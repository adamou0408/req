#!/usr/bin/env bash
# 從原始碼建置固定版本的 Dex，放到 sim/.run/idp/bin/。已經是指定版本就什麼都不做。
# 為什麼不直接 go install：Dex 的 go.mod 有 replace 指令（把 api/v2 指到 repo 內的目錄），
# go install 會拒絕；而且 api/v2 是另一個模組，不在模組快取的壓縮檔裡。所以取回原始碼再建置。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

readonly REPO_URL=https://github.com/dexidp/dex

sim_load_env "$SIM_IDP_NAME"
version="${SIM_IDP_DEX_VERSION:?service.env 必須設定 SIM_IDP_DEX_VERSION}"
commit="${SIM_IDP_DEX_COMMIT:?service.env 必須設定 SIM_IDP_DEX_COMMIT}"
run_dir="$(sim_run_dir "$SIM_IDP_NAME")"
bin="${run_dir}/bin/dex"

if [[ -x "$bin" ]] && "$bin" version 2>/dev/null | grep -qxF "Dex Version: ${version}"; then
    exit 0
fi

# 儲存用 SQLite，需要 cgo，所以要有 C 編譯器。
sim_require_cmd go git gcc
build_dir="${run_dir}/build"
rm -rf "$build_dir"
mkdir -p "$build_dir" "${run_dir}/bin"
trap 'rm -rf "$build_dir"' EXIT

sim_log "建置 Dex ${version}（第一次約需兩分鐘）"
{
    git -c advice.detachedHead=false clone --depth 1 --branch "$version" "$REPO_URL" "${build_dir}/src"
    cd "${build_dir}/src"
    actual="$(git rev-parse HEAD)"
    if [[ "$actual" != "$commit" ]]; then
        echo "標籤 ${version} 指向 ${actual}，不是預期的 ${commit}"
        exit 1
    fi
    CGO_ENABLED=1 go build -trimpath -ldflags "-s -w -X main.version=${version}" \
        -o "${bin}.new" ./cmd/dex
} >"${run_dir}/install.log" 2>&1 || sim_die "建置失敗，請看 ${run_dir}/install.log"

mv "${bin}.new" "$bin"
sim_log "Dex ${version} 已安裝到 ${bin}"
