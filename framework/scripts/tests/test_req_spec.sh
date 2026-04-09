#!/usr/bin/env bash
# Smoke test for `req changelog append`, `req spec status`, `req spec set-status`.
#
# Creates a temp project with a minimal spec to test against.

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
    if echo "$output" | grep -qF -- "$needle"; then
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

# Set up temp project
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cat > "$TMPDIR/.req.config.yml" <<'YAML'
data_root: .
code_root: .
framework_root: .req-framework
autonomy_level: strict
last_synced_version: 2.3.0
YAML

mkdir -p "$TMPDIR/docs" "$TMPDIR/specs/feat-login" "$TMPDIR/conflicts"

cat > "$TMPDIR/specs/feat-login/spec.md" <<'SPEC'
# 登入功能

## * 狀態：`draft`

## * 版本歷史

| 版本 | 日期 | 變更摘要 | 觸發者 |
|------|------|----------|--------|
| v1.0 | 2026-04-09 | 初始版本 | /req-translate |

## * 來源追溯

- 原始需求：intake/raw/2026-04-09-login.md
- 提出者：PM 老王

## * 負責人

- Spec 擁有者：PM 老王
- 審核者：Tech Lead

## * 依賴關係

- 前置需求：無

## * 需求摘要

讓使用者可以登入系統。
SPEC

# Create an unresolved conflict referencing this spec
cat > "$TMPDIR/conflicts/CONFLICT-001.md" <<'CONFLICT'
# CONFLICT-001：登入方式衝突

## 狀態：`detected`

涉及 spec: feat-login
CONFLICT

echo "=============================================="
echo "  req spec / changelog — Smoke Tests"
echo "=============================================="
echo ""

# -----------------------------------------------
echo "[1] changelog append"
output=$(cd "$TMPDIR" && "$REQ_BIN" changelog append "initial setup" 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_contains "prints path" "$output" "changelog.md"

content=$(cat "$TMPDIR/docs/changelog.md" 2>/dev/null)
assert_contains "entry appended" "$content" "initial setup"
assert_contains "date present" "$content" "2026-"
echo ""

# -----------------------------------------------
echo "[2] spec status (read-only)"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec status feat-login 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "status is draft" "$output" "status" "draft"
assert_json_field "title" "$output" "title" "登入功能"
assert_json_field "version" "$output" "version" "v1.0"
assert_json_field "owner" "$output" "owner" "PM 老王"
assert_contains "unresolved conflict found" "$output" "CONFLICT-001"
echo ""

# -----------------------------------------------
echo "[3] spec status — nonexistent slug"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec status nonexistent 2>&1 >/dev/null)
ec=$?
assert_exit "exit code 1" 1 "$ec"
echo ""

# -----------------------------------------------
echo "[4] set-status: draft → in-review (valid)"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login in-review --by "/req-translate" 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "old_status" "$output" "old_status" "draft"
assert_json_field "new_status" "$output" "new_status" "in-review"

# Verify file changed
spec_line=$(grep '狀態' "$TMPDIR/specs/feat-login/spec.md" | head -1)
assert_contains "spec.md updated" "$spec_line" "in-review"

# Verify changelog
cl=$(cat "$TMPDIR/docs/changelog.md")
assert_contains "changelog has transition" "$cl" "draft"
echo ""

# -----------------------------------------------
echo "[5] set-status: in-review → approved (valid)"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login approved --by "/req-review" 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "new_status" "$output" "new_status" "approved"
echo ""

# -----------------------------------------------
echo "[6] set-status: approved → done (INVALID — must go through in-progress)"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login done 2>&1 >/dev/null)
ec=$?
assert_exit "exit code 1 (invalid transition)" 1 "$ec"
echo ""

# -----------------------------------------------
echo "[7] set-status: approved → in-progress (valid)"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login in-progress --by "/req-plan" 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "new_status" "$output" "new_status" "in-progress"
echo ""

# -----------------------------------------------
echo "[8] set-status: in-progress → done (valid)"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login done --by "/req-implement" 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "new_status" "$output" "new_status" "done"
echo ""

# -----------------------------------------------
echo "[9] set-status: done → draft (valid, iterate)"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login draft --reason "fixup" --by "/req-iterate" 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "new_status" "$output" "new_status" "draft"

cl=$(cat "$TMPDIR/docs/changelog.md")
assert_contains "reason tag in changelog" "$cl" "[fixup]"
assert_contains "by tag in changelog" "$cl" "/req-iterate"
echo ""

# -----------------------------------------------
echo "[10] set-status: invalid status name"
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login bogus 2>&1 >/dev/null)
ec=$?
assert_exit "exit code 1" 1 "$ec"
echo ""

# -----------------------------------------------
echo "[11] set-status: no-op (already at target)"
# Current status is draft (from step 9)
output=$(cd "$TMPDIR" && "$REQ_BIN" spec set-status feat-login draft 2>&1)
ec=$?
assert_exit "exit code 0 (no-op)" 0 "$ec"
assert_contains "already message" "$output" "already"
echo ""

# -----------------------------------------------
echo "[12] full lifecycle: draft → in-review → approved → in-progress → done"
# Reset to draft (already there from step 9)
cd "$TMPDIR"
"$REQ_BIN" spec set-status feat-login in-review --by "test" >/dev/null 2>&1
"$REQ_BIN" spec set-status feat-login approved --by "test" >/dev/null 2>&1
"$REQ_BIN" spec set-status feat-login in-progress --by "test" >/dev/null 2>&1
output=$("$REQ_BIN" spec set-status feat-login done --by "test" 2>/dev/null)
ec=$?
assert_exit "full lifecycle completes" 0 "$ec"
assert_json_field "final status is done" "$output" "new_status" "done"

# Count changelog entries (should have many transitions)
entry_count=$(grep -c "^- " "$TMPDIR/docs/changelog.md" 2>/dev/null)
if [ "$entry_count" -ge 8 ]; then
    printf "  \033[32m✓\033[0m changelog has %d entries (≥8 expected)\n" "$entry_count"
    PASS=$((PASS + 1))
else
    printf "  \033[31m✗\033[0m changelog has %d entries (expected ≥8)\n" "$entry_count"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("changelog entry count")
fi
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
