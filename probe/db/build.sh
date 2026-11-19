#!/usr/bin/env bash
# 從頭建置探針資料庫並跑完全部測試。
# 用法：probe/db/build.sh            建置 + 同步目錄 + 測試
#       probe/db/build.sh --bench    另外跑效能量測（約數分鐘）
#       probe/db/build.sh --no-test  只建置
# 前提：PostgreSQL 16 在跑；sim 的 ldap、idp 在跑（sim/up.sh）；npm 套件已裝（本腳本會 npm ci）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# shellcheck source=probe.env
source "$here/probe.env"

run_tests=1
run_bench=0
for arg in "$@"; do
    case "$arg" in
        --bench) run_bench=1 ;;
        --no-test) run_tests=0 ;;
        *) echo "未知參數：$arg" >&2; exit 64 ;;
    esac
done

log() { printf '[probe-db] %s\n' "$*"; }
admin_url_for() { local db="$1"; printf '%s' "${PROBE_PG_ADMIN_URL%/*}/$db"; }
psql_admin() { local db="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 "$(admin_url_for "$db")" "$@"; }

log "檢查 PostgreSQL"
if ! psql -X -q "$PROBE_PG_ADMIN_URL" -c 'select 1' >/dev/null 2>&1; then
    pg_ctlcluster 16 main start
fi
log "檢查 sim（ldap、idp）"
"$repo/sim/status.sh" --strict ldap idp >/dev/null || { echo "sim 沒有在跑，請先 sim/up.sh" >&2; exit 1; }

log "npm ci"
(cd "$here" && npm ci --silent --no-audit --no-fund)

log "重建資料庫與角色"
for db in "$PROBE_DB" "$PROBE_BENCH_DB"; do
    psql_admin postgres -c "drop database if exists \"$db\" with (force)"
done
for role in "$PROBE_ROLE_APP" "$PROBE_ROLE_VERIFIER" "$PROBE_ROLE_SYNC" "$PROBE_ROLE_ANCHOR" "$PROBE_ROLE_OWNER"; do
    psql_admin postgres -c "drop role if exists \"$role\""
done
psql_admin postgres -c "create role \"$PROBE_ROLE_OWNER\" nologin"
for role in "$PROBE_ROLE_APP" "$PROBE_ROLE_VERIFIER" "$PROBE_ROLE_SYNC" "$PROBE_ROLE_ANCHOR"; do
    psql_admin postgres -c "create role \"$role\" login password '${PROBE_ROLE_PASSWORD_PREFIX}${role}'"
done
psql_admin postgres -c "create database \"$PROBE_DB\" owner \"$PROBE_ROLE_OWNER\""
psql_admin "$PROBE_DB" \
    -c "revoke all on database \"$PROBE_DB\" from public" \
    -c "grant connect on database \"$PROBE_DB\" to \"$PROBE_ROLE_APP\", \"$PROBE_ROLE_VERIFIER\", \"$PROBE_ROLE_SYNC\", \"$PROBE_ROLE_ANCHOR\""

log "套用 SQL（以 owner 身分）"
migrations=(01_core 02_crypto_bignum 03_crypto_es256 04_crypto_rs256_jwt 10_audit_chain 20_directory 30_identity 40_case 50_decide 60_audit_query 70_path)
args=(-c "set role \"$PROBE_ROLE_OWNER\"")
for m in "${migrations[@]}"; do
    [[ "$m" == 02_crypto_bignum ]] && args+=(-c "reset role" -c "create extension pgcrypto schema sgn_crypto" -c "set role \"$PROBE_ROLE_OWNER\"")
    args+=(-f "$here/sql/$m.sql")
done
psql_admin "$PROBE_DB" "${args[@]}"
psql_admin "$PROBE_DB" -v owner="$PROBE_ROLE_OWNER" -v app="$PROBE_ROLE_APP" -v verifier="$PROBE_ROLE_VERIFIER" \
    -v sync="$PROBE_ROLE_SYNC" -v anchor="$PROBE_ROLE_ANCHOR" -f "$here/sql/90_grants.sql"

log "設定 WebAuthn relying party"
psql_admin "$PROBE_DB" \
    -c "update sgn.setting set value = to_jsonb('$PROBE_RP_ID'::text) where key = 'webauthn.rp_id'" \
    -c "update sgn.setting set value = to_jsonb('$PROBE_RP_ORIGIN'::text) where key = 'webauthn.origin'"

log "登記身分提供者的公開金鑰"
node "$here/tools/idp-keys-sql.mjs" | psql_admin "$PROBE_DB" -c "set role \"$PROBE_ROLE_OWNER\"" -f -

log "從 LDAP 同步人員目錄"
node "$here/tools/directory-sync.mjs"

log "比較用的效能資料庫（plpython3u，不在執行路徑）"
psql_admin postgres -c "create database \"$PROBE_BENCH_DB\""
psql_admin "$PROBE_BENCH_DB" -c "create schema sgn_crypto" -c "create extension pgcrypto schema sgn_crypto" \
    -f "$here/sql/02_crypto_bignum.sql" -f "$here/sql/03_crypto_es256.sql" -f "$here/sql/04_crypto_rs256_jwt.sql" \
    -f "$here/bench/plpython.sql"

mkdir -p "$here/.run"
rm -f "$PROBE_ANCHOR_FILE"

if (( run_tests )); then
    log "檢查每個規則代碼都有測試"
    node "$here/tools/rule-coverage.mjs"
    log "跑測試"
    (cd "$here" && node --test --test-concurrency=1 "test/*.test.mjs")
fi
if (( run_bench )); then
    log "效能量測"
    (cd "$here" && node bench/verify-bench.mjs)
fi
log "完成"
