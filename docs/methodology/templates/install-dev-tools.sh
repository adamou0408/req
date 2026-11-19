#!/usr/bin/env bash
# 用途：安裝 tools/check.sh 用到的 lint 與資安掃描工具（Debian/Ubuntu），版本固定，本機與 CI 結果一致。
# 狀態：這支範本沒有實際執行過。下面的版本號需在新專案實測，跑過後在交接紀錄記下結果。
#
# 怎麼用：複製到 tools/install-dev-tools.sh，從 repo 根目錄執行，參數是要裝的工具組：
#   tools/install-dev-tools.sh                  # 最小可用版：只裝 shellcheck（小專案）
#   tools/install-dev-tools.sh shellcheck trivy # 中型：加資安掃描
#   tools/install-dev-tools.sh shellcheck trivy ci postgres
# 語言自己的格式、lint、測試工具（例如 npm 的 devDependencies）由該語言的套件管理安裝並鎖版本，不放在這裡。
# 工具組要和工程規範第 6 節一致；用不到的函式刪掉，用到別的照同樣寫法加。
#   - 工具組 shellcheck：apt，需要 root 或 sudo
#   - 工具組 trivy：apt，需要 root 或 sudo；套件弱點、機密、錯誤設定
#   - 工具組 ci：Python venv（.tools/），不需要 root；actionlint、hadolint（有 GitHub Actions 或 Dockerfile 時）
#   - 工具組 postgres：選用，只有用 PostgreSQL 時；sqlfluff 裝進 venv，plpgsql_check 需要 PGDG 套件庫與 root
set -euo pipefail

TRIVY_VERSION="0.76.2"
ACTIONLINT_PY_VERSION="1.7.12.25"
HADOLINT_BIN_VERSION="2.15.1"
SQLFLUFF_VERSION="3.4.2"
PG_MAJOR="16"
VENV=".tools"

SUDO=""
need_root() {
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
    elif command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
    else
        echo "這一組需要 root 或 sudo（apt 安裝）：$1" >&2
        exit 1
    fi
}

ensure_venv() {
    if [ ! -x "${VENV}/bin/pip" ]; then
        python3 -m venv "${VENV}"
    fi
}

install_shellcheck() {
    need_root shellcheck
    ${SUDO} apt-get update
    ${SUDO} apt-get install -y shellcheck
    shellcheck --version | sed -n 2p
}

install_trivy() {
    need_root trivy
    ${SUDO} mkdir -p /etc/apt/keyrings
    curl -fsSL https://get.trivy.dev/deb/public.key | ${SUDO} gpg --dearmor --yes -o /etc/apt/keyrings/trivy.gpg
    echo "deb [signed-by=/etc/apt/keyrings/trivy.gpg] https://get.trivy.dev/deb generic main" \
        | ${SUDO} tee /etc/apt/sources.list.d/trivy.list >/dev/null
    ${SUDO} apt-get update
    ${SUDO} apt-get install -y "trivy=${TRIVY_VERSION}"
    trivy --version | head -1
}

install_ci() {
    ensure_venv
    "${VENV}/bin/pip" install \
        "actionlint-py==${ACTIONLINT_PY_VERSION}" \
        "hadolint-bin==${HADOLINT_BIN_VERSION}"
    "${VENV}/bin/actionlint" --version | head -1
    "${VENV}/bin/hadolint" --version
}

install_postgres() {
    ensure_venv
    "${VENV}/bin/pip" install "sqlfluff==${SQLFLUFF_VERSION}"
    "${VENV}/bin/sqlfluff" --version
    # plpgsql_check 只用在開發與 CI 的資料庫，不裝進正式環境；需要先加 PGDG 套件庫（apt.postgresql.org）。
    need_root postgres
    ${SUDO} apt-get install -y "postgresql-${PG_MAJOR}-plpgsql-check"
}

if [ "$#" -eq 0 ]; then
    set -- shellcheck
fi
for group in "$@"; do
    case "${group}" in
        shellcheck | trivy | ci | postgres) "install_${group}" ;;
        *) echo "未知的工具組：${group}" >&2; exit 1 ;;
    esac
done
