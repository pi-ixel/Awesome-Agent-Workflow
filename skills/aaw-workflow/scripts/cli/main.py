"""AAW Workflow CLI — configuration-driven workflow state management."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from .models import DataError, WorkflowError
from .telemetry import TelemetryClient, TelemetryError, TelemetryStore, aaw_version
from .workflow import WorkflowManager

app = typer.Typer(
    name="aaw",
    help="AAW Workflow CLI",
    no_args_is_help=True,
)
telemetry_app = typer.Typer(help="Offline-first workflow telemetry")
app.add_typer(telemetry_app, name="telemetry")

SDD = Path(".sdd")


def _print_version(value: bool) -> None:
    if value:
        typer.echo(aaw_version())
        raise typer.Exit()


@app.callback()
def app_callback(
    version: Annotated[bool, typer.Option("--version", callback=_print_version, is_eager=True, help="Show the unified AAW release version")] = False,
) -> None:
    """AAW Workflow CLI."""


def _get_manager() -> WorkflowManager:
    return WorkflowManager(SDD)


def _get_telemetry() -> TelemetryStore:
    return TelemetryStore(Path.cwd())


def _die(msg: str, code: int = 1) -> None:
    typer.echo(msg, err=True)
    raise typer.Exit(code)


def _echo_json(data: dict) -> None:
    typer.echo(json.dumps(data, ensure_ascii=False, indent=2))


def _parse_vars(
    raw_vars: list[str] | None,
    sr: str | None,
    ar: str | None,
    title: str | None,
) -> dict[str, str]:
    vars_: dict[str, str] = {}
    for item in raw_vars or []:
        if "=" not in item:
            raise WorkflowError(f"--var 格式错误，应为 KEY=VALUE: {item}")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise WorkflowError(f"--var 缺少 key: {item}")
        vars_[key] = value
    if sr:
        vars_["SR"] = sr
    if ar:
        vars_["AR"] = ar
    if title:
        vars_["描述"] = title
    if "描述" not in vars_:
        if "TITLE" in vars_:
            vars_["描述"] = vars_["TITLE"]
        elif "DESC" in vars_:
            vars_["描述"] = vars_["DESC"]
    return vars_


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

@app.command()
def start(
    entry: Annotated[str, typer.Option("--entry", help="入口名称，如 sr / ar")] = "sr",
    var: Annotated[list[str] | None, typer.Option("--var", help="入口变量，格式 KEY=VALUE")] = None,
    sr: Annotated[str | None, typer.Option("--sr", help="SR 需求号，等价于 --var SR=...")] = None,
    ar: Annotated[str | None, typer.Option("--ar", help="AR 编号，等价于 --var AR=...")] = None,
    title: Annotated[str | None, typer.Option("--title", help="AR 描述，等价于 --var 描述=...")] = None,
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON 输出")] = False,
):
    """创建 workflow.yaml，并放入配置指定的入口节点。"""
    mgr = _get_manager()
    try:
        vars_ = _parse_vars(var, sr, ar, title)
        wf = mgr.start(entry, vars_)
    except WorkflowError as e:
        _die(str(e))

    # This is a local append only write: a telemetry outage never prevents a
    # workflow from starting.
    try:
        _get_telemetry().workflow_started(wf)
    except (OSError, TelemetryError) as e:
        typer.echo(f"telemetry warning: {e}", err=True)

    payload = {
        "ok": True,
        "sr": wf.sr,
        "entry": wf.entry,
        "workflow": str(mgr._wf_path(wf.sr)),
        "steps": [{"id": s.id, "type": s.type, "name": s.name} for s in wf.steps],
    }
    if use_json:
        _echo_json(payload)
    else:
        typer.echo(f"SR {wf.sr} 已启动，入口 {wf.entry}")
        typer.echo(f"  {mgr._wf_path(wf.sr)}")
        typer.echo("  下一步: aaw next --sr <SR> --json")


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

@app.command()
def status(
    sr: Annotated[str | None, typer.Option("--sr", help="SR 需求号")] = None,
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON 输出")] = False,
):
    """查看工作流进度。"""
    mgr = _get_manager()

    if sr is None:
        if not SDD.exists():
            srs: list[str] = []
        else:
            srs = [d.name for d in SDD.iterdir() if d.is_dir() and (d / "workflow.yaml").exists()]
        if use_json:
            _echo_json({"srs": sorted(srs)})
        elif srs:
            typer.echo("SR 列表:")
            for s in sorted(srs):
                wf = mgr.load(s)
                done_count = sum(1 for st in wf.steps if st.finished)
                total = len(wf.steps)
                typer.echo(f"  {s}  [{done_count}/{total}]  {wf.status}  entry={wf.entry}")
        else:
            typer.echo("暂无 SR")
        return

    try:
        wf = mgr.load(sr)
    except WorkflowError as e:
        _die(str(e))

    data = {
        "sr": wf.sr,
        "entry": wf.entry,
        "status": wf.status,
        "vars": wf.vars,
        "steps": [
            {
                "id": s.id,
                "type": s.type,
                "name": s.name,
                "execution": s.execution,
                "finished": s.finished,
                "next": s.next,
            }
            for s in wf.steps
        ],
    }
    if use_json:
        _echo_json(data)
    else:
        typer.echo(f"SR: {wf.sr}  [{wf.status}]  entry={wf.entry}")
        typer.echo()
        for s in wf.steps:
            mark = "✅" if s.finished else "❌"
            typer.echo(f"  {mark}  step {s.id}: {s.name}  ({s.type}, {s.execution})")


# ---------------------------------------------------------------------------
# next
# ---------------------------------------------------------------------------

@app.command()
def next(
    sr: Annotated[str, typer.Option("--sr", help="SR 需求号")],
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON 输出")] = False,
):
    """获取下一个（或多个）就绪工作单。"""
    mgr = _get_manager()
    try:
        wf = mgr.load(sr)
    except WorkflowError as e:
        _die(str(e))

    payload = mgr.build_next_payload(wf)
    if use_json:
        _echo_json(payload)
        return

    if payload["done"]:
        typer.echo("🎉 工作流完成")
        return
    if not payload["ready"]:
        typer.echo("没有就绪 step（可能还有未完成但前置不满足的）")
        return

    typer.echo("就绪工作单:")
    for s in payload["ready"]:
        typer.echo(f"  [{s['id']}] {s['name']}  ({s['type']}, {s['execution']})")
        if s["skill"]:
            typer.echo(f"      skill: {', '.join(s['skill'])}")
        if s["prompt"]:
            typer.echo("      prompt: yes")
        if s["data"]:
            typer.echo("      data: required")
        if s["inputs"]["blocked"]:
            typer.echo("      missing input: " + ", ".join(s["inputs"]["missing_required"]))
        if s["deliverables"]["can_skip"]:
            if s["data"]:
                typer.echo("      ⚠ 交付件已存在，仍需按 data_schema 提交数据后执行 done")
            else:
                typer.echo("      ⚠ 交付件已存在，可直接执行 done")
        typer.echo(f"      done: {s['commands']['done']}")


# ---------------------------------------------------------------------------
# done / rollback
# ---------------------------------------------------------------------------

@app.command()
def done(
    sr: Annotated[str, typer.Option("--sr", help="SR 需求号")],
    step_id: Annotated[int, typer.Argument(help="Step ID")],
    data_raw: Annotated[str | None, typer.Option("--data", help="分叉数据 JSON")] = None,
    data_file: Annotated[Path | None, typer.Option("--data-file", help="分叉数据 JSON 文件")] = None,
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON 输出")] = False,
):
    """标记 step 完成并按配置生成后继。"""
    mgr = _get_manager()
    try:
        if data_raw and data_file:
            raise WorkflowError("--data 和 --data-file 不能同时使用")
        if data_file:
            data_raw = data_file.read_text("utf-8-sig")
        wf = mgr.load(sr)
        step = wf.get_step(step_id)
        if step is None:
            raise WorkflowError(f"step {step_id} does not exist")
        result = mgr.mark_done(wf, step_id, data_raw)
    except OSError as e:
        _die(f"--data-file 读取失败: {e}")
    except (WorkflowError, DataError) as e:
        _die(str(e))

    # Finish only an explicitly started execution.  In particular, `next`
    # does not create a start timestamp and `done` never fabricates one.
    try:
        store = _get_telemetry()
        workflow_id = store.workflow_id(wf.sr)
        if workflow_id and store._step_state_path(workflow_id, step, 1).exists():
            if step.type == "task-dev":
                dev_state = store._dev_state_path(workflow_id, store.step_started(wf, step))
                if dev_state.exists():
                    store.dev_finished(wf, step)
            store.step_finished(wf, step, "completed")
        if wf.status == "done":
            store.workflow_updated(wf, "completed")
    except (OSError, TelemetryError) as e:
        typer.echo(f"telemetry warning: {e}", err=True)

    if use_json:
        _echo_json(result)
    else:
        typer.echo(f"step {step_id} 已完成")
        typer.echo(f"  生成 {result['generated']} 个后继 step")


@app.command()
def rollback(
    sr: Annotated[str, typer.Option("--sr", help="SR 需求号")],
    step_id: Annotated[int, typer.Argument(help="回退到的 Step ID")],
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON 输出")] = False,
):
    """回退到指定 step，删除其所有下游 step。"""
    mgr = _get_manager()
    try:
        wf = mgr.load(sr)
        target = wf.get_step(step_id)
        if target is None:
            raise WorkflowError(f"step {step_id} does not exist")
        rolled_ids = {step_id}
        pending_ids = list(target.next)
        while pending_ids:
            current_id = pending_ids.pop()
            if current_id in rolled_ids:
                continue
            rolled_ids.add(current_id)
            current = wf.get_step(current_id)
            if current:
                pending_ids.extend(current.next)
        rolled_steps = [step for step in wf.steps if step.id in rolled_ids]
        result = mgr.rollback(wf, step_id)
    except WorkflowError as e:
        _die(str(e))

    try:
        store = _get_telemetry()
        workflow_id = store.workflow_id(wf.sr)
        if workflow_id:
            for step in rolled_steps:
                state_path = store._step_state_path(workflow_id, step, 1)
                if state_path.exists():
                    store.step_finished(wf, step, "superseded")
            store.workflow_updated(wf, "in_progress")
    except (OSError, TelemetryError) as e:
        typer.echo(f"telemetry warning: {e}", err=True)

    if use_json:
        _echo_json(result)
    else:
        typer.echo(f"已回退到 step {step_id}，移除 {result['removed']} 个下游 step")


# ---------------------------------------------------------------------------
# telemetry
# ---------------------------------------------------------------------------

@telemetry_app.command("configure")
def telemetry_configure(
    endpoint: Annotated[str, typer.Option("--endpoint", help="Telemetry server base URL")],
):
    """Persist a non-secret endpoint; keep the write token in AAW_TELEMETRY_TOKEN."""
    try:
        _get_telemetry().configure(endpoint)
    except TelemetryError as e:
        _die(str(e))
    typer.echo("Telemetry endpoint saved. AAW_TELEMETRY_TOKEN is optional and is sent only when configured.")


@telemetry_app.command("status")
def telemetry_status(
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON output")] = False,
):
    """Show local queue, patch, and configuration diagnostics without uploading."""
    store = _get_telemetry()
    try:
        queue = store.pending()
        configs = store.config()
        states = [state for _, state in store.completed_dev_states()]
    except TelemetryError as e:
        _die(str(e))
    payload = {
        "endpoint": configs["endpoint"] or None,
        "token_configured": configs["token_present"],
        "pending_records": len(queue),
        "retrying_records": sum(1 for record in queue if record.get("attempts", 0)),
        "rejected_records": sum(1 for record in queue if record.get("terminal")),
        "pending_patches": sum(1 for state in states if state.get("patch_path") and not state.get("object_key")),
        "local_state": str(store.dir),
    }
    if use_json:
        _echo_json(payload)
    else:
        for key, value in payload.items():
            typer.echo(f"{key}: {value}")


@telemetry_app.command("preview")
def telemetry_preview(
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON output")] = False,
):
    """Preview queued records locally; secrets and patch bytes are never printed."""
    try:
        records = _get_telemetry().pending()
    except TelemetryError as e:
        _die(str(e))
    payload = {
        "records": [
            {key: record[key] for key in ("queue_id", "record_type", "record_id", "occurred_at", "data", "attempts", "last_error")}
            for record in records
        ]
    }
    if use_json:
        _echo_json(payload)
    else:
        for record in payload["records"]:
            typer.echo(f"{record['record_type']} {record['record_id']} @ {record['occurred_at']} (attempts={record['attempts']})")


@telemetry_app.command("flush")
def telemetry_flush(
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON output")] = False,
):
    """Retry queued state records, then upload and confirm pending Dev patches."""
    try:
        result = TelemetryClient(_get_telemetry()).flush()
    except TelemetryError as e:
        _die(str(e))
    if use_json:
        _echo_json(result)
    else:
        typer.echo(f"sent={result['sent']} uploaded={result['uploaded']} pending={result['pending']}")
        if result["error"]:
            typer.echo(f"upload pending: {result['error']}", err=True)


def _load_telemetry_step(sr: str, step_id: int):
    mgr = _get_manager()
    try:
        wf = mgr.load(sr)
    except WorkflowError as e:
        _die(str(e))
    step = wf.get_step(step_id)
    if step is None:
        _die(f"step {step_id} does not exist")
    return wf, step


@telemetry_app.command("step-start")
def telemetry_step_start(
    sr: Annotated[str, typer.Option("--sr", help="SR requirement ID")],
    step_id: Annotated[int, typer.Argument(help="Step ID actually beginning execution")],
    attempt: Annotated[int, typer.Option("--attempt", min=1)] = 1,
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON output")] = False,
):
    """Record an actual step start. Calling `next` is intentionally not enough."""
    wf, step = _load_telemetry_step(sr, step_id)
    try:
        store = _get_telemetry()
        record_id = store.step_started(wf, step, attempt)
        dev_run_id = None
        if step.type == "task-dev":
            dev_run_id = store.dev_started(wf, step, attempt)["dev_run_id"]
    except TelemetryError as e:
        _die(str(e))
    payload = {"ok": True, "step_execution_id": record_id, "dev_run_id": dev_run_id, "step_id": step_id, "attempt": attempt}
    _echo_json(payload) if use_json else typer.echo(f"step {step_id} telemetry started")


@telemetry_app.command("step-finish")
def telemetry_step_finish(
    sr: Annotated[str, typer.Option("--sr", help="SR requirement ID")],
    step_id: Annotated[int, typer.Argument(help="Step ID")],
    status: Annotated[str, typer.Option("--status", help="completed|failed|blocked|superseded")],
    attempt: Annotated[int, typer.Option("--attempt", min=1)] = 1,
):
    """Record a terminal state for an already executing step."""
    wf, step = _load_telemetry_step(sr, step_id)
    store = _get_telemetry()
    workflow_id = store.workflow_id(wf.sr)
    if not workflow_id or not store._step_state_path(workflow_id, step, attempt).exists():
        _die("Step telemetry has not started; run `aaw telemetry step-start` at actual execution start")
    try:
        store.step_finished(wf, step, status, attempt)
    except TelemetryError as e:
        _die(str(e))
    typer.echo(f"step {step_id} telemetry marked {status}")


@telemetry_app.command("dev-start")
def telemetry_dev_start(
    sr: Annotated[str, typer.Option("--sr", help="SR requirement ID")],
    step_id: Annotated[int, typer.Argument(help="task-dev step ID")],
    attempt: Annotated[int, typer.Option("--attempt", min=1)] = 1,
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON output")] = False,
):
    """Capture D0 before a task-dev changes code (HEAD, staged, unstaged, untracked)."""
    wf, step = _load_telemetry_step(sr, step_id)
    try:
        state = _get_telemetry().dev_started(wf, step, attempt)
    except TelemetryError as e:
        _die(str(e))
    payload = {"ok": True, "dev_run_id": state["dev_run_id"], "started_at": state["started_at"]}
    _echo_json(payload) if use_json else typer.echo(f"Dev telemetry started: {state['dev_run_id']}")


@telemetry_app.command("dev-finish")
def telemetry_dev_finish(
    sr: Annotated[str, typer.Option("--sr", help="SR requirement ID")],
    step_id: Annotated[int, typer.Argument(help="task-dev step ID")],
    attempt: Annotated[int, typer.Option("--attempt", min=1)] = 1,
    status: Annotated[str, typer.Option("--status", help="completed|failed|superseded")] = "completed",
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON output")] = False,
):
    """Capture D1 and queue the Dev Patch and code statistics without blocking on upload."""
    wf, step = _load_telemetry_step(sr, step_id)
    if status not in {"completed", "failed", "superseded"}:
        _die("Dev finish status must be completed, failed, or superseded")
    try:
        state = _get_telemetry().dev_finished(wf, step, attempt, status)
    except TelemetryError as e:
        _die(str(e))
    payload = {"ok": True, "dev_run_id": state["dev_run_id"], "status": status, "code_statistics": state.get("code_statistics")}
    _echo_json(payload) if use_json else typer.echo(f"Dev telemetry marked {status}: {state['dev_run_id']}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
