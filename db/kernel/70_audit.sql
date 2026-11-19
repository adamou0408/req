-- 稽核唯讀查詢與證據頁（PRB-AUDIT-READ）。function 都是 STABLE：在 PostgreSQL 裡 STABLE function 內做寫入會被拒絕，
-- 所以「唯讀」是由資料庫保證，不是靠寫程式的人小心。
-- 回傳原始 body bytes 與決定證明的原文（jsonb），讓稽核人員的瀏覽器自己做 RFC 8785 標準化、自己重算雜湊、
-- 自己驗簽章，不必相信後端或這裡的判斷。回傳結構固定（packages/contract/src/routes.ts）。

create function sgn_internal.audit_case_events(p_case sgn.request_case)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'seq', e.seq,
        'occurred_at', e.occurred_at,
        'event_type', e.event_type,
        'actor_name', p.display_name,
        'body', encode(e.body, 'base64'),
        'prev_hash', encode(e.prev_hash, 'hex'),
        'hash', encode(e.hash, 'hex')
    ) order by e.seq), '[]'::jsonb)
    from sgn.audit_event e
    left join sgn.person p on p.id = e.actor_person_id
    where e.case_id = p_case.id
       -- 這張單用到的通行金鑰的登記事件
       or (e.event_type = 'passkey.registered'
           and convert_from(e.body, 'UTF8')::jsonb #>> '{data,credential_id}' in (
               select d.raw ->> 'credential_id'
               from sgn.decision_proof d
               join sgn.auth_challenge ch on ch.id = d.challenge_id
               where ch.binding ->> 'case_id' = p_case.id::text
           ))
       -- 簽核人依據的主管關係若是同步異動而來，附上那筆異動事件（PRB-SYNC-GUARD）
       or e.seq = (select r.change_event_seq from sgn.reporting_line r where r.id = p_case.approver_line_id)
$$;

create function sgn_internal.audit_case_proofs(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'kind', d.kind,
        'challenge', sgn_internal.b64url_encode(ch.challenge),
        'raw', d.raw,
        'raw_sha256', encode(d.raw_sha256, 'hex'),
        'public_key', sgn_internal.b64url_encode(k.public_key)
    ) order by d.created_at), '[]'::jsonb)
    from sgn.decision_proof d
    join sgn.auth_challenge ch on ch.id = d.challenge_id
    left join sgn.passkey_credential k on k.credential_id = sgn_internal.b64url_decode(d.raw ->> 'credential_id')
    where ch.binding ->> 'case_id' = p_case_id::text
$$;

create function api.audit_case(p_session text, p_case_no bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case;
begin
    perform sgn_internal.authorize(v_person_id, 'audit.read');
    select * into v_case from sgn.request_case where case_no = p_case_no;
    if v_case.id is null then
        perform sgn_internal.raise_error('CASE_UNKNOWN');
    end if;
    return jsonb_build_object(
        'case', sgn_internal.case_summary(v_case.id, null) - 'actions',
        'events', sgn_internal.audit_case_events(v_case),
        'proofs', sgn_internal.audit_case_proofs(v_case.id)
    );
end;
$$;

comment on function api.audit_case(text, bigint) is
    '稽核證據頁：一張單的內容與例外、它的全部鏈上事件（含原始 bytes 與前後雜湊）、決定證明原文與所用的公開金鑰、'
    '登記該金鑰的事件與簽核人依據的主管異動事件。只限稽核角色，唯讀。呼叫者：sgn_app。規則：PRB-AUDIT-READ、PRB-CHAIN、PRB-PROOF、PRB-SYNC-GUARD';

create function api.audit_chain(p_session text, p_after_seq bigint, p_limit int)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.authorize(sgn_internal.session_person(p_session), 'audit.read');
    return (
        select coalesce(jsonb_agg(to_jsonb(e) order by e.seq), '[]'::jsonb)
        from api_job.events_after(p_after_seq, p_limit) as e
    );
end;
$$;

comment on function api.audit_chain(text, bigint, int) is
    '依序號取整條鏈的原始事件，讓稽核人員自己從創世重算並比對外部錨點。只限稽核角色，唯讀。呼叫者：sgn_app。規則：PRB-AUDIT-READ、PRB-CHAIN';

create function api.audit_code_fingerprint(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.authorize(sgn_internal.session_person(p_session), 'audit.read');
    return jsonb_build_object('code_fingerprint', api_job.code_fingerprint());
end;
$$;

comment on function api.audit_code_fingerprint(text) is
    '目前的程式指紋，讓稽核人員與錨點裡記下的指紋比對。只限稽核角色，唯讀。呼叫者：sgn_app。規則：PRB-AUDIT-READ';

create function api.audit_exceptions(p_session text)
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
            'event_seq', x.event_seq
        ) order by x.id), '[]'::jsonb)
        from sgn.exception_record x
        left join sgn.request_case c on c.id = x.case_id
    );
end;
$$;

comment on function api.audit_exceptions(text) is
    '全部例外（目前只有開立、沒有結案流程），讓稽核人員不必知道單號也看得到。只限稽核角色，唯讀。呼叫者：sgn_app。規則：PRB-AUDIT-READ、PRB-SYNC-GUARD';
