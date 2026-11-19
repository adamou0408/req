#!/usr/bin/env bash
# 列出每個模擬服務的狀態與位址。位址取自各服務的 service.env，這份輸出就是埠對照表。
# 用法：sim/status.sh [--strict] [服務...]
#   --strict：只要有服務不是 healthy 就回傳 1（給 CI 與檢查腳本用）。
set -euo pipefail

# shellcheck source=sim/lib/orchestrate.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/orchestrate.sh"

strict=false
if [[ "${1:-}" == "--strict" ]]; then
    strict=true
    shift
fi

if [[ "$#" -gt 0 ]]; then
    names=("$@")
    for name in "${names[@]}"; do
        sim_is_service "$name" || sim_die "找不到服務 ${name}"
    done
else
    order_text="$(sim_full_order)" || exit 1
    names=()
    [[ -z "$order_text" ]] || mapfile -t names <<<"$order_text"
fi

all_healthy=true
printf '%-12s %-10s %s\n' "服務" "狀態" "位址"
for name in "${names[@]}"; do
    state="$(sim_service_state "$name")"
    [[ "$state" == healthy ]] || all_healthy=false
    endpoints="$(sim_service_endpoints "$name" | paste -sd ',' - | sed 's/,/, /g')"
    printf '%-12s %-10s %s\n' "$name" "$state" "${endpoints:--}"
done

if [[ "$strict" == true && "$all_healthy" != true ]]; then
    exit 1
fi
