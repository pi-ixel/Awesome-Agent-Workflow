"""Workflow engine: DAG traversal, step generation, ready check."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .models import (
    DataError,
    Step,
    Workflow,
    WorkflowError,
    parse_data,
    validate_ars_data,
    validate_module_groups_data,
    validate_tasks_data,
)

# ---------------------------------------------------------------------------
# Workflow definition loader
# ---------------------------------------------------------------------------

_DEFINITIONS_DIR = Path(__file__).parent / "definitions"


def _load_definition() -> dict[str, dict]:
    """Load step definitions and flow.yaml, merge, set defaults, derive available_next."""
    flow_path = _DEFINITIONS_DIR / "flow.yaml"
    flow_raw = yaml.safe_load(flow_path.read_text("utf-8"))
    edges: dict[str, dict] = flow_raw["edges"]

    templates: dict[str, dict] = {}
    for def_path in sorted(_DEFINITIONS_DIR.glob("*.yaml")):
        fname = def_path.stem
        if fname == "flow":
            continue
        raw = yaml.safe_load(def_path.read_text("utf-8"))
        tmpl: dict = dict(raw)
        tmpl["type"] = fname
        tmpl.setdefault("skill", [])
        tmpl.setdefault("prompt", "")
        tmpl.setdefault("output", [])

        edge = edges.get(fname, {})
        kind = edge.get("kind", "")
        if kind == "terminal":
            tmpl["terminal"] = True
            tmpl["available_next"] = []
        elif kind == "choice":
            fork = {k: v for k, v in edge.items() if k not in ("kind", "data_schema")}
            tmpl["fork"] = fork
            tmpl["available_next"] = list(fork.values())
            tmpl["data_schema"] = edge.get("data_schema")
        elif kind == "1toN":
            tmpl["fork"] = edge["to"]
            tmpl["available_next"] = [edge["to"]]
            tmpl["data_schema"] = edge.get("data_schema")
        elif kind == "1to1":
            tmpl["successor"] = edge["to"]
            tmpl["available_next"] = [edge["to"]]
        else:
            tmpl["available_next"] = []

        templates[fname] = tmpl
    return templates


# ---------------------------------------------------------------------------
# Variable extraction & template expansion
# ---------------------------------------------------------------------------

_VAR_RE = re.compile(r"\{(\w+)\}")


def _all_texts(step: Step) -> list[str]:
    """Return all resolved text fields that may contain variables."""
    return step.input + step.output


def _extract_variables(step: Step, sr: str) -> dict[str, str]:
    """Extract {SR}, {AR}, {需求短名}, {模块组名} from a step's resolved fields."""
    vars_: dict[str, str] = {"SR": sr, "AR": ""}
    texts = _all_texts(step)

    for text in texts:
        # .sdd/{SR}/{AR}/...
        m = re.search(r"\.sdd/[^/]+/([^/]+)/", text)
        if m and m.group(1) != sr:
            vars_["AR"] = m.group(1)

        # {AR}-{需求}-{模块组名}...
        ar_val = vars_.get("AR", "")
        if ar_val:
            m2 = re.search(rf"{ar_val}-(\S+?)-(\S+?)模块", text)
            if m2:
                vars_.setdefault("需求短名", m2.group(1))
                vars_["模块组名"] = m2.group(2)

    return vars_


def _expand(text: str, vars_: dict[str, str]) -> str:
    """Replace {VAR} placeholders with values from vars_."""

    def repl(m: re.Match) -> str:
        return vars_.get(m.group(1), m.group(0))

    return _VAR_RE.sub(repl, text)


def _expand_list(items: list[str], vars_: dict[str, str]) -> list[str]:
    result: list[str] = []
    for s in items:
        expanded = _expand(s, vars_)
        while "//" in expanded:
            expanded = expanded.replace("//", "/")
        result.append(expanded)
    return result


# ---------------------------------------------------------------------------
# Step generator
# ---------------------------------------------------------------------------

def _resolve_paths(sdd_dir: Path, paths: list[str]) -> list[str]:
    """Convert .sdd/... relative paths to absolute."""
    abs_sdd = str(sdd_dir.resolve()).replace("\\", "/")
    result: list[str] = []
    for p in paths:
        if p.startswith(".sdd/"):
            p = abs_sdd + "/" + p[5:]
        elif p.startswith(".sdd"):
            p = abs_sdd + p[4:]
        result.append(p)
    return result


def _make_step(template: dict, step_id: int, vars_: dict[str, str], sdd_dir: Path) -> Step:
    """Create a Step from a template, expanding all variables and resolving paths."""
    inp = _expand_list(template.get("input", []), vars_)
    out = _expand_list(template.get("output", []), vars_)
    return Step(
        id=step_id,
        type=template["type"],
        name=_expand(template["name"], vars_),
        finished=False,
        skill=template.get("skill", []),
        prompt=template.get("prompt", ""),
        input=_resolve_paths(sdd_dir, inp),
        output=_resolve_paths(sdd_dir, out),
        available_next=template.get("available_next", []),
        data_schema=template.get("data_schema"),
        next=[],
    )


