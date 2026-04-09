#!/usr/bin/env bash
# Smoke test for `req autonomy` subcommands.
#
# Tests against a temporary .req.config.yml in a temp directory.
# Does NOT modify the real project config.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQ_BIN="$SCRIPT_DIR/../req"

PASS=0
FAIL=0
FAILED_TESTS=()

assert_exit() {
    local name="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        printf "  \033[32m✓\033[0m %s\n" "$name"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (expected exit %s, got %s)\n" "$name" "$expected" "$actual"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

assert_contains() {
    local name="$1" output="$2" needle="$3"
    if echo "$output" | grep -q -- "$needle"; then
        printf "  \033[32m✓\033[0m %s\n" "$name"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (missing '%s')\n" "$name" "$needle"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

assert_json_field() {
    local name="$1" output="$2" field="$3" expected="$4"
    local actual
    actual=$(echo "$output" | python3 -c "import sys, json; print(json.load(sys.stdin).get('$field', ''))" 2>/dev/null)
    if [ "$actual" = "$expected" ]; then
        printf "  \033[32m✓\033[0m %s (%s = %s)\n" "$name" "$field" "$expected"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (%s expected '%s', got '%s')\n" "$name" "$field" "$expected" "$actual"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

# Create a temp directory with a minimal .req.config.yml
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cat > "$TMPDIR/.req.config.yml" <<'YAML'
data_root: .
code_root: .
framework_root: .req-framework
autonomy_level: strict
last_synced_version: 2.3.0
YAML

mkdir -p "$TMPDIR/docs"

echo "=============================================="
echo "  req autonomy — Smoke Tests"
echo "=============================================="
echo ""

echo "[1] autonomy current (text)"
output=$(cd "$TMPDIR" && "$REQ_BIN" autonomy current 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_contains "shows current level" "$output" "strict"
assert_contains "shows matrix" "$output" "Conflict resolution"
assert_contains "shows Human marker" "$output" "Human"
echo ""

echo "[2] autonomy current --format json"
output=$(cd "$TMPDIR" && "$REQ_BIN" autonomy current --format json 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "level is strict" "$output" "level" "strict"
echo ""

echo "[3] autonomy set balanced"
output=$(cd "$TMPDIR" && "$REQ_BIN" autonomy set balanced 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_contains "shows transition" "$output" "strict"
assert_contains "shows matrix" "$output" "Conflict resolution"
echo ""

echo "[4] verify config was updated"
config_level=$(grep 'autonomy_level' "$TMPDIR/.req.config.yml" | awk -F': *' '{print $2}')
if [ "$config_level" = "balanced" ]; then
    printf "  \033[32m✓\033[0m config updated to balanced\n"
    PASS=$((PASS + 1))
else
    printf "  \033[31m✗\033[0m config still '%s'\n" "$config_level"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("config update")
fi
echo ""

echo "[5] verify changelog was appended"
if grep -q "strict → balanced" "$TMPDIR/docs/changelog.md" 2>/dev/null; then
    printf "  \033[32m✓\033[0m changelog entry exists\n"
    PASS=$((PASS + 1))
else
    printf "  \033[31m✗\033[0m changelog entry missing\n"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("changelog append")
fi
echo ""

echo "[6] autonomy set auto (with warning)"
output=$(cd "$TMPDIR" && "$REQ_BIN" autonomy set auto 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_contains "shows warning" "$output" "solo projects"
assert_contains "shows safety net" "$output" "audit"
echo ""

echo "[7] autonomy set auto (no-op, already auto)"
output=$(cd "$TMPDIR" && "$REQ_BIN" autonomy set auto 2>&1)
ec=$?
assert_exit "exit code 0 (no-op)" 0 "$ec"
assert_contains "already message" "$output" "already"
echo ""

echo "[8] autonomy set invalid_level"
output=$(cd "$TMPDIR" && "$REQ_BIN" autonomy set yolo 2>&1 >/dev/null)
ec=$?
assert_exit "exit code 1 (invalid)" 1 "$ec"
echo ""

echo "[9] autonomy set balanced --format json"
# Reset to strict first
cd "$TMPDIR" && "$REQ_BIN" autonomy set strict >/dev/null 2>&1
output=$(cd "$TMPDIR" && "$REQ_BIN" autonomy set balanced --format json 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "old_level" "$output" "old_level" "strict"
assert_json_field "new_level" "$output" "new_level" "balanced"
echo ""

echo "[10] autonomy.level_picker question (from catalog)"
output=$("$REQ_BIN" ask autonomy.level_picker 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_contains "contains Strict" "$output" "Strict"
assert_contains "contains Balanced" "$output" "Balanced"
assert_contains "contains Auto" "$output" "Auto"
echo ""

echo "=============================================="
printf "  Passed: \033[32m%d\033[0m   Failed: \033[31m%d\033[0m\n" "$PASS" "$FAIL"
echo "=============================================="

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "Failed tests:"
    for t in "${FAILED_TESTS[@]}"; do
        echo "  - $t"
    done
    exit 1
fi

exit 0
