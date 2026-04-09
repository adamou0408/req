#!/usr/bin/env bash
# Smoke test for `req review checklist`.

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

assert_item_pass() {
    local name="$1" output="$2" item_id="$3" expected="$4"
    local actual
    actual=$(echo "$output" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data['items']:
    if item['id'] == '$item_id':
        print(str(item['pass']))
        break
" 2>/dev/null)
    if [ "$actual" = "$expected" ]; then
        printf "  \033[32m✓\033[0m %s (%s.pass = %s)\n" "$name" "$item_id" "$expected"
        PASS=$((PASS + 1))
    else
        printf "  \033[31m✗\033[0m %s (%s.pass expected '%s', got '%s')\n" "$name" "$item_id" "$expected" "$actual"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$name")
    fi
}

# Set up temp project with a well-formed in-review spec
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

cat > "$TMPDIR/.req.config.yml" <<'YAML'
data_root: .
code_root: .
framework_root: .req-framework
autonomy_level: strict
YAML

mkdir -p "$TMPDIR/docs" "$TMPDIR/specs/feat-good" "$TMPDIR/specs/feat-bad" "$TMPDIR/conflicts"

# Good spec: all checks should pass
cat > "$TMPDIR/specs/feat-good/spec.md" <<'SPEC'
# 好功能

## * 狀態：`in-review`

## * 版本歷史

| 版本 | 日期 | 變更摘要 | 觸發者 |
|------|------|----------|--------|
| v1.0 | 2026-04-09 | 初始版本 | /req-translate |

## * 來源追溯

- 原始需求：[intake/raw/2026-04-09-good.md](../../intake/raw/2026-04-09-good.md)
- 提出者：PM

## * 負責人

- Spec 擁有者：PM
- 審核者：Tech Lead

## * 依賴關係

- 前置需求：無

## * 需求摘要

一個好功能。

## * 使用者故事

### 使用者
- **作為** 使用者，**我想要** 好東西
- **驗收條件**：
  - [ ] 條件 A
  - [ ] 條件 B

## * 非功能需求

- 效能：P95 < 200ms
- 相容性：向後相容

## * 安全性需求

- 資料分類：內部
- 認證需求：需登入
- 授權需求：一般使用者
- 加密需求：TLS
- 審計日誌：記錄操作
- 個資處理：無涉及

## * 成功指標

- 上線後使用率 > 50%
- 量測方式：分析工具

## 開放問題

- 無
SPEC

# Bad spec: multiple failures
cat > "$TMPDIR/specs/feat-bad/spec.md" <<'SPEC'
# 壞功能

## * 狀態：`draft`

## * 版本歷史

| 版本 | 日期 | 變更摘要 | 觸發者 |
|------|------|----------|--------|
| v1.0 | 2026-04-09 | 初始版本 | /req-translate |

## * 來源追溯

- 提出者：匿名

## * 負責人

- Spec 擁有者：
- 審核者：

## * 依賴關係

- 前置需求：無

## * 需求摘要

不完整的功能。

## * 使用者故事

（待補）

## * 非功能需求

## * 安全性需求

## * 成功指標

## 開放問題

- [ ] 待確認事項 1
SPEC

# Add an unresolved conflict for feat-bad
cat > "$TMPDIR/conflicts/CONFLICT-002.md" <<'CF'
# CONFLICT-002：test

## 狀態：`detected`

涉及 spec: feat-bad
CF

echo "=============================================="
echo "  req review checklist — Smoke Tests"
echo "=============================================="
echo ""

echo "[1] Good spec: all checks pass"
output=$(cd "$TMPDIR" && "$REQ_BIN" review checklist feat-good 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "all_pass" "$output" "all_pass" "True"
assert_json_field "title" "$output" "title" "好功能"
assert_item_pass "status in-review" "$output" "spec_status" "True"
assert_item_pass "user stories" "$output" "user_stories" "True"
assert_item_pass "criteria" "$output" "acceptance_criteria" "True"
assert_item_pass "conflicts" "$output" "conflicts_resolved" "True"
assert_item_pass "open questions" "$output" "open_questions" "True"
assert_item_pass "security" "$output" "security_assessment" "True"
assert_item_pass "metrics" "$output" "success_metrics" "True"
assert_item_pass "ownership" "$output" "ownership" "True"
assert_item_pass "traceability" "$output" "traceability" "True"
assert_item_pass "nfr" "$output" "non_functional" "True"
echo ""

echo "[2] Bad spec: multiple failures"
output=$(cd "$TMPDIR" && "$REQ_BIN" review checklist feat-bad 2>/dev/null)
ec=$?
assert_exit "exit code 0" 0 "$ec"
assert_json_field "all_pass is False" "$output" "all_pass" "False"
assert_item_pass "status not in-review (draft)" "$output" "spec_status" "True"
assert_item_pass "no user stories" "$output" "user_stories" "False"
assert_item_pass "no criteria" "$output" "acceptance_criteria" "False"
assert_item_pass "unresolved conflict" "$output" "conflicts_resolved" "False"
assert_item_pass "open questions remain" "$output" "open_questions" "False"
assert_item_pass "security empty" "$output" "security_assessment" "False"
assert_item_pass "metrics empty" "$output" "success_metrics" "False"
assert_item_pass "no owner" "$output" "ownership" "False"
assert_item_pass "no intake link" "$output" "traceability" "False"
assert_item_pass "nfr empty" "$output" "non_functional" "False"
echo ""

echo "[3] Nonexistent slug"
output=$(cd "$TMPDIR" && "$REQ_BIN" review checklist nonexistent 2>&1 >/dev/null)
ec=$?
assert_exit "exit code 1" 1 "$ec"
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
