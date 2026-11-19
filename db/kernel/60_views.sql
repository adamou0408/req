-- 給畫面的查詢：「我是誰、能做什麼」、我的申請、待簽清單、錯誤目錄。
-- 由 packages/contract 的路由表直接對應；後端與前端不做任何業務判斷，按鈕與選單都依這裡回傳的清單。
-- 回傳結構固定（packages/contract/src/routes.ts；db/tests/kernel/90-contract.test.mjs 檢查）。
-- 規則：PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-AUDIT-READ

create function api.error_catalog()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        jsonb_agg(jsonb_build_object('code', e.code, 'message', e.message, 'http_status', e.http_status) order by e.code),
        '[]'::jsonb
    )
    from sgn.error_catalog e
$$;

comment on function api.error_catalog() is
    '錯誤代碼、訊息與 HTTP 狀態；後端啟動時讀一次。呼叫者：sgn_app（後端啟動）。規則：無（目錄）';

-- 畫面可以顯示的功能。audit 由授權入口判定；case.submit 與 inbox 是「有沒有東西可做」的提示，不是授權。
create function sgn_internal.person_capabilities(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select to_jsonb(array_remove(array[
        case when (sgn_internal.resolve_manager(p_person_id)).id is not null then 'case.submit' end,
        case when exists (
            select 1 from sgn.reporting_line r where r.manager_person_id = p_person_id and r.valid_to is null
        ) or exists (
            select 1 from sgn.request_case c where c.approver_person_id = p_person_id and c.state = 'submitted'
        ) then 'inbox' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null) is null then 'audit' end
    ], null))
$$;

create function api.me(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    return (
        select jsonb_build_object(
            'person_id', p.id,
            'name', p.display_name,
            'passkeys', (select count(*) from sgn.passkey_credential k where k.person_id = p.id),
            'capabilities', sgn_internal.person_capabilities(p.id)
        )
        from sgn.person p
        where p.id = v_person_id
    );
end;
$$;

comment on function api.me(text) is
    '目前登入的人：姓名、已登記的通行金鑰數、畫面可以顯示的功能（送審、待簽、稽核）。呼叫者：sgn_app。規則：PRB-APPROVER、PRB-AUDIT-READ';

create function api.case_list_mine(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    return coalesce((
        select jsonb_agg(sgn_internal.case_summary(c.id, v_person_id) order by c.case_no desc)
        from sgn.request_case c
        where c.applicant_person_id = v_person_id
    ), '[]'::jsonb);
end;
$$;

comment on function api.case_list_mine(text) is
    '申請人自己的申請單，附每張單自己可以做的動作與例外。呼叫者：sgn_app。規則：PRB-APPLICANT';

create function api.inbox_list(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    return coalesce((
        select jsonb_agg(s.summary order by (s.summary ->> 'case_no')::bigint)
        from (
            select sgn_internal.case_summary(c.id, v_person_id) as summary
            from sgn.request_case c
            where c.approver_person_id = v_person_id
        ) as s
        where jsonb_array_length(s.summary -> 'actions') > 0
    ), '[]'::jsonb);
end;
$$;

comment on function api.inbox_list(text) is
    '待簽清單：這個人現在可以做決定的單（由授權入口判定），附可以做的動作與例外。呼叫者：sgn_app。規則：PRB-APPROVER、PRB-SELF、PRB-STATE';
