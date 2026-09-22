"""Risk & Trend for the real, consented user.

    Digital Twin -> Baseline Comparison -> Trend -> Confidence
                 -> Distress Signal -> Green/Amber/Red -> Explainable Alert

Reads ONLY the structured outputs already produced by the existing modules
(twin_store: baseline, check-ins, ingested face/voice/text signals). It never
re-analyses raw video or audio - that work is already done upstream and is not
repeated here.

NO FABRICATION. With too little real data this returns
"Insufficient data to calculate." and no score. A missing modality lowers
confidence rather than being filled with a default.

RED never contacts anyone. It raises a review alert inside the authorised
dashboard and nothing else; there is no notification or escalation code path
in this module.
"""
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Dict, List, Optional

from . import twin_store
from .digital_twin import BASELINE_DIMENSIONS, build_twin
from .risk_engine import SCORE_WEIGHTS, compute_risk

# Real observations needed before a distress signal is meaningful.
MIN_CHECKINS = 3
MIN_POINTS_FOR_GRAPH = 2

INSUFFICIENT = "Insufficient data to calculate."
BUILDING = "Baseline building..."


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        p = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return p if p.tzinfo else p.replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


def _mean(values: List[float]) -> Optional[float]:
    return round(mean(values), 1) if values else None


# --- Modality confidence ---------------------------------------------------


def modality_confidence(signals: List[Dict]) -> Dict[str, Dict]:
    """Per-modality confidence from the structured signals already stored.

    A modality with no observations reports available=False and contributes
    nothing - it is never treated as a zero-confidence measurement, which
    would wrongly drag the average down as if it had been measured badly.
    """
    face_scores = [
        float(s["emotion_confidence"])
        for s in signals
        if isinstance(s.get("emotion_confidence"), (int, float))
    ]
    reliabilities = [
        float(s["reliability"]) for s in signals if isinstance(s.get("reliability"), (int, float))
    ]
    voice_count = sum(1 for s in signals if s.get("voice_available"))
    text_count = sum(1 for s in signals if s.get("text_available"))

    def entry(available: bool, value: Optional[float], observations: int, note: str) -> Dict:
        return {
            "available": available,
            "confidence": value,
            "observations": observations,
            "note": note,
        }

    return {
        "face": entry(
            bool(face_scores),
            _mean(face_scores),
            len(face_scores),
            "available" if face_scores else "Insufficient signal",
        ),
        "voice": entry(
            voice_count > 0,
            # Voice sessions inherit the session reliability; there is no
            # separate stored voice-confidence figure to quote.
            _mean(reliabilities) if voice_count else None,
            voice_count,
            "available" if voice_count else "Insufficient signal",
        ),
        "text": entry(
            text_count > 0,
            _mean(reliabilities) if text_count else None,
            text_count,
            "available" if text_count else "Insufficient signal",
        ),
        "self_report": entry(True, None, 0, "see check-in count"),
    }


# --- Multimodal consistency ------------------------------------------------


def multimodal_consistency(signals: List[Dict]) -> Dict:
    """Do the modalities point the same way over recent sessions?

    Direction is measured per modality as the change between the older and
    newer half of the available sessions. With fewer than 4 sessions this
    returns available=False rather than guessing a direction.
    """
    if len(signals) < 4:
        return {
            "available": False,
            "reason": INSUFFICIENT,
            "sessions": len(signals),
            "needed": 4,
        }

    mid = len(signals) // 2

    def direction(values: List[float]) -> Optional[str]:
        usable = [v for v in values if isinstance(v, (int, float))]
        if len(usable) < 4:
            return None
        older, newer = usable[:mid], usable[mid:]
        if not older or not newer:
            return None
        delta = mean(newer) - mean(older)
        if delta > 5:
            return "up"
        if delta < -5:
            return "down"
        return "flat"

    negatives = [s.get("sentiment_scores", {}).get("negative") for s in signals]
    confidences = [s.get("emotion_confidence") for s in signals]

    directions = {
        "text": direction([n for n in negatives if n is not None]),
        "face": direction([c for c in confidences if c is not None]),
    }
    present = {k: v for k, v in directions.items() if v is not None}

    if len(present) < 2:
        return {
            "available": False,
            "reason": "Not enough modalities with data to compare.",
            "directions": present,
        }

    consistent = len(set(present.values())) == 1
    return {
        "available": True,
        "directions": present,
        "consistent": consistent,
        "label": (
            "Signals broadly consistent"
            if consistent
            else "Signals inconsistent - confidence reduced."
        ),
        # Disagreement legitimately lowers confidence in the combined picture.
        "confidence_modifier": 1.0 if consistent else 0.75,
    }


