-- 簽的是「顯示摘要」，不是代碼（裁決 D75；紅隊第三輪 高-1）。
--
-- 根因：D68 之後簽進去的只有代碼（單號、內容版本雜湊、決定種類）。代碼的意義——主題包與欄位的名稱、級別、例外、
-- 重疊、與上一版的差異、申請人與被授權者的名字——由後端另外送（資料目錄、case_get 的欄位），沒有簽。
-- 被入侵的後端把「員工薪資：實發金額、薪轉帳號」改寫成「銷售訂單：訂單金額、通路別」、L4 改成 L2，
-- 簽核人看到的和簽下去的就不是同一件事。
--
-- 這一版：
--   1. 資料庫為每個決定產生一份標準化的顯示摘要（case_display）：單號、流程、版本、級別、申請人、被授權者與負責人
--      （內部 id 與畫面上的名字）、授權起迄、內容的顯示文字（流程包的 display_content hook：名稱、分級、條件說明）、
--      例外、重疊（display_overlap hook）、這位簽核人比較的基準版本與其顯示、誰縮小過、目前與下一關的名稱。
--      摘要裡只有字串、布林、null、陣列與物件，兩種語言的 RFC 8785 標準化結果一定相同。
--   2. 頁面只從這份摘要畫出決定畫面，並把它的雜湊（display_sha256）放進要簽的內容；資料庫驗章時用自己的資料
--      重算同一份摘要（看的人＝挑戰值發給的人）。後端改任何一個字，簽章就對不上，攻擊只剩「讓人簽不了」。
--   3. 縮小後核准：縮小後那一版的顯示（version_display）也簽進去。
--   4. 簽下去的摘要原文存在決定證明（decision_proof.display_snapshot，不進鏈；鏈上只有雜湊，D27 鏈上不放個資）。
-- D73（名字簽進去）併入本條。角色變更與金鑰背書的畫面同理，見 310。

-- ── 流程包的顯示 hook ──

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('display_content', 'jsonb', 'jsonb', false,
        '把內容換成簽核畫面要顯示的文字（名稱、分級、條件說明），只含字串、布林、null、陣列與物件。沒有登記：{raw: 內容}'),
    ('display_overlap', 'jsonb', 'jsonb', false,
        '把重疊的項目換成畫面要顯示的文字，規則同 display_content。沒有登記：原樣');

