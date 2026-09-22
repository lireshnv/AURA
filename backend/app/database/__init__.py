"""Database core: engine, session factory, base model.

POSTGRES-READY, SQLITE-DEFAULT
------------------------------
`DATABASE_URL` selects the backend. When it is unset the app falls back to a
local SQLite file so `uvicorn app.main:app` still starts with no server, no
credentials and no setup - which is what keeps the prototype runnable.

Set DATABASE_URL to a Postgres DSN and nothing else changes:

    DATABASE_URL=postgresql+psycopg2://user:pass@host:5432/aura

The models use portable column types only (no JSONB, no ARRAY, no Postgres
extensions), so the same schema builds on both. Where a JSON column is needed
it uses SQLAlchemy's generic JSON type, which maps to JSONB on Postgres and
TEXT on SQLite automatically.
"""
import logging
import os
from typing import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import StaticPool

# Loaded here, not just in core/config.py: this module reads DATABASE_URL
# from os.environ at IMPORT TIME (module-level, below), and some routers
# import `app.database` before anything else has imported `app.core.config`
# (whose own load_dotenv() would otherwise run too late). Safe to call
# again if core.config also calls it - python-dotenv does not override an
# already-set environment variable by default.
try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

logger = logging.getLogger("aura.database")

DEFAULT_SQLITE_PATH = os.path.join(
    os.path.expanduser("~"), ".aura", "aura_core.db"
)


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL", "").strip()
    if url:
        return url
    os.makedirs(os.path.dirname(DEFAULT_SQLITE_PATH), exist_ok=True)
    return f"sqlite:///{DEFAULT_SQLITE_PATH}"


DATABASE_URL = _database_url()
IS_SQLITE = DATABASE_URL.startswith("sqlite")

_engine_kwargs: dict = {"pool_pre_ping": True, "future": True}
if IS_SQLITE:
    # check_same_thread=False because FastAPI serves requests from a thread
    # pool; StaticPool keeps an in-memory URL usable across those threads.
    _engine_kwargs["connect_args"] = {"check_same_thread": False}
    if ":memory:" in DATABASE_URL:
        _engine_kwargs["poolclass"] = StaticPool

engine = create_engine(DATABASE_URL, **_engine_kwargs)

if IS_SQLITE:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_connection, _record):
        """SQLite ignores foreign keys unless explicitly told not to.

        Without this the FK constraints in models/ are decorative, and a
        user could be deleted while their consent rows survived.
        """
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()
else:

    @event.listens_for(engine, "connect")
    def _postgres_session_timezone(dbapi_connection, _record):
        """Pins every connection's session timezone to UTC.

        Every expiry/lockout/cooldown check in security/auth.py and the OTP
        and password-reset services compares a DB-stored timestamp against
        `datetime.now(timezone.utc)` via `.replace(tzinfo=timezone.utc)` -
        which relabels whatever wall-clock value the driver handed back as
        UTC rather than converting it. If the Postgres server (or its OS) has
        a non-UTC local timezone - as a fresh local install typically
        inherits from Windows - the driver returns timestamptz values in
        that local offset, and every one of those comparisons silently ends
        up off by the server's UTC offset. Concretely, this manifested as
        the password-reset resend cooldown treating every attempt as too
        recent forever, on a machine set to Asia/Calcutta (UTC+5:30). Forcing
        the session to UTC here, once, fixes every call site instead of
        auditing each one individually.
        """
        cursor = dbapi_connection.cursor()
        cursor.execute("SET TIME ZONE 'UTC'")
        cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    """Declarative base for all AURA ORM models."""


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding a scoped database session."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _add_missing_sqlite_columns() -> None:
    """Adds columns introduced after a table already existed on disk.

    `create_all` only creates missing TABLES, not missing COLUMNS on tables
    that already exist - so a dev SQLite file created before a model gained a
    new column would otherwise error on first use of that column. This is a
    stopgap for the SQLite dev path only; a real Postgres deployment should
    use an Alembic migration instead, not this function.
    """
    if not IS_SQLITE:
        return
    additions = {
        "profiles": [
            ("onboarding_complete", "BOOLEAN DEFAULT 0"),
            ("onboarding_data", "TEXT"),
        ],
    }
    with engine.connect() as conn:
        for table, columns in additions.items():
            existing = {
                row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            }
            for name, ddl_type in columns:
                if name not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl_type}")
                    logger.info("Added missing column %s.%s", table, name)
        conn.commit()


def init_db() -> None:
    """Creates any missing tables.

    Alembic owns schema *migrations*; this exists so a fresh checkout runs
    immediately without an `alembic upgrade head` step. On an existing
    database create_all is a no-op for tables that are already present.
    """
    from . import models  # noqa: F401  - registers models on Base.metadata

    try:
        Base.metadata.create_all(bind=engine)
        _add_missing_sqlite_columns()
        logger.info(
            "Database ready (%s)", "sqlite" if IS_SQLITE else "postgresql"
        )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to initialise database schema")


def backend_name() -> str:
    return "sqlite" if IS_SQLITE else DATABASE_URL.split("://", 1)[0]
