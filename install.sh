#!/usr/bin/env bash
#
# s&box Codex Bridge Installer (Linux/WSL/Mac)
#
# Installs the bridge into your project's Libraries folder. The bridge
# WILL NOT compile if placed in s&box's global addons folder — that
# folder is built-in only.
#
# Usage:
#   ./install.sh                                 # Auto-detects single project
#   ./install.sh /path/to/your/sbox/project      # Explicit project path
#   ./install.sh --list                          # List projects, then exit
#   ./install.sh --remove-stale                  # Also delete old wrong-location installs

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADDON_SOURCE="$SCRIPT_DIR/sbox-bridge-addon"
PROJECTS_ROOT="${HOME}/Documents/s&box projects"

REMOVE_STALE=0
LIST_ONLY=0
PROJECT_PATH=""

for arg in "$@"; do
    case "$arg" in
        --remove-stale) REMOVE_STALE=1 ;;
        --list)         LIST_ONLY=1 ;;
        -*)             echo "Unknown flag: $arg" >&2; exit 1 ;;
        *)              PROJECT_PATH="$arg" ;;
    esac
done

echo ""
echo "=== s&box Codex Bridge Installer ==="
echo ""

# ── List mode ─────────────────────────────────────────────────────
if [[ "$LIST_ONLY" -eq 1 ]]; then
    if [[ ! -d "$PROJECTS_ROOT" ]]; then
        echo "No projects directory at: $PROJECTS_ROOT"
        exit 1
    fi
    echo "Projects under $PROJECTS_ROOT :"
    for d in "$PROJECTS_ROOT"/*/; do
        [[ -d "$d" ]] || continue
        if compgen -G "$d"*.sbproj > /dev/null; then
            echo "  $(basename "$d")"
        fi
    done
    exit 0
fi

# ── Auto-detect project if none was given ─────────────────────────
if [[ -z "$PROJECT_PATH" ]]; then
    if [[ ! -d "$PROJECTS_ROOT" ]]; then
        echo "Could not find $PROJECTS_ROOT"
        echo "Pass a project explicitly:  ./install.sh /path/to/project"
        exit 1
    fi
    candidates=()
    for d in "$PROJECTS_ROOT"/*/; do
        [[ -d "$d" ]] || continue
        if compgen -G "${d}*.sbproj" > /dev/null; then
            candidates+=("$d")
        fi
    done
    if [[ "${#candidates[@]}" -eq 0 ]]; then
        echo "No s&box projects found under $PROJECTS_ROOT"
        exit 1
    fi
    if [[ "${#candidates[@]}" -eq 1 ]]; then
        PROJECT_PATH="${candidates[0]%/}"
        echo "Auto-detected project: $(basename "$PROJECT_PATH")"
    else
        echo "Multiple projects found — specify one:"
        for c in "${candidates[@]}"; do echo "  $c"; done
        exit 1
    fi
fi

# ── Validate ─────────────────────────────────────────────────────
if [[ ! -d "$PROJECT_PATH" ]]; then
    echo "Project path not found: $PROJECT_PATH"
    exit 1
fi
if ! compgen -G "$PROJECT_PATH/*.sbproj" > /dev/null; then
    echo "No .sbproj in: $PROJECT_PATH"
    echo "Doesn't look like an s&box project folder."
    exit 1
fi

echo "Project: $(basename "$PROJECT_PATH")"
echo "Path:    $PROJECT_PATH"
echo ""

# ── Confirm addon source ─────────────────────────────────────────
[[ -d "$ADDON_SOURCE" ]] || { echo "Missing: $ADDON_SOURCE"; exit 1; }
[[ -f "$ADDON_SOURCE/codexbridge.sbproj" ]] || { echo "Missing: codexbridge.sbproj"; exit 1; }
[[ -f "$ADDON_SOURCE/Editor/MyEditorMenu.cs" ]] || { echo "Missing: Editor/MyEditorMenu.cs"; exit 1; }

# ── Install into <Project>/Libraries/codexbridge/ ────────────────
DEST_DIR="$PROJECT_PATH/Libraries/codexbridge"
EDITOR_DIR="$DEST_DIR/Editor"
mkdir -p "$EDITOR_DIR"

cp -f "$ADDON_SOURCE/codexbridge.sbproj" "$DEST_DIR/codexbridge.sbproj"
cp -f "$ADDON_SOURCE/Editor/MyEditorMenu.cs" "$EDITOR_DIR/MyEditorMenu.cs"

# Remove stale auto-generated .csproj if present — s&box will regen on next compile
STALE_CSPROJ="$EDITOR_DIR/codexbridge.editor.csproj"
if [[ -f "$STALE_CSPROJ" ]]; then
    rm -f "$STALE_CSPROJ"
    echo "Removed stale codexbridge.editor.csproj (s&box will regenerate)"
fi

echo "Installed:"
echo "  $DEST_DIR/codexbridge.sbproj"
echo "  $EDITOR_DIR/MyEditorMenu.cs"
echo ""

# ── Check for old wrong-location installs ─────────────────────────
declare -a CANDIDATES
CANDIDATES=(
    "$HOME/.steam/steam/steamapps/common/sbox/addons/sbox-bridge-addon"
    "$HOME/.local/share/Steam/steamapps/common/sbox/addons/sbox-bridge-addon"
    "/mnt/c/Program Files (x86)/Steam/steamapps/common/sbox/addons/sbox-bridge-addon"
)
BAD_INSTALLS=()
for p in "${CANDIDATES[@]}"; do
    [[ -d "$p" ]] && BAD_INSTALLS+=("$p")
done
if [[ "${#BAD_INSTALLS[@]}" -gt 0 ]]; then
    echo "Found prior install(s) in s&box's global addons folder (these never compile):"
    for p in "${BAD_INSTALLS[@]}"; do echo "  $p"; done
    if [[ "$REMOVE_STALE" -eq 1 ]]; then
        for p in "${BAD_INSTALLS[@]}"; do
            rm -rf "$p"
            echo "Removed: $p"
        done
    else
        echo "Re-run with --remove-stale to delete them."
    fi
    echo ""
fi

echo "Installation successful."
echo ""
echo "Next steps:"
echo "  1. Open or restart s&box and load this project."
echo "  2. Open your s&box project. View -> Codex Bridge is optional."
echo "  3. Register the MCP server (one-time):"
echo "       codex mcp add sbox -- node \"$SCRIPT_DIR/sbox-mcp-server/dist/index.js\""
echo "  4. In Codex: 'check the bridge status'"
echo ""
echo "If the dock doesn't appear, tail <sbox>/logs/sbox-dev.log for"
echo "'Compile of local.<project>.editor Failed' lines."
