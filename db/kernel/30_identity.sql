-- 身分證明：挑戰值、身分提供者的 ID token、工作階段、通行金鑰。
-- 原則：後端只轉送原始的證明；「是誰」一律由資料庫驗章後自己決定。

-- 身分提供者的公開金鑰（RS256）。由 migration（owner）匯入；輪替流程不在探針範圍。
create table sgn.idp_key (
    kid text primary key,
    issuer text not null,
    n bytea not null,
    e bytea not null,
    imported_at timestamptz not null default sgn_internal.now()
);

-- 一次性挑戰值。用途：session（登入）、passkey_register（登記通行金鑰）、decision（做決定）。
create table sgn.auth_challenge (
    id uuid primary key default gen_random_uuid(),
    purpose text not null check (purpose in ('session', 'passkey_register', 'decision')),
    challenge bytea not null unique,
    binding jsonb not null,
    person_id uuid references sgn.person (id),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    consumed_at timestamptz
);

-- closed_at：登出時寫入，之後這個工作階段代碼一律無效（PRB-SESSION）。
create table sgn.auth_session (
    token_hash bytea primary key,
    person_id uuid not null references sgn.person (id),
    created_at timestamptz not null,
    expires_at timestamptz not null,
    closed_at timestamptz,
    id_token_sha256 bytea not null
);

create table sgn.passkey_credential (
    credential_id bytea primary key,
    person_id uuid not null references sgn.person (id),
    public_key bytea not null check (length(public_key) = 65),
    sign_count bigint not null default 0,
    registered_at timestamptz not null,
    registration_token_sha256 bytea not null
);

create function sgn_internal.challenge_new(p_purpose text, p_binding jsonb, p_person_id uuid)
returns sgn.auth_challenge
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row sgn.auth_challenge;
    v_now timestamptz := sgn_internal.now();
begin
    insert into sgn.auth_challenge (purpose, challenge, binding, person_id, created_at, expires_at)
    values (
        p_purpose,
        sgn_internal.gen_random_bytes(32),
        p_binding,
        p_person_id,
        v_now,
        v_now + make_interval(secs => sgn_internal.setting_int('challenge.ttl_seconds'))
    )
    returning * into v_row;
    return v_row;
end;
$$;

-- 取出並鎖住挑戰值，確認用途、未過期、未使用。鎖到交易結束，同一個挑戰值的併發使用會排隊。
create function sgn_internal.challenge_check(p_challenge_id uuid, p_purpose text)
returns sgn.auth_challenge
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row sgn.auth_challenge;
begin
    select * into v_row from sgn.auth_challenge where id = p_challenge_id for update;
    if v_row.id is null then
        perform sgn_internal.raise_error('CHALLENGE_UNKNOWN');
    end if;
    if v_row.purpose <> p_purpose then
        perform sgn_internal.raise_error('CHALLENGE_PURPOSE');
    end if;
    if v_row.consumed_at is not null then
        perform sgn_internal.raise_error('CHALLENGE_USED');
    end if;
    if v_row.expires_at < sgn_internal.now() then
        perform sgn_internal.raise_error('CHALLENGE_EXPIRED');
    end if;
    return v_row;
end;
$$;

-- 檢查並標記為已使用。驗證失敗時整個交易回滾，挑戰值也跟著回到未使用。
create function sgn_internal.challenge_consume(p_challenge_id uuid, p_purpose text)
returns sgn.auth_challenge
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_row sgn.auth_challenge := sgn_internal.challenge_check(p_challenge_id, p_purpose);
begin
    update sgn.auth_challenge set consumed_at = sgn_internal.now() where id = p_challenge_id;
    return v_row;
end;
$$;

-- 驗 ID token：簽章（只接受 RS256 與登記的金鑰）、iss、aud、exp、iat 新鮮度、nonce，
-- 再把 federated_claims 對到同步進來、仍在職的人。回傳內部人員 id。
create function sgn_internal.idp_token_verify(p_jwt text, p_expected_nonce text)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_jwt record;
    v_key sgn.idp_key;
    v_now numeric := extract(epoch from sgn_internal.now());
    v_person_id uuid;
