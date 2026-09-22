"""Reliability scoring - deliberately separate from emotion confidence.

  confidence  = how strongly the fused evidence favours the winning emotion
  reliability = how much this *observation* deserves to be believed at all

They are different questions and are reported separately. A face could be
unmistakably smiling (high confidence) through a dark, blurry, half-turned
frame with two observations so far (low reliability), and the UI should say so
rather than blending the two into one falsely reassuring number.

Neither value is ever adjusted upward for presentation.
"""
from typing import Dict, Optional

from . import config

WEIGHTS = {
    "quality": 0.20,       # image quality (blur / brightness)
    "landmark": 0.16,      # were landmarks usable at this pose
    "visibility": 0.08,    # how much of the frame the face fills
    "temporal": 0.20,      # has the decision held steady
    "agreement": 0.26,     # do independent signals concur
    "observations": 0.10,  # is there enough history to mean anything
}


def signal_agreement(
    dominant: str,
    deepface_scores: Dict[str, float],
    support: Optional[Dict[str, float]],
) -> float:
    """0-100: do DeepFace and the geometry independently point the same way?

    This is the term that keeps the engine honest in both directions. When
    geometry outvotes DeepFace, agreement necessarily drops and the result is
    correctly reported as less reliable - the system is allowed to disagree
    with DeepFace, but not to hide that it did.
    """
    deepface_dominant = max(deepface_scores, key=deepface_scores.get) if deepface_scores else None
    parts = []

    # How much of DeepFace's own mass sits on the chosen label.
    parts.append(min(100.0, deepface_scores.get(dominant, 0.0) * 1.5))
    parts.append(100.0 if deepface_dominant == dominant else 35.0)

    if support is not None:
        parts.append(support.get(dominant, 0.0) * 100)

    return sum(parts) / len(parts)


def compute_reliability(
    quality_score: float,
    landmark_trust: float,
    visibility: float,
    temporal_stability: float,
    agreement_score: float,
    valid_observations: int,
) -> float:
    observation_factor = min(1.0, valid_observations / 5) * 100
    score = (
        quality_score * WEIGHTS["quality"]
        + (landmark_trust * 100) * WEIGHTS["landmark"]
        + visibility * WEIGHTS["visibility"]
        + temporal_stability * WEIGHTS["temporal"]
        + agreement_score * WEIGHTS["agreement"]
        + observation_factor * WEIGHTS["observations"]
    )
    return round(max(0.0, min(100.0, score)), 1)


def reliability_label(score: float) -> str:
    if score < 40:
        return "low"
    if score < 70:
        return "moderate"
    if score < 85:
        return "good"
    return "high"
