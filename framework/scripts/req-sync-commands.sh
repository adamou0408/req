#!/usr/bin/env bash
# req-sync-commands.sh — generate host .claude/commands/req-*.md from framework templates
#
# Reads .req.config.yml in the host repo, applies ${REQ_*_ROOT} variable substitution
# to every framework/commands/*.md, and writes the result to .claude/commands/req-*.md.
# Stamps each output file with an AUTO-GENERATED header and the framework version.
#
# Run this any time after upgrading the framework submodule.
#
# Usage:
#   bash <framework_root>/framework/scripts/req-sync-commands.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

req_load_config

# Resolve the framework's commands source directory.
# REQ_FRAMEWORK_ROOT in .req.config.yml may point at:
#   - the upstream repo root (containing framework/ + VERSION)
#   - or directly at framework/
FW_ABS="$REQ_HOST_ROOT/$REQ_FRAMEWORK_ROOT"
if [ -d "$FW_ABS/framework/commands" ]; then
    COMMANDS_SRC="$FW_ABS/framework/commands"
    VERSION_FILE="$FW_ABS/VERSION"
elif [ -d "$FW_ABS/commands" ]; then
    COMMANDS_SRC="$FW_ABS/commands"
    VERSION_FILE="$FW_ABS/../VERSION"
else
    echo "ERROR: cannot find framework commands under $FW_ABS" >&2
    exit 1
fi

CURRENT_VERSION="unknown"
[ -f "$VERSION_FILE" ] && CURRENT_VERSION="$(cat "$VERSION_FILE")"

OUT_DIR="$REQ_HOST_ROOT/.claude/commands"
mkdir -p "$OUT_DIR"

# Clean previous req-*.md to avoid stale commands after upstream renames
echo "→ Cleaning previous req-*.md from $OUT_DIR"
find "$OUT_DIR" -maxdepth 1 -name 'req-*.md' -type f -delete 2>/dev/null || true

count=0
for src in "$COMMANDS_SRC"/*.md; do
    [ -f "$src" ] || continue
    name="$(basename "$src" .md)"
    out="$OUT_DIR/req-${name}.md"

    {
        echo "<!-- AUTO-GENERATED FROM ${REQ_FRAMEWORK_ROOT}/framework/commands/${name}.md — DO NOT EDIT -->"
        echo "<!-- req framework version: ${CURRENT_VERSION} -->"
        echo "<!-- regenerate via: bash ${REQ_FRAMEWORK_ROOT}/framework/scripts/req-sync-commands.sh -->"
        echo ""
        req_substitute_vars "$src"
    } > "$out"
    count=$((count + 1))
done

echo "✓ Generated $count slash commands → $OUT_DIR/req-*.md"

# --- Sync agents (parallel to commands sync) ---
AGENTS_SRC="$(dirname "$COMMANDS_SRC")/agents"
AGENTS_OUT="$REQ_HOST_ROOT/.claude/agents"
if [ -d "$AGENTS_SRC" ]; then
    mkdir -p "$AGENTS_OUT"
    echo "→ Cleaning previous req-*.md from $AGENTS_OUT"
    find "$AGENTS_OUT" -maxdepth 1 -name 'req-*.md' -type f -delete 2>/dev/null || true
    agent_count=0
    for src in "$AGENTS_SRC"/*.md; do
        [ -f "$src" ] || continue
        name="$(basename "$src" .md)"
        # Source filename already starts with req- (e.g. req-research.md); don't double-prefix.
        case "$name" in
            req-*) out="$AGENTS_OUT/${name}.md" ;;
            *)     out="$AGENTS_OUT/req-${name}.md" ;;
        esac
        {
            echo "<!-- AUTO-GENERATED FROM ${REQ_FRAMEWORK_ROOT}/framework/agents/${name}.md — DO NOT EDIT -->"
            echo "<!-- req framework version: ${CURRENT_VERSION} -->"
            echo "<!-- regenerate via: bash ${REQ_FRAMEWORK_ROOT}/framework/scripts/req-sync-commands.sh -->"
            echo ""
            req_substitute_vars "$src"
        } > "$out"
        agent_count=$((agent_count + 1))
    done
    echo "✓ Generated $agent_count subagents → $AGENTS_OUT/req-*.md"
fi

# Major version bump warning
if [ -n "${REQ_LAST_SYNCED_VERSION:-}" ] && [ "$REQ_LAST_SYNCED_VERSION" != "$CURRENT_VERSION" ]; then
    PREV_MAJOR="$(req_semver_major "$REQ_LAST_SYNCED_VERSION")"
    CURR_MAJOR="$(req_semver_major "$CURRENT_VERSION")"
    if [ "$PREV_MAJOR" != "$CURR_MAJOR" ]; then
        echo ""
        echo "⚠️  MAJOR VERSION BUMP DETECTED: v${PREV_MAJOR} → v${CURR_MAJOR}"
        echo "   Please review MIGRATION.md in the framework before proceeding."
        echo "   Path: $FW_ABS/MIGRATION.md (or $FW_ABS/../MIGRATION.md)"
    fi
fi

# Update last_synced_version in .req.config.yml
CFG="$REQ_HOST_ROOT/.req.config.yml"
if grep -q '^last_synced_version:' "$CFG" 2>/dev/null; then
    # Use a temp file for cross-platform safety
    awk -v v="$CURRENT_VERSION" '
        /^last_synced_version:/ { print "last_synced_version: " v; next }
        { print }
    ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
else
    echo "last_synced_version: $CURRENT_VERSION" >> "$CFG"
fi

echo "✓ Updated last_synced_version → $CURRENT_VERSION in $CFG"