def _generate_1to1(wf: Workflow, parent: Step, sdd_dir: Path, templates: dict[str, dict],
                   _data: dict | None) -> tuple[list[int], list[Step]]:
    """Generate one successor step (1:1 type)."""
    successor_type = templates[parent.type]["successor"]
    template = templates[successor_type]
    vars_ = _extract_variables(parent, wf.sr)
    new_id = wf.next_id()
    return [new_id], [_make_step(template, new_id, vars_, sdd_dir)]


def _generate_fork_ars(wf: Workflow, parent: Step, sdd_dir: Path, templates: dict[str, dict],
                       data: dict) -> tuple[list[int], list[Step]]:
    """Generate one ar-clarify per AR."""
    ars = validate_ars_data(data)
    successor_type = templates[parent.type]["fork"]["ars"]
    template = templates[successor_type]
    vars_ = _extract_variables(parent, wf.sr)
    ids: list[int] = []
    steps: list[Step] = []
    nid = wf.next_id()
    for ar in ars:
        ids.append(nid)
        v = dict(vars_)
        v["AR"] = ar["id"]
        v["描述"] = ar["title"]
        steps.append(_make_step(template, nid, v, sdd_dir))
        nid += 1
    return ids, steps


def _generate_fork_module_groups(wf: Workflow, parent: Step, sdd_dir: Path, templates: dict[str, dict],
                                 data: dict) -> tuple[list[int], list[Step]]:
    """Generate one module-asis-analysis per module group."""
    groups = validate_module_groups_data(data)
    successor_type = templates[parent.type]["fork"]
    template = templates[successor_type]
    vars_ = _extract_variables(parent, wf.sr)
    ids: list[int] = []
    steps: list[Step] = []
    nid = wf.next_id()
    for g in groups:
        ids.append(nid)
        v = dict(vars_)
        v["模块组名"] = "模块" + g["name"]
        v["需求短名"] = g["requirement"]
        steps.append(_make_step(template, nid, v, sdd_dir))
        nid += 1
    return ids, steps


def _generate_fork_tasks(wf: Workflow, parent: Step, sdd_dir: Path, templates: dict[str, dict],
                         data: dict) -> tuple[list[int], list[Step]]:
    """Generate one task-dev per task."""
    tasks = validate_tasks_data(data)
    successor_type = templates[parent.type]["fork"]
    template = templates[successor_type]
    vars_ = _extract_variables(parent, wf.sr)
    ids: list[int] = []
    steps: list[Step] = []
    nid = wf.next_id()
    for i, task in enumerate(tasks, start=1):
        ids.append(nid)
        v = dict(vars_)
        v["序号"] = str(i)
        v["任务标题"] = task
        steps.append(_make_step(template, nid, v, sdd_dir))
        nid += 1
    return ids, steps


# Map fork type → generator function
_FORK_GENERATORS = {
    "module-detail-design-split": _generate_fork_module_groups,
    "task-split": _generate_fork_tasks,
}


def _generate_ar_split(wf: Workflow, parent: Step, sdd_dir: Path, templates: dict[str, dict],
                       data: dict) -> tuple[list[int], list[Step]]:
    """Handle ar-split: split mode → N ar-clarify, no_split mode → 1 boundary-design."""
    if "ars" in data:
        return _generate_fork_ars(wf, parent, sdd_dir, templates, data)
    elif data.get("mode") == "no_split":
        fork = templates[parent.type]["fork"]
        ref = templates[fork["no_split"]]
        vars_: dict[str, str] = {"SR": wf.sr, "AR": ""}
        new_id = wf.next_id()
        inp = _expand_list([".sdd/{SR}/SR-design.md"], vars_)
        out = _expand_list([".sdd/{SR}/module-boundary-design.md"], vars_)
        step = Step(
            id=new_id,
            type=ref["type"],
            name=ref["name"],
            finished=False,
            skill=ref["skill"],
            prompt="",
            input=_resolve_paths(sdd_dir, inp),
            output=_resolve_paths(sdd_dir, out),
            available_next=ref["available_next"],
            next=[],
        )
        return [new_id], [step]
    else:
        raise DataError(
            'ar-split 需要 --data:'
            ' split 模式 {"ars":[{"id":"AR-001","title":"..."},...]}'
            ' 或 no_split 模式 {"mode":"no_split"}'
        )


# ---------------------------------------------------------------------------
# Workflow manager
# ---------------------------------------------------------------------------

