#!/usr/bin/env bash
# sim/dc 各腳本共用：載入 sim 的共用函式、本服務的設定與這個實例的密鑰。
# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

readonly SIM_DC_NAME=dc

# 實例：main（預設，平台端對端用的資料庫連這一個）或 instances/ 底下的其他實例（例如 unit：平台的資料庫測試用）。
# 由環境變數 SIM_DC_INSTANCE 指定。每個實例有自己的執行期目錄 sim/.run/<名稱>/（main 是 dc，其他是 dc-<實例>）。
sim_dc_instance() {
    printf '%s\n' "${SIM_DC_INSTANCE:-main}"
}

sim_dc_run_name() {
    local instance
    instance="$(sim_dc_instance)"
    if [[ "$instance" == main ]]; then printf '%s\n' "$SIM_DC_NAME"; else printf '%s-%s\n' "$SIM_DC_NAME" "$instance"; fi
}

sim_dc_keys_dir() {
    printf '%s/keys\n' "$(sim_run_dir "$(sim_dc_run_name)")"
}

# 載入 service.env、實例的覆寫、這個實例的密鑰（有的話），並補上執行期才決定的值：
#   SIM_DC_PG_ADMIN_URL              superuser 連線，只用來建立本服務的資料庫與登入角色。
#                                    沒有另外指定時讀開發環境的唯一來源 db/admin.env（SGN_PG_ADMIN_URL），不另抄一份。
#   SIM_DC_TRUSTED_KEYS_FILE(_MASKED) 兩個環境各自的信任清單（平台的建置寫入；不存在＝不信任任何金鑰）。
#   SIM_DC_RESPONSE_KEY_FILE         回應證明的私鑰（init-secrets 產生）。
sim_dc_load_env() {
    sim_load_env "$SIM_DC_NAME"
    local instance keys
    instance="$(sim_dc_instance)"
    if [[ "$instance" != main ]]; then
        local file
        file="$(sim_service_dir "$SIM_DC_NAME")/instances/${instance}.env"
        [[ -f "$file" ]] || sim_die "找不到實例設定 ${file}"
        set -a
        # shellcheck source=/dev/null
        source "$file"
        set +a
    fi
    keys="$(sim_dc_keys_dir)"
    if [[ -f "${keys}/secrets.env" ]]; then
        set -a
        # shellcheck source=/dev/null
        source "${keys}/secrets.env"
        set +a
    fi
    if [[ -z "${SIM_DC_PG_ADMIN_URL:-}" ]]; then
        local admin_env="${SIM_ROOT}/../db/admin.env"
        [[ -f "$admin_env" ]] || sim_die "找不到 ${admin_env}；請設定 SIM_DC_PG_ADMIN_URL"
        SIM_DC_PG_ADMIN_URL="$(sed -n 's/^SGN_PG_ADMIN_URL=//p' "$admin_env")"
        [[ -n "$SIM_DC_PG_ADMIN_URL" ]] || sim_die "${admin_env} 沒有 SGN_PG_ADMIN_URL"
    fi
    SIM_DC_TRUSTED_KEYS_FILE="${SIM_DC_TRUSTED_KEYS_FILE:-${keys}/trusted-keys.json}"
    SIM_DC_TRUSTED_KEYS_FILE_MASKED="${SIM_DC_TRUSTED_KEYS_FILE_MASKED:-${keys}/trusted-keys-masked.json}"
    SIM_DC_RESPONSE_KEY_FILE="${SIM_DC_RESPONSE_KEY_FILE:-${keys}/response.private.pem}"
    export SIM_DC_PG_ADMIN_URL SIM_DC_TRUSTED_KEYS_FILE SIM_DC_TRUSTED_KEYS_FILE_MASKED SIM_DC_RESPONSE_KEY_FILE
}

# 程式（含 node_modules）安裝在 sim/.run/dc/app（各實例共用）：repo 可能以唯讀掛載（sim/docker-compose.yml），
# 而且建置產物一律放 .run。
sim_dc_app_dir() {
    printf '%s/app\n' "$(sim_run_dir "$SIM_DC_NAME")"
}
