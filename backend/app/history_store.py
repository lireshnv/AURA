"""Persistence for completed analysis sessions.

WHAT IS STORED
--------------
Only derived, structured signals: scores, timestamps, a short transcript
excerpt and the distress summary. Raw video, raw audio and face images are
never written anywhere - consistent with the privacy commitment shown in the UI.

SCOPE: every session belongs to one person (aura_id). API routes always pass
a concrete aura_id so one person's sessions are never returned for another's
request.

STORAGE: the main application database (same SQLAlchemy engine as the ORM -
Postgres in production), in table `history_sessions`, so history survives
redeploys of an ephemeral-disk host. SQL is portable to SQLite.
"""
import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy import text

from .database import engine

logger = logging.getLogger("aura.history")

_lock = threading.Lock()
_initialized = False

_COLUMNS = (
    "id, aura_id, created_at, duration_seconds, observed_emotion, emotion_confidence, "
    "distress_score, distress_level, sentiment_dominant, agreement, modalities, "
    "valid_observations, emotion_scores, sentiment_scores, factors, transcript_excerpt, notes"
)


def init_db() -> None:
    """Creates the table if absent. Safe to call repeatedly."""
    global _initialized
    with _lock:
        if _initialized:
            return
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    """CREATE TABLE IF NOT EXISTS history_sessions (
                        id                 TEXT PRIMARY KEY,
                        aura_id            TEXT,
                        created_at         TEXT NOT NULL,
                        duration_seconds   REAL NOT NULL DEFAULT 0,
                        observed_emotion   TEXT,
                        emotion_confidence REAL,
                        distress_score     REAL,
                        distress_level     TEXT,
                        sentiment_dominant TEXT,
                        agreement          REAL,
                        modalities         TEXT,
                        valid_observations INTEGER DEFAULT 0,
                        emotion_scores     TEXT,
                        sentiment_scores   TEXT,
                        factors            TEXT,
                        transcript_excerpt TEXT,
                        notes              TEXT
                    )"""
                ))
                conn.execute(text(
                    "CREATE INDEX IF NOT EXISTS idx_history_sessions_owner "
                    "ON history_sessions (aura_id, created_at)"
                ))
            _initialized = True
            logger.info("History table ready (main database)")
        except Exception:  # noqa: BLE001 - history must never block analysis
            logger.exception("Failed to initialise history table")


def save_session(record: Dict) -> Optional[str]:
    """Persists one completed session. Returns its id, or None on failure.

    Failure is logged and swallowed: losing a history row must never break the
    analysis flow the user is actually in the middle of.
    """
    init_db()
    session_id = record.get("id") or str(uuid.uuid4())
    params = {
        "id": session_id,
        "aura_id": record.get("aura_id"),
        "created_at": record.get("created_at") or datetime.now(timezone.utc).isoformat(),
        "duration_seconds": float(record.get("duration_seconds") or 0),
        "observed_emotion": record.get("observed_emotion"),
        "emotion_confidence": record.get("emotion_confidence"),
        "distress_score": record.get("distress_score"),
        "distress_level": record.get("distress_level"),
        "sentiment_dominant": record.get("sentiment_dominant"),
        "agreement": record.get("agreement"),
        "modalities": json.dumps(record.get("modalities") or []),
        "valid_observations": int(record.get("valid_observations") or 0),
        "emotion_scores": json.dumps(record.get("emotion_scores") or {}),
        "sentiment_scores": json.dumps(record.get("sentiment_scores") or {}),
        "factors": json.dumps(record.get("factors") or []),
        "transcript_excerpt": (record.get("transcript_excerpt") or "")[:1000],
        "notes": json.dumps(record.get("notes") or []),
    }
    placeholders = ", ".join(":" + c.strip() for c in _COLUMNS.split(","))
    try:
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM history_sessions WHERE id = :id"), {"id": session_id})
            conn.execute(text(f"INSERT INTO history_sessions ({_COLUMNS}) VALUES ({placeholders})"), params)
        return session_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save session to history")
        return None


def _load(value, fallback):
    try:
        return json.loads(value) if value else fallback
    except (ValueError, TypeError):
        return fallback


