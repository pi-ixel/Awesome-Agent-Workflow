"""HTTP boundary between the telemetry backend and attribution service."""

from __future__ import annotations

import abc

from aaw_contracts import (
    CONTRACT_VERSION,
    AttributionRequest,
    AttributionResult,
    DevelopmentContext,
    DiffPayload,
    ProjectContext,
    TelemetryContext,
)


class AttributionServiceError(RuntimeError):
    """A remote attribution call failed or returned an invalid contract."""


class AttributionService(abc.ABC):
    @abc.abstractmethod
    def attribute(self, request: AttributionRequest) -> AttributionResult:
        """Calculate attribution without accessing telemetry persistence."""


__all__ = [
    "CONTRACT_VERSION",
    "AttributionRequest",
    "AttributionResult",
    "AttributionService",
    "AttributionServiceError",
    "DevelopmentContext",
    "DiffPayload",
    "ProjectContext",
    "TelemetryContext",
]
