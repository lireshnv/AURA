"""Persistence for the Personal Well-being Digital Twin.

REAL DATA ONLY. Nothing in this module generates, seeds, back-fills or
estimates a record. Every row here originates in an action the user actually
took: answering the baseline questionnaire, completing a check-in, or running
an analysis session while consent was active.

If there is no data, queries return empty and the caller reports
"Baseline building..." / "Not enough information yet." That absence is the
honest answer and must never be papered over with a placeholder.

This store is entirely separate from demo_data.py. No demo profile can reach
these tables, and no row here is synthetic.

STORAGE: SQLite, for the same reason as history_store - no server, no
credentials, single-command startup. All SQL is portable; the Postgres swap is
a connection change and placeholder style.
"""
import json
import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger("aura.twin_store")

DB_PATH = Path(
    os.environ.get("AURA_TWIN_DB_PATH", Path.home() / ".aura" / "aura_twin.db")
)

# Consent scopes. Each is granted separately and can be withdrawn separately -
# consenting to check-ins must not silently enable camera analysis.
CONSENT_SCOPES = (
    "baseline",          # store questionnaire answers
    "checkins",          # store daily check-in responses
    "emotion_signals",   # store derived face/voice/text signals
    "session_history",   # retain past sessions for trend analysis
    "companion_care",    # store Companion daily-care actions (feed/water/activity)
)

_lock = threading.Lock()
_initialized = False


@contextmanager
def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    global _initialized
    with _lock:
        if _initialized:
            return
        try:
            with _connect() as conn:
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS consent (
                        scope       TEXT PRIMARY KEY,
                        granted     INTEGER NOT NULL DEFAULT 0,
                        updated_at  TEXT NOT NULL
                    )"""
                )
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS baseline_answers (
                        id          TEXT PRIMARY KEY,
                        created_at  TEXT NOT NULL,
                        answers     TEXT NOT NULL,
                        preferred_checkin_time TEXT
                    )"""
                )
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS checkins (
                        id          TEXT PRIMARY KEY,
                        created_at  TEXT NOT NULL,
                        values_json TEXT NOT NULL,
                        note        TEXT,
                        skipped     INTEGER NOT NULL DEFAULT 0,
                        source      TEXT NOT NULL DEFAULT 'user'
                    )"""
                )
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS signal_observations (
                        id                 TEXT PRIMARY KEY,
                        created_at         TEXT NOT NULL,
                        emotion_dominant   TEXT,
                        emotion_confidence REAL,
                        emotion_scores     TEXT,
                        sentiment_dominant TEXT,
                        sentiment_scores   TEXT,
                        voice_available    INTEGER DEFAULT 0,
                        text_available     INTEGER DEFAULT 0,
                        modalities         TEXT,
                        reliability        REAL,
                        session_id         TEXT
                    )"""
                )
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS care_actions (
                        id            TEXT PRIMARY KEY,
                        created_at    TEXT NOT NULL,
                        kind          TEXT NOT NULL,
                        activity_type TEXT
                    )"""
                )
                for table, column in (
                    ("checkins", "created_at"),
                    ("signal_observations", "created_at"),
                    ("care_actions", "created_at"),
                ):
                    conn.execute(
                        f"CREATE INDEX IF NOT EXISTS idx_{table}_created "
                        f"ON {table} ({column} DESC)"
                    )
            _initialized = True
            logger.info("Digital twin database ready at %s", DB_PATH)
        except Exception:  # noqa: BLE001 - persistence must never break analysis
            logger.exception("Failed to initialise digital twin database")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- Consent ---------------------------------------------------------------


def get_consent() -> Dict[str, bool]:
    """Current consent state. Every scope defaults to FALSE (opt-in)."""
    init_db()
    state = {scope: False for scope in CONSENT_SCOPES}
    try:
        with _connect() as conn:
            for row in conn.execute("SELECT scope, granted FROM consent").fetchall():
                if row["scope"] in state:
                    state[row["scope"]] = bool(row["granted"])
    except Exception:  # noqa: BLE001
        logger.exception("Failed to read consent")
    return state


def set_consent(scope: str, granted: bool) -> bool:
    if scope not in CONSENT_SCOPES:
        return False
    init_db()
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO consent (scope, granted, updated_at) VALUES (?,?,?)",
                (scope, 1 if granted else 0, _now_iso()),
            )
        return True
    except Exception:  # noqa: BLE001
        logger.exception("Failed to write consent")
        return False


def has_consent(scope: str) -> bool:
    return get_consent().get(scope, False)


# --- Baseline questionnaire ------------------------------------------------


def save_baseline_answers(
    answers: Dict[str, float], preferred_checkin_time: Optional[str] = None
) -> Optional[str]:
    """Stores the user's baseline questionnaire. Requires 'baseline' consent."""
    if not has_consent("baseline"):
        return None
    init_db()
    entry_id = str(uuid.uuid4())
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO baseline_answers (id, created_at, answers, preferred_checkin_time) "
                "VALUES (?,?,?,?)",
                (entry_id, _now_iso(), json.dumps(answers), preferred_checkin_time),
            )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save baseline answers")
        return None


