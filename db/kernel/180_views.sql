-- 給畫面的讀取（取代 40_case.sql 的 case_summary、60_views.sql 的 person_capabilities 與 inbox_list、
-- 40_case.sql 的 api.case_get）。按鈕依 actions（由授權入口算出），不依狀態推斷。
-- 回傳結構固定（packages/contract/src/routes.ts；db/tests/kernel/90-contract.test.mjs 檢查）。

create function sgn_internal.person_name(p_person_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p.display_name from sgn.person as p where p.id = p_person_id
$$;

-- 目前開著（或停住）的那一關。
create function sgn_internal.case_current_stage(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('seq', s.seq, 'code', ps.code, 'name', ps.name, 'phase', ps.phase, 'status', s.status)
    from sgn.case_stage as s
    join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
    where s.case_id = p_case_id and s.status in ('open', 'halted')
    order by s.seq
    limit 1
$$;

-- 目前等誰處理：開著的關卡裡等決定的人；等認領的工作顯示候選人。
create function sgn_internal.case_waiting_on(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(distinct p.display_name), '[]'::jsonb)
    from sgn.case_task as t
    join sgn.case_stage as s on s.id = t.stage_id
    cross join lateral unnest(
        case
            when t.status = 'pending' then array[t.assignee_person_id]
            else sgn_internal.claim_candidates(t.case_id, s.id, t.claim_role, t.claim_scope)
        end
    ) as w (person_id)
    join sgn.person as p on p.id = w.person_id
    where t.case_id = p_case_id and s.status = 'open' and t.status in ('pending', 'unclaimed')
$$;

create function sgn_internal.case_terms_view(p_terms jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'principal', (select sgn_internal.principal_json(x.id) from sgn.principal as x where x.id::text = p_terms ->> 'principal_id'),
        'valid_from', p_terms ->> 'valid_from',
        'valid_to', p_terms ->> 'valid_to'
    )
$$;

-- 單張摘要（所有回傳申請單清單的 function 共用這個結構）。
create or replace function sgn_internal.case_summary(p_case_id uuid, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'case_id', c.id,
        'case_no', c.case_no,
        'process_type', c.process_type,
        'state', c.state,
        'tier', v.tier,
        'version', v.version,
        'content', v.content,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex'),
        'terms', sgn_internal.case_terms_view(v.terms),
        'updated_at', v.created_at,
        'applicant_name', a.display_name,
        'current_stage', sgn_internal.case_current_stage(c.id),
        'waiting_on', sgn_internal.case_waiting_on(c.id),
        'notices', v.notices,
        'errors', case
            when c.state in ('draft', 'returned') then v.errors || sgn_internal.terms_errors(c.process_type, v.terms, v.tier)
            else '[]'::jsonb
        end,
        'actions', sgn_internal.case_actions(c, p_person_id),
        'exceptions', sgn_internal.case_exceptions(c.id)
    )
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    join sgn.person as a on a.id = c.applicant_person_id
    where c.id = p_case_id
$$;

create function sgn_internal.case_stages_view(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'seq', s.seq,
        'code', ps.code,
        'name', ps.name,
        'phase', ps.phase,
        'status', s.status,
        'opened_at', s.opened_at,
        'closed_at', s.closed_at,
        'tasks', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'task_id', t.id,
                'assignee_name', sgn_internal.person_name(t.assignee_person_id),
                'status', t.status,
                'scope_refs', to_jsonb(t.scope_refs),
                'decided_version', t.decided_version,
                'reason', t.reason,
                'closed_at', t.closed_at
            ) order by t.id), '[]'::jsonb)
            from sgn.case_task as t
            where t.stage_id = s.id
        )
    ) order by s.id), '[]'::jsonb)
    from sgn.case_stage as s
    join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
    where s.case_id = p_case_id
$$;

create function sgn_internal.case_versions_view(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'version', v.version,
        'change_kind', v.change_kind,
        'tier', v.tier,
        'created_by_name', sgn_internal.person_name(v.created_by),
        'created_at', v.created_at,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex')
    ) order by v.version), '[]'::jsonb)
    from sgn.case_version as v
    where v.case_id = p_case_id
$$;

