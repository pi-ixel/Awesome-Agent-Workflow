from __future__ import annotations

import re
import uuid
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StringConstraints,
    field_validator,
    model_validator,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


UnixMilliseconds = Annotated[StrictInt, Field(ge=0, le=253402300799999)]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]

# Step types whose completion may declare a Diff and therefore open a DevRun.
# The dev entry reuses the task-dev machinery as "dev-task-dev"; a Diff stays
# mandatory only for the original "task-dev" so older CLIs that never attach
# one to dev-task-dev keep being accepted.
DEV_RUN_STEP_TYPES = frozenset({"task-dev", "dev-task-dev"})


class StepFile(StrictModel):
    file_name: str = Field(min_length=1, max_length=255)
    sha256: Sha256

    @field_validator("file_name")
    @classmethod
    def validate_file_name(cls, value: str) -> str:
        if "/" in value or "\\" in value or value in {".", ".."}:
            raise ValueError("file_name must be a plain file name without a path")
        return value


class StepMessageData(StrictModel):
    ar: str | None = Field(default=None, min_length=1, max_length=128)
    step_id: int | None = Field(default=None, ge=1)
    step_type: str = Field(min_length=1, max_length=128)
    step_name: str | None = Field(default=None, min_length=1, max_length=256)
    attempt: int | None = Field(default=None, ge=1)
    execution_type: Literal["skill", "prompt", "manual", "noop"] | None = None
    skill_names: list[str] | None = None
    task_id: str | None = Field(default=None, min_length=1, max_length=128)
    status: Literal["start", "done", "failed", "blocked"]
    started_at: UnixMilliseconds
    completed_at: UnixMilliseconds | None
    file: StepFile | None = None
    development: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_step(self) -> StepMessageData:
        if self.status == "done" and self.completed_at is None:
            raise ValueError("data.completed_at is required when status is done")
        if self.completed_at is not None and self.completed_at < self.started_at:
            raise ValueError("data.completed_at must not be earlier than data.started_at")
        requires_file = self.step_type == "task-dev" and self.status == "done"
        allows_file = self.status == "done" and self.step_type in DEV_RUN_STEP_TYPES
        if requires_file and self.file is None:
            raise ValueError("data.file is required when task-dev is done")
        if not allows_file and self.file is not None:
            raise ValueError(
                "data.file is only allowed when a dev step "
                "(task-dev or dev-task-dev) is done"
            )
        identity = [
            self.step_id,
            self.step_name,
            self.attempt,
            self.execution_type,
            self.skill_names,
        ]
        if any(value is not None for value in identity) and any(
            value is None for value in identity
        ):
            raise ValueError(
                "data.step_id, step_name, attempt, execution_type and skill_names "
                "must be provided together"
            )
        return self


