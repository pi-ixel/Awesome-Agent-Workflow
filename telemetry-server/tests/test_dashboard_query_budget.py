from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from aaw_telemetry.database import Base
from aaw_telemetry.services.queries import QueryService, make_filters
from tools.profile_dashboard_queries import _profile, _projects, _seed


@pytest.mark.parametrize("workflow_count", [5, 40])
def test_dashboard_query_count_does_not_grow_with_workflows(workflow_count):
    engine = create_engine(
        "sqlite+pysqlite://",
        poolclass=StaticPool,
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    _seed(engine, workflow_count)
    today = datetime.now(UTC).date()
    filters = make_filters(today - timedelta(days=30), today, [], [], [], [], [])

    try:
        overview = _profile(
            engine,
            _projects(),
            QueryService,
            "overview",
            lambda service: service.overview(filters),
        )
        workflows = _profile(
            engine,
            _projects(),
            QueryService,
            "workflows",
            lambda service: service.workflows(filters, None, 1, 50),
        )
    finally:
        engine.dispose()

    assert overview["sql_statements"] <= 5
    assert workflows["sql_statements"] <= 5
