"""本地演示用 mock 归因引擎。

实现归因契约（contracts/src/aaw_contracts/attribution.py）：
POST /api/v1/attributions 接收 AttributionRequest，返回 AttributionResult。

行为设计（便于演示遥测管理台的各种归因状态）：
- diff 有新增有效行          → finalized_match：三档行数、置信度、MR 信息齐全
- AR 号包含 "NOMATCH"        → finalized_no_match（即使有新增行，用于演示未匹配与无关化口径）
- AR 号包含 "FAIL"           → 返回 500，模拟引擎异常（产生失败/退避重试记录）
- POST /control/fail_next?n= → 接下来 n 次归因返回 500（演示引擎故障后批量恢复）

启动：uvicorn tools.mock_engine:app --port 8010
"""

from __future__ import annotations

import threading
import uuid
from datetime import UTC, datetime, timedelta

from aaw_contracts import AttributionRequest, AttributionResult
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse

app = FastAPI(title="AAW Mock Attribution Engine", version="0.1.0")

_fail_next_lock = threading.Lock()
_fail_next = 0


def _count_added_lines(diff_bytes: bytes) -> int:
    return sum(
        1
        for line in diff_bytes.decode("utf-8", errors="replace").splitlines()
        if line.startswith("+") and not line.startswith("+++") and line[1:].strip()
    )


@app.get("/", include_in_schema=False)
def home():
    return RedirectResponse("/docs")


@app.post("/control/fail_next")
def fail_next(n: int = Query(ge=0, le=1000)):
    """让接下来 n 次归因请求返回 500，模拟引擎故障。"""
    global _fail_next
    with _fail_next_lock:
        _fail_next = n
    return {"fail_next": n}


@app.post("/api/v1/attributions")
def attribute(request: AttributionRequest) -> AttributionResult:
    global _fail_next
    with _fail_next_lock:
        should_fail = _fail_next > 0
        if should_fail:
            _fail_next -= 1
    if should_fail or "FAIL" in (request.telemetry.ar or ""):
        raise HTTPException(status_code=500, detail="mock engine injected failure")

    diff_bytes = request.diff.decode_and_verify()
    effective = int(request.diff.statistics.get("total_effective_lines") or 0) or (
        _count_added_lines(diff_bytes)
    )
    now = datetime.now(UTC).replace(microsecond=0)
    ar = request.telemetry.ar

    if effective <= 0 or (ar and "NOMATCH" in ar):
        return AttributionResult(
            request_id=request.request_id,
            result_status="finalized_no_match",
            dev_effective_lines=max(effective, 0),
            attributed_lines_60=0 if effective else None,
            attributed_lines_80=0,
            attributed_lines_90=0,
            mr_commit_lines=0 if effective else None,
            confidence=0.0,
            quality_flags=["mock_attribution", "external_service"],
            matched_mr_iid=None,
            matched_mr_url=None,
            mr_diff_version=None,
            mr_source_branch=request.development.branch,
            target_branch=request.project.target_branch,
            merge_commit_sha=None,
            mr_merged_at=None,
            algorithm_version="mock-v1",
            diff_rule_version="unified-diff-additions-v1",
            matched_at=now,
        )

    # Deterministic pseudo-randomness from request_id so demo data is stable.
    seed = request.request_id.int
    confidence = round(0.62 + (seed % 33) / 100, 4)          # 0.62 ~ 0.94
    attributed_80 = max(1, round(effective * (0.55 + (seed % 40) / 100)))
    attributed_80 = min(attributed_80, effective)
    attributed_90 = max(1, round(attributed_80 * 0.6))
    attributed_60 = min(effective, max(attributed_80, round(attributed_80 * 1.25)))
    iid = str(seed % 900 + 100)
    completed_at = request.development.completed_at
    if completed_at is not None and completed_at.tzinfo is None:
        completed_at = completed_at.replace(tzinfo=UTC)
    merged_at = (completed_at or (now - timedelta(days=1))) + timedelta(
        hours=2 + (seed % 48)
    )
    if merged_at > now:
        merged_at = now - timedelta(hours=1)
    return AttributionResult(
        request_id=request.request_id,
        result_status="finalized_match",
        dev_effective_lines=effective,
        attributed_lines_60=attributed_60,
        attributed_lines_80=attributed_80,
        attributed_lines_90=attributed_90,
        mr_commit_lines=effective * 2 + (seed % 15),
        confidence=confidence,
        quality_flags=["mock_attribution", "external_service"],
        matched_mr_iid=iid,
        matched_mr_url=(
            f"https://git.example.invalid/{request.telemetry.repository}"
            f"/-/merge_requests/{iid}"
        ),
        mr_diff_version=f"diff-v{seed % 3 + 1}",
        mr_source_branch=request.development.branch,
        target_branch=request.project.target_branch,
        merge_commit_sha=uuid.UUID(int=seed).hex[:40],
        mr_merged_at=merged_at,
        algorithm_version="mock-v1",
        diff_rule_version="unified-diff-additions-v1",
        matched_at=now,
    )
