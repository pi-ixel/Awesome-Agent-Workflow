from __future__ import annotations

import importlib.util
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "skills" / "mermaid-diagram" / "scripts" / "check_mermaid.py"
SPEC = importlib.util.spec_from_file_location("check_mermaid", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
check_mermaid = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_mermaid)


class MermaidSourceTests(unittest.TestCase):
    def test_extracts_backtick_and_tilde_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "design.md"
            path.write_text(
                "# Design\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n"
                "~~~MERMAID\nsequenceDiagram\nA->>B: ping\n~~~\n",
                encoding="utf-8",
            )
            diagrams, errors = check_mermaid.extract_markdown(path)

        self.assertEqual([], errors)
        self.assertEqual(2, len(diagrams))
        self.assertIn("flowchart LR", diagrams[0][1])
        self.assertIn("sequenceDiagram", diagrams[1][1])

    def test_reports_unclosed_mermaid_fence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.md"
            path.write_text("```mermaid\nflowchart LR\nA --> B\n", encoding="utf-8")
            diagrams, errors = check_mermaid.extract_markdown(path)

        self.assertEqual([], diagrams)
        self.assertEqual(1, len(errors))
        self.assertIn("unclosed Mermaid fence", errors[0])

    def test_collects_mmd_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "flow.mmd"
            path.write_text("flowchart LR\nA --> B\n", encoding="utf-8")
            diagrams, errors = check_mermaid.collect([path])

        self.assertEqual([], errors)
        self.assertEqual([(str(path), "flowchart LR\nA --> B\n")], diagrams)


class OfflineValidatorTests(unittest.TestCase):
    def run_cli(self, path: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

    def test_bundled_validator_accepts_valid_diagram(self) -> None:
        result = self.run_cli(ROOT / "test" / "mermaid_diagram" / "fixtures" / "escaping.mmd")

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("validated 1 diagram(s) offline", result.stdout)

    def test_bundled_validator_accepts_documented_diagram_types(self) -> None:
        result = self.run_cli(
            ROOT / "test" / "mermaid_diagram" / "fixtures" / "supported-types.md"
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("validated 5 diagram(s) offline", result.stdout)

    def test_bundled_validator_rejects_invalid_diagram(self) -> None:
        result = self.run_cli(ROOT / "test" / "mermaid_diagram" / "fixtures" / "invalid.mmd")

        self.assertEqual(1, result.returncode)
        self.assertIn("1 of 1 diagram(s) failed", result.stderr)

    def test_cli_has_no_download_or_external_renderer_options(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )

        self.assertEqual(0, result.returncode)
        self.assertNotIn("npx", result.stdout.lower())
        self.assertNotIn("mmdc", result.stdout.lower())
        self.assertNotIn("install", result.stdout.lower())

    def test_bundled_compiler_integrity_is_pinned(self) -> None:
        digest = hashlib.sha256(check_mermaid.BUNDLE.read_bytes()).hexdigest()

        self.assertEqual(check_mermaid.BUNDLE_SHA256, digest)
        self.assertTrue((check_mermaid.BUNDLE.parent / "LICENSE").is_file())
        self.assertEqual(
            "11.17.0",
            (check_mermaid.BUNDLE.parent / "VERSION").read_text(encoding="utf-8").strip(),
        )


if __name__ == "__main__":
    unittest.main()
