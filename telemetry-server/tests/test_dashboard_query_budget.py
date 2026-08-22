from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool

from aaw_telemetry.database import Base
from aaw_telemetry.services.queries import QueryService, make_filters
from tools.profile_dashboard_queries import _dashboard_calls, _profile, _projects, _seed

SQL_BUDGETS = {
    "filter-options": 3,
    "overview": 7,
    "trends": 6,
    "projects": 6,
    "users": 6,
    "components": 7,
    "steps": 3,
    "workflows": 7,
}
FULL_PAGE_SQL_BUDGET = 40


@pytest.mark.parametrize("workflow_count", [10, 1000])
def test_all_dashboard_endpoints_and_full_refresh_stay_within_sql_budget(
    workflow_count,
):
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
        results = {
            name: _profile(engine, _projects(), QueryService, name, call)[
                "sql_statements"
            ]
            for name, call in _dashboard_calls(filters)
        }
    finally:
        engine.dispose()

    assert results.keys() == SQL_BUDGETS.keys()
    for endpoint, sql_count in results.items():
        assert sql_count <= SQL_BUDGETS[endpoint], (
            f"{endpoint} executed {sql_count} SQL statements; "
            f"budget is {SQL_BUDGETS[endpoint]}"
        )
    assert sum(results.values()) <= FULL_PAGE_SQL_BUDGET, (
        f"full dashboard refresh executed {sum(results.values())} SQL statements; "
        f"budget is {FULL_PAGE_SQL_BUDGET}"
    )
