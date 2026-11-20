#!/usr/bin/env bash
# 從頭建置開發與測試用的資料庫並跑資料庫測試。
# 用法：db/build.sh                  建置資料庫測試用（sgn_test）與端對端用（sgn_e2e）的資料庫，跑資料庫測試
#       db/build.sh --no-test        只建置
#       db/build.sh --bench          另外建置效能比較用的資料庫並跑效能量測（約數分鐘）
#       db/build.sh --plpgsql-check  只建置 sgn_test 的 schema，跑 plpgsql_check 靜態分析（tools/check.sh 用）
# 前提：PostgreSQL 16 在跑；sim 的 ldap、idp、mail 在跑（sim/up.sh）；根目錄已 npm ci；以 root 執行（各程式的作業系統帳號與密鑰檔）。
# sim/dc 的兩個實例（main：sgn_e2e；unit：sgn_test）由這裡啟動並重新啟動（信任清單要先更新）。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source=sgn.env
source "$here/sgn.env"
# shellcheck source=admin.env
source "$here/admin.env"

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

# 登入角色（sgn.env 的鍵名後綴）。每次建置每個角色一組新的隨機密碼（裁決 D81 (1)），寫在只有 root 讀得到的 .run/secrets/roles.env；
# 各程式只拿到自己那一份（db/tools/provision-secrets.mjs）。
login_keys=(APP SYNC SCHEDULER RECONCILER ANCHOR MAILER DELIVERY IDP_KEYS TEST_VERIFIER)
# 已移除的合併角色（裁決 D86 (4)）：舊建置留下的一併刪掉，之後不再建立（架構測試 12 斷言它不存在）
retired_roles=(sgn_job)
secrets_dir="$repo/.run/secrets"

role_of() { local var="SGN_ROLE_$1"; printf '%s' "${!var}"; }

recreate_roles() {
    local db key password roles_file
    for db in "$SGN_DB_TEST" "$SGN_DB_E2E" "$SGN_DB_BENCH"; do
        psql_admin postgres -c "drop database if exists \"$db\" with (force)"
    done
    for key in "${login_keys[@]}" OWNER; do
        psql_admin postgres -c "drop role if exists \"$(role_of "$key")\""
    done
    for key in "${retired_roles[@]}"; do
        psql_admin postgres -c "drop role if exists \"$key\""
    done
    psql_admin postgres -c "create role \"$SGN_ROLE_OWNER\" nologin"
    rm -rf "$secrets_dir"
    mkdir -p "$secrets_dir"
    chmod 711 "$secrets_dir"
    roles_file="$secrets_dir/roles.env"
    (umask 077 && printf '# 自動產生（db/build.sh），請勿手動修改。只有 root 讀得到；各程式只拿到自己的那一份。\n' >"$roles_file")
    for key in "${login_keys[@]}"; do
        password="$(openssl rand -hex 24)"
        psql_admin postgres -c "create role \"$(role_of "$key")\" login password '$password'"
        printf 'SGN_ROLE_PASSWORD_%s=%s\n' "$key" "$password" >>"$roles_file"
    done
}

# 建一個資料庫的 schema：核心 migration（依版本序）→ 各流程包（依版本序）→ 測試資料庫另加 db/testing/ → 權限
# （90_grants.sql，再由 db/tools/grants-sql.mjs 收斂成路由表的允許清單）→ 環境設定。新建的 function 預設不對 PUBLIC 開放。
# 套用順序依骨幹第 1.1 節：核心全部 → 各流程包。90_grants.sql 帶變數，最後單獨套用。
build_schema() {
    local db="$1" with_testing="$2" connect="$SGN_ROLE_APP\", \"$SGN_ROLE_SYNC\", \"$SGN_ROLE_SCHEDULER\", \"$SGN_ROLE_RECONCILER\", \"$SGN_ROLE_ANCHOR\", \"$SGN_ROLE_MAILER\", \"$SGN_ROLE_DELIVERY\", \"$SGN_ROLE_IDP_KEYS"
    (( with_testing )) && connect="$connect\", \"$SGN_ROLE_TEST_VERIFIER"
    psql_admin postgres -c "create database \"$db\" owner \"$SGN_ROLE_OWNER\""
    psql_admin "$db" -c "revoke all on database \"$db\" from public" -c "grant connect on database \"$db\" to \"$connect\"" \
        -c "alter default privileges for role \"$SGN_ROLE_OWNER\" revoke execute on functions from public"
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
    # 90_grants.sql 的 :"job" 原本是合併角色；它已移除（D86 (4)），這裡傳排程角色。api_job 的執行權限隨即由 grants-sql.mjs
    # 全部撤掉、再依四張允許清單逐一授權（12 檢查完全相等），所以這一步多給的不會留下。
    args+=(-c "reset role" -v owner="$SGN_ROLE_OWNER" -v app="$SGN_ROLE_APP" -v sync="$SGN_ROLE_SYNC" -v job="$SGN_ROLE_SCHEDULER" -f "$here/kernel/90_grants.sql")
    psql_admin "$db" "${args[@]}" >/dev/null
    # 執行權限的允許清單（來源是路由表）：取代 90_grants.sql 的「整個 schema 授權」（紅隊 高-2）
    node "$here/tools/grants-sql.mjs" | psql_admin "$db" -f - >/dev/null
    psql_admin "$db" -c "set role \"$SGN_ROLE_OWNER\"" \
        -c "select sgn_internal.register_setting_value('webauthn.rp_id', 'global', to_jsonb('$SGN_RP_ID'::text), 'db/build.sh：開發環境')" \
        -c "select sgn_internal.register_setting_value('webauthn.origin', 'global', to_jsonb('$SGN_WEB_ORIGIN'::text), 'db/build.sh：開發環境（頁面的 origin）')" \
        -c "select sgn_internal.register_setting_value('audit.anchor_max_lag_seconds', 'global', to_jsonb(30), 'db/build.sh：開發環境每 2 秒錨定一次')" \
        -c "select sgn_internal.signing_key_create('sgn-$db')" >/dev/null
}