def get_latest_baseline_answers() -> Optional[Dict]:
    init_db()
    try:
        with _connect() as conn:
            row = conn.execute(
                "SELECT * FROM baseline_answers ORDER BY created_at DESC LIMIT 1"
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "created_at": row["created_at"],
            "answers": json.loads(row["answers"]),
            "preferred_checkin_time": row["preferred_checkin_time"],
        }
    except Exception:  # noqa: BLE001
        logger.exception("Failed to read baseline answers")
        return None


# --- Check-ins -------------------------------------------------------------


def save_checkin(
    values: Dict[str, float],
    note: Optional[str] = None,
    skipped: bool = False,
    created_at: Optional[str] = None,
    source: str = "user",
) -> Optional[str]:
    """Stores one real check-in. Requires 'checkins' consent.

    A skipped check-in is still recorded (with no values) because *engagement*
    is a legitimate signal - but it contributes no self-report data.

    `created_at`/`source` are only overridden by the synthetic-data seeder
    (see aura_api.py's /dev/seed-demo-data) so demo check-ins can be spread
    across past days instead of all landing at the same instant; every normal
    caller leaves them at the defaults (now, "user").
    """
    if not has_consent("checkins"):
        return None
    init_db()
    entry_id = str(uuid.uuid4())
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO checkins (id, created_at, values_json, note, skipped, source) "
                "VALUES (?,?,?,?,?,?)",
                (entry_id, created_at or _now_iso(), json.dumps(values or {}), note,
                 1 if skipped else 0, source),
            )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save check-in")
        return None


def list_checkins(days: Optional[int] = None) -> List[Dict]:
    """Real check-ins, oldest first. Returns [] when there are none."""
    init_db()
    try:
        with _connect() as conn:
            if days is None:
                rows = conn.execute(
                    "SELECT * FROM checkins ORDER BY created_at ASC"
                ).fetchall()
            else:
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
                rows = conn.execute(
                    "SELECT * FROM checkins WHERE created_at >= ? ORDER BY created_at ASC",
                    (cutoff,),
                ).fetchall()
        result = []
        for row in rows:
            entry = {
                "id": row["id"],
                "created_at": row["created_at"],
                "note": row["note"],
                "skipped": bool(row["skipped"]),
            }
            entry.update(json.loads(row["values_json"]) or {})
            result.append(entry)
        return result
    except Exception:  # noqa: BLE001
        logger.exception("Failed to list check-ins")
        return []


# --- Companion daily care (feed / water / activity) ------------------------

CARE_KINDS = ("feed", "water", "activity")


def save_care_action(kind: str, activity_type: Optional[str] = None) -> Optional[str]:
    """Stores one real Companion daily-care action. Requires 'companion_care'
    consent. `kind` is one of CARE_KINDS - check-ins are recorded through the
    existing checkins table instead, not duplicated here."""
    if kind not in CARE_KINDS:
        return None
    if not has_consent("companion_care"):
        return None
    init_db()
    entry_id = str(uuid.uuid4())
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO care_actions (id, created_at, kind, activity_type) "
                "VALUES (?,?,?,?)",
                (entry_id, _now_iso(), kind, activity_type),
            )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save care action")
        return None


def list_care_actions(days: Optional[int] = None) -> List[Dict]:
    """Real completed care actions, oldest first. Returns [] when there are none."""
    init_db()
    try:
        with _connect() as conn:
            if days is None:
                rows = conn.execute(
                    "SELECT * FROM care_actions ORDER BY created_at ASC"
                ).fetchall()
            else:
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
                rows = conn.execute(
                    "SELECT * FROM care_actions WHERE created_at >= ? ORDER BY created_at ASC",
                    (cutoff,),
                ).fetchall()
        return [
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "kind": r["kind"],
                "activity_type": r["activity_type"],
            }
            for r in rows
        ]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to list care actions")
        return []


# --- Signal observations (from the existing emotion dashboard) -------------


