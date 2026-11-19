#!/usr/bin/env bash
# 依相依的反向順序停止模擬服務。
# 用法：sim/down.sh [服務...]
#   不指定：停止全部。
#   指定：停止這些服務，以及相依於它們的服務（否則會留下相依對象已經不在的服務）。
set -euo pipefail

# shellcheck source=sim/lib/orchestrate.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/orchestrate.sh"

order_text="$(sim_stop_order "$@")" || exit 1
if [[ -z "$order_text" ]]; then
    sim_log "sim/ 下沒有任何服務"
    exit 0
fi
mapfile -t order <<<"$order_text"

sim_log "停止順序：${order[*]}"
failed=()
for name in "${order[@]}"; do
    sim_log "停止 ${name}"
    # 一個服務停不下來不該擋住其他服務；全部試過之後再回報。
    "$(sim_service_dir "$name")/stop.sh" || failed+=("$name")
done

[[ "${#failed[@]}" -eq 0 ]] || sim_die "沒有順利停止：${failed[*]}"
