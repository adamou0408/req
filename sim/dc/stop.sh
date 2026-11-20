#!/usr/bin/env bash
# 停止 DC 模擬器。資料庫與已套用的權限留著，下次啟動還在；要清空用 start.sh --reset。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sim_stop_daemon "$SIM_DC_NAME"
sim_log "${SIM_DC_NAME} 已停止"
