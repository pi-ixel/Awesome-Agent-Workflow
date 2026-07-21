#!/usr/bin/env python3
"""刷新发布版本并构建 AAW 的完整 GitHub Release 交付物。

用法:
  python scripts/make_release.py          # 校验当前版本并构建全部交付物
  python scripts/make_release.py 2.3.1    # 先统一刷新版本，再构建全部交付物

产出:
  dist/aaw-skills-<version>.zip
  dist/aaw-telemetry-server-<version>.tar.gz
  dist/aaw-telemetry-portal-<version>.tar.gz
  dist/release-metadata.json
  dist/SHA256SUMS
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import zipfile
from collections.abc import Callable
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = REPO_ROOT / "skills" / "aaw-workflow" / "scripts" / "cli" / "VERSION"
DIST_DIR = REPO_ROOT / "dist"
SERVER_DIR = REPO_ROOT / "telemetry-server"
PORTAL_DIR = REPO_ROOT / "telemetry-front" / "portal"
PORTAL_VERSION_FILE = PORTAL_DIR / "VERSION"

VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
MANIFEST_NAME = "release-manifest.json"
MANIFEST_SCHEMA = 1
RESERVED_PREFIX = ".aaw-"
EXCLUDED_PARTS = {"__pycache__", ".pytest_cache"}
EXCLUDED_NAMES = {".DS_Store"}
PACKAGE_EXCLUDED_PARTS = {
    ".git",
    ".idea",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
}
PACKAGE_EXCLUDED_TOP_LEVEL = {"data", "logs"}
PACKAGE_EXCLUDED_NAMES = {".coverage", ".DS_Store", ".env", "database.yaml"}
# flow.yaml 是 flow 图定义（entrypoints/edges），不是节点文件，不含 skill 引用
FLOW_DEFINITION = "flow.yaml"


class ReleaseError(Exception):
    """发布包校验失败。"""


def _replace_once(
    path: Path,
    pattern: bytes,
    replacement: bytes | Callable[[re.Match[bytes]], bytes],
) -> bytes:
    """返回恰好替换一次后的文件内容；用于在写入前完成全量校验。"""
    content = path.read_bytes()
    updated, count = re.subn(pattern, replacement, content, count=1)
    if count != 1:
        raise ReleaseError(f"{path} 中找不到唯一的版本声明")
    return updated


def set_release_version(repo_root: Path, version: str) -> list[Path]:
    """统一刷新组件版本和所有 Skill 版本，保留 Skill 的第四段修订号。"""
    if VERSION_PATTERN.fullmatch(version) is None:
        raise ReleaseError(f"版本号 {version!r} 不是严格三段版本")

    version_bytes = version.encode("ascii")
    updates: dict[Path, bytes] = {}
    version_file = repo_root / "skills" / "aaw-workflow" / "scripts" / "cli" / "VERSION"
    updates[version_file] = version_bytes + b"\n"

    for relative in ("pyproject.toml", "telemetry-server/pyproject.toml"):
        path = repo_root / relative
        updates[path] = _replace_once(
            path,
            rb'(?m)^(version\s*=\s*")[^"]+("\s*\r?$)',
            rb"\g<1>" + version_bytes + rb"\g<2>",
        )

    for relative in (
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        ".claude-plugin/marketplace.json",
    ):
        path = repo_root / relative
        updates[path] = _replace_once(
            path,
            rb'("version"\s*:\s*")[^"]+("\s*,?)',
            rb"\g<1>" + version_bytes + rb"\g<2>",
        )

    skills = collect_skills(repo_root)
    skill_pattern = re.compile(
        rb'(?m)^(version:\s*)"?\d+\.\d+\.\d+\.(\d+)"?([ \t]*\r?)$'
    )
    for name in skills:
        path = repo_root / "skills" / name / "SKILL.md"

        def replace_skill(match: re.Match[bytes]) -> bytes:
            return match.group(1) + b'"' + version_bytes + b"." + match.group(2) + b'"' + match.group(3)

        updates[path] = _replace_once(path, skill_pattern, replace_skill)

    portal_version_file = repo_root / "telemetry-front" / "portal" / "VERSION"
    updates[portal_version_file] = version_bytes + b"\n"

    for path, content in updates.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return sorted(updates)


def read_version(repo_root: Path = REPO_ROOT) -> str:
    version_file = repo_root / "skills" / "aaw-workflow" / "scripts" / "cli" / "VERSION"
    version = version_file.read_text(encoding="utf-8").strip()
    if VERSION_PATTERN.fullmatch(version) is None:
        raise ReleaseError(f"{version_file} 的版本号 {version!r} 不是严格三段版本")
    return version


def read_pyproject_version(repo_root: Path) -> str:
    text = (repo_root / "pyproject.toml").read_text(encoding="utf-8")
    try:
        import tomllib

        return tomllib.loads(text)["project"]["version"]
    except ModuleNotFoundError:  # Python 3.10 没有 tomllib，退回行匹配
        match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', text)
        if match is None:
            raise ReleaseError("pyproject.toml 中找不到 project.version")
        return match.group(1)


def read_json_version(repo_root: Path, relative: str, *keys: str) -> str:
    data = json.loads((repo_root / relative).read_text(encoding="utf-8"))
    for key in keys:
        data = data[int(key) if key.isdigit() else key]
    return data


SCRIPT_METADATA_RE = re.compile(r"(?ms)^# /// script$(.*?)^# ///$")


def _inline_block_toml(script: Path) -> str:
    match = SCRIPT_METADATA_RE.search(script.read_text(encoding="utf-8"))
    if match is None:
        raise ReleaseError(f"{script} 缺少 PEP 723 内联依赖块（# /// script）")
    return "\n".join(
        line[2:] if line.startswith("# ") else line[1:]
        for line in match.group(1).splitlines()
        if line.startswith("#")
    )


def _toml_dependencies(toml_text: str, label: str) -> list[str]:
    try:
        import tomllib
    except ModuleNotFoundError:  # Python 3.10：退回段落匹配
        section = toml_text.split("dependencies", 1)[1].split("]", 1)[0]
        return re.findall(r'"([^"]+)"', section)
    data = tomllib.loads(toml_text)
    project = data.get("project")
    deps = (project or data).get("dependencies")
    if not isinstance(deps, list):
        raise ReleaseError(f"{label} 中找不到 dependencies 列表")
    return deps


def check_script_dependencies(repo_root: Path) -> None:
    """校验 aaw.py 的 PEP 723 内联依赖与 pyproject.toml 声明一致。"""
    script = repo_root / "skills" / "aaw-workflow" / "scripts" / "aaw.py"
    script_deps = _toml_dependencies(_inline_block_toml(script), str(script))
    pyproject_deps = _toml_dependencies(
        (repo_root / "pyproject.toml").read_text(encoding="utf-8"), "pyproject.toml"
    )
    if sorted(script_deps) != sorted(pyproject_deps):
        raise ReleaseError(
            "aaw.py 内联依赖与 pyproject.toml 不一致:\n"
            f"  aaw.py:         {sorted(script_deps)}\n"
            f"  pyproject.toml: {sorted(pyproject_deps)}"
        )


def check_consistency(repo_root: Path, version: str) -> list[str]:
    sources = {
        "pyproject.toml": read_pyproject_version(repo_root),
        "telemetry-server/pyproject.toml": read_pyproject_version(repo_root / "telemetry-server"),
        "telemetry-front/portal/VERSION": (
            repo_root / "telemetry-front" / "portal" / "VERSION"
        ).read_text(encoding="utf-8").strip(),
        ".claude-plugin/plugin.json": read_json_version(repo_root, ".claude-plugin/plugin.json", "version"),
        ".codex-plugin/plugin.json": read_json_version(repo_root, ".codex-plugin/plugin.json", "version"),
        ".claude-plugin/marketplace.json": read_json_version(
            repo_root, ".claude-plugin/marketplace.json", "plugins", "0", "version"
        ),
    }
    return [f"  {name}: {found} != {version}" for name, found in sources.items() if found != version]


SKILL_VERSION_PATTERN = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"
)


def read_skill_version(skill_md: Path) -> str:
    """读 SKILL.md YAML frontmatter 的 version 字段（必须存在且为字符串）。"""
    text = skill_md.read_text(encoding="utf-8-sig")  # 容忍 BOM
    match = re.match(r"(?s)\A---\r?\n(.*?)\r?\n---", text)
    if match is None:
        raise ReleaseError(f"{skill_md} 缺少 YAML frontmatter")
    meta = yaml.safe_load(match.group(1))
    version = meta.get("version") if isinstance(meta, dict) else None
    if not isinstance(version, str):
        raise ReleaseError(f"{skill_md} frontmatter 缺少字符串 version 字段（注意加引号防 YAML 解析成数字）")
    return version


def check_skill_versions(repo_root: Path, version: str, skills: list[str]) -> None:
    """每个入包 skill 的 SKILL.md version 必须是四段且前三段 == 发布版本。"""
    problems = []
    for name in skills:
        skill_md = repo_root / "skills" / name / "SKILL.md"
        try:
            found = read_skill_version(skill_md)
        except ReleaseError as e:
            problems.append(f"  {name}: {e}")
            continue
        if SKILL_VERSION_PATTERN.fullmatch(found) is None:
            problems.append(f"  {name}: version {found!r} 不是四段格式 x.y.z.n")
        elif found.rsplit(".", 1)[0] != version:
            problems.append(f"  {name}: version {found} 前三段 != 发布版本 {version}")
    if problems:
        raise ReleaseError("以下 skill 的 SKILL.md version 不合规:\n" + "\n".join(problems))


def collect_skills(repo_root: Path) -> list[str]:
    """动态发现 skills/ 下所有含 SKILL.md 的目录（排序）。"""
    skills_root = repo_root / "skills"
    return sorted(
        path.name
        for path in skills_root.iterdir()
        if path.is_dir() and (path / "SKILL.md").is_file()
    )


def load_release_config(repo_root: Path) -> tuple[list[str], list[str]]:
    """读 scripts/release.yaml 的 external_skills / removed_skills；文件或键缺失视为空。"""
    config_path = repo_root / "scripts" / "release.yaml"
    if not config_path.is_file():
        return [], []
    data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    if data is None:
        return [], []
    if not isinstance(data, dict):
        raise ReleaseError(f"{config_path} 顶层必须是 mapping")
    lists: list[list[str]] = []
    for key in ("external_skills", "removed_skills"):
        value = data.get(key)
        if value is None:
            lists.append([])
        elif isinstance(value, list):
            lists.append(value)
        else:
            raise ReleaseError(f"{config_path} 的 {key} 必须是列表")
    return lists[0], lists[1]


def _validate_name(label: str, name: object) -> None:
    if not isinstance(name, str) or not name:
        raise ReleaseError(f"{label} 包含非法名称（必须是非空字符串）: {name!r}")
    if "/" in name or "\\" in name:
        raise ReleaseError(f"{label} 名称含路径分隔符: {name!r}")
    if name.startswith(RESERVED_PREFIX):
        raise ReleaseError(f"{label} 名称命中保留前缀 {RESERVED_PREFIX!r}: {name!r}")
    if name.startswith("."):
        raise ReleaseError(f"{label} 名称以 '.' 开头: {name!r}")


def validate_names(skills: list[str], external_skills: list[str], removed_skills: list[str]) -> None:
    """校验三个列表名称合法、各自无重复、两两不交叉。"""
    lists = {"skills": skills, "external_skills": external_skills, "removed_skills": removed_skills}
    for label, names in lists.items():
        for name in names:
            _validate_name(label, name)
        seen: set[str] = set()
        for name in names:
            if name in seen:
                raise ReleaseError(f"{label} 存在重复名称: {name!r}")
            seen.add(name)
    pairs = [("skills", "external_skills"), ("skills", "removed_skills"), ("external_skills", "removed_skills")]
    for first, second in pairs:
        overlap = sorted(set(lists[first]) & set(lists[second]))
        if overlap:
            raise ReleaseError(f"{first} 与 {second} 存在交叉名称: {overlap}")


def collect_definition_skill_refs(repo_root: Path) -> set[str]:
    """收集内置 definitions 的全部 skill 引用（语义同 cli/models.py normalize_skill）。"""
    definitions_dir = repo_root / "skills" / "aaw-workflow" / "scripts" / "cli" / "definitions"
    refs: set[str] = set()
    if not definitions_dir.is_dir():
        return refs
    for path in sorted(definitions_dir.rglob("*.yaml")):
        if path.name == FLOW_DEFINITION:
            continue
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            raise ReleaseError(f"definitions 文件解析失败 {path}: {exc}") from exc
        if not isinstance(data, dict):
            continue
        value = data.get("skill")
        if value is None:
            continue
        if isinstance(value, list):
            refs.update(str(item) for item in value)
        else:
            refs.add(str(value))
    return refs


def validate_definition_refs(refs: set[str], skills: list[str], external_skills: list[str]) -> None:
    """definitions 的每个 skill 引用必须位于 skills ∪ external_skills。"""
    unknown = sorted(refs - set(skills) - set(external_skills))
    if unknown:
        raise ReleaseError(
            f"definitions 引用了不在 skills/external_skills 中的 Skill: {unknown}；"
            "请将该 Skill 加入包内或在 scripts/release.yaml 的 external_skills 中声明"
        )


def build_manifest(
    version: str, skills: list[str], external_skills: list[str], removed_skills: list[str]
) -> dict:
    validate_names(skills, external_skills, removed_skills)
    return {
        "schema": MANIFEST_SCHEMA,
        "version": version,
        "skills": sorted(skills),
        "external_skills": sorted(external_skills),
        "removed_skills": sorted(removed_skills),
    }


def _is_excluded(path: Path) -> bool:
    return (
        bool(set(path.parts) & EXCLUDED_PARTS)
        or path.suffix == ".pyc"
        or path.name in EXCLUDED_NAMES
    )


def build_zip(repo_root: Path, manifest: dict, zip_path: Path) -> Path:
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_NAME, manifest_bytes)
        for skill in manifest["skills"]:
            skill_dir = repo_root / "skills" / skill
            for path in sorted(skill_dir.rglob("*")):
                if not path.is_file() or _is_excluded(path):
                    continue
                arcname = Path(skill) / path.relative_to(skill_dir)
                archive.write(path, arcname.as_posix())
    return zip_path


def verify_zip(zip_path: Path, manifest: dict) -> None:
    """重新打开 zip，按客户端同样的 manifest/顶层目录规则自检。"""
    expected_skills = set(manifest["skills"])
    with zipfile.ZipFile(zip_path) as archive:
        names = archive.namelist()
        top_level = {name.split("/")[0] for name in names}
        expected_top = expected_skills | {MANIFEST_NAME}
        if top_level != expected_top:
            missing = sorted(expected_top - top_level)
            extra = sorted(top_level - expected_top)
            raise ReleaseError(f"zip 顶层项与 manifest 不一致: 缺失 {missing}, 多余 {extra}")
        for skill in sorted(expected_skills):
            if f"{skill}/SKILL.md" not in names:
                raise ReleaseError(f"zip 中 {skill}/ 缺少 SKILL.md")
        zipped = json.loads(archive.read(MANIFEST_NAME).decode("utf-8"))
    if zipped.get("version") != manifest["version"]:
        raise ReleaseError(
            f"zip 内 manifest version {zipped.get('version')!r} 与打包版本 {manifest['version']!r} 不一致"
        )
    if sorted(zipped.get("skills", [])) != sorted(manifest["skills"]):
        raise ReleaseError("zip 内 manifest skills 与打包列表不一致")


def _is_package_excluded(relative: Path) -> bool:
    return (
        bool(set(relative.parts) & PACKAGE_EXCLUDED_PARTS)
        or (bool(relative.parts) and relative.parts[0] in PACKAGE_EXCLUDED_TOP_LEVEL)
        or relative.name in PACKAGE_EXCLUDED_NAMES
        or relative.suffix in {".pyc", ".pyo"}
    )


def build_component_tar(source_dir: Path, output: Path, root_name: str) -> Path:
    """构建组件源码包，过滤本地环境、运行数据和数据库配置。"""
    if not source_dir.is_dir():
        raise ReleaseError(f"组件目录不存在: {source_dir}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(output, "w:gz") as archive:
        for path in sorted(source_dir.rglob("*")):
            relative = path.relative_to(source_dir)
            if not path.is_file() or _is_package_excluded(relative):
                continue
            archive.add(path, arcname=(Path(root_name) / relative).as_posix(), recursive=False)
    return output


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_commit(repo_root: Path) -> str:
    github_sha = os.environ.get("GITHUB_SHA")
    if github_sha:
        return github_sha
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo_root, text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def write_release_metadata(
    repo_root: Path, version: str, manifest: dict, artifacts: list[Path]
) -> tuple[Path, Path]:
    metadata_path = DIST_DIR / "release-metadata.json"
    metadata = {
        "schema": 1,
        "release_version": version,
        "git_commit": git_commit(repo_root),
        "skills": manifest["skills"],
        "external_skills": manifest["external_skills"],
        "removed_skills": manifest["removed_skills"],
        "artifacts": [
            {
                "name": path.name,
                "size_bytes": path.stat().st_size,
                "sha256": file_sha256(path),
            }
            for path in artifacts
        ],
    }
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    checksummed = [*artifacts, metadata_path]
    checksums_path = DIST_DIR / "SHA256SUMS"
    checksums_path.write_text(
        "".join(f"{file_sha256(path)}  {path.name}\n" for path in checksummed),
        encoding="utf-8",
    )
    return metadata_path, checksums_path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "version",
        nargs="?",
        help="可选的新版本号；提供时先刷新所有版本声明，再构建发布物",
    )
    return parser.parse_args()


def main() -> None:
    try:
        args = parse_args()
        if args.version:
            changed = set_release_version(REPO_ROOT, args.version)
            print(f"refreshed version: {args.version} ({len(changed)} files)")
        version = read_version(REPO_ROOT)
        mismatches = check_consistency(REPO_ROOT, version)
        if mismatches:
            raise ReleaseError(
                f"以下文件版本与 VERSION ({version}) 不一致:\n" + "\n".join(mismatches)
            )
        check_script_dependencies(REPO_ROOT)
        skills = collect_skills(REPO_ROOT)
        check_skill_versions(REPO_ROOT, version, skills)
        external_skills, removed_skills = load_release_config(REPO_ROOT)
        manifest = build_manifest(version, skills, external_skills, removed_skills)
        refs = collect_definition_skill_refs(REPO_ROOT)
        validate_definition_refs(refs, manifest["skills"], manifest["external_skills"])
        zip_path = build_zip(REPO_ROOT, manifest, DIST_DIR / f"aaw-skills-{version}.zip")
        verify_zip(zip_path, manifest)
        server_path = build_component_tar(
            SERVER_DIR,
            DIST_DIR / f"aaw-telemetry-server-{version}.tar.gz",
            "telemetry-server",
        )
        portal_path = build_component_tar(
            PORTAL_DIR,
            DIST_DIR / f"aaw-telemetry-portal-{version}.tar.gz",
            "portal",
        )
        metadata_path, checksums_path = write_release_metadata(
            REPO_ROOT, version, manifest, [zip_path, server_path, portal_path]
        )
    except ReleaseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    size = zip_path.stat().st_size
    print(f"{zip_path}")
    print(f"size: {size} bytes ({size / 1024:.1f} KiB)")
    print(f"version: {version}")
    print(f"skills: {len(manifest['skills'])}")
    print(f"server: {server_path}")
    print(f"portal: {portal_path}")
    print(f"metadata: {metadata_path}")
    print(f"checksums: {checksums_path}")


if __name__ == "__main__":
    main()
