"""Persistence for the Personal Well-being Digital Twin.

REAL DATA ONLY. Nothing in this module generates, seeds, back-fills or
estimates a record on its own. Every row originates in an action a person
actually took (baseline questionnaire, check-in, analysis session with
consent), or in the explicit demo seeder, which marks its check-ins
source="synthetic".

SCOPE: every row belongs to exactly one person, keyed by their aura_id, and
every function takes that aura_id as a REQUIRED keyword argument. This used
to be a single shared store, which meant one victim's check-ins appeared on
every other victim's dashboard; making the argument required means a caller
that forgets to scope fails loudly instead of silently reading everyone's
data.

STORAGE: the main application database (the same SQLAlchemy engine as the
ORM models - Postgres in production), so twin data survives redeploys of an
ephemeral-disk host. Tables are prefixed `twin_` and created on first use.
All SQL is portable between Postgres and SQLite.
"""
import json
import logging
import threading
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from sqlalchemy import text

from .database import engine

logger = logging.getLogger("aura.twin_store")

# Consent scopes. Each is granted separately and can be withdrawn separately -
# consenting to check-ins must not silently enable camera analysis.
CONSENT_SCOPES = (
    "baseline",          # store questionnaire answers
    "checkins",          # store daily check-in responses
    "emotion_signals",   # store derived face/voice/text signals
    "session_history",   # retain past sessions for trend analysis
    "companion_care",    # store Companion daily-care actions (feed/water/activity)
)

_SCOPE_TABLES = {
    "baseline": "twin_baseline_answers",
    "checkins": "twin_checkins",
    "emotion_signals": "twin_signal_observations",
    "companion_care": "twin_care_actions",
}

_lock = threading.Lock()
_initialized = False


def init_db() -> None:
    global _initialized
    with _lock:
        if _initialized:
            return
        try:
            with engine.begin() as conn:
                conn.execute(text(
                    """CREATE TABLE IF NOT EXISTS twin_consent (
                        aura_id     TEXT NOT NULL,
                        scope       TEXT NOT NULL,
                        granted     INTEGER NOT NULL DEFAULT 0,
                        updated_at  TEXT NOT NULL,
                        PRIMARY KEY (aura_id, scope)
                    )"""
                ))
                conn.execute(text(
                    """CREATE TABLE IF NOT EXISTS twin_baseline_answers (
                        id          TEXT PRIMARY KEY,
                        aura_id     TEXT NOT NULL,
                        created_at  TEXT NOT NULL,
                        answers     TEXT NOT NULL,
                        preferred_checkin_time TEXT
                    )"""
                ))
                conn.execute(text(
                    """CREATE TABLE IF NOT EXISTS twin_checkins (
                        id          TEXT PRIMARY KEY,
                        aura_id     TEXT NOT NULL,
                        created_at  TEXT NOT NULL,
                        values_json TEXT NOT NULL,
                        note        TEXT,
                        skipped     INTEGER NOT NULL DEFAULT 0,
                        source      TEXT NOT NULL DEFAULT 'user'
                    )"""
                ))
                conn.execute(text(
                    """CREATE TABLE IF NOT EXISTS twin_signal_observations (
                        id                 TEXT PRIMARY KEY,
                        aura_id            TEXT NOT NULL,
                        created_at         TEXT NOT NULL,
                        emotion_dominant   TEXT,
                        emotion_confidence REAL,
                        emotion_scores     TEXT,
                        sentiment_dominant TEXT,
                        sentiment_scores   TEXT,
                        voice_available    INTEGER DEFAULT 0,
                        text_available     INTEGER DEFAULT 0,
                        modalities         TEXT,
                        reliability        TEXT,
                        session_id         TEXT
                    )"""
                ))
                conn.execute(text(
                    """CREATE TABLE IF NOT EXISTS twin_care_actions (
                        id            TEXT PRIMARY KEY,
                        aura_id       TEXT NOT NULL,
                        created_at    TEXT NOT NULL,
                        kind          TEXT NOT NULL,
                        activity_type TEXT
                    )"""
                ))
                for table in ("twin_checkins", "twin_signal_observations", "twin_care_actions", "twin_baseline_answers"):
                    conn.execute(text(
                        f"CREATE INDEX IF NOT EXISTS idx_{table}_owner ON {table} (aura_id, created_at)"
                    ))
            _initialized = True
            logger.info("Digital twin tables ready (main database)")
        except Exception:  # noqa: BLE001 - persistence must never break analysis
            logger.exception("Failed to initialise digital twin tables")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _cutoff(days: Optional[int]) -> Optional[str]:
    if days is None:
        return None
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _rows(sql: str, **params) -> list:
    init_db()
    with engine.connect() as conn:
        return conn.execute(text(sql), params).mappings().all()


