#!/usr/bin/env bash
# 啟動模擬的人員目錄（OpenLDAP）。已經在跑就不重啟。
# 資料目錄是空的時候，從 docs/contract/seed-directory.md 產生種子資料並載入。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

if sim_pid_alive "$SIM_LDAP_NAME"; then
    sim_log "${SIM_LDAP_NAME} 已經在執行（pid $(<"$(sim_pid_file "$SIM_LDAP_NAME")")）"
    exit 0
fi

sim_ldap_load_env
"${here}/install.sh"
sim_require_cmd node
sim_require_port_free "$SIM_LDAP_HOST" "$SIM_LDAP_PORT"

run_dir="$(sim_run_dir "$SIM_LDAP_NAME")"
data_dir="${run_dir}/data"
config_file="${run_dir}/slapd.conf"
log_file="$(sim_log_file "$SIM_LDAP_NAME")"
mkdir -p "$data_dir"

# 設定檔每次啟動重新產生：路徑與位址都來自 service.env，不留第二份。
render_config() {
    cat <<CONF
include /etc/ldap/schema/core.schema
include /etc/ldap/schema/cosine.schema
include /etc/ldap/schema/inetorgperson.schema
include ${here}/sim.schema

modulepath /usr/lib/ldap
moduleload back_mdb
moduleload memberof
moduleload ppolicy

password-hash {SSHA}

database mdb
suffix "${SIM_LDAP_BASE_DN}"
rootdn "${SIM_LDAP_ADMIN_DN}"
rootpw $(slappasswd -s "$SIM_LDAP_ADMIN_PASSWORD")
directory ${data_dir}
maxsize 67108864
index objectClass,uid,mail,member,memberOf,simLoginName eq

# 群組成員變動時自動維護人員的 memberOf，查一個人屬於哪些群組不必掃全部群組。
overlay memberof
memberof-group-oc groupOfNames
memberof-member-ad member
memberof-memberof-ad memberOf

# 密碼政策：用 pwdAccountLockedTime 停用帳號（離職）；種子的明文密碼寫入時自動雜湊。
overlay ppolicy
ppolicy_default "cn=default,ou=policies,${SIM_LDAP_BASE_DN}"
ppolicy_hash_cleartext

# 密碼只能拿來驗證；目錄內容只有服務帳號與本人讀得到，匿名查不到任何資料。
access to attrs=userPassword
    by anonymous auth
    by * none
access to *
    by dn.exact="${SIM_LDAP_READER_DN}" read
    by self read
    by anonymous auth
    by * none
CONF
}

seed_directory() {
    local seed_file="${run_dir}/seed.ldif"
    sim_log "載入種子資料（來源：docs/contract/seed-directory.md）"
    node "${here}/seed-ldif.mjs" ldif >"$seed_file"
    sim_ldap_as_admin ldapadd -f "$seed_file" >>"$log_file" 2>&1
}

abort_start() {
    sim_stop_daemon "$SIM_LDAP_NAME"
    sim_die "$1"
}

render_config >"$config_file"
chmod 600 "$config_file"
sim_start_daemon "$SIM_LDAP_NAME" "$SIM_LDAP_NAME" slapd -d stats \
    -f "$config_file" -h "ldap://${SIM_LDAP_HOST}:${SIM_LDAP_PORT}/"

sim_wait_port "$SIM_LDAP_HOST" "$SIM_LDAP_PORT" 20 || abort_start "slapd 沒有開始接受連線，請看 ${log_file}"
sim_pid_alive "$SIM_LDAP_NAME" || sim_die "slapd 啟動後就結束了，請看 ${log_file}"

# 以「根節點是否存在」判斷要不要載入種子；32 是 LDAP 的 noSuchObject。
base_status=0
sim_ldap_as_admin ldapsearch -LLL -b "$SIM_LDAP_BASE_DN" -s base dn >/dev/null 2>&1 || base_status=$?
case "$base_status" in
    0) ;;
    32)
        if ! seed_directory; then
            # 載入一半的資料不能留著，否則下次啟動會被當成已經載入。
            sim_stop_daemon "$SIM_LDAP_NAME"
            rm -rf "$data_dir"
            sim_die "種子資料載入失敗，資料目錄已清除，請看 ${log_file}"
        fi
        ;;
    *) abort_start "無法以管理者身分查詢目錄（ldapsearch 回傳 ${base_status}），請看 ${log_file}" ;;
esac

"${here}/health.sh" || abort_start "健康檢查沒有通過，請看 ${log_file}"
sim_log "${SIM_LDAP_NAME} 已啟動：${SIM_LDAP_URL}（base DN ${SIM_LDAP_BASE_DN}）"
