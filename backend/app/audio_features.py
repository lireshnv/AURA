"""Audio decoding, voice-activity detection, quality gating and acoustic features.

This is the audio analogue of face_preprocessing.py: it decides whether an
audio window is even worth running expensive models on, and extracts the
lightweight acoustic descriptors used as evidence.

Design notes:

* The frontend uploads 16 kHz mono 16-bit WAV, converted in the browser via
  the Web Audio API. That deliberately avoids an FFmpeg dependency on the
  server for WebM/Opus transcoding - the conversion is essentially free in the
  browser, and it keeps the backend install light.

* Nothing is written to disk. Audio is decoded from the request bytes in
  memory and discarded when the request ends.

* If a dependency is missing, the caller is told so explicitly. No module here
  ever returns a fabricated measurement.
"""
import io
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

from . import config

TARGET_SAMPLE_RATE = 16000

# --- Optional dependencies, resolved once at import ------------------------

try:
    import soundfile as sf

    _SOUNDFILE_OK = True
except Exception:  # noqa: BLE001
    _SOUNDFILE_OK = False

try:
    import librosa

    _LIBROSA_OK = True
except Exception:  # noqa: BLE001
    _LIBROSA_OK = False

try:
    import webrtcvad

    _WEBRTCVAD_OK = True
except Exception:  # noqa: BLE001
    _WEBRTCVAD_OK = False

try:
    import parselmouth
    from parselmouth.praat import call as _praat_call

    _PARSELMOUTH_OK = True
except Exception:  # noqa: BLE001
    _PARSELMOUTH_OK = False


def dependency_status() -> Dict[str, bool]:
    return {
        "soundfile": _SOUNDFILE_OK,
        "librosa": _LIBROSA_OK,
        "webrtcvad": _WEBRTCVAD_OK,
        "parselmouth": _PARSELMOUTH_OK,
    }


@dataclass
class AudioQuality:
    duration: float
    rms: float
    peak: float
    snr_db: float
    clipping_ratio: float
    silence_ratio: float
    score: float           # 0-100
    label: str             # good | acceptable | poor
    acceptable: bool


@dataclass
class DecodedAudio:
    samples: np.ndarray    # float32 mono, TARGET_SAMPLE_RATE
    sample_rate: int


@dataclass
class AcousticFeatures:
    """Normalized 0-1 acoustic descriptors, plus the raw values behind them."""

    pitch_mean_hz: float = 0.0
    pitch_std_hz: float = 0.0
    pitch_range_hz: float = 0.0
    pitch_normalized: float = 0.0
    pitch_variability: float = 0.0
    energy_mean: float = 0.0
    energy_std: float = 0.0
    energy_normalized: float = 0.0
    energy_variability: float = 0.0
    zero_crossing_rate: float = 0.0
    spectral_centroid: float = 0.0
    spectral_bandwidth: float = 0.0
    mfcc_mean: List[float] = field(default_factory=list)
    voiced_ratio: float = 0.0
    available: bool = False

    # --- Voice-quality (Praat), independent of the librosa features above.
    # Jitter/shimmer/HNR describe cycle-to-cycle stability of the voice signal
    # itself - a rough/strained voice reads differently here than in pitch or
    # energy alone. Absence (0.0 + jitter_available=False) is reported
    # honestly rather than as a measured zero, same as every other feature
    # in this module.
    jitter_local: float = 0.0          # local jitter, fraction (e.g. 0.01 = 1%)
    shimmer_local: float = 0.0         # local shimmer, fraction
    hnr_db: float = 0.0                # harmonics-to-noise ratio, dB
    voice_quality_available: bool = False


