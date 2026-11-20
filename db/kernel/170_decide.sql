-- 簽核動作（骨幹 5.4）：核准、縮小後核准、退回、駁回、撤回、執行完成。每個都要決定證明（K-DECISION-PROOF），
-- 證明綁定單號、內容版本雜湊、決定種類與這個決定的輸入（縮小後的內容、原因）。認領不是決定，不需要證明。
-- 只新增：50_decide.sql 的 challenge_issue、decision_prepare、decision_commit 由這裡取代（後兩者簽章不變）。

-- 決定的輸入：先在發挑戰值時整理並檢查（明確的錯誤在按通行金鑰之前就出現），綁進挑戰值，決定時照綁定的套用。
--   return、reject、recall：{reason}，必填
--   approve_reduced：縮小後的版本（整理過的內容與 terms），必須比目前版本縮小（K-CHANGE-REDUCE）
--   fulfil：執行內容的雜湊（K-FULFIL）
create function sgn_internal.decision_input(p_case sgn.request_case, p_decision text, p_input jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_current sgn.case_version;
    v_prepared jsonb;
    v_reason text := btrim(coalesce(p_input ->> 'reason', ''));
begin
    if p_decision in ('return', 'reject', 'recall') then
        if v_reason = '' then
            perform sgn_internal.raise_error('REASON_REQUIRED', p_decision);
        end if;
        return jsonb_build_object('reason', v_reason);
    end if;
    if p_decision = 'fulfil' then
        return jsonb_build_object('payload_sha256', (
            select encode(f.payload_sha256, 'hex') from sgn.fulfilment as f where f.case_id = p_case.id order by f.id desc limit 1
        ));
    end if;
    if p_decision = 'approve_reduced' then
        select * into v_current from sgn.case_version where case_id = p_case.id and version = p_case.current_version;
        v_prepared := sgn_internal.version_prepare(
            p_case.process_type,
            coalesce(p_input -> 'content', v_current.content),
            coalesce(p_input -> 'terms', v_current.terms)
        );
        if jsonb_array_length(v_prepared -> 'errors') > 0 then
            perform sgn_internal.raise_error('CONTENT_INVALID', (v_prepared -> 'errors')::text);
        end if;
        if sgn_internal.versions_compare(
            p_case.process_type, v_current.content, v_current.terms, v_current.tier,
            v_prepared -> 'content', v_prepared -> 'terms', v_prepared ->> 'tier'
        ) <> 'reduce' then
            perform sgn_internal.raise_error('CHANGE_NOT_REDUCE');
        end if;
        return v_prepared;
    end if;
    return '{}'::jsonb;
end;
$$;

-- 發決定挑戰值（取代 50_decide.sql 的三個參數版本）。
drop function api.challenge_issue(text, uuid, text);

create function api.challenge_issue(p_session text, p_case_id uuid, p_decision text, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_input jsonb;
    v_binding jsonb;
    v_row sgn.auth_challenge;
begin
    if not exists (select 1 from sgn.action as a where a.action = p_decision and a.needs_proof) then
        perform sgn_internal.raise_error('ACTION_UNKNOWN', p_decision);
    end if;
    perform sgn_internal.authorize(v_person_id, p_decision, v_case);
    v_input := sgn_internal.decision_input(v_case, p_decision, p_input);
    select jsonb_build_object(
        'case_id', v_case.id,
        'case_no', v_case.case_no,
        'version', v.version,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex'),
        'decision', p_decision,
        'input', v_input,
        'input_sha256', encode(sgn_internal.jcs_sha256(v_input), 'hex')
    ) into v_binding
    from sgn.case_version as v
    where v.case_id = v_case.id and v.version = v_case.current_version;
    v_row := sgn_internal.challenge_new('decision', v_binding, v_person_id);
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'challenge', sgn_internal.b64url_encode(v_row.challenge),
        'binding', v_binding
    );
end;
$$;

comment on function api.challenge_issue(text, uuid, text, jsonb) is
    '使用者動作「核准、縮小後核准、退回、駁回、撤回、執行完成」的第一步：檢查並整理決定的輸入（原因、縮小後的內容），'
    '發一次性挑戰值，綁定單號、內容版本雜湊、決定種類與輸入的雜湊。第二步是 case_decide_passkey。'
    '呼叫者：sgn_app。規則：K-DECISION-PROOF、K-VERSION-BOUND、K-DECISION-ELIGIBLE、K-SOD-APPLICANT、K-CHANGE-REDUCE、K-RETURN、K-REJECT、K-RECALL、K-FULFIL';

-- 決定的前半（同 50_decide.sql 的簽章）：檢查挑戰值、決定種類、內容版本（含 terms）在證明之後沒有變。
create or replace function sgn_internal.decision_prepare(p_challenge_id uuid, p_decision text)
returns sgn.auth_challenge
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_check(p_challenge_id, 'decision');
    v_case sgn.request_case := sgn_internal.case_lock((v_challenge.binding ->> 'case_id')::uuid);
    v_current sgn.case_version;
begin
    if v_challenge.binding ->> 'decision' is distinct from p_decision then
        perform sgn_internal.raise_error('DECISION_MISMATCH');
    end if;
    select * into v_current from sgn.case_version where case_id = v_case.id and version = v_case.current_version;
    if v_case.current_version <> (v_challenge.binding ->> 'version')::int
       or encode(v_current.content_sha256, 'hex') <> v_challenge.binding ->> 'content_sha256'
       or encode(v_current.version_sha256, 'hex') is distinct from v_challenge.binding ->> 'version_sha256' then
        perform sgn_internal.raise_error('CONTENT_CHANGED');
    end if;
    return v_challenge;
end;
$$;

-- 簽核關的工作結束（核准、縮小後核准）。
create function sgn_internal.task_approve(p_case sgn.request_case, p_actor uuid, p_challenge_id uuid)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_task sgn.case_task := sgn_internal.person_open_task(p_case.id, p_actor, 'approval');
begin
    update sgn.case_task
    set status = 'approved',
        closed_at = sgn_internal.now(),
        decided_version = (select c.current_version from sgn.request_case as c where c.id = p_case.id),
        decision_challenge_id = p_challenge_id
    where id = v_task.id;
    return v_task.stage_id;
end;
$$;

-- 退回、駁回：這件工作記下結果與原因，同一張單其他開著的工作取消，關卡收掉。
create function sgn_internal.task_close_negative(
    p_case sgn.request_case,
    p_actor uuid,
    p_challenge_id uuid,
    p_task_status text,
    p_stage_status text,
    p_reason text
)
returns sgn.case_stage
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_task sgn.case_task := sgn_internal.person_open_task(p_case.id, p_actor, 'approval');
    v_stage sgn.case_stage;
begin
    update sgn.case_task
    set status = p_task_status,
        closed_at = sgn_internal.now(),
        decided_version = p_case.current_version,
        decision_challenge_id = p_challenge_id,
        reason = p_reason
    where id = v_task.id;
    select * into v_stage from sgn.case_stage where id = v_task.stage_id;
    perform sgn_internal.stages_close_open(p_case.id, p_stage_status, p_task_status);
    return v_stage;
end;
$$;

-- 套用決定：更新工作與關卡、轉移狀態、通知，必要時往下一關推進。
create function sgn_internal.decision_apply(p_case sgn.request_case, p_actor uuid, p_challenge sgn.auth_challenge)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_decision text := p_challenge.binding ->> 'decision';
    v_input jsonb := p_challenge.binding -> 'input';
    v_stage sgn.case_stage;
    v_stage_id bigint;
    v_new_version int;
    v_policy sgn.policy_stage;
begin
    if v_decision in ('approve', 'approve_reduced') then
        if v_decision = 'approve_reduced' then
            v_new_version := sgn_internal.version_store(p_case.id, v_input, 'reduce', p_actor);
            perform sgn_internal.audit_append(
                'case.reduced', p_case.id, p_actor,
                jsonb_build_object(
                    'from_version', p_case.current_version,
                    'version', v_new_version,
                    'content_sha256', v_input ->> 'content_sha256',
                    'version_sha256', v_input ->> 'version_sha256',
                    'tier', v_input ->> 'tier',
                    'change_kind', 'reduce',
                    'rules', jsonb_build_array('K-CHANGE-REDUCE')
                )
            );
        end if;
        v_stage_id := sgn_internal.task_approve(p_case, p_actor, p_challenge.id);
        select ps.* into v_policy from sgn.policy_stage as ps join sgn.case_stage as s on s.policy_id = ps.policy_id and s.seq = ps.seq
        where s.id = v_stage_id;
        if v_decision = 'approve_reduced' then
            perform sgn_internal.notify(
                'case.reduced', array[p_case.applicant_person_id], p_case.id,
                jsonb_build_object('case_no', p_case.case_no, 'stage_name', v_policy.name)
            );
        end if;
        perform sgn_internal.case_transition(p_case.id, v_decision);
        perform sgn_internal.stage_close_if_done(v_stage_id);
        return;
    end if;
    if v_decision = 'fulfil' then
        select * into v_stage from sgn.case_stage
        where id = (sgn_internal.person_open_task(p_case.id, p_actor, 'fulfilment')).stage_id;
        update sgn.case_task
        set status = 'completed', closed_at = sgn_internal.now(), decided_version = p_case.current_version,
            decision_challenge_id = p_challenge.id
        where id = (sgn_internal.person_open_task(p_case.id, p_actor, 'fulfilment')).id;
        perform sgn_internal.case_transition(p_case.id, 'fulfil');
        perform sgn_internal.stage_close_if_done(v_stage.id);
        return;
    end if;
    if v_decision = 'recall' then
        select * into v_stage from sgn.case_stage
        where case_id = p_case.id and status in ('open', 'halted')
        order by seq
        limit 1;
        perform sgn_internal.stages_close_open(p_case.id, 'returned', 'recalled');
    else
        v_stage := sgn_internal.task_close_negative(
            p_case, p_actor, p_challenge.id,
            case v_decision when 'return' then 'returned' else 'rejected' end,
            case v_decision when 'return' then 'returned' else 'cancelled' end,
            v_input ->> 'reason'
        );
    end if;
    select ps.* into v_policy from sgn.policy_stage as ps where ps.policy_id = v_stage.policy_id and ps.seq = v_stage.seq;
    if v_decision in ('return', 'recall') then
        update sgn.request_case set resume_seq = v_stage.seq, returned_version = p_case.current_version where id = p_case.id;
    end if;
    perform sgn_internal.case_transition(p_case.id, v_decision);
    if v_decision <> 'recall' then
        perform sgn_internal.notify(
            case v_decision when 'return' then 'case.returned' else 'case.rejected' end,
            array[p_case.applicant_person_id], p_case.id,
            jsonb_build_object('case_no', p_case.case_no, 'stage_name', v_policy.name, 'reason', v_input ->> 'reason')
        );
    end if;
end;
$$;

-- 決定的後半（同 50_decide.sql 的簽章）。p_actor 必須是「驗過的證明」得出的人；資格由授權入口對這個人判定。
create or replace function sgn_internal.decision_commit(
    p_challenge sgn.auth_challenge,
    p_actor uuid,
    p_proof_kind text,
    p_proof_raw jsonb
)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock((p_challenge.binding ->> 'case_id')::uuid);
    v_decision text := p_challenge.binding ->> 'decision';
    v_proof_sha256 bytea := sgn_internal.jcs_sha256(p_proof_raw);
begin
    perform sgn_internal.authorize(p_actor, v_decision, v_case);
    if p_actor is distinct from p_challenge.person_id then
        -- 挑戰值發給誰，就只能由誰的證明使用（防止把別人的挑戰值拿來簽）。
        perform sgn_internal.raise_error('CHALLENGE_PURPOSE', 'challenge was issued to another person');
    end if;
    perform sgn_internal.challenge_consume(p_challenge.id, 'decision');
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at)
    values (p_challenge.id, p_proof_kind, p_proof_raw, v_proof_sha256, sgn_internal.now());
    -- 事件先寫（記下決定當時的版本），之後的關卡推進事件排在它後面
    perform sgn_internal.audit_append(
        'case.' || v_decision,
        v_case.id,
        p_actor,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', p_challenge.binding ->> 'content_sha256',
            'version_sha256', p_challenge.binding ->> 'version_sha256',
            'input_sha256', p_challenge.binding ->> 'input_sha256',
            'challenge', sgn_internal.b64url_encode(p_challenge.challenge),
            'proof_kind', p_proof_kind,
            'proof_sha256', encode(v_proof_sha256, 'hex'),
            'open_exceptions', (
                select coalesce(jsonb_agg(x.id order by x.id), '[]'::jsonb)
                from sgn.exception_record as x
                where x.case_id = v_case.id
            ),
            'rules', jsonb_build_array('K-DECISION-PROOF', 'K-VERSION-BOUND', 'K-DECISION-ELIGIBLE')
        )
    );
    perform sgn_internal.decision_apply(v_case, p_actor, p_challenge);
    return sgn_internal.case_summary(v_case.id, p_actor);
