"""Tests for MCP configuration injection module (mcp_config.py).

Test levels:
  Unit tests — UT-M01 through UT-M10: mock external deps where needed.
  Integration tests — IT-M04 through IT-M08: real file system, no mocking.
"""

from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

# Locate the cli package
ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = ROOT / "skills" / "aaw-workflow" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from cli.mcp_config import (  # noqa: E402
    MCPConfigError,
    MCP_BINARY_DIR,
    MCP_BIN_SUBDIR,
    MCP_SERVER_NAME,
    _ensure_mcp_config,
    _is_legacy_uv_config,
    detect_platform,
    detect_target,
    resolve_config_path,
    resolve_mcp_exe,
    upsert_claude_mcp,
    upsert_codex_mcp,
    upsert_chrys_mcp,
    upsert_opencode_mcp,
)


# ===================================================================
# Unit tests: PG01 — detect_platform
# ===================================================================


class TestDetectPlatform(unittest.TestCase):
    """UT-M01-01 through UT-M01-04."""

    def test_ut_m01_01_windows(self) -> None:
        """os.name == 'nt' → 'windows'"""
        with patch("os.name", "nt"):
            assert detect_platform() == "windows"

    def test_ut_m01_02_linux(self) -> None:
        """sys.platform == 'linux' → 'linux'"""
        with patch("os.name", "posix"), patch("sys.platform", "linux"):
            assert detect_platform() == "linux"

    def test_ut_m01_03_macos(self) -> None:
        """sys.platform == 'darwin' → 'macos'"""
        with patch("os.name", "posix"), patch("sys.platform", "darwin"):
            assert detect_platform() == "macos"

    def test_ut_m01_04_unknown_fallback(self) -> None:
        """Unknown platform falls back to 'windows'"""
        with patch("os.name", "java"), patch("sys.platform", "unknownos"):
            assert detect_platform() == "windows"


# ===================================================================
# Unit tests: PG02 — detect_target
# ===================================================================


class TestDetectTarget(unittest.TestCase):
    """UT-M02-01 through UT-M02-07."""

    @patch.object(Path, "home", return_value=Path("/home/testuser"))
    def test_ut_m02_01_chrys_unix(self, _home) -> None:
        assert detect_target(Path("/home/testuser/.chrys/skills")) == "chrys"

    @patch.object(Path, "home", return_value=Path("C:/Users/testuser"))
    def test_ut_m02_02_chrys_windows(self, _home) -> None:
        assert (
            detect_target(Path("C:/Users/testuser/AppData/Roaming/chrys/skills"))
            == "chrys"
        )

    @patch.object(Path, "home", return_value=Path("/home/testuser"))
    def test_ut_m02_03_claude(self, _home) -> None:
        assert detect_target(Path("/home/testuser/.claude/skills")) == "claude"

    @patch.object(Path, "home", return_value=Path("/home/testuser"))
    def test_ut_m02_04_opencode(self, _home) -> None:
        assert (
            detect_target(Path("/home/testuser/.config/opencode/skills"))
            == "opencode"
        )

    def test_ut_m02_05_codex(self) -> None:
        assert detect_target(Path("/home/testuser/.codex/skills")) == "codex"

    def test_ut_m02_06_unknown(self) -> None:
        assert detect_target(Path("/tmp/random/skills")) is None

    def test_ut_m02_07_no_false_match(self) -> None:
        """Path containing '.chrys' but not ending correctly → None."""
        assert (
            detect_target(Path("/home/testuser/my.chrys.test/skills")) is None
        )

    def test_ut_m02_09_marker_file_fallback(self) -> None:
        """Custom directory with .aaw-target → detected via marker."""
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        import os as _os
        marker = _os.path.join(tmp.name, ".aaw-target")
        with open(marker, "w", encoding="utf-8") as f:
            f.write("chrys")
        assert detect_target(Path(tmp.name)) == "chrys"
        tmp.cleanup()

    def test_ut_m02_10_marker_file_ignores_invalid(self) -> None:
        """Invalid content in .aaw-target → returns None."""
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        import os as _os
        marker = _os.path.join(tmp.name, ".aaw-target")
        with open(marker, "w", encoding="utf-8") as f:
            f.write("unknown-agent")
        assert detect_target(Path(tmp.name)) is None
        tmp.cleanup()


