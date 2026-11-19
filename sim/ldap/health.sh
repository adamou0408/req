#!/usr/bin/env bash
# 健康檢查：用唯讀服務帳號查得到種子文件裡的每一個人。健康回 0。
# 人數由種子文件算出，不寫死；離職是停用帳號而不是刪除，所以人數不會因異動而改變。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

sim_ldap_load_env

expected="$(node "${here}/seed-ldif.mjs" people-count)"
found="$(sim_ldap_search_as_reader "$SIM_LDAP_PEOPLE_DN" -s one '(objectClass=inetOrgPerson)' 1.1 |
    grep -c '^dn:' || true)"

if [[ "$found" != "$expected" ]]; then
    sim_log "${SIM_LDAP_NAME} 不健康：查到 ${found} 人，應為 ${expected} 人"
    exit 1
fi
