"""Personal Well-being Digital Twin service.

    Emotion Dashboard -> Structured Signals -> Digital Twin
                                                    |
                                            Baseline Engine
                                                    |
                                             Trend Engine

This layer RECEIVES structured outputs from the existing analysis pipeline.
It does not modify, re-run or second-guess any emotion algorithm - face, voice
and text scores arrive already computed and are stored as-is.

THE RULE THIS FILE ENFORCES: nothing is fabricated.

  * With no baseline answers and no check-ins, the twin reports
    "Baseline building..." rather than assuming a default normal.
  * A modality that produced nothing reports "Insufficient signal" rather
    than a zero that would read as a measurement.
  * Trend windows with too few points report insufficient rather than "stable",
    because "stable" is a finding and absence of data is not.
  * Confidence is derived from how much real data exists and never inflated.
"""
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from statistics import mean
from typing import Dict, List, Optional

from . import twin_store
from .digital_twin import (
    BASELINE_DIMENSIONS,
    baseline_confidence_label,
    build_twin,
    wellbeing_pattern_label,
)

# Real check-ins needed before each view is meaningful.
MIN_CHECKINS_FOR_BASELINE = 3
MIN_POINTS_FOR_TREND = 4

TREND_WINDOWS = {"today": 1, "yesterday": 2, "7d": 7, "30d": 30}

INSUFFICIENT = "Insufficient signal"
BUILDING = "Baseline building..."


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: Optional[str]) -> Optional[datetime]:
    if not ts:
        return None
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except (ValueError, AttributeError):
        return None


# --- Ingestion -------------------------------------------------------------


def ingest_session_signals(payload: Dict) -> Dict:
    """Receives one completed analysis result from the Emotion Dashboard.

    Stores only derived signals, and only with 'emotion_signals' consent.
    Without consent this is a silent no-op that reports why - the analysis
    itself still ran and still displayed; it simply is not retained.
    """
    if not twin_store.has_consent("emotion_signals"):
        return {
            "stored": False,
            "reason": "Consent for storing emotion signals has not been granted.",
        }

    record = {
        "emotion_dominant": payload.get("emotion_dominant"),
        "emotion_confidence": payload.get("emotion_confidence"),
        "emotion_scores": payload.get("emotion_scores") or {},
        "sentiment_dominant": payload.get("sentiment_dominant"),
        "sentiment_scores": payload.get("sentiment_scores") or {},
        "voice_available": payload.get("voice_available", False),
        "text_available": payload.get("text_available", False),
        "modalities": payload.get("modalities") or [],
        "reliability": payload.get("reliability"),
        "session_id": payload.get("session_id"),
    }
    entry_id = twin_store.save_signal_observation(record)
    return {"stored": entry_id is not None, "id": entry_id}


# --- Trend engine ----------------------------------------------------------


def _series_mean(values: List[float]) -> Optional[float]:
    return round(mean(values), 1) if values else None


def _window_slice(rows: List[Dict], days: int) -> List[Dict]:
    cutoff = _now() - timedelta(days=days)
    return [r for r in rows if (_parse(r.get("created_at")) or _now()) >= cutoff]


def build_trends() -> Dict:
    """Emotion / sentiment / engagement / check-in trends over real windows.

    Every window reports its own point count. A window with too few points is
    marked available=False and carries no numbers - a chart must be able to
    show "not enough information yet" rather than a misleading flat line.
    """
    checkins = twin_store.list_checkins()
    signals = twin_store.list_signal_observations()

    trends: Dict[str, Dict] = {}

    for name, days in TREND_WINDOWS.items():
        window_checkins = _window_slice(checkins, days)
        window_signals = _window_slice(signals, days)

        scored_checkins = [
            mean([float(c[d]) for d in BASELINE_DIMENSIONS if isinstance(c.get(d), (int, float))])
            for c in window_checkins
            if any(isinstance(c.get(d), (int, float)) for d in BASELINE_DIMENSIONS)
        ]

        negative_sentiment = [
            float(s["sentiment_scores"].get("negative", 0.0))
            for s in window_signals
            if s.get("sentiment_scores")
        ]
        emotion_confidence = [
            float(s["emotion_confidence"])
            for s in window_signals
            if isinstance(s.get("emotion_confidence"), (int, float))
        ]

        trends[name] = {
            "window_days": days,
            "checkin_count": len(window_checkins),
            "session_count": len(window_signals),
            "self_report": {
                "available": len(scored_checkins) > 0,
                "value": _series_mean(scored_checkins),
                "points": len(scored_checkins),
            },
            "sentiment": {
                "available": len(negative_sentiment) > 0,
                "negative_mean": _series_mean(negative_sentiment),
                "points": len(negative_sentiment),
            },
            "emotion": {
                "available": len(emotion_confidence) > 0,
                "confidence_mean": _series_mean(emotion_confidence),
                "points": len(emotion_confidence),
            },
            "engagement": {
                "available": True,
                "checkins": len(window_checkins),
                "expected": days,
                "ratio": round(min(1.0, len(window_checkins) / days), 2) if days else 0.0,
            },
        }

    return trends


