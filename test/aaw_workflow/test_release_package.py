"""Tests for scripts/make_release.py — 完整 Skill 发布包打包（docs/auto-update-design.md §6）。

核心逻辑以可 import 的函数形式测试：用 tmp 目录伪造仓库结构（skills 树 +
release.yaml + definitions）驱动，不真打真仓库；仅 DiscoveryTests 对真仓库
跑 collect + refs 校验（不产物）。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import yaml

import _cli_base  # noqa: F401  (adds scripts dir to sys.path)
from _cli_base import ROOT

sys.path.insert(0, str(ROOT / "scripts"))
import make_release  # noqa: E402

MANIFEST = "release-manifest.json"


class FakeRepoTestBase(unittest.TestCase):
    """在 tmp 目录下伪造仓库结构：skills 树 + scripts/release.yaml + definitions。"""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "skills").mkdir(parents=True)

    def add_skill(self, name: str, files: dict[str, str] | None = None) -> None:
        skill_dir = self.repo / "skills" / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(f"# {name}\n", "utf-8")
        for relative, content in (files or {}).items():
            path = skill_dir / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, "utf-8")

    def write_config(self, external: list[str] | None = None, removed: list[str] | None = None) -> None:
        scripts_dir = self.repo / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        config = {"external_skills": external or [], "removed_skills": removed or []}
        (scripts_dir / "release.yaml").write_text(yaml.safe_dump(config), "utf-8")

    def write_definitions(self, definitions: dict[str, str]) -> None:
        definitions_dir = self.repo / "skills" / "aaw-workflow" / "scripts" / "cli" / "definitions"
        definitions_dir.mkdir(parents=True, exist_ok=True)
        for name, content in definitions.items():
            (definitions_dir / name).write_text(content, "utf-8")

    def build_fake_manifest(self, version: str = "1.0.0") -> dict:
        skills = make_release.collect_skills(self.repo)
        external, removed = make_release.load_release_config(self.repo)
        return make_release.build_manifest(version, skills, external, removed)


class DiscoveryTests(unittest.TestCase):
    """真仓库：动态发现与 definitions 引用校验（不产物）。"""

    def test_collect_skills_matches_repo_skill_dirs(self) -> None:
        expected = sorted(
            path.name
            for path in (ROOT / "skills").iterdir()
            if path.is_dir() and (path / "SKILL.md").is_file()
        )
        skills = make_release.collect_skills(ROOT)
        manifest = make_release.build_manifest(make_release.read_version(ROOT), skills, [], [])
        self.assertEqual(expected, skills)
        self.assertEqual(expected, manifest["skills"])
        self.assertNotIn("question-tracker-mcp", skills)  # 无 SKILL.md 的辅助目录

    def test_real_repo_definition_refs_resolve(self) -> None:
        skills = make_release.collect_skills(ROOT)
        external, removed = make_release.load_release_config(ROOT)
        manifest = make_release.build_manifest(make_release.read_version(ROOT), skills, external, removed)
        refs = make_release.collect_definition_skill_refs(ROOT)
        make_release.validate_definition_refs(refs, manifest["skills"], manifest["external_skills"])
        self.assertTrue(refs)  # 确实收集到了引用，上面的校验不是空转


class CollectSkillsTests(FakeRepoTestBase):
    def test_new_skill_dir_is_packaged_automatically(self) -> None:
        self.add_skill("alpha")
        self.add_skill("beta-new")  # 新增目录无需修改脚本即入包
        manifest = self.build_fake_manifest()
        self.assertEqual(["alpha", "beta-new"], manifest["skills"])

    def test_dir_without_skill_md_is_not_packaged(self) -> None:
        self.add_skill("alpha")
        (self.repo / "skills" / "helper-tool").mkdir(parents=True)  # 无 SKILL.md
        manifest = self.build_fake_manifest()
        self.assertEqual(["alpha"], manifest["skills"])

    def test_manifest_shape(self) -> None:
        self.add_skill("beta")
        self.add_skill("alpha")
        self.write_config(external=["ext-skill"], removed=["old-skill"])
        manifest = self.build_fake_manifest(version="1.2.0")
        self.assertEqual(1, manifest["schema"])
        self.assertEqual("1.2.0", manifest["version"])
        self.assertEqual(["alpha", "beta"], manifest["skills"])  # 排序
        self.assertEqual(["ext-skill"], manifest["external_skills"])
        self.assertEqual(["old-skill"], manifest["removed_skills"])


class LoadReleaseConfigTests(FakeRepoTestBase):
    def test_missing_config_defaults_to_empty(self) -> None:
        self.assertEqual(([], []), make_release.load_release_config(self.repo))

    def test_config_roundtrip(self) -> None:
        self.write_config(external=["ext-skill"], removed=["old-skill"])
        self.assertEqual((["ext-skill"], ["old-skill"]), make_release.load_release_config(self.repo))

    def test_real_repo_config_loads(self) -> None:
        external, removed = make_release.load_release_config(ROOT)
        self.assertIsInstance(external, list)
        self.assertIsInstance(removed, list)


class ValidateNamesTests(unittest.TestCase):
    def test_valid_lists_accepted(self) -> None:
        make_release.validate_names(["a", "b"], ["ext"], ["old"])

    def test_reserved_prefix_rejected(self) -> None:
        for lists in ([".aaw-foo"], [], []), ([], [".aaw-lock"], []), ([], [], [".aaw-old"]):
            with self.assertRaises(make_release.ReleaseError, msg=str(lists)):
                make_release.validate_names(*lists)

    def test_path_separator_and_dot_names_rejected(self) -> None:
        for bad in ("a/b", "a\\b", "..", ".", ".hidden"):
            with self.assertRaises(make_release.ReleaseError, msg=bad):
                make_release.validate_names([bad], [], [])

    def test_empty_and_non_string_names_rejected(self) -> None:
        for bad in ("", None, 3):
            with self.assertRaises(make_release.ReleaseError, msg=repr(bad)):
                make_release.validate_names([bad], [], [])

    def test_duplicate_names_rejected(self) -> None:
        for lists in (["a", "a"], [], []), ([], ["x", "x"], []), ([], [], ["y", "y"]):
            with self.assertRaises(make_release.ReleaseError, msg=str(lists)):
                make_release.validate_names(*lists)

    def test_cross_list_overlap_rejected(self) -> None:
        for lists in (["a"], ["a"], []), (["a"], [], ["a"]), ([], ["b"], ["b"]):
            with self.assertRaises(make_release.ReleaseError, msg=str(lists)):
                make_release.validate_names(*lists)

    def test_overlap_detected_after_sorting(self) -> None:
        with self.assertRaises(make_release.ReleaseError):
            make_release.build_manifest("1.0.0", ["b", "a"], ["a"], [])


class DefinitionRefTests(FakeRepoTestBase):
    def test_refs_collected_from_list_and_string_forms(self) -> None:
        self.write_definitions(
            {
                "a.yaml": "name: a\nexecution: skill\nskill: [alpha, beta]\n",
                "b.yaml": "name: b\nexecution: skill\nskill: gamma\n",
                "c.yaml": "name: c\nexecution: prompt\nprompt:\n  inline: hi\n",
            }
        )
        self.assertEqual({"alpha", "beta", "gamma"}, make_release.collect_definition_skill_refs(self.repo))

    def test_flow_yaml_is_excluded(self) -> None:
        self.write_definitions({"flow.yaml": "version: 2\nskill: [ghost]\n"})
        self.assertEqual(set(), make_release.collect_definition_skill_refs(self.repo))

    def test_missing_definitions_dir_yields_no_refs(self) -> None:
        self.assertEqual(set(), make_release.collect_definition_skill_refs(self.repo))

    def test_unknown_ref_rejected(self) -> None:
        with self.assertRaises(make_release.ReleaseError):
            make_release.validate_definition_refs({"ghost"}, ["alpha"], [])

    def test_external_ref_allowed(self) -> None:
        make_release.validate_definition_refs({"ext-skill"}, ["alpha"], ["ext-skill"])

    def test_fake_repo_unknown_ref_rejected_end_to_end(self) -> None:
        self.add_skill("aaw-workflow")
        self.write_definitions({"x.yaml": "name: x\nexecution: skill\nskill: [ghost-skill]\n"})
        manifest = self.build_fake_manifest()
        refs = make_release.collect_definition_skill_refs(self.repo)
        with self.assertRaises(make_release.ReleaseError):
            make_release.validate_definition_refs(refs, manifest["skills"], manifest["external_skills"])

    def test_fake_repo_external_ref_passes_and_is_not_packaged(self) -> None:
        self.add_skill("aaw-workflow")
        self.write_config(external=["ext-skill"])
        self.write_definitions({"x.yaml": "name: x\nexecution: skill\nskill: [ext-skill]\n"})
        manifest = self.build_fake_manifest()
        refs = make_release.collect_definition_skill_refs(self.repo)
        make_release.validate_definition_refs(refs, manifest["skills"], manifest["external_skills"])
        zip_path = make_release.build_zip(self.repo, manifest, Path(self.tmp.name) / "out.zip")
        make_release.verify_zip(zip_path, manifest)
        with zipfile.ZipFile(zip_path) as archive:
            top_level = {name.split("/")[0] for name in archive.namelist()}
        self.assertNotIn("ext-skill", top_level)


class ZipTests(FakeRepoTestBase):
    def build_and_verify(self, version: str = "1.2.0") -> Path:
        manifest = self.build_fake_manifest(version)
        zip_path = make_release.build_zip(
            self.repo, manifest, Path(self.tmp.name) / "dist" / f"aaw-skills-{version}.zip"
        )
        make_release.verify_zip(zip_path, manifest)
        return zip_path

    def test_roundtrip_with_exclusions(self) -> None:
        self.add_skill(
            "alpha",
            files={
                "scripts/run.py": "print('hi')\n",
                "scripts/__pycache__/run.cpython-311.pyc": "junk",
                "__pycache__/other.py": "junk",
                ".pytest_cache/v/cache/lastfailed": "junk",
                ".DS_Store": "junk",
            },
        )
        self.add_skill("beta")
        zip_path = self.build_and_verify("1.2.0")
        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            zipped = json.loads(archive.read(MANIFEST).decode("utf-8"))
        self.assertIn("alpha/SKILL.md", names)
        self.assertIn("alpha/scripts/run.py", names)
        self.assertIn("beta/SKILL.md", names)
        for excluded in (
            "alpha/scripts/__pycache__/run.cpython-311.pyc",
            "alpha/__pycache__/other.py",
            "alpha/.pytest_cache/v/cache/lastfailed",
            "alpha/.DS_Store",
        ):
            self.assertNotIn(excluded, names)
        self.assertEqual(1, zipped["schema"])
        self.assertEqual("1.2.0", zipped["version"])
        self.assertEqual(["alpha", "beta"], zipped["skills"])
        self.assertEqual([], zipped["external_skills"])
        self.assertEqual([], zipped["removed_skills"])

    def write_raw_zip(self, entries: dict[str, str]) -> Path:
        zip_path = Path(self.tmp.name) / "raw.zip"
        with zipfile.ZipFile(zip_path, "w") as archive:
            for arcname, content in entries.items():
                archive.writestr(arcname, content)
        return zip_path

    def manifest_for(self, skills: list[str], version: str = "1.0.0") -> dict:
        return {
            "schema": 1,
            "version": version,
            "skills": skills,
            "external_skills": [],
            "removed_skills": [],
        }

    def test_verify_rejects_extra_top_level_entry(self) -> None:
        manifest = self.manifest_for(["alpha"])
        zip_path = self.write_raw_zip(
            {
                MANIFEST: json.dumps(manifest),
                "alpha/SKILL.md": "# alpha",
                "rogue/x.txt": "x",
            }
        )
        with self.assertRaises(make_release.ReleaseError):
            make_release.verify_zip(zip_path, manifest)

    def test_verify_rejects_missing_manifest(self) -> None:
        manifest = self.manifest_for(["alpha"])
        zip_path = self.write_raw_zip({"alpha/SKILL.md": "# alpha"})
        with self.assertRaises(make_release.ReleaseError):
            make_release.verify_zip(zip_path, manifest)

    def test_verify_rejects_skill_dir_without_skill_md(self) -> None:
        manifest = self.manifest_for(["alpha", "beta"])
        zip_path = self.write_raw_zip(
            {
                MANIFEST: json.dumps(manifest),
                "alpha/SKILL.md": "# alpha",
                "beta/readme.txt": "no skill md here",
            }
        )
        with self.assertRaises(make_release.ReleaseError):
            make_release.verify_zip(zip_path, manifest)

    def test_verify_rejects_version_mismatch(self) -> None:
        manifest = self.manifest_for(["alpha"], version="1.0.0")
        zip_path = self.write_raw_zip(
            {
                MANIFEST: json.dumps(self.manifest_for(["alpha"], version="1.0.1")),
                "alpha/SKILL.md": "# alpha",
            }
        )
        with self.assertRaises(make_release.ReleaseError):
            make_release.verify_zip(zip_path, manifest)

    def test_verify_rejects_missing_skill_dir(self) -> None:
        manifest = self.manifest_for(["alpha", "beta"])
        zip_path = self.write_raw_zip(
            {
                MANIFEST: json.dumps(manifest),
                "alpha/SKILL.md": "# alpha",
            }
        )
        with self.assertRaises(make_release.ReleaseError):
            make_release.verify_zip(zip_path, manifest)


class ScriptDependencyTests(FakeRepoTestBase):
    """aaw.py PEP 723 内联依赖与 pyproject.toml 的一致性校验。"""

    def write_entry(self, dependencies: list[str] | None, with_block: bool = True) -> None:
        scripts_dir = self.repo / "skills" / "aaw-workflow" / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        if with_block:
            deps = "\n".join(f'#     "{d}",' for d in dependencies or [])
            header = (
                "# /// script\n"
                '# requires-python = ">=3.10"\n'
                "# dependencies = [\n"
                f"{deps}\n"
                "# ]\n"
                "# ///\n"
            )
        else:
            header = ""
        (scripts_dir / "aaw.py").write_text(f'"""entry"""\n{header}import sys\n', "utf-8")

    def write_pyproject(self, dependencies: list[str]) -> None:
        deps = "\n".join(f'    "{d}",' for d in dependencies)
        (self.repo / "pyproject.toml").write_text(
            f'[project]\nname = "aaw"\nversion = "1.0.0"\ndependencies = [\n{deps}\n]\n',
            "utf-8",
        )

    def test_matching_dependencies_pass(self) -> None:
        self.write_entry(["typer>=0.12", "pyyaml>=6.0"])
        self.write_pyproject(["pyyaml>=6.0", "typer>=0.12"])  # 顺序无关
        make_release.check_script_dependencies(self.repo)

    def test_missing_inline_block_rejected(self) -> None:
        self.write_entry(None, with_block=False)
        self.write_pyproject(["typer>=0.12"])
        with self.assertRaises(make_release.ReleaseError):
            make_release.check_script_dependencies(self.repo)

    def test_dependency_mismatch_rejected(self) -> None:
        self.write_entry(["typer>=0.12"])
        self.write_pyproject(["typer>=0.12", "pyyaml>=6.0"])
        with self.assertRaises(make_release.ReleaseError):
            make_release.check_script_dependencies(self.repo)

    def test_real_repo_passes(self) -> None:
        make_release.check_script_dependencies(ROOT)


class SkillVersionTests(FakeRepoTestBase):
    """SKILL.md frontmatter version 四段格式，前三段必须等于发布版本。"""

    def add_versioned_skill(self, name: str, version: str | None, quoted: bool = True) -> None:
        skill_dir = self.repo / "skills" / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        if version is None:
            frontmatter = f"---\nname: {name}\n---\n"
        else:
            rendered = f'"{version}"' if quoted else version
            frontmatter = f"---\nname: {name}\nversion: {rendered}\n---\n"
        (skill_dir / "SKILL.md").write_text(f"{frontmatter}\n# {name}\n", "utf-8")

    def test_matching_versions_pass(self) -> None:
        self.add_versioned_skill("alpha", "1.2.0.0")
        self.add_versioned_skill("beta", "1.2.0.5")  # 第四段独立演进
        make_release.check_skill_versions(self.repo, "1.2.0", ["alpha", "beta"])

    def test_missing_version_rejected(self) -> None:
        self.add_versioned_skill("alpha", None)
        with self.assertRaises(make_release.ReleaseError):
            make_release.check_skill_versions(self.repo, "1.2.0", ["alpha"])

    def test_three_part_version_rejected(self) -> None:
        self.add_versioned_skill("alpha", "1.2.0")
        with self.assertRaises(make_release.ReleaseError) as ctx:
            make_release.check_skill_versions(self.repo, "1.2.0", ["alpha"])
        self.assertIn("四段", str(ctx.exception))

    def test_prefix_mismatch_rejected(self) -> None:
        self.add_versioned_skill("alpha", "1.1.9.0")
        with self.assertRaises(make_release.ReleaseError) as ctx:
            make_release.check_skill_versions(self.repo, "1.2.0", ["alpha"])
        self.assertIn("前三段", str(ctx.exception))

    def test_unquoted_yaml_scalar_rejected(self) -> None:
        # 不加引号时 YAML 可能解析成非字符串，必须显式拒绝
        self.add_versioned_skill("alpha", "1.2", quoted=False)
        with self.assertRaises(make_release.ReleaseError):
            make_release.check_skill_versions(self.repo, "1.2.0", ["alpha"])

    def test_real_repo_skill_versions_pass(self) -> None:
        version = make_release.read_version(ROOT)
        skills = make_release.collect_skills(ROOT)
        make_release.check_skill_versions(ROOT, version, skills)


if __name__ == "__main__":
    unittest.main()
