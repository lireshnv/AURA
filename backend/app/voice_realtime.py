"""Real-time voice pipeline: STT and acoustic analysis running in parallel.

    decode -> quality gate -> VAD
                                |
                +---------------+---------------+
                |                               |
        STT branch                      Acoustic branch
        faster-whisper                  pitch / energy / timing
        transcript cleanup              normalise -> smooth -> observe
                |                               |
                +---------------+---------------+
                                |
                     VoiceAnalysisFrame (validated)

Why threads rather than asyncio: both branches are CPU-bound native code.
faster-whisper runs in CTranslate2 and librosa/numpy in BLAS, and both release
the GIL for the duration of their work, so a ThreadPoolExecutor gives genuine
overlap. asyncio alone would not - it would interleave nothing and simply run
them one after the other on the event loop thread, blocking every other request
in the process.

The measured overlap is reported in Latency.parallel rather than assumed, so a
regression to sequential execution is visible in the response instead of
silently costing latency.

Nothing is persisted. Audio exists only as an in-memory array for the life of
the request.
"""
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Optional

from . import (
    audio_features,
    config,
    speech_to_text,
    text_emotion,
    transcript_cleanup,
    voice_emotion,
    voice_signal,
)
from .voice_frame import (
    Feature,
    Latency,
    ProsodyFeatures,
    SignalQuality,
    TextEmotionPart,
    TranscriptPart,
    VoiceAnalysisFrame,
    VoiceSignal,
    WindowSpan,
)

logger = logging.getLogger("aura.voice_realtime")

# Two workers: one per branch. Sized to the branch count, not the core count -
# more threads would only add contention, since each branch is already
# internally parallel inside its native library.
_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="aura-voice")

# Confidence below which the voice-emotion model's label is withheld entirely
# rather than shown as a weak guess.
MIN_EMOTION_CONFIDENCE = 35.0


def _now_ms() -> int:
    return int(time.time() * 1000)


def _feature(raw: Optional[float], norm: Optional[float], unit: str) -> Feature:
    """Builds a Feature, marking it unavailable when nothing was measured."""
    if raw is None and norm is None:
        return Feature(unit=unit, available=False)
    return Feature(
        raw=round(raw, 3) if raw is not None else None,
        normalized=round(norm, 3) if norm is not None else None,
        unit=unit,
        available=True,
    )


def _audio_label(score: float) -> str:
    if score >= 65:
        return "good"
    if score >= 40:
        return "fair"
    return "poor"


def _speech_label(speech_ratio: float) -> str:
    if speech_ratio >= 0.55:
        return "good"
    if speech_ratio >= 0.25:
        return "fair"
    if speech_ratio > 0:
        return "poor"
    return "none"


def _transcript_label(confidence: Optional[float], word_count: int) -> str:
    if confidence is None or word_count == 0:
        return "none"
    if confidence >= 70 and word_count >= 4:
        return "high"
    if confidence >= 45:
        return "medium"
    return "low"


def _skipped(
    span: WindowSpan, message: str, quality: SignalQuality, latency: Latency
) -> VoiceAnalysisFrame:
    """A window that produced no finding. The schema forbids attaching a
    signal or a confidence here, so this cannot become a fake reading."""
    return VoiceAnalysisFrame(
        window=span,
        analysis_used=False,
        speech_detected=False,
        message=message,
        quality=quality,
        latency=latency,
        confidence=0.0,
    )


# --- Branches --------------------------------------------------------------


def _stt_branch(decoded, language: Optional[str]) -> Dict:
    """Speech-to-text plus transcript validation. Runs in its own thread."""
    started = time.perf_counter()
    tr = speech_to_text.transcribe(decoded.samples, language=language)
    cleaned = transcript_cleanup.clean_transcript(
        tr.text, tr.segments, tr.language, tr.language_probability
    )
    text_quality = transcript_cleanup.transcript_signal_quality(cleaned)

    # Text emotion belongs to this branch: it depends on the transcript, so
    # running it here keeps it off the acoustic branch's critical path.
    te = None
    if tr.available and cleaned.final_text:
        te = text_emotion.analyze_text(cleaned.final_text, language=tr.language)

    return {
        "tr": tr,
        "cleaned": cleaned,
        "quality": text_quality,
        "text_emotion": te,
        "ms": (time.perf_counter() - started) * 1000.0,
    }


