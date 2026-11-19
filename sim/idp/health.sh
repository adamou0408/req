#!/usr/bin/env bash
# 健康檢查：discovery 文件的 issuer 正確，而且公開金鑰端點至少有一把簽章金鑰。健康回 0。
set -euo pipefail

# shellcheck source=SCRIPTDIR/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

sim_load_env "$SIM_IDP_NAME"

discovery="$(curl -fsS --max-time 3 "${SIM_IDP_ISSUER}/.well-known/openid-configuration")"
[[ "$(jq -r .issuer <<<"$discovery")" == "$SIM_IDP_ISSUER" ]]

keys="$(curl -fsS --max-time 3 "$(jq -r .jwks_uri <<<"$discovery")")"
[[ "$(jq '.keys | length' <<<"$keys")" -ge 1 ]]
