"""Multi-signal evidence fusion: turns DeepFace probabilities + per-region
facial geometry + temporal behaviour into one final emotion distribution.

The central rule this module exists to enforce:

    The final emotion is NEVER max(deepface_scores).

DeepFace is one signal among several. Geometry can outvote it when several
independent regions agree, and geometry can equally *fail* to outvote it when
the face is genuinely still - in which case Neutral correctly survives.

Two properties keep this honest rather than a thumb on the scale:

* There is no "if neutral then happy" rule, and no constant added to or
  subtracted from any emotion. Every number below is derived from a measured
  deviation from the user's own neutral baseline.

* Neutral is not privileged, but neither is it suppressed. Its geometric
  evidence is *stillness* (see neutral_evidence), so a motionless face scores
  high on it and a smiling face scores low on it, both for the same reason.
"""
from typing import Dict, List, Optional, Tuple

from . import config

# Which geometry fields belong to which face region, for region-weighted
# evidence and per-region motion.
REGION_FIELDS: Dict[str, Tuple[str, ...]] = {
    "mouth": (
        "mouth_width",
        "mouth_height",
        "mouth_open_ratio",
        "corner_lift",
        "corner_asymmetry",
        "upper_lip_thickness",
        "lower_lip_thickness",
    ),
    "eyes": ("left_eye_openness", "right_eye_openness", "eye_openness", "eye_asymmetry"),
    "brows": ("left_brow_eye_dist", "right_brow_eye_dist", "brow_eye_dist", "inner_brow_height"),
    "other": ("nose_mouth_dist",),
}


def clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


# --- Head-pose trust -------------------------------------------------------


def _ramp_trust(value: float, soft: float, hard: float) -> float:
    """1.0 below `soft`, ramping linearly to 0.0 at `hard`."""
    a = abs(value)
    if a <= soft:
        return 1.0
    span = hard - soft
    if span <= 0:
        return 0.0
    return clip01(1.0 - (a - soft) / span)


def pose_trust(yaw_ratio: float, pitch_deviation: float = 0.0) -> float:
    """How much the geometry from this pose can be trusted (0-1).

    Deliberately a soft ramp: 2D pose estimates are approximate, and a hard
    cutoff would let one slightly-off estimate throw away a whole frame's
    otherwise-good evidence.
    """
    yaw_t = _ramp_trust(yaw_ratio, config.YAW_SOFT_THRESHOLD, config.MAX_YAW_RATIO)
    pitch_t = _ramp_trust(
        pitch_deviation, config.PITCH_SOFT_THRESHOLD, config.MAX_PITCH_DEVIATION
    )
    return yaw_t * pitch_t


# --- Geometry deltas vs. the user's own baseline ----------------------------


def geometry_delta(geometry, baseline: Dict[str, float]) -> Dict[str, float]:
    """Signed deviation of each baseline-compared field from the user's neutral."""
    return {
        field: getattr(geometry, field) - baseline[field]
        for field in baseline
        if hasattr(geometry, field)
    }


def region_signals(delta: Dict[str, float]) -> Dict[str, float]:
    """Named 0-1 expression signals derived from baseline deviations.

    Each is a *directional* reading of one muscle action, so opposite actions
    (corners up vs. corners down) are separate signals rather than the sign of
    one - that keeps the per-emotion evidence below readable.
    """
    g = delta.get

    corner_lift = g("corner_lift", 0.0)
    mouth_width_d = g("mouth_width", 0.0)
    mouth_open_d = g("mouth_open_ratio", 0.0)
    eye_open_d = g("eye_openness", 0.0)
    brow_d = g("brow_eye_dist", 0.0)
    inner_brow_d = g("inner_brow_height", 0.0)
    upper_lip_d = g("upper_lip_thickness", 0.0)
    lower_lip_d = g("lower_lip_thickness", 0.0)
    midface_d = g("nose_mouth_dist", 0.0)

    # Lip compression: both lips thinning = pressed together (tension).
    lip_compression = clip01(-(upper_lip_d + lower_lip_d) / 2 * config.LIP_TENSION_GAIN)

    return {
        # Mouth
        "smile": clip01(corner_lift * config.SMILE_GAIN),
        "mouth_widening": clip01(mouth_width_d * config.MOUTH_WIDTH_GAIN),
        "mouth_open": clip01(mouth_open_d * config.MOUTH_OPEN_GAIN),
        "corner_droop": clip01(-corner_lift * config.SMILE_GAIN),
        "lip_compression": lip_compression,
        "upper_lip_raise": clip01(-upper_lip_d * config.LIP_TENSION_GAIN),
        # Eyes
        "eye_widening": clip01(eye_open_d * config.EYE_GAIN),
        "eye_narrowing": clip01(-eye_open_d * config.EYE_GAIN),
        # Brows
        "brow_raise": clip01(brow_d * config.BROW_GAIN),
        "brow_lower": clip01(-brow_d * config.BROW_GAIN),
        "inner_brow_raise": clip01(inner_brow_d * config.INNER_BROW_GAIN),
        # Midface
        "midface_change": clip01(abs(midface_d) * config.MOTION_GAIN),
    }


