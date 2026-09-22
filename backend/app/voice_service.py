"""Orchestrates the voice pipeline for a single uploaded audio window.

    bytes -> decode -> quality gate -> VAD -> [STT -> text emotion] + voice tone

Ordering matters for cost: VAD runs before Whisper and before the voice
emotion model, so silence costs almost nothing. A window that fails the
quality gate or contains no speech is reported as such and the expensive
models never run.

Nothing is persisted. Audio exists only as an in-memory array for the life of
the request.
"""
import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import (
    audio_features,
    config,
    speech_to_text,
    text_emotion,
    transcript_cleanup,
    voice_emotion,
)

logger = logging.getLogger("aura.voice_service")


@dataclass
class VoiceAnalysis:
    success: bool = True
    speech_detected: bool = False
    vad_method: str = ""
    speech_ratio: float = 0.0
    analysis_used: bool = False
    message: Optional[str] = None
    error: Optional[str] = None

    quality: Dict[str, object] = field(default_factory=dict)
    transcript: Dict[str, object] = field(default_factory=dict)
    voice: Dict[str, object] = field(default_factory=dict)
    text: Dict[str, object] = field(default_factory=dict)
    acoustic: Dict[str, object] = field(default_factory=dict)
    stress: Dict[str, object] = field(default_factory=dict)
    timing: Dict[str, float] = field(default_factory=dict)


def capability_report() -> Dict[str, object]:
    """What the voice stack can actually do in this environment.

    Surfaced to the UI so a missing model shows as an honest "unavailable"
    rather than a silently empty panel.
    """
    deps = audio_features.dependency_status()
    return {
        "audio_decode": deps["soundfile"],
        "acoustic_features": deps["librosa"],
        "vad": "webrtcvad" if deps["webrtcvad"] else "energy_zcr",
        "speech_to_text": speech_to_text.is_available(),
        "voice_emotion": voice_emotion.is_available(),
        "text_emotion": text_emotion.is_available(),
        "stt_model": config.ELEVENLABS_STT_MODEL,
    }


