"""Turns acoustic measurements into a smoothed, honest voice signal.

Two problems this module exists to solve:

1. A SINGLE FEATURE MUST NOT PRODUCE A LABEL. Raised pitch alone is not
   distress - it is also laughter, emphasis, a question, or a naturally
   high-pitched voice. Every observation here requires agreement across
   several independent features, and the observation names the SIGNAL
   ("elevated vocal activation"), never the person's state.

2. ONE WINDOW MUST NOT SWING THE RESULT. Features are smoothed with an EMA
   across a session's recent windows before any observation is derived, so a
   cough or a door slam cannot flip the reading. The smoothing is applied to
   the CONTINUOUS FEATURES, not to the chosen label - smoothing labels would
   let an early guess entrench itself, which is the failure mode the facial
   pipeline already documents in smoothing.smoothed_support.

Normalisation is relative to the SPEAKER'S OWN running baseline once enough
windows exist. Absolute pitch thresholds misread anyone whose natural voice
sits outside the assumed range; a person is compared to themselves.
"""
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from . import config

# Windows of a speaker's own audio required before deviation-from-baseline is
# trusted. Below this, observations are reported as still-calibrating.
BASELINE_MIN_WINDOWS = 4

# EMA weight for the newest window's features.
FEATURE_EMA_ALPHA = 0.45

# EMA weight for the slower baseline. Deliberately much smaller so the
# baseline tracks the speaker's voice, not the last few seconds of it.
BASELINE_EMA_ALPHA = 0.08

# A feature must deviate at least this far (in baseline standard deviations)
# to count as evidence toward an observation.
DEVIATION_THRESHOLD = 0.8

# How many features must agree before an observation is named.
MIN_AGREEING_FEATURES = 2

SESSION_TTL_SECONDS = 600

# Features that participate in observation derivation, and the direction that
# indicates heightened vocal activation. jitter/shimmer/hnr_strain are voice-
# QUALITY features (cycle-to-cycle stability, via Praat) rather than prosody -
# a rough or breathy voice is a distinct kind of evidence from "louder" or
# "higher-pitched", so it is tracked as its own agreeing signal rather than
# folded into pitch/energy.
_ACTIVATION_FEATURES = ("pitch", "energy", "speech_rate", "pitch_variation")
_SUBDUED_FEATURES = ("energy", "pitch", "speech_rate")
_STRAIN_FEATURES = ("jitter", "shimmer", "hnr_strain")


@dataclass
class _SessionState:
    smoothed: Dict[str, float] = field(default_factory=dict)
    baseline_mean: Dict[str, float] = field(default_factory=dict)
    baseline_var: Dict[str, float] = field(default_factory=dict)
    windows: int = 0
    last_seen: float = field(default_factory=time.time)


_sessions: Dict[str, _SessionState] = {}
_lock = threading.Lock()


def _evict_stale(now: float) -> None:
    for sid in [s for s, st in _sessions.items() if now - st.last_seen > SESSION_TTL_SECONDS]:
        _sessions.pop(sid, None)


def reset_session(session_id: str) -> None:
    """Drops a session's smoothing and baseline state."""
    with _lock:
        _sessions.pop(session_id, None)


def session_window_count(session_id: str) -> int:
    with _lock:
        st = _sessions.get(session_id)
        return st.windows if st else 0


def _update(session_id: str, raw: Dict[str, float]) -> Tuple[Dict[str, float], Dict[str, float], int]:
    """Folds this window's features into the session's smoothed values and
    running baseline. Returns (smoothed, z_scores, window_count)."""
    now = time.time()
    with _lock:
        _evict_stale(now)
        st = _sessions.setdefault(session_id, _SessionState())
        st.last_seen = now
        st.windows += 1

        for name, value in raw.items():
            if name in st.smoothed:
                st.smoothed[name] = (
                    FEATURE_EMA_ALPHA * value + (1 - FEATURE_EMA_ALPHA) * st.smoothed[name]
                )
            else:
                st.smoothed[name] = value

            # Welford-style EMA mean/variance for the speaker's own baseline.
            if name in st.baseline_mean:
                delta = value - st.baseline_mean[name]
                st.baseline_mean[name] += BASELINE_EMA_ALPHA * delta
                st.baseline_var[name] = (1 - BASELINE_EMA_ALPHA) * (
                    st.baseline_var[name] + BASELINE_EMA_ALPHA * delta * delta
                )
            else:
                st.baseline_mean[name] = value
                st.baseline_var[name] = 0.0

        smoothed = dict(st.smoothed)
        windows = st.windows

        z: Dict[str, float] = {}
        if windows >= BASELINE_MIN_WINDOWS:
            for name, value in smoothed.items():
                sd = st.baseline_var.get(name, 0.0) ** 0.5
                # A near-zero spread means this feature has not varied enough
                # for a deviation to mean anything yet.
                if sd > 1e-3:
                    z[name] = (value - st.baseline_mean[name]) / sd

    return smoothed, z, windows


def _clip01(x: float) -> float:
    return max(0.0, min(1.0, x))


