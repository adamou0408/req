#!/usr/bin/env bash
# sim/ldap 的腳本（以及要連 LDAP 的 sim/idp）共用：載入設定與測試密碼、包裝 LDAP 用戶端指令。

# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

readonly SIM_LDAP_NAME=ldap
# slapd 裝在 /usr/sbin，非 root 的 PATH 不一定有。
PATH="${PATH}:/usr/sbin"

# 載入 service.env 與只供 sim 使用的測試密碼，並匯出給子行程。
sim_ldap_load_env() {
    sim_load_env "$SIM_LDAP_NAME"
    set -a
    # shellcheck source=/dev/null
    source "$(sim_service_dir "$SIM_LDAP_NAME")/test-credentials.env"
    set +a
}

# 以管理者身分執行 LDAP 用戶端指令。用法：sim_ldap_as_admin ldapmodify [參數...]
sim_ldap_as_admin() {
    local tool="$1"
    shift
    "$tool" -x -H "$SIM_LDAP_URL" -o nettimeout=5 \
        -D "$SIM_LDAP_ADMIN_DN" -w "$SIM_LDAP_ADMIN_PASSWORD" "$@"
}

# 以唯讀服務帳號查詢。用法：sim_ldap_search_as_reader <base> [ldapsearch 參數...]
sim_ldap_search_as_reader() {
    local base="$1"
    shift
    ldapsearch -x -LLL -o ldif-wrap=no -o nettimeout=5 -H "$SIM_LDAP_URL" \
        -D "$SIM_LDAP_READER_DN" -w "$SIM_LDAP_READER_PASSWORD" -b "$base" "$@"
}