-- 流程包補登記一個 hook（不必重送整個流程類型的定義）。檢查同 register_process_type。
create function sgn_internal.register_hook(p_process_type text, p_hook text, p_fn text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_checked jsonb := sgn_internal.hooks_checked(jsonb_build_object(p_hook, p_fn));
begin
    update sgn.process_type set hooks = hooks || v_checked where code = p_process_type;
    if not found then
        perform sgn_internal.registration_fail('unknown process type ' || p_process_type);
    end if;
end;
$$;

create function sgn_sdk.register_hook(p_process_type text, p_hook text, p_fn text)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_hook(p_process_type, p_hook, p_fn)
$$;

create function sgn_internal.hook_display_content(p_process_type text, p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'display_content');
    v_result jsonb;
begin
    if v_fn is null then
        return jsonb_build_object('raw', p_content);
    end if;
    execute format('select %s($1)', v_fn::regprocedure::regproc) into v_result using p_content;
    return v_result;
end;
$$;

create function sgn_internal.hook_display_overlap(p_process_type text, p_items jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'display_overlap');
    v_result jsonb;
begin
    if v_fn is null then
        return p_items;
    end if;
    execute format('select %s($1)', v_fn::regprocedure::regproc) into v_result using p_items;
    return v_result;
end;
$$;

-- ── 摘要的組成 ──

-- 一個人在畫面上的樣子：內部 id 與名字（名字一律經 person_name，同名的人有區分）。
create function sgn_internal.person_display(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case when p_person_id is not null then jsonb_build_object('id', p_person_id::text, 'name', sgn_internal.person_name(p_person_id)) end
$$;

-- 被授權者：id、名字、種類、負責人。
create function sgn_internal.principal_display(p_principal_id text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'id', x.id::text,
        'name', x.name,
        'kind', x.kind,
        'owner', sgn_internal.person_display(x.owner_person_id)
    )
    from sgn.principal as x
    where x.id::text = p_principal_id
$$;

-- 一個版本（或縮小後的那一版）在畫面上的樣子：被授權者、授權起迄、內容的顯示文字。
create function sgn_internal.version_display(p_process_type text, p_content jsonb, p_terms jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'principal', sgn_internal.principal_display(p_terms ->> 'principal_id'),
        'validity', jsonb_build_object('from', p_terms ->> 'valid_from', 'to', p_terms ->> 'valid_to'),
        'content', sgn_internal.hook_display_content(p_process_type, p_content)
    )
$$;

-- 這張單目前的重疊：草稿與退回的單即時重算，其餘取最近一次送審時的檢查（與 case_detail 相同）。
create function sgn_internal.case_overlap_current(p_case_id uuid)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_overlap jsonb;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    if v_case.state in ('draft', 'returned') and sgn_internal.process_option(v_case.process_type, 'overlap_check') then
        return sgn_internal.hook_overlaps(
            v_case.process_type,
            p_case_id,
            (select v.content from sgn.case_version as v where v.case_id = p_case_id and v.version = v_case.current_version)
        ) || jsonb_build_object('reason', null, 'version', v_case.current_version);
    end if;
    select jsonb_build_object('level', o.level, 'items', o.items, 'reason', o.reason, 'version', o.version) into v_overlap
    from sgn.case_overlap as o
    where o.case_id = p_case_id
    order by o.id desc
    limit 1;
    return v_overlap;
end;
$$;

-- 比較的基準：看的人自己上次做決定的那一版；他沒決定過，就用任何人最近一次做決定的那一版（比目前版本舊的）。
create function sgn_internal.case_baseline_version(p_case_id uuid, p_viewer uuid, p_current int)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        (select max(t.decided_version) from sgn.case_task as t
         where t.case_id = p_case_id and t.assignee_person_id = p_viewer and t.decided_version < p_current),
        (select max(t.decided_version) from sgn.case_task as t
         where t.case_id = p_case_id and t.decided_version < p_current)
    )
$$;

-- 目前開著的那一關與它之後的下一關（畫面上「核准後送到哪裡」）。
create function sgn_internal.case_stage_display(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    with ordered as (
        select ps.name, s.status, row_number() over (order by s.id) as n
        from sgn.case_stage as s
        join sgn.policy_stage as ps on ps.policy_id = s.policy_id and ps.seq = s.seq
        where s.case_id = p_case_id
    ),
    current_stage as (
        select o.name, o.n from ordered as o where o.status in ('open', 'halted') order by o.n limit 1
    )
    select jsonb_build_object(
        'current', (select c.name from current_stage as c),
        'next', (select o.name from ordered as o join current_stage as c on o.n = c.n + 1)
    )
$$;

-- 決定畫面的顯示摘要（唯一來源；頁面只從它畫出決定畫面，web/pages/case.js）。p_viewer：看的人（基準版本依他而定）。
create function sgn_internal.case_display(p_case_id uuid, p_viewer uuid)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_version sgn.case_version;
    v_base sgn.case_version;
    v_overlap jsonb := sgn_internal.case_overlap_current(p_case_id);
    v_reducer sgn.case_version;
begin
    select * into v_case from sgn.request_case where id = p_case_id;
    select * into v_version from sgn.case_version where case_id = p_case_id and version = v_case.current_version;
    select * into v_base from sgn.case_version
    where case_id = p_case_id and version = sgn_internal.case_baseline_version(p_case_id, p_viewer, v_case.current_version);
    select * into v_reducer from sgn.case_version
    where case_id = p_case_id and version > v_base.version and change_kind = 'reduce' and created_by <> v_case.applicant_person_id
    order by version desc
    limit 1;
    return sgn_internal.version_display(v_case.process_type, v_version.content, v_version.terms) || jsonb_build_object(
        'case_no', v_case.case_no::text,
        'process', (select jsonb_build_object('code', t.code, 'name', t.name) from sgn.process_type as t where t.code = v_case.process_type),
        'version', v_version.version::text,
        'version_sha256', encode(v_version.version_sha256, 'hex'),
        'tier', (
            select jsonb_build_object('code', r.tier_code, 'name', r.name)
            from sgn.process_tier as r
            where r.process_type = v_case.process_type and r.tier_code = v_version.tier
        ),
        'applicant', sgn_internal.person_display(v_case.applicant_person_id),
        'exceptions', (
            select coalesce(jsonb_agg(jsonb_build_object('id', x.id::text, 'rule_code', x.rule_code) order by x.id), '[]'::jsonb)
            from sgn.exception_record as x
            where x.case_id = p_case_id
        ),
        'overlap', case when v_overlap is not null then jsonb_build_object(
            'level', v_overlap ->> 'level',
            'reason', v_overlap ->> 'reason',
            'items', sgn_internal.hook_display_overlap(v_case.process_type, coalesce(v_overlap -> 'items', '[]'::jsonb))
        ) end,
        'baseline', case when v_base.version is not null then
            sgn_internal.version_display(v_case.process_type, v_base.content, v_base.terms)
            || jsonb_build_object('version', v_base.version::text)
        end,
        'reduced_by', case when v_reducer.version is not null then jsonb_build_object(
            'name', sgn_internal.person_name(v_reducer.created_by),
            'version', v_reducer.version::text
        ) end,
        'stage', sgn_internal.case_stage_display(p_case_id)
    );
end;
$$;

-- ── 決定要簽的內容：代碼＋顯示摘要的雜湊 ──

alter table sgn.decision_proof
    add column display_snapshot jsonb;

comment on column sgn.decision_proof.display_snapshot is '簽下去的顯示摘要原文（D75）。鏈上只有它的雜湊（鏈上不放個資，D27）。';

-- 縮小後那一版的顯示（給簽核人看、也簽進去）。p_input 是 decision_input 整理過的縮小後內容。
create function sgn_internal.reduced_display(p_case_id uuid, p_input jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.version_display(c.process_type, p_input -> 'content', p_input -> 'terms')
    from sgn.request_case as c
    where c.id = p_case_id
$$;

-- 要簽的內容（唯一來源；瀏覽器端見 web/lib/signing.js 的 decisionContent）：
-- {version_sha256, display_sha256, input}；縮小後核准的 input 另有縮小後那一版的 display_sha256。
-- 顯示摘要由資料庫依挑戰值發給的人重算（驗章時才算，用的是當下自己的資料）。
create function sgn_internal.decision_signed_payload(p_challenge sgn.auth_challenge)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.decision_signed_content(p_challenge.binding)
        || jsonb_build_object(
            'display_sha256', encode(sgn_internal.jcs_sha256(
                sgn_internal.case_display((p_challenge.binding ->> 'case_id')::uuid, p_challenge.person_id)
            ), 'hex')
        )
        || case when p_challenge.binding ->> 'decision' = 'approve_reduced' then jsonb_build_object(
            'input', (sgn_internal.decision_signed_content(p_challenge.binding) -> 'input') || jsonb_build_object(
                'display_sha256', encode(sgn_internal.jcs_sha256(
                    sgn_internal.reduced_display((p_challenge.binding ->> 'case_id')::uuid, p_challenge.binding -> 'input')
                ), 'hex')
            )
        ) else '{}'::jsonb end
$$;

-- 這個決定的挑戰值（同 250_signing.sql 的簽章；改由 decision_signed_payload 重算）。
create or replace function sgn_internal.decision_signed_challenge(p_challenge sgn.auth_challenge)
returns bytea
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.signing_challenge(
        p_challenge.purpose,
        p_challenge.binding ->> 'case_no',
        sgn_internal.decision_signed_payload(p_challenge),
        p_challenge.binding ->> 'decision',
        p_challenge.challenge
    )
$$;

-- 發決定的一次性亂數（同 250_signing.sql 的簽章）。多回傳 display：縮小後那一版的顯示（其他決定為 null）。
create or replace function api.challenge_issue(p_session text, p_case_id uuid, p_decision text, p_input jsonb)
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
        'case_no', v_case.case_no::text,
        'version', v.version,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex'),
        'decision', p_decision,
        'input', v_input,
        'input_sha256', encode(sgn_internal.jcs_sha256(v_input), 'hex')
    ) into v_binding
    from sgn.case_version as v
    where v.case_id = v_case.id and v.version = v_case.current_version;
    v_row := sgn_internal.challenge_new('case.decision', v_binding, v_person_id);
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'nonce', sgn_internal.b64url_encode(v_row.challenge),
        'input', v_input,
        'display', case when p_decision = 'approve_reduced' then sgn_internal.reduced_display(v_case.id, v_input) end,
        'expires_at', v_row.expires_at
    );
end;
$$;

comment on function api.challenge_issue(text, uuid, text, jsonb) is
    '使用者動作「核准、縮小後核准、退回、駁回、撤回、執行完成」的第一步：檢查並整理決定的輸入（原因、縮小後的內容），'
    '發一次性亂數；縮小後核准另回傳縮小後那一版的顯示（display，畫面只從它畫出要簽的縮小內容）。'
    '瀏覽器用 nonce 和畫面上的單號、內容版本、顯示摘要、決定種類、輸入自己算出挑戰值再簽（web/lib/signing.js）；'
    '這裡不回傳可以直接簽的值。第二步是 case_decide_passkey。'
    '呼叫者：sgn_app。規則：K-DECISION-PROOF、K-DISPLAY-SIGNED、K-VERSION-BOUND、K-DECISION-ELIGIBLE、K-SOD-APPLICANT、'
    'K-CHANGE-REDUCE、K-RETURN、K-REJECT、K-RECALL、K-FULFIL';

-- 決定的後半（同 250_signing.sql 的簽章）。和前一版的差別：簽下去的內容含顯示摘要的雜湊、摘要原文存進決定證明。
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
    v_signed bytea := sgn_internal.decision_signed_challenge(p_challenge);
    v_payload jsonb := sgn_internal.decision_signed_payload(p_challenge);
begin
    perform sgn_internal.authorize(p_actor, v_decision, v_case);
    perform sgn_internal.challenge_owner_check(p_challenge, p_actor);
    perform sgn_internal.challenge_consume(p_challenge.id, p_challenge.purpose);
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge, display_snapshot)
    values (
        p_challenge.id, p_proof_kind, p_proof_raw, v_proof_sha256, sgn_internal.now(), v_signed,
        sgn_internal.case_display(v_case.id, p_challenge.person_id)
    );
    perform sgn_internal.audit_append(
        'case.' || v_decision,
        v_case.id,
        p_actor,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', p_challenge.binding ->> 'content_sha256',
            'version_sha256', p_challenge.binding ->> 'version_sha256',
            'input_sha256', p_challenge.binding ->> 'input_sha256',
            'challenge', sgn_internal.b64url_encode(v_signed),
            'nonce', sgn_internal.b64url_encode(p_challenge.challenge),
            'signed', jsonb_build_object(
                'purpose', p_challenge.purpose,
                'ref', p_challenge.binding ->> 'case_no',
                'content', v_payload,
                'decision', v_decision
            ),
            'proof_kind', p_proof_kind,
            'proof_sha256', encode(v_proof_sha256, 'hex'),
            'open_exceptions', (
                select coalesce(jsonb_agg(x.id order by x.id), '[]'::jsonb)
                from sgn.exception_record as x
                where x.case_id = v_case.id
            ),
            'rules', jsonb_build_array('K-DECISION-PROOF', 'K-DISPLAY-SIGNED', 'K-VERSION-BOUND', 'K-DECISION-ELIGIBLE')
        )
    );
    perform sgn_internal.notify(
        'decision.recorded', array[p_actor], v_case.id,
        jsonb_build_object('case_no', v_case.case_no, 'decision', v_decision)
    );
    perform sgn_internal.decision_apply(v_case, p_actor, p_challenge);
    return sgn_internal.case_summary(v_case.id, p_actor);
