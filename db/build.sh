#!/usr/bin/env bash
# 從頭建置開發與測試用的資料庫並跑資料庫測試。
# 用法：db/build.sh                  建置資料庫測試用（sgn_test）與端對端用（sgn_e2e）的資料庫，跑資料庫測試
#       db/build.sh --no-test        只建置
#       db/build.sh --bench          另外建置效能比較用的資料庫並跑效能量測（約數分鐘）
#       db/build.sh --plpgsql-check  只建置 sgn_test 的 schema，跑 plpgsql_check 靜態分析（tools/check.sh 用）
# 前提：PostgreSQL 16 在跑；sim 的 ldap、idp 在跑（sim/up.sh）；根目錄已 npm ci。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source=sgn.env
source "$here/sgn.env"

mode=full
run_bench=0
for arg in "$@"; do
    case "$arg" in
        --bench) run_bench=1 ;;
        --no-test) mode=no-test ;;
        --plpgsql-check) mode=plpgsql-check ;;
        *) echo "未知參數：$arg" >&2; exit 64 ;;
    esac
done

log() { printf '[db] %s\n' "$*"; }
admin_url_for() { local db="$1"; printf '%s' "${SGN_PG_ADMIN_URL%/*}/$db"; }
psql_admin() { local db="$1"; shift; psql -X -q -v ON_ERROR_STOP=1 "$(admin_url_for "$db")" "$@"; }

login_roles=("$SGN_ROLE_APP" "$SGN_ROLE_SYNC" "$SGN_ROLE_JOB" "$SGN_ROLE_TEST_VERIFIER")

recreate_roles() {
    local db role
    for db in "$SGN_DB_TEST" "$SGN_DB_E2E" "$SGN_DB_BENCH"; do
        psql_admin postgres -c "drop database if exists \"$db\" with (force)"
    done
    for role in "${login_roles[@]}" "$SGN_ROLE_OWNER"; do
        psql_admin postgres -c "drop role if exists \"$role\""
    done
    psql_admin postgres -c "create role \"$SGN_ROLE_OWNER\" nologin"
    for role in "${login_roles[@]}"; do
        psql_admin postgres -c "create role \"$role\" login password '${SGN_ROLE_PASSWORD_PREFIX}${role}'"
    done
}

# 建一個資料庫的 schema：核心 migration（依版本序）→ 各流程包（依版本序）→ 測試資料庫另加 db/testing/ → 權限 → 環境設定。
# 套用順序依骨幹第 1.1 節：核心全部 → 各流程包。90_grants.sql 帶變數，最後單獨套用。
build_schema() {
    local db="$1" with_testing="$2" connect="$SGN_ROLE_APP\", \"$SGN_ROLE_SYNC\", \"$SGN_ROLE_JOB"
    (( with_testing )) && connect="$connect\", \"$SGN_ROLE_TEST_VERIFIER"
    psql_admin postgres -c "create database \"$db\" owner \"$SGN_ROLE_OWNER\""
    psql_admin "$db" -c "revoke all on database \"$db\" from public" -c "grant connect on database \"$db\" to \"$connect\""
    # 01_core 建立 schema；pgcrypto 要以 superuser 裝進 sgn_internal，其餘 migration 以 owner 身分套用。
    local args=(-c "set role \"$SGN_ROLE_OWNER\"" -f "$here/kernel/01_core.sql" -c "reset role"
        -c "create extension pgcrypto schema sgn_internal" -c "set role \"$SGN_ROLE_OWNER\"")
    local file
    while IFS= read -r file; do
        args+=(-f "$file")
    done < <(migration_files)
    if (( with_testing )); then
        for file in "$here"/testing/*.sql; do
            args+=(-v verifier="$SGN_ROLE_TEST_VERIFIER" -f "$file")
        done
    fi
    args+=(-c "reset role" -v owner="$SGN_ROLE_OWNER" -v app="$SGN_ROLE_APP" -v sync="$SGN_ROLE_SYNC" -v job="$SGN_ROLE_JOB" -f "$here/kernel/90_grants.sql")
    psql_admin "$db" "${args[@]}" >/dev/null
    psql_admin "$db" -c "set role \"$SGN_ROLE_OWNER\"" \
        -c "select sgn_internal.register_setting_value('webauthn.rp_id', 'global', to_jsonb('$SGN_RP_ID'::text), 'db/build.sh：開發環境')" \
        -c "select sgn_internal.register_setting_value('webauthn.origin', 'global', to_jsonb('$SGN_RP_ORIGIN'::text), 'db/build.sh：開發環境')" >/dev/null
}

# 核心（不含 01_core 與 90_grants）與各流程包的 migration，各自依檔名的版本序。
migration_files() {
    find "$here/kernel" -maxdepth 1 -name '*.sql' ! -name '01_core.sql' ! -name '90_grants.sql' | sort -V
    local pack
    for pack in "$here"/packs/*/; do
        find "$pack" -maxdepth 1 -name '*.sql' | sort -V
    done
}

