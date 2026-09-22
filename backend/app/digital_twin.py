"""The AURA Well-being Digital Twin - the central object every module feeds.

    BASELINE -> CURRENT STATE -> DEVIATION -> TREND -> RISK

The twin holds a person's own normal (baseline), what recent signals say now
(current state), how far that has moved (deviation), which way it is going
(trend), and what that implies for review priority (risk).

Two rules run through this file:

* Everything is measured against THE SAME PERSON'S baseline, never a
  population norm. "Sleeps 5 hours" means nothing on its own; "sleeps 2 hours
  less than their own usual" is a signal.

* Nothing here is a diagnosis. Dimensions are self-reported or observed
  signals, and every output carries a confidence that starts LOW for a new
  user and only rises with observations. A twin with two check-ins must not
  look as authoritative as one with fifty.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from statistics import mean, pstdev
from typing import Dict, List, Optional

# Self-reported baseline dimensions, each 0-10 as reported by the person.
BASELINE_DIMENSIONS = (
    "sleep",
    "energy",
    "mood",
    "social_interaction",
    "routine",
    "communication",
)

# Observations needed before the baseline is treated as well-established.
BASELINE_TARGET_OBSERVATIONS = 14

# Direction each dimension moves when things get worse. All current dimensions
# are "higher is better", but this is explicit so adding an inverted dimension
# later (e.g. "physical_pain") cannot silently invert the deviation maths.
LOWER_IS_WORSE = {d: True for d in BASELINE_DIMENSIONS}


@dataclass
class Baseline:
    """A person's own normal, with the spread that counts as ordinary variation."""

    values: Dict[str, float] = field(default_factory=dict)
    variation: Dict[str, float] = field(default_factory=dict)
    confidence: float = 0.0          # 0-100
    observations: int = 0
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    def is_established(self) -> bool:
        return self.observations >= 3 and bool(self.values)


@dataclass
class CurrentState:
    values: Dict[str, float] = field(default_factory=dict)
    observations: int = 0
    window_days: int = 7
    last_checkin_at: Optional[str] = None


@dataclass
class Deviation:
    """Per-dimension movement from baseline, in standard-deviation-like units."""

    per_dimension: Dict[str, float] = field(default_factory=dict)
    overall: float = 0.0             # 0-100, magnitude of adverse movement
    worsening: List[str] = field(default_factory=list)
    improving: List[str] = field(default_factory=list)


@dataclass
class Trend:
    direction: str = "insufficient"  # improving | stable | worsening | insufficient
    delta: float = 0.0
    sessions_compared: int = 0
    label: str = "Not enough data yet"


@dataclass
class Engagement:
    """Behavioural signal only. Deliberately NOT treated as evidence of distress
    on its own - a missed check-in most often means a busy day."""

    checkin_streak: int = 0
    checkins_last_7d: int = 0
    expected_last_7d: int = 7
    missed_last_7d: int = 0
    days_since_last_checkin: Optional[float] = None
    companion_care_last_7d: int = 0
    engagement_ratio: float = 0.0    # 0-1
    changed: bool = False


@dataclass
class DigitalTwin:
    aura_id: str
    baseline: Baseline = field(default_factory=Baseline)
    current: CurrentState = field(default_factory=CurrentState)
    deviation: Deviation = field(default_factory=Deviation)
    trend: Trend = field(default_factory=Trend)
    engagement: Engagement = field(default_factory=Engagement)
    # Latest multimodal signal summary, if a session has been run.
    signal_summary: Dict[str, object] = field(default_factory=dict)
    updated_at: Optional[str] = None


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


# --- Baseline --------------------------------------------------------------