class WorkflowManager:
    """Reads / writes workflow.yaml, handles DAG logic."""

    def __init__(self, sdd_dir: Path):
        self.sdd_dir = sdd_dir
        self.templates = _load_definition()

    # ---- init ----

    def init_sr(self, sr: str) -> Workflow:
        """Create a new SR directory with a fresh workflow.yaml containing step 1."""
        sr_dir = self.sdd_dir / sr
        if sr_dir.exists():
            raise WorkflowError(f"SR {sr} 已存在")

        sr_dir.mkdir(parents=True, exist_ok=True)
        step1 = _make_step(self.templates["sr-design"], 1, {"SR": sr}, self.sdd_dir)
        wf = Workflow(
            sr=sr,
            status="in_progress",
            created_at=datetime.now(timezone.utc).isoformat(),
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

    # ---- next ----

    def get_ready(self, wf: Workflow) -> list[Step]:
        """Return steps whose predecessors are all finished, and themselves are not."""
        pred_map = self._build_predecessor_map(wf)
        ready: list[Step] = []
        for s in wf.steps:
            if s.finished:
                continue
            preds = pred_map.get(s.id, [])
            if all(p.finished for p in preds):
                ready.append(s)
        return ready

    @staticmethod
    def check_deliverables(step: Step) -> bool:
        """Return True if all output files of this step already exist on disk."""
        for out_path in step.output:
            if out_path and not Path(out_path).exists():
                return False
        return bool(step.output)  # at least one output file, and all exist

    def _build_predecessor_map(self, wf: Workflow) -> dict[int, list[Step]]:
        """Build map: step_id → list of predecessor Step objects."""
        pmap: dict[int, list[Step]] = {}
        for s in wf.steps:
            for nxt in s.next:
                pmap.setdefault(nxt, []).append(s)
        return pmap

    # ---- done ----

    def mark_done(self, wf: Workflow, step_id: int, data_raw: str | None = None) -> dict:
        """
        Mark a step finished, generate successors, save.

        Returns {"ok": True, "generated": N}
        """
        step = wf.get_step(step_id)
        if step is None:
            raise WorkflowError(f"step {step_id} 不存在")
        if step.finished:
            raise WorkflowError(f"step {step_id} 已完成，不能重复 done")

        step.finished = True

        if step.type == "task-dev":
            pass
        elif step.type == "ar-split":
            data = parse_data(data_raw)
            ids, new_steps = _generate_ar_split(wf, step, self.sdd_dir, self.templates, data)
            step.next = ids
            wf.steps.extend(new_steps)
        elif step.is_fork():
            data = parse_data(data_raw)
            generator = _FORK_GENERATORS[step.type]
            ids, new_steps = generator(wf, step, self.sdd_dir, self.templates, data)
            step.next = ids
            wf.steps.extend(new_steps)
        else:
            ids, new_steps = _generate_1to1(wf, step, self.sdd_dir, self.templates, None)
            step.next = ids
            wf.steps.extend(new_steps)

        if wf.all_finished():
            wf.status = "done"

        self._save(wf)
        return {"ok": True, "generated": len(step.next) if step.next else 0}

    # ---- rollback ----

    def rollback(self, wf: Workflow, step_id: int) -> dict:
        """Reset a step, remove all downstream steps, and delete their generated files.

        Returns {"ok": True, "removed": N, "deleted_files": [...]}
        """
        step = wf.get_step(step_id)
        if step is None:
            raise WorkflowError(f"step {step_id} 不存在")

        # BFS to collect all descendant step ids and objects
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

        # Delete generated files from all descendant steps
        deleted_files: list[str] = []
        dirs_to_check: set[Path] = set()
        for ds in desc_steps:
            for out_path in ds.output:
                p = Path(out_path)
                if p.exists():
                    p.unlink()
                    deleted_files.append(str(p))
                    dirs_to_check.add(p.parent)

        # Clean up empty directories (bottom-up by depth)
        cleaned = 0
        while cleaned < len(dirs_to_check):
            cleaned = 0
            remaining: set[Path] = set()
            for d in dirs_to_check:
                try:
                    if d.exists() and not any(d.iterdir()):
                        d.rmdir()
                        deleted_files.append(str(d) + "/")
                        if d.parent != self.sdd_dir.resolve():
                            remaining.add(d.parent)
                    else:
                        remaining.add(d)
                except OSError:
                    remaining.add(d)
            if remaining == dirs_to_check:
                break  # no progress
            dirs_to_check = remaining

        # Reset target
        step.finished = False
        step.next = []

        # Remove descendants
        removed = len(descendants)
        wf.steps = [s for s in wf.steps if s.id not in descendants]

        wf.status = "in_progress"
        self._save(wf)
        return {"ok": True, "removed": removed, "deleted_files": deleted_files}
