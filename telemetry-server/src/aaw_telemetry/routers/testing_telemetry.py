from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from ..config import ProjectRegistry, Settings
from ..logging import request_id_var
from ..schemas import (
    StepMessageData,
    TelemetrySyncRequest,
    TelemetrySyncResponse,
    TestingTelemetrySyncRequest,
)
from ..services.ingestion import IngestionService


def _to_internal(payload: TestingTelemetrySyncRequest) -> TelemetrySyncRequest:
    event = payload.event
    artifact = event.change_artifact
    # The AAW-only task-dev name remains inside the compatibility adapter.  Test CLI
    # callers use test-code-change and never need to know the legacy server shape.
    step_type = "task-dev" if artifact is not None else event.step_type
    return TelemetrySyncRequest(
        message_id=payload.message_id,
        workflow_id=payload.workflow_id,
        aaw_version=f"testing/{payload.cli_version}",
        user_email=payload.user.email,
        user_name=payload.user.name,
        repository=payload.repository,
        sr=f"testing-{payload.workflow_id}",
        started_at=payload.started_at,
        completed_at=payload.completed_at,
        updated_at=payload.updated_at,
        data=StepMessageData(
            step_id=event.step_id,
            step_type=step_type,
            step_name=event.step_name,
            attempt=event.attempt,
            execution_type="manual",
            skill_names=[],
            status=event.status,
            started_at=event.started_at,
            completed_at=event.completed_at,
            file=artifact,
            development=(
                {"test_summary": event.test_summary.model_dump()}
                if event.test_summary is not None
                else None
            ),
        ),
    )


def build_testing_telemetry_router(
    session_dependency, projects: ProjectRegistry, settings: Settings
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/testing/telemetry", tags=["testing telemetry"])

    @router.post(
        "/sync", response_model=TelemetrySyncResponse, summary="上报一条测试工作流步骤事件"
    )
    def sync(
        payload: Annotated[TestingTelemetrySyncRequest, Body(description="测试 CLI 的单步骤事件")],
        session: Session = Depends(session_dependency),
    ) -> TelemetrySyncResponse:
        return IngestionService(session, projects, settings).process(
            _to_internal(payload), request_id_var.get(), workflow_kind="testing"
        )

    return router
