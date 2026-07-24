#!/usr/bin/env bash
# Awesome-Agent-Workflow installer.
# Supports four harness targets:
#   claude   (default) — ~/.claude/skills/ + ~/.claude.json (MCP)
#   codex                — ~/.codex/config.toml (MCP only; skills via plugin marketplace)
#   opencode             — ~/.config/opencode/skills/ + ~/.config/opencode/opencode.json (MCP)
#   chrys                — ~/.chrys/skills/ + ~/.chrys/agents/Code.yaml (MCP)
#
# MCP server is a pre-compiled Go binary (zero runtime deps; no Python/uv needed).
# The installer's config-injection scripts still use uv run python (one-shot, not runtime).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_ROOT/skills"

TARGET="claude"  # claude | codex | opencode | chrys
SCOPE=""         # user | project
METHOD=""        # copy | symlink
MCP_ONLY=0
UNINSTALL=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Options:
  --target=NAME    Harness target: claude (default) | codex | opencode | chrys
  --user           Install to user-level config (~/.claude, ~/.codex, ~/.config/opencode)
  --project        Install to project-level config (./.claude, ./.opencode, etc.)
  --copy           Copy skill files (default)
  --symlink        Symlink instead of copy (git pull updates instantly)
  --mcp-only       Only register the MCP server, skip skills
  --uninstall      Remove everything this script installed
  -h, --help       Show this help

Targets:
  claude     skills → ~/.claude/skills/         MCP → ~/.claude.json
  codex      skills via /plugins marketplace      MCP → ~/.codex/config.toml
  opencode   skills → ~/.config/opencode/skills/  MCP → ~/.config/opencode/opencode.json
  chrys      skills → ~/.chrys/skills/            MCP → ~/.chrys/agents/Code.yaml

Prerequisites:
  uv (for config injection scripts only; MCP server is a standalone Go binary)

Without flags, runs interactively and prompts for each choice.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target=*)   TARGET="${1#--target=}"; shift ;;
    --target)     TARGET="$2"; shift 2 ;;
    --user)       SCOPE=user; shift ;;
    --project)    SCOPE=project; shift ;;
    --copy)       METHOD=copy; shift ;;
    --symlink)    METHOD=symlink; shift ;;
    --mcp-only)   MCP_ONLY=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

case "$TARGET" in
  claude|codex|opencode|chrys) ;;
  *) echo "Invalid --target: $TARGET (expected claude|codex|opencode|chrys)" >&2; exit 2 ;;
esac

# --- Resolve scope interactively if not set ---------------------------------
if [[ -z "$SCOPE" ]]; then
  echo "Where to install ($TARGET)?"
  echo "  1) User-level    (global, all projects)"
  echo "  2) Project-level (current project only)"
  read -rp "Choose [1/2]: " choice
  case "$choice" in
    1) SCOPE=user ;;
    2) SCOPE=project ;;
    *) echo "Invalid choice"; exit 2 ;;
  esac
fi

