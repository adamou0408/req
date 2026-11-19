#!/usr/bin/env bash
# 停止模擬的人員目錄。資料留在 sim/.run/ldap/data，下次啟動還在；要回到種子狀態請用 reset.sh。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sim_stop_daemon "$SIM_LDAP_NAME"
sim_log "${SIM_LDAP_NAME} 已停止"
