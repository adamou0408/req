#!/usr/bin/env bash
# 把程式複製到 sim/.run/dc/app，並依 package-lock.json 安裝套件（lock 沒變就不重裝）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib.sh
source "${here}/lib.sh"

sim_require_cmd node npm sha256sum
app="$(sim_dc_app_dir)"
mkdir -p "$app"

rm -rf "${app}/src" "${app}/tests"
cp -R "${here}/src" "${here}/tests" "$app/"
cp "${here}/package.json" "${here}/package-lock.json" "${here}/tsconfig.json" "${here}/.npmrc" "$app/"

stamp="${app}/.lock.sha256"
want="$(sha256sum "${here}/package-lock.json" | cut -d' ' -f1)"
if [[ -d "${app}/node_modules" && -f "$stamp" && "$(<"$stamp")" == "$want" ]]; then
    exit 0
fi
sim_log "安裝 sim/dc 的套件"
(cd "$app" && npm ci --ignore-scripts --no-audit >"${app}/install.log" 2>&1) ||
    sim_die "npm ci 失敗，請看 ${app}/install.log"
printf '%s\n' "$want" >"$stamp"