# --- Distress signal history ----------------------------------------------


def distress_history(days: int = 7) -> Dict:
    """Daily distress signal over recent days, computed from real data only.

    A day with no check-ins produces no point. The series is never zero-filled,
    because a zero would render as a genuine low reading.
    """
    checkins = twin_store.list_checkins()
    signals = twin_store.list_signal_observations()

    if len(checkins) < MIN_CHECKINS:
        return {
            "available": False,
            "reason": BUILDING,
            "points": [],
            "checkins_recorded": len(checkins),
            "checkins_needed": MIN_CHECKINS - len(checkins),
        }

    points: List[Dict] = []
    today = _now().date()

    for offset in range(days - 1, -1, -1):
        day = today - timedelta(days=offset)
        day_end = datetime.combine(day, datetime.max.time(), tzinfo=timezone.utc)

        # Everything known up to and including that day.
        day_checkins = [c for c in checkins if (_parse(c.get("created_at")) or _now()) <= day_end]
        day_signals = [s for s in signals if (_parse(s.get("created_at")) or _now()) <= day_end]

        has_that_day = any(
            (_parse(c.get("created_at")) or _now()).date() == day for c in day_checkins
        )
        if not has_that_day or len(day_checkins) < MIN_CHECKINS:
            continue

        twin = build_twin(
            aura_id="local-user",
            checkins=day_checkins,
            onboarding=(twin_store.get_latest_baseline_answers() or {}).get("answers"),
        )
        negatives = [
            float(s["sentiment_scores"].get("negative", 0.0))
            for s in day_signals
            if s.get("sentiment_scores")
        ]
        assessment = compute_risk(
            twin,
            sentiment_negative=_mean(negatives),
            case_events=None,
            signal_deviation=None,
        )
        if assessment.insufficient_data:
            continue

        points.append(
            {
                "date": day.isoformat(),
                "value": assessment.score,
                "band": assessment.band,
                "confidence": assessment.confidence,
            }
        )

    return {
        "available": len(points) >= MIN_POINTS_FOR_GRAPH,
        "reason": None if len(points) >= MIN_POINTS_FOR_GRAPH else BUILDING,
        "points": points,
        "days": days,
    }


# --- Assessment ------------------------------------------------------------


