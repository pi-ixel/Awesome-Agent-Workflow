# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Standalone long-running module research coordinator."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
TERMINAL_STATUSES = {"paused", "blocked", "complete"}
TASK_STATUSES = {"pending", "running", "completed", "split", "blocked"}
OUTCOMES = {"completed", "split", "blocked"}
CLAIM_STATUSES = {"FACT", "INFERRED", "CONFIRMED", "BLOCKED"}
ACCEPTANCE_STATUSES = {"satisfied", "partial", "blocked"}
HISTORY_MODES = {"full", "off"}
MODULE_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

SCRIPT_PATH = Path(__file__).resolve()
SKILL_DIR = SCRIPT_PATH.parent.parent
TASK_TYPES_PATH = SKILL_DIR / "assets" / "task-types.json"
TASK_PROMPT_PATH = SKILL_DIR / "assets" / "prompts" / "task.md"
RECHECK_PROMPT_PATH = SKILL_DIR / "assets" / "prompts" / "recheck.md"
ASSET_SPEC_PATH = SKILL_DIR / "references" / "asset-structure.md"
DOCUMENT_CONTRACTS_PATH = SKILL_DIR / "assets" / "document-contracts.json"
TEMPLATE_DIR = SKILL_DIR / "assets" / "templates"


class CliError(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value)


def parse_budget(value: str) -> int:
    match = re.fullmatch(r"\s*(\d+)\s*([smh]?)\s*", value.lower())
    if not match:
        raise argparse.ArgumentTypeError("预算格式应为整数加 s/m/h，例如 45m、2h")
    amount = int(match.group(1))
    if amount <= 0:
        raise argparse.ArgumentTypeError("预算必须大于 0")
    unit = match.group(2) or "m"
    multiplier = {"s": 1, "m": 60, "h": 3600}[unit]
    return amount * multiplier


def parse_priority(value: str) -> int:
    try:
        priority = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("优先级必须是 1..100 的整数") from exc
    if not 1 <= priority <= 100:
        raise argparse.ArgumentTypeError("优先级必须是 1..100 的整数")
    return priority


def format_duration(seconds: int) -> str:
    hours, remainder = divmod(max(0, seconds), 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}h{minutes:02d}m{secs:02d}s"
    if minutes:
        return f"{minutes}m{secs:02d}s"
    return f"{secs}s"


def validate_module_name(value: str) -> str:
    name = value.strip()
    if not name or name in {".", ".."} or len(name) > 80 or MODULE_FORBIDDEN.search(name):
        raise CliError("模块名不能为空、不能包含路径/控制字符，且长度不能超过 80")
    return name


def repo_root() -> Path:
    return Path.cwd().resolve()


def ensure_within(path: Path, parent: Path, label: str) -> Path:
    resolved = path.resolve()
    parent_resolved = parent.resolve()
    if resolved != parent_resolved and parent_resolved not in resolved.parents:
        raise CliError(f"{label}必须位于 {parent_resolved} 内")
    return resolved


def module_root(root: Path, module: str) -> Path:
    return root / ".sdd" / "modules" / module


def state_path(root: Path, module: str) -> Path:
    return module_root(root, module) / "研究过程" / "research-state.json"


def finding_path(root: Path, module: str, task_id: str) -> Path:
    return module_root(root, module) / "研究过程" / "findings" / f"{task_id}.json"


