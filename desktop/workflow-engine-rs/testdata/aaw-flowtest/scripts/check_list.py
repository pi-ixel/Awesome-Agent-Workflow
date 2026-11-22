"""检查 trial/flowtest/list.md：首行以「# 」开头、末尾非空行是 END。

工作目录是项目目录；结果以一个 JSON 对象写到标准输出。
"""
import json
from pathlib import Path

path = Path("trial/flowtest/list.md")
if not path.exists():
    print(json.dumps({"ok": False, "lines": 0, "problem": f"{path.as_posix()} 不存在"}, ensure_ascii=False))
else:
    lines = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    problem = ""
    if not lines or not lines[0].startswith("# "):
        problem = "第一行应以「# 」开头"
    elif lines[-1] != "END":
        problem = "最后一个非空行应是 END"
    result = {"ok": not problem, "lines": len(lines)}
    if problem:
        result["problem"] = problem
    print(json.dumps(result, ensure_ascii=False))