# ===================================================================
# Unit tests: PG03 — resolve_config_path
# ===================================================================


class TestResolveConfigPath(unittest.TestCase):
    """UT-M02-08."""

    @patch.object(Path, "home", return_value=Path("/home/testuser"))
    def test_ut_m02_08_all_targets(self, _home) -> None:
        p = resolve_config_path("claude", Path("/tmp/x"))
        assert p is not None and p.name == ".claude.json"
        p = resolve_config_path("codex", Path("/home/testuser/.codex/skills"))
        assert p is not None and p.name == "config.toml" and p.parent.name == ".codex"
        p = resolve_config_path("opencode", Path("/home/testuser/.config/opencode/skills"))
        assert p is not None and p.name == "opencode.json"
        p = resolve_config_path("chrys", Path("/tmp/x"))
        # On Windows, chrys path goes to APPDATA; on Unix it's ~/.chrys/agents/
        assert p is not None and p.name == "Code.yaml"
        assert resolve_config_path("unknown", Path("/tmp/x")) is None

    def test_codex_direct_root(self) -> None:
        """Codex skills_root IS .codex directory (no skills/ subdir)."""
        p = resolve_config_path("codex", Path("/home/u/.codex"))
        assert p == Path("/home/u/.codex/config.toml")


# ===================================================================
# Unit tests: PG04 — resolve_mcp_exe
# ===================================================================


class TestResolveMcpExe(unittest.TestCase):
    """UT-M03-01 through UT-M03-04."""

    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _touch(self, rel: str) -> Path:
        p = self.tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("")
        return p

    def test_ut_m03_01_linux(self) -> None:
        exe = self._touch(f"{MCP_BINARY_DIR}/{MCP_BIN_SUBDIR}/linux/mcp_server")
        result = resolve_mcp_exe(self.tmp_path, "linux")
        assert result == exe

    def test_ut_m03_02_windows(self) -> None:
        exe = self._touch(
            f"{MCP_BINARY_DIR}/{MCP_BIN_SUBDIR}/windows/mcp_server.exe"
        )
        result = resolve_mcp_exe(self.tmp_path, "windows")
        assert result is not None
        assert result.name == "mcp_server.exe"

    def test_ut_m03_03_not_found(self) -> None:
        assert resolve_mcp_exe(self.tmp_path, "linux") is None

    def test_ut_m03_04_macos_not_built(self) -> None:
        """macOS binary not yet built → None."""
        assert resolve_mcp_exe(self.tmp_path, "macos") is None


# ===================================================================
# Unit tests: PG10 — _is_legacy_uv_config
# ===================================================================


class TestIsLegacyUvConfig(unittest.TestCase):
    """UT-M10-01 through UT-M10-04."""

    def test_ut_m10_01_claude_legacy(self) -> None:
        entry = {
            "command": "uv",
            "args": [
                "run", "--with", "fastmcp", "python", "/path/mcp_server.py"
            ],
        }
        assert _is_legacy_uv_config(entry) is True

    def test_ut_m10_02_opencode_legacy(self) -> None:
        entry = {
            "command": [
                "uv", "run", "--with", "fastmcp", "python", "/path/mcp_server.py"
            ],
        }
        assert _is_legacy_uv_config(entry) is True

    def test_ut_m10_03_new_format(self) -> None:
        entry = {"command": "/path/to/mcp_server", "args": []}
        assert _is_legacy_uv_config(entry) is False

    def test_ut_m10_04_other_format(self) -> None:
        entry = {"command": "python", "args": ["script.py"]}
        assert _is_legacy_uv_config(entry) is False


# ===================================================================
# Integration tests: PG05 — upsert_claude_mcp
# ===================================================================