begin
    v_jwt := sgn_internal.jwt_split(p_jwt);
    if v_jwt.header is null or v_jwt.header ->> 'alg' is distinct from 'RS256' then
        perform sgn_internal.raise_error('TOKEN_INVALID', 'alg');
    end if;
    select * into v_key from sgn.idp_key where kid = v_jwt.header ->> 'kid';
    if v_key.kid is null
       or not sgn_internal.rs256_verify(v_jwt.signing_input, v_jwt.signature, v_key.n, v_key.e) then
        perform sgn_internal.raise_error('TOKEN_INVALID', 'signature');
    end if;
    if v_jwt.payload ->> 'iss' is distinct from v_key.issuer
       or v_key.issuer is distinct from sgn_internal.setting_text('idp.issuer')
       or not (
           v_jwt.payload -> 'aud' = to_jsonb(sgn_internal.setting_text('idp.client_id'))
           or v_jwt.payload -> 'aud' @> jsonb_build_array(sgn_internal.setting_text('idp.client_id'))
       )
       or (v_jwt.payload ->> 'exp')::numeric <= v_now then
        perform sgn_internal.raise_error('TOKEN_INVALID', 'claims');
    end if;
    if (v_jwt.payload ->> 'iat')::numeric < v_now - sgn_internal.setting_int('idp.token_max_age_seconds') then
        perform sgn_internal.raise_error('TOKEN_STALE');
    end if;
    if v_jwt.payload ->> 'nonce' is distinct from p_expected_nonce then
        perform sgn_internal.raise_error('TOKEN_NONCE');
    end if;
    if v_jwt.payload #>> '{federated_claims,connector_id}' is distinct from sgn_internal.setting_text('idp.connector_id') then
        perform sgn_internal.raise_error('PERSON_UNKNOWN', 'connector');
    end if;
    v_person_id := sgn_internal.person_by_identity(
        sgn_internal.setting_text('idp.directory_source'),
        v_jwt.payload #>> '{federated_claims,user_id}'
    );
    if v_person_id is null then
        perform sgn_internal.raise_error('PERSON_UNKNOWN');
    end if;
    return v_person_id;
end;
$$;

create function sgn_internal.session_person(p_session text)
returns uuid
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid;
begin
    select s.person_id into v_person_id
    from sgn.auth_session s
    join sgn.person p on p.id = s.person_id
    where s.token_hash = sha256(convert_to(coalesce(p_session, ''), 'UTF8'))
      and s.expires_at > sgn_internal.now()
      and s.closed_at is null
      and p.active;
    if v_person_id is null then
        perform sgn_internal.raise_error('SESSION_INVALID');
    end if;
    return v_person_id;
end;
$$;

-- ── 工作階段 ──

create function api.session_begin()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_new('session', '{}'::jsonb, null);
begin
    return jsonb_build_object(
        'challenge_id', v_challenge.id,
        'nonce', sgn_internal.b64url_encode(v_challenge.challenge)
    );
end;
$$;

comment on function api.session_begin() is
    '開始登入：發一次性 nonce，後端把它放進導向身分提供者的授權請求。呼叫者：sgn_app（後端 /auth/login）。規則：PRB-PROOF';

create function api.session_open(p_challenge_id uuid, p_id_token text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'session');
    v_person_id uuid := sgn_internal.idp_token_verify(p_id_token, sgn_internal.b64url_encode(v_challenge.challenge));
    v_token text := sgn_internal.b64url_encode(sgn_internal.gen_random_bytes(32));
begin
    insert into sgn.auth_session (token_hash, person_id, created_at, expires_at, id_token_sha256)
    values (
        sha256(convert_to(v_token, 'UTF8')),
        v_person_id,
        sgn_internal.now(),
        sgn_internal.now() + make_interval(secs => sgn_internal.setting_int('session.ttl_seconds')),
        sha256(convert_to(p_id_token, 'UTF8'))
    );
    perform sgn_internal.audit_append('session.opened', null, v_person_id, '{}'::jsonb);
    return jsonb_build_object('session_token', v_token, 'person_id', v_person_id);
end;
$$;

comment on function api.session_open(uuid, text) is
    '完成登入：資料庫自己驗 ID token（RS256、iss、aud、exp、iat、nonce）並對到人員，回傳工作階段代碼。'
    '呼叫者：sgn_app（後端 /auth/oidc/callback）。規則：PRB-PROOF';