# --- Resolve target-specific paths ------------------------------------------
resolve_paths() {
  case "$TARGET" in
    claude)
      if [[ "$SCOPE" == "user" ]]; then
        SKILLS_DST="$HOME/.claude/skills"
        CONFIG_FILE="$HOME/.claude.json"
        CONFIG_FMT=claude-json
        MCP_SCOPE_KEY="__global__"
      else
        SKILLS_DST="$PWD/.claude/skills"
        CONFIG_FILE="$HOME/.claude.json"
        CONFIG_FMT=claude-json
        MCP_SCOPE_KEY="$PWD"
      fi
      ;;
    opencode)
      if [[ "$SCOPE" == "user" ]]; then
        SKILLS_DST="$HOME/.config/opencode/skills"
        CONFIG_FILE="$HOME/.config/opencode/opencode.json"
      else
        SKILLS_DST="$PWD/.opencode/skills"
        CONFIG_FILE="$PWD/opencode.json"
      fi
      CONFIG_FMT=opencode-json
      ;;
    codex)
      # Codex skills are installed via the plugin marketplace (/plugins),
      # not via this script. Here we only register the MCP server.
      SKILLS_DST=""
      if [[ "$SCOPE" == "user" ]]; then
        CONFIG_FILE="$HOME/.codex/config.toml"
      else
        CONFIG_FILE="$PWD/.codex/config.toml"
      fi
      CONFIG_FMT=codex-toml
      MCP_ONLY=1
      ;;
    chrys)
      if [[ "$SCOPE" == "user" ]]; then
        if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* || "$(uname -s)" == MSYS* ]]; then
          SKILLS_DST="$APPDATA/chrys/skills"
        else
          SKILLS_DST="$HOME/.chrys/skills"
        fi
      else
        SKILLS_DST="$PWD/.chrys/skills"
      fi
      CONFIG_FMT=chrys-yaml
      # Chrys agent profile is always user-level
      if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* || "$(uname -s)" == MSYS* ]]; then
        CONFIG_FILE="$APPDATA/chrys/agents/Code.yaml"
      else
        CONFIG_FILE="$HOME/.chrys/agents/Code.yaml"
      fi
      ;;
  esac
}
resolve_paths

# --- Platform detection for MCP binary selection ------------------------------
detect_platform() {
  local os
  os="$(uname -s)"
  case "$os" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|CYGWIN*|MSYS*) echo "windows" ;;
    *)       echo "windows" ;;  # unknown → default to Windows binary
  esac
}
PLATFORM=$(detect_platform)
MCP_EXE_NAME="mcp_server"
[[ "$PLATFORM" == "windows" ]] && MCP_EXE_NAME="mcp_server.exe"

# MCP binary lives under skills/question-tracker-mcp/bin/<platform>/
if [[ -n "$SKILLS_DST" ]]; then
  MCP_EXE="$SKILLS_DST/question-tracker-mcp/bin/$PLATFORM/$MCP_EXE_NAME"
else
  # Codex: skills not installed here; point to the repo's binary
  MCP_EXE="$SKILLS_SRC/question-tracker-mcp/bin/$PLATFORM/$MCP_EXE_NAME"
fi

