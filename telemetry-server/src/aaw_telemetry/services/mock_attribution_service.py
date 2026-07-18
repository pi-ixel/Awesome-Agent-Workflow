"""Mock 归因服务 —— GitHub 开源版本使用。

diff 上传后直接写入 mock 归因结果（同步），
补跑调度器为 no-op。
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy.orm import Session

from ..models import DevRun
from .attribution_service import AttributionService

logger = logging.getLogger("aaw_telemetry.attribution")


class MockAttributionService(AttributionService):
    """Mock 归因服务：同步写入确定性 mock 归因结果。"""

    def on_diff_confirmed(
        self,
        session: Session,
        dev_run: DevRun,
        now: datetime,
    ) -> None:
        total = (
            int(dev_run.code_statistics["total_effective_lines"])
            if dev_run.code_statistics
            else 0
        )
        attributed_80 = min(total, max(1, (total * 80) // 100)) if total else 0
        attributed_90 = min(attributed_80, (total * 60) // 100)
        has_match = attributed_80 > 0
        mock_iid = str((dev_run.id.int % 900_000) + 100_000) if has_match else None

        values = {
            "dev_effective_lines": total,
            "attributed_lines_80": attributed_80,
            "attributed_lines_90": attributed_90,
            "confidence": 0.8 if has_match else 0.0,
            "quality_flags": ["mock_attribution"],
            "result_status": "finalized_match" if has_match else "finalized_no_match",
            "attribution_status": (
                "finalized_match" if has_match else "finalized_no_match"
            ),
            "matched_mr_iid": mock_iid,
            "matched_mr_url": (
                f"https://example.invalid/mock/merge_requests/{mock_iid}"
                if mock_iid
                else None
            ),
            "mr_diff_version": "mock-1" if has_match else None,
            "mr_source_branch": None,
            "target_branch": None,
            "merge_commit_sha": None,
            "mr_merged_at": dev_run.completed_at if has_match else None,
            "algorithm_version": "mock-v1",
            "diff_rule_version": "unified-diff-additions-v1",
            "matched_at": now,
            "server_updated_at": now,
        }
        if dev_run.attribution is None:
            from ..models import CodeAttribution

            dev_run.attribution = CodeAttribution(dev_run_id=dev_run.id, **values)
        else:
            for field, value in values.items():
                setattr(dev_run.attribution, field, value)
        logger.info(
            "mock_attribution: written, dev_run_id=%s, has_match=%s",
            dev_run.id,
            has_match,
        )

    def start_retry_scheduler(self, settings, projects) -> None:
        logger.info("mock_attribution: retry scheduler skipped (no-op)")