def decode_wav(raw_bytes: bytes) -> Optional[DecodedAudio]:
    """Decodes uploaded audio to float32 mono at TARGET_SAMPLE_RATE.

    Returns None when the payload cannot be decoded - the caller reports that
    rather than guessing at contents.
    """
    if not _SOUNDFILE_OK:
        return None
    try:
        data, sample_rate = sf.read(io.BytesIO(raw_bytes), dtype="float32", always_2d=True)
    except Exception:  # noqa: BLE001 - malformed upload
        return None

    if data.size == 0:
        return None

    mono = data.mean(axis=1)  # downmix any channel count

    if sample_rate != TARGET_SAMPLE_RATE:
        if _LIBROSA_OK:
            mono = librosa.resample(mono, orig_sr=sample_rate, target_sr=TARGET_SAMPLE_RATE)
        else:
            # Linear-interpolation fallback so a missing librosa degrades
            # quality rather than breaking the feature outright.
            duration = len(mono) / sample_rate
            target_len = int(duration * TARGET_SAMPLE_RATE)
            if target_len <= 1:
                return None
            mono = np.interp(
                np.linspace(0, len(mono) - 1, target_len),
                np.arange(len(mono)),
                mono,
            ).astype(np.float32)
        sample_rate = TARGET_SAMPLE_RATE

    return DecodedAudio(samples=mono.astype(np.float32), sample_rate=sample_rate)


def _frame_signal(samples: np.ndarray, frame_len: int, hop: int) -> np.ndarray:
    if len(samples) < frame_len:
        return np.empty((0, frame_len), dtype=np.float32)
    n_frames = 1 + (len(samples) - frame_len) // hop
    idx = np.arange(frame_len)[None, :] + hop * np.arange(n_frames)[:, None]
    return samples[idx]


def assess_quality(audio: DecodedAudio) -> AudioQuality:
    """Rejects audio too poor to analyse honestly.

    The SNR figure is an *estimate*: the ratio between energy in the loudest
    frames and the quietest frames of this window. That is a heuristic, not a
    calibrated measurement, and it is labelled as an estimate everywhere it
    surfaces.
    """
    samples = audio.samples
    duration = len(samples) / audio.sample_rate

    rms = float(np.sqrt(np.mean(samples**2))) if samples.size else 0.0
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    clipping_ratio = float(np.mean(np.abs(samples) > 0.99)) if samples.size else 0.0

    frame_len = int(0.025 * audio.sample_rate)
    hop = int(0.010 * audio.sample_rate)
    frames = _frame_signal(samples, frame_len, hop)

    if frames.shape[0] >= 4:
        frame_rms = np.sqrt(np.mean(frames**2, axis=1)) + 1e-10
        loud = np.percentile(frame_rms, 90)
        quiet = np.percentile(frame_rms, 10)
        snr_db = float(20 * math.log10(loud / quiet)) if quiet > 0 else 0.0
        silence_threshold = max(quiet * 2.0, config.AUDIO_SILENCE_RMS)
        silence_ratio = float(np.mean(frame_rms < silence_threshold))
    else:
        snr_db = 0.0
        silence_ratio = 1.0 if rms < config.AUDIO_SILENCE_RMS else 0.0

    # Component scores, each 0-100.
    level_score = min(100.0, (rms / config.AUDIO_TARGET_RMS) * 100.0) if rms > 0 else 0.0
    level_score = min(level_score, 100.0)
    snr_score = float(np.clip(snr_db / config.AUDIO_GOOD_SNR_DB, 0.0, 1.0) * 100.0)
    clip_penalty = float(np.clip(clipping_ratio / 0.02, 0.0, 1.0) * 100.0)
    duration_score = float(np.clip(duration / config.AUDIO_MIN_DURATION, 0.0, 1.0) * 100.0)

    score = round(
        max(
            0.0,
            0.30 * level_score + 0.35 * snr_score + 0.20 * duration_score - 0.15 * clip_penalty,
        ),
        1,
    )
    label = "good" if score >= 65 else "acceptable" if score >= 35 else "poor"

    acceptable = (
        duration >= config.AUDIO_MIN_DURATION
        and rms >= config.AUDIO_SILENCE_RMS
        and score >= config.AUDIO_MIN_QUALITY_SCORE
    )

    return AudioQuality(
        duration=round(duration, 2),
        rms=round(rms, 5),
        peak=round(peak, 4),
        snr_db=round(snr_db, 1),
        clipping_ratio=round(clipping_ratio, 4),
        silence_ratio=round(silence_ratio, 3),
        score=score,
        label=label,
        acceptable=acceptable,
    )