-- 登出：讓資料庫裡的工作階段失效。已失效或不存在的代碼回 closed=false，不丟錯（登出要能重複按）。
create function api.session_close(p_session text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid;
begin
    update sgn.auth_session
    set closed_at = sgn_internal.now()
    where token_hash = sha256(convert_to(coalesce(p_session, ''), 'UTF8'))
      and closed_at is null
      and expires_at > sgn_internal.now()
    returning person_id into v_person_id;
    if v_person_id is not null then
        perform sgn_internal.audit_append('session.closed', null, v_person_id, '{}'::jsonb);
    end if;
    return jsonb_build_object('closed', v_person_id is not null);
end;
$$;

comment on function api.session_close(text) is
    '登出：資料庫裡的工作階段立即失效，之後同一個代碼呼叫任何 function 都是 SESSION_INVALID。'
    '呼叫者：sgn_app（後端 /auth/logout）。規則：PRB-SESSION';

-- ── 通行金鑰登記 ──
-- 信任來源：身分提供者的再驗證。ID token 的 nonce 必須等於 b64url(sha256(挑戰值 || 公鑰 SPKI))，
-- 所以這張 token 只能用來登記這一把公鑰。

create function api.passkey_register_begin(p_session text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge := sgn_internal.challenge_new(
        'passkey_register',
        '{}'::jsonb,
        sgn_internal.session_person(p_session)
    );
begin
    return jsonb_build_object(
        'challenge_id', v_challenge.id,
        'challenge', sgn_internal.b64url_encode(v_challenge.challenge)
    );
end;
$$;

comment on function api.passkey_register_begin(text) is
    '開始登記通行金鑰。回傳挑戰值；身分提供者再驗證時的 nonce = b64url(sha256(挑戰值 bytes || 公鑰 SPKI bytes))。呼叫者：sgn_app。規則：PRB-PROOF';

create function api.passkey_register(
    p_challenge_id uuid,
    p_id_token text,
    p_credential_id text,
    p_public_key_spki text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge;
    v_spki bytea := sgn_internal.b64url_decode(p_public_key_spki);
    v_point bytea := sgn_internal.p256_spki_to_point(v_spki);
    v_person_id uuid;
begin
    v_challenge := sgn_internal.challenge_consume(p_challenge_id, 'passkey_register');
    v_person_id := sgn_internal.idp_token_verify(
        p_id_token,
        sgn_internal.b64url_encode(sha256(v_challenge.challenge || v_spki))
    );
    if v_person_id <> v_challenge.person_id then
        perform sgn_internal.raise_error('PERSON_UNKNOWN', 'token is for a different person');
    end if;
    if v_point is null
       or not sgn_internal.p256_on_curve(
           sgn_internal.bytes_to_int(substring(v_point from 2 for 32)),
           sgn_internal.bytes_to_int(substring(v_point from 34 for 32))
       ) then
        perform sgn_internal.raise_error('PASSKEY_KEY_INVALID');
    end if;
    insert into sgn.passkey_credential (credential_id, person_id, public_key, registered_at, registration_token_sha256)
    values (
        sgn_internal.b64url_decode(p_credential_id),
        v_person_id,
        v_point,
        sgn_internal.now(),
        sha256(convert_to(p_id_token, 'UTF8'))
    );
    perform sgn_internal.audit_append(
        'passkey.registered',
        null,
        v_person_id,
        jsonb_build_object(
            'credential_id', p_credential_id,
            'public_key_sha256', encode(sha256(v_point), 'hex'),
            'id_token_sha256', encode(sha256(convert_to(p_id_token, 'UTF8')), 'hex')
        )
    );
    return jsonb_build_object('credential_id', p_credential_id);
end;
$$;

comment on function api.passkey_register(uuid, text, text, text) is
    '登記通行金鑰（只收 ES256 / P-256 的 SPKI）。資料庫以 ID token 確認登記者本人，並確認 token 綁定這把公鑰。呼叫者：sgn_app（後端 /auth/oidc/callback）。規則：PRB-PROOF';

-- WebAuthn assertion 驗證：clientDataJSON、authenticatorData、ES256 簽章、計數器。
-- 回傳簽章者（憑證的擁有人）。p_expected_challenge 是資料庫自己存的挑戰值。
create function sgn_internal.webauthn_verify(
    p_expected_challenge bytea,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cred sgn.passkey_credential;
    v_auth bytea := sgn_internal.b64url_decode(p_authenticator_data);
    v_client_raw bytea := sgn_internal.b64url_decode(p_client_data_json);
    v_client jsonb;
    v_flags int;
    v_count bigint;
begin
    select * into v_cred
    from sgn.passkey_credential
    where credential_id = sgn_internal.b64url_decode(p_credential_id)
    for update;
    if v_cred.credential_id is null then
        perform sgn_internal.raise_error('PASSKEY_UNKNOWN');
    end if;
    begin
        v_client := convert_from(v_client_raw, 'UTF8')::jsonb;
    exception
        when others then
            perform sgn_internal.raise_error('PASSKEY_INVALID', 'clientDataJSON');
    end;
    if length(v_auth) < 37
       or v_client ->> 'type' is distinct from 'webauthn.get'
       or v_client ->> 'challenge' is distinct from sgn_internal.b64url_encode(p_expected_challenge)
       or v_client ->> 'origin' is distinct from sgn_internal.setting_text('webauthn.origin')
       or substring(v_auth from 1 for 32) <> sha256(convert_to(sgn_internal.setting_text('webauthn.rp_id'), 'UTF8')) then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'client data or rp id');
    end if;
    v_flags := get_byte(v_auth, 32);
    -- 0x01 使用者在場、0x04 使用者驗證（生物辨識或 PIN）。決定類一律要求兩者。
    if v_flags & 5 <> 5 then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'flags');
    end if;
    if not sgn_internal.es256_verify(
        v_auth || sha256(v_client_raw),
        sgn_internal.b64url_decode(p_signature),
        v_cred.public_key
    ) then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'signature');
    end if;
    v_count := sgn_internal.bytes_to_int(substring(v_auth from 34 for 4));
    if (v_count <> 0 or v_cred.sign_count <> 0) and v_count <= v_cred.sign_count then
        perform sgn_internal.raise_error('PASSKEY_COUNTER');
    end if;
    update sgn.passkey_credential set sign_count = v_count where credential_id = v_cred.credential_id;
    return v_cred.person_id;
end;
$$;
