"""跑一轮场景矩阵并钉基线。

用法（skill-eval/ 目录）：
    .venv/Scripts/python.exe evolution/asis-scenarios/run_baseline.py [--skill PATH] [--no-pin]
"""

from __future__ import annotations

import argparse
import json
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
    "timeout_seconds": 3600,
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
    with urllib.request.urlopen(f"{BASE}{path}", timeout=180) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", default=str(DEFAULT_SKILL))
    parser.add_argument("--no-pin", dest="pin", action="store_false")
    args = parser.parse_args()

    suite = json.loads((HERE / "suite.json").read_text(encoding="utf-8"))
    suite_id = suite["id"]
    print(f"skill={args.skill}\nsuite={suite_id}\ncases={suite['cases']}\n")

    created = post(
        f"/api/v1/benchmark/suites/{suite_id}/execute",
        {
            "candidate_kind": "skill",
            "skill_path": args.skill,
            "mode": "quick",
            "profile": PROFILE,
        },
    )
    experiment_id = created["id"]
    print(f"queued {experiment_id}")

    deadline = time.monotonic() + 6 * 3600
    while time.monotonic() < deadline:
        time.sleep(60)
        experiment = get(f"/api/v1/experiments/{experiment_id}")
        status = experiment.get("status")
        runs = experiment.get("runs", [])
        done = [r for r in runs if r.get("status") not in {"queued", "running"}]
        print(f"  {status} {len(done)}/{len(runs)} runs settled", flush=True)
        if status not in {"queued", "preparing", "running"}:
            break
    else:
        print("超时")
        return 2

    scores = experiment.get("dimension_scores") or {}
    print(f"\nstatus={status}")
    for group, items in scores.items():
        for item in items:
            print(f"  {group}/{item['id']} score={item['score']} {item['completed']}/{item['expected']}")
    for run in experiment.get("runs", []):
        print(
            f"  run {run['case_id']} {run['status']} score={run.get('quality_score')} "
            f"stage={run.get('current_stage')}"
        )

    if args.pin and status.startswith("completed"):
        pinned = post(f"/api/v1/benchmark/suites/{suite_id}/baseline", {"experiment_id": experiment_id})
        comparison = pinned.get("comparison") or {}
        print(f"\npinned baseline: {comparison.get('current_score')}")

    out = HERE / "baseline.json"
    out.write_text(
        json.dumps(
            {
                "skill": args.skill,
                "suite_id": suite_id,
                "experiment_id": experiment_id,
                "status": status,
                "dimension_scores": scores,
                "runs": [
                    {
                        "case_id": r["case_id"],
                        "status": r["status"],
                        "score": r.get("quality_score"),
                    }
                    for r in experiment.get("runs", [])
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"written {out}")
    return 0 if status.startswith("completed") else 1


if __name__ == "__main__":
    raise SystemExit(main())
