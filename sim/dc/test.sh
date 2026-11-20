#!/usr/bin/env bash
# sim/dc 的檢查：型別檢查，然後跑 tests/ 的測試。
# 測試啟動自己的一份服務：資料庫 sim_dc_check、sim_dc_check_test，角色前綴 simdc_t_，
# 聽 unix socket（不占用 7001、7002），自己的密鑰與信任清單，所以開發用的 sim/dc 在跑也不受影響。
# 用法：sim/dc/test.sh [要跑的測試檔...]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

sim_dc_load_env
"${here}/install.sh"
app="$(sim_dc_app_dir)"
test_dir="$(sim_run_dir "$SIM_DC_NAME")/test"
rm -rf "${test_dir}/keys"
mkdir -p "$test_dir"

cd "$app"
# 測試實例自己的密鑰（服務密碼、呼叫方金鑰、回應證明）與兩個環境各一把平台金鑰
node src/cli.ts init-secrets "${test_dir}/keys"
node src/cli.ts keygen "${test_dir}/keys" test-platform
node src/cli.ts keygen "${test_dir}/keys" test-platform-masked
set -a
# shellcheck source=/dev/null
source "${test_dir}/keys/secrets.env"
set +a

export SIM_DC_DB=sim_dc_check
export SIM_DC_DB_MASKED=sim_dc_check_test
export SIM_DC_SERVICE_ROLE=simdc_t_service
export SIM_DC_ROLE_PREFIX=simdc_t_p_
export SIM_DC_MASKED_ROLE_PREFIX=simdc_t_m_p_
export SIM_DC_SANDBOX_ROLE=simdc_t_m_sandbox
export SIM_DC_SOCKET="${test_dir}/dc.sock"
export SIM_DC_TEST_DIR="$test_dir"
export SIM_DC_TRUSTED_KEYS_FILE="${test_dir}/keys/trusted-keys.json"
export SIM_DC_TRUSTED_KEYS_FILE_MASKED="${test_dir}/keys/trusted-keys-masked.json"
export SIM_DC_RESPONSE_KEY_FILE="${test_dir}/keys/response.private.pem"
export SIM_DC_ENABLE_BACKDOOR=1
SIM_DC_REPO_ROOT="$(cd "${here}/../.." && pwd)"
export SIM_DC_REPO_ROOT
node src/cli.ts trust "$SIM_DC_TRUSTED_KEYS_FILE" test-platform "${test_dir}/keys/test-platform.public.pem"
node src/cli.ts trust "$SIM_DC_TRUSTED_KEYS_FILE_MASKED" test-platform-masked "${test_dir}/keys/test-platform-masked.public.pem"

npx --no-install tsc -p tsconfig.json
if [[ $# -gt 0 ]]; then
    node --test --test-concurrency=1 "$@"
else
    node --test --test-concurrency=1 "tests/*.test.ts"
fi