def _acoustic_branch(decoded, want_tone: bool) -> Dict:
    """Acoustic features and VAD timing. Runs in its own thread.

    Deliberately does not touch the transcript: timing comes from vad_timing(),
    not Whisper timestamps, which is what allows this to run concurrently.

    `want_tone` gates the wav2vec2 tone model, which dominates this branch's
    cost. Features are cheap and update on every partial window; the tone model
    runs once per utterance on the final pass. That is the right split anyway:
    features are the continuously-observed signal, while the tone label is an
    interpretation that only becomes meaningful over a whole utterance.
    """
    started = time.perf_counter()
    features = audio_features.extract_acoustic_features(decoded)
    timing = audio_features.vad_timing(decoded)
    feature_ms = (time.perf_counter() - started) * 1000.0

    tone = None
    tone_ms = 0.0
    if want_tone:
        tone_started = time.perf_counter()
        tone = voice_emotion.analyze_voice(decoded.samples, decoded.sample_rate)
        tone_ms = (time.perf_counter() - tone_started) * 1000.0

    return {
        "features": features,
        "timing": timing,
        "tone": tone,
        "feature_ms": feature_ms,
        "tone_ms": tone_ms,
        "ms": (time.perf_counter() - started) * 1000.0,
    }


# --- Orchestrator ----------------------------------------------------------