def region_activity(delta: Dict[str, float]) -> Dict[str, float]:
    """Per-region 0-1 magnitude of deviation from baseline (how 'busy' a region is).

    Uses the MAXIMUM deviation across the region's fields, not the mean. A
    region is active if any one of its measurements has moved substantially -
    averaging instead would let a real signal be diluted by the unrelated
    fields that happened to stay put (a smile moves 2 of the 7 mouth fields,
    and the other 5 zeros would wash it out).
    """
    activity: Dict[str, float] = {}
    for region, fields in REGION_FIELDS.items():
        values = [abs(delta.get(f, 0.0)) for f in fields if f in delta]
        magnitude = max(values) if values else 0.0
        activity[region] = clip01(magnitude * config.MOTION_GAIN)
    return activity


def region_motion(motion_delta: Dict[str, float]) -> Dict[str, float]:
    """Per-region frame-to-frame motion (0-100), plus an 'overall' key.

    This is what separates a static neutral face from a face mid-transition
    into an expression - the distinction the whole engine hinges on.
    """
    motion: Dict[str, float] = {}
    for region, fields in REGION_FIELDS.items():
        values = [abs(motion_delta.get(f, 0.0)) for f in fields if f in motion_delta]
        magnitude = sum(values) / len(values) if values else 0.0
        motion[region] = round(clip01(magnitude * config.MOTION_GAIN) * 100, 1)

    all_values = [abs(v) for v in motion_delta.values()]
    overall = sum(all_values) / len(all_values) if all_values else 0.0
    motion["overall"] = round(clip01(overall * config.MOTION_GAIN) * 100, 1)
    return motion


# --- Per-emotion, region-weighted evidence ---------------------------------


def _weighted_regions(contributions: Dict[str, float]) -> float:
    """Combines per-region sub-scores using REGION_WEIGHTS.

    Only the regions a given emotion actually has a signal for are counted,
    and the result is renormalized by their weight. Otherwise an emotion whose
    evidence legitimately lives in one region (e.g. a smile, mostly mouth)
    would be diluted by regions that have nothing to say about it.
    """
    weights = config.REGION_WEIGHTS
    total_weight = sum(weights[r] for r in contributions)
    if total_weight <= 0:
        return 0.0
    return clip01(
        sum(weights[r] * clip01(v) for r, v in contributions.items()) / total_weight
    )


def emotion_evidence(signals: Dict[str, float]) -> Dict[str, float]:
    """0-1 geometric evidence per emotion, region-weighted.

    These are evidence strengths, not probabilities - they do not sum to 1,
    and several can be high at once (an open mouth supports both surprise and
    fear). Disambiguation is the fusion step's job, with DeepFace's help.
    """
    s = signals

    happy = _weighted_regions(
        {
            "mouth": 0.65 * s["smile"] + 0.35 * s["mouth_widening"],
            # Genuine smiles narrow the eyes slightly (Duchenne marker); capped
            # so a hard squint alone can't masquerade as happiness.
            "eyes": min(s["eye_narrowing"], 0.6),
            "other": s["midface_change"],
        }
    )

    sad = _weighted_regions(
        {
            "mouth": s["corner_droop"],
            "eyes": min(s["eye_narrowing"], 0.7),
            # Inner brows drawn up is the distinctive sadness brow action,
            # as opposed to the whole brow rising (surprise).
            "brows": s["inner_brow_raise"],
        }
    )

    angry = _weighted_regions(
        {
            "mouth": 0.6 * s["lip_compression"] + 0.4 * s["corner_droop"],
            "eyes": s["eye_narrowing"],
            "brows": s["brow_lower"],
        }
    )

    surprise = _weighted_regions(
        {
            "mouth": s["mouth_open"],
            "eyes": s["eye_widening"],
            "brows": s["brow_raise"],
        }
    )

    fear = _weighted_regions(
        {
            "mouth": 0.7 * s["mouth_open"],
            # Fear reads as wider eyes than surprise for a comparable brow raise.
            "eyes": s["eye_widening"],
            "brows": 0.8 * s["brow_raise"],
        }
    )

    disgust = _weighted_regions(
        {
            "mouth": 0.5 * s["upper_lip_raise"] + 0.5 * s["lip_compression"],
            "other": s["midface_change"],
        }
    )

    return {
        "happy": happy,
        "sad": sad,
        "angry": angry,
        "surprise": surprise,
        "fear": fear,
        "disgust": disgust,
    }


