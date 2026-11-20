#!/usr/bin/env bash
# 一支指令跑完全部測試：模擬環境 → 建庫（含 sim/dc 兩個實例的金鑰互相登記、各程式的密鑰）與資料庫測試 → 通行金鑰對照組 →
# 錨點存放處、錨定程式、排程、通知寄送、交付、對帳、身分提供者金鑰更新、後端與頁面 → 端對端測試。
# 頁面與後端分開來源（裁決 D68）：後端 $SGN_RP_ORIGIN 只回 JSON，頁面由另一個靜態伺服器 $SGN_WEB_ORIGIN 提供；
# 錨點存放處又是另一個來源 $SGN_ANCHOR_ORIGIN（裁決 D81 (4)）。
# 每個背景程式以自己的作業系統帳號執行、只讀得到自己的密鑰檔（裁決 D81 (1)；db/tools/lib/programs.mjs），所以要以 root 執行。
# 用法：tools/run-all.sh            全部跑完後停掉背景程式
#       tools/run-all.sh --keep     跑完後讓背景程式繼續跑（可以用瀏覽器開 http://localhost:3001 試）
# 前提：根目錄已 npm ci（tools/check.sh 會做）；PostgreSQL 16；全域的 Playwright 瀏覽器在 /opt/pw-browsers；root。
set -euo pipefail
(( EUID == 0 )) || { echo "tools/run-all.sh 要以 root 執行（各程式以自己的作業系統帳號啟動）" >&2; exit 1; }

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run="$repo/.run"
keep=0
[[ "${1:-}" == "--keep" ]] && keep=1
mkdir -p "$run"
chmod 711 "$run"
# shellcheck source=../db/sgn.env
source "$repo/db/sgn.env"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

log() { printf '[run-all] %s\n' "$*"; }

stop_bg() {
    local name
    for name in api anchor anchor-store jobs mailer delivery reconciler idp-keys web; do
        # 先停監看（否則它會把程式重新啟動），再停程式
        if [[ -f "$run/$name.supervisor.pid" ]]; then
            kill "$(cat "$run/$name.supervisor.pid")" 2>/dev/null || true
            rm -f "$run/$name.supervisor.pid"
        fi
        if [[ -f "$run/$name.pid" ]]; then
            kill -CONT "$(cat "$run/$name.pid")" 2>/dev/null || true
            kill "$(cat "$run/$name.pid")" 2>/dev/null || true
            rm -f "$run/$name.pid"
        fi
    done
}

stop_bg
if (( ! keep )); then trap stop_bg EXIT; fi

log "1/6 模擬環境（ldap、idp、mail；dc 由 db/build.sh 在建好資料庫、更新信任清單之後啟動）"
"$repo/sim/up.sh" ldap idp mail

log "2/6 建置資料庫（$SGN_DB_TEST、$SGN_DB_E2E）並跑資料庫測試"
"$repo/db/build.sh"

log "3/6 通行金鑰的 Node 對照組（e2e/reference/passkey，不在執行路徑）"
(cd "$repo/e2e/reference/passkey" && FRONTDOOR_PORT=0 node --test --test-concurrency=1 passkey.test.ts vectors.test.ts)

# 以程式自己的作業系統帳號（sgn-<程式>）啟動，環境變數只留 PATH 與要連的資料庫；log 與 pid 檔由 root 寫，log 只有 root 讀得到。
# 監看（裁決 D84 (7)）：程式結束（例如錨定程式遇到不一致、被殺掉）就在 1 秒後以同一個帳號重新啟動，並在 log 記下結束碼；
# $name.pid 一律是目前那個程式的 pid（暫停、恢復都對它），$name.supervisor.pid 是監看本身。
supervise() {
    local name="$1" status
    shift
    while :; do
        setpriv --reuid "sgn-$name" --regid "sgn-$name" --clear-groups -- \
            env -i PATH="$PATH" SGN_DATABASE="$SGN_DB_E2E" node "$@" >>"$run/$name.log" 2>&1 &
        echo $! >"$run/$name.pid"
        status=0
        wait $! || status=$?
        printf '[run-all] %s 結束（結束碼 %s），1 秒後重新啟動\n' "$name" "$status" >>"$run/$name.log"
        sleep 1
    done
}

start_program() {
    local name="$1"
    shift
    rm -f "$run/$name.log"
    (umask 077 && : >"$run/$name.log")
    rm -f "$run/$name.pid"
    supervise "$name" "$@" &
    echo $! >"$run/$name.supervisor.pid"
    for _ in $(seq 1 50); do
        [[ -s "$run/$name.pid" ]] && break
        sleep 0.1
    done
}

log "4/6 錨點存放處（$SGN_ANCHOR_ORIGIN）與錨定程式（每 2 秒把 $SGN_DB_E2E 的鏈頭寫到存放處）"
start_program anchor-store "$repo/db/tools/anchor-store.mjs"
for _ in $(seq 1 50); do
    curl -fsS -o /dev/null "$SGN_ANCHOR_ORIGIN/anchors" 2>/dev/null && break
    sleep 0.2
done
start_program anchor "$repo/db/tools/anchor.mjs" --every 2

log "5/6 排程（每 60 秒）、通知寄送（每 5 秒，寄到 sim/mail）、交付（每秒，送到 sim/dc）、對帳（每 30 秒）、身分提供者金鑰（每 60 秒）、後端（連 $SGN_DB_E2E）、頁面"
start_program jobs "$repo/db/tools/jobs.mjs" --every 60
start_program mailer "$repo/api/src/mailer.ts" --every 5
# 交付程式（sgn_delivery，每秒一輪，送到 sim/dc）與對帳程式（sgn_job＋唯讀稽核金鑰，每 30 秒）：裁決 D63
start_program delivery "$repo/api/src/delivery.ts" --every 1
start_program reconciler "$repo/api/src/reconciler.ts" --every 30
start_program idp-keys "$repo/db/tools/idp-keys.mjs" --every 60
start_program api "$repo/api/src/server.ts"
start_program web "$repo/web/server.mjs"
for _ in $(seq 1 50); do
    curl -fsS -o /dev/null "$SGN_RP_ORIGIN/errors" 2>/dev/null && curl -fsS -o /dev/null "$SGN_WEB_ORIGIN/" 2>/dev/null && break
    sleep 0.2
done
curl -fsS -o /dev/null "$SGN_RP_ORIGIN/errors" || { cat "$run/api.log"; exit 1; }
curl -fsS -o /dev/null "$SGN_WEB_ORIGIN/" || { cat "$run/web.log"; exit 1; }

log "6/6 端對端測試（Playwright，390px）"
SGN_DATABASE="$SGN_DB_E2E" node --test --test-concurrency=1 "$repo/e2e/tests/"*.test.mjs

log "量到的數字：$run/e2e-results.json、$run/wycheproof-results.json"
if (( keep )); then log "背景程式仍在跑；停止：kill \$(cat $run/*.pid)"; fi
log "完成"
