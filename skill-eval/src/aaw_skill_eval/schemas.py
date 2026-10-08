from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class FollowupSpec(BaseModel):
    when_output_contains: str = Field(min_length=1, max_length=500)
    reply: str = Field(min_length=1, max_length=20_000)


class GraderSpec(BaseModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$")
    type: Literal["command", "file_exists", "forbidden_changes", "llm_rubric"]
    name: str = Field(min_length=1, max_length=160)
    weight: float = Field(default=0, ge=0, le=1000)
    hard_gate: bool = False
    command: str | None = Field(default=None, max_length=4000)
    path: str | None = Field(default=None, max_length=1000)
    patterns: list[str] = Field(default_factory=list, max_length=100)
    rubric: str | None = Field(default=None, max_length=30_000)
    timeout_seconds: int = Field(default=300, ge=1, le=7200)

    @model_validator(mode="after")
    def validate_type_fields(self):
        if self.type == "command" and not self.command:
            raise ValueError("command grader requires command")
        if self.type == "file_exists" and not self.path:
            raise ValueError("file_exists grader requires path")
        if self.type == "forbidden_changes" and not self.patterns:
            raise ValueError("forbidden_changes grader requires patterns")
        if self.type == "llm_rubric" and not self.rubric:
            raise ValueError("llm_rubric grader requires rubric")
        if not self.hard_gate and self.weight <= 0:
            raise ValueError("quality grader weight must be greater than zero")
        return self


class SetupSpec(BaseModel):
    commands: list[str] = Field(default_factory=list, max_length=30)
    preflight: list[str] = Field(default_factory=list, max_length=30)
    network: bool = False
    timeout_seconds: int = Field(default=900, ge=1, le=7200)


class TimeScoringSpec(BaseModel):
    """执行时间计分（可选）：run 总耗时 ≤target_seconds 得满分，≥limit_seconds 得零分，中间线性。"""

    target_seconds: int = Field(ge=1, le=86_400)
    limit_seconds: int = Field(ge=1, le=86_400)
    weight: float = Field(default=10, gt=0, le=1000)

    @model_validator(mode="after")
    def validate_window(self):
        if self.limit_seconds <= self.target_seconds:
            raise ValueError("limit_seconds must be greater than target_seconds")
        return self


class CaseSpec(BaseModel):
    id: str = Field(pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$")
    name: str = Field(min_length=1, max_length=200)
    input: str = Field(min_length=1, max_length=50_000)
    expected: str = Field(min_length=1, max_length=50_000)
    weight: float = Field(default=1, gt=0, le=1000)
    agent_context: str = Field(default="", max_length=50_000)
    followups: list[FollowupSpec] = Field(default_factory=list, max_length=20)
    max_turns: int = Field(default=6, ge=1, le=30)
    graders: list[GraderSpec] = Field(min_length=1, max_length=50)
    time_scoring: TimeScoringSpec | None = None


class ProviderSnapshot(BaseModel):
    provider: Literal["codex", "chrys"]
    runtime_version: str | None = None
    model_profile_id: str
    model_profile_name: str | None = None
    model_id: str | None = None
    model_provider: str | None = None
    api_style: str | None = None
    config_hash: str | None = None
    agent_profile: str | None = None
    agent_profile_hash: str | None = None
    isolation: Literal["workspace-write", "read-only", "soft", "unknown"] = "unknown"
    network_policy: Literal["disabled", "enabled", "uncontrolled"] = "disabled"
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvalProfile(BaseModel):
    schema_version: int = Field(default=2, ge=1, le=2)
    name: str = Field(default="codex-standard", min_length=1, max_length=120)
    runner_provider: Literal["codex", "chrys"] = "codex"
    runner_model: str = Field(min_length=1, max_length=160)
    runner_reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh"] = "high"
    judge_provider: Literal["codex", "chrys"] = "codex"
    judge_model: str = Field(min_length=1, max_length=160)
    judge_reasoning_effort: Literal["none", "minimal", "low", "medium", "high", "xhigh"] = "high"
    timeout_seconds: int = Field(default=1800, ge=30, le=14_400)
    network: bool = False
    allowed_mcp_servers: list[str] = Field(default_factory=list, max_length=50)
    runner_snapshot: ProviderSnapshot | None = None
    judge_snapshot: ProviderSnapshot | None = None


class RubricDraftRequest(BaseModel):
    project_path: str = Field(min_length=1, max_length=2000)
    skill_path: str = Field(min_length=1, max_length=2000)
    input: str = Field(min_length=1, max_length=50_000)
    expected: str = Field(min_length=1, max_length=50_000)


class RubricDraftResponse(BaseModel):
    project: dict
    skill: dict
    case: CaseSpec


class SuiteCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    project_path: str = Field(min_length=1, max_length=2000)
    skill_path: str = Field(min_length=1, max_length=2000)
    setup: SetupSpec = Field(default_factory=SetupSpec)
    cases: list[CaseSpec] = Field(min_length=1, max_length=200)

    @field_validator("cases")
    @classmethod
    def unique_case_ids(cls, value: list[CaseSpec]):
        ids = [case.id for case in value]
        if len(ids) != len(set(ids)):
            raise ValueError("case ids must be unique")
        return value


class ExperimentCreateRequest(BaseModel):
    suite_id: str
    mode: Literal["quick", "formal"] = "formal"
    profile: EvalProfile


class BaselineRequest(BaseModel):
    revision_id: str


class HumanReviewRequest(BaseModel):
    score: float = Field(ge=0, le=100)
    note: str = Field(default="", max_length=20_000)
    reviewer: str = Field(default="local-user", min_length=1, max_length=128)