def _row_to_dict(row) -> Dict:
    return {
        "id": row["id"],
        "aura_id": row["aura_id"],
        "created_at": row["created_at"],
        "duration_seconds": row["duration_seconds"],
        "observed_emotion": row["observed_emotion"],
        "emotion_confidence": row["emotion_confidence"],
        "distress_score": row["distress_score"],
        "distress_level": row["distress_level"],
        "sentiment_dominant": row["sentiment_dominant"],
        "agreement": row["agreement"],
        "modalities": _load(row["modalities"], []),
        "valid_observations": row["valid_observations"],
        "emotion_scores": _load(row["emotion_scores"], {}),
        "sentiment_scores": _load(row["sentiment_scores"], {}),
        "factors": _load(row["factors"], []),
        "transcript_excerpt": row["transcript_excerpt"],
        "notes": _load(row["notes"], []),
    }


def _query(sql: str, **params) -> list:
    init_db()
    with engine.connect() as conn:
        return conn.execute(text(sql), params).mappings().all()


def _write(sql: str, **params) -> int:
    init_db()
    with engine.begin() as conn:
        return conn.execute(text(sql), params).rowcount


def list_sessions(limit: int = 50, aura_id: Optional[str] = None) -> List[Dict]:
    """`aura_id=None` lists every session (internal use only) - every API
    route passes a concrete aura_id so one person's sessions are never
    returned for another's request."""
    try:
        if aura_id is not None:
            rows = _query(
                "SELECT * FROM history_sessions WHERE aura_id = :a ORDER BY created_at DESC LIMIT :n",
                a=aura_id, n=limit,
            )
        else:
            rows = _query("SELECT * FROM history_sessions ORDER BY created_at DESC LIMIT :n", n=limit)
        return [_row_to_dict(r) for r in rows]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to list sessions")
        return []


def get_session(session_id: str, aura_id: Optional[str] = None) -> Optional[Dict]:
    try:
        if aura_id is not None:
            rows = _query("SELECT * FROM history_sessions WHERE id = :i AND aura_id = :a", i=session_id, a=aura_id)
        else:
            rows = _query("SELECT * FROM history_sessions WHERE id = :i", i=session_id)
        return _row_to_dict(rows[0]) if rows else None
    except Exception:  # noqa: BLE001
        logger.exception("Failed to fetch session")
        return None


def delete_session(session_id: str, aura_id: Optional[str] = None) -> bool:
    try:
        if aura_id is not None:
            n = _write("DELETE FROM history_sessions WHERE id = :i AND aura_id = :a", i=session_id, a=aura_id)
        else:
            n = _write("DELETE FROM history_sessions WHERE id = :i", i=session_id)
        return n > 0
    except Exception:  # noqa: BLE001
        logger.exception("Failed to delete session")
        return False


def clear_all(aura_id: Optional[str] = None) -> int:
    """Deletes stored sessions - the user's 'clear my history' control.
    `aura_id=None` would wipe every user's history, so every API caller
    always passes their own aura_id."""
    try:
        if aura_id is not None:
            return _write("DELETE FROM history_sessions WHERE aura_id = :a", a=aura_id)
        return _write("DELETE FROM history_sessions")
    except Exception:  # noqa: BLE001
        logger.exception("Failed to clear history")
        return 0


def compute_trend(sessions: List[Dict]) -> Dict:
    """Direction of the distress signal across recent sessions.

    Split-half comparison of the mean distress score, oldest-to-newest. With
    fewer than two scored sessions there is nothing to compare, and that is
    reported as 'insufficient' rather than defaulting to 'stable' - which would
    imply a measurement that was never made.
    """
    scored = [s for s in reversed(sessions) if s.get("distress_score") is not None]
    if len(scored) < 2:
        return {
            "direction": "insufficient",
            "delta": 0.0,
            "sessions_compared": len(scored),
            "label": "Not enough sessions yet",
        }

    mid = len(scored) // 2
    earlier = scored[:mid] or scored[:1]
    later = scored[mid:]
    mean_earlier = sum(s["distress_score"] for s in earlier) / len(earlier)
    mean_later = sum(s["distress_score"] for s in later) / len(later)
    delta = mean_later - mean_earlier

    if delta > 5:
        direction, label = "increasing", "Increasing"
    elif delta < -5:
        direction, label = "decreasing", "Decreasing"
    else:
        direction, label = "stable", "Stable"

    return {
        "direction": direction,
        "delta": round(delta, 1),
        "sessions_compared": len(scored),
        "label": label,
    }
