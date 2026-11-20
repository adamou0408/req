#!/usr/bin/env bash
# 健康檢查（實例由 SIM_DC_INSTANCE 指定，預設 main）：/health 回 ok，表示 HTTP 服務在、兩個資料庫都連得上。健康回 0。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sim_dc_load_env
body="$(curl -fsS --max-time 3 "http://${SIM_DC_HOST}:${SIM_DC_PORT}/health")"
[[ "$(jq -r .status <<<"$body")" == ok ]]
