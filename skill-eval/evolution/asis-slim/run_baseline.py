"""对三套 ASIS 测试套各跑一轮并设为基线（精简前的对照组）。

用法：
    skill-eval/.venv/Scripts/python.exe skill-eval/evolution/asis-slim/run_baseline.py [--skill PATH]

默认使用仓库内当前 skills/module-asis-analysis。跑完后把每套的 current 结果钉为 baseline，
后续换精简版 skill 路径重跑，页面上的 delta 即为该次精简的净效果。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = "http://127.0.0.1:18110"
DEFAULT_SKILL = ROOT.parent / "skills" / "module-asis-analysis"

PROFILE = {
    "schema_version": 2,
    "name": "chrys-standard",
    "runner_provider": "chrys",
    "runner_model": "03b919c5c576",
    "runner_reasoning_effort": "high",
    "judge_provider": "chrys",
    "judge_model": "03b919c5c576",
    "judge_reasoning_effort": "high",
    "timeout_seconds": 1800,
    "judge_timeout_seconds": 300,
    "judge_total_timeout_seconds": 900,
    "network": False,
    "allowed_mcp_servers": [],
}


def post(path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"POST {path} -> {exc.code}: {detail[:800]}") from exc


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def summarize(experiment: dict) -> str:
    parts = []
    for run in experiment.get("runs", []):
        parts.append(
            f"{run['group']}/T{run['trial']} {run['status']} "
            f"score={run.get('quality_score')} stage={run.get('current_stage')}"
        )
    return "; ".join(parts) or "no runs"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", default=str(DEFAULT_SKILL))
    parser.add_argument("--mode", default="quick", choices=["quick", "formal"])
    parser.add_argument("--pin-baseline", action="store_true", default=True)
    parser.add_argument("--no-pin", dest="pin_baseline", action="store_false")
    args = parser.parse_args()

    suites = json.loads((HERE / "suites.json").read_text(encoding="utf-8"))
    print(f"skill={args.skill}\nmode={args.mode}\nsuites={len(suites)}\n")

    pending: dict[str, str] = {}
    for name, suite_id in suites.items():
        created = post(
            f"/api/v1/benchmark/suites/{suite_id}/execute",
            {
                "candidate_kind": "skill",
                "skill_path": args.skill,
                "mode": args.mode,
                "profile": PROFILE,
            },
        )
        pending[name] = created["id"]
        print(f"queued {created['id']}  {name}")

    # 单 worker 串行执行：三套排队跑完，再统一钉基线。
    deadline = time.monotonic() + 4 * 3600
    done: dict[str, str] = {}
    while pending and time.monotonic() < deadline:
        time.sleep(30)
        for name, experiment_id in list(pending.items()):
            experiment = get(f"/api/v1/experiments/{experiment_id}")
            status = experiment.get("status")
            if status in {"queued", "preparing", "running"}:
                continue
            print(f"done   {experiment_id[:8]} {name} status={status} :: {summarize(experiment)}")
            if status.startswith("completed"):
                done[name] = experiment_id
            pending.pop(name)

    if not done:
        print("没有完成的执行，未钉基线")
        return 1

    if args.pin_baseline:
        for name, experiment_id in done.items():
            pinned = post(
                f"/api/v1/benchmark/suites/{suites[name]}/baseline",
                {"experiment_id": experiment_id},
            )
            comparison = pinned.get("comparison") or {}
            print(
                f"baseline {name}: exp={experiment_id[:8]} score={comparison.get('current_score')}"
            )

    out = HERE / "baseline.json"
    out.write_text(
        json.dumps({"skill": args.skill, "mode": args.mode, "experiments": done}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"\nwritten {out}")
    return 0 if not pending else 2


if __name__ == "__main__":
    sys.exit(main())
