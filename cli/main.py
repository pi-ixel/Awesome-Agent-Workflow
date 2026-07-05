"""AAW Workflow CLI — deterministic workflow state management."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Annotated, Optional

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


# ---------------------------------------------------------------------------
# init
# ---------------------------------------------------------------------------

@app.command()
def init(
    sr: Annotated[Optional[str], typer.Option("--sr", help="SR 需求号")] = None,
):
    """创建 .sdd/ 目录骨架或初始化 SR 工作流."""
    mgr = _get_manager()
    SDD.mkdir(parents=True, exist_ok=True)

    if sr is None:
        typer.echo(f"已创建 {SDD}/ 目录骨架")
        return

    try:
        wf = mgr.init_sr(sr)
    except WorkflowError as e:
        _die(str(e))
    typer.echo(f"SR {sr} 初始化完成\n  仅包含 step 1 (sr-design)\n  {mgr._wf_path(sr)}")


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

@app.command()
def status(
    sr: Annotated[Optional[str], typer.Option("--sr", help="SR 需求号")] = None,
    json_output: Annotated[bool, typer.Option("--json", help="JSON 输出")] = False,
):
    """查看工作流进度."""
    mgr = _get_manager()

    if sr is None:
        # List all SRs
        srs = [d.name for d in SDD.iterdir() if d.is_dir() and (d / "workflow.yaml").exists()]
        if json_output:
            typer.echo(json.dumps({"srs": srs}, ensure_ascii=False, indent=2))
        elif srs:
            typer.echo("SR 列表:")
            for s in sorted(srs):
                wf = mgr.load(s)
                done_count = sum(1 for st in wf.steps if st.finished)
                total = len(wf.steps)
                typer.echo(f"  {s}  [{done_count}/{total}]  {wf.status}")
        else:
            typer.echo("暂无 SR")
        return

    # Single SR
    try:
        wf = mgr.load(sr)
    except WorkflowError as e:
        _die(str(e))

    if json_output:
        data = {
            "sr": wf.sr,
            "status": wf.status,
            "steps": [
                {"id": s.id, "type": s.type, "name": s.name, "finished": s.finished}
                for s in wf.steps
            ],
        }
        typer.echo(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        typer.echo(f"SR: {wf.sr}  [{wf.status}]")
        typer.echo()
        for s in wf.steps:
            mark = "✅" if s.finished else "❌"
            typer.echo(f"  {mark}  step {s.id}: {s.name}  ({s.type})")


# ---------------------------------------------------------------------------
# next
# ---------------------------------------------------------------------------

@app.command()
def next(
    sr: Annotated[str, typer.Option("--sr", help="SR 需求号")],
    json_output: Annotated[bool, typer.Option("--json", help="JSON 输出")] = False,
):
    """获取下一个（或多个）就绪的 step."""
    mgr = _get_manager()
    try:
        wf = mgr.load(sr)
    except WorkflowError as e:
        _die(str(e))

    ready = mgr.get_ready(wf)
    done = len(ready) == 0 and wf.all_finished()

    if json_output:
        data = {
            "sr": wf.sr,
            "ready": [
                {
                    "id": s.id,
                    "type": s.type,
                    "name": s.name,
                    "skill": s.skill,
                    "input": s.input,
                    "output": s.output,
                    "available_next": s.available_next,
                    "deliverables_exist": mgr.check_deliverables(s),
                }
                for s in ready
            ],
            "done": done,
        }
        # Add hint for steps with existing deliverables
        for rd in data["ready"]:
            if rd["deliverables_exist"]:
                rd["hint"] = f"交付件已存在，请执行 aaw done --sr {wf.sr} {rd['id']}"
        typer.echo(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        if done:
            typer.echo("🎉 工作流完成")
        elif ready:
            typer.echo("就绪 step:")
            for s in ready:
                typer.echo(f"  [{s.id}] {s.name}  (skill: {s.skill or '(prompt)'})")
                if s.input:
                    typer.echo(f"      input:  {s.input}")
                if s.output:
                    typer.echo(f"      output: {s.output}")
                if mgr.check_deliverables(s):
                    typer.echo(f"      ⚠ 交付件已存在，可直接 aaw done --sr {wf.sr} {s.id}")
            typer.echo("")
            typer.echo("执行步骤:")
            typer.echo("  1. skill 非空 → load_skill 执行，完成后检查交付件")
            typer.echo("  2. skill 为空 → 按 prompt 执行")
            typer.echo("  3. type=ar-split → 询问用户是否拆分 AR")
            typer.echo("  4. 完成后: aaw done --sr SR-XXX <id> [--data '...'] --json")
        else:
            typer.echo("没有就绪 step（可能还有未完成但前置不满足的）")


# ---------------------------------------------------------------------------
# done
# ---------------------------------------------------------------------------

@app.command()
def done(
    sr: Annotated[str, typer.Option("--sr", help="SR 需求号")],
    step_id: Annotated[int, typer.Argument(help="Step ID")],
    data_raw: Annotated[Optional[str], typer.Option("--data", help="分叉数据 JSON")] = None,
    json_output: Annotated[bool, typer.Option("--json", help="JSON 输出")] = False,
):
    """标记 step 完成并生成后继."""
    mgr = _get_manager()
    try:
        wf = mgr.load(sr)
    except WorkflowError as e:
        _die(str(e))

    try:
        result = mgr.mark_done(wf, step_id, data_raw)
    except (WorkflowError, DataError) as e:
        _die(str(e))

    if json_output:
        typer.echo(json.dumps(result, ensure_ascii=False))
    else:
        typer.echo(f"step {step_id} 已完成")
        if result["generated"] > 0:
            typer.echo(f"  生成 {result['generated']} 个后继 step")
        else:
            typer.echo("  终止节点，无后继")


@app.command()
def rollback(
    sr: Annotated[str, typer.Option("--sr", help="SR 需求号")],
    step_id: Annotated[int, typer.Argument(help="回退到的 Step ID")],
    json_output: Annotated[bool, typer.Option("--json", help="JSON 输出")] = False,
):
    """回退到指定 step，删除其所有下游 step."""
    mgr = _get_manager()
    try:
        wf = mgr.load(sr)
    except WorkflowError as e:
        _die(str(e))

    try:
        result = mgr.rollback(wf, step_id)
    except WorkflowError as e:
        _die(str(e))

    if json_output:
        typer.echo(json.dumps(result, ensure_ascii=False))
    else:
        typer.echo(f"已回退到 step {step_id}，移除 {result['removed']} 个下游 step")


def main():
    app()


if __name__ == "__main__":
    main()
