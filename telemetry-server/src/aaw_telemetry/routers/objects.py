from __future__ import annotations

import uuid
from datetime import UTC

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..logging import request_id_var
from ..schemas import DiffUploadResponse
from ..services.objects import ObjectService


def _milliseconds(value) -> int:
    aware = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return int(aware.timestamp() * 1000)


def build_objects_router(
    session_dependency,
    settings: Settings,
    projects: ProjectRegistry,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/objects", tags=["objects"])

    @router.put(
        "/step-diffs/{message_id}",
        response_model=DiffUploadResponse,
        summary="上传并确认开发步骤的 Git Diff",
        description=(
            "`message_id` 必须对应已接受的 `task-dev + done` Step。请求体是原始 Git "
            "Diff 字节；服务端使用 Step 中声明的 SHA-256 校验内容，并在成功后完成落盘、"
            "Dev 状态更新和 Mock 归因。客户端不需要上传会话、文件大小或单独确认。"
        ),
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "application/octet-stream": {
                        "schema": {"type": "string", "format": "binary"}
                    }
                },
            }
        },
    )
    async def upload_diff(
        message_id: uuid.UUID,
        request: Request,
        session: Session = Depends(session_dependency),
    ) -> DiffUploadResponse:
        upload = await ObjectService(session, settings, projects).upload_diff(
            message_id, request.stream()
        )
        return DiffUploadResponse(
            request_id=request_id_var.get(),
            message_id=upload.owner_id,
            status="confirmed",
            object_key=upload.object_key,
            sha256=upload.sha256,
            confirmed_at=_milliseconds(upload.confirmed_at),
        )

    return router