def detect_speech(audio: DecodedAudio) -> Tuple[bool, float, str]:
    """Voice-activity detection. Returns (speech_detected, speech_ratio, method).

    Prefers WebRTC VAD (a tiny, well-tested C extension with no model to
    download). Falls back to an energy + zero-crossing heuristic with an
    adaptive noise floor, which is reported honestly as "energy_zcr" so the
    caller knows which method produced the answer.
    """
    samples = audio.samples

    if _WEBRTCVAD_OK:
        try:
            vad = webrtcvad.Vad(config.VAD_AGGRESSIVENESS)
            pcm16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16).tobytes()
            frame_ms = 30
            bytes_per_frame = int(audio.sample_rate * frame_ms / 1000) * 2
            total = len(pcm16) // bytes_per_frame
            if total > 0:
                voiced = 0
                for i in range(total):
                    chunk = pcm16[i * bytes_per_frame : (i + 1) * bytes_per_frame]
                    if vad.is_speech(chunk, audio.sample_rate):
                        voiced += 1
                ratio = voiced / total
                return ratio >= config.VAD_MIN_SPEECH_RATIO, round(ratio, 3), "webrtcvad"
        except Exception:  # noqa: BLE001 - fall through to the heuristic
            pass

    frame_len = int(0.030 * audio.sample_rate)
    hop = int(0.015 * audio.sample_rate)
    frames = _frame_signal(samples, frame_len, hop)
    if frames.shape[0] == 0:
        return False, 0.0, "energy_zcr"

    frame_rms = np.sqrt(np.mean(frames**2, axis=1))
    zcr = np.mean(np.abs(np.diff(np.sign(frames), axis=1)) > 0, axis=1)

    # Adaptive noise floor from the quietest frames in this window.
    noise_floor = np.percentile(frame_rms, 15) + 1e-8
    # Speech: clearly above the local noise floor, without the very high ZCR
    # that characterises fricative-like noise or hiss.
    speech_frames = (frame_rms > noise_floor * 2.5) & (zcr < 0.35)
    ratio = float(np.mean(speech_frames))
    return ratio >= config.VAD_MIN_SPEECH_RATIO, round(ratio, 3), "energy_zcr"


def voiced_frame_mask(audio: DecodedAudio) -> Tuple[np.ndarray, float, str]:
    """Per-frame voiced/unvoiced decisions on a fixed 30 ms grid.

    detect_speech() collapses this to a single ratio. The real-time pipeline
    needs the frame sequence itself, because pause STRUCTURE - how many gaps
    and how long - is what distinguishes hesitant speech from fluent speech,
    and that is invisible in an aggregate ratio.

    Returns (mask, frame_seconds, method).
    """
    samples = audio.samples
    frame_ms = 30
    frame_seconds = frame_ms / 1000.0

    if _WEBRTCVAD_OK:
        try:
            vad = webrtcvad.Vad(config.VAD_AGGRESSIVENESS)
            pcm16 = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16).tobytes()
            bytes_per_frame = int(audio.sample_rate * frame_ms / 1000) * 2
            total = len(pcm16) // bytes_per_frame
            if total > 0:
                mask = np.fromiter(
                    (
                        vad.is_speech(
                            pcm16[i * bytes_per_frame : (i + 1) * bytes_per_frame],
                            audio.sample_rate,
                        )
                        for i in range(total)
                    ),
                    dtype=bool,
                    count=total,
                )
                return mask, frame_seconds, "webrtcvad"
        except Exception:  # noqa: BLE001 - fall through to the heuristic
            pass

    frame_len = int(frame_seconds * audio.sample_rate)
    frames = _frame_signal(samples, frame_len, frame_len)
    if frames.shape[0] == 0:
        return np.zeros(0, dtype=bool), frame_seconds, "energy_zcr"

    frame_rms = np.sqrt(np.mean(frames**2, axis=1))
    zcr = np.mean(np.abs(np.diff(np.sign(frames), axis=1)) > 0, axis=1)
    noise_floor = np.percentile(frame_rms, 15) + 1e-8
    mask = (frame_rms > noise_floor * 2.5) & (zcr < 0.35)
    return mask, frame_seconds, "energy_zcr"


