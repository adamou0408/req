#!/usr/bin/env bash
# sim/dc 的檢查：型別檢查，然後跑 tests/ 的測試。
# 測試啟動自己的一份服務：資料庫 sim_dc_check、sim_dc_check_test，角色前綴 simdc_t_，
# 聽 unix socket（不占用 7001），所以開發用的 sim/dc 在跑也不受影響。
# 用法：sim/dc/test.sh [要跑的測試檔...]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

sim_dc_load_env
"${here}/install.sh"
app="$(sim_dc_app_dir)"
test_dir="$(sim_run_dir "$SIM_DC_NAME")/test"
mkdir -p "$test_dir"

export SIM_DC_DB=sim_dc_check
export SIM_DC_DB_MASKED=sim_dc_check_test
export SIM_DC_ROLE_PREFIX=simdc_t_p_
export SIM_DC_MASKED_ROLE_PREFIX=simdc_t_m_p_
export SIM_DC_SANDBOX_ROLE=simdc_t_m_sandbox
export SIM_DC_SOCKET="${test_dir}/dc.sock"
export SIM_DC_TEST_DIR="$test_dir"
export SIM_DC_TRUSTED_KEYS_FILE="${test_dir}/keys/trusted-keys.json"
export SIM_DC_ENABLE_BACKDOOR=1
SIM_DC_REPO_ROOT="$(cd "${here}/../.." && pwd)"
export SIM_DC_REPO_ROOT

cd "$app"
node src/cli.ts keygen "${test_dir}/keys" test-platform
npx --no-install tsc -p tsconfig.json
if [[ $# -gt 0 ]]; then
    node --test --test-concurrency=1 "$@"
else
    node --test --test-concurrency=1 "tests/*.test.ts"
fi
