#!/usr/bin/env bash
# sim/dc 各腳本共用：載入 sim 的共用函式、本服務的設定與測試憑證。
# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

readonly SIM_DC_NAME=dc

# 載入 service.env 與 test-credentials.env，並補上執行期才決定的值：
#   SIM_DC_PG_ADMIN_URL      superuser 連線，只用來建立本服務的資料庫與登入角色。
#                            沒有另外指定時讀開發環境的唯一來源 db/sgn.env（SGN_PG_ADMIN_URL），不另抄一份。
#   SIM_DC_TRUSTED_KEYS_FILE 沒有指定時用 sim/.run/dc/keys/trusted-keys.json（start.sh 產生開發用金鑰對）。
sim_dc_load_env() {
    sim_load_env "$SIM_DC_NAME"
    local creds
    creds="$(sim_service_dir "$SIM_DC_NAME")/test-credentials.env"
    set -a
    # shellcheck source=/dev/null
    source "$creds"
    set +a
    if [[ -z "${SIM_DC_PG_ADMIN_URL:-}" ]]; then
        local sgn_env="${SIM_ROOT}/../db/sgn.env"
        [[ -f "$sgn_env" ]] || sim_die "找不到 ${sgn_env}；請設定 SIM_DC_PG_ADMIN_URL"
        SIM_DC_PG_ADMIN_URL="$(sed -n 's/^SGN_PG_ADMIN_URL=//p' "$sgn_env")"
        [[ -n "$SIM_DC_PG_ADMIN_URL" ]] || sim_die "${sgn_env} 沒有 SGN_PG_ADMIN_URL"
    fi
    if [[ -z "${SIM_DC_TRUSTED_KEYS_FILE:-}" ]]; then
        SIM_DC_TRUSTED_KEYS_FILE="$(sim_run_dir "$SIM_DC_NAME")/keys/trusted-keys.json"
    fi
    export SIM_DC_PG_ADMIN_URL SIM_DC_TRUSTED_KEYS_FILE
}

# 程式（含 node_modules）安裝在 sim/.run/dc/app：repo 可能以唯讀掛載（sim/docker-compose.yml），
# 而且建置產物一律放 .run。
sim_dc_app_dir() {
    printf '%s/app\n' "$(sim_run_dir "$SIM_DC_NAME")"
}
