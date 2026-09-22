"""Append-only audit log for human actions on risk assessments.

Every human decision - reviewing a case, requesting follow-up, a user asking
for support - is recorded with who did it, when, and why.

Two design rules:

* APPEND-ONLY. There is no update or delete function in this module. An audit
  trail that can be edited is not an audit trail, and for a system touching
  vulnerable people's cases that property matters more than convenience.

* MINIMAL. Only pseudonymous AURA-IDs, an action, a role and a reason are
  stored. No names, no contact details, no clinical notes, no signal values.
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

logger = logging.getLogger("aura.audit")

DB_PATH = Path(os.environ.get("AURA_AUDIT_DB_PATH", Path.home() / ".aura" / "aura_audit.db"))

# Actions the log accepts. An unknown action is rejected rather than stored,
# so the vocabulary cannot drift silently over time.
ACTIONS = (
    "risk_reviewed",
    "follow_up_requested",
    "continue_monitoring",
    "support_requested",
    "review_requested",
    "case_opened",
    "consent_changed",
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
                    """CREATE TABLE IF NOT EXISTS audit_log (
                        id          TEXT PRIMARY KEY,
                        timestamp   TEXT NOT NULL,
                        aura_id     TEXT NOT NULL,
                        action      TEXT NOT NULL,
                        actor_role  TEXT NOT NULL,
                        actor_id    TEXT,
                        reason      TEXT,
                        context     TEXT
                    )"""
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (timestamp DESC)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_audit_aura ON audit_log (aura_id)"
                )
            _initialized = True
            logger.info("Audit log ready at %s", DB_PATH)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to initialise audit log")


def record(
    aura_id: str,
    action: str,
    actor_role: str,
    actor_id: Optional[str] = None,
    reason: Optional[str] = None,
    context: Optional[Dict] = None,
) -> Optional[str]:
    """Appends one entry. Returns its id, or None if rejected/failed."""
    if action not in ACTIONS:
        logger.warning("Rejected unknown audit action: %s", action)
        return None
    init_db()
    entry_id = str(uuid.uuid4())
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO audit_log (id, timestamp, aura_id, action, actor_role, "
                "actor_id, reason, context) VALUES (?,?,?,?,?,?,?,?)",
                (
                    entry_id,
                    datetime.now(timezone.utc).isoformat(),
                    aura_id,
                    action,
                    actor_role,
                    actor_id,
                    reason,
                    json.dumps(context or {}),
                ),
            )
        return entry_id
    except Exception:  # noqa: BLE001
        logger.exception("Failed to write audit entry")
        return None


def list_entries(aura_id: Optional[str] = None, limit: int = 100) -> List[Dict]:
    init_db()
    try:
        with _connect() as conn:
            if aura_id:
                rows = conn.execute(
                    "SELECT * FROM audit_log WHERE aura_id = ? ORDER BY timestamp DESC LIMIT ?",
                    (aura_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?", (limit,)
                ).fetchall()
        return [
            {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "aura_id": r["aura_id"],
                "action": r["action"],
                "actor_role": r["actor_role"],
                "actor_id": r["actor_id"],
                "reason": r["reason"],
                "context": json.loads(r["context"] or "{}"),
            }
            for r in rows
        ]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to read audit log")
        return []


def review_status(aura_id: str) -> Dict:
    """Latest review state for a case, derived from the log itself."""
    entries = list_entries(aura_id, limit=50)
    review_actions = [
        e for e in entries
        if e["action"] in ("risk_reviewed", "follow_up_requested", "continue_monitoring")
    ]
    if not review_actions:
        return {"status": "Pending Review", "last_action": None, "last_at": None}

    latest = review_actions[0]
    label = {
        "risk_reviewed": "Reviewed",
        "follow_up_requested": "Follow-up requested",
        "continue_monitoring": "Monitoring",
    }[latest["action"]]
    return {
        "status": label,
        "last_action": latest["action"],
        "last_at": latest["timestamp"],
        "by_role": latest["actor_role"],
    }