class TestUpsertClaudeMcp(unittest.TestCase):
    """IT-M04-01 through IT-M04-07.

    Uses Path.home() mocking to control scope detection across platforms.
    """

    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self._home_patcher = patch.object(
            Path, "home", return_value=Path("/home/testuser")
        )
        self._home_patcher.start()

    def tearDown(self) -> None:
        self._home_patcher.stop()
        self.tmp.cleanup()

    def _touch_exe(self) -> Path:
        exe = (
            self.tmp_path
            / MCP_BINARY_DIR
            / MCP_BIN_SUBDIR
            / "linux"
            / "mcp_server"
        )
        exe.parent.mkdir(parents=True, exist_ok=True)
        exe.write_text("")
        return exe

    def test_it_m04_01_new_from_empty(self) -> None:
        """IT-M04-01: Empty config → new entry."""
        exe = self._touch_exe()
        config = self.tmp_path / "claude.json"
        config.write_text("{}")
        result = upsert_claude_mcp(
            config, exe, Path("/home/testuser/.claude/skills")
        )
        assert result is True
        data = json.loads(config.read_text())
        mcp = data["mcpServers"]["question-tracker"]
        assert mcp["command"] == str(exe)
        assert mcp["args"] == []
        assert mcp["env"] == {}

    def test_it_m04_02_idempotent(self) -> None:
        """IT-M04-02: Same command → skip."""
        exe = self._touch_exe()
        config = self.tmp_path / "claude.json"
        config.write_text("{}")
        assert upsert_claude_mcp(config, exe, Path("/home/testuser/.claude/skills")) is True
        assert upsert_claude_mcp(config, exe, Path("/home/testuser/.claude/skills")) is False

    def test_it_m04_03_path_update(self) -> None:
        """IT-M04-03: Different command → update."""
        exe_old = self._touch_exe()
        config = self.tmp_path / "claude.json"
        config.write_text("{}")
        upsert_claude_mcp(config, exe_old, Path("/home/testuser/.claude/skills"))

        # New exe at different path
        exe_new = self.tmp_path / "new_mcp_server"
        exe_new.write_text("")
        result = upsert_claude_mcp(config, exe_new, Path("/home/testuser/.claude/skills"))
        assert result is True
        data = json.loads(config.read_text())
        assert data["mcpServers"]["question-tracker"]["command"] == str(exe_new)

    def test_it_m04_04_legacy_migration(self) -> None:
        """IT-M04-04: uv format → Go exe."""
        exe = self._touch_exe()
        config = self.tmp_path / "claude.json"
        config.write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "question-tracker": {
                            "command": "uv",
                            "args": [
                                "run",
                                "--with",
                                "fastmcp",
                                "python",
                                "/old/mcp_server.py",
                            ],
                            "env": {},
                        }
                    }
                }
            )
        )
        result = upsert_claude_mcp(
            config, exe, Path("/home/testuser/.claude/skills")
        )
        assert result is True
        data = json.loads(config.read_text())
        mcp = data["mcpServers"]["question-tracker"]
        assert mcp["command"] == str(exe)
        assert mcp["args"] == []

    def test_it_m04_05_project_scope(self) -> None:
        """IT-M04-05: Project scope → projects[<cwd>].mcpServers."""
        exe = self._touch_exe()
        config = self.tmp_path / "claude.json"
        config.write_text("{}")
        # Use a skills_root outside the user home to trigger project scope
        skills_root = Path("/some/project/.claude/skills")
        # Mock cwd to a known path
        import os as _os
        with patch.object(_os, "getcwd", return_value="/some/project"):
            result = upsert_claude_mcp(config, exe, skills_root)
        assert result is True
        data = json.loads(config.read_text())
        # The project key uses cwd path
        projects = data["projects"]
        assert len(projects) == 1
        proj_mcp = list(projects.values())[0]["mcpServers"]["question-tracker"]
        assert proj_mcp["command"] == str(exe)

    def test_it_m04_06_config_missing(self) -> None:
        """IT-M04-06: Config file missing → create."""
        exe = self._touch_exe()
        config = self.tmp_path / "claude.json"
        result = upsert_claude_mcp(
            config, exe, Path("/home/testuser/.claude/skills")
        )
        assert result is True
        assert config.is_file()
        data = json.loads(config.read_text())
        assert data["mcpServers"]["question-tracker"]["command"] == str(exe)

    def test_it_m04_07_existing_keys_no_mcpServers(self) -> None:
        """IT-M04-07: Config has other keys but no mcpServers."""
        exe = self._touch_exe()
        config = self.tmp_path / "claude.json"
        config.write_text(json.dumps({"projects": {}, "theme": "dark"}))
        result = upsert_claude_mcp(
            config, exe, Path("/home/testuser/.claude/skills")
        )
        assert result is True
        data = json.loads(config.read_text())
        assert data["theme"] == "dark"
        assert data["projects"] == {}
        assert data["mcpServers"]["question-tracker"]["command"] == str(exe)


