#!/usr/bin/env bash
# 停止 DC 模擬器（實例由 SIM_DC_INSTANCE 指定，預設 main）。資料庫與已套用的權限留著，下次啟動還在；要清空用 start.sh --reset。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

name="$(sim_dc_run_name)"
sim_stop_daemon "$name"
sim_log "${name} 已停止"