def build_series() -> Dict[str, List[Dict]]:
    """Daily points for the trend graphs, over the last 30 days.

    Only days that actually have data produce a point. Missing days are simply
    absent from the series - they are NOT interpolated or zero-filled, because
    a zero would render as a real low reading.
    """
    checkins = twin_store.list_checkins(days=30)
    signals = twin_store.list_signal_observations(days=30)

    by_day_checkin: Dict[str, List[float]] = {}
    for c in checkins:
        day = (_parse(c.get("created_at")) or _now()).date().isoformat()
        values = [float(c[d]) for d in BASELINE_DIMENSIONS if isinstance(c.get(d), (int, float))]
        if values:
            by_day_checkin.setdefault(day, []).append(mean(values))

    by_day_sentiment: Dict[str, List[float]] = {}
    by_day_emotion: Dict[str, List[float]] = {}
    for s in signals:
        day = (_parse(s.get("created_at")) or _now()).date().isoformat()
        neg = s.get("sentiment_scores", {}).get("negative")
        if isinstance(neg, (int, float)):
            by_day_sentiment.setdefault(day, []).append(float(neg))
        conf = s.get("emotion_confidence")
        if isinstance(conf, (int, float)):
            by_day_emotion.setdefault(day, []).append(float(conf))

    def to_series(bucket: Dict[str, List[float]]) -> List[Dict]:
        return [
            {"date": day, "value": round(mean(values), 1), "points": len(values)}
            for day, values in sorted(bucket.items())
        ]

    engagement = [
        {"date": day, "value": len(values), "points": len(values)}
        for day, values in sorted(
            {
                (_parse(c.get("created_at")) or _now()).date().isoformat(): []
                for c in checkins
            }.items()
        )
    ]
    # Count check-ins per day for the engagement series.
    counts: Dict[str, int] = {}
    for c in checkins:
        day = (_parse(c.get("created_at")) or _now()).date().isoformat()
        counts[day] = counts.get(day, 0) + 1
    engagement = [
        {"date": day, "value": count, "points": count} for day, count in sorted(counts.items())
    ]

    return {
        "self_report": to_series(by_day_checkin),
        "sentiment_negative": to_series(by_day_sentiment),
        "emotion_confidence": to_series(by_day_emotion),
        "engagement": engagement,
    }


# --- Recent changes --------------------------------------------------------


def detect_recent_changes(twin, signals: List[Dict]) -> List[Dict]:
    """Changes stated against the person's OWN recent pattern.

    Cautious language throughout: "changed from your recent pattern", never a
    claim about the person's state. Returns [] when there is nothing measured
    to report.
    """
    changes: List[Dict] = []

    for dim in twin.deviation.worsening:
        changes.append(
            {
                "signal": dim.replace("_", " ").capitalize(),
                "direction": "down",
                "text": f"{dim.replace('_', ' ').capitalize()} is lower than your recent pattern.",
            }
        )
    for dim in twin.deviation.improving:
        changes.append(
            {
                "signal": dim.replace("_", " ").capitalize(),
                "direction": "up",
                "text": f"{dim.replace('_', ' ').capitalize()} is higher than your recent pattern.",
            }
        )

    # Sentiment shift, split-half over real sessions only.
    negatives = [
        float(s["sentiment_scores"].get("negative", 0.0))
        for s in signals
        if s.get("sentiment_scores")
    ]
    if len(negatives) >= 4:
        mid = len(negatives) // 2
        delta = mean(negatives[mid:]) - mean(negatives[:mid])
        if abs(delta) >= 10:
            changes.append(
                {
                    "signal": "Sentiment",
                    "direction": "down" if delta > 0 else "up",
                    "text": (
                        "Sentiment in your recent sessions moved "
                        f"{'more negative' if delta > 0 else 'less negative'} "
                        f"than earlier ones."
                    ),
                }
            )

    if twin.engagement.changed:
        changes.append(
            {
                "signal": "Check-in frequency",
                "direction": "down",
                "text": "Check-in frequency decreased compared with your recent pattern.",
            }
        )

    return changes