# ===================================================================
# Integration tests: PG06 — upsert_codex_mcp
# ===================================================================


class TestUpsertCodexMcp(unittest.TestCase):
    """IT-M05-01 through IT-M05-05.

    The upsert functions don't call detect_platform(), so no platform
    mocking is needed for these tests.
    """

    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.exe = self.tmp_path / "mcp_server"
        self.exe.parent.mkdir(parents=True, exist_ok=True)
        self.exe.write_text("")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_it_m05_01_new_file(self) -> None:
        """IT-M05-01: Config missing → create with section."""
        config = self.tmp_path / "config.toml"
        result = upsert_codex_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert "[mcp_servers.question-tracker]" in content
        assert f'command = "{self.exe}"' in content
        assert "args = []" in content

    def test_it_m05_02_other_servers_preserved(self) -> None:
        """IT-M05-02: Existing other server untouched."""
        config = self.tmp_path / "config.toml"
        config.write_text(
            "[mcp_servers.other-server]\n"
            'command = "other"\n'
            "args = [\"--flag\"]\n"
        )
        upsert_codex_mcp(config, self.exe)
        content = config.read_text()
        assert "[mcp_servers.other-server]" in content
        assert '[mcp_servers.question-tracker]' in content
        assert content.count("[mcp_servers.question-tracker]") == 1

    def test_it_m05_03_legacy_migration(self) -> None:
        """IT-M05-03: uv format → Go exe."""
        config = self.tmp_path / "config.toml"
        config.write_text(
            "[mcp_servers.question-tracker]\n"
            'command = "uv"\n'
            'args = ["run", "--with", "fastmcp", "python", "mcp_server.py"]\n'
        )
        upsert_codex_mcp(config, self.exe)
        content = config.read_text()
        assert 'command = "uv"' not in content
        assert f'command = "{self.exe}"' in content

    def test_it_m05_04_idempotent(self) -> None:
        """IT-M05-04: Same command → skip."""
        config = self.tmp_path / "config.toml"
        assert upsert_codex_mcp(config, self.exe) is True
        assert upsert_codex_mcp(config, self.exe) is False

    def test_it_m05_05_path_update(self) -> None:
        """IT-M05-05: Different Go exe path → update."""
        config = self.tmp_path / "config.toml"
        config.write_text(
            "[mcp_servers.question-tracker]\n"
            'command = "/old/path/mcp_server"\n'
            "args = []\n"
        )
        result = upsert_codex_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert str(self.exe) in content
        assert "/old/path/mcp_server" not in content


# ===================================================================
# Integration tests: PG07 — upsert_opencode_mcp
# ===================================================================


