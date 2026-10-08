from __future__ import annotations

import json
import re

import yaml
from sqlalchemy.orm import Session

from ...config import Settings
from ...models import Suite
from ...schemas import CaseSpec, GraderSpec, RubricDraftRequest, SuiteCreateRequest
from ..storage.artifacts import atomic_write_text, canonical_json, content_hash
from ..workspace.repository import inspect_clean_project
from .skills import import_skill, inspect_skill


def _slug(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value.strip()).strip("-").lower()
    return value[:80] or "case-1"


def build_rubric_draft(request: RubricDraftRequest, settings: Settings) -> dict:
    project = inspect_clean_project(request.project_path)
    skill = inspect_skill(request.skill_path, settings.max_skill_bytes)
    rubric = (
        "按 0-100 分评价候选结果。重点检查：\n"
        "1. 是否完成用户任务并产出可使用的结果；\n"
        "2. 是否满足全部预期效果；\n"
        "3. 内容是否与项目事实一致，且没有无依据的断言；\n"
        "4. 结果是否清晰、完整、可维护。\n\n"
        f"预期效果：\n{request.expected}"
    )
    case = CaseSpec(
        id=_slug(skill.name + "-case-1"),
        name=f"{skill.name} 默认测试",
        input=request.input,
        expected=request.expected,
        graders=[
            GraderSpec(
                id="outcome-quality",
                type="llm_rubric",
                name="结果质量",
                weight=100,
                rubric=rubric,
            )
        ],
    )
    return {
        "project": {
            "path": str(project.path),
            "name": project.name,
            "commit": project.commit,
            "tree": project.tree,
        },
        "skill": {
            "path": str(skill.root),
            "name": skill.name,
            "description": skill.description,
            "content_hash": skill.content_hash,
            "total_bytes": skill.total_bytes,
        },
        "case": case.model_dump(mode="json"),
    }


def create_suite(session: Session, settings: Settings, request: SuiteCreateRequest) -> Suite:
    project = inspect_clean_project(request.project_path)
    revision = import_skill(session, settings, request.skill_path)
    definition = {
        "schema_version": 1,
        "name": request.name,
        "project": {
            "path": str(project.path),
            "commit_at_creation": project.commit,
        },
        "skill": {"id": revision.skill_id, "name": revision.skill.name},
        "setup": request.setup.model_dump(mode="json"),
        "cases": [case.model_dump(mode="json") for case in request.cases],
    }
    definition_json = canonical_json(definition)
    digest = content_hash(definition)
    suite = Suite(
        name=request.name,
        skill_id=revision.skill_id,
        project_path=str(project.path),
        definition_path="",
        definition_hash=digest,
        definition_json=definition_json,
    )
    session.add(suite)
    session.flush()
    definition_path = settings.suites_dir / f"{suite.id}.yaml"
    atomic_write_text(
        definition_path,
        yaml.safe_dump(definition, allow_unicode=True, sort_keys=False),
    )
    suite.definition_path = str(definition_path)
    session.commit()
    session.refresh(suite)
    return suite


def suite_definition(suite: Suite) -> dict:
    return json.loads(suite.definition_json)
