"""Storage for AURA calls - both counsellor-generated (the real feature) and
the earlier victim-self-initiated path (still supported, unused by the
current victim UI). Stores only real call interactions: an actual call was
started, actual turns (real transcribed/typed user text and real Groq
replies) were exchanged, and how it actually ended. Nothing here is ever
backfilled or invented - a call with no turns is stored as a call with zero
turns.

Status vocabulary matches the spec: ringing -> answered -> completed, or
declined / failed. ("pending"/"in_progress" are not distinct persisted
states here - a call is "ringing" until answered, and "answered" for its
whole active duration; the richer intermediate states add no real
information this store doesn't already track via turns/timestamps.)
"""
import logging
import os
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger("aura.ivrs_store")

DB_PATH = Path(os.environ.get("AURA_IVRS_DB_PATH", Path.home() / ".aura" / "aura_ivrs.db"))

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


def _add_missing_columns(conn) -> None:
    """Adds columns introduced after this table already existed on disk -
    `CREATE TABLE IF NOT EXISTS` alone won't add them to an existing file."""
    existing = {row[1] for row in conn.execute("PRAGMA table_info(ivrs_calls)").fetchall()}
    additions = [
        ("counsellor_user_id", "TEXT"),
        ("message", "TEXT"),
        ("answered_at", "TEXT"),
        ("language", "TEXT"),
    ]
    for name, ddl_type in additions:
        if name not in existing:
            conn.execute(f"ALTER TABLE ivrs_calls ADD COLUMN {name} {ddl_type}")
            logger.info("Added missing column ivrs_calls.%s", name)


def init_db() -> None:
    global _initialized
    with _lock:
        if _initialized:
            return
        try:
            with _connect() as conn:
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS ivrs_calls (
                        id                 TEXT PRIMARY KEY,
                        aura_id            TEXT NOT NULL,
                        reason_key         TEXT NOT NULL,
                        custom_reason      TEXT,
                        status             TEXT NOT NULL,
                        started_at         TEXT NOT NULL,
                        ended_at           TEXT,
                        counsellor_user_id TEXT,
                        message            TEXT,
                        answered_at        TEXT,
                        language           TEXT
                    )"""
                )
                conn.execute(
                    """CREATE TABLE IF NOT EXISTS ivrs_turns (
                        id       TEXT PRIMARY KEY,
                        call_id  TEXT NOT NULL,
                        role     TEXT NOT NULL,
                        text     TEXT NOT NULL,
                        at       TEXT NOT NULL
                    )"""
                )
                _add_missing_columns(conn)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_ivrs_turns_call ON ivrs_turns (call_id)")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_ivrs_calls_aura ON ivrs_calls (aura_id)")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_ivrs_calls_counsellor ON ivrs_calls (counsellor_user_id)"
                )
            _initialized = True
            logger.info("IVRS call store ready at %s", DB_PATH)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to initialise IVRS call store")


def start_call(
    victim_aura_id: str,
    reason_key: str,
    custom_reason: Optional[str],
    message: str,
    counsellor_user_id: Optional[str] = None,
    language: Optional[str] = None,
    started_at: Optional[str] = None,
) -> str:
    """Creates a call in 'ringing' status. `victim_aura_id` is whose phone is
    "ringing" - the caller's own aura_id for a self-initiated call, or the
    target victim's aura_id when a counsellor generates the call.

    `started_at` override exists only for the synthetic-data seeder (see
    aura_api.py's /dev/seed-demo-data), so demo calls can be spread across
    past days instead of all landing at the same instant.
    """
    init_db()
    call_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO ivrs_calls "
            "(id, aura_id, reason_key, custom_reason, status, started_at, counsellor_user_id, message, language) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                call_id,
                victim_aura_id,
                reason_key,
                custom_reason,
                "ringing",
                started_at or datetime.now(timezone.utc).isoformat(),
                counsellor_user_id,
                message,
                language,
            ),
        )
    return call_id


def set_status(
    call_id: str, status: str, ended: bool = False, answered: bool = False, at: Optional[str] = None
) -> None:
    init_db()
    now = at or datetime.now(timezone.utc).isoformat()
    with _connect() as conn:
        if ended:
            conn.execute(
                "UPDATE ivrs_calls SET status = ?, ended_at = ? WHERE id = ?", (status, now, call_id)
            )
        elif answered:
            conn.execute(
                "UPDATE ivrs_calls SET status = ?, answered_at = ? WHERE id = ?", (status, now, call_id)
            )
        else:
            conn.execute("UPDATE ivrs_calls SET status = ? WHERE id = ?", (status, call_id))


def add_turn(call_id: str, role: str, text: str, at: Optional[str] = None) -> None:
    """`role` is 'user' or 'aura'. A blank text is not stored - it is not a
    real turn, and storing it would misrepresent the call transcript."""
    if not text or not text.strip():
        return
    init_db()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO ivrs_turns (id, call_id, role, text, at) VALUES (?,?,?,?,?)",
            (str(uuid.uuid4()), call_id, role, text.strip(), at or datetime.now(timezone.utc).isoformat()),
        )


def get_call(call_id: str) -> Optional[Dict]:
    init_db()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM ivrs_calls WHERE id = ?", (call_id,)).fetchone()
        if not row:
            return None
        turns = conn.execute(
            "SELECT role, text, at FROM ivrs_turns WHERE call_id = ? ORDER BY at ASC", (call_id,)
        ).fetchall()
    return {
        "id": row["id"],
        "aura_id": row["aura_id"],
        "reason_key": row["reason_key"],
        "custom_reason": row["custom_reason"],
        "status": row["status"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "counsellor_user_id": row["counsellor_user_id"],
        "message": row["message"],
        "answered_at": row["answered_at"],
        "language": row["language"],
        "turns": [{"role": t["role"], "text": t["text"], "at": t["at"]} for t in turns],
    }


def history_for_groq(call_id: str) -> List[Dict]:
    """This call's real turns only, mapped to Groq's role vocabulary."""
    call = get_call(call_id)
    if not call:
        return []
    return [
        {"role": "assistant" if t["role"] == "aura" else "user", "content": t["text"]}
        for t in call["turns"]
    ]


def _row_summary(r: sqlite3.Row) -> Dict:
    return {
        "id": r["id"],
        "aura_id": r["aura_id"],
        "reason_key": r["reason_key"],
        "custom_reason": r["custom_reason"],
        "status": r["status"],
        "started_at": r["started_at"],
        "answered_at": r["answered_at"],
        "ended_at": r["ended_at"],
        "counsellor_user_id": r["counsellor_user_id"],
        "message": r["message"],
    }


def list_calls(aura_id: str, limit: int = 50) -> List[Dict]:
    """Calls for one victim (their own call history)."""
    init_db()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM ivrs_calls WHERE aura_id = ? ORDER BY started_at DESC LIMIT ?",
            (aura_id, limit),
        ).fetchall()
    return [_row_summary(r) for r in rows]


def list_calls_by_counsellor(counsellor_user_id: str, limit: int = 100) -> List[Dict]:
    """Calls a specific counsellor generated - what their 'AURA Call' history view shows."""
    init_db()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM ivrs_calls WHERE counsellor_user_id = ? ORDER BY started_at DESC LIMIT ?",
            (counsellor_user_id, limit),
        ).fetchall()
    return [_row_summary(r) for r in rows]
