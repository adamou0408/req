-- 紅隊第七輪 低-1（裁決 D88 (4)）：例外只有開立、沒有結案。K-GOVERNANCE-KEY 以「這個人歷來有沒有開過」去重，
-- 所以同一個人第二次出事不會再開；種子階段（還沒有人登記金鑰時）開的那幾筆，持有人登記了金鑰之後仍掛著「沒有金鑰」。
--   1. 例外加上結案（closed_at、closed_seq、結案依據）；結案的唯一入口 sgn_internal.exception_close，每一筆結案都進鏈。
--   2. K-GOVERNANCE-KEY、K-PASSKEY-SUSPEND-HOLDER 在狀況解除時結案：持有人有可用的通行金鑰了，或已不再持有那一類角色。
--      排程（governance_check）每一輪檢查；恢復停用的金鑰時當場檢查。種子階段留下的舊例外由同一個檢查結案（不另寫一套）。
--   3. 去重只看未結案的：結案之後同一個人再出事，會再開一筆。

alter table sgn.exception_record
    add column closed_at timestamptz,
    add column closed_seq bigint,
    add column close_detail jsonb;

create index exception_record_open_idx on sgn.exception_record (rule_code) where closed_at is null;

-- 結案的唯一入口：只結未結案的那一筆，進鏈（事件寫明規則代碼與結案依據）。已結案時不動作，回傳 false。
create function sgn_internal.exception_close(p_id bigint, p_detail jsonb)
returns boolean
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row sgn.exception_record;
    v_seq bigint;
begin
    select * into v_row from sgn.exception_record where id = p_id and closed_at is null for update;
    if v_row.id is null then
        return false;
    end if;
    v_seq := sgn_internal.audit_append('exception.closed', v_row.case_id, null, jsonb_build_object(
        'exception', v_row.id, 'rule_code', v_row.rule_code, 'detail', p_detail));
    update sgn.exception_record set closed_at = sgn_internal.now(), closed_seq = v_seq, close_detail = p_detail where id = p_id;
    return true;
end;
$$;

-- 這個規則代碼、這個人（detail.person）目前未結案的例外（去重用；沒有時為 null）。
create function sgn_internal.exception_open_for_person(p_rule_code text, p_person_id uuid)
returns bigint
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select min(x.id) from sgn.exception_record as x
    where x.rule_code = p_rule_code and x.closed_at is null and x.detail ->> 'person' = p_person_id::text
$$;

