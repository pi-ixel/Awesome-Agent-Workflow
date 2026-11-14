"""把场景矩阵套件导出为 `standards/asis-scenarios/` 可审阅档案。

用法（skill-eval/ 目录）：
    .venv/Scripts/python.exe evolution/asis-scenarios/export_standards.py
"""

from __future__ import annotations

import base64
import json
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = ROOT / "standards" / "asis-scenarios"
BASE = "http://127.0.0.1:18110"


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main() -> int:
    suite = json.loads((HERE / "suite.json").read_text(encoding="utf-8"))
    data = get(f"/api/v1/benchmark/suites/{suite['id']}")
    definition = data["definition"]

    scenarios = []
    for case in definition["cases"]:
        scenario = {
            "id": case["id"],
            "name": case["name"],
            "purpose": "",
            "input": case["input"],
            "expected": case["expected"],
            "output_paths": case.get("output_paths", []),
            "max_turns": case.get("max_turns"),
            "graders": [
                {
                    "id": grader["id"],
                    "type": grader["type"],
                    "dimension_id": grader.get("dimension_id"),
                    "checkpoint_ids": grader.get("checkpoint_ids", []),
                    "command": grader.get("command"),
                }
                for grader in case["graders"]
            ],
        }
        scenarios.append(scenario)

    # 场景目的来自构建脚本，避免档案里丢失“为什么有这个场景”。
    import importlib.util

    spec = importlib.util.spec_from_file_location("build_suite", HERE / "build_suite.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    purposes = {item["id"]: item["purpose"] for item in module.SCENES}
    for scenario in scenarios:
        scenario["purpose"] = purposes.get(scenario["id"], "")

    write(
        OUT / "00-source-standard.md",
        (HERE / "README.md").read_text(encoding="utf-8"),
    )
    write(
        OUT / "01-scenarios.json",
        json.dumps(scenarios, ensure_ascii=False, indent=2),
    )
    write(
        OUT / "02-suite.definition.yaml",
        yaml_dump(definition),
    )
    write(
        OUT / "03-metrics.md",
        (HERE / "METRICS.md").read_text(encoding="utf-8")
        if (HERE / "METRICS.md").is_file()
        else "# 指标说明\n\n见 00-source-standard.md 的「每个场景测什么指标」一节。\n",
    )

    # 判据脚本原样落盘：审阅者看到的必须与线上执行的是同一份字节。
    for case in definition["cases"]:
        for grader in case["graders"]:
            if grader["type"] != "command":
                continue
            for file in grader.get("files", []):
                target = OUT / "99-rubric-source" / case["id"] / Path(file["path"]).name
                write(target, base64.b64decode(file["content_base64"]).decode("utf-8"))

    meta = {
        "suite_id": suite["id"],
        "name": definition["name"],
        "project_path": data.get("project_path"),
        "reference_skill_path": data.get("reference_skill_path"),
        "catalog_version": data.get("catalog_version"),
        "skill_type": data.get("skill_type"),
        "dimensions": [
            {"id": item["id"], "name": item["name"], "method": item["method"]}
            for item in definition["dimensions"]
        ],
        "cases": [case["id"] for case in definition["cases"]],
        "baseline_experiment_id": data.get("baseline_experiment_id"),
        "baseline_assessment_id": data.get("baseline_assessment_id"),
        "baseline_score": (data.get("baseline") or {}).get("scores", {}).get("current"),
    }
    write(OUT / "05-meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

    print(f"written {OUT}")
    for path in sorted(OUT.rglob("*")):
        if path.is_file():
            print("  ", path.relative_to(OUT).as_posix(), path.stat().st_size)
    return 0


def yaml_dump(value: dict) -> str:
    import yaml

    return yaml.safe_dump(value, allow_unicode=True, sort_keys=False)


if __name__ == "__main__":
    raise SystemExit(main())
