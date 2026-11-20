-- 參數改成「定義＋值」（工程規範第 2 節抽象層；骨幹第 8 節）、訊息目錄分種類、營業日。
-- 只新增，不改既有 migration（已套用到環境）：01_core.sql 的單一 sgn.setting 表由這裡取代並刪除，
-- setting_text、setting_int 以同樣的簽章改為讀新的定義與值。

-- ── 訊息目錄：錯誤之外，也放提示與檢查結果（只有錯誤有 HTTP 狀態）──

alter table sgn.error_catalog
    add column kind text not null default 'error' check (kind in ('error', 'notice', 'check'));

alter table sgn.error_catalog
    alter column http_status drop not null;

alter table sgn.error_catalog
    add constraint error_catalog_status_only_for_errors check ((kind = 'error') = (http_status is not null));

-- 訊息文字的唯一入口：依代碼取訊息，以 format() 代入參數（訊息裡的 %s、%1$s）。
create function sgn_internal.message_text(p_code text, p_args text[] default '{}')
returns text
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_message text;
begin
    select message into v_message from sgn.error_catalog where code = p_code;
    if v_message is null then
        raise exception 'UNKNOWN_MESSAGE_CODE: %', p_code;
    end if;
    return format(v_message, variadic p_args);
end;
$$;

-- ── 只增不改的資料表共用的觸發器（參數值、例外等）──

insert into sgn.error_catalog (code, message, http_status) values
    ('RECORD_APPEND_ONLY', '這筆紀錄只能新增，不能修改或刪除', 409),
    ('SETTING_UNKNOWN', '沒有這個參數', 500),
    ('SETTING_SCOPE_INVALID', '這個參數不能依這種範圍設定', 422);

create function sgn_internal.reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.raise_error('RECORD_APPEND_ONLY', tg_table_name || ' ' || tg_op);
    return null;
end;
$$;

-- ── 參數：定義（型別、預設值、可用的範圍種類）與值（帶範圍與生效時間，只增不改）──

create table sgn.setting_definition (
    key text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
    value_type text not null check (value_type in ('integer', 'boolean', 'text', 'json')),
    default_value jsonb not null,
    -- 可以設定值的範圍種類（scope_ref 的前綴），global 一律可以
    scope_kinds text[] not null default '{}',
    description text not null,
    pack text
);

create table sgn.setting_value (
    id bigint generated always as identity primary key,
    key text not null references sgn.setting_definition (key),
    -- global，或 <種類>:<代碼>（骨幹 1.2），例如 process:<流程類型>、tier:<流程類型>:<級別>
    scope_ref text not null,
    value jsonb not null,
    effective_from timestamptz not null,
    recorded_at timestamptz not null,
    reason text not null check (btrim(reason) <> '')
);

create index setting_value_lookup_idx on sgn.setting_value (key, scope_ref, effective_from desc, id desc);

create trigger setting_value_append_only
    before update or delete on sgn.setting_value
    for each row execute function sgn_internal.reject_change();

create trigger setting_value_no_truncate
    before truncate on sgn.setting_value
    for each statement execute function sgn_internal.reject_change();

-- 01_core 的值成為定義的預設值。
insert into sgn.setting_definition (key, value_type, default_value, description)
select
    s.key,
    case jsonb_typeof(s.value) when 'number' then 'integer' when 'boolean' then 'boolean' else 'text' end,
    s.value,
    s.description
from sgn.setting as s;

-- 讀參數的唯一入口：依「最具體的範圍 → 全域 → 預設值」取值；同一範圍取生效時間最晚且已生效的那一筆。
-- p_scopes 由呼叫者依最具體到最不具體排列。範圍種類不在定義允許之列的，略過。
create function sgn_internal.setting(p_key text, p_scopes text[] default '{}')
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_def sgn.setting_definition;
    v_now timestamptz := sgn_internal.now();
    v_scope text;
    v_value jsonb;
