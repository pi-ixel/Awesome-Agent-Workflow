"""Configuration-driven workflow engine: definitions, DAG traversal, generation."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from shlex import quote
from typing import Any

import yaml

from .models import (
    DataError,
    Step,
    Workflow,
    WorkflowError,
    normalize_io,
    normalize_skill,
    parse_data,
)


_DEFINITIONS_DIR = Path(__file__).parent / "definitions"
_VAR_RE = re.compile(r"\{([^{}]+)\}")


# ---------------------------------------------------------------------------
# Workflow definition loader
# ---------------------------------------------------------------------------

def _load_definition() -> dict[str, Any]:
    """Load all workflow definitions and normalize them into runtime templates."""
    flow_path = _DEFINITIONS_DIR / "flow.yaml"
    flow_raw = yaml.safe_load(flow_path.read_text("utf-8")) or {}
    edges: dict[str, dict[str, Any]] = flow_raw.get("edges", {})

    templates: dict[str, dict[str, Any]] = {}
    for def_path in sorted(_DEFINITIONS_DIR.glob("*.yaml")):
        if def_path.stem == "flow":
            continue
        raw = yaml.safe_load(def_path.read_text("utf-8")) or {}
        tmpl = _normalize_node_template(raw, def_path.stem)
        edge = _normalize_edge(edges.get(def_path.stem, {}))
        tmpl["edge"] = edge
        tmpl["available_next"] = _available_next(edge)
        if edge.get("data_schema"):
            tmpl["data_schema"] = edge["data_schema"]
        templates[def_path.stem] = tmpl

    return {
        "version": flow_raw.get("version", 1),
        "entrypoints": flow_raw.get("entrypoints", {}),
        "templates": templates,
    }


def _normalize_node_template(raw: dict[str, Any], type_name: str) -> dict[str, Any]:
    skill = normalize_skill(raw.get("skill"))
    prompt = _normalize_prompt(raw.get("prompt"))
    execution = raw.get("execution")
    if not execution:
        if skill:
            execution = "skill"
        elif prompt:
            execution = "prompt"
        else:
            execution = "noop"

    return {
        "type": type_name,
        "name": raw.get("name", type_name),
        "execution": execution,
        "skill": skill,
        "prompt": prompt,
        "data_prompt": raw.get("data_prompt"),
        "input": normalize_io(raw.get("input"), "input"),
        "output": normalize_io(raw.get("output"), "output"),
        "data_schema": raw.get("data_schema"),
    }


def _normalize_prompt(raw: Any) -> dict[str, Any] | None:
    if not raw:
        return None
    if isinstance(raw, str):
        return {"inline": raw, "rendered": raw}
    if not isinstance(raw, dict):
        return {"inline": str(raw), "rendered": str(raw)}

    prompt = dict(raw)
    if "template" in prompt:
        template_path = _DEFINITIONS_DIR / str(prompt["template"])
        if not template_path.exists():
            raise WorkflowError(f"prompt template 不存在: {template_path}")
        prompt["rendered"] = template_path.read_text("utf-8")
    elif "inline" in prompt:
        prompt["rendered"] = prompt["inline"]
    elif "steps" in prompt:
        prompt["rendered"] = "\n".join(_render_prompt_step(s) for s in prompt["steps"])
    return prompt


def _render_prompt_step(step: Any) -> str:
    if isinstance(step, dict):
        return "; ".join(f"{k}: {v}" for k, v in step.items())
    return str(step)


def _quote_arg(arg: str) -> str:
    return quote(arg)


def _normalize_edge(edge: dict[str, Any]) -> dict[str, Any]:
    if not edge:
        return {"kind": "terminal"}

    kind = edge.get("kind", "")
    if kind == "1to1":
        kind = "direct"
    elif kind == "1toN":
        kind = "foreach"

    normalized = dict(edge)
    normalized["kind"] = kind

    if kind == "choice" and "choices" not in normalized:
        normalized["choices"] = _legacy_choice_to_choices(edge)
    if kind == "foreach" and "foreach" not in normalized:
        normalized["foreach"] = _infer_foreach_selector(edge)
    return normalized


def _legacy_choice_to_choices(edge: dict[str, Any]) -> list[dict[str, Any]]:
    choices: list[dict[str, Any]] = []
    for key, value in edge.items():
        if key in {"kind", "data_schema"}:
            continue
        choices.append({"when": f"data.{key}", "to": value})
    return choices


def _infer_foreach_selector(edge: dict[str, Any]) -> str:
    fields = ((edge.get("data_schema") or {}).get("fields") or {})
    if fields:
        return f"data.{next(iter(fields))}"
    return "data.items"


def _available_next(edge: dict[str, Any]) -> list[str]:
    kind = edge.get("kind")
    if kind == "terminal":
        return []
    if kind in {"direct", "foreach"}:
        return [edge["to"]]
    if kind == "choice":
        return [c["to"] for c in edge.get("choices", [])]
    return []


# ---------------------------------------------------------------------------
# Variable expansion
# ---------------------------------------------------------------------------

def _expand_obj(obj: Any, vars_: dict[str, Any]) -> Any:
    if isinstance(obj, str):
        return _expand(obj, vars_)
    if isinstance(obj, list):
        return [_expand_obj(item, vars_) for item in obj]
    if isinstance(obj, dict):
        return {k: _expand_obj(v, vars_) for k, v in obj.items()}
    return obj


def _expand(text: str, vars_: dict[str, Any]) -> str:
    def repl(match: re.Match[str]) -> str:
        value = _resolve_expr(match.group(1), {"vars": vars_, **vars_})
        return str(value) if value is not None else match.group(0)

    expanded = _VAR_RE.sub(repl, text)
    while "//" in expanded:
        expanded = expanded.replace("//", "/")
    return expanded


def _resolve_expr(expr: str, context: dict[str, Any]) -> Any:
    expr = expr.strip()
    if expr in context:
        return context[expr]
    current: Any = context
    for part in expr.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def _render_vars_mapping(mapping: dict[str, Any] | None, context: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in (mapping or {}).items():
        if isinstance(value, str):
            result[key] = _render_expr_template(value, context, strict=True)
        else:
            result[key] = value
    return result


def _render_expr_template(text: str, context: dict[str, Any], strict: bool = False) -> str:
    def repl(match: re.Match[str]) -> str:
        expr = match.group(1)
        value = _resolve_expr(expr, context)
        if value is None:
            if strict:
                raise DataError(f"变量映射无法解析: {expr}")
            return match.group(0)
        if strict and isinstance(value, (dict, list)):
            raise DataError(f"变量映射必须解析为标量: {expr}")
        return str(value)

    return _VAR_RE.sub(repl, text)


def _resolve_selector(selector: str, context: dict[str, Any]) -> Any:
    return _resolve_expr(selector, context)


def _eval_when(expr: str | None, context: dict[str, Any]) -> bool:
    if not expr:
        return True
    if "==" in expr:
        left, right = expr.split("==", 1)
        left_value = _resolve_selector(left.strip(), context)
        right_value = right.strip().strip("\"'")
        return str(left_value) == right_value
    return bool(_resolve_selector(expr.strip(), context))


def _validate_items(items: list[Any], validation: dict[str, Any] | None) -> None:
    if not validation:
        return
    reject_pattern = validation.get("reject_pattern")
    if reject_pattern:
        pattern = re.compile(str(reject_pattern))
        for item in items:
            if pattern.search(str(item)):
                message = validation.get("message") or f"数组项不允许匹配: {reject_pattern}"
                raise DataError(f"{message} offending item: {item}")


def _edge_rejections(edge: dict[str, Any]) -> list[dict[str, Any]]:
    raw = edge.get("reject")
    if raw is None:
        raw = edge.get("rejects")
    if raw is None:
        return []
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    if isinstance(raw, dict):
        return [raw]
    return []


# ---------------------------------------------------------------------------
# Step creation and IO rendering
# ---------------------------------------------------------------------------

def _resolve_path(sdd_dir: Path, path: str) -> str:
    abs_sdd = str(sdd_dir.resolve()).replace("\\", "/")
    if path.startswith(".sdd/"):
        return abs_sdd + "/" + path[5:]
    if path == ".sdd":
        return abs_sdd
    if path.startswith(".sdd"):
        return abs_sdd + path[4:]
    return path


def _render_io_items(sdd_dir: Path, items: list[dict[str, Any]], vars_: dict[str, Any]) -> list[dict[str, Any]]:
    rendered: list[dict[str, Any]] = []
    for item in items:
        out = _expand_obj(item, vars_)
        if "path" in out:
            out["path"] = _resolve_path(sdd_dir, out["path"])
        rendered.append(out)
    return rendered


def _make_step(template: dict[str, Any], step_id: int, vars_: dict[str, Any], sdd_dir: Path) -> Step:
    vars_copy = dict(vars_)
    return Step(
        id=step_id,
        type=template["type"],
        name=_expand(template["name"], vars_copy),
        finished=False,
        execution=template.get("execution", "noop"),
        skill=template.get("skill", []),
        prompt=_expand_obj(template.get("prompt"), vars_copy),
        data_prompt=_expand_obj(template.get("data_prompt"), vars_copy),
        input=_render_io_items(sdd_dir, template.get("input", []), vars_copy),
        output=_render_io_items(sdd_dir, template.get("output", []), vars_copy),
        available_next=template.get("available_next", []),
        data_schema=_expand_obj(template.get("data_schema"), vars_copy),
        vars=vars_copy,
        next=[],
    )


def _extract_variables_from_step(step: Step, sr: str) -> dict[str, Any]:
    """Best-effort compatibility for old workflow.yaml files without vars."""
    vars_: dict[str, Any] = {"SR": sr}
    for item in step.input + step.output:
        text = str(item.get("path") or item.get("value") or "").replace("\\", "/")
        marker = f"/{sr}/"
        if marker in text:
            tail = text.split(marker, 1)[1]
            first = tail.split("/", 1)[0]
            if first and "." not in first:
                vars_.setdefault("AR", first)
    return vars_


# ---------------------------------------------------------------------------
# Workflow manager
# ---------------------------------------------------------------------------

class WorkflowManager:
    """Reads and writes workflow.yaml, evaluates config-driven DAG logic."""

    def __init__(self, sdd_dir: Path):
        self.sdd_dir = sdd_dir
        definition = _load_definition()
        self.entrypoints: dict[str, dict[str, Any]] = definition["entrypoints"]
        self.templates: dict[str, dict[str, Any]] = definition["templates"]

    # ---- bootstrap ----

    def start(self, entry: str, vars_: dict[str, Any]) -> Workflow:
        entry_def = self.entrypoints.get(entry)
        if not entry_def:
            raise WorkflowError(f"入口不存在: {entry}")

        required = entry_def.get("vars", [])
        missing = [key for key in required if key not in vars_ or vars_[key] in {"", None}]
        if missing:
            raise WorkflowError(f"入口 {entry} 缺少变量: {', '.join(missing)}")

        sr = str(vars_.get("SR") or "")
        if not sr:
            raise WorkflowError("缺少 SR 变量，无法创建 workflow.yaml")

        self.sdd_dir.mkdir(parents=True, exist_ok=True)
        sr_dir = self.sdd_dir / sr
        if self._wf_path(sr).exists():
            raise WorkflowError(f"SR {sr} workflow 已存在")
        sr_dir.mkdir(parents=True, exist_ok=True)
        self._data_dir(sr).mkdir(parents=True, exist_ok=True)

        start_type = entry_def["start"]
        if start_type not in self.templates:
            raise WorkflowError(f"入口 {entry} 指向未知节点: {start_type}")

        wf_vars = dict(vars_)
        wf_vars["SR"] = sr
        step1 = _make_step(self.templates[start_type], 1, wf_vars, self.sdd_dir)
        wf = Workflow(
            sr=sr,
            entry=entry,
            status="in_progress",
            created_at=datetime.now(timezone.utc).isoformat(),
            vars=wf_vars,
            steps=[step1],
        )
        self._save(wf)
        return wf

    # ---- load / save ----

    def load(self, sr: str) -> Workflow:
        path = self._wf_path(sr)
        if not path.exists():
            raise WorkflowError(f"SR {sr} 不存在")
        return Workflow.from_yaml(path)

    def _save(self, wf: Workflow) -> None:
        wf.to_yaml(self._wf_path(wf.sr))

    def _wf_path(self, sr: str) -> Path:
        return self.sdd_dir / sr / "workflow.yaml"

    def _data_dir(self, sr: str) -> Path:
        return self.sdd_dir / sr / ".aaw" / "data"

    # ---- next ----

    def get_ready(self, wf: Workflow) -> list[Step]:
        pred_map = self._build_predecessor_map(wf)
        ready: list[Step] = []
        for s in wf.steps:
            if s.finished:
                continue
            preds = pred_map.get(s.id, [])
            if all(p.finished for p in preds):
                ready.append(s)
        return ready

    def build_next_payload(self, wf: Workflow) -> dict[str, Any]:
        ready = self.get_ready(wf)
        return {
            "sr": wf.sr,
            "entry": wf.entry,
            "ready": [self._step_work_order(wf, s) for s in ready],
            "done": len(ready) == 0 and wf.all_finished(),
        }

    def _step_work_order(self, wf: Workflow, step: Step) -> dict[str, Any]:
        requires_data = self._step_requires_data(step)
        data_file = self._data_file(wf, step) if requires_data else None
        done_argv = self._done_argv(wf, step, data_file)
        done = " ".join(_quote_arg(arg) for arg in done_argv)

        legacy_done = f"aaw done --sr {wf.sr} {step.id}"
        if requires_data:
            legacy_done += " --data '<JSON>'"
        legacy_done += " --json"

        return {
            "id": step.id,
            "type": step.type,
            "name": step.name,
            "execution": step.execution,
            "skill": step.skill,
            "prompt": step.prompt,
            "data_prompt": step.data_prompt,
            "data_file": self._data_file_payload(data_file),
            "input": self._annotate_io(step.input),
            "output": self._annotate_io(step.output),
            "inputs": self.check_inputs(step),
            "available_next": step.available_next,
            "data": step.data_schema,
            "vars": step.vars,
            "deliverables": self.check_deliverables(step),
            "deliverables_exist": self.check_deliverables(step)["can_skip"],
            "commands": {
                "done": done,
                "done_argv": done_argv,
                "done_inline": self._done_inline(wf, step, requires_data),
                "legacy_done": legacy_done,
            },
        }

    def _data_file(self, wf: Workflow, step: Step) -> Path:
        safe_type = re.sub(r"[^A-Za-z0-9_.-]+", "-", step.type).strip("-") or "step"
        return self._data_dir(wf.sr) / f"step-{step.id:04d}-{safe_type}.json"

    def _data_file_payload(self, data_file: Path | None) -> dict[str, Any] | None:
        if data_file is None:
            return None
        return {
            "path": str(data_file.resolve()).replace("\\", "/"),
            "relative_path": str(data_file.relative_to(Path.cwd())).replace("\\", "/")
            if data_file.is_relative_to(Path.cwd())
            else str(data_file).replace("\\", "/"),
            "encoding": "utf-8",
            "overwrite": True,
        }

    @staticmethod
    def _done_argv(wf: Workflow, step: Step, data_file: Path | None) -> list[str]:
        script = str((Path(__file__).resolve().parents[1] / "aaw.py")).replace("\\", "/")
        argv = ["python", script, "done", "--sr", wf.sr, str(step.id)]
        if data_file is not None:
            argv.extend(["--data-file", str(data_file.resolve()).replace("\\", "/")])
        argv.append("--json")
        return argv

    @staticmethod
    def _done_inline(wf: Workflow, step: Step, requires_data: bool) -> str:
        script = str((Path(__file__).resolve().parents[1] / "aaw.py")).replace("\\", "/")
        argv = ["python", script, "done", "--sr", wf.sr, str(step.id)]
        if requires_data:
            argv.extend(["--data", "<JSON>"])
        argv.append("--json")
        return " ".join(_quote_arg(arg) for arg in argv)

    def _step_requires_data(self, step: Step) -> bool:
        edge = self.templates[step.type]["edge"]
        return edge.get("kind") in {"choice", "foreach"} or bool(step.data_schema)

    @staticmethod
    def _annotate_io(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        annotated: list[dict[str, Any]] = []
        for item in items:
            out = dict(item)
            if "path" in out:
                out["exists"] = Path(out["path"]).exists()
            annotated.append(out)
        return annotated

    @staticmethod
    def check_inputs(step: Step) -> dict[str, Any]:
        inputs = [item for item in step.input if "path" in item]
        required = [item for item in inputs if item.get("required", True)]
        missing = [item["path"] for item in required if not Path(item["path"]).exists()]
        return {
            "required": [item["path"] for item in required],
            "optional": [item["path"] for item in inputs if not item.get("required", True)],
            "missing_required": missing,
            "all_required_exist": len(missing) == 0,
            "blocked": len(missing) > 0,
        }

    @staticmethod
    def check_deliverables(step: Step) -> dict[str, Any]:
        outputs = [item for item in step.output if "path" in item]
        required = [item for item in outputs if item.get("required", True)]
        missing = [item["path"] for item in required if not Path(item["path"]).exists()]
        return {
            "required": [item["path"] for item in required],
            "optional": [item["path"] for item in outputs if not item.get("required", True)],
            "missing_required": missing,
            "all_required_exist": len(missing) == 0,
            "can_skip": bool(required) and len(missing) == 0,
        }

    def _build_predecessor_map(self, wf: Workflow) -> dict[int, list[Step]]:
        pmap: dict[int, list[Step]] = {}
        for s in wf.steps:
            for nxt in s.next:
                pmap.setdefault(nxt, []).append(s)
        return pmap

    # ---- done ----

    def mark_done(self, wf: Workflow, step_id: int, data_raw: str | None = None) -> dict[str, Any]:
        step = wf.get_step(step_id)
        if step is None:
            raise WorkflowError(f"step {step_id} 不存在")
        if step.finished:
            raise WorkflowError(f"step {step_id} 已完成，不能重复 done")
        self._ensure_required_inputs(step)
        self._ensure_required_deliverables(step)

        ids, new_steps = self._generate_successors(wf, step, data_raw)
        step.finished = True
        step.next = ids
        wf.steps.extend(new_steps)

        if wf.all_finished():
            wf.status = "done"

        self._save(wf)
        return {"ok": True, "generated": len(ids), "next": ids}

    def _ensure_required_inputs(self, step: Step) -> None:
        missing = self.check_inputs(step)["missing_required"]
        if missing:
            raise WorkflowError("缺少 required input，不能 done: " + ", ".join(missing))

    def _ensure_required_deliverables(self, step: Step) -> None:
        missing = self.check_deliverables(step)["missing_required"]
        if missing:
            raise WorkflowError("缺少 required output，不能 done: " + ", ".join(missing))

    def _generate_successors(
        self,
        wf: Workflow,
        parent: Step,
        data_raw: str | None,
    ) -> tuple[list[int], list[Step]]:
        edge = self.templates[parent.type]["edge"]
        kind = edge.get("kind", "terminal")
        if kind == "terminal":
            return [], []
        if kind == "direct":
            return self._generate_direct(wf, parent, edge)

        data = parse_data(data_raw)
        context = {"data": data, "vars": self._parent_vars(wf, parent), **self._parent_vars(wf, parent)}
        if kind == "foreach":
            return self._generate_foreach(wf, parent, edge, context)
        if kind == "choice":
            return self._generate_choice(wf, parent, edge, context)
        raise WorkflowError(f"未知 edge kind: {kind}")

    def _parent_vars(self, wf: Workflow, parent: Step) -> dict[str, Any]:
        vars_: dict[str, Any] = dict(wf.vars)
        vars_.update(_extract_variables_from_step(parent, wf.sr))
        vars_.update(parent.vars)
        vars_["SR"] = wf.sr
        return vars_

    def _generate_direct(
        self,
        wf: Workflow,
        parent: Step,
        edge: dict[str, Any],
    ) -> tuple[list[int], list[Step]]:
        vars_ = self._parent_vars(wf, parent)
        vars_.update(_render_vars_mapping(edge.get("vars"), {"vars": vars_, **vars_}))
        new_id = wf.next_id()
        return [new_id], [self._make_successor(edge["to"], new_id, vars_)]

    def _generate_foreach(
        self,
        wf: Workflow,
        parent: Step,
        edge: dict[str, Any],
        context: dict[str, Any],
    ) -> tuple[list[int], list[Step]]:
        items = _resolve_selector(edge["foreach"], context)
        if not isinstance(items, list) or len(items) == 0:
            raise DataError(f"--data 中 {edge['foreach']} 必须是非空数组")
        _validate_items(items, edge.get("item_validation"))
        return self._generate_many(wf, parent, edge["to"], edge.get("vars"), items, context)

    def _generate_choice(
        self,
        wf: Workflow,
        parent: Step,
        edge: dict[str, Any],
        context: dict[str, Any],
    ) -> tuple[list[int], list[Step]]:
        for choice in edge.get("choices", []):
            if not _eval_when(choice.get("when"), context):
                continue
            if choice.get("foreach"):
                items = _resolve_selector(choice["foreach"], context)
                if not isinstance(items, list) or len(items) == 0:
                    raise DataError(f"--data 中 {choice['foreach']} 必须是非空数组")
                _validate_items(items, choice.get("item_validation"))
                return self._generate_many(wf, parent, choice["to"], choice.get("vars"), items, context)

            vars_ = self._parent_vars(wf, parent)
            vars_.update(_render_vars_mapping(choice.get("vars"), context | {"vars": vars_, **vars_}))
            new_id = wf.next_id()
            return [new_id], [self._make_successor(choice["to"], new_id, vars_)]
        for rejection in _edge_rejections(edge):
            if _eval_when(rejection.get("when"), context):
                message = rejection.get("message") or "当前数据被工作流配置拒绝，不能推进"
                raise DataError(_render_expr_template(str(message), context, strict=False))
        raise DataError("没有匹配的 choice 分支，请检查 --data")

    def _generate_many(
        self,
        wf: Workflow,
        parent: Step,
        target_type: str,
        vars_mapping: dict[str, Any] | None,
        items: list[Any],
        base_context: dict[str, Any],
    ) -> tuple[list[int], list[Step]]:
        ids: list[int] = []
        steps: list[Step] = []
        nid = wf.next_id()
        parent_vars = self._parent_vars(wf, parent)
        for index, item in enumerate(items, start=1):
            context = dict(base_context)
            context.update({"item": item, "index": index, "vars": parent_vars, **parent_vars})
            vars_ = dict(parent_vars)
            vars_.update(_render_vars_mapping(vars_mapping, context))
            ids.append(nid)
            steps.append(self._make_successor(target_type, nid, vars_))
            nid += 1
        return ids, steps

    def _make_successor(self, target_type: str, step_id: int, vars_: dict[str, Any]) -> Step:
        if target_type not in self.templates:
            raise WorkflowError(f"未知后继节点: {target_type}")
        return _make_step(self.templates[target_type], step_id, vars_, self.sdd_dir)

    # ---- rollback ----

    def rollback(self, wf: Workflow, step_id: int) -> dict[str, Any]:
        step = wf.get_step(step_id)
        if step is None:
            raise WorkflowError(f"step {step_id} 不存在")

        descendants: set[int] = set()
        desc_steps: list[Step] = []
        queue: list[int] = list(step.next)
        while queue:
            nid = queue.pop(0)
            if nid in descendants:
                continue
            descendants.add(nid)
            ns = wf.get_step(nid)
            if ns:
                desc_steps.append(ns)
                queue.extend(ns.next)

        deleted_files: list[str] = []
        dirs_to_check: set[Path] = set()
        for ds in desc_steps:
            for item in ds.output:
                out_path = item.get("path")
                if not out_path:
                    continue
                p = Path(out_path)
                if p.exists() and p.is_file():
                    p.unlink()
                    deleted_files.append(str(p))
                    dirs_to_check.add(p.parent)

        self._cleanup_empty_dirs(dirs_to_check, deleted_files)

        step.finished = False
        step.next = []
        wf.steps = [s for s in wf.steps if s.id not in descendants]
        wf.status = "in_progress"
        self._save(wf)
        return {"ok": True, "removed": len(descendants), "deleted_files": deleted_files}

    def _cleanup_empty_dirs(self, dirs_to_check: set[Path], deleted_files: list[str]) -> None:
        protected = self.sdd_dir.resolve()
        while dirs_to_check:
            next_dirs: set[Path] = set()
            progressed = False
            for d in dirs_to_check:
                try:
                    resolved = d.resolve()
                    if resolved == protected or protected not in resolved.parents:
                        continue
                    if d.exists() and not any(d.iterdir()):
                        d.rmdir()
                        deleted_files.append(str(d) + "/")
                        next_dirs.add(d.parent)
                        progressed = True
                    else:
                        next_dirs.add(d)
                except OSError:
                    next_dirs.add(d)
            if not progressed:
                break
            dirs_to_check = next_dirs
