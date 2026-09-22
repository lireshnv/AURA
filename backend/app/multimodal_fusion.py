"""Fusion of face, voice and text emotion into one overall estimate.

Three rules shape this module:

1. It is NOT a blind average. Each modality's base weight is scaled by that
   modality's own confidence and signal quality, so a clear facial reading is
   not dragged around by a noisy 1-second audio window.

2. Weights renormalize over whatever is actually present. Face-only, voice-only
   and any combination are all valid; a missing modality contributes nothing
   rather than contributing a default.

3. Disagreement is surfaced, never smoothed away. When the modalities point
   different directions the agreement score falls and reliability falls with
   it. "I'm fine" said in a flat voice with a sad face SHOULD read as a
   low-agreement, low-reliability result - that disagreement is the finding.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config
from .sentiment import compute_sentiment

MODALITIES = ("face", "voice", "text")


@dataclass
class ModalityInput:
    """One modality's contribution. `quality` is the signal-quality score for
    that modality (image quality / audio quality / transcript adequacy)."""

    scores: Dict[str, float]
    confidence: float = 0.0
    quality: float = 0.0
    available: bool = True


@dataclass
class FusionResult:
    dominant: str = "uncertain"
    scores: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0
    reliability: float = 0.0
    agreement: float = 0.0
    agreement_label: str = "unknown"
    modalities_used: List[str] = field(default_factory=list)
    effective_weights: Dict[str, float] = field(default_factory=dict)
    per_modality_dominant: Dict[str, str] = field(default_factory=dict)
    disagreement: bool = False
    notes: List[str] = field(default_factory=list)


def _normalize(scores: Dict[str, float]) -> Dict[str, float]:
    filled = {k: max(0.0, float(scores.get(k, 0.0))) for k in config.EMOTION_KEYS}
    total = sum(filled.values())
    if total <= 0:
        return {k: 0.0 for k in config.EMOTION_KEYS}
    return {k: v / total * 100 for k, v in filled.items()}


def compute_agreement(per_modality_scores: Dict[str, Dict[str, float]]) -> float:
    """0-100 agreement across the available modalities.

    Uses the mean pairwise overlap of the full distributions rather than only
    comparing top labels, so "happy 51 / sad 49" versus "happy 49 / sad 51"
    is correctly reported as near-total agreement despite differing winners.
    """
    names = [m for m, s in per_modality_scores.items() if s]
    if len(names) < 2:
        return 100.0  # nothing to disagree with

    overlaps: List[float] = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a = _normalize(per_modality_scores[names[i]])
            b = _normalize(per_modality_scores[names[j]])
            # Histogram intersection: sum of elementwise minima, 0-100.
            overlaps.append(sum(min(a[k], b[k]) for k in config.EMOTION_KEYS))
    return round(sum(overlaps) / len(overlaps), 1)


def agreement_label(score: float) -> str:
    if score >= 70:
        return "high"
    if score >= 45:
        return "moderate"
    return "low"


def fuse_modalities(inputs: Dict[str, Optional[ModalityInput]]) -> FusionResult:
    """Fuses whichever modalities are present into one overall emotion."""
    present = {
        name: mi
        for name, mi in inputs.items()
        if mi is not None and mi.available and mi.scores and sum(mi.scores.values()) > 0
    }

    if not present:
        return FusionResult(
            dominant="uncertain",
            scores={k: 0.0 for k in config.EMOTION_KEYS},
            notes=["No modality produced a usable result; no emotion is reported."],
        )

    # --- Confidence/quality-scaled weights, renormalized over what's present.
    influence = config.MODALITY_QUALITY_INFLUENCE
    raw_weights: Dict[str, float] = {}
    for name, mi in present.items():
        base = config.MULTIMODAL_WEIGHTS.get(name, 0.0)
        # A modality with high confidence AND good signal quality keeps its
        # full base weight; a weak or noisy one is scaled down but, unless
        # influence is 1.0, never silenced entirely.
        signal = (max(0.0, min(100.0, mi.confidence)) / 100 * 0.6) + (
            max(0.0, min(100.0, mi.quality)) / 100 * 0.4
        )
        raw_weights[name] = base * ((1.0 - influence) + influence * signal)

    total_weight = sum(raw_weights.values())
    if total_weight <= 0:
        # Every present modality scored zero signal - fall back to the base
        # weights rather than dividing by zero or inventing a winner.
        raw_weights = {n: config.MULTIMODAL_WEIGHTS.get(n, 0.0) for n in present}
        total_weight = sum(raw_weights.values()) or 1.0

    weights = {n: w / total_weight for n, w in raw_weights.items()}

    fused = {k: 0.0 for k in config.EMOTION_KEYS}
    for name, mi in present.items():
        norm = _normalize(mi.scores)
        for emotion in config.EMOTION_KEYS:
            fused[emotion] += weights[name] * norm[emotion]

    fused = {k: round(v, 1) for k, v in _normalize(fused).items()}
    dominant = max(fused, key=fused.get)
    confidence = round(fused[dominant], 1)

    per_scores = {n: mi.scores for n, mi in present.items()}
    agreement = compute_agreement(per_scores)
    per_dominant = {n: max(_normalize(s), key=_normalize(s).get) for n, s in per_scores.items()}
    distinct = set(per_dominant.values())
    disagreement = len(distinct) > 1

    # Reliability blends the fused margin, cross-modal agreement, and the
    # average signal strength of the modalities that contributed. Disagreement
    # therefore lowers reliability by construction.
    avg_signal = sum(
        (mi.confidence * 0.6 + mi.quality * 0.4) for mi in present.values()
    ) / len(present)
    reliability = round(
        max(0.0, min(100.0, 0.40 * agreement + 0.35 * avg_signal + 0.25 * confidence)), 1
    )

    notes: List[str] = []
    if len(present) == 1:
        only = next(iter(present))
        notes.append(f"Only the {only} modality was available; overall estimate rests on it alone.")
    if disagreement:
        readable = ", ".join(f"{n}={d}" for n, d in sorted(per_dominant.items()))
        notes.append(f"Modalities indicate different emotions ({readable}); reliability reduced.")
    if agreement < 45 and len(present) > 1:
        notes.append("Signal consistency is low - treat the overall estimate with caution.")

    return FusionResult(
        dominant=dominant,
        scores=fused,
        confidence=confidence,
        reliability=reliability,
        agreement=agreement,
        agreement_label=agreement_label(agreement),
        modalities_used=sorted(present.keys()),
        effective_weights={n: round(w * 100, 1) for n, w in weights.items()},
        per_modality_dominant=per_dominant,
        disagreement=disagreement,
        notes=notes,
    )


def fused_sentiment(scores: Dict[str, float]) -> Dict[str, object]:
    """Sentiment from the fused multimodal distribution."""
    dominant, breakdown = compute_sentiment(scores)
    return {"dominant": dominant, "scores": breakdown}