begin
    select * into v_def from sgn.setting_definition where key = p_key;
    if v_def.key is null then
        perform sgn_internal.raise_error('SETTING_UNKNOWN', p_key);
    end if;
    foreach v_scope in array p_scopes || array['global'] loop
        continue when v_scope <> 'global' and split_part(v_scope, ':', 1) <> all (v_def.scope_kinds);
        select v.value into v_value
        from sgn.setting_value as v
        where v.key = p_key
          and v.scope_ref = v_scope
          and v.effective_from <= v_now
        order by v.effective_from desc, v.id desc
        limit 1;
        if v_value is not null then
            return v_value;
        end if;
    end loop;
    return v_def.default_value;
end;
$$;

create or replace function sgn_internal.setting_text(p_key text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.setting(p_key) #>> '{}'
$$;

create or replace function sgn_internal.setting_int(p_key text)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (sgn_internal.setting(p_key) #>> '{}')::int
$$;

drop table sgn.setting;

-- 登記入口（流程包與部署腳本共用；可重複執行：定義相同時不動作）。
create function sgn_internal.register_setting_definition(
    p_key text,
    p_value_type text,
    p_default jsonb,
    p_scope_kinds text[],
    p_description text,
    p_pack text default null
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description, pack)
    values (p_key, p_value_type, p_default, p_scope_kinds, p_description, p_pack)
    on conflict (key) do update
    set value_type = excluded.value_type,
        default_value = excluded.default_value,
        scope_kinds = excluded.scope_kinds,
        description = excluded.description,
        pack = excluded.pack;
end;
$$;

-- 新增一筆參數值（立即生效）。和目前生效的值相同時不新增，所以可重複執行。
create function sgn_internal.register_setting_value(p_key text, p_scope_ref text, p_value jsonb, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_def sgn.setting_definition;
    v_now timestamptz := sgn_internal.now();
begin
    select * into v_def from sgn.setting_definition where key = p_key;
    if v_def.key is null then
        perform sgn_internal.raise_error('SETTING_UNKNOWN', p_key);
    end if;
    if p_scope_ref <> 'global' and split_part(p_scope_ref, ':', 1) <> all (v_def.scope_kinds) then
        perform sgn_internal.raise_error('SETTING_SCOPE_INVALID', p_key || ' @ ' || p_scope_ref);
    end if;
    if sgn_internal.setting(p_key, array[p_scope_ref]) = p_value
       and exists (select 1 from sgn.setting_value as v where v.key = p_key and v.scope_ref = p_scope_ref) then
        return;
    end if;
    insert into sgn.setting_value (key, scope_ref, value, effective_from, recorded_at, reason)
    values (p_key, p_scope_ref, p_value, v_now, v_now, p_reason);
end;
$$;

-- ── 營業日：週六、週日與登記的休假日不算 ──

create table sgn.calendar_holiday (
    day date primary key,
    description text not null
);

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('calendar.timezone', 'text', '"Asia/Taipei"', '{}', '計算「今天」與營業日所用的時區（IANA 名稱）');

-- 營業日期的唯一入口（骨幹 0.3 的 D1）。
create function sgn_internal.today()
returns date
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (sgn_internal.now() at time zone sgn_internal.setting_text('calendar.timezone'))::date
$$;

create function sgn_internal.is_workday(p_day date)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select extract(isodow from p_day) < 6
       and not exists (select 1 from sgn.calendar_holiday as h where h.day = p_day)
$$;

-- 從某個時間點往後數 p_days 個營業日，保留當地的時刻。例如週五 10:00 加 1 個營業日＝下週一 10:00。
create function sgn_internal.add_workdays(p_from timestamptz, p_days int)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_zone text := sgn_internal.setting_text('calendar.timezone');
    v_local timestamp := p_from at time zone v_zone;
    v_day date := v_local::date;
    v_left int := p_days;
begin
    if p_from is null or p_days is null then
        return null;
    end if;
    while v_left > 0 loop
        v_day := v_day + 1;
        if sgn_internal.is_workday(v_day) then
            v_left := v_left - 1;
        end if;
    end loop;
    return (v_day + v_local::time) at time zone v_zone;
end;
$$;
