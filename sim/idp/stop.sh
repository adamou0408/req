#!/usr/bin/env bash
# 停止模擬的身分提供者。簽章金鑰留在 sim/.run/idp/dex.db，下次啟動沿用。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sim_stop_daemon "$SIM_IDP_NAME"
sim_log "${SIM_IDP_NAME} 已停止"
