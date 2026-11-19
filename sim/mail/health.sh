#!/usr/bin/env bash
# 健康檢查：HTTP 的 readyz 通過，而且 SMTP 埠回應 220。健康回 0。
set -euo pipefail

# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

sim_load_env mail

curl -fsS --max-time 3 -o /dev/null \
    "http://${SIM_MAIL_HTTP_HOST}:${SIM_MAIL_HTTP_PORT}/readyz"

exec 3<>"/dev/tcp/${SIM_MAIL_SMTP_HOST}/${SIM_MAIL_SMTP_PORT}"
IFS= read -r -t 3 banner <&3
printf 'QUIT\r\n' >&3
exec 3<&-
[[ "$banner" == 220* ]]