def normalize_features(
    features,
    timing: Dict[str, float],
    quality_rms: float,
) -> Dict[str, Optional[float]]:
    """Maps raw acoustic values onto 0-1 display scales.

    These scales are for the bars only. Observation logic uses deviation from
    the speaker's own baseline, not these absolute positions, so a naturally
    high or quiet voice is not permanently pinned near an extreme.
    Returns None for anything not actually measured.
    """
    out: Dict[str, Optional[float]] = {}

    if features.available and features.pitch_mean_hz > 0:
        span = config.PITCH_FMAX - config.PITCH_FMIN
        out["pitch"] = _clip01((features.pitch_mean_hz - config.PITCH_FMIN) / span)
        # Pitch std of ~50 Hz is already a highly variable delivery.
        out["pitch_variation"] = _clip01(features.pitch_std_hz / 50.0)
    else:
        out["pitch"] = None
        out["pitch_variation"] = None

    if quality_rms > 0:
        out["energy"] = _clip01(quality_rms / (config.AUDIO_TARGET_RMS * 2.0))
    else:
        out["energy"] = None

    out["energy_variation"] = (
        _clip01(features.energy_variability) if features.available else None
    )

    if timing.get("available"):
        # ~5 voiced onsets/sec is fast conversational speech.
        out["speech_rate"] = _clip01(float(timing.get("onset_rate", 0.0)) / 5.0)
        out["pause_ratio"] = _clip01(float(timing.get("pause_ratio", 0.0)))
        out["voiced_ratio"] = _clip01(float(timing.get("speech_ratio", 0.0)))
    else:
        out["speech_rate"] = None
        out["pause_ratio"] = None
        out["voiced_ratio"] = None

    if features.available and features.spectral_centroid > 0:
        # Centroid above ~4 kHz is a bright/tense spectrum for speech.
        out["spectral_centroid"] = _clip01(features.spectral_centroid / 4000.0)
    else:
        out["spectral_centroid"] = None

    # Voice quality (Praat). Reference points come from established clinical
    # thresholds for perceptible roughness, not an arbitrary scale: ~1.04%
    # local jitter and ~3.81% local shimmer are the commonly cited limits of
    # normal phonation, so this maps THOSE limits to the middle of the 0-1
    # range rather than an endpoint. All three are oriented so higher = more
    # strain, matching the rest of this module's convention.
    if getattr(features, "voice_quality_available", False):
        out["jitter"] = _clip01(features.jitter_local / 0.02)
        out["shimmer"] = _clip01(features.shimmer_local / 0.08)
        # HNR: clear phonation is ~20 dB+; breathy/strained voices sit lower.
        # Inverted so, like jitter/shimmer, higher = more strain.
        out["hnr_strain"] = _clip01(1.0 - (features.hnr_db / 20.0))
    else:
        out["jitter"] = None
        out["shimmer"] = None
        out["hnr_strain"] = None

    return out


def derive(
    session_id: str,
    normalized: Dict[str, Optional[float]],
) -> Tuple[str, float, List[str], Dict[str, float]]:
    """Derives the observed signal from smoothed, baseline-relative features.

    Returns (observed, confidence, contributing_features, smoothed_values).
    """
    measured = {k: v for k, v in normalized.items() if v is not None}
    smoothed, z, windows = _update(session_id, measured)

    # Coverage: how much of the intended feature set was actually measurable.
    # A reading built on two features cannot be as confident as one built on
    # six, and saying so is the difference between a measurement and a guess.
    expected = len(_ACTIVATION_FEATURES) + len(_STRAIN_FEATURES) + 2
    coverage = _clip01(len(measured) / expected)

    if windows < BASELINE_MIN_WINDOWS:
        return (
            "Establishing this speaker's vocal baseline",
            round(20.0 * coverage, 1),
            sorted(measured.keys()),
            smoothed,
        )

    raised = [f for f in _ACTIVATION_FEATURES if z.get(f, 0.0) >= DEVIATION_THRESHOLD]
    lowered = [f for f in _SUBDUED_FEATURES if z.get(f, 0.0) <= -DEVIATION_THRESHOLD]
    strained = [f for f in _STRAIN_FEATURES if z.get(f, 0.0) >= DEVIATION_THRESHOLD]
    hesitant = z.get("pause_ratio", 0.0) >= DEVIATION_THRESHOLD

    # Strength of the agreeing evidence, in baseline standard deviations.
    def strength(names: List[str]) -> float:
        if not names:
            return 0.0
        return sum(abs(z.get(n, 0.0)) for n in names) / len(names)

    if len(raised) >= MIN_AGREEING_FEATURES:
        observed = "Elevated vocal activation"
        contributing = raised
    elif len(strained) >= MIN_AGREEING_FEATURES:
        # Roughness/breathiness deviating from THIS speaker's own baseline
        # voice quality - distinct from "louder" or "faster", which raised/
        # lowered above already cover.
        observed = "Change in vocal quality (rougher or more strained)"
        contributing = strained
    elif len(lowered) >= MIN_AGREEING_FEATURES:
        observed = "Reduced vocal activation"
        contributing = lowered
    elif hesitant and len(raised) + len(lowered) < MIN_AGREEING_FEATURES:
        observed = "Frequent pausing in delivery"
        contributing = ["pause_ratio"]
    else:
        # Not "neutral" - an absence of deviation is a statement about the
        # signal being steady, not a claim about the speaker.
        observed = "Steady vocal delivery"
        contributing = sorted(measured.keys())

    # Confidence combines HOW MUCH we measured with HOW STRONGLY it deviated.
    # Capped below 100: an acoustic observation over a few seconds is never
    # certain, and a full-confidence bar would overstate it.
    dev = strength(contributing) if observed != "Steady vocal delivery" else 0.6
    confidence = _clip01(0.35 * coverage + 0.45 * _clip01(dev / 2.0) + 0.20 * coverage) * 92.0

    return observed, round(confidence, 1), contributing, smoothed
