"""Expose the workflow-skill CLI as the packaged ``aaw`` command.

The workflow definitions deliberately remain beside the skill so that the
installed skill and the package execute the same implementation.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


_SOURCE = Path(__file__).resolve().parents[1] / "skills" / "aaw-workflow" / "scripts" / "cli"
_SPEC = importlib.util.spec_from_file_location(
    "aaw_embedded_cli", _SOURCE / "__init__.py", submodule_search_locations=[str(_SOURCE)]
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - installation corruption
    raise RuntimeError("AAW workflow CLI sources are missing")
_PACKAGE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _PACKAGE
_SPEC.loader.exec_module(_PACKAGE)
_MAIN_SPEC = importlib.util.spec_from_file_location("aaw_embedded_cli.main", _SOURCE / "main.py")
if _MAIN_SPEC is None or _MAIN_SPEC.loader is None:  # pragma: no cover - installation corruption
    raise RuntimeError("AAW workflow CLI entry point is missing")
_MAIN = importlib.util.module_from_spec(_MAIN_SPEC)
sys.modules[_MAIN_SPEC.name] = _MAIN
_MAIN_SPEC.loader.exec_module(_MAIN)

app = _MAIN.app
main = _MAIN.main