def vad_timing(audio: DecodedAudio) -> Dict[str, float]:
    """Speech/pause structure derived from VAD alone.

    Deliberately independent of Whisper. speech_timing() below needs Whisper's
    word timestamps, which forces transcription to finish before any timing
    exists; that serialises the two pipelines. These measurements come from the
    audio itself, so the acoustic branch can run fully in parallel with STT.

    Returns zeros for an empty window - absence of measurement, not a measured
    zero.
    """
    mask, frame_seconds, method = voiced_frame_mask(audio)
    total_frames = int(mask.size)
    if total_frames == 0:
        return {
            "available": 0.0,
            "speech_ratio": 0.0,
            "pause_ratio": 0.0,
            "pause_count": 0.0,
            "longest_pause": 0.0,
            "voiced_seconds": 0.0,
            "onset_rate": 0.0,
        }

    voiced_frames = int(np.count_nonzero(mask))
    duration = total_frames * frame_seconds

    # Run-length scan for silence gaps long enough to count as deliberate
    # pauses. Short inter-word gaps are normal articulation, not hesitation.
    min_pause_frames = max(1, int(round(config.PAUSE_MIN_SECONDS / frame_seconds)))
    pause_count = 0
    pause_frames_total = 0
    longest_pause_frames = 0
    run = 0
    for is_voiced in mask:
        if is_voiced:
            if run >= min_pause_frames:
                pause_count += 1
                pause_frames_total += run
                longest_pause_frames = max(longest_pause_frames, run)
            run = 0
        else:
            run += 1
    if run >= min_pause_frames:  # trailing silence
        pause_count += 1
        pause_frames_total += run
        longest_pause_frames = max(longest_pause_frames, run)

    # Voiced ONSETS approximate syllable starts. This is an acoustic proxy for
    # tempo, not a word count - reported as such and never labelled
    # words-per-second, which only a transcript can give.
    onsets = int(np.count_nonzero(mask[1:] & ~mask[:-1])) + (1 if mask[0] else 0)

    return {
        "available": 1.0,
        "speech_ratio": round(voiced_frames / total_frames, 3),
        "pause_ratio": round(pause_frames_total / total_frames, 3),
        "pause_count": float(pause_count),
        "longest_pause": round(longest_pause_frames * frame_seconds, 2),
        "voiced_seconds": round(voiced_frames * frame_seconds, 2),
        "onset_rate": round(onsets / duration, 2) if duration > 0 else 0.0,
    }


