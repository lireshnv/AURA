"""Live 0-100 distress signal for the dashboard, with named contributing factors.

This is the simple, real-time counterpart to distress_engine.py (which produces
the deeper end-of-session report). It answers one question during a live
session: "is there something here a human should look at?"

It is explicitly a PROTOTYPE DECISION-SUPPORT SIGNAL, not a clinical measure.
Every factor is a measured signal with a stated weight, so the score can always
be decomposed into why it moved. Nothing here diagnoses anything.

A single frame or a single word can never drive the score: every input is an
aggregate over the rolling session window, and the score is scaled down when
the observations feeding it were unreliable.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from . import config

NEGATIVE_EMOTIONS = ("sad", "angry", "fear", "disgust")

# Transparent factor weights. Exposed in the response so the UI can show how
# the number was composed rather than presenting it as an oracle.
FACTOR_WEIGHTS = {
    "negative_expression": 0.35,
    "negative_sentiment": 0.20,
    "voice_pattern": 0.20,
    "expression_change": 0.15,
    "engagement": 0.10,
}


@dataclass
class DistressSignal:
    score: float = 0.0
    level: str = "GREEN"          # GREEN | AMBER | RED
    confidence: float = 0.0
    factors: List[Dict] = field(default_factory=list)
    components: Dict[str, float] = field(default_factory=dict)
    disclaimer: str = (
        "Prototype decision-support signal - not a clinical diagnosis."
    )
    insufficient_data: bool = False


def _level(score: float) -> str:
    if score >= 70:
        return "RED"
    if score >= 40:
        return "AMBER"
    return "GREEN"


def _negative_share(scores: Optional[Dict[str, float]]) -> float:
    if not scores:
        return 0.0
    total = sum(scores.values()) or 1.0
    return sum(scores.get(k, 0.0) for k in NEGATIVE_EMOTIONS) / total * 100


def compute_signal(
    *,
    emotion_window: List[Dict],
    sentiment_window: List[Dict],
    voice_stress: Optional[float] = None,
    face_motion: Optional[float] = None,
    reliability: float = 100.0,
    min_observations: int = 5,
) -> DistressSignal:
    """Builds the live signal from rolling-window aggregates.

    emotion_window   - recent per-observation emotion score dicts
    sentiment_window - recent sentiment score dicts (positive/neutral/negative)
    voice_stress     - 0-1 vocal-pattern composite, if voice is active
    face_motion      - 0-100 mean facial motion, proxy for engagement
    reliability      - 0-100 confidence in the observations themselves
    """
    signal = DistressSignal()

    if len(emotion_window) < min_observations:
        signal.insufficient_data = True
        signal.confidence = 0.0
        signal.factors = [
            {
                "label": "Insufficient observations",
                "direction": "neutral",
                "detail": f"{len(emotion_window)} of {min_observations} needed",
            }
        ]
        return signal

    components: Dict[str, float] = {}
    factors: List[Dict] = []

    # --- 1. Sustained negative facial expression --------------------------
    negatives = [_negative_share(o) for o in emotion_window]
    mean_negative = sum(negatives) / len(negatives)
    components["negative_expression"] = mean_negative
    if mean_negative > 35:
        factors.append(
            {
                "label": "Negative expression signal",
                "direction": "up",
                "detail": f"averaged {mean_negative:.0f}% across the window",
            }
        )

    # --- 2. Negative sentiment from spoken content ------------------------
    if sentiment_window:
        mean_neg_sentiment = sum(s.get("negative", 0.0) for s in sentiment_window) / len(
            sentiment_window
        )
        components["negative_sentiment"] = mean_neg_sentiment
        if mean_neg_sentiment > 35:
            factors.append(
                {
                    "label": "Negative sentiment",
                    "direction": "up",
                    "detail": f"{mean_neg_sentiment:.0f}% of spoken content",
                }
            )

    # --- 3. Vocal pattern -------------------------------------------------
    if voice_stress is not None:
        components["voice_pattern"] = voice_stress * 100
        if voice_stress > 0.5:
            factors.append(
                {
                    "label": "Vocal pattern variation",
                    "direction": "up",
                    "detail": f"composite {voice_stress * 100:.0f}%",
                }
            )

    # --- 4. Change in expression over the window --------------------------
    if len(negatives) >= 4:
        mid = len(negatives) // 2
        delta = (sum(negatives[mid:]) / len(negatives[mid:])) - (
            sum(negatives[:mid]) / mid
        )
        # Only an INCREASE contributes; a face becoming calmer must not raise
        # a distress score.
        components["expression_change"] = max(0.0, min(100.0, delta * 2))
        if delta > 10:
            factors.append(
                {
                    "label": "Facial-expression change",
                    "direction": "up",
                    "detail": f"negative signal rose {delta:.0f} points",
                }
            )
        elif delta < -10:
            factors.append(
                {
                    "label": "Facial-expression change",
                    "direction": "down",
                    "detail": f"negative signal fell {abs(delta):.0f} points",
                }
            )

    # --- 5. Engagement (low facial motion = withdrawn/flat presentation) ---
    if face_motion is not None:
        engagement = max(0.0, min(100.0, 100.0 - face_motion))
        components["engagement"] = engagement
        if face_motion < 15:
            factors.append(
                {
                    "label": "Engagement",
                    "direction": "down",
                    "detail": f"low facial movement ({face_motion:.0f}%)",
                }
            )

    # --- Weighted composite over the factors that had data ---------------
    active = {k: v for k, v in components.items() if k in FACTOR_WEIGHTS}
    total_weight = sum(FACTOR_WEIGHTS[k] for k in active) or 1.0
    raw = sum(FACTOR_WEIGHTS[k] * v for k, v in active.items()) / total_weight

    # Unreliable observations must not produce a confident-looking score.
    reliability_factor = 0.5 + 0.5 * (max(0.0, min(100.0, reliability)) / 100)
    signal.score = round(max(0.0, min(100.0, raw * reliability_factor)), 1)
    signal.level = _level(signal.score)
    signal.components = {k: round(v, 1) for k, v in components.items()}

    # Confidence in the SIGNAL: how much data, how reliable, how many modalities.
    observation_factor = min(1.0, len(emotion_window) / 15) * 100
    modality_factor = 100.0 if sentiment_window or voice_stress is not None else 60.0
    signal.confidence = round(
        (observation_factor * 0.4 + reliability * 0.4 + modality_factor * 0.2), 1
    )

    if not factors:
        factors.append(
            {
                "label": "No elevated signals",
                "direction": "neutral",
                "detail": "measured signals stayed within their typical range",
            }
        )
    signal.factors = factors
    return signal


# --- Emotional themes ------------------------------------------------------
#
# Deliberately a transparent lexicon rather than a model. Two reasons:
#   * These are surfaced as "themes present in the transcript", i.e. an index
#     back into what was actually said - not an inference about the speaker.
#   * A theme classifier trained on emotion labels would duplicate the text
#     emotion model already running, with no independent evidence added.
# Every theme reports the exact matched words, so a reader can verify it.
THEME_LEXICON: Dict[str, List[str]] = {
    "worry / uncertainty": [
        "worried", "worry", "anxious", "nervous", "scared", "afraid", "unsure",
        "uncertain", "concerned", "what if", "hope not",
    ],
    "low mood": [
        "sad", "down", "hopeless", "empty", "tired", "exhausted", "numb",
        "worthless", "pointless", "give up",
    ],
    "isolation": [
        "alone", "lonely", "nobody", "no one", "myself", "isolated", "abandoned",
    ],
    "frustration": [
        "angry", "furious", "annoyed", "frustrated", "unfair", "fed up", "hate",
    ],
    "positive outlook": [
        "happy", "glad", "better", "good", "grateful", "thankful", "excited",
        "hopeful", "looking forward",
    ],
    "future orientation": [
        "tomorrow", "next week", "will be", "going to", "plan", "future", "soon",
    ],
}


def detect_themes(transcript: str) -> List[Dict]:
    """Themes present in the transcript, each with the words that matched.

    Returns matched evidence so a claim can always be checked against the
    actual words. Never infers a theme that has no literal match.
    """
    if not transcript:
        return []
    lowered = transcript.lower()
    found: List[Dict] = []
    for theme, keywords in THEME_LEXICON.items():
        matches = [k for k in keywords if k in lowered]
        if matches:
            found.append({"theme": theme, "matches": matches, "count": len(matches)})
    return sorted(found, key=lambda t: t["count"], reverse=True)