def _write(sql: str, **params) -> int:
    init_db()
    with engine.begin() as conn:
        return conn.execute(text(sql), params).rowcount


# --- Consent ---------------------------------------------------------------


def get_consent(*, aura_id: str) -> Dict[str, bool]:
    """Current consent state. Every scope defaults to FALSE (opt-in)."""
    state = {scope: False for scope in CONSENT_SCOPES}
    try:
        for row in _rows("SELECT scope, granted FROM twin_consent WHERE aura_id = :a", a=aura_id):
            if row["scope"] in state:
                state[row["scope"]] = bool(row["granted"])
    except Exception:  # noqa: BLE001
        logger.exception("Failed to read consent")
    return state


def set_consent(scope: str, granted: bool, *, aura_id: str) -> bool:
    if scope not in CONSENT_SCOPES:
        return False
    try:
        _write(
            "INSERT INTO twin_consent (aura_id, scope, granted, updated_at) VALUES (:a, :s, :g, :t) "
            "ON CONFLICT (aura_id, scope) DO UPDATE SET granted = excluded.granted, updated_at = excluded.updated_at",
            a=aura_id, s=scope, g=1 if granted else 0, t=_now_iso(),
        )
        return True
    except Exception:  # noqa: BLE001
        logger.exception("Failed to write consent")
        return False


def has_consent(scope: str, *, aura_id: str) -> bool:
    return get_consent(aura_id=aura_id).get(scope, False)


# --- Baseline questionnaire ------------------------------------------------


def save_baseline_answers(
    answers: Dict[str, float], preferred_checkin_time: Optional[str] = None, *, aura_id: str
) -> Optional[str]:
    """Stores the person's baseline questionnaire. Requires 'baseline' consent."""
    if not has_consent("baseline", aura_id=aura_id):
        return None
    entry_id = str(uuid.uuid4())
    try:
        _write(
            "INSERT INTO twin_baseline_answers (id, aura_id, created_at, answers, preferred_checkin_time) "
            "VALUES (:id, :a, :t, :ans, :p)",
            id=entry_id, a=aura_id, t=_now_iso(), ans=json.dumps(answers), p=preferred_checkin_time,
        )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save baseline answers")
        return None


def get_latest_baseline_answers(*, aura_id: str) -> Optional[Dict]:
    try:
        rows = _rows(
            "SELECT * FROM twin_baseline_answers WHERE aura_id = :a ORDER BY created_at DESC LIMIT 1",
            a=aura_id,
        )
        if not rows:
            return None
        row = rows[0]
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
    *,
    aura_id: str,
) -> Optional[str]:
    """Stores one check-in. Requires 'checkins' consent.

    A skipped check-in is still recorded (with no values) because *engagement*
    is a legitimate signal - but it contributes no self-report data.

    `created_at`/`source` are only overridden by the demo seeder so seeded
    check-ins can be spread across past days; every normal caller leaves them
    at the defaults (now, "user").
    """
    if not has_consent("checkins", aura_id=aura_id):
        return None
    entry_id = str(uuid.uuid4())
    try:
        _write(
            "INSERT INTO twin_checkins (id, aura_id, created_at, values_json, note, skipped, source) "
            "VALUES (:id, :a, :t, :v, :n, :s, :src)",
            id=entry_id, a=aura_id, t=created_at or _now_iso(), v=json.dumps(values or {}),
            n=note, s=1 if skipped else 0, src=source,
        )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save check-in")
        return None


