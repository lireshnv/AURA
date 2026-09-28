"""Synthetic demo history for demo victim accounts.

Writes ONLY through the real storage functions (twin_store / history_store),
scoped to one aura_id each, so every chart, trend, risk band and case-queue
priority is computed by the app's normal code from these rows - exactly as it
would be from real use. Nothing is faked at display time, which is why the
numbers keep moving as soon as someone actually uses the app: a new check-in
or session is just another row alongside the seeded ones.

Seeded check-ins are marked source="synthetic". Each victim follows a
different trajectory so their dashboards genuinely differ.
"""
import math
import random
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict

from . import history_store, twin_store
from .digital_twin import BASELINE_DIMENSIONS

# Offset from the person's own normal (in points on a 0-10 scale) as a
# function of t: 0.0 = oldest day seeded, 1.0 = today.
TRAJECTORIES: Dict[str, Callable[[float], float]] = {
    "steady": lambda t: 0.0,
    "improving": lambda t: -2.6 * (1 - t),
    "declining": lambda t: 0.0 if t < 0.7 else -3.6 * (t - 0.7) / 0.3,
    "volatile": lambda t: 1.8 * math.sin(t * 5 * math.pi),
    "slipping": lambda t: -1.6 * t,
    "recovering_after_dip": lambda t: -3.0 * math.exp(-((t - 0.45) ** 2) / 0.02),
}

# (trajectory, normal wellbeing level, chance of checking in on a given day)
PROFILES = [
    ("steady", 7.6, 0.9),
    ("improving", 7.2, 0.85),
    ("declining", 7.4, 0.8),
    ("volatile", 6.6, 0.75),
    ("slipping", 7.0, 0.6),
    ("recovering_after_dip", 7.3, 0.85),
    ("steady", 6.1, 0.55),
    ("declining", 6.9, 0.9),
    ("improving", 6.4, 0.7),
    ("volatile", 7.1, 0.8),
]

DAYS = 30
EMOTIONS_BY_MOOD = [(4.0, ["sad", "fear"]), (5.5, ["sad", "neutral"]), (7.0, ["neutral", "calm"]), (11, ["calm", "happy"])]


def _clamp(v: float, lo: float = 0.0, hi: float = 10.0) -> float:
    return max(lo, min(hi, v))


def _emotion_for(mood: float, rng: random.Random) -> str:
    for ceiling, options in EMOTIONS_BY_MOOD:
        if mood < ceiling:
            return rng.choice(options)
    return "calm"


def _level_for(score: float) -> str:
    return "GREEN" if score < 35 else "AMBER" if score < 65 else "RED"


def seed_victim(aura_id: str, profile_index: int) -> Dict[str, int]:
    """Replaces any previous twin/session history for `aura_id` with a fresh
    synthetic history. Only ever call this for demo accounts."""
    trajectory_name, normal, engagement = PROFILES[profile_index % len(PROFILES)]
    trajectory = TRAJECTORIES[trajectory_name]
    rng = random.Random(f"aura-demo-{aura_id}")
    now = datetime.now(timezone.utc)

    twin_store.delete_all(aura_id=aura_id)
    history_store.clear_all(aura_id=aura_id)
    for scope in twin_store.CONSENT_SCOPES:
        twin_store.set_consent(scope, True, aura_id=aura_id)

    per_dim_normal = {d: _clamp(normal + rng.uniform(-0.8, 0.8)) for d in BASELINE_DIMENSIONS}
    twin_store.save_baseline_answers(
        {d: round(v, 1) for d, v in per_dim_normal.items()},
        preferred_checkin_time=rng.choice(["Morning", "Evening", "No preference"]),
        aura_id=aura_id,
    )

    counts = {"checkins": 0, "signals": 0, "sessions": 0, "care_actions": 0}
    for days_ago in range(DAYS, -1, -1):
        t = 1 - days_ago / DAYS
        offset = trajectory(t)
        # Always include the last two days so every dashboard has a recent point.
        if days_ago > 1 and rng.random() > engagement:
            continue
        when = now - timedelta(days=days_ago, hours=rng.randint(0, 10), minutes=rng.randint(0, 59))
        values = {
            d: round(_clamp(per_dim_normal[d] + offset + rng.uniform(-0.6, 0.6)), 1)
            for d in BASELINE_DIMENSIONS
        }
        if twin_store.save_checkin(values, created_at=when.isoformat(), source="synthetic", aura_id=aura_id):
            counts["checkins"] += 1
        mood = sum(values.values()) / len(values)

        if days_ago % 3 == 0:
            negative = round(_clamp((7.5 - mood) / 7.5 + rng.uniform(-0.08, 0.08), 0.02, 0.95), 2)
            record = {
                "emotion_dominant": _emotion_for(mood, rng),
                "emotion_confidence": round(rng.uniform(55, 88), 1),
                "sentiment_dominant": "negative" if negative > 0.5 else "neutral" if negative > 0.2 else "positive",
                "sentiment_scores": {"negative": negative, "neutral": round((1 - negative) * 0.7, 2),
                                     "positive": round((1 - negative) * 0.3, 2)},
                "voice_available": True,
                "text_available": True,
                "modalities": ["voice", "text"],
                "reliability": round(rng.uniform(0.6, 0.9), 2),
            }
            if twin_store.save_signal_observation(record, created_at=when.isoformat(), aura_id=aura_id):
                counts["signals"] += 1

        if days_ago % 4 == 1:
            score = round(_clamp((10 - mood) * 10 + rng.uniform(-6, 6), 2, 98), 1)
            session = {
                "aura_id": aura_id,
                "created_at": (when + timedelta(hours=2)).isoformat(),
                "duration_seconds": rng.randint(90, 720),
                "observed_emotion": _emotion_for(mood, rng),
                "emotion_confidence": round(rng.uniform(55, 88), 1),
                "distress_score": score,
                "distress_level": _level_for(score),
                "sentiment_dominant": "negative" if score > 55 else "neutral",
                "modalities": ["voice", "text"],
                "valid_observations": rng.randint(20, 140),
            }
            if history_store.save_session(session):
                counts["sessions"] += 1

    for days_ago in range(0, 6):
        if rng.random() < engagement:
            kind = rng.choice(["feed", "water", "activity"])
            if twin_store.save_care_action(kind, aura_id=aura_id):
                counts["care_actions"] += 1
    return counts