-- 持有人的金鑰例外還成不成立：K-GOVERNANCE-KEY 看治理類；K-PASSKEY-SUSPEND-HOLDER 看參數 passkey.suspend_exception_categories。
-- 成立＝仍持有那一類角色、而且沒有可用的通行金鑰。回傳結案依據；仍成立時為 null。
create function sgn_internal.holder_key_resolution(p_rule_code text, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when sgn_internal.passkey_usable_count(p_person_id) > 0
            then jsonb_build_object('resolved', 'usable_key', 'usable_keys', sgn_internal.passkey_usable_count(p_person_id))
        when sgn_internal.passkey_suspend_flagged_roles(
                 p_person_id,
                 case p_rule_code when 'K-GOVERNANCE-KEY' then '["governance"]'::jsonb
                      else sgn_internal.setting('passkey.suspend_exception_categories') end
             ) = '[]'::jsonb
            then jsonb_build_object('resolved', 'no_role')
    end
$$;

-- 狀況解除的持有人例外一律結案。p_person_id 為 null 時檢查全部。回傳結了幾筆。
create function sgn_internal.holder_key_exceptions_settle(p_person_id uuid default null)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row record;
    v_resolution jsonb;
    v_closed int := 0;
begin
    for v_row in
        select x.id, x.rule_code, (x.detail ->> 'person')::uuid as person_id
        from sgn.exception_record as x
        where x.rule_code in ('K-GOVERNANCE-KEY', 'K-PASSKEY-SUSPEND-HOLDER')
          and x.closed_at is null
          and (p_person_id is null or x.detail ->> 'person' = p_person_id::text)
        order by x.id
    loop
        v_resolution := sgn_internal.holder_key_resolution(v_row.rule_code, v_row.person_id);
        if v_resolution is not null and sgn_internal.exception_close(v_row.id, v_resolution || jsonb_build_object(
            'person', v_row.person_id, 'rules', jsonb_build_array(v_row.rule_code))) then
            v_closed := v_closed + 1;
        end if;
    end loop;
    return v_closed;
end;
$$;

-- 治理類持有人沒有可用金鑰就開例外（同 320 的簽章）：去重只看未結案的。
create or replace function sgn_internal.governance_key_check()
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_opened jsonb := '[]'::jsonb;
    v_holder record;
begin
    for v_holder in
        select h.person_id, jsonb_agg(h.role_code order by h.role_code) as roles
        from (
            select distinct x as person_id, g.code as role_code
            from sgn.role as g, unnest(sgn_internal.role_holders(g.code)) as x
            where g.category = 'governance'
        ) as h
        where sgn_internal.passkey_usable_count(h.person_id) = 0
          and sgn_internal.exception_open_for_person('K-GOVERNANCE-KEY', h.person_id) is null
        group by h.person_id
    loop
        v_opened := v_opened || to_jsonb(sgn_internal.exception_open('K-GOVERNANCE-KEY', null, jsonb_build_object(
            'kind', 'governance_holder_without_key', 'person', v_holder.person_id, 'roles', v_holder.roles
        )));
    end loop;
    return v_opened;
end;
$$;

-- 停用之後的例外與通知（同 510 的簽章）：兩種例外都只在這個人沒有未結案的同種例外時開（去重只看未結案的）。
create or replace function sgn_internal.passkey_suspend_flag(p_person_id uuid, p_suspension_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_categories jsonb := sgn_internal.setting('passkey.suspend_exception_categories');
    v_notify_roles jsonb := sgn_internal.setting('passkey.suspend_exception_notify_roles');
    v_roles jsonb := sgn_internal.passkey_suspend_flagged_roles(p_person_id, v_categories);
    v_governance jsonb;
    v_people uuid[];
begin
    if v_roles = '[]'::jsonb then
        return v_roles;
    end if;
    if sgn_internal.exception_open_for_person('K-PASSKEY-SUSPEND-HOLDER', p_person_id) is null then
        perform sgn_internal.exception_open('K-PASSKEY-SUSPEND-HOLDER', null, jsonb_build_object(
            'person', p_person_id, 'roles', v_roles, 'suspension', p_suspension_id,
            'settings', jsonb_build_object(
                'passkey.suspend_exception_categories', v_categories,
                'passkey.suspend_exception_notify_roles', v_notify_roles
            )
        ));
    end if;
    v_governance := (
        select coalesce(jsonb_agg(r -> 'code' order by r ->> 'code'), '[]'::jsonb)
        from jsonb_array_elements(v_roles) as r
        where r ->> 'category' = 'governance'
    );
    if v_governance <> '[]'::jsonb and sgn_internal.exception_open_for_person('K-GOVERNANCE-KEY', p_person_id) is null then
        perform sgn_internal.exception_open('K-GOVERNANCE-KEY', null, jsonb_build_object(
            'kind', 'governance_holder_suspended', 'person', p_person_id, 'roles', v_governance, 'suspension', p_suspension_id));
    end if;
    select coalesce(array_agg(distinct h), '{}') into v_people
    from jsonb_array_elements_text(v_notify_roles) as n (code)
    cross join lateral unnest(sgn_internal.role_holders(n.code)) as h
    where h <> p_person_id;
    perform sgn_internal.notify('passkey.holder_suspended', v_people, null, jsonb_build_object(
        'person_name', sgn_internal.person_name(p_person_id),
        'roles', (select string_agg(g.name, '、' order by g.code) from sgn.role as g
                  where g.code in (select r ->> 'code' from jsonb_array_elements(v_roles) as r))
    ));
    return v_roles;
end;
$$;

-- 全部例外（同 70 的簽章）：多了結案時間。
create or replace function api.audit_exceptions(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.authorize(sgn_internal.session_person(p_session), 'audit.read');
    return (
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', x.id,
            'rule_code', x.rule_code,
            'case_no', c.case_no,
            'opened_at', x.opened_at,
            'event_seq', x.event_seq,
            'closed_at', x.closed_at
        ) order by x.id), '[]'::jsonb)
        from sgn.exception_record x
        left join sgn.request_case c on c.id = x.case_id
    );
end;
$$;

comment on function api.audit_exceptions(text) is
    '全部例外與結案時間（狀況解除時結案的例外有 closed_at；裁決 D88 (4)），讓稽核人員不必知道單號也看得到。只限稽核角色，唯讀。'
    '呼叫者：sgn_app。規則：PRB-AUDIT-READ、PRB-SYNC-GUARD、K-EXCEPTION-CLOSE';

select sgn_internal.register_rule(
    'K-EXCEPTION-CLOSE',
    '例外在狀況解除時結案（裁決 D88 (4)）：結案只經 sgn_internal.exception_close，每一筆都進鏈並寫明依據；'
    'K-GOVERNANCE-KEY、K-PASSKEY-SUSPEND-HOLDER 在持有人有可用的通行金鑰或不再持有那一類角色時結案（排程每輪、恢復金鑰時當場）；'
    '這兩種例外的去重只看未結案的，同一個人第二次出事會再開',
    null,
    'partial',
    '其他例外代碼還沒有結案條件（人工覆核與結案的流程是核心尚未做的部分）'
);

select sgn_internal.register_rule(
    'K-PASSKEY-SUSPEND-HOLDER',
    '只憑登入停用通行金鑰時，當事人持有參數 passkey.suspend_exception_categories 所列類別的角色（預設控制類與治理類，'
    '依 sgn.role 的類別判斷，任何適用範圍都算；裁決 D86 (3)）就當場開例外，列出這些角色與用到的參數，'
    '並通知參數 passkey.suspend_exception_notify_roles 的角色持有人（不含當事人）；治理類的持有人另開 K-GOVERNANCE-KEY；'
    '持有人有可用的金鑰或不再持有那一類角色時結案，去重只看未結案的（K-EXCEPTION-CLOSE）',
    null,
    'full',
    null
);

select sgn_internal.register_rule(
    'K-GOVERNANCE-KEY',
    '治理類角色的持有人必須有可用的通行金鑰（否則冷卻期內擋不下任何變更）；沒有就開例外，排程與治理類變更進冷卻期時檢查；'
    '持有人有可用的金鑰或不再持有治理類角色時結案，去重只看未結案的（K-EXCEPTION-CLOSE）',
    null,
    'full',
    null
);
