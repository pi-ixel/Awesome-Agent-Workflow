from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from datetime import UTC

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from ..config import Settings
from ..errors import ApiError
from ..logging import request_id_var
from ..schemas import DiffUploadResponse
from ..services.objects import ObjectService

logger = logging.getLogger("aaw_telemetry.objects.diff")


def _milliseconds(value) -> int:
    aware = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return int(aware.timestamp() * 1000)


def build_objects_router(
    session_dependency,
    settings: Settings,
    attribution_notifier: Callable[[], None] | None = None,
    *,
    prefix: str = "/api/v1/objects",
    workflow_kind: str = "aaw",
    diff_path: str = "/step-diffs/{message_id}",
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["objects"])

    @router.put(
        diff_path,
        response_model=DiffUploadResponse,
        summary="上传并确认开发步骤的 Git Diff",
        description=(
            "`message_id` 必须对应已接受的 `task-dev + done` Step。请求体是原始 Git "
            "Diff 字节；服务端使用 Step 中声明的 SHA-256 校验内容，并在成功后完成落盘、"
            "Dev 状态更新和归因。客户端不需要上传会话、文件大小或单独确认。"
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
        try:
            upload = await ObjectService(
                session,
                settings,
                attribution_notifier,
            ).upload_diff(message_id, request.stream(), workflow_kind=workflow_kind)
        except ApiError as exc:
            logger.warning(
                "Dev Patch 上传或校验失败，文件未确认",
                extra={
                    "event": "objects.upload_failed",
                    "message_id": str(message_id),
                    "error_code": exc.code,
                    "status_code": exc.status_code,
                    "retryable": exc.retryable,
                },
            )
            raise
        except Exception:
            logger.exception(
                "处理 Dev Patch 时发生未预期异常",
                extra={
                    "event": "objects.upload_failed",
                    "message_id": str(message_id),
                    "error_code": "INTERNAL_ERROR",
                    "status_code": 500,
                    "retryable": True,
                },
            )
            raise
        return DiffUploadResponse(
            request_id=request_id_var.get(),
            message_id=upload.owner_id,
            status="confirmed",
            object_key=upload.object_key,
            sha256=upload.sha256,
            confirmed_at=_milliseconds(upload.confirmed_at),
        )

    return router
