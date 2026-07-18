"""Unified AAW version source.

The VERSION file lives next to this module so that every distribution form
(copy, symlink, zip update) carries it along; the moment a new skill tree is
swapped in, the reported version is the new one.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

FALLBACK_VERSION = "0.0.0"

# Strict three-part version, no leading zeros (see docs/auto-update-design.md §3.2).
_STRICT_VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


def aaw_version() -> str:
    version_file = Path(os.path.abspath(__file__)).with_name("VERSION")
    try:
        text = version_file.read_text("utf-8").strip()
    except OSError:
        return FALLBACK_VERSION
    return text or FALLBACK_VERSION


def parse_version(value: str) -> tuple[int, int, int] | None:
    """Return the (major, minor, patch) tuple, or None if not a strict version."""
    match = _STRICT_VERSION.match(value.strip())
    if not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def is_newer(candidate: str, current: str) -> bool:
    """True when candidate is a valid version strictly newer than current.

    An invalid candidate never wins; an invalid current is treated as the
    lowest version so a corrupted local install can still be upgraded.
    """
    candidate_parts = parse_version(candidate)
    if candidate_parts is None:
        return False
    return candidate_parts > (parse_version(current) or (0, 0, 0))
