#!/usr/bin/env bash
# 容器的進入點：啟動模擬服務（參數同 sim/up.sh），留在前景；收到停止訊號時依序停止。
# 服務各自在背景執行，所以這支腳本要自己留在前景，容器才不會結束。
set -euo pipefail

sim_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

shutdown() {
    trap - TERM INT
    "${sim_dir}/down.sh" || true
    exit 0
}

trap shutdown TERM INT
"${sim_dir}/up.sh" "$@"

# sleep 放背景再 wait：bash 要等前景指令結束才處理訊號，直接 sleep 會讓停止卡住。
sleep infinity &
wait "$!"
