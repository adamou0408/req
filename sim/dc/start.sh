#!/usr/bin/env bash
# 啟動 DC 模擬器（實例由 SIM_DC_INSTANCE 指定，預設 main）。已經在跑就不重啟。
# 加 --reset 會重建兩個資料庫的結構與示範資料，並刪除所有被授權者角色。
# 第一次啟動時產生這個實例的密鑰（服務的資料庫密碼、呼叫方金鑰、回應證明的金鑰對），之後沿用。
# 沒有開發用的平台金鑰：信任清單由平台的建置（db/build.sh）寫入，寫入之前任何簽章都不受信任。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

name="$(sim_dc_run_name)"
if sim_pid_alive "$name"; then
    sim_log "${name} 已經在執行（pid $(<"$(sim_pid_file "$name")")）"
    exit 0
fi

sim_dc_load_env
"${here}/install.sh"
app="$(sim_dc_app_dir)"
node "${app}/src/cli.ts" init-secrets "$(sim_dc_keys_dir)"
sim_dc_load_env
sim_require_port_free "$SIM_DC_HOST" "$SIM_DC_PORT"

sim_start_daemon "$name" "$name" node "${app}/src/cli.ts" serve "$@"

waited=0
until "${here}/health.sh" >/dev/null 2>&1; do
    sim_pid_alive "$name" || sim_die "${name} 啟動後就結束了，請看 $(sim_log_file "$name")"
    # 第一次啟動要建立資料庫並載入示範資料
    [[ "$waited" -lt 300 ]] || sim_die "${name} 60 秒內沒有就緒，請看 $(sim_log_file "$name")"
    sleep 0.2
    waited=$((waited + 1))
done
sim_log "${name} 已啟動：http://${SIM_DC_HOST}:${SIM_DC_PORT}/v1（遮罩資料：/masked/v1）"
