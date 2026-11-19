#!/usr/bin/env bash
# 對執行中的 sim/idp 走完一次真正的登入（authorization code flow），驗證 ID token 並印出 claims。
# 用法：login-check.sh <uid 或 email> [密碼]
#   不給密碼就用 sim 的測試密碼。
# 結束代碼：0＝成功；2＝帳號或密碼被拒絕（例如離職停用）；1＝其他錯誤。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

[[ "$#" -ge 1 && "$#" -le 2 ]] || sim_die "用法：login-check.sh <uid 或 email> [密碼]"
sim_require_cmd node
sim_idp_load_env

exec node "${here}/login-check.mjs" "$1" "${2:-$SIM_LDAP_USER_PASSWORD}"