# --- Uninstall ---------------------------------------------------------------
if [[ $UNINSTALL -eq 1 ]]; then
  echo "Uninstalling Awesome-Agent-Workflow ($TARGET, $SCOPE scope)..."
  if [[ -n "$SKILLS_DST" ]]; then
    for skill_dir in "$SKILLS_SRC"/*/; do
      name="$(basename "$skill_dir")"
      target="$SKILLS_DST/$name"
      if [[ -L "$target" || -d "$target" ]]; then
        rm -rf "$target"
        echo "  removed skill: $name"
      fi
    done
    rm -f "$SKILLS_DST/.aaw-target"
  fi
  case "$CONFIG_FMT" in
    claude-json)
      uv run python - "$CONFIG_FILE" "$MCP_SCOPE_KEY" <<'PY'
import json, sys
path, scope_key = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
removed = False
if scope_key == "__global__":
    if "mcpServers" in data and "question-tracker" in data["mcpServers"]:
        del data["mcpServers"]["question-tracker"]; removed = True
else:
    proj = data.get("projects", {}).get(scope_key, {})
    if "mcpServers" in proj and "question-tracker" in proj["mcpServers"]:
        del proj["mcpServers"]["question-tracker"]; removed = True
if removed:
    with open(path, "w", encoding="utf-8") as f: json.dump(data, f, indent=2)
    print("  removed MCP server: question-tracker")
else:
    print("  MCP server not found, skipping")
PY
      ;;
    opencode-json)
      uv run python - "$CONFIG_FILE" <<'PY'
import json, os, sys
path = sys.argv[1]
if not os.path.exists(path):
    print("  config not found, skipping"); sys.exit()
data = json.load(open(path, encoding="utf-8"))
mcp = data.get("mcp", {})
if "question-tracker" in mcp:
    del mcp["question-tracker"]
    with open(path, "w", encoding="utf-8") as f: json.dump(data, f, indent=2)
    print("  removed MCP server: question-tracker")
else:
    print("  MCP server not found, skipping")
PY
      ;;
    codex-toml)
      uv run python - "$CONFIG_FILE" <<'PY'
import re, sys
path = sys.argv[1]
try:
    content = open(path, encoding="utf-8").read()
except FileNotFoundError:
    print("  config not found, skipping"); sys.exit()
pattern = re.compile(
    r'\n?\[mcp_servers\.question-tracker\]\n(?:[^\[]*?)(?=\n\[|\Z)',
    re.DOTALL
)
new, n = pattern.subn('\n', content)
if n:
    open(path, 'w').write(new)
    print("  removed MCP server: question-tracker")
else:
    print("  MCP server not found, skipping")
PY
      ;;
  chrys-yaml)
    uv run python - "$CONFIG_FILE" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.exists():
    print("  config not found, skipping"); sys.exit()
text = path.read_text("utf-8")
if "question-tracker" in text:
    lines = text.splitlines(keepends=True)
    new_lines = []
    skip = False
    for l in lines:
        if "- name: question-tracker" in l:
            skip = True
            continue
        if skip:
            if l.strip().startswith("- name:") or (l.strip() and not l.startswith(" ") and not l.startswith("\t")):
                skip = False
                new_lines.append(l)
            continue
        new_lines.append(l)
    path.write_text("".join(new_lines), "utf-8")
    print("  removed MCP server: question-tracker")
else:
    print("  MCP server not found, skipping")
PY
      ;;
  esac
  echo "Done."
  exit 0
fi

# --- Sanity checks -----------------------------------------------------------
[[ -d "$SKILLS_SRC" ]]   || { echo "skills/ not found at $SKILLS_SRC"; exit 1; }
if ! command -v uv >/dev/null 2>&1; then
  echo "uv not found. Install it first:" >&2
  echo "  curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

# --- Install skills ----------------------------------------------------------
if [[ $MCP_ONLY -eq 0 && -n "$SKILLS_DST" ]]; then
  if [[ -z "$METHOD" ]]; then
    echo "Install method?"
    echo "  1) Copy     (snapshot, won't auto-update)"
    echo "  2) Symlink  (git pull updates instantly)"
    read -rp "Choose [1/2]: " choice
    case "$choice" in
      1) METHOD=copy ;;
      2) METHOD=symlink ;;
      *) echo "Invalid choice"; exit 2 ;;
    esac
  fi

  mkdir -p "$SKILLS_DST"
  echo "Installing skills ($METHOD) → $SKILLS_DST"
  for skill_dir in "$SKILLS_SRC"/*/; do
    name="$(basename "$skill_dir")"
    target="$SKILLS_DST/$name"
    if [[ -e "$target" || -L "$target" ]]; then
      rm -rf "$target"
    fi
    if [[ "$METHOD" == "symlink" ]]; then
      ln -s "$skill_dir" "$target"
    else
      cp -R "$skill_dir" "$target"
    fi
    echo "  $name"
  done
elif [[ "$TARGET" == "codex" ]]; then
  echo "Codex skills are installed via the plugin marketplace:"
  echo "  In Codex CLI:  /plugins  →  search 'awesome-agent-workflow'  →  Install"
  echo "  (MCP server will still be registered below.)"
  echo
fi

# Write .aaw-target marker so auto-update can detect agent type from any directory
if [[ -n "$SKILLS_DST" ]]; then
  echo "$TARGET" > "$SKILLS_DST/.aaw-target"
fi

# --- Register MCP server (via uv) -------------------------------------------
echo
echo "Registering MCP server (question-tracker, $TARGET/$SCOPE)..."
case "$CONFIG_FMT" in
  claude-json)
    uv run python - "$CONFIG_FILE" "$MCP_SCOPE_KEY" "$MCP_EXE" <<'PY'
