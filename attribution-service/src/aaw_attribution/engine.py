"""Engine extension point and the public-repository mock implementation."""

from __future__ import annotations

import abc
from datetime import UTC, datetime

from .contracts import AttributionRequest, AttributionResult


class AttributionEngine(abc.ABC):
    @abc.abstractmethod
    def attribute(self, request: AttributionRequest) -> AttributionResult:
        """Return a contract result without depending on backend persistence."""


class MockAttributionEngine(AttributionEngine):
    def attribute(self, request: AttributionRequest) -> AttributionResult:
        total = int(request.diff.statistics.get("total_effective_lines", 0))
        attributed_60 = min(total, max(1, (total * 90) // 100)) if total else 0
        attributed_80 = min(total, max(1, (total * 80) // 100)) if total else 0
        attributed_90 = min(attributed_80, (total * 60) // 100)
        has_match = attributed_80 > 0
        mock_iid = str((request.request_id.int % 900_000) + 100_000) if has_match else None
        return AttributionResult(
            request_id=request.request_id,
            result_status="finalized_match" if has_match else "finalized_no_match",
            dev_effective_lines=total,
            attributed_lines_60=attributed_60,
            attributed_lines_80=attributed_80,
            attributed_lines_90=attributed_90,
            confidence=0.8 if has_match else 0.0,
            quality_flags=["mock_attribution", "external_service"],
            matched_mr_iid=mock_iid,
            matched_mr_url=(
                f"https://example.invalid/mock/merge_requests/{mock_iid}"
                if mock_iid
                else None
            ),
            mr_diff_version="mock-1" if has_match else None,
            target_branch=request.project.target_branch,
            mr_merged_at=request.development.completed_at if has_match else None,
            algorithm_version="mock-v1",
            diff_rule_version="unified-diff-additions-v1",
            matched_at=datetime.now(UTC),
        )
