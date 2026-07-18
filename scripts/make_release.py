#!/usr/bin/env python3
"""打包 aaw-workflow skill 为发布 zip（设计见 docs/auto-update-design.md §6）。

用法: python scripts/make_release.py
产出: dist/aaw-skills-<version>.zip（zip 根为 aaw-workflow/，排除 __pycache__ 与 *.pyc）
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = REPO_ROOT / "skills" / "aaw-workflow" / "scripts" / "cli" / "VERSION"
SKILL_DIR = REPO_ROOT / "skills" / "aaw-workflow"
DIST_DIR = REPO_ROOT / "dist"

VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def read_version() -> str:
    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    if VERSION_PATTERN.fullmatch(version) is None:
        sys.exit(f"error: {VERSION_FILE} 的版本号 {version!r} 不是严格三段版本")
    return version


def read_pyproject_version() -> str:
    text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    try:
        import tomllib

        return tomllib.loads(text)["project"]["version"]
    except ModuleNotFoundError:  # Python 3.10 没有 tomllib，退回行匹配
        match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
        if match is None:
            sys.exit("error: pyproject.toml 中找不到 project.version")
        return match.group(1)


def read_json_version(relative: str, *keys: str) -> str:
    data = json.loads((REPO_ROOT / relative).read_text(encoding="utf-8"))
    for key in keys:
        data = data[int(key) if key.isdigit() else key]
    return data


def check_consistency(version: str) -> list[str]:
    sources = {
        "pyproject.toml": read_pyproject_version(),
        ".claude-plugin/plugin.json": read_json_version(".claude-plugin/plugin.json", "version"),
        ".codex-plugin/plugin.json": read_json_version(".codex-plugin/plugin.json", "version"),
        ".claude-plugin/marketplace.json": read_json_version(
            ".claude-plugin/marketplace.json", "plugins", "0", "version"
        ),
    }
    return [f"  {name}: {found} != {version}" for name, found in sources.items() if found != version]


def build_zip(version: str) -> Path:
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    zip_path = DIST_DIR / f"aaw-skills-{version}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(SKILL_DIR.rglob("*")):
            if not path.is_file():
                continue
            if "__pycache__" in path.parts or path.suffix == ".pyc":
                continue
            arcname = Path("aaw-workflow") / path.relative_to(SKILL_DIR)
            archive.write(path, arcname.as_posix())
    return zip_path


def main() -> None:
    version = read_version()
    mismatches = check_consistency(version)
    if mismatches:
        print(f"error: 以下文件版本与 VERSION ({version}) 不一致:", file=sys.stderr)
        for line in mismatches:
            print(line, file=sys.stderr)
        sys.exit(1)
    zip_path = build_zip(version)
    size = zip_path.stat().st_size
    print(f"{zip_path}")
    print(f"size: {size} bytes ({size / 1024:.1f} KiB)")


if __name__ == "__main__":
    main()