import json, os, sys
path, scope_key, exe_path = sys.argv[1], sys.argv[2], sys.argv[3]
data = {} if not os.path.exists(path) else json.load(open(path, encoding="utf-8"))
entry = {"command": exe_path, "args": [], "env": {}}
if scope_key == "__global__":
    mcp_servers = data.setdefault("mcpServers", {})
    mcp_servers["question-tracker"] = entry
else:
    proj = data.setdefault("projects", {}).setdefault(scope_key, {})
    proj.setdefault("mcpServers", {})["question-tracker"] = entry
with open(path, "w", encoding="utf-8") as f: json.dump(data, f, indent=2)
print(f"  registered in {path}")
PY
    ;;
  opencode-json)
    uv run python - "$CONFIG_FILE" "$MCP_EXE" <<'PY'
import json, os, sys
path, exe_path = sys.argv[1], sys.argv[2]
data = {} if not os.path.exists(path) else json.load(open(path, encoding="utf-8"))
data.setdefault("$schema", "https://opencode.ai/config.json")
data.setdefault("mcp", {})["question-tracker"] = {
    "type": "local",
    "command": [exe_path],
    "enabled": True,
    "environment": {},
}
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
with open(path, "w", encoding="utf-8") as f: json.dump(data, f, indent=2)
print(f"  registered in {path}")
PY
    ;;
  codex-toml)
    uv run python - "$CONFIG_FILE" "$MCP_EXE" <<'PY'
import os, sys, re
path, exe_path = sys.argv[1], sys.argv[2]
content = ""
if os.path.exists(path):
    content = open(path, encoding="utf-8").read()
content = re.sub(
    r'\n?\[mcp_servers\.question-tracker\]\n(?:[^\[]*?)(?=\n\[|\Z)',
    '', content, flags=re.DOTALL
)
block = (
    f"\n[mcp_servers.question-tracker]\n"
    f'command = "{exe_path}"\n'
    f"args = []\n"
)
if content and not content.endswith("\n"):
    content += "\n"
content += block
os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
open(path, "w", encoding="utf-8").write(content)
print(f"  registered in {path}")
PY
    ;;
  chrys-yaml)
    uv run python - "$CONFIG_FILE" "$MCP_EXE" <<'PY'
import os, sys
from pathlib import Path
path = Path(sys.argv[1])
exe_path = sys.argv[2]
entry = "    - name: question-tracker\n      transport: stdio\n      command: " + exe_path + "\n      args: []\n      enabled: true\n"
if not path.exists():
    try:
        from importlib.resources import files
        builtin = files("chrys.service.profiles.agents.builtins").joinpath("Code.yaml").read_text("utf-8")
    except Exception:
        builtin = "name: Code\n"
    lines = builtin.splitlines(keepends=True)
    has_mcp = any("  mcp:" in l or "\tmcp:" in l for l in lines)
    if not has_mcp:
        has_tools = any(l.startswith("tools:") for l in lines)
        if not has_tools:
            if lines and not lines[-1].endswith("\n"): lines.append("\n")
            lines.append("tools:\n")
        lines.append("  mcp:\n")
        lines.append(entry)
    else:
        for i, l in enumerate(lines):
            if "  mcp:" in l or "\tmcp:" in l:
                end = len(lines)
                for j in range(i + 1, len(lines)):
                    s = lines[j].rstrip("\n").rstrip("\r")
                    if s and not s[0].isspace(): end = j; break
                lines.insert(end, entry)
                break
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(lines), "utf-8")
else:
    text = path.read_text("utf-8")
    if "question-tracker" in text and exe_path in text:
        print("  question-tracker already configured — skipping")
        sys.exit(0)
    lines = text.splitlines(keepends=True)
    qt_idx = -1
    for i, l in enumerate(lines):
        if "- name: question-tracker" in l: qt_idx = i; break
    if qt_idx >= 0:
        end = qt_idx + 1
        while end < len(lines):
            s = lines[end].rstrip("\n").rstrip("\r")
            if s and s.strip().startswith("- name:"): break
            end += 1
        lines[qt_idx:end] = [entry]
    else:
        mcp_idx = -1
        for i, l in enumerate(lines):
            if "  mcp:" in l or "\tmcp:" in l: mcp_idx = i; break
        if mcp_idx >= 0:
            end = len(lines)
            for j in range(mcp_idx + 1, len(lines)):
                s = lines[j].rstrip("\n").rstrip("\r")
                if s and not s[0].isspace(): end = j; break
            lines.insert(end, entry)
        else:
            if lines and not lines[-1].endswith("\n"): lines.append("\n")
            lines.append("tools:\n  mcp:\n")
            lines.append(entry)
    path.write_text("".join(lines), "utf-8")
