#!/usr/bin/env bash
# 用途：品質關卡的單一入口。本機與 CI 都只執行這支，任何一段失敗就整體失敗（exit 1）。
# 怎麼用：複製到 tools/check.sh，從 repo 任何位置執行 tools/check.sh。SKILL.md 步驟 1 建立，空專案也要能跑完。
# 怎麼改：
#   - 標「未設定」的段落，依技術選型在 SKILL.md 步驟 1 或 4 填入指令；步驟 4 結束時格式、lint、測試三段不得再顯示「未設定」。
#   - 依規模取捨：小專案只留格式、lint、測試與內建檢查；中型加型別與資安；用不到的段落整段刪除。
#   - 例外只能在各工具的設定檔逐項寫原因，不在這裡關閉整段。
# 內建檢查（不需要額外工具）：禁止字串、技術債編號、規則代碼的測試覆蓋。
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [ -d .tools/bin ]; then
    PATH="$PWD/.tools/bin:$PATH"
fi

# 專案設定
RULE_DOCS=(docs/contract docs/design.md)   # 規則代碼的唯一來源：骨幹第 5 節加各契約（小專案為設計文件）
RULE_PATTERN='R-[A-Z]+-[0-9]{2,}'          # 與骨幹第 1 節的規則代碼格式一致
TEST_PATHS=(tests)                         # 測試所在的目錄
SOURCE_EXCLUDES=(':!docs' ':!*.md' ':!tools/check.sh')
ENABLE_TRIVY=0                             # 中、大型專案設為 1

failed=()
unset_steps=()

section() { printf '\n== %s\n' "$1"; }
not_set() { echo "未設定"; unset_steps+=("$1"); }
need() {
    command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1：先執行 tools/install-dev-tools.sh" >&2; return 1; }
}
run() {
    local name="$1"
    shift
    section "${name}"
    local before="${#unset_steps[@]}"
    if ! "$@"; then
        failed+=("${name}")
    elif [ "${#unset_steps[@]}" -eq "${before}" ]; then
        echo "通過"
    fi
}

check_format() { not_set "格式"; }      # 例：npx prettier --check .
check_lint() { not_set "lint"; }        # 例：npx eslint --max-warnings 0 .
check_types() { not_set "型別"; }       # 例：npx tsc --noEmit（中、大型）
check_tests() { not_set "測試"; }       # 例：npm test
check_generated() { not_set "產生檔"; } # 例：npm run generate && git diff --exit-code（有產生檔時）

check_shell() {
    local files
    files=$(git ls-files '*.sh')
    [ -z "${files}" ] && return 0
    need shellcheck || return 1
    # shellcheck disable=SC2086 # 檔名清單需要分詞
    LC_ALL=C.UTF-8 shellcheck ${files}
}

check_forbidden() {
    local bad=0 hits
    hits=$(git grep -nE '(TODO|FIXME)' -- . "${SOURCE_EXCLUDES[@]}" || true)
    if [ -n "${hits}" ]; then
        echo "程式裡不得有 TODO/FIXME；登記到 docs/tech-debt.md 並改寫成 TD-<n>：" >&2
        echo "${hits}" >&2
        bad=1
    fi
    hits=$(git grep -nE '\.(skip|only)\(' -- "${TEST_PATHS[@]}" 2>/dev/null || true)
    if [ -n "${hits}" ]; then
        echo "測試裡不得有 .skip/.only：" >&2
        echo "${hits}" >&2
        bad=1
    fi
    return "${bad}"
}

check_debt_refs() {
    local bad=0 ref
    for ref in $(git grep -hoE 'TD-[0-9]+' -- . "${SOURCE_EXCLUDES[@]}" | sort -u || true); do
        if ! grep -qE "^\| ${ref} \|" docs/tech-debt.md 2>/dev/null; then
            echo "${ref} 沒有登記在 docs/tech-debt.md" >&2
            bad=1
        fi
    done
    return "${bad}"
}

check_rule_coverage() {
    local bad=0 code codes
    codes=$(grep -rohE "${RULE_PATTERN}" "${RULE_DOCS[@]}" 2>/dev/null | sort -u || true)
    if [ -z "${codes}" ]; then
        echo "尚無規則代碼（骨幹定稿後生效）"
        return 0
    fi
    for code in ${codes}; do
        if ! git grep -qF "${code}" -- "${TEST_PATHS[@]}" 2>/dev/null; then
            echo "規則 ${code} 沒有測試" >&2
            bad=1
        fi
    done
    return "${bad}"
}

check_security() {
    [ "${ENABLE_TRIVY}" = 1 ] || { echo "未啟用（小型專案）"; return 0; }
    need trivy || return 1
    trivy fs --quiet --exit-code 1 --severity HIGH,CRITICAL --scanners vuln,secret,misconfig .
}

run "格式" check_format
run "lint" check_lint
run "型別" check_types
run "測試" check_tests
run "產生檔無差異" check_generated
run "shell 腳本" check_shell
run "禁止字串" check_forbidden
run "技術債編號" check_debt_refs
run "規則代碼的測試覆蓋" check_rule_coverage
run "資安掃描" check_security

section "結果"
if [ "${#unset_steps[@]}" -gt 0 ]; then
    echo "未設定：${unset_steps[*]}"
fi
if [ "${#failed[@]}" -gt 0 ]; then
    echo "失敗：${failed[*]}"
    exit 1
fi
echo "全部通過"
