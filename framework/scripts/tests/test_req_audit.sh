#!/usr/bin/env bash
# Smoke test for `req audit run`.
#
# Creates a temp project with:
# - A "done" spec with acceptance criteria referencing symbols
# - src/ with some but not all symbols (→ spec-code drift)
# - A TODO(auto) marker (→ auto-residue drift)
# - A changelog with [autonomy: auto] entry (→ changelog-review drift)

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

assert_json_field_gte() {
    local name="$1" output="$2" field="$3" min="$4"
    local actual
    actual=$(echo "$output" | python3 -c "import sys, json; print(json.load(sys.stdin).get('$field', 0))" 2>/dev/null)
    if [ "$actual" -ge "$min" ] 2>/dev/null; then
        printf "  \033[32m✓\033[0m %s (%s = %s, ≥ %s)\n" "$name" "$field" "$actual" "$min"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (%s = %s, expected ≥ %s)\n" "$name" "$field" "$actual" "$min"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

# Set up temp project with deliberate drift
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cat > "$TMPDIR/.req.config.yml" <<'YAML'
data_root: .
code_root: .
framework_root: .req-framework
autonomy_level: auto
YAML

mkdir -p "$TMPDIR/docs" "$TMPDIR/specs/feat-search" "$TMPDIR/src"

# A "done" spec with acceptance criteria referencing symbols
cat > "$TMPDIR/specs/feat-search/spec.md" <<'SPEC'
# 搜尋功能

## * 狀態：`done`

## * 版本歷史

| 版本 | 日期 | 變更摘要 | 觸發者 |
|------|------|----------|--------|
| v1.0 | 2026-04-09 | 初始版本 | /req-translate |

## * 使用者故事

### 終端用戶

- **作為** 使用者，**我想要** 搜尋功能
- **驗收條件**：
  - [x] 呼叫 `searchUsers()` 可搜尋使用者
  - [x] 呼叫 `searchDocs()` 可搜尋文件
  - [x] 呼叫 `missingFunc()` 可做其他事情
SPEC

# src/ with searchUsers but NOT searchDocs or missingFunc → drift
cat > "$TMPDIR/src/search.js" <<'JS'
// Spec: specs/feat-search/spec.md
function searchUsers(query) {
  return db.query('SELECT * FROM users WHERE name LIKE ?', query);
}
// TODO(auto) — 這個標記應該在 audit 被抓到
JS

# Changelog with an autonomy entry
cat > "$TMPDIR/docs/changelog.md" <<'CL'
# Changelog

- 2026-04-09: spec feat-search (`approved` → `in-progress`) [autonomy: auto] by /req-iterate
- 2026-04-09: spec feat-search (`in-progress` → `done`) by /req-implement
CL

echo "=============================================="
echo "  req audit — Smoke Tests"
echo "=============================================="
echo ""

echo "[1] audit run (full sweep, text)"
output=$(cd "$TMPDIR" && "$REQ_BIN" audit run 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_contains "report has header" "$output" "Audit Report"
assert_contains "shows autonomy level" "$output" "auto"
assert_contains "finds spec-code drift" "$output" "spec-code"
assert_contains "finds missing symbol" "$output" "missingFunc"
assert_contains "finds auto-residue" "$output" "TODO(auto)"
assert_contains "finds changelog autonomy" "$output" "changelog-review"
echo ""

echo "[2] audit run (json)"
output=$(cd "$TMPDIR" && "$REQ_BIN" audit run --format json 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field_gte "specs scanned ≥ 1" "$output" "specs_scanned" 1
assert_json_field_gte "drift rows ≥ 3" "$output" "drift_rows" 3
assert_json_field_gte "high ≥ 2" "$output" "high" 2
assert_json_field_gte "medium ≥ 1" "$output" "medium" 1
echo ""

echo "[3] audit report file was written"
report_file=$(ls "$TMPDIR/audits/AUDIT-"*.md 2>/dev/null | head -1)
if [ -n "$report_file" ] && [ -f "$report_file" ]; then
    printf "  \033[32m✓\033[0m AUDIT report file exists: %s\n" "$(basename "$report_file")"
    PASS=$((PASS + 1))
    content=$(cat "$report_file")
    assert_contains "report has drift table" "$content" "Spec | Source"
    assert_contains "report has recommendations" "$content" "Recommended Actions"
else
    printf "  \033[31m✗\033[0m AUDIT report file not found\n"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("report file missing")
fi
echo ""

echo "[4] audit run --spec (scoped to one slug)"
output=$(cd "$TMPDIR" && "$REQ_BIN" audit run --spec feat-search --format json 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field_gte "scoped: specs scanned = 1" "$output" "specs_scanned" 1
echo ""

echo "[5] audit run --spec nonexistent (0 specs)"
output=$(cd "$TMPDIR" && "$REQ_BIN" audit run --spec nonexistent --format json 2>/dev/null)
ec=$?
assert_exit "exit code 0 (no crash)" 0 "$ec"
assert_contains "0 specs scanned" "$output" '"specs_scanned": 0'
echo ""

echo "[6] audit on clean project (no drift)"
# Create a clean project with a done spec but no missing symbols
TMPDIR2=$(mktemp -d)
cat > "$TMPDIR2/.req.config.yml" <<'YAML'
data_root: .
code_root: .
framework_root: .req-framework
autonomy_level: strict
YAML
mkdir -p "$TMPDIR2/docs" "$TMPDIR2/specs/feat-clean" "$TMPDIR2/src" "$TMPDIR2/audits"
cat > "$TMPDIR2/specs/feat-clean/spec.md" <<'SPEC'
# 乾淨功能

## * 狀態：`done`

## * 使用者故事

- **驗收條件**：
  - [x] 系統可以啟動
SPEC
cat > "$TMPDIR2/docs/changelog.md" <<'CL'
# Changelog
- 2026-04-09: spec feat-clean done
CL

output=$(cd "$TMPDIR2" && "$REQ_BIN" audit run --format json 2>/dev/null)
ec=$?
assert_exit "clean project exits 0" 0 "$ec"
assert_contains "zero drift" "$output" '"drift_rows": 0'
# Verify report still written
report_file2=$(ls "$TMPDIR2/audits/AUDIT-"*.md 2>/dev/null | head -1)
if [ -n "$report_file2" ]; then
    printf "  \033[32m✓\033[0m zero-drift report still written\n"
    PASS=$((PASS + 1))
else
    printf "  \033[31m✗\033[0m zero-drift report not written\n"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("zero-drift report")
fi
rm -rf "$TMPDIR2"
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