def assess_current_risk() -> Dict:
    """The user's current Risk & Trend, from real consented data only."""
    twin_store.init_db()

    baseline_entry = twin_store.get_latest_baseline_answers()
    onboarding = baseline_entry["answers"] if baseline_entry else None
    checkins = twin_store.list_checkins()
    signals = twin_store.list_signal_observations()

    modalities = modality_confidence(signals)
    consistency = multimodal_consistency(signals)

    # --- Hard gate: not enough real data to compute anything -------------
    if len(checkins) < MIN_CHECKINS:
        return {
            "success": True,
            "available": False,
            "status": "BUILDING",
            "status_label": BUILDING,
            "reason": INSUFFICIENT,
            "distress_signal": None,
            "confidence": None,
            "checkins_recorded": len(checkins),
            "checkins_needed": MIN_CHECKINS - len(checkins),
            "modalities": modalities,
            "consistency": consistency,
            "human_review_required": False,
            "disclaimer": (
                "Prototype decision-support signal - not a clinical diagnosis."
            ),
        }

    twin = build_twin(aura_id="local-user", checkins=checkins, onboarding=onboarding)

    negatives = [
        float(s["sentiment_scores"].get("negative", 0.0))
        for s in signals
        if s.get("sentiment_scores")
    ]
    face_conf = [
        float(s["emotion_confidence"])
        for s in signals
        if isinstance(s.get("emotion_confidence"), (int, float))
    ]

    assessment = compute_risk(
        twin,
        sentiment_negative=_mean(negatives),
        case_events=None,
        # Behaviour change from observed expression signals, expressed as
        # distance from a confident reading. Only supplied when face data
        # actually exists.
        signal_deviation=(100.0 - _mean(face_conf)) if face_conf else None,
    )

    if assessment.insufficient_data:
        return {
            "success": True,
            "available": False,
            "status": "BUILDING",
            "status_label": BUILDING,
            "reason": INSUFFICIENT,
            "distress_signal": None,
            "confidence": None,
            "modalities": modalities,
            "consistency": consistency,
            "human_review_required": False,
            "disclaimer": assessment.disclaimer,
        }

    # Disagreement between modalities reduces confidence in the combined view.
    confidence = assessment.confidence
    if consistency.get("available") and not consistency.get("consistent", True):
        confidence = round(confidence * consistency["confidence_modifier"], 1)

    # --- Status wording (user-facing, non-clinical) ----------------------
    status_map = {
        "GREEN": ("STABLE", "Stable pattern"),
        "AMBER": ("CHANGING", "Meaningful change detected - human review may be appropriate"),
        "RED": ("NEEDS_REVIEW", "Strong change detected - priority human review recommended"),
    }
    if twin.trend.direction == "improving" and assessment.band == "GREEN":
        status, status_label = "IMPROVING", "Improving pattern"
    else:
        status, status_label = status_map[assessment.band]

    # --- Contribution strength per factor --------------------------------
    def strength(value: Optional[float]) -> str:
        if value is None:
            return "NONE"
        if value >= 60:
            return "HIGH"
        if value >= 30:
            return "MEDIUM"
        return "LOW"

    contributions = [
        {
            "signal": "Self-report",
            "strength": strength(assessment.components.get("self_report")),
            "value": assessment.components.get("self_report"),
            "weight": SCORE_WEIGHTS["self_report"],
            "available": "self_report" in assessment.components,
        },
        {
            "signal": "Sentiment",
            "strength": strength(assessment.components.get("sentiment")),
            "value": assessment.components.get("sentiment"),
            "weight": SCORE_WEIGHTS["sentiment"],
            "available": "sentiment" in assessment.components,
        },
        {
            "signal": "Face / behaviour",
            "strength": strength(assessment.components.get("behaviour_change")),
            "value": assessment.components.get("behaviour_change"),
            "weight": SCORE_WEIGHTS["behaviour_change"],
            "available": "behaviour_change" in assessment.components,
        },
        {
            "signal": "Engagement",
            "strength": strength(assessment.components.get("engagement_change")),
            "value": assessment.components.get("engagement_change"),
            "weight": SCORE_WEIGHTS["engagement_change"],
            "available": "engagement_change" in assessment.components,
        },
    ]

    # --- Baseline vs current comparison, per dimension -------------------
    comparison = []
    for dim in BASELINE_DIMENSIONS:
        base = twin.baseline.values.get(dim)
        curr = twin.current.values.get(dim)
        if base is None or curr is None:
            continue
        delta = round(curr - base, 1)
        comparison.append(
            {
                "dimension": dim.replace("_", " ").capitalize(),
                "baseline": base,
                "current": curr,
                "delta": delta,
                "direction": "up" if delta > 0.3 else "down" if delta < -0.3 else "flat",
            }
        )

    return {
        "success": True,
        "available": True,
        "status": status,
        "status_label": status_label,
        "band": assessment.band,
        "distress_signal": assessment.score,
        "confidence": confidence,
        "trend": {
            "direction": twin.trend.direction,
            "label": twin.trend.label,
            "sessions_compared": twin.trend.sessions_compared,
        },
        "contributions": contributions,
        "comparison": comparison,
        "contributing_factors": assessment.contributing_factors,
        "recent_changes": assessment.recent_changes,
        "limitations": assessment.limitations,
        "modalities": modalities,
        "consistency": consistency,
        "components": assessment.components,
        "weights_used": assessment.weights_used,
        "human_review_required": assessment.band in ("AMBER", "RED"),
        "autonomous_action": False,
        "escalation_note": (
            "A RED status raises a review alert inside the authorised dashboard only. "
            "It does not contact police, emergency services, family members or anyone else."
        ),
        "disclaimer": assessment.disclaimer,
        "data_quality": {
            "checkins": len(checkins),
            "sessions": len(signals),
            "baseline_confidence": twin.baseline.confidence,
        },
        "assessed_at": assessment.assessed_at,
    }
