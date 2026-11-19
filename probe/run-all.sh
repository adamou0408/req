#!/usr/bin/env bash
# 一支指令：啟動模擬環境 → 建置資料庫（含資料庫測試）→ 後端型別檢查 → 啟動錨定程式與後端 → 跑端對端測試。
# 用法：probe/run-all.sh            全部跑完後停掉後端與錨定程式
#       probe/run-all.sh --keep     跑完後讓後端與錨定程式繼續跑（可以用瀏覽器開 http://localhost:3000 試）
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
run="$here/.run"
keep=0
[[ "${1:-}" == "--keep" ]] && keep=1
mkdir -p "$run"

log() { printf '[probe] %s\n' "$*"; }

stop_bg() {
    local name
    for name in api anchor; do
        if [[ -f "$run/$name.pid" ]]; then
            kill "$(cat "$run/$name.pid")" 2>/dev/null || true
            rm -f "$run/$name.pid"
        fi
    done
}

stop_bg
if (( ! keep )); then trap stop_bg EXIT; fi

log "1/6 模擬環境（ldap、idp）"
"$repo/sim/up.sh" ldap idp

log "2/6 建置資料庫並跑資料庫測試，再重建一次乾淨的資料庫給端對端測試用"
"$repo/probe/db/build.sh"
# 資料庫測試會留下測試資料（例如主管已登記的軟體通行金鑰）；端對端從乾淨狀態開始。
"$repo/probe/db/build.sh" --no-test

log "3/6 後端：安裝套件與型別檢查"
(cd "$here/api" && npm ci --silent --no-audit --no-fund && npx tsc --noEmit -p .)

log "4/6 錨定程式（每 2 秒把鏈頭寫到資料庫以外）"
node "$here/db/tools/anchor.mjs" --every 2 >"$run/anchor.log" 2>&1 &
echo $! >"$run/anchor.pid"

log "5/6 後端"
node "$here/api/src/server.ts" >"$run/api.log" 2>&1 &
echo $! >"$run/api.pid"
for _ in $(seq 1 50); do
    curl -fsS -o /dev/null http://localhost:3000/ 2>/dev/null && break
    sleep 0.2
done
curl -fsS -o /dev/null http://localhost:3000/ || { cat "$run/api.log"; exit 1; }

log "6/6 端對端測試（Playwright，390px）"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}" \
    node --test --test-concurrency=1 "$here/e2e/tests/"*.test.mjs

log "量到的數字：$run/e2e-results.json"
if (( keep )); then log "後端與錨定程式仍在跑；停止：kill \$(cat $run/api.pid) \$(cat $run/anchor.pid)"; fi
log "完成"
