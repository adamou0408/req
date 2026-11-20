-- 流程定義（骨幹第 2 節 01d、第 6 節、第 7 節）：流程類型、級別、hook、簽核路徑與關卡。
-- 路徑是資料：每一關宣告 resolver 種類、模式（one／all）、適用的級別。核心不認得任何流程包的概念，
-- 領域判斷一律經由流程包登記的 hook（簽章由 sgn.hook_definition 固定，登記時檢查）。

create table sgn.process_type (
    code text primary key check (code ~ '^[a-z][a-z0-9_]*$' and code not like 'sys\_%'),
    name text not null,
    pack text not null,
    -- 骨幹第 3 節的選項；核心用到的鍵：uses_principal、has_validity、overlap_check、requires_fulfilment
    options jsonb not null,
    -- hook 名稱 → 函式（regprocedure 的文字）
    hooks jsonb not null,
    registered_at timestamptz not null
);

create table sgn.process_tier (
    process_type text not null references sgn.process_type (code),
    tier_code text not null,
    name text not null,
    sort_order int not null,
    primary key (process_type, tier_code),
    unique (process_type, sort_order)
);

-- 核心呼叫流程包 hook 的固定介面（骨幹 6.4 的子集；這一版用到的六個）。
create table sgn.hook_definition (
    hook text primary key,
    arg_types text not null,
    result_type text not null,
    returns_set boolean not null,
    description text not null
);

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('normalize_content', 'jsonb', 'jsonb', false,
        '整理內容：回傳 {content, notices: [{code, message}], errors: [{path, code, message}]}。沒有登記：原樣、沒有提示與錯誤'),
    ('classify_tier', 'jsonb', 'text', false, '判定級別：回傳級別代碼。沒有登記：排序最低的級別'),
    ('compare_content', 'jsonb, jsonb', 'text', false,
        '比較舊版與新版內容：same、reduce、expand。沒有登記：內容不同一律 expand'),
    ('find_overlaps', 'uuid, jsonb', 'jsonb', false,
        '找重疊：回傳 {level: none／partial／covered, items: [...]}。沒有登記：none'),
    ('stage_scopes', 'text, jsonb', 'text', true, '這一關涉及的範圍（scope_ref）。沒有登記：沒有範圍'),
    ('build_fulfilment', 'uuid', 'jsonb', false, '產生交給外部系統的執行內容。沒有登記：{}');

create table sgn.approval_policy (
    id bigint generated always as identity primary key,
    process_type text not null references sgn.process_type (code),
    version int not null,
    -- 往上找到最頂層仍沒有合格的人時的最終決定者（角色代碼）；null＝停住並開例外（K-TOP-RESOLVER、K-RESOLVE-HALT）
    top_resolver_role text,
    definition jsonb not null,
    effective_from timestamptz not null,
    unique (process_type, version)
);

create table sgn.policy_stage (
    policy_id bigint not null references sgn.approval_policy (id),
    seq int not null,
    code text not null,
    name text not null,
    phase text not null check (phase in ('approval', 'fulfilment')),
    side text not null check (side in ('demand', 'control')),
    resolver_kind text not null
        check (resolver_kind in ('applicant_manager', 'role_holder', 'scoped_role', 'role_group_claim', 'system_custodian')),
    resolver_role text,
    mode text not null check (mode in ('one', 'all')),
    -- null＝全部級別；{"tier_in": [...]}
    applies_when jsonb,
    primary key (policy_id, seq),
    unique (policy_id, code),
    check ((resolver_kind = 'applicant_manager') = (resolver_role is null)),
    check (resolver_kind <> 'scoped_role' or mode = 'all'),
    check (resolver_kind not in ('role_group_claim', 'system_custodian', 'applicant_manager', 'role_holder') or mode = 'one')
);

-- ── 登記入口（流程包經 sgn_sdk 呼叫；可重複執行）──