def neutral_evidence(
    activity: Dict[str, float], motion: Dict[str, float], strongest_other: float
) -> float:
    """Geometric evidence FOR neutral: measured stillness.

    Neutral is the *absence* of expression, not a competing expression, so the
    absence term is applied MULTIPLICATIVELY: neutral support can never exceed
    (1 - strongest expression evidence). A face with strong smile geometry is
    by definition not expressionless, so it cannot score highly here.

    That multiplication is also what stops the previous failure mode. When the
    absence term was merely additive, a big smile still scored ~0.67 neutral
    because the terms for "stable brows" and "stable eyes" paid out - but brows
    and eyes ARE relatively still during a genuine smile, so rewarding that
    stillness let Neutral collect credit for the smile's own signature.
    Stillness now only modulates a ceiling set by expression evidence.
    """
    weights = config.REGION_WEIGHTS
    stability = sum(weights[r] * (1.0 - clip01(activity.get(r, 0.0))) for r in weights)
    motion_stillness = 1.0 - clip01(motion.get("overall", 0.0) / 100)
    stillness = 0.6 * stability + 0.4 * motion_stillness

    absence = 1.0 - clip01(strongest_other)
    # Floor of 0.5 on the stillness factor: a still face with no expression
    # evidence must still reach ~1.0, so stillness tempers the ceiling rather
    # than compounding into a second penalty.
    return clip01(absence * (0.5 + 0.5 * stillness))


def landmark_support(delta: Dict[str, float], motion: Optional[Dict[str, float]] = None) -> Dict[str, float]:
    """Full per-emotion geometric support map, including neutral."""
    signals = region_signals(delta)
    activity = region_activity(delta)
    motion = motion or {"overall": 0.0}

    support = emotion_evidence(signals)
    strongest_other = max(support.values()) if support else 0.0
    support["neutral"] = neutral_evidence(activity, motion, strongest_other)
    return support


# --- Intensity / reaction --------------------------------------------------


def expression_intensity(
    support: Dict[str, float], motion_overall: float, deepface_neutral_prob: float
) -> float:
    """0-100 strength of the observed facial reaction (NOT its valence).

    A strongly positive reaction and a strongly negative one both score high;
    this measures how much the face is doing, not whether it is good or bad.
    """
    best_support = max((v for k, v in support.items() if k != "neutral"), default=0.0)
    motion_norm = clip01(motion_overall / 100)
    deepface_departure = clip01(1 - deepface_neutral_prob / 100)
    intensity = 0.45 * best_support + 0.25 * motion_norm + 0.30 * deepface_departure
    return round(clip01(intensity) * 100, 1)


def reaction_label(intensity: float) -> str:
    if intensity < config.REACTION_MINIMAL_MAX:
        return "Minimal"
    if intensity < config.REACTION_MILD_MAX:
        return "Mild"
    if intensity < config.REACTION_MODERATE_MAX:
        return "Moderate"
    return "Strong"


# --- Fusion ----------------------------------------------------------------


def fuse(
    deepface_scores: Dict[str, float],
    support: Optional[Dict[str, float]],
    smoothed_support: Dict[str, float],
    quality_score: float,
    yaw_ratio: float = 0.0,
    pitch_deviation: float = 0.0,
) -> Dict[str, float]:
    """Returns the FINAL fused 0-100 distribution, summing to ~100.

    This distribution - not DeepFace's - is what the dashboard, the graph and
    the report all display.

    `support` is this frame's instantaneous geometry evidence (None when
    withheld: calibrating, or no landmarks). `smoothed_support` is an EMA of
    that same evidence, which is what lets an expression building over 2-3
    frames earn real weight while a single odd frame cannot flip the result.

    Note the temporal term smooths the *evidence signal*, never a vote for
    whichever label previously won - that latter design self-reinforces and is
    exactly how Neutral came to dominate a previous revision of this engine.
    """
    weights = config.FUSION_WEIGHTS
    quality_factor = clip01(quality_score / 100)
    landmark_trust = quality_factor * pose_trust(yaw_ratio, pitch_deviation)

    # Geometry is only as trustworthy as the image and pose it was measured
    # from. As that trust falls, its weight moves back to DeepFace (which
    # degrades more gracefully) rather than the frame being discarded.
    landmark_weight = weights["landmarks"] * landmark_trust
    temporal_weight = weights["temporal"] * landmark_trust
    deepface_weight = (
        weights["deepface"]
        + weights["quality"]
        + (weights["landmarks"] - landmark_weight)
        + (weights["temporal"] - temporal_weight)
    )

    # DeepFace's NEUTRAL vote is credible only to the extent that direct
    # measurement of the same face agrees the face is expressionless. When
    # geometry measures strong expression evidence, DeepFace's neutral reading
    # is the specific claim being contradicted, so it is discounted in
    # proportion to the strength of that contradicting evidence.
    #
    # This is a discount, never a boost: no emotion ever gains a constant, and
    # when geometry finds no expression (strongest_expression ~ 0) the factor
    # is 1.0 and DeepFace's neutral vote counts in full - which is why a
    # genuinely still face still resolves to Neutral. The discount also only
    # applies when landmarks were actually available and trusted for this
    # frame; with no geometry to contradict it, DeepFace stands unmodified.
    neutral_credibility = 1.0
    if support is not None and landmark_trust > 0:
        strongest_expression = max(
            (v for k, v in support.items() if k != "neutral"), default=0.0
        )
        contradiction = clip01(strongest_expression) * landmark_trust
        neutral_credibility = 1.0 - contradiction

    fused: Dict[str, float] = {}
    for emotion in config.EMOTION_KEYS:
        deepface_component = deepface_weight * (deepface_scores.get(emotion, 0.0) / 100)
        if emotion == "neutral":
            deepface_component *= neutral_credibility
        fused[emotion] = (
            deepface_component
            + landmark_weight * (support.get(emotion, 0.0) if support else 0.0)
            + temporal_weight * smoothed_support.get(emotion, 0.0)
        )

    total = sum(fused.values())
    if total > 0:
        fused = {k: v / total * 100 for k, v in fused.items()}
    return fused