def build_baseline(checkins: List[Dict], onboarding: Optional[Dict] = None) -> Baseline:
    """Builds the personal baseline from onboarding answers plus check-ins.

    Onboarding seeds the baseline so a brand-new user has something to compare
    against, but is weighted as a single observation - stated expectations are
    a weaker signal than repeated measurements, and confidence reflects that.
    """
    baseline = Baseline()
    samples: Dict[str, List[float]] = {d: [] for d in BASELINE_DIMENSIONS}

    if onboarding:
        for dim in BASELINE_DIMENSIONS:
            value = onboarding.get(dim)
            if isinstance(value, (int, float)):
                samples[dim].append(float(value))

    # Early check-ins define "normal"; later ones are current state, not baseline.
    for entry in checkins[:BASELINE_TARGET_OBSERVATIONS]:
        for dim in BASELINE_DIMENSIONS:
            value = entry.get(dim)
            if isinstance(value, (int, float)):
                samples[dim].append(float(value))

    observation_counts = []
    for dim, values in samples.items():
        if not values:
            continue
        baseline.values[dim] = round(mean(values), 2)
        # Floor the variation: with 1-2 samples the spread is 0, which would
        # make any later change look infinitely significant.
        baseline.variation[dim] = round(max(pstdev(values) if len(values) > 1 else 0.0, 0.8), 2)
        observation_counts.append(len(values))

    baseline.observations = int(mean(observation_counts)) if observation_counts else 0
    baseline.confidence = round(
        min(100.0, baseline.observations / BASELINE_TARGET_OBSERVATIONS * 100), 1
    )
    if baseline.values:
        baseline.created_at = checkins[0].get("created_at") if checkins else _now().isoformat()
        baseline.updated_at = _now().isoformat()
    return baseline


def baseline_confidence_label(confidence: float) -> str:
    if confidence < 30:
        return "Low - still learning your usual pattern"
    if confidence < 70:
        return "Building"
    return "Established"


# --- Current state ---------------------------------------------------------


def build_current_state(checkins: List[Dict], window_days: int = 7) -> CurrentState:
    """Averages recent check-ins into the person's current state."""
    state = CurrentState(window_days=window_days)
    cutoff = _now() - timedelta(days=window_days)

    recent = []
    for entry in checkins:
        created = _parse(entry.get("created_at"))
        if created and created >= cutoff:
            recent.append(entry)

    # Fall back to the most recent few so a returning user isn't left blank.
    if not recent:
        recent = checkins[-3:]

    if not recent:
        return state

    for dim in BASELINE_DIMENSIONS:
        values = [
            float(e[dim]) for e in recent if isinstance(e.get(dim), (int, float))
        ]
        if values:
            state.values[dim] = round(mean(values), 2)

    state.observations = len(recent)
    last = _parse(recent[-1].get("created_at"))
    state.last_checkin_at = last.isoformat() if last else None
    return state


# --- Deviation -------------------------------------------------------------


def compute_deviation(baseline: Baseline, current: CurrentState) -> Deviation:
    """How far current state has moved from this person's own normal.

    Expressed in units of their own ordinary variation, so a change only reads
    as significant if it is large *for them*.
    """
    deviation = Deviation()
    if not baseline.is_established() or not current.values:
        return deviation

    adverse_scores = []
    for dim in BASELINE_DIMENSIONS:
        if dim not in baseline.values or dim not in current.values:
            continue
        spread = baseline.variation.get(dim, 1.0) or 1.0
        z = (current.values[dim] - baseline.values[dim]) / spread
        deviation.per_dimension[dim] = round(z, 2)

        adverse = -z if LOWER_IS_WORSE.get(dim, True) else z
        if adverse > 0.75:
            deviation.worsening.append(dim)
            adverse_scores.append(adverse)
        elif adverse < -0.75:
            deviation.improving.append(dim)

    if adverse_scores:
        # ~2 SD of adverse movement reads as a full-scale deviation.
        deviation.overall = round(min(100.0, mean(adverse_scores) / 2.0 * 100), 1)
    return deviation


# --- Trend -----------------------------------------------------------------


