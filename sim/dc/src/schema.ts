// 資料庫結構：資料表（schema data）、匯出用的檢視表（schema export，每個角色一個，見 exportView.ts）、
// 列層級安全用的判斷函式（schema simdc）、服務自己的紀錄（schema simdc_meta）。
// 被授權者角色只會拿到 data 的欄位權限、自己的匯出檢視表與 simdc 的 usage；simdc_meta 對它們不可見。

import { ident, lit } from './db.ts';
import { PACKAGES, ROW_ID, type ColumnType } from './catalog.ts';

// 結構改變時加一：啟動時發現版本不同，就整個重建（只是模擬資料，重建即可）。
export const SCHEMA_VERSION = 4;

const SQL_TYPE: Record<ColumnType, string> = { text: 'text', numeric: 'numeric', date: 'date' };

function tablesSql(): string[] {
    const out: string[] = [];
    for (const pkg of PACKAGES) {
        const cols = pkg.columns.map((c) => `${ident(c.code)} ${SQL_TYPE[c.type]}`).join(', ');
        out.push(`create table data.${ident(pkg.code)} (${ROW_ID} bigint generated always as identity primary key, ${cols})`);
        out.push(`alter table data.${ident(pkg.code)} enable row level security`);
        if (pkg.periodField !== null) {
            out.push(`create index on data.${ident(pkg.code)} (${ident(pkg.periodField)})`);
        }
    }
    return out;
}

// 列層級安全的判斷：每條規則是一個 policy，運算式是 simdc.rule_match('<規則的 JSON>', <這一列的條件欄位>)。
// 規則的 JSON 直接寫在 policy 運算式裡（系統目錄 pg_policy），對帳從那裡讀回，不靠服務自己的紀錄。
function functionsSql(serviceRole: string): string[] {
    return [
        // 查詢日期：只有服務自己的連線（測試查詢）可以用 simdc.as_of 指定，其他人一律是今天，
        // 否則被授權者可以自己 set simdc.as_of 把過期的授權變回有效。
        `create function simdc.as_of() returns date language sql stable set search_path = pg_catalog as $$
            select case
                when session_user = ${lit(serviceRole)} and coalesce(current_setting('simdc.as_of', true), '') <> ''
                    then current_setting('simdc.as_of')::date
                else current_date
            end
        $$`,
        // 一個條件對一個值是否成立。值不存在或是 null 一律不成立。
        `create function simdc.condition_holds(p_cond jsonb, p_value jsonb) returns boolean language sql immutable
            set search_path = pg_catalog as $$
            select case
                when p_value is null or jsonb_typeof(p_value) = 'null' then false
                when p_cond ->> 'op' = 'in' then (p_cond -> 'values') @> jsonb_build_array(p_value #>> '{}')
                when p_cond ->> 'op' = 'between' and p_cond ->> 'type' = 'number' then
                    (p_value #>> '{}')::numeric between coalesce((p_cond #>> '{values,0}')::numeric, '-Infinity')
                                                    and coalesce((p_cond #>> '{values,1}')::numeric, 'Infinity')
                when p_cond ->> 'op' = 'between' and p_cond ->> 'type' = 'date' then
                    (p_value #>> '{}')::date between coalesce((p_cond #>> '{values,0}')::date, '-infinity')
                                                 and coalesce((p_cond #>> '{values,1}')::date, 'infinity')
                else false
            end
        $$`,
        // 這一列為什麼看不到；看得到回 null。順序與 02 §8.5 的規則語意相同。
        `create function simdc.rule_reason(p_rule jsonb, p_row jsonb) returns text language sql stable
            set search_path = pg_catalog as $$
            select case
                when simdc.as_of() < (p_rule #>> '{valid,from}')::date then 'not_yet_valid'
                when simdc.as_of() > (p_rule #>> '{valid,to}')::date then 'expired'
                when exists (
                    select 1 from jsonb_array_elements(p_rule -> 'row_filter') as f
                    where not simdc.condition_holds(f, p_row -> (f ->> 'column'))
                ) then 'row_filter'
                when jsonb_typeof(p_rule -> 'data_period') = 'object' and not simdc.condition_holds(
                    jsonb_build_object('op', 'between', 'type', 'date', 'values',
                        jsonb_build_array(p_rule #> '{data_period,from}', p_rule #> '{data_period,to}')),
                    p_row -> (p_rule #>> '{data_period,field}')
                ) then 'data_period'
            end
        $$`,
        `create function simdc.rule_match(p_rule jsonb, p_row jsonb) returns boolean language sql stable
            set search_path = pg_catalog as $$
            select simdc.rule_reason(p_rule, p_row) is null
        $$`,
    ];
}

function metaSql(): string[] {
    return [
        `create table simdc_meta.schema_info (version int not null)`,
        // 服務收到並接受的規則（只是「收到什麼」的紀錄；實際權限以系統目錄為準，對帳不讀這張表）
        `create table simdc_meta.rule_set (
            case_no text primary key,
            case_version_no int not null,
            principal_id text not null,
            role_name text not null,
            body jsonb not null,
            body_sha256 text not null,
            key_id text not null,
            request_id text,
            status text not null check (status in ('applied', 'withdrawn')),
            withdrawn_rule_ids text[] not null default '{}',
            applied_at timestamptz not null,
            updated_at timestamptz not null
        )`,
        `create table simdc_meta.withdraw_request (
            request_id text primary key,
            case_no text not null,
            received_at timestamptz not null default now(),
            result jsonb not null
        )`,
        // 管理後門：讓某條規則「套用時被默默略過」，用來測試對帳抓不抓得到「核准未設定」
        `create table simdc_meta.sabotage (rule_id text primary key, created_at timestamptz not null default now())`,
        `create table simdc_meta.call_log (
            id bigint generated always as identity primary key,
            at timestamptz not null default now(),
            client text,
            method text not null,
            path text not null,
            status int not null,
            note text
        )`,
    ];
}

export const DROP_SCHEMAS_SQL = 'drop schema if exists data, export, simdc, simdc_meta cascade';

export function schemaSql(serviceRole: string): string[] {
    return [
        `revoke all on schema public from public`,
        `create schema data`,
        `create schema export`,
        `create schema simdc`,
        `create schema simdc_meta`,
        ...tablesSql(),
        ...functionsSql(serviceRole),
        ...metaSql(),
        `insert into simdc_meta.schema_info (version) values (${SCHEMA_VERSION})`,
    ];
}
