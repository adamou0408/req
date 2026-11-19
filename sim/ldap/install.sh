#!/usr/bin/env bash
# 確認 OpenLDAP 伺服器與用戶端工具已安裝；沒有而且是 root 時，用 apt 安裝。
# 只用套件裡的執行檔：sim 有自己的設定與資料目錄，不使用也不修改 /etc/ldap 的系統實例。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

readonly COMMANDS=(slapd slappasswd ldapsearch ldapadd ldapmodify ldapwhoami)

missing=false
for cmd in "${COMMANDS[@]}"; do
    command -v "$cmd" >/dev/null 2>&1 || missing=true
done
[[ "$missing" == true ]] || exit 0

if [[ "$EUID" -ne 0 ]] || ! command -v apt-get >/dev/null 2>&1; then
    sim_die "需要 OpenLDAP：請安裝 slapd 與 ldap-utils（Debian/Ubuntu：sudo apt-get install slapd ldap-utils）"
fi

sim_log "安裝 slapd 與 ldap-utils"
install_log="$(sim_run_dir "$SIM_LDAP_NAME")/install.log"
{
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y slapd ldap-utils
} >"$install_log" 2>&1 || sim_die "安裝失敗，請看 ${install_log}"
sim_require_cmd "${COMMANDS[@]}"
