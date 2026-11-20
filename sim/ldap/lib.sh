#!/usr/bin/env bash
# sim/ldap 的腳本（以及要連 LDAP 的 sim/idp）共用：載入設定與測試密碼、包裝 LDAP 用戶端指令。

# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

readonly SIM_LDAP_NAME=ldap
# slapd 裝在 /usr/sbin，非 root 的 PATH 不一定有。
PATH="${PATH}:/usr/sbin"

# 密碼檔：第一次啟動時隨機產生（裁決 D84 (1)：沒有可用的已知密碼）。目錄與檔案都只有 root（slapd、Dex 與測試工具的帳號）讀得到；
# 平台的執行期程式（sgn-api 等）讀不到（架構測試 db/tests/kernel/97-reach）。
sim_ldap_secrets_file() {
    printf '%s/secrets.env\n' "$(sim_run_dir "$SIM_LDAP_NAME")"
}

# 沒有密碼檔就產生（回傳 0＝這次新產生，目錄裡的舊資料用的是別的密碼，要重新載入種子）；已經有就回傳 1。
sim_ldap_ensure_secrets() {
    local dir file
    dir="$(sim_run_dir "$SIM_LDAP_NAME")"
    chmod 700 "$dir"
    file="$(sim_ldap_secrets_file)"
    [[ -f "$file" ]] && return 1
    (
        printf '# 自動產生（sim/ldap/start.sh），請勿手動修改。只有 root 讀得到。\n'
        printf 'SIM_LDAP_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'SIM_LDAP_READER_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'SIM_LDAP_USER_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    ) >"$file.new"
    chmod 600 "$file.new"
    mv "$file.new" "$file"
    return 0
}

# 載入 service.env 與執行期產生的密碼，並匯出給子行程。
sim_ldap_load_env() {
    sim_load_env "$SIM_LDAP_NAME"
    local file
    file="$(sim_ldap_secrets_file)"
    [[ -f "$file" ]] || sim_die "沒有 ${file}：先執行 sim/ldap/start.sh"
    set -a
    # shellcheck source=/dev/null
    source "$file"
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
