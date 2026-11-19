"""把 evolution/asis-slim 下三套 ASIS 测试套归档为可复核的标准文件。

用法：
    skill-eval/.venv/Scripts/python.exe skill-eval/evolution/asis-slim/export_standards.py

产出 skill-eval/standards/asis-slim-<case>/ 下的：
  00-source-standard.md   本目录 README 的判定依据摘要（人工维护，存在则保留）
  01-case-input.md        用例输入逐字
  02-case-expected.md     用例预期逐字
  03-graders.md           每个 grader 一条，含 checkpoints 与脚本入口
  04-suite.definition.yaml 套件完整定义，可回灌平台
  05-meta.json            套件 id / 定义哈希 / 固定 commit / 各 grader 权重
  99-rubric-source/       断言脚本副本，用于离线复核
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = "http://127.0.0.1:18110"
ASSETS = HERE / "assets"
STDS = ROOT / "standards"

CASES = {
    "ASIS-契约基线": "asis-slim-contract",
    "ASIS-事实可信": "asis-slim-facts",
    "ASIS-产出经济性": "asis-slim-economy",
}


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def main() -> int:
    suites = json.loads((HERE / "suites.json").read_text(encoding="utf-8"))
    readme = (HERE / "README.md").read_text(encoding="utf-8")
    for name, suite_id in suites.items():
        key = next((slug for prefix, slug in CASES.items() if name.startswith(prefix)), None)
        if key is None:
            print(f"skip {name}")
            continue
        detail = get(f"/api/v1/benchmark/suites/{suite_id}")
        definition = detail["definition"]
        case = definition["cases"][0]
        out = STDS / key

        write(out / "00-source-standard.md", readme)
        write(out / "01-case-input.md", case["input"])
        write(out / "02-case-expected.md", case["expected"])

        body = [
            f"# {name} —— 判据正文",
            "",
            f"- 套件 id：`{suite_id}`",
            f"- 定义哈希：`{detail['definition_hash']}`",
            f"- 项目：`{definition['project']['path']}` @ `{definition['project']['commit_at_creation']}`",
            f"- 维度：{', '.join(d['id'] for d in definition.get('dimensions', []))}",
            "",
            "| grader | 类型 | 权重 | 检查点 | 入口 |",
            "|---|---|---|---|---|",
        ]
        for grader in case["graders"]:
            body.append(
                f"| `{grader['id']}` | {grader['type']} | {grader['weight']} | "
                f"{', '.join(grader.get('checkpoint_ids') or []) or '（LLM 固定标准）'} | "
                f"`{grader.get('command') or '—'}` |"
            )
        body += ["", "## 断言脚本", ""]
        for grader in case["graders"]:
            if grader["type"] != "command":
                continue
            for file in grader["files"]:
                body.append(f"### {file['path']}")
                body.append("")
                body.append("```python")
                import base64

                body.append(base64.b64decode(file["content_base64"]).decode("utf-8"))
                body.append("```")
                body.append("")
        write(out / "03-graders.md", "\n".join(body))

        write(
            out / "04-suite.definition.yaml",
            yaml.safe_dump(definition, allow_unicode=True, sort_keys=False, width=10**6),
        )
        meta = {
            "suite_id": suite_id,
            "suite_name": name,
            "definition_hash": detail["definition_hash"],
            "project_path": definition["project"]["path"],
            "project_commit": definition["project"]["commit_at_creation"],
            "reference_skill_path": definition.get("reference_skill_path"),
            "setup": definition.get("setup"),
            "max_turns": case.get("max_turns"),
            "dimensions": [d["id"] for d in definition.get("dimensions", [])],
            "graders": [
                {
                    "id": g["id"],
                    "type": g["type"],
                    "weight": g["weight"],
                    "checkpoint_ids": g.get("checkpoint_ids") or [],
                }
                for g in case["graders"]
            ],
            "baseline_experiment_id": detail.get("baseline_experiment_id"),
            "baseline_assessment_id": detail.get("baseline_assessment_id"),
        }
        write(out / "05-meta.json", json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

        for source in sorted(ASSETS.rglob("*.py")):
            relative = source.relative_to(ASSETS)
            if relative.parts[0] == "_lib":
                continue
            used = any(
                relative.name in (grader.get("command") or "")
                for grader in case["graders"]
                if grader["type"] == "command"
            )
            if not used:
                continue
            target = out / "99-rubric-source" / source.name
            write(target, source.read_text(encoding="utf-8"))
        print(f"{key:22} {suite_id}  {len(case['graders'])} graders")
    return 0


if __name__ == "__main__":
    sys.exit(main())
