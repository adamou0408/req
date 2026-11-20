#!/usr/bin/env bash
# 品質關卡的單一入口（工程規範第 6 節）。本機與 CI 都只執行這支，任何一段失敗就整體失敗（exit 1）。
# 依 docs/methodology/templates/check.sh 改寫；只放「現在就真的設定好並通過」的段落。
# 還沒納入的工具（sqlfluff、knip、Trivy、hadolint、actionlint、產生檔檢查）列在 docs/handoff/promote.md，不在這裡放空殼。
# 用法：tools/check.sh            全部（最後跑 tools/run-all.sh）
#       tools/check.sh --fast     不跑 tools/run-all.sh（只做靜態檢查與 plpgsql_check）
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
fast=0
[[ "${1:-}" == "--fast" ]] && fast=1

# 這支腳本自己含有被禁止的字串樣式，所以排除自己
SOURCE_EXCLUDES=(':!docs' ':!*.md' ':!tools/check.sh' ':!db/tests/kernel/fixtures')
TEST_PATHS=(db/tests db/testing e2e)
MAX_BYTES=$((1024 * 1024))
RUNTIME_PATHS='(^|/)(\.run|node_modules|dist|test-results|playwright-report)/'

failed=()

section() { printf '\n== %s\n' "$1"; }
need() {
    command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1：先執行 tools/install-dev-tools.sh" >&2; return 1; }
}
run() {
    local name="$1"
    shift
    section "$name"
    if "$@"; then echo "通過"; else failed+=("$name"); fi
}

# 會被提交的檔案：已追蹤的，加上沒被 .gitignore 排除的新檔
repo_files() { git ls-files -z --cached --others --exclude-standard "$@"; }

check_install() { npm ci --no-audit --no-fund --silent; }
check_format() { npx prettier --check . >/dev/null; }
check_lint() { npx eslint --max-warnings 0 .; }
check_types() { npx tsc -p packages/contract && npx tsc -p api && npx tsc -p e2e/reference/passkey; }

check_shell() {
    need shellcheck || return 1
    local files=()
    while IFS= read -r -d '' f; do [[ -f "$f" ]] && files+=("$f"); done < <(repo_files '*.sh')
    LC_ALL=C.UTF-8 shellcheck -x -P SCRIPTDIR "${files[@]}"
}

check_plpgsql() { db/build.sh --plpgsql-check >/dev/null; }

check_forbidden() {
    local bad=0 hits
    hits=$(git grep --untracked -nE '(TODO|FIXME)' -- . "${SOURCE_EXCLUDES[@]}" || true)
    if [[ -n "$hits" ]]; then
        echo "程式裡不得有 TODO/FIXME：" >&2
        echo "$hits" >&2
        bad=1
    fi
    # node:test 的 test.skip/it.only、{ skip: … }、{ only: … }、{ todo: … } 都算
    hits=$(git grep --untracked -nE '\.(skip|only|todo)\(|\{[^}]*\b(skip|only|todo)\s*:' -- "${TEST_PATHS[@]}" ':!db/tests/kernel/fixtures' || true)
    if [[ -n "$hits" ]]; then
        echo "測試裡不得有 .skip/.only：" >&2
        echo "$hits" >&2
        bad=1
    fi
    return "$bad"
}

check_tracked_files() {
    local bad=0 path size
    while IFS= read -r -d '' path; do
        [[ -f "$path" ]] || continue
        if [[ "$path" =~ $RUNTIME_PATHS ]]; then
            echo "執行期或建置產物被追蹤：$path" >&2
            bad=1
        fi
        size=$(stat -c %s "$path")
        if ((size > MAX_BYTES)); then
            echo "超過 1 MB：$path（$size bytes）" >&2
            bad=1
        fi
    done < <(repo_files)
    return "$bad"
}

check_audit() { npm audit --audit-level=high --omit=optional; }
# sim/dc 不在根目錄的 workspaces（自己的 lock）：以根目錄的 Prettier、ESLint 設定檢查，再跑它自己的型別檢查與測試
check_sim_dc() {
    npx prettier --ignore-path /dev/null --check sim/dc/src sim/dc/tests >/dev/null &&
        npx eslint --no-ignore --max-warnings 0 sim/dc/src sim/dc/tests &&
        sim/dc/test.sh >/dev/null
}
check_tests() { tools/run-all.sh; }

run "安裝（npm ci）" check_install
run "格式（Prettier）" check_format
run "lint（ESLint）" check_lint
run "型別（tsc）" check_types
run "shell 腳本（shellcheck）" check_shell
run "PL/pgSQL 靜態分析（plpgsql_check）" check_plpgsql
run "禁止字串（TODO/FIXME、.skip/.only）" check_forbidden
run "追蹤的檔案（1 MB、執行期目錄）" check_tracked_files
run "套件弱點（npm audit，high 以上）" check_audit
run "sim/dc（格式、lint、型別、測試）" check_sim_dc
if ((!fast)); then
    run "測試（tools/run-all.sh）" check_tests
fi

section "結果"
if ((${#failed[@]} > 0)); then
    echo "失敗：${failed[*]}"
    exit 1
fi
echo "全部通過"