def compute_trend(checkins: List[Dict], min_sessions: int = 4) -> Trend:
    """Direction of overall self-reported well-being across recent check-ins."""
    scored = []
    for entry in checkins:
        values = [
            float(entry[d]) for d in BASELINE_DIMENSIONS
            if isinstance(entry.get(d), (int, float))
        ]
        if values:
            scored.append(mean(values))

    if len(scored) < min_sessions:
        return Trend(sessions_compared=len(scored))

    window = scored[-12:]
    mid = len(window) // 2
    delta = mean(window[mid:]) - mean(window[:mid])

    if delta > 0.5:
        direction, label = "improving", "Improving"
    elif delta < -0.5:
        direction, label = "worsening", "Changing - may need review"
    else:
        direction, label = "stable", "Stable"

    return Trend(
        direction=direction,
        delta=round(delta, 2),
        sessions_compared=len(window),
        label=label,
    )


# --- Engagement ------------------------------------------------------------


def compute_engagement(
    checkins: List[Dict], companion_events: Optional[List[Dict]] = None
) -> Engagement:
    """Behavioural engagement. A soft signal, never distress evidence alone."""
    engagement = Engagement()
    companion_events = companion_events or []
    now = _now()
    week_ago = now - timedelta(days=7)

    dated = [(_parse(c.get("created_at")), c) for c in checkins]
    dated = [(d, c) for d, c in dated if d]
    dated.sort(key=lambda pair: pair[0])

    recent = [c for d, c in dated if d >= week_ago]
    engagement.checkins_last_7d = len(recent)
    engagement.missed_last_7d = max(0, engagement.expected_last_7d - len(recent))
    engagement.engagement_ratio = round(
        min(1.0, len(recent) / engagement.expected_last_7d), 2
    )

    if dated:
        engagement.days_since_last_checkin = round(
            (now - dated[-1][0]).total_seconds() / 86400, 1
        )
        # Consecutive days with at least one check-in, walking backwards.
        days_seen = {d.date() for d, _ in dated}
        streak = 0
        cursor = now.date()
        while cursor in days_seen:
            streak += 1
            cursor -= timedelta(days=1)
        engagement.checkin_streak = streak

    engagement.companion_care_last_7d = sum(
        1 for e in companion_events if (_parse(e.get("created_at")) or now) >= week_ago
    )

    # "Changed" compares this week against the previous week, rather than
    # against an assumed ideal - people have different natural cadences.
    prior = [c for d, c in dated if week_ago - timedelta(days=7) <= d < week_ago]
    if prior:
        engagement.changed = len(recent) < len(prior) * 0.6

    return engagement


# --- Assembly --------------------------------------------------------------


def build_twin(
    aura_id: str,
    checkins: List[Dict],
    onboarding: Optional[Dict] = None,
    companion_events: Optional[List[Dict]] = None,
    signal_summary: Optional[Dict] = None,
) -> DigitalTwin:
    """Assembles the full twin from stored signals."""
    ordered = sorted(checkins, key=lambda c: c.get("created_at") or "")
    baseline = build_baseline(ordered, onboarding)
    current = build_current_state(ordered)

    return DigitalTwin(
        aura_id=aura_id,
        baseline=baseline,
        current=current,
        deviation=compute_deviation(baseline, current),
        trend=compute_trend(ordered),
        engagement=compute_engagement(ordered, companion_events),
        signal_summary=signal_summary or {},
        updated_at=_now().isoformat(),
    )


def wellbeing_pattern_label(twin: DigitalTwin) -> str:
    """Supportive, non-clinical phrasing for the victim-facing dashboard.

    Deliberately avoids any percentage-of-mental-health framing: the person
    sees a pattern description, not a score out of 100.
    """
    if not twin.baseline.is_established():
        return "Still learning your usual pattern"
    if twin.trend.direction == "worsening" or twin.deviation.overall > 55:
        return "Changing - may be worth talking to someone"
    if twin.trend.direction == "improving":
        return "Improving"
    return "Stable"
