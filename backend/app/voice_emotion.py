"""Voice-tone emotion from the acoustic signal, independent of what was said.

This classifies *how* something was said. text_emotion.py classifies *what*
was said. They are kept separate on purpose so the multimodal layer can detect
when they disagree ("I'm fine", said flatly).

The pretrained model's label set is smaller than AURA's seven emotions. Rather
than spreading probability into classes the model cannot actually express, the
emotions it has no output for are left at zero and reported as unsupported.
Inventing values for surprise/disgust here would be fabricating evidence.
"""
import logging
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

from . import config

logger = logging.getLogger("aura.voice")

try:
    from transformers import AutoFeatureExtractor, AutoModelForAudioClassification
    import torch

    _TRANSFORMERS_OK = True
except Exception:  # noqa: BLE001
    _TRANSFORMERS_OK = False


@dataclass
class VoiceEmotionResult:
    dominant: str = "neutral"
    scores: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0
    supported_emotions: List[str] = field(default_factory=list)
    model_available: bool = False
    error: Optional[str] = None


_model = None
_extractor = None
_model_lock = threading.Lock()
_load_error: Optional[str] = None
_load_attempts = 0

# Weights download on first load, so a transient network failure is retried
# across requests instead of disabling voice emotion until a restart.
MAX_LOAD_ATTEMPTS = 3


def is_available() -> bool:
    return _TRANSFORMERS_OK


def _get_model():
    global _model, _extractor, _load_error, _load_attempts
    if _model is not None:
        return _model, _extractor
    if _load_attempts >= MAX_LOAD_ATTEMPTS:
        return None, None
    with _model_lock:
        if _model is not None:
            return _model, _extractor
        if _load_attempts >= MAX_LOAD_ATTEMPTS:
            return None, None
        _load_attempts += 1
        try:
            logger.info("Loading voice emotion model '%s'", config.VOICE_EMOTION_MODEL)
            _extractor = AutoFeatureExtractor.from_pretrained(config.VOICE_EMOTION_MODEL)
            _model = AutoModelForAudioClassification.from_pretrained(
                config.VOICE_EMOTION_MODEL
            )
            _model.eval()
            _load_error = None
            logger.info("Voice emotion model ready")
        except Exception as exc:  # noqa: BLE001
            _load_error = str(exc)
            logger.warning(
                "Voice emotion load attempt %d/%d failed: %s",
                _load_attempts,
                MAX_LOAD_ATTEMPTS,
                exc,
            )
    return _model, _extractor


def load_eagerly() -> None:
    if _TRANSFORMERS_OK:
        _get_model()


def analyze_voice(samples: np.ndarray, sample_rate: int) -> VoiceEmotionResult:
    """Classifies voice tone from 16 kHz mono float32 audio."""
    if not _TRANSFORMERS_OK:
        return VoiceEmotionResult(
            model_available=False,
            error="transformers/torch not installed; voice emotion model is unavailable.",
        )

    model, extractor = _get_model()
    if model is None:
        return VoiceEmotionResult(
            model_available=False,
            error=f"Voice emotion model could not be loaded: {_load_error}",
        )

    try:
        inputs = extractor(
            samples, sampling_rate=sample_rate, return_tensors="pt", padding=True
        )
        with torch.no_grad():
            logits = model(**inputs).logits[0]
        probs = torch.softmax(logits, dim=-1).tolist()

        id2label = model.config.id2label
        scores: Dict[str, float] = {k: 0.0 for k in config.EMOTION_KEYS}
        supported: List[str] = []
        unmapped_mass = 0.0

        for idx, prob in enumerate(probs):
            raw_label = str(id2label[idx]).lower().strip()
            mapped = config.VOICE_EMOTION_LABEL_MAP.get(raw_label)
            if mapped is None:
                unmapped_mass += prob
                logger.warning("Unmapped voice-emotion label '%s'", raw_label)
                continue
            scores[mapped] += prob * 100
            if mapped not in supported:
                supported.append(mapped)

        if unmapped_mass > 0:
            logger.warning(
                "%.1f%% of voice model probability fell on unmapped labels",
                unmapped_mass * 100,
            )

        total = sum(scores.values())
        if total > 0:
            scores = {k: round(v / total * 100, 1) for k, v in scores.items()}

        dominant = max(scores, key=scores.get)
        return VoiceEmotionResult(
            dominant=dominant,
            scores=scores,
            confidence=round(scores[dominant], 1),
            supported_emotions=supported,
            model_available=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Voice emotion analysis failed")
        return VoiceEmotionResult(
            model_available=False, error=f"Voice emotion analysis failed: {exc}"
        )


def voice_stress_indicators(features, timing: Dict[str, float]) -> Dict[str, object]:
    """Descriptive vocal-pattern indicators from measured acoustics.

    These are OBSERVATIONAL DESCRIPTORS of the audio signal - pitch spread,
    energy spread, speaking rate, pause structure. They are explicitly not
    medical or physiological stress measurements, and the labels below are
    descriptive words ("Fast", "Moderate") rather than clinical categories.
    """
    if not getattr(features, "available", False):
        return {"available": False}

    def band(value: float, low: float, high: float) -> str:
        if value < low:
            return "Low"
        if value < high:
            return "Moderate"
        return "High"

    rate = timing.get("words_per_second", 0.0)
    pause_ratio = timing.get("pause_ratio", 0.0)

    rate_label = "Unknown"
    if rate > 0:
        rate_label = "Slow" if rate < 1.8 else "Moderate" if rate < 3.2 else "Fast"

    # A transparent 0-1 composite of the descriptors above. Contributes to the
    # distress estimate but is never presented as a stress measurement itself.
    contribution = float(
        np.clip(
            0.35 * features.pitch_variability
            + 0.25 * features.energy_variability
            + 0.20 * (1.0 if rate_label == "Fast" else 0.5 if rate_label == "Moderate" else 0.0)
            + 0.20 * (1.0 - min(1.0, pause_ratio / 0.4)),
            0.0,
            1.0,
        )
    )

    return {
        "available": True,
        "pitch_variability": band(features.pitch_variability, 0.25, 0.6),
        "pitch_variability_value": features.pitch_variability,
        "energy_variability": band(features.energy_variability, 0.25, 0.6),
        "energy_variability_value": features.energy_variability,
        "speech_rate": rate_label,
        "words_per_second": rate,
        "pause_ratio": pause_ratio,
        "contribution": round(contribution, 3),
        "contribution_label": band(contribution, 0.3, 0.6),
    }
