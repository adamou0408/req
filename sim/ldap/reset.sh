#!/usr/bin/env bash
# 把目錄恢復成種子狀態：停止、清除資料、重新啟動並載入種子。
# 用在測試做過人事異動（change.sh）之後。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

"${here}/stop.sh"
run_dir="$(sim_run_dir "$SIM_LDAP_NAME")"
rm -rf "${run_dir}/data" "${run_dir}/seed.ldif"
"${here}/start.sh"