def analyze_frame(
    raw_bytes: bytes,
    session_id: str,
    window_start: float,
    window_end: float,
    language: Optional[str] = None,
    is_final: bool = False,
    want_transcript: bool = True,
) -> VoiceAnalysisFrame:
    """Analyses one window and returns a validated frame."""
    total_started = time.perf_counter()
    span = WindowSpan(
        session_id=session_id,
        window_start=max(0.0, window_start),
        window_end=max(window_start, window_end),
        timestamp=_now_ms(),
        duration=max(0.0, window_end - window_start),
    )

    if not raw_bytes:
        return VoiceAnalysisFrame(
            window=span, analysis_used=False, error="Received an empty audio upload."
        )

    # --- Decode -----------------------------------------------------------
    decode_started = time.perf_counter()
    decoded = audio_features.decode_wav(raw_bytes)
    decode_ms = (time.perf_counter() - decode_started) * 1000.0

    if decoded is None:
        return VoiceAnalysisFrame(
            window=span,
            analysis_used=False,
            error="Audio could not be decoded. Expected 16 kHz mono WAV.",
            latency=Latency(decode_ms=decode_ms),
        )

    # --- Quality gate -----------------------------------------------------
    q = audio_features.assess_quality(decoded)
    quality = SignalQuality(
        audio=_audio_label(q.score), audio_score=round(q.score, 1), speech="none", transcript="none"
    )

    if not q.acceptable:
        reason = (
            f"Window too short ({q.duration:.1f}s)."
            if q.duration < config.AUDIO_MIN_DURATION
            else "Audio level too low - microphone may be muted or too distant."
            if q.rms < config.AUDIO_SILENCE_RMS
            else "Collecting more speech..."
        )
        return _skipped(
            span,
            reason,
            quality,
            Latency(decode_ms=decode_ms, total_ms=(time.perf_counter() - total_started) * 1000.0),
        )

    # --- VAD gate: silence must not cost a Whisper run --------------------
    speech_detected, speech_ratio, _vad_method = audio_features.detect_speech(decoded)
    quality.speech = _speech_label(speech_ratio)
    if not speech_detected:
        return _skipped(
            span,
            "Collecting more speech...",
            quality,
            Latency(decode_ms=decode_ms, total_ms=(time.perf_counter() - total_started) * 1000.0),
        )

    # --- Both branches, concurrently --------------------------------------
    parallel_started = time.perf_counter()
    acoustic_future = _pool.submit(_acoustic_branch, decoded, is_final)
    stt_future = (
        _pool.submit(_stt_branch, decoded, language) if want_transcript else None
    )

    acoustic = acoustic_future.result()
    stt = stt_future.result() if stt_future else None
    wall_ms = (time.perf_counter() - parallel_started) * 1000.0

    features_ms = acoustic["ms"]
    transcribe_ms = stt["ms"] if stt else 0.0
    # Dispatched concurrently whenever there was a second branch to dispatch.
    parallel = bool(stt)
    # What the overlap actually saved. Reported rather than inferred: a
    # regression to sequential execution drives this to ~0 and is visible in
    # the response, while a tiny branch alongside a large one honestly saves
    # only as much as the tiny branch cost.
    overlap_saved_ms = max(0.0, (features_ms + transcribe_ms) - wall_ms)

    # --- Transcript -------------------------------------------------------
    transcript = TranscriptPart()
    text_part = TextEmotionPart()
    if stt:
        tr, cleaned = stt["tr"], stt["cleaned"]
        indicator = speech_to_text.logprob_to_indicator(tr.mean_logprob)
        transcript = TranscriptPart(
            text=cleaned.final_text,
            display_text=cleaned.display_text,
            is_final=is_final,
            confidence=indicator,
            language=tr.language,
            language_reliable=cleaned.language_reliable,
            word_count=cleaned.word_count,
            uncertain_segments=cleaned.uncertain_segments,
            available=tr.available,
            error=tr.error,
        )
        quality.transcript = _transcript_label(indicator, cleaned.word_count)

        te = stt.get("text_emotion")
        if te is not None and te.available:
            text_part = TextEmotionPart(
                available=True,
                dominant=te.dominant,
                scores=te.scores,
                confidence=te.confidence,
                sentiment={"dominant": te.sentiment_dominant, "scores": te.sentiment_scores},
                signal_quality=stt["quality"],
                language_supported=te.language_supported,
            )
        elif te is not None:
            text_part = TextEmotionPart(available=False, error=te.error)

    # --- Acoustic features -> normalised -> smoothed observation ----------
    features, timing = acoustic["features"], acoustic["timing"]
    normalized = voice_signal.normalize_features(features, timing, q.rms)
    observed, obs_confidence, contributing, _smoothed = voice_signal.derive(
        session_id, normalized
    )

    prosody = ProsodyFeatures(
        pitch=_feature(
            features.pitch_mean_hz if features.available else None, normalized["pitch"], "Hz"
        ),
        pitch_variation=_feature(
            features.pitch_std_hz if features.available else None,
            normalized["pitch_variation"],
            "Hz",
        ),
        energy=_feature(q.rms, normalized["energy"], "RMS"),
        energy_variation=_feature(
            features.energy_variability if features.available else None,
            normalized["energy_variation"],
            "ratio",
        ),
        speech_rate=_feature(
            timing.get("onset_rate") if timing.get("available") else None,
            normalized["speech_rate"],
            "onsets/s",
        ),
        pause_ratio=_feature(
            timing.get("pause_ratio") if timing.get("available") else None,
            normalized["pause_ratio"],
            "ratio",
        ),
        voiced_ratio=_feature(
            timing.get("speech_ratio") if timing.get("available") else None,
            normalized["voiced_ratio"],
            "ratio",
        ),
        spectral_centroid=_feature(
            features.spectral_centroid if features.available else None,
            normalized["spectral_centroid"],
            "Hz",
        ),
        voice_activity_seconds=_feature(
            timing.get("voiced_seconds") if timing.get("available") else None,
            None,
            "s",
        ),
        jitter=_feature(
            features.jitter_local if features.voice_quality_available else None,
            normalized["jitter"],
            "ratio",
        ),
        shimmer=_feature(
            features.shimmer_local if features.voice_quality_available else None,
            normalized["shimmer"],
            "ratio",
        ),
        hnr=_feature(
            features.hnr_db if features.voice_quality_available else None,
            normalized["hnr_strain"],
            "dB",
        ),
    )

    # --- Interpretation, kept separate from the observation ---------------
    # Absent on partial windows by design - see _acoustic_branch. The UI shows
    # the observation alone until the utterance-level pass supplies a label.
    tone = acoustic["tone"]
    emotion = None
    emotion_confidence = None
    emotion_scores: Dict[str, float] = {}
    if tone is not None and tone.model_available:
        conf = tone.confidence
        # Poor-but-passable audio must not yield a confident tone reading.
        if q.score < 50:
            conf = round(conf * (q.score / 50), 1)
        if conf >= MIN_EMOTION_CONFIDENCE:
            emotion = tone.dominant
            emotion_confidence = conf
            emotion_scores = tone.scores
        # Below threshold the label is withheld rather than shown as neutral.

    signal = VoiceSignal(
        observed=observed,
        confidence=obs_confidence,
        contributing_features=contributing,
        emotion=emotion,
        emotion_confidence=emotion_confidence,
        emotion_scores=emotion_scores,
    )

    # Frame confidence is bounded by the weakest link: a strong observation
    # over poor audio is not a strong frame.
    frame_confidence = min(obs_confidence, max(q.score, 1.0))

    return VoiceAnalysisFrame(
        window=span,
        analysis_used=True,
        speech_detected=True,
        transcript=transcript,
        text_emotion=text_part,
        prosody=prosody,
        voice_signal=signal,
        quality=quality,
        confidence=round(frame_confidence, 1),
        latency=Latency(
            decode_ms=round(decode_ms, 1),
            features_ms=round(acoustic["feature_ms"], 1),
            tone_ms=round(acoustic["tone_ms"], 1),
            transcribe_ms=round(transcribe_ms, 1),
            total_ms=round((time.perf_counter() - total_started) * 1000.0, 1),
            parallel=parallel,
            overlap_saved_ms=round(overlap_saved_ms, 1),
        ),
    )