create function sgn_internal.registration_fail(p_detail text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.raise_error('REGISTRATION_INVALID', p_detail);
end;
$$;

-- 檢查並轉換 hook：每個都必須是 sgn.hook_definition 裡的名稱，函式存在、參數與回傳型別相符。
create function sgn_internal.hooks_checked(p_hooks jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_hook text;
    v_fn text;
    v_def sgn.hook_definition;
    v_proc regprocedure;
    v_result jsonb := '{}'::jsonb;
begin
    for v_hook, v_fn in select key, value #>> '{}' from jsonb_each(coalesce(p_hooks, '{}'::jsonb)) loop
        select * into v_def from sgn.hook_definition where hook = v_hook;
        if v_def.hook is null then
            perform sgn_internal.registration_fail('unknown hook ' || v_hook);
        end if;
        v_proc := to_regprocedure(v_fn || '(' || v_def.arg_types || ')');
        if v_proc is null then
            perform sgn_internal.registration_fail(v_hook || ': ' || v_fn || '(' || v_def.arg_types || ') does not exist');
        end if;
        if not exists (
            select 1 from pg_proc as p
            where p.oid = v_proc
              and p.prorettype = v_def.result_type::regtype
              and p.proretset = v_def.returns_set
        ) then
            perform sgn_internal.registration_fail(v_hook || ': ' || v_fn || ' has the wrong result type');
        end if;
        v_result := v_result || jsonb_build_object(v_hook, v_proc::text);
    end loop;
    return v_result;
end;
$$;

-- p_def：{code, name, pack, options, tiers: [{code, name, sort_order}], hooks: {hook: "schema.function"}}
create function sgn_internal.register_process_type(p_def jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_code text := p_def ->> 'code';
    v_hooks jsonb := sgn_internal.hooks_checked(p_def -> 'hooks');
begin
    if jsonb_typeof(p_def -> 'tiers') is distinct from 'array' or jsonb_array_length(p_def -> 'tiers') = 0 then
        perform sgn_internal.registration_fail(v_code || ': tiers');
    end if;
    insert into sgn.process_type (code, name, pack, options, hooks, registered_at)
    values (v_code, p_def ->> 'name', p_def ->> 'pack', coalesce(p_def -> 'options', '{}'::jsonb), v_hooks, sgn_internal.now())
    on conflict (code) do update
    set name = excluded.name,
        pack = excluded.pack,
        options = excluded.options,
        hooks = excluded.hooks;
    delete from sgn.process_tier
    where process_type = v_code
      and tier_code not in (select t ->> 'code' from jsonb_array_elements(p_def -> 'tiers') as t);
    insert into sgn.process_tier (process_type, tier_code, name, sort_order)
    select v_code, t ->> 'code', t ->> 'name', (t ->> 'sort_order')::int
    from jsonb_array_elements(p_def -> 'tiers') as t
    on conflict (process_type, tier_code) do update
    set name = excluded.name,
        sort_order = excluded.sort_order;
end;
$$;

create function sgn_internal.policy_stage_checked(p_process_type text, p_stage jsonb)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_tier text;
begin
    if p_stage -> 'applies_when' is not null and jsonb_typeof(p_stage -> 'applies_when') <> 'null' then
        if jsonb_typeof(p_stage #> '{applies_when,tier_in}') is distinct from 'array' then
            perform sgn_internal.registration_fail(p_stage ->> 'code' || ': applies_when');
        end if;
        for v_tier in select jsonb_array_elements_text(p_stage #> '{applies_when,tier_in}') loop
            if not exists (select 1 from sgn.process_tier as t where t.process_type = p_process_type and t.tier_code = v_tier) then
                perform sgn_internal.registration_fail(p_stage ->> 'code' || ': unknown tier ' || v_tier);
            end if;
        end loop;
    end if;
end;
$$;

-- 新的路徑版本：定義和最新版不同時才新增一版（只增不改；送審時綁定當時的最新版）。
-- p_def：{top_resolver_role, stages: [{seq, code, name, phase, side, resolver: {kind, role}, mode, applies_when}]}
create function sgn_internal.register_approval_policy(p_process_type text, p_def jsonb)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_latest sgn.approval_policy;
    v_policy_id bigint;
    v_stage jsonb;
begin
    if not exists (select 1 from sgn.process_type where code = p_process_type) then
        perform sgn_internal.raise_error('PROCESS_UNKNOWN', p_process_type);
    end if;
    select * into v_latest from sgn.approval_policy
    where process_type = p_process_type
    order by version desc
    limit 1;
    if v_latest.definition = p_def then
        return;
    end if;
    if jsonb_typeof(p_def -> 'stages') is distinct from 'array' or jsonb_array_length(p_def -> 'stages') = 0 then
        perform sgn_internal.registration_fail(p_process_type || ': stages');
    end if;
    insert into sgn.approval_policy (process_type, version, top_resolver_role, definition, effective_from)
    values (p_process_type, coalesce(v_latest.version, 0) + 1, p_def ->> 'top_resolver_role', p_def, sgn_internal.now())
    returning id into v_policy_id;
    for v_stage in select * from jsonb_array_elements(p_def -> 'stages') loop
        perform sgn_internal.policy_stage_checked(p_process_type, v_stage);
        insert into sgn.policy_stage (policy_id, seq, code, name, phase, side, resolver_kind, resolver_role, mode, applies_when)
        values (
            v_policy_id,
            (v_stage ->> 'seq')::int,
            v_stage ->> 'code',
            v_stage ->> 'name',
            v_stage ->> 'phase',
            v_stage ->> 'side',
            v_stage #>> '{resolver,kind}',
            v_stage #>> '{resolver,role}',
            v_stage ->> 'mode',
            nullif(v_stage -> 'applies_when', 'null'::jsonb)
        );
    end loop;
end;
$$;

create function sgn_internal.policy_latest(p_process_type text)
returns sgn.approval_policy
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_policy sgn.approval_policy;
begin
    select * into v_policy from sgn.approval_policy
    where process_type = p_process_type and effective_from <= sgn_internal.now()
    order by version desc
    limit 1;
    if v_policy.id is null then
        perform sgn_internal.raise_error('POLICY_MISSING', p_process_type);
    end if;
    return v_policy;
end;
$$;

create function sgn_internal.process_option(p_process_type text, p_option text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce((select (t.options ->> p_option)::boolean from sgn.process_type as t where t.code = p_process_type), false)
$$;

create function sgn_internal.message_register(p_code text, p_kind text, p_message text, p_http_status int default null)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    insert into sgn.error_catalog (code, kind, message, http_status)
    values (p_code, p_kind, p_message, p_http_status)
    on conflict (code) do update
    set kind = excluded.kind,
        message = excluded.message,
        http_status = excluded.http_status;
end;
$$;

-- ── 呼叫 hook：每種 hook 一個入口；沒有登記時用骨幹 6.4 的預設行為 ──

create function sgn_internal.hook_fn(p_process_type text, p_hook text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select t.hooks ->> p_hook from sgn.process_type as t where t.code = p_process_type
$$;

create function sgn_internal.hook_normalize(p_process_type text, p_content jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'normalize_content');
    v_result jsonb;
begin
    if v_fn is null then
        return jsonb_build_object('content', p_content, 'notices', '[]'::jsonb, 'errors', '[]'::jsonb);
    end if;
    execute format('select %s($1)', v_fn::regprocedure::regproc) into v_result using p_content;
    return jsonb_build_object(
        'content', v_result -> 'content',
        'notices', coalesce(v_result -> 'notices', '[]'::jsonb),
        'errors', coalesce(v_result -> 'errors', '[]'::jsonb)
    );
end;
$$;

create function sgn_internal.hook_classify(p_process_type text, p_content jsonb)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'classify_tier');
    v_tier text;
begin
    if v_fn is not null then
        execute format('select %s($1)', v_fn::regprocedure::regproc) into v_tier using p_content;
    end if;
    if v_tier is null or not exists (
        select 1 from sgn.process_tier as t where t.process_type = p_process_type and t.tier_code = v_tier
    ) then
        -- 沒有登記，或 hook 回傳不認得的級別：沒有登記時取最低級別；回傳不認得的值時取最高級別（從嚴）
        select t.tier_code into v_tier
        from sgn.process_tier as t
        where t.process_type = p_process_type
        order by case when v_fn is null then t.sort_order else -t.sort_order end
        limit 1;
    end if;
    return v_tier;
end;
$$;

create function sgn_internal.hook_compare(p_process_type text, p_old jsonb, p_new jsonb)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'compare_content');
    v_result text;
begin
    if p_old = p_new then
        return 'same';
    end if;
    if v_fn is null then
        return 'expand';
    end if;
    execute format('select %s($1, $2)', v_fn::regprocedure::regproc) into v_result using p_old, p_new;
    -- 無法判定一律算擴大（K-CHANGE-EXPAND）
    return case when v_result in ('same', 'reduce') then v_result else 'expand' end;
end;
$$;

create function sgn_internal.hook_overlaps(p_process_type text, p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'find_overlaps');
    v_result jsonb;
begin
    if v_fn is null then
        return jsonb_build_object('level', 'none', 'items', '[]'::jsonb);
    end if;
    execute format('select %s($1, $2)', v_fn::regprocedure::regproc) into v_result using p_case_id, p_content;
    -- 回傳不認得的程度時當作部分重疊：要填理由、簽核人看得到，不會因此放行
    return jsonb_build_object(
        'level', case when v_result ->> 'level' in ('none', 'partial', 'covered') then v_result ->> 'level' else 'partial' end,
        'items', coalesce(v_result -> 'items', '[]'::jsonb)
    );
end;
$$;

create function sgn_internal.hook_stage_scopes(p_process_type text, p_stage_code text, p_content jsonb)
returns text[]
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'stage_scopes');
    v_scopes text[];
begin
    if v_fn is null then
        return '{}'::text[];
    end if;
    execute format('select coalesce(array_agg(s order by s), ''{}'') from (select distinct s from %s($1, $2) as s) as d', v_fn::regprocedure::regproc)
        into v_scopes using p_stage_code, p_content;
    return v_scopes;
end;
$$;

create function sgn_internal.hook_fulfilment(p_process_type text, p_case_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'build_fulfilment');
    v_result jsonb;
begin
    if v_fn is null then
        return '{}'::jsonb;
    end if;
    execute format('select %s($1)', v_fn::regprocedure::regproc) into v_result using p_case_id;
    return v_result;
end;
$$;
