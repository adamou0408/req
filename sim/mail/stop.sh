#!/usr/bin/env bash
# 停止模擬郵件伺服器。收到的信留在 sim/.run/mail/mailpit.db，下次啟動還在；
# 要清空請用 mailbox.sh clear。
set -euo pipefail

# shellcheck source=sim/lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

readonly NAME=mail

sim_stop_daemon "$NAME"
sim_log "${NAME} 已停止"
