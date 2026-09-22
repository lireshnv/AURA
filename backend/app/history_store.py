"""Persistence for completed analysis sessions.

STORAGE CHOICE
--------------
The spec names PostgreSQL. This uses SQLite instead, deliberately, for the
prototype stage: it needs no server, no credentials and no setup, which keeps
`uvicorn app.main:app` a single command for a student/demo deployment.

The swap is intentionally cheap. All SQL here is plain and portable, and the
only Postgres-specific work would be swapping the `sqlite3` connection for a
DB-API/SQLAlchemy engine and changing the placeholder style. `DATABASE_URL` is
already read from the environment so the seam exists.

WHAT IS STORED
--------------
Only derived, structured signals: scores, timestamps, a short transcript
excerpt and the distress summary. Raw video, raw audio and face images are
never written to disk - consistent with the privacy commitment shown in the UI.
"""
import json
import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger("aura.history")

# Kept outside the OneDrive-synced project tree: OneDrive's file locking has
# repeatedly broken writes to this project directory, and a locked DB file
# would fail a session save.
DEFAULT_DB_PATH = Path(os.environ.get("AURA_DB_PATH", Path.home() / ".aura" / "aura_history.db"))

_lock = threading.Lock()
_initialized = False


def _db_path() -> Path:
    DEFAULT_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return DEFAULT_DB_PATH


@contextmanager
def _connect():
    conn = sqlite3.connect(_db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    """Creates the schema if absent. Safe to call repeatedly."""
    global _initialized
    with _lock:
        if _initialized:
            return
        try:
            with _connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS sessions (
                        id                TEXT PRIMARY KEY,
                        created_at        TEXT NOT NULL,
                        duration_seconds  REAL NOT NULL DEFAULT 0,
                        observed_emotion  TEXT,
                        emotion_confidence REAL,
                        distress_score    REAL,
                        distress_level    TEXT,
                        sentiment_dominant TEXT,
                        agreement         REAL,
                        modalities        TEXT,
                        valid_observations INTEGER DEFAULT 0,
                        emotion_scores    TEXT,
                        sentiment_scores  TEXT,
                        factors           TEXT,
                        transcript_excerpt TEXT,
                        notes             TEXT
                    )
                    """
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_sessions_created "
                    "ON sessions (created_at DESC)"
                )
            _initialized = True
            logger.info("History database ready at %s", _db_path())
        except Exception:  # noqa: BLE001 - history must never block analysis
            logger.exception("Failed to initialise history database")


def save_session(record: Dict) -> Optional[str]:
    """Persists one completed session. Returns its id, or None on failure.

    Failure is logged and swallowed: losing a history row must never break the
    analysis flow the user is actually in the middle of.
    """
    init_db()
    session_id = record.get("id") or str(uuid.uuid4())
    try:
        with _connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO sessions (
                    id, created_at, duration_seconds, observed_emotion,
                    emotion_confidence, distress_score, distress_level,
                    sentiment_dominant, agreement, modalities,
                    valid_observations, emotion_scores, sentiment_scores,
                    factors, transcript_excerpt, notes
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    session_id,
                    record.get("created_at") or datetime.now(timezone.utc).isoformat(),
                    float(record.get("duration_seconds") or 0),
                    record.get("observed_emotion"),
                    record.get("emotion_confidence"),
                    record.get("distress_score"),
                    record.get("distress_level"),
                    record.get("sentiment_dominant"),
                    record.get("agreement"),
                    json.dumps(record.get("modalities") or []),
                    int(record.get("valid_observations") or 0),
                    json.dumps(record.get("emotion_scores") or {}),
                    json.dumps(record.get("sentiment_scores") or {}),
                    json.dumps(record.get("factors") or []),
                    (record.get("transcript_excerpt") or "")[:1000],
                    json.dumps(record.get("notes") or []),
                ),
            )
        return session_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save session to history")
        return None


def _row_to_dict(row: sqlite3.Row) -> Dict:
    def _load(value, fallback):
        try:
            return json.loads(value) if value else fallback
        except (ValueError, TypeError):
            return fallback

    return {
        "id": row["id"],
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


def list_sessions(limit: int = 50) -> List[Dict]:
    init_db()
    try:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [_row_to_dict(r) for r in rows]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to list sessions")
        return []


def get_session(session_id: str) -> Optional[Dict]:
    init_db()
    try:
        with _connect() as conn:
            row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return _row_to_dict(row) if row else None
    except Exception:  # noqa: BLE001
        logger.exception("Failed to fetch session")
        return None


def delete_session(session_id: str) -> bool:
    init_db()
    try:
        with _connect() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        return cur.rowcount > 0
    except Exception:  # noqa: BLE001
        logger.exception("Failed to delete session")
        return False


def clear_all() -> int:
    """Deletes every stored session - the user's 'clear my history' control."""
    init_db()
    try:
        with _connect() as conn:
            cur = conn.execute("DELETE FROM sessions")
        return cur.rowcount
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