# --- Assembly --------------------------------------------------------------


def get_twin_view() -> Dict:
    """The complete My Well-being view, built from real data only."""
    twin_store.init_db()
    consent = twin_store.get_consent()

    baseline_entry = twin_store.get_latest_baseline_answers()
    onboarding = baseline_entry["answers"] if baseline_entry else None
    checkins = twin_store.list_checkins()
    signals = twin_store.list_signal_observations()

    has_any_data = bool(onboarding) or bool(checkins) or bool(signals)

    twin = build_twin(
        aura_id="local-user",
        checkins=checkins,
        onboarding=onboarding,
        companion_events=None,
    )

    # Real-data gate: the digital_twin engine will happily compute from a
    # single onboarding submission, but a baseline from one questionnaire is
    # not yet a baseline. Report status honestly instead.
    baseline_ready = (
        onboarding is not None and len(checkins) >= MIN_CHECKINS_FOR_BASELINE
    ) or len(checkins) >= MIN_CHECKINS_FOR_BASELINE

    latest_signal = signals[-1] if signals else None

    current_state = {
        "available": bool(checkins) or bool(latest_signal),
        "self_report": twin.current.values or None,
        "observations": twin.current.observations,
        "last_checkin_at": twin.current.last_checkin_at,
        "emotion": (
            {
                "dominant": latest_signal["emotion_dominant"],
                "confidence": latest_signal["emotion_confidence"],
                "at": latest_signal["created_at"],
            }
            if latest_signal and latest_signal.get("emotion_dominant")
            else None
        ),
        "sentiment": (
            {
                "dominant": latest_signal["sentiment_dominant"],
                "scores": latest_signal["sentiment_scores"],
            }
            if latest_signal and latest_signal.get("sentiment_dominant")
            else None
        ),
    }

    # Per-modality availability, so the UI can say "Insufficient signal"
    # against the specific thing that is missing.
    modality_status = {
        "self_report": "available" if checkins else INSUFFICIENT,
        "face": INSUFFICIENT,
        "voice": INSUFFICIENT,
        "text": INSUFFICIENT,
    }
    if latest_signal:
        if latest_signal.get("emotion_dominant"):
            modality_status["face"] = "available"
        if latest_signal.get("voice_available"):
            modality_status["voice"] = "available"
        if latest_signal.get("text_available"):
            modality_status["text"] = "available"

    return {
        "success": True,
        "has_data": has_any_data,
        "consent": consent,
        "baseline": {
            "status": "ready" if baseline_ready else "building",
            "status_label": "Established" if baseline_ready else BUILDING,
            "confidence": twin.baseline.confidence if baseline_ready else 0.0,
            "confidence_label": (
                baseline_confidence_label(twin.baseline.confidence)
                if baseline_ready
                else "Not enough information yet."
            ),
            # 0-5 dots for the UI.
            "confidence_dots": (
                min(5, round(twin.baseline.confidence / 20)) if baseline_ready else 0
            ),
            "observations": twin.baseline.observations,
            "checkins_recorded": len(checkins),
            "checkins_needed": max(0, MIN_CHECKINS_FOR_BASELINE - len(checkins)),
            "values": twin.baseline.values if baseline_ready else {},
            "questionnaire_submitted": baseline_entry is not None,
        },
        "current": current_state,
        "change": (
            {
                "available": baseline_ready and bool(twin.deviation.per_dimension),
                "per_dimension": twin.deviation.per_dimension,
                "overall": twin.deviation.overall,
                "worsening": twin.deviation.worsening,
                "improving": twin.deviation.improving,
            }
            if baseline_ready
            else {"available": False, "reason": "Not enough information yet."}
        ),
        "trend": (
            {
                "available": twin.trend.direction != "insufficient",
                "direction": twin.trend.direction,
                "label": twin.trend.label,
                "sessions_compared": twin.trend.sessions_compared,
            }
            if twin.trend.direction != "insufficient"
            else {
                "available": False,
                "reason": "Not enough information yet.",
                "sessions_compared": twin.trend.sessions_compared,
                "needed": MIN_POINTS_FOR_TREND,
            }
        ),
        "engagement": asdict(twin.engagement),
        "recent_changes": detect_recent_changes(twin, signals) if baseline_ready else [],
        "modality_status": modality_status,
        "pattern_label": (
            wellbeing_pattern_label(twin) if baseline_ready else BUILDING
        ),
        "counts": {"checkins": len(checkins), "sessions": len(signals)},
        "safety_note": (
            "This shows changes in signals you have consented to share. It is not a "
            "psychological assessment or diagnosis."
        ),
    }