end;
$$;

-- ── 認領（K-CLAIM）──

create function api.task_claim(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_task sgn.case_task;
begin
    perform sgn_internal.authorize(v_person_id, 'claim', v_case);
    v_task := sgn_internal.person_claimable_task(p_case_id, v_person_id);
    update sgn.case_task
    set assignee_person_id = v_person_id, status = 'pending', claimed_at = sgn_internal.now()
    where id = v_task.id;
    perform sgn_internal.case_transition(p_case_id, 'claim');
    perform sgn_internal.audit_append(
        'case.claimed', p_case_id, v_person_id,
        jsonb_build_object('task_id', v_task.id, 'role', v_task.claim_role, 'scope', v_task.claim_scope, 'rules', jsonb_build_array('K-CLAIM'))
    );
    return sgn_internal.case_summary(p_case_id, v_person_id);
end;
$$;

comment on function api.task_claim(text, uuid) is
    '使用者動作「認領」：群組關卡（MIS 合規檢查、系統管理人執行）由一人認領後負責；被職責分離排除的人不能認領。'
    '回傳單張摘要。呼叫者：sgn_app。規則：K-CLAIM、K-SOD-DISTINCT、K-AUDITOR-INDEPENDENT';

-- ── 建立、修改、送審 ──

create function api.case_create(p_session text, p_process_type text, p_content jsonb, p_terms jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case_id uuid := sgn_internal.case_new(v_person_id, p_process_type, p_content, p_terms);
begin
    return sgn_internal.case_detail(v_case_id, v_person_id);
end;
$$;

comment on function api.case_create(text, text, jsonb, jsonb) is
    '使用者動作「儲存草稿」：建立申請單（版本 1）。內容由流程包整理（例如移除不需申請的欄位並提示）、分級；'
    '回傳申請單詳情，含提示、送審前要修正的錯誤與重疊檢查結果。呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-AUDIT-APPEND';

create function api.case_submit_new(p_session text, p_process_type text, p_content jsonb, p_terms jsonb, p_overlap_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case_id uuid := sgn_internal.case_new(v_person_id, p_process_type, p_content, p_terms);
begin
    perform sgn_internal.case_submit_draft(v_person_id, v_case_id, p_overlap_reason);
    return sgn_internal.case_detail(v_case_id, v_person_id);
end;
$$;

comment on function api.case_submit_new(text, text, jsonb, jsonb, text) is
    '使用者動作「送出申請」：建立並送審，同一個交易（送審失敗時不留下草稿）。部分重疊時必須帶理由。回傳申請單詳情。'
    '呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-VALIDITY-MAX、K-NO-BACKDATE、K-PRINCIPAL、K-OVERLAP-BLOCK、K-OVERLAP-REASON、K-RESOLVE-STAGE-START';

create function api.case_revise(p_session text, p_case_id uuid, p_content jsonb, p_terms jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_kind text;
begin
    perform sgn_internal.authorize(v_person_id, 'revise', v_case);
    perform sgn_internal.case_transition(p_case_id, 'revise');
    v_kind := sgn_internal.version_add(
        v_case,
        sgn_internal.version_prepare(v_case.process_type, p_content, p_terms),
        v_person_id
    );
    perform sgn_internal.audit_append(
        'case.revised', p_case_id, v_person_id,
        (
            select jsonb_build_object(
                'version', v.version,
                'content_sha256', encode(v.content_sha256, 'hex'),
                'version_sha256', encode(v.version_sha256, 'hex'),
                'tier', v.tier,
                'change_kind', v_kind
            )
            from sgn.case_version as v
            join sgn.request_case as c on c.id = v.case_id and c.current_version = v.version
            where v.case_id = p_case_id
        )
    );
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_revise(text, uuid, jsonb, jsonb) is
    '使用者動作「修改」：草稿或退回、撤回後的單產生新版本（每次修改一個版本），記下相對前一版是縮小還是擴大。'
    '只有申請人。回傳申請單詳情。呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-NO-REGRESS、K-CHANGE-EXPAND、K-AUDIT-APPEND';

create function api.case_submit(p_session text, p_case_id uuid, p_overlap_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    perform sgn_internal.case_submit_draft(v_person_id, p_case_id, p_overlap_reason);
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_submit(text, uuid, text) is
    '使用者動作「送審」：草稿送審，或退回、撤回後重送（只做縮小就從退回的那一關繼續，否則從第一關重簽）。'
    '回傳申請單詳情。呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-RETURN、K-RECALL、K-OVERLAP-BLOCK、K-OVERLAP-REASON、K-VALIDITY-MAX';