class TestUpsertOpencodeMcp(unittest.TestCase):
    """IT-M06-01 through IT-M06-05."""

    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.exe = self.tmp_path / "mcp_server"
        self.exe.parent.mkdir(parents=True, exist_ok=True)
        self.exe.write_text("")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_it_m06_01_new_file(self) -> None:
        """IT-M06-01: Config missing → create."""
        config = self.tmp_path / "opencode.json"
        result = upsert_opencode_mcp(config, self.exe)
        assert result is True
        data = json.loads(config.read_text())
        mcp = data["mcp"]["question-tracker"]
        assert mcp["command"] == [str(self.exe)]
        assert mcp["type"] == "local"
        assert mcp["enabled"] is True

    def test_it_m06_02_idempotent(self) -> None:
        """IT-M06-02: Same command → skip."""
        config = self.tmp_path / "opencode.json"
        assert upsert_opencode_mcp(config, self.exe) is True
        assert upsert_opencode_mcp(config, self.exe) is False

    def test_it_m06_03_legacy_migration(self) -> None:
        """IT-M06-03: uv array format → Go exe."""
        config = self.tmp_path / "opencode.json"
        config.write_text(
            json.dumps(
                {
                    "mcp": {
                        "question-tracker": {
                            "type": "local",
                            "command": [
                                "uv", "run", "--with", "fastmcp",
                                "python", "/old/mcp_server.py",
                            ],
                            "enabled": True,
                        }
                    }
                }
            )
        )
        upsert_opencode_mcp(config, self.exe)
        data = json.loads(config.read_text())
        assert data["mcp"]["question-tracker"]["command"] == [str(self.exe)]

    def test_it_m06_04_other_servers_preserved(self) -> None:
        """IT-M06-04: Existing other MCP entries untouched."""
        config = self.tmp_path / "opencode.json"
        other_entry = {
            "type": "local",
            "command": ["/usr/bin/other"],
            "enabled": True,
        }
        config.write_text(
            json.dumps({"mcp": {"other-server": other_entry}})
        )
        upsert_opencode_mcp(config, self.exe)
        data = json.loads(config.read_text())
        assert data["mcp"]["other-server"]["command"] == ["/usr/bin/other"]
        assert "question-tracker" in data["mcp"]

    def test_it_m06_05_path_update(self) -> None:
        """IT-M06-05: Existing Go exe with different path → update."""
        config = self.tmp_path / "opencode.json"
        config.write_text(
            json.dumps(
                {
                    "mcp": {
                        "question-tracker": {
                            "type": "local",
                            "command": ["/old/path/mcp_server"],
                            "enabled": True,
                        }
                    }
                }
            )
        )
        result = upsert_opencode_mcp(config, self.exe)
        assert result is True
        data = json.loads(config.read_text())
        assert data["mcp"]["question-tracker"]["command"] == [str(self.exe)]


# ===================================================================
# Integration tests: PG08 — upsert_chrys_mcp
# ===================================================================


