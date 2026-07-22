"""Workflow data models and generic --data parsing."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def normalize_io_item(item: Any, default_kind: str = "input") -> dict[str, Any]:
    """Normalize legacy string IO and structured IO into one dict shape."""
    if isinstance(item, dict):
        result = dict(item)
    else:
        value = str(item)
        if default_kind == "output" or value.startswith(".sdd"):
            result = {"path": value}
        else:
            result = {"value": value}

    if "path" in result:
        result.setdefault("required", True)
    return result


def normalize_io(items: list[Any] | None, default_kind: str = "input") -> list[dict[str, Any]]:
    return [normalize_io_item(item, default_kind) for item in (items or [])]


def normalize_skill(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    return [str(value)]


# ---------------------------------------------------------------------------
# Step
# ---------------------------------------------------------------------------

@dataclass
class Step:
    id: int
    type: str
    name: str
    finished: bool = False
    execution_status: str = "ready"
    attempt: int = 1
    started_at: str | None = None
    ended_at: str | None = None
    execution: str = "noop"
    session: str = "inherit"
    skill: list[str] = field(default_factory=list)
    prompt: dict[str, Any] | None = None
    data_prompt: dict[str, Any] | None = None
    input: list[dict[str, Any]] = field(default_factory=list)
    output: list[dict[str, Any]] = field(default_factory=list)
    available_next: list[str] = field(default_factory=list)
    data_schema: dict[str, Any] | None = None
    vars: dict[str, Any] = field(default_factory=dict)
    depends_on: list[int] = field(default_factory=list)
    next: list[int] = field(default_factory=list)
    result_data: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Step":
        skill = normalize_skill(data.get("skill"))
        prompt = data.get("prompt")
        if isinstance(prompt, str):
            prompt = {"inline": prompt, "rendered": prompt}
        execution = data.get("execution") or _infer_execution(skill, prompt)
        return cls(
            id=data["id"],
            type=data["type"],
            name=data["name"],
            finished=data.get("finished", False),
            execution_status=data.get("execution_status", "completed" if data.get("finished", False) else "ready"),
            attempt=data.get("attempt", 1),
            started_at=data.get("started_at"),
            ended_at=data.get("ended_at"),
            execution=execution,
            session=data.get("session", "inherit"),
            skill=skill,
            prompt=prompt,
            data_prompt=data.get("data_prompt"),
            input=normalize_io(data.get("input"), "input"),
            output=normalize_io(data.get("output"), "output"),
            available_next=data.get("available_next", []),
            data_schema=data.get("data_schema"),
            vars=data.get("vars", {}),
            depends_on=data.get("depends_on", []),
            next=data.get("next", []),
            result_data=data.get("result_data"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "name": self.name,
            "finished": self.finished,
            "execution_status": self.execution_status,
            "attempt": self.attempt,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "execution": self.execution,
            "session": self.session,
            "skill": self.skill,
            "prompt": self.prompt,
            "data_prompt": self.data_prompt,
            "input": self.input,
            "output": self.output,
            "available_next": self.available_next,
            "data_schema": self.data_schema,
            "vars": self.vars,
            "depends_on": self.depends_on,
            "next": self.next,
            "result_data": self.result_data,
        }


def _infer_execution(skill: list[str], prompt: dict[str, Any] | None) -> str:
    if skill:
        return "skill"
    if prompt:
        return "prompt"
    return "noop"


# ---------------------------------------------------------------------------
# Workflow (workflow.yaml)
# ---------------------------------------------------------------------------

@dataclass
class Workflow:
    sr: str
    entry: str = "sr"
    status: str = "in_progress"
    created_at: str = ""
    vars: dict[str, Any] = field(default_factory=dict)
    steps: list[Step] = field(default_factory=list)
    pending_user_confirm: dict[str, Any] | None = None
    control: dict[str, Any] = field(default_factory=dict)
    transition_history: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_yaml(cls, path: Path) -> "Workflow":
        data = yaml.safe_load(path.read_text("utf-8")) or {}
        steps = [Step.from_dict(s) for s in data.get("steps", [])]
        vars_ = data.get("vars") or {}
        vars_.setdefault("SR", data["sr"])
        return cls(
            sr=data["sr"],
            entry=data.get("entry", "sr"),
            status=data.get("status", "in_progress"),
            created_at=data.get("created_at", ""),
            vars=vars_,
            steps=steps,
            pending_user_confirm=data.get("pending_user_confirm"),
            control=data.get("control") or {},
            transition_history=data.get("transition_history") or [],
        )

    def to_yaml(self, path: Path) -> None:
        d: dict[str, Any] = {
            "sr": self.sr,
            "entry": self.entry,
            "status": self.status,
            "created_at": self.created_at,
            "vars": self.vars,
            "steps": [s.to_dict() for s in self.steps],
        }
        if self.pending_user_confirm is not None:
            d["pending_user_confirm"] = self.pending_user_confirm
        if self.control:
            d["control"] = self.control
        if self.transition_history:
            d["transition_history"] = self.transition_history
        path.write_text(
            yaml.dump(d, allow_unicode=True, default_flow_style=False, sort_keys=False),
            "utf-8",
        )

    def get_step(self, step_id: int) -> Step | None:
        for s in self.steps:
            if s.id == step_id:
                return s
        return None

    def _max_id(self) -> int:
        return max((s.id for s in self.steps), default=0)

    def next_id(self) -> int:
        return self._max_id() + 1

    def all_finished(self) -> bool:
        return all(s.finished for s in self.steps)


# ---------------------------------------------------------------------------
# --data parsing
# ---------------------------------------------------------------------------

def parse_data(raw: str | None) -> dict[str, Any]:
    """Parse --data JSON string. Raises on missing or malformed input."""
    if not raw:
        raise DataError("缺少 --data 参数")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise DataError(f"--data JSON 解析失败: {e}")
    if not isinstance(data, dict):
        raise DataError("--data 必须是 JSON object")
    return data


class DataError(Exception):
    pass


class WorkflowError(Exception):
    pass
