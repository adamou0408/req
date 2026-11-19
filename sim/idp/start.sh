#!/usr/bin/env bash
# 啟動模擬的 OIDC 身分提供者（Dex），帳號與群組來自 sim/ldap。已經在跑就不重啟。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

if sim_pid_alive "$SIM_IDP_NAME"; then
    sim_log "${SIM_IDP_NAME} 已經在執行（pid $(<"$(sim_pid_file "$SIM_IDP_NAME")")）"
    exit 0
fi

sim_idp_load_env
"${here}/install.sh"
sim_require_cmd curl jq
sim_require_port_free "$SIM_IDP_HOST" "$SIM_IDP_PORT"
"$(sim_service_dir "$SIM_LDAP_NAME")/health.sh" ||
    sim_die "sim/ldap 沒有就緒；請用 sim/up.sh idp（會先啟動 ldap），或先執行 sim/ldap/start.sh"

run_dir="$(sim_run_dir "$SIM_IDP_NAME")"
config_file="${run_dir}/config.yaml"
log_file="$(sim_log_file "$SIM_IDP_NAME")"

# 設定檔每次啟動重新產生：位址、client、LDAP 連線都來自各自的 service.env，不留第二份。
render_config() {
    local uri
    cat <<CONF
issuer: "${SIM_IDP_ISSUER}"
storage:
  # 簽章金鑰與登入狀態存在檔案裡，重啟後已發出的 token 仍驗得過。
  type: sqlite3
  config:
    file: "${run_dir}/dex.db"
web:
  http: "${SIM_IDP_HOST}:${SIM_IDP_PORT}"
logger:
  level: info
  format: text
frontend:
  issuer: "sgn sim IdP"
oauth2:
  responseTypes: ["code"]
  # 只有一個 client 而且是自家平台，不需要使用者再按一次同意。
  skipApprovalScreen: true
enablePasswordDB: false
staticClients:
  - id: "${SIM_IDP_CLIENT_ID}"
    name: "sgn platform backend (sim)"
    secret: "${SIM_IDP_CLIENT_SECRET}"
    redirectURIs:
CONF
    for uri in $SIM_IDP_CLIENT_REDIRECT_URIS; do
        printf '      - "%s"\n' "$uri"
    done
    cat <<CONF
connectors:
  - type: ldap
    id: ldap
    name: "sim LDAP"
    config:
      host: "${SIM_LDAP_HOST}:${SIM_LDAP_PORT}"
      insecureNoSSL: true
      bindDN: "${SIM_LDAP_READER_DN}"
      bindPW: "${SIM_LDAP_READER_PASSWORD}"
      usernamePrompt: "uid 或 email"
      userSearch:
        baseDN: "${SIM_LDAP_PEOPLE_DN}"
        # 離職停用的人即使還有未過期的 refresh token，也換不到新的 token。
        filter: "(&(objectClass=inetOrgPerson)(!(employeeType=terminated)))"
        # simLoginName 同時有 uid 與 email，兩種都能登入（見 sim/ldap/sim.schema）。
        username: simLoginName
        idAttr: uid
        emailAttr: mail
        nameAttr: cn
        preferredUsernameAttr: uid
      groupSearch:
        baseDN: "${SIM_LDAP_GROUPS_DN}"
        filter: "(objectClass=groupOfNames)"
        userMatchers:
          - userAttr: DN
            groupAttr: member
        nameAttr: cn
CONF
}

(umask 077 && render_config >"$config_file")
sim_start_daemon "$SIM_IDP_NAME" "$SIM_IDP_NAME" "${run_dir}/bin/dex" serve "$config_file"

waited=0
until "${here}/health.sh" >/dev/null 2>&1; do
    sim_pid_alive "$SIM_IDP_NAME" || sim_die "${SIM_IDP_NAME} 啟動後就結束了，請看 ${log_file}"
    if [[ "$waited" -ge 100 ]]; then
        sim_stop_daemon "$SIM_IDP_NAME"
        sim_die "${SIM_IDP_NAME} 20 秒內沒有就緒，請看 ${log_file}"
    fi
    sleep 0.2
    waited=$((waited + 1))
done
sim_log "${SIM_IDP_NAME} 已啟動：issuer ${SIM_IDP_ISSUER}"
