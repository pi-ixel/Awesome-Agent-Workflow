from __future__ import annotations

import random
import time
from collections.abc import Callable, Generator
from typing import TypeVar

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import Settings

T = TypeVar("T")

# SQLite raises these as OperationalError when another writer holds the
# database past the driver busy timeout. Pair-parallel execution has two
# writer threads plus the API, so writes retry a bounded number of times
# with exponential backoff and jitter instead of failing the run.
LOCK_ERROR_MARKERS = ("database is locked", "database table is locked", "database is busy")

LOCK_RETRY_ATTEMPTS = 8
LOCK_RETRY_INITIAL_DELAY_SECONDS = 0.05
LOCK_RETRY_MAX_DELAY_SECONDS = 0.8


class Base(DeclarativeBase):
    pass


def build_engine(settings: Settings):
    settings.ensure_directories()
    engine = create_engine(
        settings.database_url,
        connect_args={"check_same_thread": False, "timeout": 30},
        pool_pre_ping=True,
    )

    @event.listens_for(engine, "connect")
    def configure_sqlite(dbapi_connection, _):
        dbapi_connection.execute("PRAGMA foreign_keys=ON")
        dbapi_connection.execute("PRAGMA journal_mode=WAL")

    return engine


def build_session_factory(engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def is_locked_error(exc: BaseException) -> bool:
    if not isinstance(exc, OperationalError):
        return False
    message = str(exc).lower()
    return any(marker in message for marker in LOCK_ERROR_MARKERS)


def with_lock_retry(
    operation: Callable[[], T],
    *,
    attempts: int = LOCK_RETRY_ATTEMPTS,
    initial_delay: float = LOCK_RETRY_INITIAL_DELAY_SECONDS,
    max_delay: float = LOCK_RETRY_MAX_DELAY_SECONDS,
) -> T:
    """Run a database operation with bounded retry on SQLite lock errors.

    The callable must be idempotent from a clean state: a failed transaction
    is rolled back by SQLite itself, so re-running it on a fresh session is
    safe. Non-lock errors propagate immediately.
    """
    for attempt in range(attempts):
        try:
            return operation()
        except OperationalError as exc:
            if not is_locked_error(exc) or attempt == attempts - 1:
                raise
            delay = min(initial_delay * (2**attempt), max_delay)
            time.sleep(delay * (0.5 + random.random()))
    raise AssertionError("unreachable")  # pragma: no cover - loop always returns or raises


def migrate_schema(engine) -> None:
    additions = {
        "experiments": {
            "cancel_requested_at": "DATETIME",
            "retry_of_experiment_id": "VARCHAR(36) REFERENCES experiments(id)",
            "execution_mode": "VARCHAR(32)",
            "concurrency_limit": "INTEGER",
        },
        "runs": {
            "current_stage": "VARCHAR(64)",
            "stage_started_at": "DATETIME",
            "last_heartbeat_at": "DATETIME",
            "last_activity_at": "DATETIME",
            "cancel_requested_at": "DATETIME",
            "current_attempt": "INTEGER NOT NULL DEFAULT 1",
            "pair_id": "VARCHAR(160)",
            "pair_launch_skew_ms": "INTEGER",
        },
    }
    with engine.begin() as connection:
        schema = inspect(connection)
        for table_name, columns in additions.items():
            if not schema.has_table(table_name):
                continue
            existing = {column["name"] for column in schema.get_columns(table_name)}
            for name, definition in columns.items():
                if name not in existing:
                    connection.execute(
                        text(f'ALTER TABLE "{table_name}" ADD COLUMN "{name}" {definition}')
                    )
        if schema.has_table("experiments"):
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_experiments_retry_of_experiment_id "
                    "ON experiments (retry_of_experiment_id)"
                )
            )
        if schema.has_table("runs"):
            connection.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_runs_pair_id "
                    "ON runs (pair_id)"
                )
            )


def session_dependency(factory: sessionmaker[Session]):
    def dependency() -> Generator[Session, None, None]:
        with factory() as session:
            yield session

    return dependency