# 示範與驗收用的種子資料（db/seed/，不進正式環境）：要在人員同步之後，才對得到人。
load_seed() {
    local db="$1" file args=(-c "set role \"$SGN_ROLE_OWNER\"")
    while IFS= read -r file; do
        args+=(-f "$file")
    done < <(find "$here/seed" -name '*.sql' | sort -V)
    psql_admin "$db" "${args[@]}" >/dev/null
}

# 登記身分提供者的公開金鑰，並從 LDAP 做第一次（基準）同步。
seed_from_sim() {
    local db="$1"
    node "$here/tools/idp-keys-sql.mjs" | psql_admin "$db" -c "set role \"$SGN_ROLE_OWNER\"" -f -
    SGN_DATABASE="$db" node "$here/tools/directory-sync.mjs" >/dev/null
}

# plpgsql_check 只裝在測試資料庫，在獨立的 schema，任何登入角色都沒有 USAGE。
run_plpgsql_check() {
    local db="$1"
    psql_admin "$db" -c "create schema plpgsql_check" -c "create extension plpgsql_check schema plpgsql_check"
    local report
    report="$(psql_admin "$db" -t -A -f "$here/tools/plpgsql-check.sql")"
    if [[ -n "$report" ]]; then
        printf '%s\n' "$report" >&2
        echo "plpgsql_check 發現問題" >&2
        return 1
    fi
    log "plpgsql_check：沒有問題（$(psql_admin "$db" -t -A -c "select count(*) from pg_proc p join pg_language l on l.oid = p.prolang where l.lanname = 'plpgsql' and (p.pronamespace::regnamespace::text in ('sgn_internal', 'sgn_sdk', 'api', 'api_sync', 'api_job', 'api_verified') or p.pronamespace::regnamespace::text like 'pack\\_%')") 個 PL/pgSQL function）"
}

log "檢查 PostgreSQL"
if ! psql -X -q "$SGN_PG_ADMIN_URL" -c 'select 1' >/dev/null 2>&1; then
    pg_ctlcluster 16 main start
fi
[[ -d "$repo/node_modules/pg" ]] || { echo "缺少套件，請先在根目錄 npm ci" >&2; exit 1; }

log "重建資料庫與角色"
recreate_roles

if [[ "$mode" == plpgsql-check ]]; then
    build_schema "$SGN_DB_TEST" 1
    run_plpgsql_check "$SGN_DB_TEST"
    exit 0
fi

log "檢查 sim（ldap、idp）"
"$repo/sim/status.sh" --strict ldap idp >/dev/null || { echo "sim 沒有在跑，請先 sim/up.sh" >&2; exit 1; }

mkdir -p "$repo/.run"
for db in "$SGN_DB_TEST" "$SGN_DB_E2E"; do
    log "建置 $db"
    with_testing=0
    [[ "$db" == "$SGN_DB_TEST" ]] && with_testing=1
    build_schema "$db" "$with_testing"
    seed_from_sim "$db"
    load_seed "$db"
    rm -f "$repo/.run/anchors-$db.jsonl"
done

if (( run_bench )); then
    log "比較用的效能資料庫（plpython3u，不在執行路徑）"
    psql_admin postgres -c "create database \"$SGN_DB_BENCH\""
    psql_admin "$SGN_DB_BENCH" -c "create schema sgn_internal" -c "create extension pgcrypto schema sgn_internal" \
        -f "$here/kernel/02_crypto_bignum.sql" -f "$here/kernel/03_crypto_es256.sql" -f "$here/kernel/04_crypto_rs256_jwt.sql" \
        -f "$here/bench/plpython.sql"
fi

if [[ "$mode" == full ]]; then
    log "檢查每個規則代碼都有測試"
    SGN_DATABASE="$SGN_DB_TEST" node "$here/tools/rule-coverage.mjs"
    log "跑資料庫測試（$SGN_DB_TEST）"
    (cd "$here" && SGN_DATABASE="$SGN_DB_TEST" node --test --test-concurrency=1 "tests/kernel/*.test.mjs" "tests/packs/*/*.test.mjs")
fi
if (( run_bench )); then
    log "效能量測"
    (cd "$here" && SGN_DATABASE="$SGN_DB_TEST" node bench/verify-bench.mjs)
fi
log "完成"
