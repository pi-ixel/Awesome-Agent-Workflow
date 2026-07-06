"""Step data model, Workflow data model, YAML serialization, --data validation."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml


# ---------------------------------------------------------------------------
# Step
# ---------------------------------------------------------------------------

@dataclass
class Step:
    id: int
    type: str
    name: str
    finished: bool = False
    skill: list[str] = field(default_factory=list)
    prompt: str = ""
    input: list[str] = field(default_factory=list)
    output: list[str] = field(default_factory=list)
    available_next: list[str] = field(default_factory=list)
    next: list[int] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict) -> "Step":
        return cls(
            id=data["id"],
            type=data["type"],
            name=data["name"],
            finished=data.get("finished", False),
            skill=data.get("skill", []),
            prompt=data.get("prompt", ""),
            input=data.get("input", []),
            output=data.get("output", []),
            available_next=data.get("available_next", []),
            next=data.get("next", []),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "name": self.name,
            "finished": self.finished,
            "skill": self.skill,
            "prompt": self.prompt,
            "input": self.input,
            "output": self.output,
            "available_next": self.available_next,
            "next": self.next,
        }

    def is_terminal(self) -> bool:
        return self.type == "task-dev"

    def is_fork(self) -> bool:
        return self.type in ("module-detail-design-split", "task-split")


# ---------------------------------------------------------------------------
# Workflow (workflow.yaml)
# ---------------------------------------------------------------------------

@dataclass
class Workflow:
    sr: str
    status: str = "in_progress"
    created_at: str = ""
    steps: list[Step] = field(default_factory=list)

    @classmethod
    def from_yaml(cls, path: Path) -> "Workflow":
        data = yaml.safe_load(path.read_text("utf-8")) or {}
        steps = [Step.from_dict(s) for s in data.get("steps", [])]
        return cls(
            sr=data["sr"],
            status=data.get("status", "in_progress"),
            created_at=data.get("created_at", ""),
            steps=steps,
        )

    def to_yaml(self, path: Path) -> None:
        d: dict[str, Any] = {
            "sr": self.sr,
            "status": self.status,
            "created_at": self.created_at,
            "steps": [s.to_dict() for s in self.steps],
        }
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
# --data validation
# ---------------------------------------------------------------------------

def parse_data(raw: str | None) -> dict:
    """Parse --data JSON string.  Raises on missing / malformed input."""
    if not raw:
        raise DataError("缺少 --data 参数")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise DataError(f"--data JSON 解析失败: {e}")
    return data


def validate_ars_data(data: dict) -> list[dict]:
    ars = data.get("ars")
    if not ars:
        raise DataError('--data 需要 "ars" 字段，格式: {"ars": [{"id": "AR-001", "title": "..."}, ...]}')
    if not isinstance(ars, list) or len(ars) == 0:
        raise DataError('"ars" 必须为非空数组')
    for item in ars:
        if "id" not in item or "title" not in item:
            raise DataError('ars 每一项需要 "id" 和 "title" 字段')
    return ars


def validate_module_groups_data(data: dict) -> list[dict]:
    groups = data.get("module_groups")
    if not groups:
        raise DataError(
            '--data 需要 "module_groups" 字段，格式: '
            '{"module_groups": [{"name": "A,B", "modules": [...], "requirement": "..."}, ...]}'
        )
    if not isinstance(groups, list) or len(groups) == 0:
        raise DataError('"module_groups" 必须为非空数组')
    for item in groups:
        if "name" not in item or "modules" not in item or "requirement" not in item:
            raise DataError('module_groups 每一项需要 "name", "modules", "requirement" 字段')
    return groups


def validate_tasks_data(data: dict) -> list[str]:
    tasks = data.get("tasks")
    if not tasks:
        raise DataError('--data 需要 "tasks" 字段，格式: {"tasks": ["T1-...", "T2-..."]}')
    if not isinstance(tasks, list) or len(tasks) == 0:
        raise DataError('"tasks" 必须为非空数组')
    for t in tasks:
        if not isinstance(t, str):
            raise DataError("tasks 每一项必须为字符串")
    return tasks


class DataError(Exception):
    pass


class WorkflowError(Exception):
    pass
