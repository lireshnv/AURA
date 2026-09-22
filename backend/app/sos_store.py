"""Storage for real SOS events triggered from the AURA SOS button.

Append-only, same rule as `audit_store.py`: an SOS log that could be edited
or backfilled is not trustworthy. Only what was actually sent is recorded -
no fabricated contacts, locations, or demo events ever get written here.
Location is stored only when the browser actually granted it for that
specific click; it is never guessed or defaulted.
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

logger = logging.getLogger("aura.sos_store")

DB_PATH = Path(os.environ.get("AURA_SOS_DB_PATH", Path.home() / ".aura" / "aura_sos.db"))

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
                    """CREATE TABLE IF NOT EXISTS sos_events (
                        id          TEXT PRIMARY KEY,
                        aura_id     TEXT NOT NULL,
                        timestamp   TEXT NOT NULL,
                        latitude    REAL,
                        longitude   REAL,
                        page        TEXT
                    )"""
                )
                conn.execute("CREATE INDEX IF NOT EXISTS idx_sos_aura ON sos_events (aura_id)")
            _initialized = True
            logger.info("SOS event store ready at %s", DB_PATH)
        except Exception:  # noqa: BLE001
            logger.exception("Failed to initialise SOS event store")


def record_event(
    aura_id: str,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    page: Optional[str] = None,
) -> Optional[Dict]:
    """Records one real SOS trigger. Returns the stored event, or None on
    failure - the caller must report that honestly as "failed", never as sent."""
    init_db()
    event_id = str(uuid.uuid4())
    timestamp = datetime.now(timezone.utc).isoformat()
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO sos_events (id, aura_id, timestamp, latitude, longitude, page) "
                "VALUES (?,?,?,?,?,?)",
                (event_id, aura_id, timestamp, latitude, longitude, page),
            )
        return {
            "id": event_id,
            "timestamp": timestamp,
            "has_location": latitude is not None and longitude is not None,
        }
    except Exception:  # noqa: BLE001
        logger.exception("Failed to record SOS event")
        return None


def list_events(aura_id: str, limit: int = 50) -> List[Dict]:
    init_db()
    try:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT * FROM sos_events WHERE aura_id = ? ORDER BY timestamp DESC LIMIT ?",
                (aura_id, limit),
            ).fetchall()
        return [
            {
                "id": r["id"],
                "timestamp": r["timestamp"],
                "has_location": r["latitude"] is not None and r["longitude"] is not None,
                "page": r["page"],
            }
            for r in rows
        ]
    except Exception:  # noqa: BLE001
        logger.exception("Failed to read SOS event log")
        return []