class TelemetrySyncRequest(StrictModel):
    message_id: uuid.UUID
    workflow_id: uuid.UUID
    entry: Literal["ar", "sr"] | None = None
    aaw_version: str = Field(min_length=1, max_length=64)
    user_email: str = Field(min_length=1, max_length=320)
    user_name: str
    repository: str = Field(min_length=1, max_length=128)
    sr: str = Field(min_length=1, max_length=128)
    started_at: UnixMilliseconds
    completed_at: UnixMilliseconds | None = None
    updated_at: UnixMilliseconds
    data: StepMessageData

    @field_validator("user_email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized or not re.fullmatch(r"[^@\s]+@[^@\s]+", normalized):
            raise ValueError("user_email must be a valid non-empty email address")
        return normalized

    @model_validator(mode="after")
    def validate_timeline(self) -> TelemetrySyncRequest:
        if self.data.started_at < self.started_at:
            raise ValueError("data.started_at must not be earlier than workflow started_at")
        if self.data.completed_at is not None and self.data.completed_at > self.updated_at:
            raise ValueError("data.completed_at must not be later than updated_at")
        if self.completed_at is not None:
            if self.data.completed_at is not None and self.completed_at < self.data.completed_at:
                raise ValueError("workflow completed_at must not precede data.completed_at")
            if self.completed_at < self.data.started_at:
                raise ValueError("workflow completed_at must not precede data.started_at")
            if self.completed_at > self.updated_at:
                raise ValueError("workflow completed_at must not be later than updated_at")
        return self


class TestingUser(StrictModel):
    email: str = Field(min_length=1, max_length=320)
    name: str = Field(default="", max_length=200)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not normalized or not re.fullmatch(r"[^@\s]+@[^@\s]+", normalized):
            raise ValueError("email must be a valid non-empty email address")
        return normalized


class TestSummary(StrictModel):
    cases_total: int = Field(ge=0)
    cases_passed: int = Field(ge=0)
    cases_failed: int = Field(ge=0)
    cases_blocked: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_counts(self) -> TestSummary:
        if self.cases_passed + self.cases_failed + self.cases_blocked > self.cases_total:
            raise ValueError("test case outcomes must not exceed cases_total")
        return self


class TestingChangeArtifact(StepFile):
    change_kind: Literal["test_code"] = "test_code"


class TestingEvent(StrictModel):
    step_id: int = Field(ge=1)
    step_type: str = Field(min_length=1, max_length=128)
    step_name: str = Field(min_length=1, max_length=256)
    attempt: int = Field(ge=1)
    status: Literal["start", "done", "failed", "blocked"]
    started_at: UnixMilliseconds
    completed_at: UnixMilliseconds | None = None
    test_summary: TestSummary | None = None
    change_artifact: TestingChangeArtifact | None = None

    @model_validator(mode="after")
    def validate_event(self) -> TestingEvent:
        if self.status == "done" and self.completed_at is None:
            raise ValueError("event.completed_at is required when status is done")
        if self.completed_at is not None and self.completed_at < self.started_at:
            raise ValueError("event.completed_at must not be earlier than event.started_at")
        if self.change_artifact is not None and self.status != "done":
            raise ValueError("change_artifact is only allowed when status is done")
        return self


class TestingTelemetrySyncRequest(StrictModel):
    message_id: uuid.UUID
    workflow_id: uuid.UUID
    cli_version: str = Field(min_length=1, max_length=64)
    repository: str = Field(min_length=1, max_length=128)
    user: TestingUser
    started_at: UnixMilliseconds
    completed_at: UnixMilliseconds | None = None
    updated_at: UnixMilliseconds
    event: TestingEvent


class ResultError(StrictModel):
    code: str
    message: str
    retryable: bool = False


class TelemetrySyncResponse(StrictModel):
    request_id: str
    message_id: uuid.UUID
    status: Literal["accepted", "duplicate", "rejected"]
    server_updated_at: int | None = None
    error: ResultError | None = None


class ErrorResponse(StrictModel):
    request_id: str
    code: str
    message: str
    retryable: bool


class ClientReleaseResponse(StrictModel):
    latest_version: str | None = None
    file_name: str | None = None
    size_bytes: int | None = None
    released_at: str | None = None


class DiffUploadResponse(StrictModel):
    request_id: str
    message_id: uuid.UUID
    status: Literal["confirmed"]
    object_key: str
    sha256: Sha256
    confirmed_at: int


IssueAssignee = Literal["张轶勃", "徐哲威", "宋东方", "张立肖", "孙杨宇鑫"]
IssueStatus = Literal["todo", "in_progress", "resolved"]
IssuePriority = Literal["low", "medium", "high"]


class IssueTextNode(StrictModel):
    type: Literal["text"]
    text: str = Field(max_length=10_000)


class IssueImageNode(StrictModel):
    type: Literal["image"]
    image_id: uuid.UUID
    alt: str = Field(min_length=1, max_length=100)

    @field_validator("alt")
    @classmethod
    def strip_alt(cls, value: str) -> str:
        return value.strip()


IssueDescriptionNode = Annotated[
    IssueTextNode | IssueImageNode,
    Field(discriminator="type"),
]


class IssueDescriptionDocument(StrictModel):
    version: Literal[1] = 1
    nodes: list[IssueDescriptionNode] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_document_limits(self) -> IssueDescriptionDocument:
        text = "".join(node.text for node in self.nodes if isinstance(node, IssueTextNode))
        if len(text) > 10_000:
            raise ValueError("visible description text exceeds 10000 characters")
        image_ids = [
            node.image_id for node in self.nodes if isinstance(node, IssueImageNode)
        ]
        if len(image_ids) > 10:
            raise ValueError("description contains more than 10 images")
        if len(image_ids) != len(set(image_ids)):
            raise ValueError("the same image cannot appear more than once")
        return self


def issue_document_text(document: IssueDescriptionDocument) -> str:
    return "".join(
        node.text for node in document.nodes if isinstance(node, IssueTextNode)
    ).strip()


def issue_document_image_ids(document: IssueDescriptionDocument | None) -> list[uuid.UUID]:
    if document is None:
        return []
    return [
        node.image_id for node in document.nodes if isinstance(node, IssueImageNode)
    ]


class IssueCreate(StrictModel):
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(max_length=10_000)
    reporter: str = Field(min_length=1, max_length=100)
    assignee: IssueAssignee
    priority: IssuePriority = "medium"
    status: IssueStatus = "todo"
    component: str | None = Field(default=None, max_length=128)
    workflow_run_id: uuid.UUID | None = None
    sr: str | None = Field(default=None, max_length=128)
    ar: str | None = Field(default=None, max_length=128)
    description_doc: IssueDescriptionDocument | None = None

    @field_validator("title", "reporter")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("description")
    @classmethod
    def strip_description(cls, value: str) -> str:
        return value.strip()

    @field_validator("component", "sr", "ar")
    @classmethod
    def strip_optional_text(cls, value: str | None) -> str | None:
        return value.strip() if value and value.strip() else None

    @model_validator(mode="after")
    def validate_description_document(self) -> IssueCreate:
        if self.description_doc is None:
            if not self.description:
                raise ValueError("description must contain text or an image")
        elif issue_document_text(self.description_doc) != self.description:
            raise ValueError("description must match the visible text in description_doc")
        elif not self.description and not issue_document_image_ids(self.description_doc):
            raise ValueError("description must contain text or an image")
        return self


class IssueUpdate(StrictModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=10_000)
    reporter: str | None = Field(default=None, min_length=1, max_length=100)
    assignee: IssueAssignee | None = None
    priority: IssuePriority | None = None
    status: IssueStatus | None = None
    component: str | None = Field(default=None, max_length=128)
    workflow_run_id: uuid.UUID | None = None
    sr: str | None = Field(default=None, max_length=128)
    ar: str | None = Field(default=None, max_length=128)
    description_doc: IssueDescriptionDocument | None = None
    version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def require_change(self) -> IssueUpdate:
        if not self.model_fields_set:
            raise ValueError("at least one field is required")
        return self

    @field_validator("title", "reporter")
    @classmethod
    def strip_updated_required_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("description")
    @classmethod
    def strip_updated_description(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("component", "sr", "ar")
    @classmethod
    def strip_updated_optional_text(cls, value: str | None) -> str | None:
        return value.strip() if value and value.strip() else None

    @model_validator(mode="after")
    def validate_description_document(self) -> IssueUpdate:
        if self.description_doc is not None:
            if self.description is None:
                raise ValueError("description is required with description_doc")
            if issue_document_text(self.description_doc) != self.description:
                raise ValueError("description must match the visible text in description_doc")
            if not self.description and not issue_document_image_ids(self.description_doc):
                raise ValueError("description must contain text or an image")
        elif "description" in self.model_fields_set and self.description == "":
            raise ValueError("description must contain text or an image")
        return self
