#!/usr/bin/env bash
# 從原始碼建置固定版本的 Mailpit（含網頁介面），放到 sim/.run/mail/bin/。
# 為什麼不直接 go install：Go 模組裡不含建置好的前端檔，go install 出來的執行檔
# SMTP 與 API 正常，但網頁介面是空白頁。所以多做一步，用模組內附的原始碼建置前端。
# 已經是指定版本就什麼都不做。
set -euo pipefail

# shellcheck source=sim/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

readonly NAME=mail
readonly MODULE=github.com/axllent/mailpit

sim_load_env "$NAME"
version="${SIM_MAIL_MAILPIT_VERSION:?service.env 必須設定 SIM_MAIL_MAILPIT_VERSION}"
run_dir="$(sim_run_dir "$NAME")"
bin="${run_dir}/bin/mailpit"

if [[ -x "$bin" ]] && "$bin" version --no-release-check 2>/dev/null | grep -qF " ${version} "; then
    exit 0
fi

sim_require_cmd go npm jq
build_dir="${run_dir}/build"
rm -rf "$build_dir"
mkdir -p "$build_dir" "${run_dir}/bin"
trap 'rm -rf "$build_dir"' EXIT

sim_log "建置 Mailpit ${version}（第一次約需一到兩分鐘）"
{
    cd "$build_dir"
    module_dir="$(go mod download -json "${MODULE}@${version}" | jq -r .Dir)"
    [[ -d "$module_dir" ]] || sim_die "下載 ${MODULE}@${version} 失敗"
    # 模組快取是唯讀的，建置前端要寫檔，所以複製一份出來。
    cp -r "$module_dir" src
    chmod -R u+w src
    cd src
    npm ci --ignore-scripts --no-audit --no-fund
    npm run package
    CGO_ENABLED=0 go build -trimpath \
        -ldflags "-s -w -X ${MODULE}/config.Version=${version}" \
        -o "${bin}.new" .
} >"${run_dir}/install.log" 2>&1 || sim_die "建置失敗，請看 ${run_dir}/install.log"

mv "${bin}.new" "$bin"
sim_log "Mailpit ${version} 已安裝到 ${bin}"