def extract_acoustic_features(audio: DecodedAudio) -> AcousticFeatures:
    """Lightweight acoustic descriptors used as voice evidence.

    Only features that materially inform the analysis are computed - pitch,
    energy, their variability, and a small spectral set. Pitch uses librosa's
    YIN, which is cheaper than PYIN and sufficient at this granularity.
    """
    if not _LIBROSA_OK:
        return AcousticFeatures(available=False)

    samples = audio.samples
    sr = audio.sample_rate
    if len(samples) < int(0.2 * sr):
        return AcousticFeatures(available=False)

    features = AcousticFeatures(available=True)

    # --- Pitch (F0) ---
    try:
        f0 = librosa.yin(
            samples,
            fmin=config.PITCH_FMIN,
            fmax=config.PITCH_FMAX,
            sr=sr,
            frame_length=2048,
        )
        # YIN reports a value for every frame; keep only plausibly voiced ones.
        voiced = f0[(f0 > config.PITCH_FMIN * 1.05) & (f0 < config.PITCH_FMAX * 0.95)]
        if voiced.size >= 3:
            features.pitch_mean_hz = round(float(np.mean(voiced)), 1)
            features.pitch_std_hz = round(float(np.std(voiced)), 1)
            features.pitch_range_hz = round(float(np.percentile(voiced, 95) - np.percentile(voiced, 5)), 1)
            features.voiced_ratio = round(float(voiced.size / f0.size), 3)
            # Normalized against a broad speech pitch span rather than a
            # per-gender assumption - this is a relative descriptor only.
            features.pitch_normalized = round(
                float(np.clip((features.pitch_mean_hz - 75) / (300 - 75), 0, 1)), 3
            )
            features.pitch_variability = round(
                float(np.clip(features.pitch_std_hz / 60.0, 0, 1)), 3
            )
    except Exception:  # noqa: BLE001 - pitch is optional evidence
        pass

    # --- Energy ---
    rms = librosa.feature.rms(y=samples)[0]
    if rms.size:
        features.energy_mean = round(float(np.mean(rms)), 5)
        features.energy_std = round(float(np.std(rms)), 5)
        features.energy_normalized = round(
            float(np.clip(features.energy_mean / config.AUDIO_TARGET_RMS, 0, 1)), 3
        )
        features.energy_variability = round(
            float(np.clip(features.energy_std / (features.energy_mean + 1e-8), 0, 1)), 3
        )

    # --- Spectral ---
    try:
        features.zero_crossing_rate = round(
            float(np.mean(librosa.feature.zero_crossing_rate(y=samples)[0])), 4
        )
        features.spectral_centroid = round(
            float(np.mean(librosa.feature.spectral_centroid(y=samples, sr=sr)[0])), 1
        )
        features.spectral_bandwidth = round(
            float(np.mean(librosa.feature.spectral_bandwidth(y=samples, sr=sr)[0])), 1
        )
        mfcc = librosa.feature.mfcc(y=samples, sr=sr, n_mfcc=config.N_MFCC)
        features.mfcc_mean = [round(float(v), 3) for v in np.mean(mfcc, axis=1)]
    except Exception:  # noqa: BLE001
        pass

    # --- Voice quality: jitter, shimmer, HNR (Praat via parselmouth) ---
    if _PARSELMOUTH_OK:
        try:
            snd = parselmouth.Sound(samples, sampling_frequency=sr)
            point_process = _praat_call(
                snd, "To PointProcess (periodic, cc)", config.PITCH_FMIN, config.PITCH_FMAX
            )
            # Only meaningful with enough detected glottal pulses; too few
            # means the window was mostly unvoiced and the figures below
            # would be noise, not a measurement.
            n_points = _praat_call(point_process, "Get number of points")
            if n_points >= 3:
                jitter = _praat_call(point_process, "Get jitter (local)", 0.0, 0.0, 0.0001, 0.02, 1.3)
                shimmer = _praat_call(
                    [snd, point_process],
                    "Get shimmer (local)",
                    0.0, 0.0, 0.0001, 0.02, 1.3, 1.6,
                )
                harmonicity = _praat_call(snd, "To Harmonicity (cc)", 0.01, config.PITCH_FMIN, 0.1, 1.0)
                hnr = _praat_call(harmonicity, "Get mean", 0, 0)

                if not (math.isnan(jitter) or math.isnan(shimmer) or math.isnan(hnr)):
                    features.jitter_local = round(float(jitter), 5)
                    features.shimmer_local = round(float(shimmer), 4)
                    features.hnr_db = round(float(hnr), 1)
                    features.voice_quality_available = True
        except Exception:  # noqa: BLE001 - voice quality is optional evidence
            pass

    return features


def speech_timing(segments: List[dict], duration: float) -> Dict[str, float]:
    """Speaking rate and pause structure, derived from Whisper's timestamps.

    Returns zeros when there are no segments - absence of speech is reported
    as such, not as a rate of zero dressed up as a measurement.
    """
    if not segments or duration <= 0:
        return {"words_per_second": 0.0, "pause_ratio": 0.0, "pause_count": 0.0, "speech_ratio": 0.0}

    total_words = sum(len((s.get("text") or "").split()) for s in segments)
    speech_time = sum(max(0.0, (s.get("end", 0.0) - s.get("start", 0.0))) for s in segments)

    pause_count = 0
    pause_time = 0.0
    ordered = sorted(segments, key=lambda s: s.get("start", 0.0))
    for prev, nxt in zip(ordered, ordered[1:]):
        gap = nxt.get("start", 0.0) - prev.get("end", 0.0)
        if gap >= config.PAUSE_MIN_SECONDS:
            pause_count += 1
            pause_time += gap

    leading = ordered[0].get("start", 0.0)
    trailing = duration - ordered[-1].get("end", 0.0)
    for edge in (leading, trailing):
        if edge >= config.PAUSE_MIN_SECONDS:
            pause_time += edge

    return {
        "words_per_second": round(total_words / speech_time, 2) if speech_time > 0 else 0.0,
        "pause_ratio": round(min(1.0, pause_time / duration), 3),
        "pause_count": float(pause_count),
        "speech_ratio": round(min(1.0, speech_time / duration), 3),
    }
