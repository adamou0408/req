#!/usr/bin/env bash
# 一支指令跑完全部測試：模擬環境 → 建庫與資料庫測試 → 通行金鑰對照組 → 錨定程式與後端 → 端對端測試。
# 用法：tools/run-all.sh            全部跑完後停掉後端與錨定程式
#       tools/run-all.sh --keep     跑完後讓後端與錨定程式繼續跑（可以用瀏覽器開 http://localhost:3000 試）
# 前提：根目錄已 npm ci（tools/check.sh 會做）；PostgreSQL 16；全域的 Playwright 瀏覽器在 /opt/pw-browsers。
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run="$repo/.run"
keep=0
[[ "${1:-}" == "--keep" ]] && keep=1
mkdir -p "$run"
# shellcheck source=../db/sgn.env
source "$repo/db/sgn.env"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"

log() { printf '[run-all] %s\n' "$*"; }

stop_bg() {
    local name
    for name in api anchor; do
        if [[ -f "$run/$name.pid" ]]; then
            kill -CONT "$(cat "$run/$name.pid")" 2>/dev/null || true
            kill "$(cat "$run/$name.pid")" 2>/dev/null || true
            rm -f "$run/$name.pid"
        fi
    done
}

stop_bg
if (( ! keep )); then trap stop_bg EXIT; fi

log "1/6 模擬環境（ldap、idp）"
"$repo/sim/up.sh" ldap idp

log "2/6 建置資料庫（$SGN_DB_TEST、$SGN_DB_E2E）並跑資料庫測試"
"$repo/db/build.sh"

log "3/6 通行金鑰的 Node 對照組（e2e/reference/passkey，不在執行路徑）"
(cd "$repo/e2e/reference/passkey" && FRONTDOOR_PORT=0 node --test --test-concurrency=1 passkey.test.ts vectors.test.ts)

log "4/6 錨定程式（每 2 秒把 $SGN_DB_E2E 的鏈頭寫到資料庫以外）"
SGN_DATABASE="$SGN_DB_E2E" node "$repo/db/tools/anchor.mjs" --every 2 >"$run/anchor.log" 2>&1 &
echo $! >"$run/anchor.pid"

log "5/6 後端（連 $SGN_DB_E2E）"
SGN_DATABASE="$SGN_DB_E2E" node "$repo/api/src/server.ts" >"$run/api.log" 2>&1 &
echo $! >"$run/api.pid"
for _ in $(seq 1 50); do
    curl -fsS -o /dev/null "$SGN_RP_ORIGIN/" 2>/dev/null && break
    sleep 0.2
done
curl -fsS -o /dev/null "$SGN_RP_ORIGIN/" || { cat "$run/api.log"; exit 1; }

log "6/6 端對端測試（Playwright，390px）"
SGN_DATABASE="$SGN_DB_E2E" node --test --test-concurrency=1 "$repo/e2e/tests/"*.test.mjs

log "量到的數字：$run/e2e-results.json、$run/wycheproof-results.json"
if (( keep )); then log "後端與錨定程式仍在跑；停止：kill \$(cat $run/api.pid) \$(cat $run/anchor.pid)"; fi
log "完成"
