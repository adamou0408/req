-- 決定（核准、退回）。證明方式共用同一套 sgn_internal.decision_prepare 與 decision_commit：
--   (a) api.case_decide_passkey       資料庫自己驗通行金鑰的 ES256 簽章（畫面走這條）
--   (b) api.case_decide_idp           資料庫自己驗身分提供者以挑戰值為 nonce 簽發的 ID token（RS256）；刻意不開路由
--   (c) 比較用的獨立驗證服務只裝在測試資料庫（db/testing/50_verifier.sql）
-- 規則：PRB-PROOF、PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-CHAIN、PRB-SYNC-GUARD

create table sgn.decision_proof (
    id uuid primary key default gen_random_uuid(),
    challenge_id uuid not null unique references sgn.auth_challenge (id),
    kind text not null check (kind in ('passkey', 'idp_stepup', 'verifier_passkey')),
    raw jsonb not null,
    raw_sha256 bytea not null,
    created_at timestamptz not null
);

-- 發決定挑戰值：由資料庫算出綁定的對象（單號、版本、內容雜湊、決定種類）。
-- 只有需要證明的動作（動作目錄的 needs_proof）才發；能不能做由授權入口決定。
create function api.challenge_issue(p_session text, p_case_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_binding jsonb;
    v_row sgn.auth_challenge;
begin
    if not exists (select 1 from sgn.action a where a.action = p_decision and a.needs_proof) then
        perform sgn_internal.raise_error('ACTION_UNKNOWN', p_decision);
    end if;
    perform sgn_internal.authorize(v_person_id, p_decision, v_case);
    select jsonb_build_object(
        'case_id', v_case.id,
        'case_no', v_case.case_no,
        'version', v.version,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'decision', p_decision
    ) into v_binding
    from sgn.case_version v
    where v.case_id = v_case.id and v.version = v_case.current_version;
    v_row := sgn_internal.challenge_new('decision', v_binding, v_person_id);
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'challenge', sgn_internal.b64url_encode(v_row.challenge),
        'binding', v_binding
    );
end;
$$;

comment on function api.challenge_issue(text, uuid, text) is
    '使用者動作「核准／退回」的第一步：發一次性挑戰值，綁定單號、內容版本雜湊與決定種類；只發給這張單的簽核人。'
    '第二步是 case_decide_passkey（WebAuthn 協定本身要求先拿挑戰值再簽）。呼叫者：sgn_app。規則：PRB-PROOF、PRB-SELF、PRB-APPROVER';

-- 決定的前半：鎖住並檢查挑戰值（用途、未用、未過期）、決定種類、內容沒變。在驗證明之前做，
-- 這樣重放與內容變更會得到明確的錯誤，而不是被計數器之類的次要檢查擋下。
create function sgn_internal.decision_prepare(p_challenge_id uuid, p_decision text)
returns sgn.auth_challenge
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_check(p_challenge_id, 'decision');
    v_case sgn.request_case := sgn_internal.case_lock((v_challenge.binding ->> 'case_id')::uuid);
    v_current_hash bytea;
begin
    if v_challenge.binding ->> 'decision' is distinct from p_decision then
        perform sgn_internal.raise_error('DECISION_MISMATCH');
    end if;
    select content_sha256 into v_current_hash
    from sgn.case_version
    where case_id = v_case.id and version = v_case.current_version;
    if v_case.current_version <> (v_challenge.binding ->> 'version')::int
       or encode(v_current_hash, 'hex') <> v_challenge.binding ->> 'content_sha256' then
        perform sgn_internal.raise_error('CONTENT_CHANGED');
    end if;
    return v_challenge;
end;
$$;

-- 決定的後半。p_actor 必須是「驗過的證明」得出的人，不是後端說的人；資格由授權入口對這個人判定。
create function sgn_internal.decision_commit(
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
    perform sgn_internal.case_transition(v_case.id, v_decision);
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at)
    values (p_challenge.id, p_proof_kind, p_proof_raw, v_proof_sha256, sgn_internal.now());
    perform sgn_internal.audit_append(
        'case.' || v_decision,
        v_case.id,
        p_actor,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', p_challenge.binding ->> 'content_sha256',
            'challenge', sgn_internal.b64url_encode(p_challenge.challenge),
            'proof_kind', p_proof_kind,
            'proof_sha256', encode(v_proof_sha256, 'hex'),
            'open_exceptions', (
                select coalesce(jsonb_agg(x.id order by x.id), '[]'::jsonb)
                from sgn.exception_record x
                where x.case_id = v_case.id
            )
        )
    );
    return sgn_internal.case_summary(v_case.id, p_actor);
end;
$$;

-- (a) 通行金鑰
create function api.case_decide_passkey(
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
        sgn_internal.webauthn_verify(v_challenge.challenge, p_credential_id, p_authenticator_data, p_client_data_json, p_signature),
        'passkey',
        jsonb_build_object(
            'credential_id', p_credential_id,
            'authenticator_data', p_authenticator_data,
            'client_data_json', p_client_data_json,
            'signature', p_signature
        )
    );
end;
$$;

comment on function api.case_decide_passkey(uuid, text, text, text, text, text) is
    '使用者動作「核准／退回」的第二步：以通行金鑰的 assertion 做決定。誰做的決定由資料庫驗章後從憑證得出，'
    '不接受後端傳入的身分。回傳單張摘要。呼叫者：sgn_app。規則：PRB-PROOF、PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-CHAIN';

-- (b) 身分提供者再驗證
create function api.case_decide_idp(p_challenge_id uuid, p_decision text, p_id_token text)
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
        sgn_internal.idp_token_verify(p_id_token, sgn_internal.b64url_encode(v_challenge.challenge)),
        'idp_stepup',
        jsonb_build_object('id_token', p_id_token)
    );
end;
$$;

comment on function api.case_decide_idp(uuid, text, text) is
    '以身分提供者再驗證的 ID token（nonce＝挑戰值）做決定。誰做的決定由資料庫驗章後從 token 得出。'
    '刻意不開路由（等於只靠密碼）；只有資料庫測試使用。呼叫者：sgn_app。規則：PRB-PROOF、PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-CHAIN';