def analyze_audio_window(
    raw_bytes: bytes,
    want_transcript: bool = True,
    want_voice_emotion: bool = True,
    language: Optional[str] = None,
) -> VoiceAnalysis:
    """Runs the full voice pipeline on one audio window."""
    if not raw_bytes:
        return VoiceAnalysis(success=False, error="Received an empty audio upload.")

    decoded = audio_features.decode_wav(raw_bytes)
    if decoded is None:
        deps = audio_features.dependency_status()
        if not deps["soundfile"]:
            return VoiceAnalysis(
                success=False,
                error="soundfile is not installed; audio cannot be decoded.",
            )
        return VoiceAnalysis(
            success=False,
            error="Audio could not be decoded. Expected 16 kHz mono WAV.",
        )

    # --- Quality gate -----------------------------------------------------
    quality = audio_features.assess_quality(decoded)
    quality_payload = {
        "duration": quality.duration,
        "rms": quality.rms,
        "peak": quality.peak,
        "snr_db_estimate": quality.snr_db,
        "clipping_ratio": quality.clipping_ratio,
        "silence_ratio": quality.silence_ratio,
        "score": quality.score,
        "label": quality.label,
        "acceptable": quality.acceptable,
    }

    if not quality.acceptable:
        reason = (
            f"Audio window too short ({quality.duration:.1f}s)."
            if quality.duration < config.AUDIO_MIN_DURATION
            else "Audio level too low - microphone may be muted or too distant."
            if quality.rms < config.AUDIO_SILENCE_RMS
            else f"Audio quality too poor to analyse (score {quality.score:.0f})."
        )
        return VoiceAnalysis(
            success=True,
            analysis_used=False,
            speech_detected=False,
            quality=quality_payload,
            message=reason,
        )

    # --- VAD: gate the expensive models -----------------------------------
    speech_detected, speech_ratio, vad_method = audio_features.detect_speech(decoded)
    if not speech_detected:
        return VoiceAnalysis(
            success=True,
            analysis_used=False,
            speech_detected=False,
            speech_ratio=speech_ratio,
            vad_method=vad_method,
            quality=quality_payload,
            message="No speech detected in this window.",
        )

    result = VoiceAnalysis(
        success=True,
        speech_detected=True,
        speech_ratio=speech_ratio,
        vad_method=vad_method,
        analysis_used=True,
        quality=quality_payload,
    )

    # --- Acoustic features ------------------------------------------------
    features = audio_features.extract_acoustic_features(decoded)
    result.acoustic = {
        "available": features.available,
        "pitch": {
            "mean_hz": features.pitch_mean_hz,
            "std_hz": features.pitch_std_hz,
            "range_hz": features.pitch_range_hz,
            "normalized": features.pitch_normalized,
            "variability": features.pitch_variability,
        },
        "energy": {
            "mean": features.energy_mean,
            "std": features.energy_std,
            "normalized": features.energy_normalized,
            "variability": features.energy_variability,
        },
        "spectral": {
            "zero_crossing_rate": features.zero_crossing_rate,
            "centroid": features.spectral_centroid,
            "bandwidth": features.spectral_bandwidth,
            "mfcc_mean": features.mfcc_mean,
        },
        "voiced_ratio": features.voiced_ratio,
    }

    # --- Speech-to-text, then text emotion on the transcript --------------
    if want_transcript:
        tr = speech_to_text.transcribe(decoded.samples, language=language)

        # RAW -> CLEANUP -> VALIDATION -> FINAL. Uncertain segments are kept
        # separate rather than corrected, and only confident text reaches the
        # emotion model, so shaky recognition cannot become emotion evidence.
        cleaned = transcript_cleanup.clean_transcript(
            tr.text, tr.segments, tr.language, tr.language_probability
        )
        text_quality = transcript_cleanup.transcript_signal_quality(cleaned)

        result.transcript = {
            "available": tr.available,
            "raw_text": cleaned.raw_text,
            "text": cleaned.final_text,
            "display_text": cleaned.display_text,
            "language": tr.language,
            "language_probability": tr.language_probability,
            "language_reliable": cleaned.language_reliable,
            "segments": cleaned.confident_segments,
            "uncertain_segments": cleaned.uncertain_segments,
            "removed_segments": cleaned.removed_segments,
            "word_count": cleaned.word_count,
            "segment_confidence": cleaned.confidence_score,
            "signal_quality": text_quality,
            "notes": cleaned.notes,
            # Explicitly an indicator derived from avg_logprob, not a
            # calibrated accuracy figure. None => shown as "unavailable".
            "quality_indicator": speech_to_text.logprob_to_indicator(tr.mean_logprob),
            "error": tr.error,
        }

        result.timing = audio_features.speech_timing(
            cleaned.confident_segments or tr.segments, quality.duration
        )

        if tr.available and cleaned.final_text:
            te = text_emotion.analyze_text(cleaned.final_text, language=tr.language)
            result.text = {
                "available": te.available,
                "dominant": te.dominant,
                "scores": te.scores,
                "confidence": te.confidence,
                "sentiment": {"dominant": te.sentiment_dominant, "scores": te.sentiment_scores},
                "language_supported": te.language_supported,
                "evidence": te.evidence,
                "signal_quality": text_quality,
                "error": te.error,
            }
        else:
            result.text = {
                "available": False,
                "signal_quality": 0.0,
                "error": (
                    tr.error
                    or (
                        "Speech was detected but no segment cleared the confidence "
                        "threshold; no text emotion estimated."
                        if cleaned.uncertain_segments
                        else "No transcript text produced for this window."
                    )
                ),
            }
    else:
        result.timing = audio_features.speech_timing([], quality.duration)

    # --- Voice tone -------------------------------------------------------
    if want_voice_emotion:
        ve = voice_emotion.analyze_voice(decoded.samples, decoded.sample_rate)
        # Poor-but-passable audio should not yield a confident tone reading.
        confidence = ve.confidence
        if quality.score < 50 and ve.model_available:
            confidence = round(confidence * (quality.score / 50), 1)

        result.voice = {
            "available": ve.model_available,
            "dominant": ve.dominant if ve.model_available else "uncertain",
            "scores": ve.scores,
            "confidence": confidence,
            "raw_confidence": ve.confidence,
            "supported_emotions": ve.supported_emotions,
            "quality_limited": quality.score < 50,
            "error": ve.error,
        }

    result.stress = voice_emotion.voice_stress_indicators(features, result.timing)
    return result