print("  registered in " + str(path))
PY
    ;;
esac

# --- Self-check --------------------------------------------------------------
echo
echo "=== Self-check ($TARGET) ==="
if [[ -n "$SKILLS_DST" && $MCP_ONLY -eq 0 ]]; then
  echo "Installed skills:"
  for skill_dir in "$SKILLS_SRC"/*/; do
    name="$(basename "$skill_dir")"
    if [[ -e "$SKILLS_DST/$name" ]]; then
      echo "  [OK] $name"
    else
      echo "  [MISSING] $name" >&2
    fi
  done
elif [[ "$TARGET" == "codex" ]]; then
  echo "Skills: install via Codex /plugins (marketplace)."
fi
echo "MCP server binary:"
if [[ -f "$MCP_EXE" ]]; then
  echo "  [OK] $MCP_EXE"
else
  echo "  [MISSING] $MCP_EXE" >&2
fi
echo "MCP server registration:"
case "$CONFIG_FMT" in
  claude-json)
    uv run python - "$CONFIG_FILE" "$MCP_SCOPE_KEY" <<'PY'
import json, sys
path, scope_key = sys.argv[1], sys.argv[2]
data = json.load(open(path, encoding="utf-8"))
if scope_key == "__global__":
    found = "question-tracker" in data.get("mcpServers", {})
else:
    found = "question-tracker" in data.get("projects", {}).get(scope_key, {}).get("mcpServers", {})
print(f"  [{'OK' if found else 'MISSING'}] question-tracker")
PY
    ;;
  opencode-json)
    uv run python - "$CONFIG_FILE" <<'PY'
import json, os, sys
path = sys.argv[1]
found = False
if os.path.exists(path):
    found = "question-tracker" in json.load(open(path, encoding="utf-8")).get("mcp", {})
print(f"  [{'OK' if found else 'MISSING'}] question-tracker")
PY
    ;;
  codex-toml)
    uv run python - "$CONFIG_FILE" <<'PY'
import os, re, sys
path = sys.argv[1]
found = False
if os.path.exists(path):
    found = bool(re.search(r'\[mcp_servers\.question-tracker\]', open(path).read()))
print(f"  [{'OK' if found else 'MISSING'}] question-tracker")
PY
    ;;
  chrys-yaml)
    uv run python - "$CONFIG_FILE" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
found = path.is_file() and "question-tracker" in path.read_text("utf-8")
print(f"  [{'OK' if found else 'MISSING'}] question-tracker")
PY
    ;;
esac

echo
echo "Done. Restart $TARGET to pick up changes."
echo "(MCP server is a standalone Go binary — no Python/uv needed at runtime.)"
[[ "$TARGET" == "claude" ]] && echo "Try triggering with: 进入工作流"
[[ "$TARGET" == "opencode" ]] && echo "Try triggering with: 进入工作流"
[[ "$TARGET" == "codex" ]] && echo "Install the plugin via /plugins, then trigger with: 进入工作流"
[[ "$TARGET" == "chrys" ]] && echo "Try triggering with: 进入工作流"
