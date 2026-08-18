from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import Settings


class Base(DeclarativeBase):
    pass


def build_engine(settings: Settings):
    assert settings.database_url is not None
    pool_options = {}
    if make_url(settings.database_url).get_backend_name() != "sqlite":
        pool_options = {
            "pool_size": settings.database_pool_size,
            "max_overflow": settings.database_max_overflow,
            "pool_timeout": settings.database_pool_timeout_seconds,
        }
    return create_engine(settings.database_url, pool_pre_ping=True, **pool_options)


def build_session_factory(engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def session_dependency(factory: sessionmaker[Session]):
    def dependency() -> Generator[Session, None, None]:
        with factory() as session:
            yield session

    return dependency