def list_checkins(days: Optional[int] = None, *, aura_id: str) -> List[Dict]:
    """This person's check-ins, oldest first. Returns [] when there are none."""
    try:
        cut = _cutoff(days)
        if cut is None:
            rows = _rows("SELECT * FROM twin_checkins WHERE aura_id = :a ORDER BY created_at ASC", a=aura_id)
        else:
            rows = _rows(
                "SELECT * FROM twin_checkins WHERE aura_id = :a AND created_at >= :c ORDER BY created_at ASC",
                a=aura_id, c=cut,
            )
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


def save_care_action(kind: str, activity_type: Optional[str] = None, *, aura_id: str) -> Optional[str]:
    """Stores one Companion daily-care action. Requires 'companion_care'
    consent. Check-ins are recorded through the check-ins table instead."""
    if kind not in CARE_KINDS:
        return None
    if not has_consent("companion_care", aura_id=aura_id):
        return None
    entry_id = str(uuid.uuid4())
    try:
        _write(
            "INSERT INTO twin_care_actions (id, aura_id, created_at, kind, activity_type) "
            "VALUES (:id, :a, :t, :k, :at)",
            id=entry_id, a=aura_id, t=_now_iso(), k=kind, at=activity_type,
        )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save care action")
        return None


def list_care_actions(days: Optional[int] = None, *, aura_id: str) -> List[Dict]:
    """This person's completed care actions, oldest first."""
    try:
        cut = _cutoff(days)
        if cut is None:
            rows = _rows("SELECT * FROM twin_care_actions WHERE aura_id = :a ORDER BY created_at ASC", a=aura_id)
        else:
            rows = _rows(
                "SELECT * FROM twin_care_actions WHERE aura_id = :a AND created_at >= :c ORDER BY created_at ASC",
                a=aura_id, c=cut,
            )
        return [
            {"id": r["id"], "created_at": r["created_at"], "kind": r["kind"], "activity_type": r["activity_type"]}
            for r in rows
        ]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to list care actions")
        return []


# --- Signal observations (from the emotion dashboard) ----------------------


def save_signal_observation(record: Dict, created_at: Optional[str] = None, *, aura_id: str) -> Optional[str]:
    """Stores one structured analysis result. Requires 'emotion_signals' consent.

    Only DERIVED signals are stored - scores, labels, reliability. No frames,
    no audio, no transcript text.
    """
    if not has_consent("emotion_signals", aura_id=aura_id):
        return None
    entry_id = str(uuid.uuid4())
    reliability = record.get("reliability")
    try:
        _write(
            """INSERT INTO twin_signal_observations (
                id, aura_id, created_at, emotion_dominant, emotion_confidence, emotion_scores,
                sentiment_dominant, sentiment_scores, voice_available, text_available,
                modalities, reliability, session_id
            ) VALUES (:id, :a, :t, :ed, :ec, :es, :sd, :ss, :va, :ta, :m, :r, :sid)""",
            id=entry_id, a=aura_id, t=created_at or _now_iso(),
            ed=record.get("emotion_dominant"), ec=record.get("emotion_confidence"),
            es=json.dumps(record.get("emotion_scores") or {}),
            sd=record.get("sentiment_dominant"), ss=json.dumps(record.get("sentiment_scores") or {}),
            va=1 if record.get("voice_available") else 0, ta=1 if record.get("text_available") else 0,
            m=json.dumps(record.get("modalities") or []),
            r=None if reliability is None else str(reliability),
            sid=record.get("session_id"),
        )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to save signal observation")
        return None


