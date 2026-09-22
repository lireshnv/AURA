"""Thin wrapper around DeepFace restricted to emotion-only analysis."""
from typing import Dict

import numpy as np
from deepface import DeepFace

from . import config


def analyze_emotion(face_crop: np.ndarray) -> Dict[str, float]:
    """Runs DeepFace emotion analysis on an already-cropped, already-validated face.

    enforce_detection is disabled because face presence was already confirmed by
    the MediaPipe preprocessing stage - re-detecting here would be redundant work.
    """
    result = DeepFace.analyze(
        img_path=face_crop,
        actions=["emotion"],
        enforce_detection=False,
        detector_backend="skip",
        silent=True,
    )

    payload = result[0] if isinstance(result, list) else result
    raw_scores = payload["emotion"]
    scores = {k: float(raw_scores.get(k, 0.0)) for k in config.EMOTION_KEYS}

    total = sum(scores.values())
    if total > 0:
        scores = {k: v / total * 100 for k, v in scores.items()}
    return scores


def warm_up() -> None:
    """Runs one dummy inference at startup so model weights load before the
    first real request, instead of stalling the user's first analysis call."""
    dummy = np.zeros((config.FACE_RESIZE_DIM, config.FACE_RESIZE_DIM, 3), dtype=np.uint8)
    try:
        analyze_emotion(dummy)
        print("[AURA] DeepFace emotion model warmed up successfully.")
    except Exception as exc:  # noqa: BLE001 - startup diagnostics, not a request path
        print(f"[AURA] DeepFace warm-up failed: {exc}")