def relative_posix(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    os.replace(temp, path)


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise CliError(f"{label}不存在：{path}") from exc
    except json.JSONDecodeError as exc:
        raise CliError(f"{label}不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise CliError(f"{label}必须是 JSON object")
    return data


def load_task_types() -> dict[str, dict[str, Any]]:
    raw = load_json(TASK_TYPES_PATH, "任务类型定义")
    items = raw.get("task_types")
    if not isinstance(items, list) or not items:
        raise CliError("任务类型定义缺少非空 task_types")
    result: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("type"), str):
            raise CliError("任务类型定义格式错误")
        result[item["type"]] = item
    return result


def load_document_contracts() -> dict[str, Any]:
    raw = load_json(DOCUMENT_CONTRACTS_PATH, "文档契约")
    contracts = raw.get("contracts")
    if not isinstance(contracts, list) or not contracts:
        raise CliError("文档契约缺少非空 contracts")
    for contract in contracts:
        if not isinstance(contract, dict):
            raise CliError("文档契约格式错误")
        for field in ("id", "match", "template", "metadata", "required_headings"):
            if field not in contract:
                raise CliError(f"文档契约缺少字段：{field}")
    return raw


def load_state(root: Path, module: str) -> tuple[Path, dict[str, Any]]:
    path = state_path(root, module)
    state = load_json(path, "研究状态")
    if state.get("schema_version") != SCHEMA_VERSION:
        raise CliError(f"不支持的 research-state schema：{state.get('schema_version')}")
    if state.get("module") != module:
        raise CliError("研究状态中的模块名与命令参数不一致")
    state.setdefault(
        "history",
        {
            "mode": "full",
            "last_scanned_head": None,
            "last_scanned_at": None,
            "commit_tasks": {},
            "scan_error": None,
        },
    )
    return path, state


def run_git(root: Path, args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess(
            ["git", *args],
            returncode=1,
            stdout="",
            stderr=str(exc),
        )


def git_head(root: Path) -> str:
    result = run_git(root, ["rev-parse", "HEAD"], timeout=5)
    if result.returncode != 0:
        return "无法获取"
    return result.stdout.strip()


def git_history_for_path(root: Path, source_path: str) -> list[dict[str, Any]]:
    marker = "__DEEP_RESEARCH_COMMIT__"
    result = run_git(
        root,
        [
            "log",
            "--full-history",
            "--reverse",
            "--date=iso-strict",
            "--name-only",
            f"--format={marker}%H%x1f%P%x1f%aI%x1f%s",
            "--",
            source_path,
        ],
        timeout=120,
    )
    if result.returncode != 0:
        raise CliError(f"无法扫描 Git 历史：{result.stderr.strip() or 'git log 失败'}")
    commits: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for raw_line in result.stdout.splitlines():
        line = raw_line.rstrip()
        if line.startswith(marker):
            if current is not None:
                current["changed_files"] = list(dict.fromkeys(current["changed_files"]))
                commits.append(current)
            fields = line[len(marker) :].split("\x1f", 3)
            if len(fields) != 4:
                raise CliError("Git 历史输出格式异常")
            current = {
                "commit": fields[0],
                "parents": fields[1].split() if fields[1] else [],
                "author_date": fields[2],
                "subject": fields[3],
                "changed_files": [],
            }
        elif current is not None and line.strip():
            current["changed_files"].append(line.strip())
    if current is not None:
        current["changed_files"] = list(dict.fromkeys(current["changed_files"]))
        commits.append(current)
    return commits


def active_elapsed(state: dict[str, Any], at: datetime | None = None) -> int:
    session = state["session"]
    elapsed = int(session.get("elapsed_seconds", 0))
    started = session.get("active_started_at")
    if started:
        elapsed += max(0, int(((at or datetime.now(timezone.utc)) - parse_time(started)).total_seconds()))
    return elapsed


def stop_session(state: dict[str, Any], reason: str) -> None:
    session = state["session"]
    elapsed = active_elapsed(state)
    session["elapsed_seconds"] = elapsed
    session["active_started_at"] = None
    session["last_stopped_at"] = now_iso()
    session["last_stop_reason"] = reason


def budget_exhausted(state: dict[str, Any]) -> bool:
    return active_elapsed(state) >= int(state["session"]["budget_seconds"])


def next_id(state: dict[str, Any], prefix: str) -> str:
    counters = state.setdefault("counters", {})
    counters[prefix] = int(counters.get(prefix, 0)) + 1
    return f"{prefix}-{counters[prefix]:03d}"


def create_task(
    state: dict[str, Any],
    *,
    task_type: str,
    title: str,
    question: str,
    priority: int,
    evidence_hints: list[str],
    acceptance: list[str],
    expansion_triggers: list[str],
    parent_id: str | None = None,
    reason: str = "seed",
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    task = {
        "id": next_id(state, "DR"),
        "type": task_type,
        "title": title,
        "question": question,
        "priority": priority,
        "status": "pending",
        "parent_id": parent_id,
        "reason": reason,
        "context": context or {},
        "evidence_hints": evidence_hints,
        "acceptance": acceptance,
        "expansion_triggers": expansion_triggers,
        "created_at": now_iso(),
        "started_at": None,
        "ended_at": None,
        "summary": None,
        "finding_file": None,
        "asset_snapshot": {},
    }
    state["tasks"].append(task)
    return task


def scan_history_into_state(
    root: Path,
    state: dict[str, Any],
    *,
    force: bool = False,
) -> dict[str, Any]:
    history = state["history"]
    if history["mode"] == "off":
        return {
            "mode": "off",
            "scanned": False,
            "created_tasks": [],
            "message": "Git 历史研究已关闭。",
        }
    head = git_head(root)
    if head == "无法获取":
        history["scan_error"] = "当前目录不是可读取的 Git 仓库"
        return {
            "mode": history["mode"],
            "scanned": False,
            "created_tasks": [],
            "error": history["scan_error"],
        }
    if not force and history.get("last_scanned_head") == head:
        return {
            "mode": history["mode"],
            "scanned": False,
            "created_tasks": [],
            "head": head,
            "message": "Git HEAD 未变化，无需重复扫描。",
        }
    try:
        commits = git_history_for_path(root, state["source_path"])
    except CliError as exc:
        history["scan_error"] = str(exc)
        return {
            "mode": history["mode"],
            "scanned": False,
            "created_tasks": [],
            "head": head,
            "error": history["scan_error"],
        }
    commit_tasks = history.setdefault("commit_tasks", {})
    initial_backfill = history.get("last_scanned_at") is None
    definition = load_task_types()["git-change"]
    created: list[str] = []
    for commit in commits:
        commit_hash = commit["commit"]
        if commit_hash in commit_tasks:
            continue
        short = commit_hash[:10]
        changed_files = list(commit["changed_files"])
        task = create_task(
            state,
            task_type="git-change",
            title=f"由提交 {short} 反查当前模块知识",
            question=(
                f"提交 {short}（{commit['subject']}）暴露了哪些值得核对的模块知识，"
                "这些知识在当前 HEAD 中的真实实现、适用边界和例外是什么？"
            ),
            priority=55 if initial_backfill else 98,
            evidence_hints=changed_files or [state["source_path"]],
            acceptance=list(definition["acceptance"]),
            expansion_triggers=list(definition["expansion_triggers"]),
            reason="history-backfill" if initial_backfill else "history-refresh",
            context={
                "git_commit": commit_hash,
                "git_parents": commit["parents"],
                "author_date": commit["author_date"],
                "subject": commit["subject"],
                "changed_files": changed_files,
                "evidence_policy": (
                    "提交及历史 diff 只作为调查 hint；claims 必须以当前 HEAD "
                    "的模块源码为事实来源，测试、配置和说明材料只用于交叉验证。"
                ),
            },
        )
        commit_tasks[commit_hash] = task["id"]
        created.append(task["id"])
    history["last_scanned_head"] = head
    history["last_scanned_at"] = now_iso()
    history["scan_error"] = None
    history["commit_count"] = len(commits)
    return {
        "mode": history["mode"],
        "scanned": True,
        "head": head,
        "commit_count": len(commits),
        "created_tasks": created,
        "initial_backfill": initial_backfill,
    }


def create_issue(
    state: dict[str, Any], task_id: str, data: dict[str, Any]
) -> dict[str, Any]:
    issue = {
        "id": next_id(state, "ISSUE"),
        "source_task_id": task_id,
        "question": require_text(data, "question", "unresolved_issues[]"),
        "blocked_by": require_text(data, "blocked_by", "unresolved_issues[]"),
        "needed": require_text(data, "needed", "unresolved_issues[]"),
        "status": "open",
        "created_at": now_iso(),
        "resolved_at": None,
    }
    state["issues"].append(issue)
    return issue


def render_asset_template(
    template_name: str,
    *,
    module: str,
    source_path: str,
    baseline: str,
) -> str:
    template = (TEMPLATE_DIR / template_name).read_text("utf-8")
    replacements = {
        "{{MODULE}}": module,
        "{{SOURCE_PATH}}": source_path,
        "{{BASELINE}}": baseline,
        "{{DATE}}": datetime.now().date().isoformat(),
    }
    for source, target in replacements.items():
        template = template.replace(source, target)
    return template


def create_asset_skeleton(
    root: Path, module: str, source_path: str, baseline: str
) -> None:
    base = module_root(root, module)
    process = base / "研究过程"
    (base / "业务功能" / "业务流程").mkdir(parents=True, exist_ok=True)
    (base / "业务功能" / "非流程功能点").mkdir(parents=True, exist_ok=True)
    (process / "findings").mkdir(parents=True, exist_ok=True)
    files = {
        base / f"{module}模块认知说明书.md": render_asset_template(
            "module-overview.md",
            module=module,
            source_path=source_path,
            baseline=baseline,
        ),
        base / "数据模型与状态.md": render_asset_template(
            "data-model.md",
            module=module,
            source_path=source_path,
            baseline=baseline,
        ),
        base / "约束与风险.md": render_asset_template(
            "constraints-risks.md",
            module=module,
            source_path=source_path,
            baseline=baseline,
        ),
    }
    for path, content in files.items():
        if not path.exists():
            path.write_text(content, "utf-8")


def command_init(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    source = Path(args.path)
    if not source.is_absolute():
        source = root / source
    source = ensure_within(source, root, "模块路径")
    if not source.exists():
        raise CliError(f"模块路径不存在：{source}")

    path = state_path(root, module)
    if path.exists():
        raise CliError(f"研究已经初始化：{path}；请使用 status 或 resume")

    baseline = git_head(root)
    source_relative = relative_posix(source, root)
    create_asset_skeleton(root, module, source_relative, baseline)
    started = now_iso()
    state: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "module": module,
        "source_path": source_relative,
        "asset_root": relative_posix(module_root(root, module), root),
        "repository_root": root.as_posix(),
        "baseline_commit": baseline,
        "status": "active",
        "phase": "research",
        "created_at": started,
        "updated_at": started,
        "completed_at": None,
        "current_task_id": None,
        "session": {
            "budget_seconds": args.budget,
            "elapsed_seconds": 0,
            "total_elapsed_seconds": 0,
            "active_started_at": started,
            "last_stopped_at": None,
            "last_stop_reason": None,
        },
        "counters": {"DR": 0, "ISSUE": 0},
        "tasks": [],
        "issues": [],
        "history": {
            "mode": args.history_mode,
            "last_scanned_head": None,
            "last_scanned_at": None,
            "commit_tasks": {},
            "scan_error": None,
        },
    }
    definitions = load_task_types()
    for definition in definitions.values():
        if not definition.get("seed", False):
            continue
        create_task(
            state,
            task_type=definition["type"],
            title=definition["title"],
            question=definition["question"],
            priority=int(definition["priority"]),
            evidence_hints=[state["source_path"]],
            acceptance=list(definition["acceptance"]),
            expansion_triggers=list(definition["expansion_triggers"]),
        )
    history_scan = scan_history_into_state(root, state)
    state["updated_at"] = now_iso()
    atomic_write_json(path, state)
    return {
        "status": "initialized",
        "module": module,
        "source_path": state["source_path"],
        "state_file": relative_posix(path, root),
        "task_count": len(state["tasks"]),
        "history": history_scan,
        "budget_seconds": args.budget,
        "next_command": build_command("next", module, "--json"),
    }


def find_task(state: dict[str, Any], task_id: str) -> dict[str, Any]:
    for task in state["tasks"]:
        if task["id"] == task_id:
            return task
    raise CliError(f"研究任务不存在：{task_id}")


def current_task(state: dict[str, Any]) -> dict[str, Any] | None:
    task_id = state.get("current_task_id")
    if not task_id:
        return None
    task = find_task(state, task_id)
    if task["status"] != "running":
        raise CliError("状态损坏：current_task_id 未指向 running 任务")
    return task


def select_pending_task(state: dict[str, Any]) -> dict[str, Any] | None:
    pending = [task for task in state["tasks"] if task["status"] == "pending"]
    if not pending:
        return None
    return sorted(
        pending,
        key=lambda item: (
            -int(item["priority"]),
            0 if item["type"] == "user-question" else 1,
            item["id"],
        ),
    )[0]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot_stable_assets(root: Path, module: str) -> dict[str, str]:
    base = module_root(root, module)
    process = base / "研究过程"
    snapshot: dict[str, str] = {}
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        resolved = path.resolve()
        if resolved == process.resolve() or process.resolve() in resolved.parents:
            continue
        snapshot[relative_posix(path, root)] = file_sha256(path)
    return snapshot


def completed_context(state: dict[str, Any]) -> str:
    completed = [
        task
        for task in state["tasks"]
        if task["status"] in {"completed", "split"} and task.get("summary")
    ]
    if not completed:
        return "- 尚无已验收结论。"
    lines: list[str] = []
    for task in completed[-12:]:
        summary = str(task["summary"]).replace("\n", " ").strip()
        if len(summary) > 400:
            summary = summary[:397] + "..."
        lines.append(f"- {task['id']} {task['title']}：{summary}")
    return "\n".join(lines)


def stable_asset_context(root: Path, module: str) -> str:
    files = stable_markdown_files(root, module)
    if not files:
        return "- 尚无稳定认知文档。"
    return "\n".join(f"- {relative_posix(path, root)}" for path in files)


def task_specific_context(task: dict[str, Any]) -> str:
    context = task.get("context") or {}
    commit = context.get("git_commit")
    if not commit:
        if context.get("source") == "user":
            return (
                "- 来源：用户在既有研究基础上补充的问题\n"
                f"- 提交时间：{context.get('submitted_at') or '未知'}\n"
                f"- 原始问题：{context.get('original_question') or task['question']}\n"
                "- 处理原则：保持原始问题语义；已有认知只作为起点，仍须回到当前实现复核。"
            )
        return "- 无额外任务上下文。"
    parents = ", ".join(context.get("git_parents") or []) or "无（根提交）"
    changed = context.get("changed_files") or []
    changed_lines = "\n".join(f"  - {path}" for path in changed) or "  - 未解析到路径"
    return (
        f"- Git 提交：`{commit}`\n"
        f"- 父提交：{parents}\n"
        f"- 提交时间：{context.get('author_date') or '未知'}\n"
        f"- 提交主题：{context.get('subject') or '无'}\n"
        f"- 当时涉及路径：\n{changed_lines}\n"
        f"- 证据政策：{context.get('evidence_policy')}"
    )


def open_issues_context(state: dict[str, Any]) -> str:
    issues = [issue for issue in state["issues"] if issue["status"] == "open"]
    if not issues:
        return "- 无。"
    return "\n".join(
        f"- {item['id']}：{item['question']}（受阻于：{item['blocked_by']}）"
        for item in issues[-12:]
    )


def bullet_lines(items: list[str]) -> str:
    return "\n".join(f"- {item}" for item in items) if items else "- 无。"


def result_example(task: dict[str, Any]) -> dict[str, Any]:
    is_recheck = task["type"] == "recheck"
    acceptance = list(task["acceptance"])
    return {
        "task_id": task["id"],
        "outcome": "completed",
        "summary": "本轮得到的稳定认知摘要",
        "claims": [
            {
                "statement": f"支撑完成标准 {index + 1} 的具体稳定结论",
                "status": "FACT",
                "evidence": [
                    {
                        "path": "相对仓库根目录的文件路径",
                        "line_start": 1,
                        "line_end": 1,
                        "symbol": "函数、类、配置项或测试名",
                        "proves": f"该证据如何支撑完成标准 {index + 1}",
                    }
                ],
            }
            for index, _ in enumerate(acceptance)
        ],
        "acceptance_checks": [
            {
                "criterion_index": index,
                "status": "satisfied",
                "claim_refs": [index],
                "notes": "该结论及其证据如何满足本项完成标准",
            }
            for index, _ in enumerate(acceptance)
        ],
        "updated_assets": (
            []
            if is_recheck
            else [
                f".sdd/modules/{task.get('module', '<module>')}/"
                f"{task.get('module', '<module>')}模块认知说明书.md"
            ]
        ),
        "new_tasks": [],
        "unresolved_issues": [],
    }


def build_command(action: str, module: str, *extra: str) -> str:
    quoted_script = f'"{SCRIPT_PATH}"' if " " in str(SCRIPT_PATH) else str(SCRIPT_PATH)
    quoted_module = json.dumps(module, ensure_ascii=False)
    suffix = " ".join(extra)
    return f"uv run --no-project {quoted_script} {action} --module {quoted_module}" + (
        f" {suffix}" if suffix else ""
    )


def render_prompt(state: dict[str, Any], task: dict[str, Any], root: Path) -> str:
    definitions = load_task_types()
    definition = definitions.get(task["type"])
    if not definition:
        raise CliError(f"未知任务类型：{task['type']}")
    template_path = RECHECK_PROMPT_PATH if task["type"] == "recheck" else TASK_PROMPT_PATH
    template = template_path.read_text("utf-8")
    result_path = finding_path(root, state["module"], task["id"])
    example = result_example({**task, "module": state["module"]})
    replacements = {
        "{{MODULE}}": state["module"],
        "{{SOURCE_PATH}}": state["source_path"],
        "{{ASSET_ROOT}}": state["asset_root"],
        "{{ASSET_SPEC}}": ASSET_SPEC_PATH.as_posix(),
        "{{TEMPLATE_DIR}}": TEMPLATE_DIR.as_posix(),
        "{{BASELINE_COMMIT}}": state["baseline_commit"],
        "{{CURRENT_COMMIT}}": git_head(root),
        "{{TASK_ID}}": task["id"],
        "{{TASK_TYPE}}": task["type"],
        "{{TASK_TITLE}}": task["title"],
        "{{TASK_QUESTION}}": task["question"],
        "{{TASK_CONTEXT}}": task_specific_context(task),
        "{{METHOD}}": bullet_lines(list(definition["method"])),
        "{{ACCEPTANCE}}": bullet_lines(list(task["acceptance"])),
        "{{EVIDENCE_HINTS}}": bullet_lines(list(task["evidence_hints"])),
        "{{EXPANSION_TRIGGERS}}": bullet_lines(list(task["expansion_triggers"])),
        "{{COMPLETED_CONTEXT}}": completed_context(state),
        "{{STABLE_ASSETS}}": stable_asset_context(root, state["module"]),
        "{{OPEN_ISSUES}}": open_issues_context(state),
        "{{RESULT_PATH}}": relative_posix(result_path, root),
        "{{RESULT_EXAMPLE}}": json.dumps(example, ensure_ascii=False, indent=2),
        "{{DONE_COMMAND}}": build_command(
            "done",
            state["module"],
            "--task",
            task["id"],
            "--result",
            json.dumps(relative_posix(result_path, root), ensure_ascii=False),
            "--json",
        ),
    }
    for source, target in replacements.items():
        template = template.replace(source, target)
    return template.strip() + "\n"


def next_payload(state: dict[str, Any], task: dict[str, Any], root: Path) -> dict[str, Any]:
    result = finding_path(root, state["module"], task["id"])
    return {
        "status": "task",
        "phase": state["phase"],
        "module": state["module"],
        "task": {
            "id": task["id"],
            "type": task["type"],
            "title": task["title"],
            "question": task["question"],
            "priority": task["priority"],
            "acceptance": task["acceptance"],
            "evidence_hints": task["evidence_hints"],
            "context": task.get("context") or {},
        },
        "prompt": render_prompt(state, task, root),
        "result_file": relative_posix(result, root),
        "commands": {
            "done": build_command(
                "done",
                state["module"],
                "--task",
                task["id"],
                "--result",
                json.dumps(relative_posix(result, root), ensure_ascii=False),
                "--json",
            ),
            "pause": build_command("pause", state["module"], "--json"),
            "status": build_command("status", state["module"], "--json"),
        },
    }


def command_next(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    path, state = load_state(root, module)
    if state["status"] == "complete":
        return {"status": "complete", "module": module, "message": "模块研究已经完成。"}
    if state["status"] == "active":
        scan_result = scan_history_into_state(root, state)
        if scan_result.get("scanned") or scan_result.get("error"):
            state["updated_at"] = now_iso()
            atomic_write_json(path, state)
    if state["status"] == "paused":
        return {
            "status": "paused",
            "module": module,
            "message": "研究已暂停；先执行 resume 开始新的运行时段。",
            "resume_command": build_command("resume", module, "--json"),
        }
    if state["status"] == "blocked":
        return {
            "status": "blocked",
            "module": module,
            "message": "研究只剩阻塞任务；补充外部材料后执行 resume --reopen-blocked。",
            "issues": [item for item in state["issues"] if item["status"] == "open"],
        }

    running = current_task(state)
    if running:
        return next_payload(state, running, root)

    if budget_exhausted(state):
        stop_session(state, "budget_exhausted")
        state["status"] = "paused"
        state["updated_at"] = now_iso()
        atomic_write_json(path, state)
        return {
            "status": "paused",
            "module": module,
            "reason": "budget_exhausted",
            "elapsed_seconds": state["session"]["elapsed_seconds"],
            "resume_command": build_command("resume", module, "--json"),
        }

    task = select_pending_task(state)
    if task is None:
        blocked = [item for item in state["tasks"] if item["status"] == "blocked"]
        if blocked:
            stop_session(state, "blocked")
            state["status"] = "blocked"
            state["updated_at"] = now_iso()
            atomic_write_json(path, state)
            return {
                "status": "blocked",
                "module": module,
                "tasks": [item["id"] for item in blocked],
                "issues": [item for item in state["issues"] if item["status"] == "open"],
            }
        return {
            "status": "needs_recheck",
            "module": module,
            "message": "普通研究任务已清空；执行 recheck 创建独立审查任务。",
            "recheck_command": build_command("recheck", module, "--json"),
        }

    task["status"] = "running"
    task["started_at"] = now_iso()
    task["asset_snapshot"] = snapshot_stable_assets(root, module)
    state["current_task_id"] = task["id"]
    state["updated_at"] = now_iso()
    atomic_write_json(path, state)
    return next_payload(state, task, root)


def require_text(data: dict[str, Any], field: str, label: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise CliError(f"{label}.{field} 必须是非空字符串")
    return value.strip()


def require_string_list(data: dict[str, Any], field: str, label: str) -> list[str]:
    value = data.get(field)
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise CliError(f"{label}.{field} 必须是字符串数组")
    return [item.strip() for item in value]


def validate_evidence(
    root: Path, module: str, evidence: dict[str, Any], label: str
) -> None:
    if any(field in evidence for field in ("commit", "revision", "historical_path")):
        raise CliError(
            f"{label} 不能把 Git 提交或历史文件作为事实证据；"
            "请引用当前 HEAD 中的代码、测试、配置或当前有效文档"
        )
    raw_path = require_text(evidence, "path", label)
    path = Path(raw_path)
    if path.is_absolute():
        raise CliError(f"{label}.path 必须使用仓库相对路径")
    resolved = ensure_within(root / path, root, f"{label}.path")
    if not resolved.is_file():
        raise CliError(f"{label}.path 不是现有文件：{raw_path}")
    generated_root = module_root(root, module).resolve()
    if resolved == generated_root or generated_root in resolved.parents:
        raise CliError(f"{label}.path 不能把本次生成的认知资产或 findings 当作原始证据")
    require_text(evidence, "proves", label)
    line_start = evidence.get("line_start")
    line_end = evidence.get("line_end", line_start)
    if line_start is None:
        return
    if isinstance(line_start, bool) or not isinstance(line_start, int) or line_start <= 0:
        raise CliError(f"{label}.line_start 必须是正整数")
    if isinstance(line_end, bool) or not isinstance(line_end, int) or line_end < line_start:
        raise CliError(f"{label}.line_end 必须是不小于 line_start 的整数")
    line_count = len(resolved.read_text("utf-8", errors="ignore").splitlines())
    if line_end > max(1, line_count):
        raise CliError(f"{label} 行号超出文件范围：{line_end} > {line_count}")


def validate_claims(
    root: Path, module: str, claims: Any, required: bool
) -> list[dict[str, Any]]:
    if not isinstance(claims, list) or (required and not claims):
        raise CliError("claims 必须是非空数组")
    for index, claim in enumerate(claims):
        label = f"claims[{index}]"
        if not isinstance(claim, dict):
            raise CliError(f"{label} 必须是 object")
        require_text(claim, "statement", label)
        status = claim.get("status")
        if status not in CLAIM_STATUSES:
            raise CliError(f"{label}.status 必须是 {sorted(CLAIM_STATUSES)} 之一")
        evidence = claim.get("evidence")
        if not isinstance(evidence, list):
            raise CliError(f"{label}.evidence 必须是数组")
        if status != "BLOCKED" and not evidence:
            raise CliError(f"{label} 的 {status} 结论必须包含证据")
        for evidence_index, item in enumerate(evidence):
            if not isinstance(item, dict):
                raise CliError(f"{label}.evidence[{evidence_index}] 必须是 object")
            validate_evidence(
                root, module, item, f"{label}.evidence[{evidence_index}]"
            )
    return claims


def validate_acceptance_checks(
    task: dict[str, Any],
    raw_checks: Any,
    claims: list[dict[str, Any]],
    outcome: str,
) -> list[dict[str, Any]]:
    acceptance = list(task["acceptance"])
    if not isinstance(raw_checks, list):
        raise CliError("acceptance_checks 必须是数组")
    if len(raw_checks) != len(acceptance):
        raise CliError(
            "acceptance_checks 必须逐项覆盖完成标准："
            f"期望 {len(acceptance)} 项，实际 {len(raw_checks)} 项"
        )
    seen: set[int] = set()
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(raw_checks):
        label = f"acceptance_checks[{index}]"
        if not isinstance(item, dict):
            raise CliError(f"{label} 必须是 object")
        criterion_index = item.get("criterion_index")
        if (
            isinstance(criterion_index, bool)
            or not isinstance(criterion_index, int)
            or not 0 <= criterion_index < len(acceptance)
        ):
            raise CliError(f"{label}.criterion_index 超出完成标准范围")
        if criterion_index in seen:
            raise CliError(f"{label}.criterion_index 重复：{criterion_index}")
        status = item.get("status")
        if status not in ACCEPTANCE_STATUSES:
            raise CliError(
                f"{label}.status 必须是 {sorted(ACCEPTANCE_STATUSES)} 之一"
            )
        claim_refs = item.get("claim_refs")
        if not isinstance(claim_refs, list) or any(
            isinstance(value, bool)
            or not isinstance(value, int)
            or not 0 <= value < len(claims)
            for value in claim_refs
        ):
            raise CliError(f"{label}.claim_refs 必须是有效的 claims 下标数组")
        if status == "satisfied" and not claim_refs:
            raise CliError(f"{label} 已满足时必须引用至少一条 claim")
        notes = require_text(item, "notes", label)
        seen.add(criterion_index)
        normalized.append(
            {
                "criterion_index": criterion_index,
                "status": status,
                "claim_refs": claim_refs,
                "notes": notes,
            }
        )
    if seen != set(range(len(acceptance))):
        raise CliError("acceptance_checks 未完整覆盖完成标准")
    statuses = {item["status"] for item in normalized}
    if outcome == "completed" and statuses != {"satisfied"}:
        raise CliError("outcome=completed 时所有完成标准都必须是 satisfied")
    if outcome == "split" and statuses == {"satisfied"}:
        raise CliError("outcome=split 时至少一项完成标准必须是 partial 或 blocked")
    if outcome == "blocked" and "blocked" not in statuses:
        raise CliError("outcome=blocked 时至少一项完成标准必须是 blocked")
    return normalized


def validate_git_change_current_code_evidence(
    root: Path,
    state: dict[str, Any],
    claims: list[dict[str, Any]],
) -> None:
    source_root = ensure_within(
        root / state["source_path"],
        root,
        "source_path",
    )
    for index, claim in enumerate(claims):
        if claim.get("status") == "BLOCKED":
            continue
        has_current_code = False
        for evidence in claim.get("evidence", []):
            resolved = (root / evidence["path"]).resolve()
            if resolved == source_root or source_root in resolved.parents:
                has_current_code = True
                break
        if not has_current_code:
            raise CliError(
                f"claims[{index}] 来自 git-change 任务，必须至少引用一处"
                f"当前模块源码 {state['source_path']} 下的证据；"
                "Git 历史、测试或说明材料只能作为辅助线索"
            )


def find_document_contract(
    root: Path, module: str, path: Path
) -> tuple[dict[str, Any], str]:
    base = module_root(root, module)
    relative = path.resolve().relative_to(base.resolve()).as_posix()
    definitions = load_document_contracts()
    for contract in definitions["contracts"]:
        pattern = str(contract["match"]).replace("{module}", module)
        if fnmatch.fnmatchcase(relative, pattern):
            return contract, relative
    raise CliError(f"稳定认知文档没有对应格式契约：{relative}")


def validate_document_contract(
    root: Path,
    module: str,
    path: Path,
    *,
    final: bool,
    require_completed_status: bool = False,
) -> None:
    if path.suffix.lower() != ".md":
        raise CliError(f"稳定认知资产只接受 Markdown 文档：{path.name}")
    contract, relative = find_document_contract(root, module, path)
    content = path.read_text("utf-8")
    errors: list[str] = []
    if not content.startswith("# "):
        errors.append("必须以一级标题开头")
    for field in contract["metadata"]:
        pattern = rf"(?m)^- {re.escape(str(field))}：\S.*$"
        if not re.search(pattern, content):
            errors.append(f"缺少非空元信息：{field}")
    for heading in contract["required_headings"]:
        count = sum(1 for line in content.splitlines() if line.strip() == heading)
        if count == 0:
            errors.append(f"缺少标题：{heading}")
        elif count > 1:
            errors.append(f"标题重复：{heading}")
    if final:
        definitions = load_document_contracts()
        for forbidden in definitions.get("final_forbidden_patterns", []):
            if str(forbidden).lower() in content.lower():
                errors.append(f"仍包含占位内容：{forbidden}")
        if not re.search(r"\[(FACT|INFERRED|CONFIRMED|BLOCKED)\]", content):
            errors.append("至少需要一条带 [FACT]/[INFERRED]/[CONFIRMED]/[BLOCKED] 的结论")
        if "证据：" not in content:
            errors.append("至少需要一处“证据：...”原始证据说明")
        if require_completed_status:
            status_line = (
                "- 状态：已完成"
                if contract["id"] == "module-overview"
                else "- 文档状态：已完成"
            )
            if status_line not in content:
                errors.append(f"最终文档必须包含：{status_line}")
    if errors:
        raise CliError(f"文档格式不合格 {relative}：" + "；".join(errors))


def stable_markdown_files(root: Path, module: str) -> list[Path]:
    base = module_root(root, module)
    process = base / "研究过程"
    result: list[Path] = []
    for path in base.rglob("*.md"):
        resolved = path.resolve()
        if resolved == process.resolve() or process.resolve() in resolved.parents:
            continue
        result.append(path)
    return sorted(result)


def validate_all_documents(
    root: Path,
    module: str,
    *,
    require_completed_status: bool = False,
) -> None:
    base = module_root(root, module)
    required = [
        base / f"{module}模块认知说明书.md",
        base / "数据模型与状态.md",
        base / "约束与风险.md",
    ]
    missing = [relative_posix(path, root) for path in required if not path.is_file()]
    if missing:
        raise CliError("缺少必需认知文档：" + ", ".join(missing))
    feature_files = sorted((base / "业务功能").rglob("*.md"))
    if not feature_files:
        raise CliError("最终认知至少需要一个业务流程或非流程功能点文档")
    documents = stable_markdown_files(root, module)
    for document in documents:
        validate_document_contract(
            root,
            module,
            document,
            final=True,
            require_completed_status=require_completed_status,
        )
    overview = required[0].read_text("utf-8")
    missing_index: list[str] = []
    for feature in feature_files:
        relative = feature.resolve().relative_to(base.resolve()).as_posix()
        if relative not in overview:
            missing_index.append(relative)
    if missing_index:
        raise CliError("功能索引缺少文档链接：" + ", ".join(missing_index))


def finalize_document_metadata(root: Path, module: str) -> None:
    date = datetime.now().date().isoformat()
    head = git_head(root)
    for path in stable_markdown_files(root, module):
        contract, _ = find_document_contract(root, module, path)
        content = path.read_text("utf-8")
        if contract["id"] == "module-overview":
            content = re.sub(r"(?m)^- 状态：.*$", "- 状态：已完成", content)
            content = re.sub(
                r"(?m)^- 最后同步提交：.*$",
                f"- 最后同步提交：{head}",
                content,
            )
        else:
            content = re.sub(
                r"(?m)^- 文档状态：.*$", "- 文档状态：已完成", content
            )
        content = re.sub(
            r"(?m)^- 最后更新：.*$", f"- 最后更新：{date}", content
        )
        path.write_text(content, "utf-8")


def reopen_document_metadata(root: Path, module: str) -> None:
    date = datetime.now().date().isoformat()
    for path in stable_markdown_files(root, module):
        contract, _ = find_document_contract(root, module, path)
        content = path.read_text("utf-8")
        if contract["id"] == "module-overview":
            content = re.sub(r"(?m)^- 状态：.*$", "- 状态：研究中", content)
        else:
            content = re.sub(
                r"(?m)^- 文档状态：.*$",
                "- 文档状态：研究中",
                content,
            )
        content = re.sub(
            r"(?m)^- 最后更新：.*$",
            f"- 最后更新：{date}",
            content,
        )
        path.write_text(content, "utf-8")


def validate_updated_assets(
    root: Path,
    module: str,
    values: Any,
    required: bool,
    snapshot: dict[str, str],
) -> list[str]:
    if not isinstance(values, list) or any(not isinstance(item, str) for item in values):
        raise CliError("updated_assets 必须是字符串数组")
    if required and not values:
        raise CliError("完成普通研究任务时 updated_assets 不能为空")
    stable_root = module_root(root, module)
    process_root = stable_root / "研究过程"
    result: list[str] = []
    for index, raw in enumerate(values):
        path = Path(raw)
        if path.is_absolute():
            raise CliError(f"updated_assets[{index}] 必须使用仓库相对路径")
        resolved = ensure_within(root / path, stable_root, f"updated_assets[{index}]")
        if resolved == process_root.resolve() or process_root.resolve() in resolved.parents:
            raise CliError("findings 和 research-state 不算稳定认知资产")
        if not resolved.is_file():
            raise CliError(f"updated_assets[{index}] 不是现有文件：{raw}")
        relative = relative_posix(resolved, root)
        if required and snapshot.get(relative) == file_sha256(resolved):
            raise CliError(f"updated_assets[{index}] 内容相对任务开始时没有变化：{relative}")
        validate_document_contract(root, module, resolved, final=False)
        result.append(relative)
    return result


def task_signature(title: str, question: str) -> str:
    return re.sub(r"\s+", "", f"{title}|{question}").lower()


def validate_new_tasks(
    state: dict[str, Any],
    raw_tasks: Any,
    definitions: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(raw_tasks, list):
        raise CliError("new_tasks 必须是数组")
    existing = {
        task_signature(item["title"], item["question"])
        for item in state["tasks"]
        if item["status"] != "blocked"
    }
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(raw_tasks):
        label = f"new_tasks[{index}]"
        if not isinstance(item, dict):
            raise CliError(f"{label} 必须是 object")
        task_type = require_text(item, "type", label)
        if task_type not in definitions or task_type in {
            "recheck",
            "git-change",
            "user-question",
        }:
            raise CliError(f"{label}.type 不是可用研究任务类型：{task_type}")
        title = require_text(item, "title", label)
        question = require_text(item, "question", label)
        signature = task_signature(title, question)
        if signature in existing:
            continue
        priority = item.get("priority", definitions[task_type]["priority"])
        if isinstance(priority, bool) or not isinstance(priority, int) or not 1 <= priority <= 100:
            raise CliError(f"{label}.priority 必须是 1..100 的整数")
        evidence_hints = item.get("evidence_hints", [])
        if not isinstance(evidence_hints, list) or any(not isinstance(value, str) for value in evidence_hints):
            raise CliError(f"{label}.evidence_hints 必须是字符串数组")
        acceptance = item.get("acceptance", definitions[task_type]["acceptance"])
        if not isinstance(acceptance, list) or not acceptance or any(
            not isinstance(value, str) or not value.strip() for value in acceptance
        ):
            raise CliError(f"{label}.acceptance 必须是非空字符串数组")
        normalized.append(
            {
                "type": task_type,
                "title": title,
                "question": question,
                "priority": priority,
                "evidence_hints": [value.strip() for value in evidence_hints],
                "acceptance": [value.strip() for value in acceptance],
                "expansion_triggers": list(definitions[task_type]["expansion_triggers"]),
            }
        )
        existing.add(signature)
    return normalized


def command_done(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    path, state = load_state(root, module)
    if state["status"] == "complete":
        raise CliError("模块研究已经完成，不能继续提交任务")
    was_paused = state["status"] == "paused"
    task = current_task(state)
    if not task or task["id"] != args.task:
        raise CliError(f"当前 running 任务不是 {args.task}")
    if task["type"] == "recheck":
        history_scan = scan_history_into_state(root, state)
        if history_scan.get("created_tasks"):
            task["status"] = "split"
            task["summary"] = "审查期间发现新的模块提交，返回研究阶段刷新认知。"
            task["ended_at"] = now_iso()
            state["current_task_id"] = None
            state["phase"] = "research"
            state["status"] = "active"
            state["updated_at"] = now_iso()
            atomic_write_json(path, state)
            return {
                "status": "active",
                "phase": "research",
                "task_id": task["id"],
                "task_outcome": "superseded_by_new_commits",
                "created_tasks": history_scan["created_tasks"],
                "next_command": build_command("next", module, "--json"),
            }

    expected = finding_path(root, module, task["id"])
    result_arg = Path(args.result)
    if not result_arg.is_absolute():
        result_arg = root / result_arg
    result_arg = ensure_within(result_arg, root, "result")
    if result_arg != expected.resolve():
        raise CliError(f"result 必须写入当前任务指定位置：{relative_posix(expected, root)}")
    result = load_json(result_arg, "研究结果")
    if result.get("task_id") != task["id"]:
        raise CliError("研究结果 task_id 与当前任务不一致")
    outcome = result.get("outcome")
    if outcome not in OUTCOMES:
        raise CliError(f"outcome 必须是 {sorted(OUTCOMES)} 之一")
    summary = require_text(result, "summary", "result")
    is_recheck = task["type"] == "recheck"
    claims = validate_claims(
        root,
        module,
        result.get("claims"),
        required=outcome == "completed",
    )
    if task["type"] == "git-change" and outcome == "completed":
        validate_git_change_current_code_evidence(root, state, claims)
    validate_acceptance_checks(
        task,
        result.get("acceptance_checks"),
        claims,
        outcome,
    )
    updated_assets = validate_updated_assets(
        root,
        module,
        result.get("updated_assets"),
        required=(
            outcome == "completed"
            and not is_recheck
            and task["type"] not in {"git-change", "user-question"}
        ),
        snapshot=task.get("asset_snapshot") or {},
    )
    definitions = load_task_types()
    new_tasks = validate_new_tasks(state, result.get("new_tasks"), definitions)
    unresolved = result.get("unresolved_issues")
    if not isinstance(unresolved, list) or any(not isinstance(item, dict) for item in unresolved):
        raise CliError("unresolved_issues 必须是 object 数组")
    if outcome == "split" and len(new_tasks) < 2:
        raise CliError("outcome=split 时至少提交两个不重复的 new_tasks")
    if outcome == "blocked" and not unresolved:
        raise CliError("outcome=blocked 时至少提交一个 unresolved_issue")
    will_complete = (
        is_recheck
        and outcome == "completed"
        and not new_tasks
        and not unresolved
    )
    if will_complete:
        validate_all_documents(root, module)
        finalize_document_metadata(root, module)
        validate_all_documents(root, module, require_completed_status=True)

    for item in new_tasks:
        create_task(
            state,
            task_type=item["type"],
            title=item["title"],
            question=item["question"],
            priority=item["priority"],
            evidence_hints=item["evidence_hints"],
            acceptance=item["acceptance"],
            expansion_triggers=item["expansion_triggers"],
            parent_id=task["id"],
            reason="discovered",
        )
    created_issues = [create_issue(state, task["id"], item) for item in unresolved]

    task["status"] = outcome
    task["summary"] = summary
    task["ended_at"] = now_iso()
    task["finding_file"] = relative_posix(expected, root)
    task["updated_assets"] = updated_assets
    state["current_task_id"] = None

    if is_recheck:
        if new_tasks:
            state["phase"] = "research"
            state["status"] = "active"
        elif created_issues:
            stop_session(state, "blocked_after_recheck")
            state["status"] = "blocked"
        elif outcome != "completed":
            raise CliError("recheck 只有 completed 且无新任务/未解问题时才能通过")
        else:
            stop_session(state, "complete")
            state["phase"] = "complete"
            state["status"] = "complete"
            state["completed_at"] = now_iso()
    elif was_paused:
        state["status"] = "paused"
    elif budget_exhausted(state):
        stop_session(state, "budget_exhausted")
        state["status"] = "paused"
    else:
        state["status"] = "active"

    state["updated_at"] = now_iso()
    atomic_write_json(path, state)
    return {
        "status": state["status"],
        "phase": state["phase"],
        "task_id": task["id"],
        "task_outcome": outcome,
        "created_tasks": [item["id"] for item in state["tasks"] if item.get("parent_id") == task["id"]],
        "created_issues": [item["id"] for item in created_issues],
        "next_command": None if state["status"] == "complete" else build_command("next", module, "--json"),
    }


def status_payload(state: dict[str, Any]) -> dict[str, Any]:
    counts: dict[str, int] = {key: 0 for key in TASK_STATUSES}
    for task in state["tasks"]:
        counts[task["status"]] = counts.get(task["status"], 0) + 1
    session = state["session"]
    elapsed = active_elapsed(state)
    cumulative = int(session.get("total_elapsed_seconds", 0)) + elapsed
    return {
        "status": state["status"],
        "phase": state["phase"],
        "module": state["module"],
        "source_path": state["source_path"],
        "baseline_commit": state["baseline_commit"],
        "current_task_id": state["current_task_id"],
        "tasks": counts,
        "open_issues": [item for item in state["issues"] if item["status"] == "open"],
        "history": {
            "mode": state["history"]["mode"],
            "last_scanned_head": state["history"].get("last_scanned_head"),
            "last_scanned_at": state["history"].get("last_scanned_at"),
            "commit_count": state["history"].get("commit_count", 0),
            "tracked_commits": len(state["history"].get("commit_tasks", {})),
            "scan_error": state["history"].get("scan_error"),
        },
        "session": {
            "budget_seconds": session["budget_seconds"],
            "elapsed_seconds": elapsed,
            "elapsed": format_duration(elapsed),
            "cumulative_elapsed_seconds": cumulative,
            "cumulative_elapsed": format_duration(cumulative),
            "remaining_seconds": max(0, int(session["budget_seconds"]) - elapsed),
            "active": bool(session.get("active_started_at")),
        },
    }


def command_status(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    _, state = load_state(root, module)
    payload = status_payload(state)
    if state["status"] == "active":
        payload["recommended_command"] = build_command("next", module, "--json")
    elif state["status"] == "paused":
        payload["recommended_command"] = build_command("resume", module, "--json")
    elif state["status"] == "blocked":
        payload["recommended_command"] = build_command(
            "resume", module, "--reopen-blocked", "--json"
        )
    return payload


def command_history_sync(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    path, state = load_state(root, module)
    if state["status"] == "complete":
        raise CliError("已经完成的研究不能新增 Git 历史任务")
    result = scan_history_into_state(root, state, force=args.force)
    state["updated_at"] = now_iso()
    atomic_write_json(path, state)
    return {
        "status": "history_synced" if result.get("scanned") else "history_unchanged",
        "module": module,
        **result,
        "next_command": build_command("next", module, "--json"),
    }


def begin_new_session(state: dict[str, Any], budget: int | None = None) -> None:
    session = state["session"]
    session["total_elapsed_seconds"] = int(
        session.get("total_elapsed_seconds", 0)
    ) + int(session.get("elapsed_seconds", 0))
    session["elapsed_seconds"] = 0
    session["active_started_at"] = now_iso()
    session["last_stopped_at"] = None
    session["last_stop_reason"] = None
    if budget is not None:
        session["budget_seconds"] = budget


def normalized_question(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def command_add_question(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    path, state = load_state(root, module)
    question = args.question.strip()
    if not question:
        raise CliError("question 不能为空")
    original_status = state["status"]

    existing = next(
        (
            task
            for task in state["tasks"]
            if task["type"] == "user-question"
            and task["status"] in {"pending", "running"}
            and normalized_question(task["question"]) == normalized_question(question)
        ),
        None,
    )
    if existing:
        reopened = state["status"] != "active"
        if reopened:
            begin_new_session(state, args.budget)
            state["status"] = "active"
            state["phase"] = "research"
            state["completed_at"] = None
            if original_status == "complete":
                reopen_document_metadata(root, module)
            state["updated_at"] = now_iso()
            atomic_write_json(path, state)
        return {
            "status": "question_exists",
            "module": module,
            "task_id": existing["id"],
            "task_status": existing["status"],
            "reopened": reopened,
            "next_command": build_command("next", module, "--json"),
        }

    invalidated_rechecks: list[str] = []
    for task in state["tasks"]:
        if task["type"] != "recheck" or task["status"] not in {"pending", "running"}:
            continue
        task["status"] = "split"
        task["summary"] = "用户补充了新的模块问题，本轮审查失效并返回研究阶段。"
        task["ended_at"] = now_iso()
        invalidated_rechecks.append(task["id"])
        if state.get("current_task_id") == task["id"]:
            state["current_task_id"] = None

    definition = load_task_types()["user-question"]
    evidence_hints = [
        value.strip()
        for value in (args.evidence_hint or [])
        if value.strip()
    ] or [state["source_path"]]
    title = (args.title or "研究用户补充问题").strip()
    if not title:
        raise CliError("title 不能为空")
    task = create_task(
        state,
        task_type="user-question",
        title=title,
        question=question,
        priority=args.priority,
        evidence_hints=evidence_hints,
        acceptance=list(definition["acceptance"]),
        expansion_triggers=list(definition["expansion_triggers"]),
        reason="user-question",
        context={
            "source": "user",
            "submitted_at": now_iso(),
            "original_question": question,
        },
    )

    was_inactive = state["status"] != "active"
    if was_inactive:
        begin_new_session(state, args.budget)
    elif args.budget is not None:
        state["session"]["budget_seconds"] = args.budget
    state["status"] = "active"
    state["phase"] = "research"
    state["completed_at"] = None
    if original_status == "complete":
        reopen_document_metadata(root, module)
    state["updated_at"] = now_iso()
    atomic_write_json(path, state)
    return {
        "status": "question_added",
        "module": module,
        "task_id": task["id"],
        "priority": task["priority"],
        "reopened": was_inactive,
        "invalidated_rechecks": invalidated_rechecks,
        "next_command": build_command("next", module, "--json"),
    }


def command_pause(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    path, state = load_state(root, module)
    if state["status"] == "complete":
        raise CliError("已经完成的研究不能暂停")
    if state["status"] == "blocked":
        raise CliError("blocked 研究应补充材料后 resume --reopen-blocked，不能改为 paused")
    if state["status"] != "paused":
        stop_session(state, args.reason or "manual_pause")
        state["status"] = "paused"
        state["updated_at"] = now_iso()
        atomic_write_json(path, state)
    return {
        "status": "paused",
        "module": module,
        "current_task_id": state["current_task_id"],
        "elapsed_seconds": state["session"]["elapsed_seconds"],
        "resume_command": build_command("resume", module, "--json"),
    }


def command_resume(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    path, state = load_state(root, module)
    if state["status"] == "complete":
        raise CliError("已经完成的研究不能恢复")
    if state["status"] == "active":
        return {
            "status": "active",
            "module": module,
            "message": "研究已经处于 active 状态。",
            "next_command": build_command("next", module, "--json"),
        }
    if state["status"] == "blocked":
        if not args.reopen_blocked:
            raise CliError("研究处于 blocked；补充材料后使用 --reopen-blocked")
        for task in state["tasks"]:
            if task["status"] == "blocked":
                task["status"] = "pending"
                task["started_at"] = None
                task["ended_at"] = None
        for issue in state["issues"]:
            if issue["status"] == "open":
                issue["status"] = "reopened"
                issue["resolved_at"] = now_iso()
    state["status"] = "active"
    state["session"]["budget_seconds"] = args.budget or state["session"]["budget_seconds"]
    state["session"]["total_elapsed_seconds"] = int(
        state["session"].get("total_elapsed_seconds", 0)
    ) + int(state["session"].get("elapsed_seconds", 0))
    state["session"]["elapsed_seconds"] = 0
    state["session"]["active_started_at"] = now_iso()
    state["session"]["last_stop_reason"] = None
    state["updated_at"] = now_iso()
    atomic_write_json(path, state)
    return {
        "status": "active",
        "module": module,
        "budget_seconds": state["session"]["budget_seconds"],
        "next_command": build_command("next", module, "--json"),
    }


def command_recheck(args: argparse.Namespace) -> dict[str, Any]:
    root = repo_root()
    module = validate_module_name(args.module)
    path, state = load_state(root, module)
    if state["status"] != "active":
        raise CliError("只有 active 研究可以进入 recheck")
    if current_task(state):
        raise CliError("当前仍有 running 任务，不能进入 recheck")
    scan_result = scan_history_into_state(root, state)
    if scan_result.get("scanned") or scan_result.get("error"):
        state["updated_at"] = now_iso()
        atomic_write_json(path, state)
    unfinished = [task for task in state["tasks"] if task["status"] == "pending"]
    if unfinished:
        raise CliError("仍有 pending 任务，不能进入 recheck")
    blocked = [task for task in state["tasks"] if task["status"] == "blocked"]
    if blocked:
        raise CliError("仍有 blocked 任务，不能进入 recheck")
    if any(task["type"] == "recheck" and task["status"] in {"pending", "running"} for task in state["tasks"]):
        raise CliError("已经存在未完成的 recheck 任务")

    definition = load_task_types()["recheck"]
    task = create_task(
        state,
        task_type="recheck",
        title=definition["title"],
        question=definition["question"],
        priority=100,
        evidence_hints=[state["asset_root"], state["source_path"]],
        acceptance=list(definition["acceptance"]),
        expansion_triggers=list(definition["expansion_triggers"]),
        reason="recheck",
    )
    state["phase"] = "recheck"
    state["updated_at"] = now_iso()
    atomic_write_json(path, state)
    return {
        "status": "recheck_created",
        "module": module,
        "task_id": task["id"],
        "next_command": build_command("next", module, "--json"),
    }


def add_common_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="输出机器可读 JSON")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="deep-research",
        description="独立的模块深度研究任务与时长协调 CLI。",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="初始化模块研究")
    init.add_argument("--module", required=True)
    init.add_argument("--path", required=True, help="模块源码路径，相对仓库根目录")
    init.add_argument("--budget", type=parse_budget, default=parse_budget("45m"))
    init.add_argument(
        "--history-mode",
        choices=sorted(HISTORY_MODES),
        default="full",
        help="full：回溯全部模块提交并持续刷新；off：关闭 Git 历史任务",
    )
    add_common_flags(init)
    init.set_defaults(handler=command_init)

    next_parser = subparsers.add_parser("next", help="领取当前唯一研究任务")
    next_parser.add_argument("--module", required=True)
    add_common_flags(next_parser)
    next_parser.set_defaults(handler=command_next)

    done = subparsers.add_parser("done", help="提交当前任务结果")
    done.add_argument("--module", required=True)
    done.add_argument("--task", required=True)
    done.add_argument("--result", required=True)
    add_common_flags(done)
    done.set_defaults(handler=command_done)

    status = subparsers.add_parser("status", help="查看研究状态")
    status.add_argument("--module", required=True)
    add_common_flags(status)
    status.set_defaults(handler=command_status)

    history_sync = subparsers.add_parser(
        "history-sync",
        help="扫描模块 Git 提交并补充历史反查任务",
    )
    history_sync.add_argument("--module", required=True)
    history_sync.add_argument("--force", action="store_true")
    add_common_flags(history_sync)
    history_sync.set_defaults(handler=command_history_sync)

    add_question = subparsers.add_parser(
        "add-question",
        help="追加用户问题，并在需要时重新打开已完成研究",
    )
    add_question.add_argument("--module", required=True)
    add_question.add_argument("--question", required=True)
    add_question.add_argument("--title")
    add_question.add_argument("--priority", type=parse_priority, default=100)
    add_question.add_argument(
        "--evidence-hint",
        action="append",
        help="建议优先取证位置，可重复提供",
    )
    add_question.add_argument(
        "--budget",
        type=parse_budget,
        help="重新打开非 active 研究时的新运行预算",
    )
    add_common_flags(add_question)
    add_question.set_defaults(handler=command_add_question)

    pause = subparsers.add_parser("pause", help="暂停当前研究")
    pause.add_argument("--module", required=True)
    pause.add_argument("--reason")
    add_common_flags(pause)
    pause.set_defaults(handler=command_pause)

    resume = subparsers.add_parser("resume", help="恢复研究并开启新的运行时段")
    resume.add_argument("--module", required=True)
    resume.add_argument("--budget", type=parse_budget)
    resume.add_argument("--reopen-blocked", action="store_true")
    add_common_flags(resume)
    resume.set_defaults(handler=command_resume)

    recheck = subparsers.add_parser("recheck", help="创建交付前独立审查任务")
    recheck.add_argument("--module", required=True)
    add_common_flags(recheck)
    recheck.set_defaults(handler=command_recheck)
    return parser


def emit(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    status = payload.get("status", "ok")
    print(f"[{status}]")
    for key, value in payload.items():
        if key == "status":
            continue
        if isinstance(value, (dict, list)):
            print(f"{key}: {json.dumps(value, ensure_ascii=False)}")
        else:
            print(f"{key}: {value}")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        payload = args.handler(args)
    except CliError as exc:
        if getattr(args, "json", False):
            print(
                json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False),
                file=sys.stderr,
            )
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 2
    emit(payload, getattr(args, "json", False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
