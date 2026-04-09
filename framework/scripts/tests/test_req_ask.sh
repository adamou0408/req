#!/usr/bin/env bash
# Smoke test for `req ask` PoC.
#
# Covers:
#   - static question: every catalog entry resolves to valid JSON
#   - dynamic question: extracts options from a well-formed CONFLICT file
#   - dynamic fallback: malformed CONFLICT file falls through to fallback_options
#   - error paths: unknown question id, missing context, invalid --var
#   - JSON validity: stdout is always parseable JSON (on success or fallback)
#
# Usage:
#   bash framework/scripts/tests/test_req_ask.sh
#
# Exit: 0 on all tests passing, non-zero on any failure.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQ_BIN="$SCRIPT_DIR/../req"
FIXTURES="$SCRIPT_DIR/fixtures"

PASS=0
FAIL=0
FAILED_TESTS=()

assert_success() {
    local name="$1" expected_exit="$2" actual_exit="$3"
    if [ "$actual_exit" = "$expected_exit" ]; then
        printf "  \033[32m✓\033[0m %s\n" "$name"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (expected exit %s, got %s)\n" \
            "$name" "$expected_exit" "$actual_exit"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

assert_json_valid() {
    local name="$1" output="$2"
    if echo "$output" | python3 -c "import sys, json; json.load(sys.stdin)" 2>/dev/null; then
        printf "  \033[32m✓\033[0m %s (valid JSON)\n" "$name"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (invalid JSON)\n" "$name"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

assert_contains() {
    local name="$1" output="$2" needle="$3"
    if echo "$output" | grep -q -- "$needle"; then
        printf "  \033[32m✓\033[0m %s (contains '%s')\n" "$name" "$needle"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (missing '%s')\n" "$name" "$needle"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

assert_option_count() {
    local name="$1" output="$2" expected="$3"
    local actual
    actual=$(echo "$output" | python3 -c "import sys, json; d=json.load(sys.stdin); print(len(d['questions'][0]['options']))" 2>/dev/null || echo "0")
    if [ "$actual" = "$expected" ]; then
        printf "  \033[32m✓\033[0m %s (%d options)\n" "$name" "$expected"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (expected %d options, got %s)\n" \
            "$name" "$expected" "$actual"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

echo "=============================================="
echo "  req ask — Smoke Tests"
echo "=============================================="
echo ""

echo "[1] Static question: intake.confirmation"
output=$("$REQ_BIN" ask intake.confirmation 2>/dev/null)
ec=$?
assert_success "exit code 0" 0 "$ec"
assert_json_valid "valid JSON" "$output"
assert_option_count "3 options" "$output" 3
assert_contains "contains '確認送出'" "$output" "確認送出"
echo ""

echo "[2] Static question: review.approval"
output=$("$REQ_BIN" ask review.approval 2>/dev/null)
ec=$?
assert_success "exit code 0" 0 "$ec"
assert_json_valid "valid JSON" "$output"
assert_option_count "4 options" "$output" 4
assert_contains "contains '退件'" "$output" "退件"
echo ""

echo "[3] Static question: deploy.prod_confirmation"
output=$("$REQ_BIN" ask deploy.prod_confirmation 2>/dev/null)
ec=$?
assert_success "exit code 0" 0 "$ec"
assert_json_valid "valid JSON" "$output"
assert_option_count "2 options" "$output" 2
echo ""

echo "[4] Static question: research.duplicate_action"
output=$("$REQ_BIN" ask research.duplicate_action 2>/dev/null)
ec=$?
assert_success "exit code 0" 0 "$ec"
assert_option_count "3 options" "$output" 3
echo ""

echo "[5] Dynamic question: resolve_conflict.picker (well-formed fixture)"
output=$("$REQ_BIN" ask resolve_conflict.picker \
    --context "$FIXTURES/CONFLICT-test-001.md" 2>/dev/null)
ec=$?
assert_success "exit code 0 (extraction succeeded)" 0 "$ec"
assert_json_valid "valid JSON" "$output"
assert_option_count "3 extracted options" "$output" 3
assert_contains "contains 'Option 1'" "$output" "Option 1"
assert_contains "contains 'Option 3'" "$output" "Option 3"
assert_contains "contains extracted title" "$output" "slug 速率限制"
echo ""

echo "[6] Dynamic question: resolve_conflict.picker (malformed → fallback)"
output=$("$REQ_BIN" ask resolve_conflict.picker \
    --context "$FIXTURES/CONFLICT-test-malformed.md" 2>/dev/null)
ec=$?
assert_success "exit code 5 (fallback used)" 5 "$ec"
assert_json_valid "valid JSON (even on fallback)" "$output"
assert_option_count "2 fallback options" "$output" 2
assert_contains "contains '手動解決' fallback" "$output" "手動解決"
echo ""

echo "[7] Error: unknown question id"
output=$("$REQ_BIN" ask nonexistent.entry 2>&1 >/dev/null)
ec=$?
assert_success "exit code 2" 2 "$ec"
echo ""

echo "[8] Error: dynamic without --context"
output=$("$REQ_BIN" ask resolve_conflict.picker 2>&1 >/dev/null)
ec=$?
assert_success "exit code 4" 4 "$ec"
echo ""

echo "[9] Error: dynamic with missing context file"
output=$("$REQ_BIN" ask resolve_conflict.picker \
    --context /tmp/nonexistent-conflict.md 2>&1 >/dev/null)
ec=$?
assert_success "exit code 4" 4 "$ec"
echo ""

echo "[10] Error: malformed --var"
output=$("$REQ_BIN" ask intake.confirmation --var "no-equals-sign" 2>&1 >/dev/null)
ec=$?
assert_success "exit code 1" 1 "$ec"
echo ""

echo "[11] req list: every catalog entry appears"
output=$("$REQ_BIN" list 2>/dev/null)
ec=$?
assert_success "exit code 0" 0 "$ec"
for qid in intake.confirmation review.approval deploy.prod_confirmation \
           research.duplicate_action resolve_conflict.picker; do
    assert_contains "list contains $qid" "$output" "$qid"
done
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
