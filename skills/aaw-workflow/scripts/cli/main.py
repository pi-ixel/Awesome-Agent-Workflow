"""AAW Workflow CLI — configuration-driven workflow state management."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated

import typer

from .models import DataError, WorkflowError
from .workflow import WorkflowManager

app = typer.Typer(
    name="aaw",
    help="AAW Workflow CLI",
    no_args_is_help=True,
)

SDD = Path(".sdd")


def _get_manager() -> WorkflowManager:
    return WorkflowManager(SDD)


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
        result = mgr.mark_done(wf, step_id, data_raw)
    except OSError as e:
        _die(f"--data-file 读取失败: {e}")
    except (WorkflowError, DataError) as e:
        _die(str(e))

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
        result = mgr.rollback(wf, step_id)
    except WorkflowError as e:
        _die(str(e))

    if use_json:
        _echo_json(result)
    else:
        typer.echo(f"已回退到 step {step_id}，移除 {result['removed']} 个下游 step")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
