"""AAW Workflow CLI — configuration-driven workflow state management."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Annotated

import typer

from .models import DataError, WorkflowError
from .telemetry import TelemetryClient, TelemetryError, TelemetryStore, aaw_version
from .update import UpdateError, auto_update_on_entry, consume_handoff, run_update
from .workflow import WorkflowManager, write_session_marker

app = typer.Typer(
    name="aaw",
    help="AAW Workflow CLI",
    no_args_is_help=True,
)

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
    try:
        return WorkflowManager(SDD)
    except WorkflowError as e:
        _die(str(e))


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

    write_session_marker(SDD, wf.sr)

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
    # Auto-update runs here: per SKILL.md, `status` is the first command of
    # every session, so it is the update entry point (docs §4.2).  A successful
    # update re-execs the new CLI with the original argv and never returns; a
    # re-executed process consumes the one-shot handoff instead of querying the
    # server again.  Only fatal states abort status.
    try:
        if not consume_handoff():
            auto_update_on_entry(sys.argv[1:])
    except UpdateError as e:
        message = e.message if not e.hint else f"{e.message}\n  {e.hint}"
        _die(message)

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
        "pending_user_confirm": wf.pending_user_confirm,
        "steps": [
            {
                "id": s.id,
                "type": s.type,
                "name": s.name,
                "execution": s.execution,
                "finished": s.finished,
                "execution_status": s.execution_status,
                "attempt": s.attempt,
                "started_at": s.started_at,
                "ended_at": s.ended_at,
                "next": s.next,
            }
            for s in wf.steps
        ],
    }
    if use_json:
        _echo_json(data)
    else:
        typer.echo(f"SR: {wf.sr}  [{wf.status}]  entry={wf.entry}")
        if wf.pending_user_confirm:
            pending = wf.pending_user_confirm
            typer.echo(
                f"等待用户确认: step {pending.get('from_step')} "
                f"{pending.get('from_name')} -> "
                f"{', '.join(str(item.get('name')) for item in pending.get('planned_next', []))}"
            )
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

    write_session_marker(SDD, wf.sr)

    telemetry_results = []
    for ready_step in mgr.get_ready(wf):
        if ready_step.execution not in {"skill", "prompt"}:
            continue
        attempt = ready_step.attempt or 1
        if ready_step.execution_status in {"completed", "failed", "blocked", "superseded"}:
            attempt += 1
        try:
            started_step = mgr.mark_started(wf, ready_step.id, attempt)
        except WorkflowError as e:
            _die(str(e))
        if started_step.type == "task-dev":
            try:
                _get_telemetry().dev_started(wf, started_step, attempt)
            except (OSError, TelemetryError) as e:
                typer.echo(f"telemetry warning: {e}", err=True)
        telemetry_result = {
            "step_id": started_step.id,
            "step_type": started_step.type,
            "attempt": attempt,
        }
        message = None
        try:
            store = _get_telemetry()
            message = store.step_message(wf, started_step, "start")
            telemetry_result.update(TelemetryClient(Path.cwd()).send(message))
        except (OSError, TelemetryError) as e:
            typer.echo(f"telemetry warning: {e}", err=True)
            if message is not None:
                telemetry_result["message_id"] = message["message_id"]
            telemetry_result.update({"status": "failed", "error": str(e)})
        telemetry_results.append(telemetry_result)

    payload = mgr.build_next_payload(wf)
    payload["telemetry"] = telemetry_results
    if use_json:
        _echo_json(payload)
        return

    if payload["done"]:
        typer.echo("🎉 工作流完成")
        return
    if payload.get("status") == "awaiting_user_confirm":
        typer.echo(payload.get("message") or "当前步骤已完成，等待用户确认是否放行进入下一步。")
        pending = payload.get("pending_user_confirm") or {}
        typer.echo(
            f"  来源: step {pending.get('from_step')} "
            f"{pending.get('from_name')} ({pending.get('from_type')})"
        )
        planned = pending.get("planned_next") or []
        if planned:
            typer.echo("  待放行下游:")
            for item in planned:
                typer.echo(f"    [{item.get('id')}] {item.get('name')} ({item.get('type')})")
        typer.echo(f"  确认命令: {payload['commands']['user_confirm']}")
        return
    if not payload["ready"]:
        typer.echo("没有就绪 step（可能还有未完成但前置不满足的）")
        return

    typer.echo("就绪工作单:")
    telemetry_by_step = {item["step_id"]: item for item in telemetry_results}
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
        telemetry_result = telemetry_by_step.get(s["id"])
        if telemetry_result:
            typer.echo(f"      telemetry: {telemetry_result['status']}")
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

    # `next` persists the actual start timestamp; `done` sends the terminal Step.
    store = _get_telemetry()
    dev_state = None
    telemetry_succeeded = False
    try:
        file = None
        if step.type == "task-dev":
            dev_state = store.dev_finished(wf, step, step.attempt)
            file = dev_state["file"]
        message = store.step_message(wf, step, "done", file=file)
        result["telemetry"] = TelemetryClient(Path.cwd()).send(message, dev_state)
        telemetry_succeeded = True
    except (OSError, TelemetryError) as e:
        typer.echo(f"telemetry warning: {e}", err=True)
        result["telemetry"] = {"status": "failed", "error": str(e)}
    finally:
        if step.type == "task-dev" and telemetry_succeeded:
            store.cleanup_step(wf, step, step.attempt, dev_state)

    if use_json:
        _echo_json(result)
    else:
        typer.echo(f"step {step_id} 已完成")
        if result.get("state") == "awaiting_user_confirm":
            typer.echo("  当前步骤已完成，等待用户确认是否放行进入下一步。")
            typer.echo(f"  确认命令: {result['commands']['user_confirm']}")
        else:
            typer.echo(f"  生成 {result['generated']} 个后继 step")


@app.command("user-confirm")
def user_confirm(
    sr: Annotated[str, typer.Option("--sr", help="SR 需求号")],
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON 输出")] = False,
):
    """用户确认当前已完成 step 的交付物可放行到下游。"""
    mgr = _get_manager()
    try:
        wf = mgr.load(sr)
        result = mgr.user_confirm(wf)
    except WorkflowError as e:
        _die(str(e))

    if use_json:
        _echo_json(result)
    else:
        typer.echo("用户已确认，已放行下游 step")
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
        result = mgr.rollback(wf, step_id)
    except WorkflowError as e:
        _die(str(e))

    if use_json:
        _echo_json(result)
    else:
        typer.echo(f"已回退到 step {step_id}，移除 {result['removed']} 个下游 step")


@app.command()
def update(
    use_json: Annotated[bool, typer.Option("--json/--no-json", help="JSON 输出")] = False,
):
    """更新 AAW skills 到服务端发布的最新版本。

    退出码: up_to_date/updated -> 0, failed -> 1, recovery_required -> 2。
    """
    try:
        result = run_update()
    except UpdateError as e:
        status = "recovery_required" if e.fatal else "failed"
        if use_json:
            _echo_json({"status": status, "error": e.message})
        message = f"更新失败: {e.message}"
        if e.hint:
            message += f"\n  {e.hint}"
        typer.echo(message, err=True)
        raise typer.Exit(2 if e.fatal else 1)

    if use_json:
        _echo_json(result)
    elif result["status"] == "updated":
        typer.echo(f"更新完成: {result['from_version']} -> {result['to_version']}")
        typer.echo("  已更新 skills: " + ", ".join(result["updated_skills"]))
        if result["removed_skills"]:
            typer.echo("  已移除 skills: " + ", ".join(result["removed_skills"]))
    else:
        typer.echo(f"已是最新版本 ({result['from_version']})")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
