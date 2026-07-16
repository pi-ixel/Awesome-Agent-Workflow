from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..logging import request_id_var
from ..schemas import TelemetrySyncRequest, TelemetrySyncResponse
from ..services.ingestion import IngestionService

SYNC_DESCRIPTION = """
一个请求上报一个已经结束的 Step。消息体结构固定，不使用数组、`record_type` 或多态 `data`。

- `message_id`：本条消息的幂等键；原样重试必须复用。
- `workflow_id`：工作流聚合键；同一工作流允许多个人上报。
- `user_email`：人员唯一键；`user_name` 是展示值，服务端不校验其格式。
- `repository`、`sr`、外层 `started_at`：同一工作流内必须一致。
- `updated_at`：本条消息产生时间，不是服务器收到请求的时间。
- `data`：当前 Step；`ar` 位于这里，一个请求只包含一个 Step。
- `data.file`：仅 `task-dev + done` 必填，包含 Diff 文件名和原始字节 SHA-256。

所有时间字段均为 Unix 毫秒整数。首次合法消息返回 `accepted`；相同消息重试返回
`duplicate`；同一 `message_id` 对应不同内容返回 HTTP 409 `MESSAGE_CONFLICT`。
"""

SYNC_EXAMPLES = {
    "task-dev 完成": {
        "summary": "上报完成的开发步骤并声明待上传 Diff",
        "value": {
            "message_id": "22222222-2222-4222-8222-222222222222",
            "workflow_id": "11111111-1111-4111-8111-111111111111",
            "aaw_version": "0.1.0",
            "user_email": "developer@example.com",
            "user_name": "Z30049429",
            "repository": "team/example-service",
            "sr": "SR-1001",
            "started_at": 1784163660000,
            "completed_at": 1784165400000,
            "updated_at": 1784165400000,
            "data": {
                "ar": "AR-2001",
                "step_type": "task-dev",
                "status": "done",
                "started_at": 1784163660000,
                "completed_at": 1784165400000,
                "file": {
                    "file_name": "SR-1001-AR-2001.diff",
                    "sha256": "0123456789abcdef" * 4,
                },
            },
        },
    }
}


def build_telemetry_router(
    session_dependency,
    projects: ProjectRegistry,
    settings: Settings,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/telemetry", tags=["telemetry"])

    @router.post(
        "/sync",
        response_model=TelemetrySyncResponse,
        summary="上报一条终态 Step 消息",
        description=SYNC_DESCRIPTION,
        response_description="消息接收或幂等重试结果。",
    )
    def sync(
        payload: Annotated[
            TelemetrySyncRequest,
            Body(
                description="固定结构的单 Step 上报消息。",
                openapi_examples=SYNC_EXAMPLES,
            ),
        ],
        session: Session = Depends(session_dependency),
    ) -> TelemetrySyncResponse:
        return IngestionService(session, projects, settings).process(
            payload, request_id_var.get()
        )

    return router