def save_signal_observation(record: Dict, created_at: Optional[str] = None) -> Optional[str]:
    """Stores one structured analysis result. Requires 'emotion_signals' consent.

    Only DERIVED signals are stored - scores, labels, reliability. No frames,
    no audio, no transcript text.

    `created_at` override exists only for the synthetic-data seeder, same
    reasoning as save_checkin() above.
    """
    if not has_consent("emotion_signals"):
        return None
    init_db()
    entry_id = str(uuid.uuid4())
    try:
        with _connect() as conn:
            conn.execute(
                """INSERT INTO signal_observations (
                    id, created_at, emotion_dominant, emotion_confidence, emotion_scores,
                    sentiment_dominant, sentiment_scores, voice_available, text_available,
                    modalities, reliability, session_id
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    entry_id,
                    created_at or _now_iso(),
                    record.get("emotion_dominant"),
                    record.get("emotion_confidence"),
                    json.dumps(record.get("emotion_scores") or {}),
                    record.get("sentiment_dominant"),
                    json.dumps(record.get("sentiment_scores") or {}),
                    1 if record.get("voice_available") else 0,
                    1 if record.get("text_available") else 0,
                    json.dumps(record.get("modalities") or []),
                    record.get("reliability"),
                    record.get("session_id"),
                ),
            )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save signal observation")
        return None


def list_signal_observations(days: Optional[int] = None) -> List[Dict]:
    init_db()
    try:
        with _connect() as conn:
            if days is None:
                rows = conn.execute(
                    "SELECT * FROM signal_observations ORDER BY created_at ASC"
                ).fetchall()
            else:
                cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
                rows = conn.execute(
                    "SELECT * FROM signal_observations WHERE created_at >= ? "
                    "ORDER BY created_at ASC",
                    (cutoff,),
                ).fetchall()
        return [
            {
                "id": r["id"],
                "created_at": r["created_at"],
                "emotion_dominant": r["emotion_dominant"],
                "emotion_confidence": r["emotion_confidence"],
                "emotion_scores": json.loads(r["emotion_scores"] or "{}"),
                "sentiment_dominant": r["sentiment_dominant"],
                "sentiment_scores": json.loads(r["sentiment_scores"] or "{}"),
                "voice_available": bool(r["voice_available"]),
                "text_available": bool(r["text_available"]),
                "modalities": json.loads(r["modalities"] or "[]"),
                "reliability": r["reliability"],
                "session_id": r["session_id"],
            }
            for r in rows
        ]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to list signal observations")
        return []


# --- Data control ----------------------------------------------------------


def data_summary() -> Dict:
    """What is actually stored, for the Privacy Center."""
    init_db()
    try:
        with _connect() as conn:
            checkins = conn.execute("SELECT COUNT(*) c FROM checkins").fetchone()["c"]
            signals = conn.execute(
                "SELECT COUNT(*) c FROM signal_observations"
            ).fetchone()["c"]
            baselines = conn.execute(
                "SELECT COUNT(*) c FROM baseline_answers"
            ).fetchone()["c"]
            care_actions = conn.execute(
                "SELECT COUNT(*) c FROM care_actions"
            ).fetchone()["c"]
            earliest = conn.execute(
                "SELECT MIN(created_at) m FROM ("
                "  SELECT created_at FROM checkins "
                "  UNION ALL SELECT created_at FROM signal_observations "
                "  UNION ALL SELECT created_at FROM care_actions)"
            ).fetchone()["m"]
        return {
            "checkins": checkins,
            "signal_observations": signals,
            "baseline_submissions": baselines,
            "care_actions": care_actions,
            "earliest_record": earliest,
            "storage_location": str(DB_PATH),
            "raw_media_stored": False,
            "transcript_text_stored": False,
        }
    except Exception:  # noqa: BLE001
        logger.exception("Failed to summarise stored data")
        return {}


def delete_scope(scope: str) -> int:
    """Permanently deletes one category of stored data."""
    init_db()
    table = {
        "baseline": "baseline_answers",
        "checkins": "checkins",
        "emotion_signals": "signal_observations",
        "companion_care": "care_actions",
    }.get(scope)
    if not table:
        return 0
    try:
        with _connect() as conn:
            cur = conn.execute(f"DELETE FROM {table}")
        return cur.rowcount
    except Exception:  # noqa: BLE001
        logger.exception("Failed to delete scope %s", scope)
        return 0


def delete_all() -> Dict[str, int]:
    """Deletes every stored record and revokes all consent."""
    init_db()
    deleted = {}
    try:
        with _connect() as conn:
            for scope, table in (
                ("baseline", "baseline_answers"),
                ("checkins", "checkins"),
                ("emotion_signals", "signal_observations"),
                ("companion_care", "care_actions"),
            ):
                cur = conn.execute(f"DELETE FROM {table}")
                deleted[scope] = cur.rowcount
            conn.execute("DELETE FROM consent")
        return deleted
    except Exception:  # noqa: BLE001
        logger.exception("Failed to delete all data")
        return deleted


def export_all() -> Dict:
    """Full export of everything stored about the user."""
    return {
        "exported_at": _now_iso(),
        "consent": get_consent(),
        "baseline": get_latest_baseline_answers(),
        "checkins": list_checkins(),
        "signal_observations": list_signal_observations(),
        "care_actions": list_care_actions(),
        "note": "Raw video, audio and transcript text are never stored and cannot appear here.",
    }
