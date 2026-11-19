#!/usr/bin/env bash
# 依相依順序啟動模擬服務，逐一等到健康檢查通過。
# 用法：sim/up.sh [服務...]
#   不指定：啟動 sim/ 下所有服務。
#   指定：只啟動這些服務，以及它們（直接或間接）相依的服務。
# 環境變數：SIM_HEALTH_TIMEOUT＝每個服務等待健康檢查的秒數（預設 60）。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib/orchestrate.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/orchestrate.sh"

health_timeout="${SIM_HEALTH_TIMEOUT:-60}"

order_text="$(sim_start_order "$@")" || exit 1
if [[ -z "$order_text" ]]; then
    sim_log "sim/ 下沒有任何服務"
    exit 0
fi
mapfile -t order <<<"$order_text"

for name in "${order[@]}"; do
    sim_check_service_layout "$name"
done

sim_log "啟動順序：${order[*]}"
for name in "${order[@]}"; do
    sim_log "啟動 ${name}"
    "$(sim_service_dir "$name")/start.sh" || sim_die "${name} 的 start.sh 失敗；已啟動的服務維持原狀，可用 sim/down.sh 停止"
    if ! sim_wait_healthy "$name" "$health_timeout"; then
        sim_die "${name} 在 ${health_timeout} 秒內沒有通過健康檢查；log 在 ${SIM_RUN_ROOT}/${name}/"
    fi
    sim_log "${name} 已就緒"
done

"$(dirname "${BASH_SOURCE[0]}")/status.sh" "${order[@]}"