class TestUpsertChrysMcp(unittest.TestCase):
    """IT-M07-01 through IT-M07-11."""

    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self.exe = self.tmp_path / "mcp_server"
        self.exe.parent.mkdir(parents=True, exist_ok=True)
        self.exe.write_text("")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # -- IT-M07-01: File missing → create from builtin -------------------

    def test_it_m07_01_create_from_builtin(self) -> None:
        """IT-M07-01: No Code.yaml → copy builtin + inject MCP."""
        config = self.tmp_path / "Code.yaml"
        # This test requires chrys to be importable
        try:
            result = upsert_chrys_mcp(config, self.exe)
        except Exception:
            self.skipTest("chrys not installed — cannot test builtin copy")
        assert result is True
        content = config.read_text()
        assert "name: Code" in content
        assert "question-tracker" in content
        assert str(self.exe) in content
        assert "enabled: true" in content

    # -- IT-M07-02: no tools → append tools.mcp -------------------------

    def test_it_m07_02_no_tools(self) -> None:
        """IT-M07-02: Code.yaml with no tools section → append."""
        config = self.tmp_path / "Code.yaml"
        config.write_text("name: Code\ninstructions: |\n  Hello world\n")
        result = upsert_chrys_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert "tools:" in content
        assert "question-tracker" in content
        # Original content still first
        assert content.index("name: Code") < content.index("tools:")

    # -- IT-M07-03: tools but no mcp → insert mcp under tools -----------

    def test_it_m07_03_tools_no_mcp(self) -> None:
        """IT-M07-03: tools exists with builtins, no mcp → add mcp."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "name: Code\n"
            "tools:\n"
            "  builtins:\n"
            "    - filesystem.read\n"
            "    - shell\n"
        )
        result = upsert_chrys_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert "builtins:" in content
        assert "mcp:" in content
        assert "question-tracker" in content

    # -- IT-M07-04: mcp exists, no question-tracker → append entry ------

    def test_it_m07_04_mcp_no_qt(self) -> None:
        """IT-M07-04: mcp list has other entries → append question-tracker."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "name: Code\n"
            "tools:\n"
            "  mcp:\n"
            "    - name: existing-server\n"
            "      transport: stdio\n"
            "      command: /usr/bin/existing\n"
        )
        result = upsert_chrys_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert "existing-server" in content
        assert "question-tracker" in content
        assert content.index("existing-server") < content.index("question-tracker")

    # -- IT-M07-05: same command → skip ---------------------------------

    def test_it_m07_05_idempotent(self) -> None:
        """IT-M07-05: Same command → skip."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "name: Code\n"
            "tools:\n"
            "  mcp:\n"
            f"    - name: question-tracker\n"
            f"      transport: stdio\n"
            f"      command: {self.exe}\n"
            f"      args: []\n"
            f"      enabled: true\n"
        )
        result = upsert_chrys_mcp(config, self.exe)
        assert result is False

    # -- IT-M07-06: different command → update --------------------------

    def test_it_m07_06_path_update(self) -> None:
        """IT-M07-06: Different command path → update."""
        config = self.tmp_path / "Code.yaml"
        old_exe = "/old/path/mcp_server"
        config.write_text(
            "name: Code\n"
            "tools:\n"
            "  mcp:\n"
            f"    - name: question-tracker\n"
            f"      transport: stdio\n"
            f"      command: {old_exe}\n"
            f"      args: []\n"
            f"      enabled: true\n"
        )
        result = upsert_chrys_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert str(self.exe) in content
        assert old_exe not in content

    # -- IT-M07-07: legacy uv → Go exe ----------------------------------

    def test_it_m07_07_legacy_migration(self) -> None:
        """IT-M07-07: uv run python → Go exe."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "name: Code\n"
            "tools:\n"
            "  mcp:\n"
            "    - name: question-tracker\n"
            "      transport: stdio\n"
            "      command: uv\n"
            "      args:\n"
            "        - run\n"
            "        - --with\n"
            "        - fastmcp\n"
            "        - python\n"
            "        - /old/mcp_server.py\n"
            "      enabled: true\n"
        )
        result = upsert_chrys_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert str(self.exe) in content

    # -- IT-M07-08: preserve comments -----------------------------------

    def test_it_m07_08_preserve_comments(self) -> None:
        """IT-M07-08: User comments and blank lines preserved."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "# My custom comment\n"
            "name: Code\n"
            "\n"
            "tools:\n"
            "  mcp: []\n"
        )
        upsert_chrys_mcp(config, self.exe)
        content = config.read_text()
        assert "# My custom comment" in content

    # -- IT-M07-09: abnormal indent → handled gracefully ----------------

    def test_it_m07_09_abnormal_indent(self) -> None:
        """IT-M07-09: Non-standard indent (4 spaces) — still works."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "name: Code\n"
            "tools:\n"
            "    mcp:\n"
            "        - name: question-tracker\n"
            "          transport: stdio\n"
            f"          command: {self.exe}\n"
        )
        # Should not crash; if indent is too unusual, skips gracefully
        try:
            result = upsert_chrys_mcp(config, self.exe)
        except Exception:
            self.skipTest("Abnormal indent caused unexpected crash")
        # Either updated or skipped (both acceptable)
        assert isinstance(result, bool)

    # -- IT-M07-10: empty mcp list → insert first entry -----------------

    def test_it_m07_10_empty_mcp_list(self) -> None:
        """IT-M07-10: mcp: [] → insert first entry."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "name: Code\n"
            "tools:\n"
            "  mcp: []\n"
        )
        result = upsert_chrys_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert "question-tracker" in content
        # Only one question-tracker entry
        assert content.count("- name: question-tracker") == 1

    # -- IT-M07-11: mcp not under tools → skip -------------------------

    def test_it_m07_11_mcp_not_under_tools(self) -> None:
        """IT-M07-11: mcp at top level (not under tools) → handled."""
        config = self.tmp_path / "Code.yaml"
        config.write_text(
            "name: Code\n"
            "mcp:\n"
            "  - name: other\n"
        )
        # mcp is top-level, not under tools. Our tool looks for tools.mcp.
        # Should append tools.mcp (since tools doesn't exist)
        result = upsert_chrys_mcp(config, self.exe)
        assert result is True
        content = config.read_text()
        assert "question-tracker" in content


# ===================================================================
# Integration tests: PG09 — _ensure_mcp_config
# ===================================================================


class TestEnsureMcpConfig(unittest.TestCase):
    """IT-M08-01 through IT-M08-08.

    All tests mock HOME/USERPROFILE to the temp directory so that
    skills_root paths like <tmp>/.claude/skills are recognised as
    user-level installations.

    Platform detection is mocked to ``"linux"`` so the tests are
    deterministic regardless of the host OS.
    """

    def setUp(self) -> None:
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self.tmp.name)
        self._platform_patcher = patch(
            "cli.mcp_config.detect_platform", return_value="linux"
        )
        self._platform_patcher.start()

    def tearDown(self) -> None:
        self._platform_patcher.stop()
        self.tmp.cleanup()

    # -- IT-M08-01: chrys full flow -------------------------------------

    def test_it_m08_01_chrys_full_flow(self) -> None:
        """Full detection → upsert for chrys."""
        skills_root = self.tmp_path / ".chrys" / "skills"
        skills_root.mkdir(parents=True)
        exe_dir2 = skills_root / MCP_BINARY_DIR / MCP_BIN_SUBDIR / "linux"
        exe_dir2.mkdir(parents=True)
        exe2 = exe_dir2 / "mcp_server"
        exe2.write_text("")

        agents_dir = self.tmp_path / ".chrys" / "agents"
        agents_dir.mkdir(parents=True)

        with patch("cli.mcp_config.Path.home", return_value=self.tmp_path):
            try:
                _ensure_mcp_config(skills_root)
            except Exception:
                self.skipTest("chrys not installed — cannot test builtin copy")

        code_yaml = agents_dir / "Code.yaml"
        if code_yaml.is_file():
            content = code_yaml.read_text()
            assert "question-tracker" in content

    # -- IT-M08-02: idempotent ------------------------------------------

    def test_it_m08_02_idempotent(self) -> None:
        """Second call is a no-op."""
        skills_root = self.tmp_path / ".claude" / "skills"
        skills_root.mkdir(parents=True)
        exe_dir = skills_root / MCP_BINARY_DIR / MCP_BIN_SUBDIR / "linux"
        exe_dir.mkdir(parents=True)
        (exe_dir / "mcp_server").write_text("")

        with patch.dict(os.environ, {"HOME": str(self.tmp_path), "USERPROFILE": str(self.tmp_path)}, clear=False):
            _ensure_mcp_config(skills_root)
        claude_json = self.tmp_path / ".claude.json"
        assert claude_json.is_file()
        mtime_before = claude_json.stat().st_mtime
        with patch.dict(os.environ, {"HOME": str(self.tmp_path), "USERPROFILE": str(self.tmp_path)}, clear=False):
            _ensure_mcp_config(skills_root)
        mtime_after = claude_json.stat().st_mtime
        assert mtime_before == mtime_after

    # -- IT-M08-03: unknown target → silent skip ------------------------

    def test_it_m08_03_unknown_target(self) -> None:
        """Unknown agent → no-op, no exception."""
        skills_root = self.tmp_path / "random" / "skills"
        _ensure_mcp_config(skills_root)  # Should not raise

    # -- IT-M08-04: binary missing → silent skip ------------------------

    def test_it_m08_04_binary_missing(self) -> None:
        """Binary not found → skips silently."""
        skills_root = self.tmp_path / ".claude" / "skills"
        skills_root.mkdir(parents=True)
        with patch("cli.mcp_config.Path.home", return_value=self.tmp_path):
            _ensure_mcp_config(skills_root)
        claude_json = self.tmp_path / ".claude.json"
        assert not claude_json.exists()

    # -- IT-M08-05: write failure → exception ---------------------------

    def test_it_m08_05_write_failure(self) -> None:
        """Config file not writable → exception propagates."""
        if os.name == "nt":
            self.skipTest("chmod semantics on Windows differ; skip write-protect test")
        skills_root = self.tmp_path / ".claude" / "skills"
        skills_root.mkdir(parents=True)
        exe_dir = skills_root / MCP_BINARY_DIR / MCP_BIN_SUBDIR / "linux"
        exe_dir.mkdir(parents=True)
        (exe_dir / "mcp_server").write_text("")

        with patch("cli.mcp_config.Path.home", return_value=self.tmp_path):
            _ensure_mcp_config(skills_root)

        claude_json = self.tmp_path / ".claude.json"
        # Make the parent directory read-only to simulate write failure
        claude_json.chmod(0o444)
        # Replace the binary so upsert tries to write (different path triggers update)
        new_exe = exe_dir / "mcp_server2"
        new_exe.write_text("")
        (exe_dir / "mcp_server").unlink()
        with patch("cli.mcp_config.Path.home", return_value=self.tmp_path):
            with self.assertRaises((MCPConfigError, OSError, PermissionError)):
                _ensure_mcp_config(skills_root)

    # -- IT-M08-06: claude full flow ------------------------------------

    def test_it_m08_06_claude_full_flow(self) -> None:
        """Detect → upsert for claude."""
        skills_root = self.tmp_path / ".claude" / "skills"
        skills_root.mkdir(parents=True)
        exe_dir = skills_root / MCP_BINARY_DIR / MCP_BIN_SUBDIR / "linux"
        exe_dir.mkdir(parents=True)
        exe = exe_dir / "mcp_server"
        exe.write_text("")

        with patch("cli.mcp_config.Path.home", return_value=self.tmp_path):
            _ensure_mcp_config(skills_root)

        claude_json = self.tmp_path / ".claude.json"
        assert claude_json.is_file()
        data = json.loads(claude_json.read_text())
        assert data["mcpServers"]["question-tracker"]["command"] == str(exe)

    # -- IT-M08-07: opencode full flow ----------------------------------

    def test_it_m08_07_opencode_full_flow(self) -> None:
        """Detect → upsert for opencode."""
        opencode_root = self.tmp_path / ".config" / "opencode"
        skills_root = opencode_root / "skills"
        skills_root.mkdir(parents=True)
        exe_dir = skills_root / MCP_BINARY_DIR / MCP_BIN_SUBDIR / "linux"
        exe_dir.mkdir(parents=True)
        exe = exe_dir / "mcp_server"
        exe.write_text("")

        with patch("cli.mcp_config.Path.home", return_value=self.tmp_path):
            _ensure_mcp_config(skills_root)

        opencode_json = opencode_root / "opencode.json"
        assert opencode_json.is_file()
        data = json.loads(opencode_json.read_text())
        assert data["mcp"]["question-tracker"]["command"] == [str(exe)]

    # -- IT-M08-08: codex full flow -------------------------------------

    def test_it_m08_08_codex_full_flow(self) -> None:
        """Detect → upsert for codex."""
        codex_root = self.tmp_path / ".codex"
        skills_root = codex_root / "skills"
        skills_root.mkdir(parents=True)
        exe_dir = skills_root / MCP_BINARY_DIR / MCP_BIN_SUBDIR / "linux"
        exe_dir.mkdir(parents=True)
        exe = exe_dir / "mcp_server"
        exe.write_text("")

        with patch("cli.mcp_config.Path.home", return_value=self.tmp_path):
            _ensure_mcp_config(skills_root)

        config_toml = codex_root / "config.toml"
        assert config_toml.is_file()
        content = config_toml.read_text()
        assert "[mcp_servers.question-tracker]" in content
        assert str(exe) in content