def _reliability_out(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return value


def list_signal_observations(days: Optional[int] = None, *, aura_id: str) -> List[Dict]:
    try:
        cut = _cutoff(days)
        if cut is None:
            rows = _rows(
                "SELECT * FROM twin_signal_observations WHERE aura_id = :a ORDER BY created_at ASC", a=aura_id
            )
        else:
            rows = _rows(
                "SELECT * FROM twin_signal_observations WHERE aura_id = :a AND created_at >= :c "
                "ORDER BY created_at ASC",
                a=aura_id, c=cut,
            )
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
                "reliability": _reliability_out(r["reliability"]),
                "session_id": r["session_id"],
            }
            for r in rows
        ]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to list signal observations")
        return []


def has_any_data(*, aura_id: str) -> bool:
    """Whether this person has any stored twin data at all (cheap check)."""
    try:
        for table in ("twin_checkins", "twin_signal_observations", "twin_baseline_answers"):
            if _rows(f"SELECT 1 FROM {table} WHERE aura_id = :a LIMIT 1", a=aura_id):
                return True
    except Exception:  # noqa: BLE001
        logger.exception("Failed to check for stored data")
    return False


# --- Data control ----------------------------------------------------------


def data_summary(*, aura_id: str) -> Dict:
    """What is actually stored about this person, for the Privacy Center."""
    try:
        counts = {}
        for key, table in (
            ("checkins", "twin_checkins"),
            ("signal_observations", "twin_signal_observations"),
            ("baseline_submissions", "twin_baseline_answers"),
            ("care_actions", "twin_care_actions"),
        ):
            counts[key] = _rows(f"SELECT COUNT(*) AS c FROM {table} WHERE aura_id = :a", a=aura_id)[0]["c"]
        earliest = _rows(
            "SELECT MIN(created_at) AS m FROM ("
            "  SELECT created_at FROM twin_checkins WHERE aura_id = :a"
            "  UNION ALL SELECT created_at FROM twin_signal_observations WHERE aura_id = :a"
            "  UNION ALL SELECT created_at FROM twin_care_actions WHERE aura_id = :a) AS t",
            a=aura_id,
        )[0]["m"]
        return {
            **counts,
            "earliest_record": earliest,
            "storage_location": "AURA application database",
            "raw_media_stored": False,
            "transcript_text_stored": False,
        }
    except Exception:  # noqa: BLE001
        logger.exception("Failed to summarise stored data")
        return {}


def delete_scope(scope: str, *, aura_id: str) -> int:
    """Permanently deletes one category of this person's stored data."""
    table = _SCOPE_TABLES.get(scope)
    if not table:
        return 0
    try:
        return _write(f"DELETE FROM {table} WHERE aura_id = :a", a=aura_id)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to delete scope %s", scope)
        return 0


def delete_all(*, aura_id: str) -> Dict[str, int]:
    """Deletes every stored record for this person and revokes their consent."""
    deleted = {}
    try:
        for scope, table in _SCOPE_TABLES.items():
            deleted[scope] = _write(f"DELETE FROM {table} WHERE aura_id = :a", a=aura_id)
        _write("DELETE FROM twin_consent WHERE aura_id = :a", a=aura_id)
    except Exception:  # noqa: BLE001
        logger.exception("Failed to delete all data")
    return deleted


def export_all(*, aura_id: str) -> Dict:
    """Full export of everything stored about this person."""
    return {
        "exported_at": _now_iso(),
        "consent": get_consent(aura_id=aura_id),
        "baseline": get_latest_baseline_answers(aura_id=aura_id),
        "checkins": list_checkins(aura_id=aura_id),
        "signal_observations": list_signal_observations(aura_id=aura_id),
        "care_actions": list_care_actions(aura_id=aura_id),
        "note": "Raw video, audio and transcript text are never stored and cannot appear here.",
    }