# --- Explainability -------------------------------------------------------

_SIGNAL_LABELS = {
    "smile": "lip-corner elevation (smile geometry)",
    "mouth_widening": "mouth widening",
    "mouth_open": "mouth opening",
    "corner_droop": "downturned mouth corners",
    "lip_compression": "lip compression / tension",
    "upper_lip_raise": "upper-lip raise",
    "eye_widening": "widened eyes",
    "eye_narrowing": "narrowed eyes",
    "brow_raise": "raised eyebrows",
    "brow_lower": "lowered / compressed brows",
    "inner_brow_raise": "inner-brow raise",
    "midface_change": "midface movement",
}

# The signals each emotion's evidence is actually built from, so an
# explanation only ever cites measurements that fed that specific decision.
_EMOTION_SIGNALS = {
    "happy": ("smile", "mouth_widening", "eye_narrowing", "midface_change"),
    "sad": ("corner_droop", "eye_narrowing", "inner_brow_raise"),
    "angry": ("lip_compression", "corner_droop", "eye_narrowing", "brow_lower"),
    "surprise": ("mouth_open", "eye_widening", "brow_raise"),
    "fear": ("mouth_open", "eye_widening", "brow_raise"),
    "disgust": ("upper_lip_raise", "lip_compression", "midface_change"),
}


def explain(
    dominant: str,
    signals: Optional[Dict[str, float]],
    motion: Dict[str, float],
    deepface_scores: Dict[str, float],
    stability: float,
    observations: int,
) -> List[str]:
    """Human-readable reasons, generated strictly from measured values.

    Nothing here is templated flattery or invented narrative - every line is
    gated on an actual number crossing an actual threshold, which is why a
    Neutral verdict can be interrogated as readily as a Happy one.
    """
    reasons: List[str] = []
    deepface_prob = deepface_scores.get(dominant, 0.0)

    if dominant == "neutral":
        if signals is not None:
            if signals.get("smile", 0.0) < 0.2:
                reasons.append("Low smile evidence (lip corners near their resting position)")
            if motion.get("mouth", 0.0) < 25:
                reasons.append("Stable mouth geometry")
            if motion.get("eyes", 0.0) < 25:
                reasons.append("Stable eye geometry")
            if motion.get("brows", 0.0) < 25:
                reasons.append("Stable eyebrow geometry")
        if motion.get("overall", 0.0) < 30:
            reasons.append(f"Low overall facial motion ({motion.get('overall', 0.0):.0f}%)")
        if deepface_prob >= 30:
            reasons.append(f"DeepFace also assigns neutral a high probability ({deepface_prob:.0f}%)")
    else:
        if signals is not None:
            for key in _EMOTION_SIGNALS.get(dominant, ()):  # cite only relevant signals
                value = signals.get(key, 0.0)
                if value >= 0.35:
                    reasons.append(f"{_SIGNAL_LABELS[key].capitalize()} ({value * 100:.0f}%)")
        if motion.get("overall", 0.0) >= 30:
            reasons.append(f"Active facial movement ({motion.get('overall', 0.0):.0f}%)")
        if deepface_prob >= 15:
            reasons.append(f"Supported by DeepFace {dominant} probability ({deepface_prob:.0f}%)")

    if stability >= 60 and observations >= 3:
        reasons.append(f"Expression persisted across recent observations ({stability:.0f}% consistency)")

    if not reasons:
        reasons.append("Evidence was weak across all signals; result is low-confidence")
    return reasons
