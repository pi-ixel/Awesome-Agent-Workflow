"""Attribution service abstraction for dependency inversion.

High-level modules depend on this interface. The GitHub build injects
MockAttributionService, while intranet deployments may inject a real service.
"""

from __future__ import annotations

import abc
from datetime import datetime

from sqlalchemy.orm import Session

from ..models import DevRun


class AttributionService(abc.ABC):
    """Define attribution behavior after Diff confirmation and during retries."""

    @abc.abstractmethod
    def on_diff_confirmed(
        self,
        session: Session,
        dev_run: DevRun,
        now: datetime,
    ) -> None:
        """Trigger attribution after a Diff has been confirmed."""

    @abc.abstractmethod
    def start_retry_scheduler(self, settings, projects) -> None:
        """Start retry scheduling when the concrete service requires it."""
