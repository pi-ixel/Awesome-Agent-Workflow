"""Entry point for aaw CLI — invoked by aaw-workflow skill."""
import sys
from pathlib import Path

# Ensure the skill's cli package is importable
sys.path.insert(0, str(Path(__file__).parent))

import cli.main

cli.main.app()
