"""Distress scoring, risk banding and escalation routing.

Implements the transparent prototype score from the spec:

    40% self-report | 25% sentiment | 20% behaviour change | 15% engagement change

Every component is a measured aggregate with a published weight, so any score
can be decomposed into exactly why it moved. Components with no data are
dropped and the remaining weights renormalized, so a person who has not spoken
is scored on what actually exists rather than penalised for silence.

HARD CONSTRAINTS
----------------
* This is a PROTOTYPE DECISION-SUPPORT SCORE, not a clinical instrument, and
  every payload says so.
* No band, including RED, triggers a real-world intervention. Bands route to a
  human review queue at different priorities. `autonomous_action` is always
  False and there is no code path that sets it True.
* Risk is never stated deterministically. Language is "signals indicate",
  never "will".
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

from .digital_twin import DigitalTwin

SCORE_WEIGHTS = {
    "self_report": 0.40,
    "sentiment": 0.25,
    "behaviour_change": 0.20,
    "engagement_change": 0.15,
}

RISK_BANDS = (
    (0, 30, "GREEN", "Low", "Routine monitoring"),
    (31, 60, "AMBER", "Moderate", "Counsellor review queue"),
    (61, 100, "RED", "Elevated", "Priority authorised human review"),
)


@dataclass
class RiskAssessment:
    score: float = 0.0
    band: str = "GREEN"
    level: str = "Low"
    routing: str = "Routine monitoring"
    confidence: float = 0.0
    components: Dict[str, float] = field(default_factory=dict)
    weights_used: Dict[str, float] = field(default_factory=dict)
    contributing_factors: List[Dict] = field(default_factory=list)
    recent_changes: List[str] = field(default_factory=list)
    case_context: List[str] = field(default_factory=list)
    limitations: List[str] = field(default_factory=list)
    human_review_required: bool = True
    autonomous_action: bool = False
    insufficient_data: bool = False
    disclaimer: str = (
        "Prototype decision-support score - not a clinical diagnosis. "
        "A human reviewer makes every intervention decision."
    )
    assessed_at: str = ""


def _band(score: float):
    for low, high, band, level, routing in RISK_BANDS:
        if low <= score <= high:
            return band, level, routing
    return "GREEN", "Low", "Routine monitoring"


def compute_risk(
    twin: DigitalTwin,
    sentiment_negative: Optional[float] = None,
    case_events: Optional[List[Dict]] = None,
    signal_deviation: Optional[float] = None,
) -> RiskAssessment:
    """Computes the distress score and risk band for one twin.

    twin              - the person's digital twin
    sentiment_negative- 0-100 mean negative sentiment from recent sessions
    case_events       - upcoming legal/case milestones
    signal_deviation  - 0-100 movement in observed face/voice signals
    """
    assessment = RiskAssessment(assessed_at=datetime.now(timezone.utc).isoformat())
    case_events = case_events or []

    if not twin.baseline.is_established():
        assessment.insufficient_data = True
        assessment.confidence = round(twin.baseline.confidence * 0.5, 1)
        assessment.limitations.append(
            "Personal baseline is not yet established; risk cannot be assessed "
            "against this person's own normal."
        )
        assessment.contributing_factors.append(
            {
                "factor": "Baseline still building",
                "direction": "neutral",
                "detail": f"{twin.baseline.observations} observation(s) so far",
            }
        )
        return assessment

    components: Dict[str, float] = {}

    # --- 1. Self-report: adverse movement from personal baseline ----------
    components["self_report"] = twin.deviation.overall
    for dim in twin.deviation.worsening:
        z = twin.deviation.per_dimension.get(dim, 0.0)
        assessment.contributing_factors.append(
            {
                "factor": dim.replace("_", " ").capitalize(),
                "direction": "down",
                "detail": f"{abs(z):.1f}x below their usual range",
            }
        )
    for dim in twin.deviation.improving:
        assessment.contributing_factors.append(
            {
                "factor": dim.replace("_", " ").capitalize(),
                "direction": "up",
                "detail": "above their usual range",
            }
        )

    # --- 2. Sentiment of what was actually said ---------------------------
    if sentiment_negative is not None:
        components["sentiment"] = max(0.0, min(100.0, sentiment_negative))
        if sentiment_negative > 45:
            assessment.contributing_factors.append(
                {
                    "factor": "Negative sentiment",
                    "direction": "up",
                    "detail": f"{sentiment_negative:.0f}% of recent spoken content",
                }
            )

    # --- 3. Behaviour change: observed face/voice signal movement ---------
    if signal_deviation is not None:
        components["behaviour_change"] = max(0.0, min(100.0, signal_deviation))
        if signal_deviation > 45:
            assessment.contributing_factors.append(
                {
                    "factor": "Observed expression signals",
                    "direction": "up",
                    "detail": f"movement of {signal_deviation:.0f}% from typical",
                }
            )

    # --- 4. Engagement change --------------------------------------------
    engagement_component = (1.0 - twin.engagement.engagement_ratio) * 100
    if twin.engagement.changed:
        engagement_component = min(100.0, engagement_component + 20)
    components["engagement_change"] = round(engagement_component, 1)
    if twin.engagement.changed or twin.engagement.missed_last_7d >= 3:
        assessment.contributing_factors.append(
            {
                "factor": "Check-in engagement",
                "direction": "down",
                "detail": f"{twin.engagement.checkins_last_7d} of "
                f"{twin.engagement.expected_last_7d} check-ins this week",
            }
        )

    # --- Weighted composite, renormalized over available components -------
    active_weight = sum(SCORE_WEIGHTS[k] for k in components) or 1.0
    raw = sum(SCORE_WEIGHTS[k] * v for k, v in components.items()) / active_weight

    assessment.score = round(max(0.0, min(100.0, raw)), 1)
    assessment.components = {k: round(v, 1) for k, v in components.items()}
    assessment.weights_used = {
        k: round(SCORE_WEIGHTS[k] / active_weight, 3) for k in components
    }
    assessment.band, assessment.level, assessment.routing = _band(assessment.score)

    # --- Trend as a recent change, not a score input ----------------------
    if twin.trend.direction == "worsening":
        assessment.recent_changes.append(
            f"Self-reported well-being declined over the last "
            f"{twin.trend.sessions_compared} check-ins."
        )
    elif twin.trend.direction == "improving":
        assessment.recent_changes.append(
            f"Self-reported well-being improved over the last "
            f"{twin.trend.sessions_compared} check-ins."
        )
    if twin.engagement.days_since_last_checkin is not None and (
        twin.engagement.days_since_last_checkin > 3
    ):
        assessment.recent_changes.append(
            f"No check-in for {twin.engagement.days_since_last_checkin:.0f} days."
        )

    # --- Case context: correlation only, never causation ------------------
    for event in case_events:
        days = event.get("days_until")
        if days is not None and 0 <= days <= 14:
            assessment.case_context.append(
                f"{event.get('title', 'Case event')} in {int(days)} day(s)."
            )
    if assessment.case_context and twin.trend.direction == "worsening":
        assessment.case_context.append(
            "Check-ins around previous case events also showed increased distress "
            "signals. This is an observed association, not a cause."
        )

    # --- Confidence -------------------------------------------------------
    modality_factor = min(1.0, len(components) / len(SCORE_WEIGHTS)) * 100
    assessment.confidence = round(
        (twin.baseline.confidence * 0.4)
        + (min(1.0, twin.current.observations / 7) * 100 * 0.3)
        + (modality_factor * 0.3),
        1,
    )

    # --- Limitations ------------------------------------------------------
    if twin.baseline.confidence < 60:
        assessment.limitations.append(
            f"Baseline confidence is {twin.baseline.confidence:.0f}%; comparisons "
            f"against this person's normal are still provisional."
        )
    if len(components) < len(SCORE_WEIGHTS):
        missing = sorted(set(SCORE_WEIGHTS) - set(components))
        assessment.limitations.append(
            f"No data for: {', '.join(m.replace('_', ' ') for m in missing)}. "
            f"Remaining weights were renormalized."
        )
    assessment.limitations.append(
        "Signals indicate patterns that may warrant attention. They do not "
        "establish a person's psychological state."
    )

    if not assessment.contributing_factors:
        assessment.contributing_factors.append(
            {
                "factor": "No elevated signals",
                "direction": "neutral",
                "detail": "measured signals remained within this person's usual range",
            }
        )

    return assessment


def priority_score(assessment: RiskAssessment, twin: DigitalTwin) -> float:
    """Ordering key for the counsellor review queue.

    Deliberately separate from the risk score. A moderate score that is moving
    fast, or is about to collide with a court date, can need attention sooner
    than a static higher score - and a low-confidence assessment should not
    outrank a well-evidenced one.
    """
    score = assessment.score
    if twin.trend.direction == "worsening":
        score += 12
    if twin.engagement.days_since_last_checkin and twin.engagement.days_since_last_checkin > 5:
        score += 8
    if assessment.case_context:
        score += 10
    # Low-confidence assessments are ranked slightly lower, not hidden.
    score *= 0.75 + 0.25 * (assessment.confidence / 100)
    return round(min(150.0, score), 1)