-- 申請單詳情：摘要＋每一關與每件工作、版本歷程、最近一次重疊檢查、執行內容、授權。
-- 草稿與退回的單，重疊檢查即時重算（送審前就讓申請人看到要不要填理由）。
create function sgn_internal.case_detail(p_case_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_overlap jsonb;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    if v_case.state in ('draft', 'returned') and sgn_internal.process_option(v_case.process_type, 'overlap_check') then
        v_overlap := sgn_internal.hook_overlaps(
            v_case.process_type,
            p_case_id,
            (select v.content from sgn.case_version as v where v.case_id = p_case_id and v.version = v_case.current_version)
        ) || jsonb_build_object('reason', null, 'version', v_case.current_version);
    else
        select jsonb_build_object('level', o.level, 'items', o.items, 'reason', o.reason, 'version', o.version) into v_overlap
        from sgn.case_overlap as o
        where o.case_id = p_case_id
        order by o.id desc
        limit 1;
    end if;
    return sgn_internal.case_summary(p_case_id, p_person_id) || jsonb_build_object(
        'stages', sgn_internal.case_stages_view(p_case_id),
        'versions', sgn_internal.case_versions_view(p_case_id),
        'overlap', v_overlap,
        'fulfilment', (
            select jsonb_build_object('version', f.version, 'payload', f.payload, 'payload_sha256', encode(f.payload_sha256, 'hex'))
            from sgn.fulfilment as f
            where f.case_id = p_case_id
            order by f.id desc
            limit 1
        ),
        'grant', (
            select jsonb_build_object('grant_id', g.id, 'valid_from', g.valid_from, 'valid_to', g.valid_to, 'status', g.status)
            from sgn.grant_record as g
            where g.case_id = p_case_id
        )
    );
end;
$$;

drop function api.case_get(text, uuid);

create function api.case_get(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    perform sgn_internal.authorize(v_person_id, 'read', v_case);
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_get(text, uuid) is
    '申請單詳情（申請、簽核、執行畫面共用）：摘要、可執行的動作、每一關與每件工作、版本歷程、重疊、執行內容、授權。'
    '只有申請人與這張單的指派對象、候選人看得到，其他人一律 CASE_UNKNOWN。呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-DECISION-ELIGIBLE';

-- 這個人有沒有等他處理的工作（畫面提示，不是授權）。
create function sgn_internal.person_waiting_cases(p_person_id uuid)
returns setof uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select distinct t.case_id
    from sgn.case_task as t
    join sgn.case_stage as s on s.id = t.stage_id
    where s.status = 'open'
      and (
          (t.status = 'pending' and t.assignee_person_id = p_person_id)
          or (t.status = 'unclaimed' and p_person_id = any (sgn_internal.claim_candidates(t.case_id, s.id, t.claim_role, t.claim_scope)))
      )
$$;

create or replace function sgn_internal.person_capabilities(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select to_jsonb(array_remove(array[
        'case.submit',
        case when exists (select 1 from sgn_internal.person_waiting_cases(p_person_id)) then 'inbox' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null) is null then 'audit' end
    ], null))
$$;

create or replace function api.inbox_list(p_session text)
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
            select sgn_internal.case_summary(w.case_id, v_person_id) as summary
            from sgn_internal.person_waiting_cases(v_person_id) as w (case_id)
        ) as s
        where jsonb_array_length(s.summary -> 'actions') > 0
    ), '[]'::jsonb);
end;
$$;

comment on function api.inbox_list(text) is
    '待辦清單：指派給我、或我可以認領的工作所在的單，只列我現在可以做事的（由授權入口判定）。'
    '呼叫者：sgn_app。規則：K-DECISION-ELIGIBLE、K-CLAIM、K-SOD-APPLICANT';

create function api.process_type_list(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.session_person(p_session);
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'code', t.code,
            'name', t.name,
            'options', t.options,
            'tiers', (
                select jsonb_agg(jsonb_build_object('code', r.tier_code, 'name', r.name) order by r.sort_order)
                from sgn.process_tier as r
                where r.process_type = t.code
            )
        ) order by t.code)
        from sgn.process_type as t
    ), '[]'::jsonb);
end;
$$;

comment on function api.process_type_list(text) is
    '可以申請的流程類型與級別、選項（是否要選被授權者、填授權起迄）。新申請畫面用。呼叫者：sgn_app。規則：無（目錄）';

create function api.principal_list(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.session_person(p_session);
    return coalesce((
        select jsonb_agg(sgn_internal.principal_json(x.id) order by x.kind, x.name)
        from sgn.principal as x
        where sgn_internal.principal_usable(x.id)
    ), '[]'::jsonb);
end;
$$;

comment on function api.principal_list(text) is
    '可以選的被授權者（團隊、專案、agent）：有效、沒有過結束日、負責人在職。新申請畫面用。呼叫者：sgn_app。規則：K-PRINCIPAL';

-- 稽核證據頁的事件（取代 70_audit.sql 的版本）：這張單的事件、用到的通行金鑰的登記事件、
-- 每件工作依據的主管關係若是同步異動而來，附上那筆異動事件（K-DETECT-MANAGER-FLIP）。
create or replace function sgn_internal.audit_case_events(p_case sgn.request_case)
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
        'body', translate(encode(e.body, 'base64'), E'\n', ''),
        'prev_hash', encode(e.prev_hash, 'hex'),
        'hash', encode(e.hash, 'hex')
    ) order by e.seq), '[]'::jsonb)
    from sgn.audit_event as e
    left join sgn.person as p on p.id = e.actor_person_id
    where e.case_id = p_case.id
       or (e.event_type = 'passkey.registered'
           and convert_from(e.body, 'UTF8')::jsonb #>> '{data,credential_id}' in (
               select d.raw ->> 'credential_id'
               from sgn.decision_proof as d
               join sgn.auth_challenge as ch on ch.id = d.challenge_id
               where ch.binding ->> 'case_id' = p_case.id::text
           ))
       or e.seq in (
           select (t.basis #>> '{line,change_event_seq}')::bigint
           from sgn.case_task as t
           where t.case_id = p_case.id and t.basis #>> '{line,change_event_seq}' is not null
       )
$$;

-- 錯誤目錄（取代 60_views.sql 的版本）：訊息目錄多了提示與檢查結果（沒有 HTTP 狀態），後端只需要錯誤。
create or replace function api.error_catalog()
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
    from sgn.error_catalog as e
    where e.kind = 'error'
$$;
