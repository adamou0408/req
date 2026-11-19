-- 決定（核准、退回）。三種證明方式共用同一套 sgn_internal.decision_prepare 與 decision_commit：
--   (a) api.case_decide_passkey       資料庫自己驗通行金鑰的 ES256 簽章
--   (b) api.case_decide_idp           資料庫自己驗身分提供者以挑戰值為 nonce 簽發的 ID token（RS256）
--   (c) api_verified.case_decide_passkey  驗證服務驗完簽章後呼叫；只有 sgn_probe_verifier 能執行
-- 規則：PRB-PROOF、PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-CHAIN

create table sgn.decision_proof (
    id uuid primary key default gen_random_uuid(),
    challenge_id uuid not null unique references sgn.auth_challenge (id),
    kind text not null check (kind in ('passkey', 'idp_stepup', 'verifier_passkey')),
    raw jsonb not null,
    raw_sha256 bytea not null,
    created_at timestamptz not null
);

-- 發決定挑戰值：由資料庫算出綁定的對象（單號、版本、內容雜湊、決定種類）。
create function api.challenge_issue(
    p_session text,
    p_case_id uuid,
    p_decision text,
    out challenge_id uuid,
    out challenge text,
    out binding jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_row sgn.auth_challenge;
begin
    if v_case.applicant_person_id = v_person_id then
        perform sgn_internal.raise_error('SELF_APPROVAL');
    end if;
    if v_case.approver_person_id is distinct from v_person_id then
        perform sgn_internal.raise_error('NOT_APPROVER');
    end if;
    if not exists (
        select 1 from sgn.state_transition where from_state = v_case.state and action = p_decision
    ) or p_decision not in ('approve', 'return') then
        perform sgn_internal.raise_error('STATE_TRANSITION', p_decision);
    end if;
    select jsonb_build_object(
        'case_id', v_case.id,
        'case_no', v_case.case_no,
        'version', v.version,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'decision', p_decision
    ) into binding
    from sgn.case_version v
    where v.case_id = v_case.id and v.version = v_case.current_version;
    v_row := sgn_internal.challenge_new('decision', binding, v_person_id);
    challenge_id := v_row.id;
    challenge := sgn_crypto.b64url_encode(v_row.challenge);
end;
$$;

comment on function api.challenge_issue(text, uuid, text) is
    '為一個決定發一次性挑戰值，綁定單號、內容版本雜湊與決定種類；只發給這張單的簽核人。呼叫者：sgn_probe_app。規則：PRB-PROOF、PRB-SELF、PRB-APPROVER';

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

-- 決定的後半。p_actor 必須是「驗過的證明」得出的人，不是後端說的人。
create function sgn_internal.decision_commit(
    p_challenge sgn.auth_challenge,
    p_actor uuid,
    p_proof_kind text,
    p_proof_raw jsonb
)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock((p_challenge.binding ->> 'case_id')::uuid);
    v_decision text := p_challenge.binding ->> 'decision';
    v_state text;
    v_proof_sha256 bytea := sha256(convert_to(p_proof_raw::text, 'UTF8'));
begin
    if p_actor = v_case.applicant_person_id then
        perform sgn_internal.raise_error('SELF_APPROVAL');
    end if;
    if p_actor is distinct from v_case.approver_person_id or p_actor is distinct from p_challenge.person_id then
        perform sgn_internal.raise_error('NOT_APPROVER');
    end if;
    perform sgn_internal.challenge_consume(p_challenge.id, 'decision');
    v_state := sgn_internal.case_transition(v_case.id, v_decision);
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at)
    values (p_challenge.id, p_proof_kind, p_proof_raw, v_proof_sha256, clock_timestamp());
    perform sgn_internal.audit_append(
        'case.' || v_decision,
        v_case.id,
        p_actor,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', p_challenge.binding ->> 'content_sha256',
            'challenge', sgn_crypto.b64url_encode(p_challenge.challenge),
            'proof_kind', p_proof_kind,
            'proof_sha256', encode(v_proof_sha256, 'hex')
        )
    );
    return v_state;
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
returns text
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
    '以通行金鑰的 assertion 做決定。誰做的決定由資料庫驗章後從憑證得出，不接受後端傳入的身分。呼叫者：sgn_probe_app。規則：PRB-PROOF、PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-CHAIN';

-- (b) 身分提供者再驗證
create function api.case_decide_idp(p_challenge_id uuid, p_decision text, p_id_token text)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.decision_prepare(p_challenge_id, p_decision);
begin
    return sgn_internal.decision_commit(
        v_challenge,
        sgn_internal.idp_token_verify(p_id_token, sgn_crypto.b64url_encode(v_challenge.challenge)),
        'idp_stepup',
        jsonb_build_object('id_token', p_id_token)
    );
end;
$$;

comment on function api.case_decide_idp(uuid, text, text) is
    '以身分提供者再驗證的 ID token（nonce＝挑戰值）做決定。誰做的決定由資料庫驗章後從 token 得出。呼叫者：sgn_probe_app。規則：PRB-PROOF、PRB-APPROVER、PRB-SELF、PRB-STATE、PRB-CHAIN';

-- (c) 獨立驗證服務。資料庫相信「這個憑證簽了這個挑戰值」，但人仍由資料庫從憑證對出，
-- 挑戰值的綁定、是否已用、簽核人資格仍由資料庫檢查。
create function api_verified.challenge_get(p_challenge_id uuid, out challenge text, out binding jsonb)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select sgn_crypto.b64url_encode(c.challenge), c.binding
    from sgn.auth_challenge c
    where c.id = p_challenge_id and c.purpose = 'decision'
$$;

comment on function api_verified.challenge_get(uuid) is
    '驗證服務取挑戰值原文，用來比對 clientDataJSON。呼叫者：sgn_probe_verifier。';

create function api_verified.passkey_get(p_credential_id text, out public_key text, out sign_count bigint)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select encode(k.public_key, 'base64'), k.sign_count
    from sgn.passkey_credential k
    where k.credential_id = sgn_crypto.b64url_decode(p_credential_id)
$$;

comment on function api_verified.passkey_get(text) is
    '驗證服務取通行金鑰的公鑰（未壓縮點，base64）與計數器。呼叫者：sgn_probe_verifier。';

create function api_verified.case_decide_passkey(
    p_challenge_id uuid,
    p_decision text,
    p_credential_id text,
    p_sign_count bigint,
    p_proof jsonb
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.decision_prepare(p_challenge_id, p_decision);
    v_cred sgn.passkey_credential;
begin
    select * into v_cred
    from sgn.passkey_credential
    where credential_id = sgn_crypto.b64url_decode(p_credential_id)
    for update;
    if v_cred.credential_id is null then
        perform sgn_internal.raise_error('PASSKEY_UNKNOWN');
    end if;
    if (p_sign_count <> 0 or v_cred.sign_count <> 0) and p_sign_count <= v_cred.sign_count then
        perform sgn_internal.raise_error('PASSKEY_COUNTER');
    end if;
    update sgn.passkey_credential set sign_count = p_sign_count where credential_id = v_cred.credential_id;
    return sgn_internal.decision_commit(v_challenge, v_cred.person_id, 'verifier_passkey', p_proof);
end;
$$;

comment on function api_verified.case_decide_passkey(uuid, text, text, bigint, jsonb) is
    '驗證服務確認「這把通行金鑰簽了這個挑戰值」後呼叫。資料庫不驗章，只檢查挑戰值、綁定、簽核人資格。呼叫者：sgn_probe_verifier。規則：PRB-PROOF、PRB-APPROVER、PRB-SELF';
