"""Emotion-only analysis of an already-cropped, already-validated face.

Two interchangeable backends, chosen automatically at import:

* DeepFace (TensorFlow) - used when installed (the full `requirements.txt`
  build). Heavier and more accurate.
* FER+ via OpenCV DNN - the fallback when DeepFace isn't installed (the
  `requirements-lite.txt` build used on small hosts). A 35 MB ONNX model
  (FER+, ONNX Model Zoo, Apache-2.0) run by OpenCV, which is already a
  dependency, so it needs no TensorFlow and fits in a 512 MB instance.

Both return the same shape: a percentage per config.EMOTION_KEYS summing to
100, so everything downstream (smoothing, fusion, reliability) is identical.
"""
import logging
from pathlib import Path
from typing import Dict, Optional

import cv2
import numpy as np

from . import config

logger = logging.getLogger("aura.emotion")

try:
    from deepface import DeepFace
except ImportError:  # pragma: no cover - depends on the install profile
    DeepFace = None

FERPLUS_PATH = Path(__file__).resolve().parent.parent / "models" / "emotion-ferplus-8.onnx"
# FER+ output order, mapped onto AURA's keys. FER+ has "contempt", which
# AURA/DeepFace don't - it's folded into "disgust", its nearest neighbour.
_FERPLUS_TO_AURA = ["neutral", "happy", "surprise", "sad", "angry", "disgust", "fear", "disgust"]

_ferplus_net: Optional["cv2.dnn.Net"] = None
if DeepFace is None and FERPLUS_PATH.exists():
    try:
        _ferplus_net = cv2.dnn.readNetFromONNX(str(FERPLUS_PATH))
    except cv2.error:
        logger.exception("Could not load FER+ emotion model at %s", FERPLUS_PATH)

if DeepFace is not None:
    BACKEND = "deepface"
elif _ferplus_net is not None:
    BACKEND = "ferplus"
else:
    BACKEND = None

EMOTION_ANALYSIS_AVAILABLE = BACKEND is not None


def _normalise(scores: Dict[str, float]) -> Dict[str, float]:
    scores = {k: float(scores.get(k, 0.0)) for k in config.EMOTION_KEYS}
    total = sum(scores.values())
    if total > 0:
        scores = {k: v / total * 100 for k, v in scores.items()}
    return scores


def _analyze_deepface(face_crop: np.ndarray) -> Dict[str, float]:
    result = DeepFace.analyze(
        img_path=face_crop,
        actions=["emotion"],
        enforce_detection=False,
        detector_backend="skip",
        silent=True,
    )
    payload = result[0] if isinstance(result, list) else result
    return _normalise(payload["emotion"])


def _analyze_ferplus(face_crop: np.ndarray) -> Dict[str, float]:
    gray = face_crop if face_crop.ndim == 2 else cv2.cvtColor(face_crop, cv2.COLOR_BGR2GRAY)
    # FER+ takes a 64x64 single-channel face with raw 0-255 pixel values.
    blob = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA).astype(np.float32).reshape(1, 1, 64, 64)
    _ferplus_net.setInput(blob)
    logits = _ferplus_net.forward()[0].astype(np.float64)
    probs = np.exp(logits - logits.max())
    probs /= probs.sum()
    scores: Dict[str, float] = {k: 0.0 for k in config.EMOTION_KEYS}
    for label, p in zip(_FERPLUS_TO_AURA, probs):
        scores[label] += float(p)
    return _normalise(scores)


def analyze_emotion(face_crop: np.ndarray) -> Dict[str, float]:
    """Runs emotion analysis on an already-cropped, already-validated face.

    Face presence was already confirmed by the MediaPipe preprocessing stage,
    so neither backend re-detects - that would be redundant work.
    """
    if BACKEND == "deepface":
        return _analyze_deepface(face_crop)
    if BACKEND == "ferplus":
        return _analyze_ferplus(face_crop)
    raise RuntimeError("Face emotion analysis is not installed on this deployment.")


def warm_up() -> None:
    """Runs one dummy inference at startup so model weights load before the
    first real request, instead of stalling the user's first analysis call."""
    if BACKEND is None:
        print("[AURA] No face emotion model installed - face emotion analysis disabled.")
        return
    dummy = np.zeros((config.FACE_RESIZE_DIM, config.FACE_RESIZE_DIM, 3), dtype=np.uint8)
    try:
        analyze_emotion(dummy)
        print(f"[AURA] Face emotion model ready ({BACKEND}).")
    except Exception as exc:  # noqa: BLE001 - startup diagnostics, not a request path
        print(f"[AURA] Face emotion warm-up failed ({BACKEND}): {exc}")
