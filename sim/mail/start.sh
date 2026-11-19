#!/usr/bin/env bash
# 啟動模擬郵件伺服器（Mailpit）。已經在跑就不重啟。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=sim/lib/common.sh
source "${here}/../lib/common.sh"

readonly NAME=mail

if sim_pid_alive "$NAME"; then
    sim_log "${NAME} 已經在執行（pid $(<"$(sim_pid_file "$NAME")")）"
    exit 0
fi

sim_load_env "$NAME"
"${here}/install.sh"
sim_require_port_free "$SIM_MAIL_SMTP_HOST" "$SIM_MAIL_SMTP_PORT"
sim_require_port_free "$SIM_MAIL_HTTP_HOST" "$SIM_MAIL_HTTP_PORT"

run_dir="$(sim_run_dir "$NAME")"
# --smtp-auth-accept-any：平台的 SMTP adapter 不論有沒有帶帳密都能寄，帳密路徑也測得到。
# --smtp-auth-allow-insecure：sim 不設 TLS，允許在明文連線上做 AUTH。
# --disable-version-check：不對外連線查新版。
sim_start_daemon "$NAME" "$NAME" "${run_dir}/bin/mailpit" \
    --smtp "${SIM_MAIL_SMTP_HOST}:${SIM_MAIL_SMTP_PORT}" \
    --listen "${SIM_MAIL_HTTP_HOST}:${SIM_MAIL_HTTP_PORT}" \
    --database "${run_dir}/mailpit.db" \
    --smtp-auth-accept-any \
    --smtp-auth-allow-insecure \
    --disable-version-check

waited=0
until "${here}/health.sh" >/dev/null 2>&1; do
    sim_pid_alive "$NAME" || sim_die "${NAME} 啟動後就結束了，請看 $(sim_log_file "$NAME")"
    [[ "$waited" -lt 100 ]] || sim_die "${NAME} 20 秒內沒有就緒，請看 $(sim_log_file "$NAME")"
    sleep 0.2
    waited=$((waited + 1))
done
sim_log "${NAME} 已啟動：SMTP ${SIM_MAIL_SMTP_HOST}:${SIM_MAIL_SMTP_PORT}，信箱 http://${SIM_MAIL_HTTP_HOST}:${SIM_MAIL_HTTP_PORT}/"
