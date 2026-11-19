#!/usr/bin/env bash
# 容器的進入點：啟動模擬服務（參數同 sim/up.sh），留在前景；收到停止訊號時依序停止。
# 服務各自在背景執行，所以這支腳本要自己留在前景，容器才不會結束。
set -euo pipefail

sim_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=SCRIPTDIR/../common.sh
source "${sim_dir}/lib/common.sh"

# 映像只帶工具鏈；腳本用到而映像沒有的小工具在這裡補上。
install_missing_tools() {
    local tool missing=()
    for tool in curl jq; do
        command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    [[ "${#missing[@]}" -gt 0 ]] || return 0
    sim_log "安裝 ${missing[*]}"
    apt-get update >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}" >/dev/null
}

shutdown() {
    trap - TERM INT
    "${sim_dir}/down.sh" || true
    exit 0
}

install_missing_tools
trap shutdown TERM INT
"${sim_dir}/up.sh" "$@"

# sleep 放背景再 wait：bash 要等前景指令結束才處理訊號，直接 sleep 會讓停止卡住。
sleep infinity &
wait "$!"
