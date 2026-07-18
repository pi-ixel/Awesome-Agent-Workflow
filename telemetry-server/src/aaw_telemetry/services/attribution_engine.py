"""Attribution engine abstraction for actual code-attribution calculation."""

from __future__ import annotations

import abc


class AttributionEngine(abc.ABC):
    """Calculate attribution for a Diff without owning task orchestration."""

    @abc.abstractmethod
    def run(
        self,
        dev_run,
        diff_bytes: bytes,
        project_entry,
        message,
    ) -> dict:
        """Return values that can be applied to a CodeAttribution row."""
