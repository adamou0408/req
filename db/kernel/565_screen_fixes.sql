-- 閉環第三批 A：六個畫面問題中要由資料庫決定的部分（docs/handoff/closed-loop-3.md）。
--
-- 1. 首頁的排列：person_capabilities 的順序就是首頁區塊的順序（最需要處理的在前：待簽、稽核、報表、我的申請、角色指派、背書）。
--    待簽清單依「需要處理的程度」排序：有逾期警示的在前，其次等最久的（目前開著的工作最早開始的時間），最後依單號。
--    我的申請：有我現在可以做的動作的單在前，其餘新的在前；捨棄的草稿不列。
-- 2. 例外清單（api.audit_exception_groups）：同一規則、同一張單（或同一個全公司層級的規則）合成一筆，帶筆數與最近一次的時間；
--    未結案與已結案分成兩組。去重與分組都在這裡，畫面只照順序畫。
-- 3. 原因欄位的說明（case_detail.reason_audience）：要填原因的動作各自回傳「原因會讓誰看到」的代碼，依操作者與這張單的
--    通知對象決定（通知對象只有一個來源 case_end_recipients，撤銷與縮小的通知也改用它）；畫面只依代碼取文案。
-- 4. 捨棄草稿（K-CASE-DISCARD）：申請人可以把從沒送審過的草稿捨棄（draft → cancelled），留稽核事件 case.discarded，
--    內容與版本照樣保存，之後不出現在「我的申請」。單號仍在建立草稿時取號（與骨幹 K-CASE-NUMBER「送審時取號」不同；
--    改成送審時取號要動單號的產生與所有以單號為鍵的地方，風險大，記在交接）。
-- 5. 重疊提示（case_detail.overlap_shown）：重疊的主題包、欄位與對方的單號；單號與期間只在操作者本來就能看那張單時才給。

insert into sgn.error_catalog (code, message, http_status) values
    ('MIS_REQUIRED', '只有 MIS 或稽核人員可以看這份報表', 403);

select sgn_internal.register_setting_definition(
    'report.mis_role', 'text', '"mis"', array[]::text[],
    '可以看唯讀彙總報表（例如匯出需求調查的彙總）的 MIS 角色代碼；稽核角色（audit.auditor_role）一律可以看'
);

insert into sgn.state_transition (entity, from_state, action, to_state) values
    ('case', 'draft', 'discard', 'cancelled');

insert into sgn.action (action, scope, actor_rule, role_setting, denied_code, needs_proof, changes_state) values
    ('discard', 'case', 'applicant', null, null, false, true),
    ('report.mis_read', 'global', 'role', 'report.mis_role', 'MIS_REQUIRED', false, false);

-- ── 給流程包：幾個動作之中任一個允許就放行（授權仍由 denial_reason 判斷）；全部不允許時丟第一個動作的錯誤 ──

create function sgn_internal.authorize_any(p_person_id uuid, p_actions text[])
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
    if not exists (select 1 from unnest(p_actions) as a (action) where sgn_internal.denial_reason(p_person_id, a.action, null) is null) then
        perform sgn_internal.authorize(p_person_id, p_actions[1]);
    end if;
end;
$$;

create function sgn_sdk.authorize_any(p_person_id uuid, p_actions text[])
returns void
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.authorize_any(p_person_id, p_actions)
$$;

revoke all on function sgn_sdk.authorize_any(uuid, text[]) from public;

-- ── 首頁區塊的順序（同 270 的簽章）：陣列的順序就是首頁的順序；多了 report（稽核或 MIS 可以看的唯讀彙總） ──

create or replace function sgn_internal.person_capabilities(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select to_jsonb(array_remove(array[
        case when exists (select 1 from sgn_internal.person_waiting_cases(p_person_id)) then 'inbox' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null::sgn.request_case) is null then 'audit' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null::sgn.request_case) is null
               or sgn_internal.denial_reason(p_person_id, 'report.mis_read', null::sgn.request_case) is null then 'report' end,
        'case.submit',
        case when exists (
            select 1
            from sgn.role as r
            where sgn_internal.denial_reason(p_person_id, 'role_change.propose', r) is null
        ) or exists (
            select 1
            from sgn.role_change_request as q
            join sgn.role as r on r.code = q.role_code
            where sgn_internal.denial_reason(p_person_id, 'role_change.approve', r, q) is null
               or sgn_internal.denial_reason(p_person_id, 'role_change.block', r, q) is null
        ) then 'role_change' end,
        case when exists (
            select 1
            from sgn.passkey_enrollment as e
            where e.status = 'pending' and e.person_id <> p_person_id and sgn_internal.denial_reason(p_person_id, 'passkey.endorse', e) is null
        ) then 'passkey.endorse' end
    ], null))