end;
$$;

create or replace function api.case_decide_passkey(
    p_challenge_id uuid,
    p_decision text,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.decision_prepare(p_challenge_id, p_decision);
begin
    return sgn_internal.decision_commit(
        v_challenge,
        sgn_internal.signature_verify(
            v_challenge,
            v_challenge.binding ->> 'case_no',
            sgn_internal.decision_signed_payload(v_challenge),
            p_decision,
            p_credential_id,
            p_authenticator_data,
            p_client_data_json,
            p_signature
        ),
        'passkey',
        sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature)
    );
end;
$$;

comment on function api.case_decide_passkey(uuid, text, text, text, text, text) is
    '使用者動作「核准、縮小後核准、退回、駁回、撤回、執行完成」的第二步：以通行金鑰的 assertion 做決定。'
    '資料庫用自己的紀錄重算挑戰值（用途、單號、內容版本雜湊、顯示摘要的雜湊、決定種類、輸入、nonce）比對簽章，'
    '顯示摘要依挑戰值發給的人、以資料庫當下的資料重算；誰做的決定從憑證得出，不接受後端傳入的身分。回傳單張摘要。'
    '呼叫者：sgn_app。規則：K-DECISION-PROOF、K-DISPLAY-SIGNED、K-DECISION-ELIGIBLE、K-SOD-APPLICANT、K-VERSION-BOUND';

-- 申請單詳情（同 180_views.sql 的簽章）：多了 display（決定畫面的顯示摘要，依看的人）；重疊改用 case_overlap_current。
create or replace function sgn_internal.case_detail(p_case_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.case_summary(p_case_id, p_person_id) || jsonb_build_object(
        'stages', sgn_internal.case_stages_view(p_case_id),
        'versions', sgn_internal.case_versions_view(p_case_id),
        'overlap', sgn_internal.case_overlap_current(p_case_id),
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
        'display', sgn_internal.case_display(p_case_id, p_person_id)
    );
end;
$$;

select sgn_internal.register_rule(
    'K-DISPLAY-SIGNED',
    '簽的是顯示摘要，不是代碼（D75）：資料庫為每個決定產生標準化的顯示摘要（名稱、級別、例外、重疊、版本差異、'
    '申請人與被授權者及負責人的名字），頁面只從摘要畫出決定畫面並把它的雜湊簽進去，資料庫驗章時用自己的資料重算；'
    '縮小後核准的縮小內容、角色變更、通行金鑰背書的畫面同理',
    null,
    'full',
    null
);
