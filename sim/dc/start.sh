#!/usr/bin/env bash
# 啟動 DC 模擬器。已經在跑就不重啟。加 --reset 會重建兩個資料庫的結構與示範資料，並刪除所有被授權者角色。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

if sim_pid_alive "$SIM_DC_NAME"; then
    sim_log "${SIM_DC_NAME} 已經在執行（pid $(<"$(sim_pid_file "$SIM_DC_NAME")")）"
    exit 0
fi

sim_dc_load_env
"${here}/install.sh"
sim_require_port_free "$SIM_DC_HOST" "$SIM_DC_PORT"

app="$(sim_dc_app_dir)"
# 開發用的平台簽章金鑰對：私鑰給平台那一側在開發環境簽規則，公鑰是本服務信任的金鑰。
node "${app}/src/cli.ts" keygen "$(sim_run_dir "$SIM_DC_NAME")/keys" platform-dev

sim_start_daemon "$SIM_DC_NAME" "$SIM_DC_NAME" node "${app}/src/cli.ts" serve "$@"

waited=0
until "${here}/health.sh" >/dev/null 2>&1; do
    sim_pid_alive "$SIM_DC_NAME" || sim_die "${SIM_DC_NAME} 啟動後就結束了，請看 $(sim_log_file "$SIM_DC_NAME")"
    # 第一次啟動要建立資料庫並載入示範資料
    [[ "$waited" -lt 300 ]] || sim_die "${SIM_DC_NAME} 60 秒內沒有就緒，請看 $(sim_log_file "$SIM_DC_NAME")"
    sleep 0.2
    waited=$((waited + 1))
done
sim_log "${SIM_DC_NAME} 已啟動：http://${SIM_DC_HOST}:${SIM_DC_PORT}/v1（遮罩資料：/masked/v1）"
