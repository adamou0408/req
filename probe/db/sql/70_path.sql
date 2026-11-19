-- 路徑探針需要的查詢入口：給畫面用的「我是誰、能做什麼」、待簽清單、我的申請、稽核證據頁。
-- 由 probe/api 的路由表直接對應；後端與前端不做任何業務判斷，按鈕與選單都依這裡回傳的清單。
-- 規則：PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-AUDIT-READ

-- 錯誤目錄加上 HTTP 狀態，讓後端啟動時讀表，不在程式裡另寫一份對照。
alter table sgn.error_catalog add column http_status int not null default 409;

update sgn.error_catalog set http_status = 401 where code = 'SESSION_INVALID';
update sgn.error_catalog set http_status = 403
where code in ('NOT_APPLICANT', 'NOT_APPROVER', 'SELF_APPROVAL', 'AUDITOR_REQUIRED');
update sgn.error_catalog set http_status = 404 where code = 'CASE_UNKNOWN';
update sgn.error_catalog set http_status = 422
where code like 'PASSKEY\_%' or code like 'TOKEN\_%' or code like 'CHALLENGE\_%'
   or code in ('PERSON_UNKNOWN', 'DECISION_MISMATCH');

create function api.error_catalog()
returns table (code text, message text, http_status int)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select e.code, e.message, e.http_status from sgn.error_catalog e order by e.code
$$;

comment on function api.error_catalog() is
    '錯誤代碼、訊息與 HTTP 狀態；後端啟動時讀一次。呼叫者：sgn_probe_app。';

-- 某個角色在某張單目前可以做的動作。動作來自轉移表；誰能做由同一套規則決定（PRB-APPLICANT、PRB-APPROVER、PRB-SELF）。
create function sgn_internal.case_actions(p_case sgn.request_case, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(t.action order by t.action), '[]'::jsonb)
    from sgn.state_transition t
    where t.from_state = p_case.state
      and (
          (t.action in ('revise', 'submit') and p_person_id = p_case.applicant_person_id)
          or (t.action in ('approve', 'return')
              and p_person_id = p_case.approver_person_id
              and p_person_id <> p_case.applicant_person_id)
      )
$$;

-- 給畫面的單張摘要：單號、狀態、目前版本的內容與雜湊、雙方姓名、這個人可以做的動作。
create function sgn_internal.case_summary(p_case sgn.request_case, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'case_id', p_case.id,
        'case_no', p_case.case_no,
        'state', p_case.state,
        'version', v.version,
        'content', v.content,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'submitted_at', v.created_at,
        'applicant_name', a.display_name,
        'approver_name', m.display_name,
        'actions', sgn_internal.case_actions(p_case, p_person_id)
    )
    from sgn.case_version v
    join sgn.person a on a.id = p_case.applicant_person_id
    left join sgn.person m on m.id = p_case.approver_person_id
    where v.case_id = p_case.id
      and v.version = p_case.current_version
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
            'capabilities', to_jsonb(array_remove(array[
                case when sgn_internal.resolve_manager(p.id) is not null then 'case.submit' end,
                case when exists (
                    select 1 from sgn.reporting_line r where r.manager_person_id = p.id and r.valid_to is null
                ) or exists (
                    select 1 from sgn.request_case c where c.approver_person_id = p.id and c.state = 'submitted'
                ) then 'inbox' end,
                case when sgn_internal.has_role(p.id, sgn_internal.setting_text('audit.auditor_role')) then 'audit' end
            ], null))
        )
        from sgn.person p
        where p.id = v_person_id
    );
end;
$$;

comment on function api.me(text) is
    '目前登入的人：姓名、已登記的通行金鑰數、畫面可以顯示的功能（送審、待簽、稽核）。呼叫者：sgn_probe_app。規則：PRB-APPROVER、PRB-AUDIT-READ';

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
        select jsonb_agg(sgn_internal.case_summary(c, v_person_id) order by c.case_no desc)
        from sgn.request_case c
        where c.applicant_person_id = v_person_id
    ), '[]'::jsonb);
end;
$$;

comment on function api.case_list_mine(text) is
    '申請人自己的申請單，附每張單自己可以做的動作。呼叫者：sgn_probe_app。規則：PRB-APPLICANT';

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
            select sgn_internal.case_summary(c, v_person_id) as summary
            from sgn.request_case c
            where c.approver_person_id = v_person_id
        ) s
        where jsonb_array_length(s.summary -> 'actions') > 0
    ), '[]'::jsonb);
end;
$$;