# 外部系統（sim/dc）的兩個實例：main 給 sgn_e2e、unit 給 sgn_test（各自的資料庫、角色、金鑰與信任清單，單號互不影響）。
# 第一次啟動時實例產生自己的密鑰（start.sh），之後才能發給平台的程式。
start_dc() {
    local instance
    for instance in main unit; do
        SIM_DC_INSTANCE="$instance" "$repo/sim/dc/start.sh" >/dev/null
    done
}

# 互相登記金鑰（db/tools/delivery-keys.mjs）：實例只信任對應資料庫目前那一把，資料庫只信任實例目前的回應金鑰；
# 重新啟動並清空實例，讓它讀新的信任清單。
trust_dc() {
    local instance
    node "$here/tools/delivery-keys.mjs" "$SGN_DB_TEST" "$SGN_DB_E2E"
    for instance in main unit; do
        SIM_DC_INSTANCE="$instance" "$repo/sim/dc/stop.sh" >/dev/null
        SIM_DC_INSTANCE="$instance" "$repo/sim/dc/start.sh" --reset >/dev/null
    done
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
    log "plpgsql_check：沒有問題（$(psql_admin "$db" -t -A -c "select count(*) from pg_proc p join pg_language l on l.oid = p.prolang where l.lanname = 'plpgsql' and (p.pronamespace::regnamespace::text in ('sgn_internal', 'sgn_sdk', 'api', 'api_sync', 'api_job', 'api_delivery', 'api_idp', 'api_verified') or p.pronamespace::regnamespace::text like 'pack\\_%')") 個 PL/pgSQL function）"
}

# 管理者連線只限本機 peer（裁決 D84 (1)）：以作業系統帳號 postgres（peer）建立和本程序帳號同名的 superuser 角色（db/admin.env），
# 清掉所有 superuser 的密碼（環境原有的帳號 das_dev 的密碼是已知值），並在 pg_hba.conf 最前面拒絕 superuser 經 TCP 登入。
# 新增的 superuser 下一次建置時一併處理；架構測試 97 以後端帳號實際試連。
hba_begin='# >>> sgn：superuser 只限本機 peer（db/build.sh 寫入，請勿手動修改）'
hba_end='# <<< sgn'
secure_admin() {
    local admin superusers hba
    admin="$(id -un)"
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 -d postgres -v admin="$admin" >/dev/null <<'SQL'
select format('create role %I superuser login', :'admin') where not exists (select 1 from pg_roles where rolname = :'admin') \gexec
select format('alter role %I with password null', rolname) from pg_authid where rolsuper and rolpassword is not null \gexec
SQL
    superusers="$(runuser -u postgres -- psql -X -q -t -A -d postgres -c "select string_agg(quote_ident(rolname), ',' order by rolname) from pg_roles where rolsuper")"
    hba="$(runuser -u postgres -- psql -X -q -t -A -d postgres -c 'show hba_file')"
    {
        printf '%s\n' "$hba_begin"
        printf 'host all %s all reject\n' "$superusers"
        printf '%s\n' "$hba_end"
        sed "/^${hba_begin//\//\\/}\$/,/^${hba_end}\$/d" "$hba"
    } >"$hba.sgn-new"
    cat "$hba.sgn-new" >"$hba"
    rm -f "$hba.sgn-new"
    runuser -u postgres -- psql -X -q -t -A -d postgres -c 'select pg_reload_conf()' >/dev/null
}

log "檢查 PostgreSQL"
(( EUID == 0 )) || { echo "db/build.sh 要以 root 執行（管理者連線是 root 的本機 peer；各程式的作業系統帳號）" >&2; exit 1; }
if ! pg_ctlcluster 16 main status >/dev/null 2>&1; then
    pg_ctlcluster 16 main start
fi
secure_admin
chmod 600 "$here/admin.env"
[[ -d "$repo/node_modules/pg" ]] || { echo "缺少套件，請先在根目錄 npm ci" >&2; exit 1; }

log "重建資料庫與角色"
recreate_roles

if [[ "$mode" == plpgsql-check ]]; then
    build_schema "$SGN_DB_TEST" 1
    run_plpgsql_check "$SGN_DB_TEST"
    exit 0
fi

log "檢查 sim（ldap、idp、mail）"
"$repo/sim/status.sh" --strict ldap idp mail >/dev/null || { echo "sim 沒有在跑，請先 sim/up.sh" >&2; exit 1; }

mkdir -p "$repo/.run"
chmod 711 "$repo/.run"
log "sim/dc 的兩個實例（main、unit）"
start_dc
for db in "$SGN_DB_TEST" "$SGN_DB_E2E"; do
    log "建置 $db"
    with_testing=0
    [[ "$db" == "$SGN_DB_TEST" ]] && with_testing=1
    build_schema "$db" "$with_testing"
    seed_from_sim "$db"
    load_seed "$db"
    SGN_DATABASE="$db" node "$here/tools/bootstrap-registrar.mjs" >/dev/null
    # 測試的舊金鑰（db/tests/kernel/lib/harness.mjs）只對這一次建置的資料庫有效
    rm -f "$repo/.run/anchors-$db.jsonl" "$repo/.run/passkeys-$db.json"
done
log "sim/dc 與兩個資料庫互相登記金鑰，並清空 sim/dc"
trust_dc
log "發給各程式自己的密鑰（作業系統帳號與 .run/secrets/）"
node "$here/tools/provision-secrets.mjs" >/dev/null

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
