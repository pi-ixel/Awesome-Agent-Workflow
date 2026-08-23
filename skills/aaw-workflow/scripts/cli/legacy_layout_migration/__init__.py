"""Temporary, removable legacy artifact-layout migration boundary."""

from .detector import format_layout_notice, migration_notice, requires_migration
from .executor import MigrationExecutionError, execute_plan
from .planner import MigrationPlan, build_plan

__all__ = [
    "MigrationExecutionError",
    "MigrationPlan",
    "build_plan",
    "execute_plan",
    "format_layout_notice",
    "migration_notice",
    "requires_migration",
]