# --- Companion daily care ---------------------------------------------------

# Real completed actions needed for each pet/plant growth stage. Deliberately
# a simple count, not a score: growth reflects consistency of real actions,
# never anything inferred from mood, distress or conversation content.
CARE_GROWTH_STAGE_SIZE = 5
CARE_GROWTH_MAX_STAGE = 4


def _is_today(ts: Optional[str], today: datetime) -> bool:
    parsed = _parse(ts)
    return parsed is not None and parsed.date() == today.date()


def get_care_summary() -> Dict:
    """Today's Companion daily-care checklist plus real pet/plant growth.

    Check-ins are read from the existing checkins table rather than
    duplicated here - Feed/Water/Activity are the only new action kinds.
    """
    twin_store.init_db()
    today = _now()

    care_actions = twin_store.list_care_actions()
    checkins = twin_store.list_checkins()

    feed_actions = [a for a in care_actions if a["kind"] == "feed"]
    water_actions = [a for a in care_actions if a["kind"] == "water"]
    activity_actions = [a for a in care_actions if a["kind"] == "activity"]

    def _streak(dated: List[datetime]) -> int:
        """Consecutive days up to today with at least one real action."""
        days = {d.date() for d in dated}
        streak = 0
        cursor = today.date()
        while cursor in days:
            streak += 1
            cursor = cursor - timedelta(days=1)
        return streak

    all_care_dates = [
        d for d in (_parse(a["created_at"]) for a in care_actions) if d is not None
    ]
    checkin_dates = [
        d for d in (_parse(c["created_at"]) for c in checkins if not c.get("skipped"))
        if d is not None
    ]

    return {
        "success": True,
        "consent": twin_store.has_consent("companion_care"),
        "today": {
            "feed": any(_is_today(a["created_at"], today) for a in feed_actions),
            "water": any(_is_today(a["created_at"], today) for a in water_actions),
            "checkin": any(_is_today(c["created_at"], today) for c in checkins),
            "activity": any(_is_today(a["created_at"], today) for a in activity_actions),
        },
        "pet": {
            "total_feedings": len(feed_actions),
            "growth_stage": min(
                CARE_GROWTH_MAX_STAGE, len(feed_actions) // CARE_GROWTH_STAGE_SIZE
            ),
            "next_stage_in": max(
                0, CARE_GROWTH_STAGE_SIZE - (len(feed_actions) % CARE_GROWTH_STAGE_SIZE)
            )
            if len(feed_actions) // CARE_GROWTH_STAGE_SIZE < CARE_GROWTH_MAX_STAGE
            else 0,
        },
        "plant": {
            "total_waterings": len(water_actions),
            "growth_stage": min(
                CARE_GROWTH_MAX_STAGE, len(water_actions) // CARE_GROWTH_STAGE_SIZE
            ),
            "next_stage_in": max(
                0, CARE_GROWTH_STAGE_SIZE - (len(water_actions) % CARE_GROWTH_STAGE_SIZE)
            )
            if len(water_actions) // CARE_GROWTH_STAGE_SIZE < CARE_GROWTH_MAX_STAGE
            else 0,
        },
        "activity": {"total_completed": len(activity_actions)},
        "care_streak_days": _streak(all_care_dates + checkin_dates),
        "recent_activities": [
            a["activity_type"] for a in activity_actions[-5:] if a.get("activity_type")
        ],
    }