$$;

-- ── 待簽清單的順序 ──

-- 這張單目前開著的工作（等決定或等認領）最早開始的時間：等最久的排前面。
create function sgn_internal.case_waiting_since(p_case_id uuid)
returns timestamptz
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select min(t.opened_at)
    from sgn.case_task as t
    join sgn.case_stage as s on s.id = t.stage_id
    where t.case_id = p_case_id and s.status = 'open' and t.status in ('pending', 'unclaimed')
$$;

-- 待辦清單（同 180 的簽章）：有逾期警示的在前，其次等最久的，最後依單號。
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
        select jsonb_agg(s.summary order by s.overdue desc, s.since nulls last, (s.summary ->> 'case_no')::bigint)
        from (
            select sgn_internal.case_summary(w.case_id, v_person_id) as summary,
                   sgn_internal.case_overdue(w.case_id) is not null as overdue,
                   sgn_internal.case_waiting_since(w.case_id) as since
            from sgn_internal.person_waiting_cases(v_person_id) as w (case_id)
        ) as s
        where jsonb_array_length(s.summary -> 'actions') > 0
    ), '[]'::jsonb);
end;
$$;

comment on function api.inbox_list(text) is
    '待辦清單：指派給我、或我可以認領的工作所在的單，只列我現在可以做事的（由授權入口判定）。'
    '順序由這裡決定：有逾期警示的在前，其次等最久的，最後依單號。呼叫者：sgn_app。規則：K-DECISION-ELIGIBLE、K-CLAIM、K-SOD-APPLICANT';

-- 捨棄的草稿：從沒送審過（沒有任何關卡）而被取消的單。
create function sgn_internal.case_discarded(p_case sgn.request_case)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p_case.state = 'cancelled' and not exists (select 1 from sgn.case_stage as s where s.case_id = p_case.id)
$$;

-- 申請人自己的申請單（同 60 的簽章）：有我現在可以做的動作的在前，其餘新的在前；捨棄的草稿不列。
create or replace function api.case_list_mine(p_session text)
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
        select jsonb_agg(s.summary order by jsonb_array_length(s.summary -> 'actions') > 0 desc, (s.summary ->> 'case_no')::bigint desc)
        from (
            select sgn_internal.case_summary(c.id, v_person_id) as summary
            from sgn.request_case as c
            where c.applicant_person_id = v_person_id and not sgn_internal.case_discarded(c)
        ) as s
    ), '[]'::jsonb);
end;
$$;

comment on function api.case_list_mine(text) is
    '申請人自己的申請單，附每張單自己可以做的動作與例外。有我現在可以做的動作的在前，其餘新的在前；捨棄的草稿不列（K-CASE-DISCARD）。'
    '呼叫者：sgn_app。規則：PRB-APPLICANT、K-CASE-DISCARD';

-- ── 例外清單：去重、分組 ──

-- 同一規則、同一張單（全公司層級的例外：同一規則）合成一筆；status 是 open（未結案）或 closed（已結案）。
create function sgn_internal.exception_groups(p_open boolean)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'rule_code', g.rule_code,
        'process_type', g.process_type,
        'case_no', g.case_no,
        'count', g.n,
        'first_opened_at', g.first_opened_at,
        'last_opened_at', g.last_opened_at,
        'last_closed_at', g.last_closed_at
    ) order by coalesce(g.last_closed_at, g.last_opened_at) desc, g.rule_code, g.case_no), '[]'::jsonb)
    from (
        select x.rule_code, c.process_type, c.case_no, count(*)::int as n,
               min(x.opened_at) as first_opened_at, max(x.opened_at) as last_opened_at,
               case when not p_open then max(x.closed_at) end as last_closed_at
        from sgn.exception_record as x
        left join sgn.request_case as c on c.id = x.case_id
        where (x.closed_at is null) = p_open
        group by x.rule_code, c.process_type, c.case_no
    ) as g