comment on function api.inbox_list(text) is
    '待簽清單：這個人現在可以做決定的單（由轉移表與簽核人規則決定），附可以做的動作。呼叫者：sgn_probe_app。規則：PRB-APPROVER、PRB-SELF、PRB-STATE';

-- ── 稽核證據頁 ──
-- 回傳原始 body bytes 與決定證明的原文，讓稽核人員的瀏覽器自己重算雜湊、自己驗簽章，不必相信後端或這個 function 的判斷。

create function sgn_internal.require_auditor(p_session text)
returns uuid
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    if not sgn_internal.has_role(v_person_id, sgn_internal.setting_text('audit.auditor_role')) then
        perform sgn_internal.raise_error('AUDITOR_REQUIRED');
    end if;
    return v_person_id;
end;
$$;

create function api.audit_case(p_session text, p_case_no bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
begin
    perform sgn_internal.require_auditor(p_session);
    select * into v_case from sgn.request_case where case_no = p_case_no;
    if v_case.id is null then
        perform sgn_internal.raise_error('CASE_UNKNOWN');
    end if;
    return jsonb_build_object(
        -- content_text 是算內容指紋用的原文（jsonb 的文字輸出），稽核端自己重算 sha256 比對。
        'case', (sgn_internal.case_summary(v_case, null) - 'actions') || jsonb_build_object(
            'content_text', (
                select v.content::text from sgn.case_version v
                where v.case_id = v_case.id and v.version = v_case.current_version
            )
        ),
        'events', (
            select jsonb_agg(jsonb_build_object(
                'seq', e.seq,
                'occurred_at', e.occurred_at,
                'event_type', e.event_type,
                'actor_name', p.display_name,
                'body', encode(e.body, 'base64'),
                'prev_hash', encode(e.prev_hash, 'hex'),
                'hash', encode(e.hash, 'hex')
            ) order by e.seq)
            from sgn.audit_event e
            left join sgn.person p on p.id = e.actor_person_id
            where e.case_id = v_case.id
               or (e.event_type = 'passkey.registered'
                   and e.body is not null
                   and convert_from(e.body, 'UTF8')::jsonb #>> '{data,credential_id}' in (
                       select d.raw ->> 'credential_id'
                       from sgn.decision_proof d
                       join sgn.auth_challenge ch on ch.id = d.challenge_id
                       where ch.binding ->> 'case_id' = v_case.id::text
                   ))
        ),
        'proofs', coalesce((
            select jsonb_agg(jsonb_build_object(
                'kind', d.kind,
                'challenge', sgn_crypto.b64url_encode(ch.challenge),
                'raw_text', d.raw::text,
                'raw_sha256', encode(d.raw_sha256, 'hex'),
                'public_key', sgn_crypto.b64url_encode(k.public_key)
            ) order by d.created_at)
            from sgn.decision_proof d
            join sgn.auth_challenge ch on ch.id = d.challenge_id
            left join sgn.passkey_credential k on k.credential_id = sgn_crypto.b64url_decode(d.raw ->> 'credential_id')
            where ch.binding ->> 'case_id' = v_case.id::text
        ), '[]'::jsonb)
    );
end;
$$;

comment on function api.audit_case(text, bigint) is
    '稽核證據頁：一張單的內容、它的全部鏈上事件（含原始 bytes 與前後雜湊）、決定證明原文與所用的公開金鑰，以及登記該金鑰的事件。只限稽核角色，唯讀。呼叫者：sgn_probe_app。規則：PRB-AUDIT-READ、PRB-CHAIN、PRB-PROOF';

create function api.audit_chain(p_session text, p_after_seq bigint, p_limit int)
returns table (
    seq bigint,
    occurred_at timestamptz,
    event_type text,
    case_id uuid,
    actor_person_id uuid,
    body text,
    prev_hash text,
    hash text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.require_auditor(p_session);
    return query select * from api_audit.events_after(p_after_seq, p_limit);
end;
$$;

comment on function api.audit_chain(text, bigint, int) is
    '依序號取整條鏈的原始事件，讓稽核人員自己從創世重算並比對外部錨點。只限稽核角色，唯讀。呼叫者：sgn_probe_app。規則：PRB-AUDIT-READ、PRB-CHAIN';

create function api.audit_code_fingerprint(p_session text)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.require_auditor(p_session);
    return api_audit.code_fingerprint();
end;
$$;

comment on function api.audit_code_fingerprint(text) is
    '目前的程式指紋，讓稽核人員與錨點裡記下的指紋比對。只限稽核角色，唯讀。呼叫者：sgn_probe_app。規則：PRB-AUDIT-READ';
