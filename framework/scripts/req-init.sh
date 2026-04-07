#!/usr/bin/env bash
# req-init.sh — initialize a new requirement-driven project in the current directory
#
# Usage:
#   cd /path/to/new-or-empty-project
#   bash <path-to-req-clone>/framework/scripts/req-init.sh [--mode=copy|submodule] [--remote=<url>]
#
# Modes:
#   copy       (default) — copy framework/ into ./.req-framework/ as a plain directory
#   submodule           — git submodule add <remote> .req-framework  (requires --remote)
#
# After this script completes, the current directory is a self-contained req project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODE="copy"
REMOTE="https://github.com/adamou0408/req"

for arg in "$@"; do
    case "$arg" in
        --mode=*)   MODE="${arg#--mode=}" ;;
        --remote=*) REMOTE="${arg#--remote=}" ;;
        -h|--help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "Unknown arg: $arg" >&2; exit 1 ;;
    esac
done

HOST="$(pwd)"
echo "→ Initializing req project at $HOST  (mode: $MODE)"

if [ -f "$HOST/.req.config.yml" ]; then
    echo "ERROR: .req.config.yml already exists. This directory looks initialized." >&2
    exit 1
fi

# 1. Install framework as ./.req-framework
case "$MODE" in
    copy)
        if [ -e "$HOST/.req-framework" ]; then
            echo "ERROR: .req-framework already exists" >&2; exit 1
        fi
        echo "→ Copying framework from $SOURCE_REPO_ROOT to .req-framework/"
        mkdir -p "$HOST/.req-framework"
        cp -r "$SOURCE_REPO_ROOT/framework" "$HOST/.req-framework/framework"
        cp "$SOURCE_REPO_ROOT/VERSION" "$HOST/.req-framework/VERSION"
        [ -f "$SOURCE_REPO_ROOT/CHANGELOG.md" ] && cp "$SOURCE_REPO_ROOT/CHANGELOG.md" "$HOST/.req-framework/"
        [ -f "$SOURCE_REPO_ROOT/MIGRATION.md" ] && cp "$SOURCE_REPO_ROOT/MIGRATION.md" "$HOST/.req-framework/"
        ;;
    submodule)
        if [ ! -d "$HOST/.git" ]; then
            echo "ERROR: submodule mode requires the host directory to be a git repo" >&2
            exit 1
        fi
        git -C "$HOST" submodule add "$REMOTE" .req-framework
        ;;
    *)
        echo "ERROR: unknown mode '$MODE'" >&2; exit 1
        ;;
esac

# 2. Write .req.config.yml (init mode: data and code both at host root)
cat > "$HOST/.req.config.yml" <<EOF
# req framework configuration
# data_root      — where intake/specs/personas/conflicts/reviews/docs live
# code_root      — where AI-generated src/ and tests/ live
# framework_root — where the framework lives (relative to host root)
data_root: .
code_root: .
framework_root: .req-framework
last_synced_version: $(cat "$SOURCE_REPO_ROOT/VERSION")
EOF

# 3. Create empty business directories
echo "→ Creating business directories"
mkdir -p "$HOST/intake/raw" "$HOST/specs" "$HOST/personas" \
         "$HOST/conflicts" "$HOST/reviews" "$HOST/docs/postmortems" \
         "$HOST/src" "$HOST/tests"

touch "$HOST/intake/raw/.gitkeep" \
      "$HOST/specs/.gitkeep" \
      "$HOST/personas/.gitkeep" \
      "$HOST/conflicts/.gitkeep" \
      "$HOST/reviews/.gitkeep" \
      "$HOST/src/.gitkeep" \
      "$HOST/tests/.gitkeep"

# 4. Seed the changelog
if [ ! -f "$HOST/docs/changelog.md" ]; then
    cat > "$HOST/docs/changelog.md" <<EOF
# Changelog

This file logs every spec state transition. Auto-updated by /req-* commands.

## $(date '+%Y-%m-%d')
- Project initialized via req-init.sh
EOF
fi

# 5. Generate the slash commands
echo "→ Generating .claude/commands/req-*.md"
bash "$HOST/.req-framework/framework/scripts/req-sync-commands.sh"

# 6. Friendly next-steps
cat <<EOF

✅ req project initialized.

Next steps:
  1. Open this directory in Claude Code.
  2. Run /req-intake to capture your first requirement.
  3. Read .req-framework/framework/AGENTS.md for the behavioral rules.

Upgrade later with:
  cd .req-framework && git pull && cd ..
  bash .req-framework/framework/scripts/req-sync-commands.sh
EOF