$$;

create function api.audit_exception_groups(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.authorize(sgn_internal.session_person(p_session), 'audit.read');
    return jsonb_build_object('open', sgn_internal.exception_groups(true), 'closed', sgn_internal.exception_groups(false));
end;
$$;

comment on function api.audit_exception_groups(text) is
    '稽核首頁的例外清單：同一規則、同一張單合成一筆（筆數、第一次與最近一次的時間），未結案與已結案分開；'
    '每組依最近的時間排序（已結案的依最近結案）。只限稽核角色，唯讀。呼叫者：sgn_app。規則：PRB-AUDIT-READ、K-EXCEPTION-CLOSE';

-- ── 原因會讓誰看到 ──

-- 撤銷、縮小時收到通知的人（申請人、被授權者負責人）：通知與畫面上的說明都從這裡取（K-GRANT-REVOKE、K-GRANT-REDUCE）。
create function sgn_internal.case_end_recipients(p_case sgn.request_case)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_array(
        jsonb_build_object('role', 'applicant', 'person', p_case.applicant_person_id),
        jsonb_build_object('role', 'principal_owner', 'person', sgn_internal.case_principal_owner(p_case))
    )
$$;

create function sgn_internal.recipient_people(p_recipients jsonb)
returns uuid[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select array(select (r ->> 'person')::uuid from jsonb_array_elements(p_recipients) as r where r ->> 'person' is not null)
$$;

-- 這些收件人扣掉看的人之後的代碼：applicant、principal_owner、applicant_principal_owner；沒有人時是 record（只記在紀錄裡）。
create function sgn_internal.reason_audience(p_recipients jsonb, p_viewer uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(string_agg(distinct r ->> 'role', '_' order by r ->> 'role'), 'record')
    from jsonb_array_elements(p_recipients) as r
    where r ->> 'person' is not null and (r ->> 'person')::uuid is distinct from p_viewer
$$;

-- 看的人在這張單可以做、而且要填原因的動作 → 原因會讓誰看到。退回、駁回通知申請人；撤回不通知任何人（只記在這張單的紀錄）。
create function sgn_internal.case_reason_audience(p_case sgn.request_case, p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_object_agg(a.action, sgn_internal.reason_audience(
        case a.action
            when 'recall' then '[]'::jsonb
            when 'return' then jsonb_path_query_array(sgn_internal.case_end_recipients(p_case), '$[*] ? (@.role == "applicant")')
            when 'reject' then jsonb_path_query_array(sgn_internal.case_end_recipients(p_case), '$[*] ? (@.role == "applicant")')
            else sgn_internal.case_end_recipients(p_case)
        end, p_person_id)), '{}'::jsonb)
    from jsonb_array_elements_text(sgn_internal.case_actions(p_case, p_person_id)) as a (action)
    where a.action in ('revoke', 'reduce', 'return', 'reject', 'recall')
$$;

-- 撤銷與到期（同 480 的簽章）：通知對象改由 case_end_recipients 取（行為不變）。
create or replace function sgn_internal.grant_end(p_case sgn.request_case, p_event text, p_actor uuid, p_reason text, p_rule_code text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_withdrawals int := 0;
    v_channel text;
begin
    perform sgn_internal.case_transition(p_case.id, case p_event when 'revoked' then 'revoke' else 'expire' end);
    perform sgn_internal.confirmation_close(p_case.id, 'cancel', p_actor, p_reason);
    if p_case.state in ('pending_fulfilment', 'verifying') then
        perform sgn_internal.stages_close_open(p_case.id, 'cancelled', p_event);
    end if;
    update sgn.grant_record
    set status = p_event, ended_at = sgn_internal.now(), ended_by = p_actor, end_reason = p_reason
    where case_id = p_case.id and status = 'active';
    if p_event = 'revoked' then
        v_withdrawals := sgn_internal.delivery_withdraw_case(p_case.id);
    else
        for v_channel in select distinct o.channel from sgn.delivery_op as o where o.case_id = p_case.id and o.kind = 'apply' order by 1 loop
            perform sgn_internal.delivery_supersede(p_case.id, v_channel, sgn_internal.delivery_purge(v_channel));
        end loop;
    end if;
    perform sgn_internal.audit_append(
        'grant.' || p_event, p_case.id, p_actor,
        jsonb_build_object('version', p_case.current_version, 'reason', p_reason, 'withdrawals', v_withdrawals, 'from_state', p_case.state,
            'rules', jsonb_build_array(p_rule_code, 'K-DELIVERY-AUTO'))
    );
    perform sgn_internal.grant_manual_followup(p_case, p_event);
    perform sgn_internal.notify(
        'case.' || p_event, sgn_internal.recipient_people(sgn_internal.case_end_recipients(p_case)), p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'reason', coalesce(p_reason, '-'))
    );
end;
$$;

-- 生效後縮小的交付（同 420 的簽章）：通知對象改由 case_end_recipients 取（行為不變）。
create or replace function sgn_internal.grant_reduce_deliver(p_case sgn.request_case, p_actor uuid, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_terms jsonb := (select v.terms from sgn.case_version as v where v.case_id = p_case.id and v.version = p_case.current_version);
    v_payload jsonb := sgn_internal.hook_fulfilment(p_case.process_type, p_case.id);
    v_channel text;
    v_scopes text[];
    v_body jsonb;
begin
    insert into sgn.fulfilment (case_id, version, payload, payload_sha256, created_at)
    values (p_case.id, p_case.current_version, v_payload, sgn_internal.jcs_sha256(v_payload), sgn_internal.now());
    update sgn.grant_record
    set version = p_case.current_version, valid_to = sgn_internal.try_date(v_terms ->> 'valid_to')
    where case_id = p_case.id and status = 'active';
    for v_channel in select distinct o.channel from sgn.delivery_op as o where o.case_id = p_case.id and o.kind = 'apply' order by 1 loop
        v_scopes := array(
            select s from unnest(sgn_internal.case_fulfilment_scopes(p_case, sgn_internal.case_fulfilment_stage_code(p_case))) as s
            where sgn_internal.delivery_automated(s) and sgn_internal.setting('delivery.channel', array[s]) #>> '{}' = v_channel
        );
        v_body := case when cardinality(v_scopes) > 0 then sgn_internal.hook_build_delivery(p_case.process_type, p_case.id, v_scopes) end;
        perform sgn_internal.delivery_supersede(p_case.id, v_channel, null);
        if v_body is null then
            perform sgn_internal.delivery_op_create(v_channel, 'withdraw', p_case.id, p_case.current_version,
                jsonb_build_object('case_no', p_case.case_no::text));
        else
            perform sgn_internal.delivery_op_create(v_channel, 'apply', p_case.id, p_case.current_version, v_body);
        end if;
    end loop;
    perform sgn_internal.audit_append(
        'grant.reduced', p_case.id, p_actor,
        jsonb_build_object('version', p_case.current_version, 'terms', v_terms, 'reason', p_reason,
            'payload_sha256', encode(sgn_internal.jcs_sha256(v_payload), 'hex'),
            'rules', jsonb_build_array('K-GRANT-REDUCE', 'K-CHANGE-REDUCE', 'K-DELIVERY-AUTO'))
    );
    perform sgn_internal.notify(
        'case.reduced_active', sgn_internal.recipient_people(sgn_internal.case_end_recipients(p_case)), p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'reason', p_reason)
    );
end;
$$;

-- ── 重疊提示：給操作者看的版本 ──

-- 重疊的項目經流程包的顯示 hook 換成名稱（主題包、欄位）；對方的單號與期間只在看的人本來就能看那張單（申請人或經手人，或稽核）時才給。
create function sgn_internal.case_overlap_shown(p_case_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_overlap jsonb := sgn_internal.case_overlap_current(p_case_id);
    v_process text := (select c.process_type from sgn.request_case as c where c.id = p_case_id);
    v_shown jsonb;
begin
    if v_overlap is null then
        return null;
    end if;
    v_shown := sgn_internal.hook_display_overlap(v_process, coalesce(v_overlap -> 'items', '[]'::jsonb));
    return jsonb_build_object(
        'level', v_overlap -> 'level',
        'reason', v_overlap -> 'reason',
        'items', coalesce((
            select jsonb_agg(case when sgn_internal.case_visible_to(r.item ->> 'case_id', p_person_id) then d.item
                                  else d.item || jsonb_build_object('case_no', null, 'valid_from', null, 'valid_to', null) end
                             order by r.n)
            from jsonb_array_elements(coalesce(v_overlap -> 'items', '[]'::jsonb)) with ordinality as r (item, n)
            join jsonb_array_elements(case when jsonb_typeof(v_shown) = 'array' then v_shown else '[]'::jsonb end)
                with ordinality as d (item, n) on d.n = r.n
        ), '[]'::jsonb)
    );
end;
$$;

-- 看的人能不能看這張單（以授權入口判定：這張單的經手人（read），或稽核）。
create function sgn_internal.case_visible_to(p_case_id text, p_person_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce((
        select sgn_internal.denial_reason(p_person_id, 'read', c) is null
            or sgn_internal.denial_reason(p_person_id, 'audit.read', null::sgn.request_case) is null
        from sgn.request_case as c
        where c.id::text = p_case_id
    ), false)
$$;

-- 申請單詳情（同 545 的簽章）：多了 reason_audience 與 overlap_shown。
create or replace function sgn_internal.case_detail(p_case_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    return sgn_internal.case_summary(p_case_id, p_person_id) || jsonb_build_object(
        'stages', sgn_internal.case_stages_view(p_case_id),
        'versions', sgn_internal.case_versions_view(p_case_id),
        'overlap', sgn_internal.case_overlap_current(p_case_id),
        'overlap_shown', sgn_internal.case_overlap_shown(p_case_id, p_person_id),
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
        ),
        'display', sgn_internal.case_display(p_case_id, p_person_id),
        'duplicates', sgn_internal.case_duplicates(p_case_id),
        'path', sgn_internal.case_path(p_case_id),
        'resubmit', sgn_internal.case_resubmit_preview(p_case_id),
        'delivery', sgn_internal.case_delivery_view(p_case_id),
        'confirmation', sgn_internal.case_confirmation_view(p_case_id),
        'usage', sgn_internal.case_usage(p_case_id),
        'reason_audience', sgn_internal.case_reason_audience(v_case, p_person_id)
    );
end;
$$;

-- ── 捨棄草稿 ──

create function api.case_discard(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
begin
    perform sgn_internal.authorize(v_person_id, 'discard', v_case);
    perform sgn_internal.case_transition(p_case_id, 'discard');
    perform sgn_internal.audit_append(
        'case.discarded', p_case_id, v_person_id,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', (select encode(v.content_sha256, 'hex') from sgn.case_version as v
                               where v.case_id = p_case_id and v.version = v_case.current_version),
            'rules', jsonb_build_array('K-CASE-DISCARD')
        )
    );
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_discard(text, uuid) is
    '使用者動作「捨棄草稿」：申請人把從沒送審過的草稿捨棄（狀態轉為已取消，內容與版本照樣保存），寫稽核事件 case.discarded；'
    '之後不出現在「我的申請」。送審過的單不能捨棄（退回的單要撤回或修改）。回傳申請單詳情。呼叫者：sgn_app。規則：K-CASE-DISCARD';

select sgn_internal.register_rule(
    'K-CASE-DISCARD',
    '申請人可以捨棄從沒送審過的草稿：狀態轉為已取消、留稽核事件（內容指紋），內容不刪除；捨棄的草稿不列在「我的申請」',
    null,
    'partial',
    '單號仍在建立草稿時取號（骨幹 K-CASE-NUMBER 要求送審時無間隙取號），捨棄的草稿留下跳號'
);

select sgn_internal.register_rule(
    'K-HOME-ORDER',
    '畫面清單的順序由資料庫決定：首頁區塊依 person_capabilities 的順序（待簽、稽核、報表、我的申請……）；待簽清單有逾期警示的在前、'
    '其次等最久的；我的申請有我可以做的動作的在前；例外清單同一規則同一張單合成一筆，未結案與已結案分開',
    null,
    'full',
    null
);

select sgn_internal.register_rule(
    'K-REASON-AUDIENCE',
    '要填原因的動作（撤銷、縮小、退回、駁回、撤回），畫面上的說明依「原因會讓誰看到」決定：通知對象扣掉操作者本人，由資料庫回傳代碼',
    null,
    'full',
    null
);

select sgn_internal.register_rule(
    'K-OVERLAP-SHOWN',
    '重疊提示列出重疊的主題包與欄位（名稱）；對方的單號與期間只在操作者本來就能看那張單（經手人或稽核）時才顯示',
    null,
    'full',
    null
);
