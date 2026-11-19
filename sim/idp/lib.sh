#!/usr/bin/env bash
# sim/idp 的腳本共用：載入本服務與 LDAP 的設定、測試用密碼。

# LDAP 的連線設定與唯讀帳號由 sim/ldap 提供，這裡不重複定義。
# shellcheck source=SCRIPTDIR/../ldap/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../ldap/lib.sh"

readonly SIM_IDP_NAME=idp

sim_idp_load_env() {
    sim_ldap_load_env
    sim_load_env "$SIM_IDP_NAME"
    set -a
    # shellcheck source=/dev/null
    source "$(sim_service_dir "$SIM_IDP_NAME")/test-credentials.env"
    set +a
}
