#!/usr/bin/env bash
# sim/idp 的腳本共用：載入本服務與 LDAP 的設定、測試用密碼。

# LDAP 的連線設定與唯讀帳號由 sim/ldap 提供，這裡不重複定義。
# shellcheck source=SCRIPTDIR/../ldap/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../ldap/lib.sh"

readonly SIM_IDP_NAME=idp

# client secret：第一次啟動時隨機產生（裁決 D84 (1)）。目錄（含 Dex 的私鑰 dex.db）與檔案都只有 root 讀得到；
# 後端拿到的是 db/tools/provision-secrets.mjs 抄進它自己密鑰檔的那一份。
sim_idp_ensure_secrets() {
    local dir file
    dir="$(sim_run_dir "$SIM_IDP_NAME")"
    chmod 700 "$dir"
    file="${dir}/secrets.env"
    [[ -f "$file" ]] && return 0
    (
        printf '# 自動產生（sim/idp/start.sh），請勿手動修改。只有 root 讀得到。\n'
        printf 'SIM_IDP_CLIENT_SECRET=%s\n' "$(openssl rand -hex 24)"
    ) >"$file.new"
    chmod 600 "$file.new"
    mv "$file.new" "$file"
}

sim_idp_load_env() {
    sim_ldap_load_env
    sim_load_env "$SIM_IDP_NAME"
    local file
    file="$(sim_run_dir "$SIM_IDP_NAME")/secrets.env"
    [[ -f "$file" ]] || sim_die "沒有 ${file}：先執行 sim/idp/start.sh"
    set -a
    # shellcheck source=/dev/null
    source "$file"
    set +a
}
