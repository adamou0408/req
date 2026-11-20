-- 通行金鑰的登記（裁決 D65；紅隊第二輪 高-3）。
--
-- 根因：登記只靠一次身分提供者的再驗證，而再驗證的 nonce 由後端決定。被入侵的後端可以在使用者下一次登入時，
-- 把 nonce 換成綁定攻擊者公鑰的值，替使用者登記攻擊者的金鑰，之後以他的名義核准。不需要舊金鑰同意，也不通知本人。
--
-- 這一版：
--   1. 身分提供者再驗證之後（api.passkey_register，簽章不變）只建立「待核准的登記」，金鑰還不能用。
--   2. 核准的方式只有一種入口（passkey_endorse_passkey），以通行金鑰簽 purpose = passkey.enrollment 的挑戰值，
--      內容綁定新金鑰的指紋與兩邊畫面顯示的六位數短碼：
--        - 本人已有生效的金鑰：用舊金鑰核准。
--        - 第一把金鑰（新到職、遺失全部裝置）：由另一個人背書——本人的主管（找主管的唯一入口，含冷卻期）
--          或持有登記人角色（參數 passkey.registrar_role）的人；背書人不得是本人，也不得持有不能做決定的角色。
--   3. 核准後有冷卻期（passkey.cooling_workdays 個營業日）才能簽章；登記、背書、生效都進鏈，並通知本人與主管。
--   4. 系統的第一位登記人在安裝時由資料庫擁有者建立（passkey_bootstrap，只有 owner 能執行），留下事件。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('passkey.cooling_workdays', 'integer', '1', '{}',
        '新登記的通行金鑰核准後，幾個營業日後才能用來簽章（期間內通知本人與主管，可以發現不是本人登記的金鑰）'),
    ('passkey.registrar_role', 'text', '"passkey_registrar"', '{}',
        '可以替別人的第一把通行金鑰背書的角色（本人的主管也可以）');

insert into sgn.error_catalog (code, message, http_status) values
    ('PASSKEY_ENROLLMENT_UNKNOWN', '沒有這筆通行金鑰登記', 404),
    ('PASSKEY_ENROLLMENT_STATE', '這筆通行金鑰登記已經處理過了', 409),
    ('PASSKEY_ENDORSER_NOT_ALLOWED', '你不能核准這把通行金鑰：本人要用已生效的舊金鑰，第一把金鑰要由本人的主管或登記人背書', 403),
    ('PASSKEY_BOOTSTRAP_DONE', '已經有登記人，第一位登記人只能在安裝時建立一次', 409);

select sgn_internal.register_role('passkey_registrar', '通行金鑰登記人', 'control', 'manual', null, null, null);

create table sgn.passkey_enrollment (
    id uuid primary key default gen_random_uuid(),
    person_id uuid not null references sgn.person (id),
    credential_id bytea not null unique,
    public_key bytea not null check (length(public_key) = 65),
    registration_token_sha256 bytea not null,
    requested_at timestamptz not null,
    requested_seq bigint not null,
    status text not null check (status in ('pending', 'approved')),
    endorsed_by uuid references sgn.person (id),
    endorsed_at timestamptz,
    endorsed_seq bigint,
    endorsement_challenge_id uuid references sgn.auth_challenge (id),
    check ((status = 'approved') = (endorsed_by is not null and endorsed_seq is not null and endorsement_challenge_id is not null))
);

-- ── 共用 ──

-- 六位數短碼：指紋（hex）前 8 位當整數取後六位。瀏覽器端見 web/lib/signing.js 的 shortCode。
create function sgn_internal.passkey_short_code(p_fingerprint text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select lpad((('x' || lpad(substr(p_fingerprint, 1, 8), 16, '0'))::bit(64)::bigint % 1000000)::text, 6, '0')
$$;

-- 這個人現在有沒有可以簽章的金鑰（已過冷卻期）。
create function sgn_internal.passkey_usable_count(p_person_id uuid)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select count(*)::int from sgn.passkey_credential as k where k.person_id = p_person_id and k.usable_from <= sgn_internal.now()
$$;

-- 背書時要簽的內容：誰的金鑰、哪一把（指紋）、兩邊畫面對照的短碼。
create function sgn_internal.enrollment_signed_content(p_enrollment sgn.passkey_enrollment)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'person_id', p_enrollment.person_id,
        'person_name', sgn_internal.person_name(p_enrollment.person_id),
        'credential_id', sgn_internal.b64url_encode(p_enrollment.credential_id),
        'public_key_sha256', encode(sha256(p_enrollment.public_key), 'hex'),
        'short_code', sgn_internal.passkey_short_code(encode(sha256(p_enrollment.public_key), 'hex'))
    )
$$;

-- 授權檢查的唯一入口（通行金鑰核准的版本；與申請單、角色變更的版本同名，以第三個參數的型別區分）。
-- 回傳拒絕代碼；可以時回 null。動作只有 passkey.endorse。規則：K-PASSKEY-ENROLL、K-AUDITOR-INDEPENDENT
create function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_enrollment sgn.passkey_enrollment)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_action <> 'passkey.endorse' then 'ACTION_UNKNOWN'
        when p_enrollment.id is null then 'PASSKEY_ENROLLMENT_UNKNOWN'
        when p_enrollment.status <> 'pending' then 'PASSKEY_ENROLLMENT_STATE'
        when sgn_internal.passkey_usable_count(p_person_id) = 0 then 'PASSKEY_ENDORSER_NOT_ALLOWED'
        when p_person_id = p_enrollment.person_id then null
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then 'DECIDER_ROLE_EXCLUDED'
        when (sgn_internal.resolve_manager(p_enrollment.person_id)).manager_person_id is not distinct from p_person_id then null
        when sgn_internal.has_role(p_person_id, sgn_internal.setting_text('passkey.registrar_role')) then null
        else 'PASSKEY_ENDORSER_NOT_ALLOWED'
    end
$$;

-- 不允許就丟錯（通行金鑰核准的版本）。
create function sgn_internal.authorize(p_person_id uuid, p_action text, p_enrollment sgn.passkey_enrollment)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_denial text := sgn_internal.denial_reason(p_person_id, p_action, p_enrollment);
begin
    if v_denial is not null then
        perform sgn_internal.raise_error(v_denial, p_action);
    end if;
end;
$$;

create function sgn_internal.enrollment_json(p_enrollment sgn.passkey_enrollment, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.enrollment_signed_content(p_enrollment) - 'short_code' || jsonb_build_object(
        'enrollment_id', p_enrollment.id,
        'status', p_enrollment.status,
        'requested_at', p_enrollment.requested_at,
        'actions', case
            when sgn_internal.denial_reason(p_viewer, 'passkey.endorse', p_enrollment) is null then '["endorse"]'::jsonb
            else '[]'::jsonb
        end
    )
$$;

-- ── 登記：身分提供者再驗證之後只建立待核准的登記（同 30_identity.sql 的簽章）──

create or replace function api.passkey_register(
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
    v_enrollment sgn.passkey_enrollment;
    v_token_sha256 bytea := sha256(convert_to(p_id_token, 'UTF8'));
begin
    v_challenge := sgn_internal.challenge_consume(p_challenge_id, 'passkey_register');
    v_person_id := sgn_internal.idp_token_verify(p_id_token, sgn_internal.b64url_encode(sha256(v_challenge.challenge || v_spki)));
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
    insert into sgn.passkey_enrollment (
        person_id, credential_id, public_key, registration_token_sha256, requested_at, requested_seq, status
    )
    values (
        v_person_id,
        sgn_internal.b64url_decode(p_credential_id),
        v_point,
        v_token_sha256,
        sgn_internal.now(),
        sgn_internal.audit_append('passkey.enrollment_requested', null, v_person_id, jsonb_build_object(
            'credential_id', p_credential_id,
            'public_key_sha256', encode(sha256(v_point), 'hex'),
            'id_token_sha256', encode(v_token_sha256, 'hex'),
            'rules', jsonb_build_array('K-PASSKEY-ENROLL')
        )),
        'pending'
    )
    returning * into v_enrollment;
    perform sgn_internal.notify(
        'passkey.enrollment_requested',
        array[v_person_id, (sgn_internal.resolve_manager(v_person_id)).manager_person_id],
        null,
        jsonb_build_object('person_name', sgn_internal.person_name(v_person_id), 'short_code', sgn_internal.passkey_short_code(encode(sha256(v_point), 'hex')))
    );
    return jsonb_build_object(
        'credential_id', p_credential_id,
        'enrollment_id', v_enrollment.id,
        'status', v_enrollment.status,
        'public_key_sha256', encode(sha256(v_point), 'hex')
    );
end;
$$;

comment on function api.passkey_register(uuid, text, text, text) is
    '登記通行金鑰的第一步（只收 ES256 / P-256 的 SPKI）：資料庫以 ID token 確認登記者本人、token 綁定這把公鑰，'
    '建立待核准的登記；金鑰要經 passkey_endorse_passkey 核准並過冷卻期才能用。呼叫者：sgn_app（後端 /auth/oidc/callback）。'
    '規則：K-PASSKEY-ENROLL';

-- ── 核准（本人的舊金鑰，或主管、登記人背書）──

create function api.passkey_enrollment_list(p_session text)
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
        select jsonb_agg(sgn_internal.enrollment_json(e, v_person_id) order by e.requested_at desc)
        from sgn.passkey_enrollment as e
        where e.status = 'pending'
          and (e.person_id = v_person_id or sgn_internal.denial_reason(v_person_id, 'passkey.endorse', e) is null)
    ), '[]'::jsonb);
end;
$$;

comment on function api.passkey_enrollment_list(text) is
    '待核准的通行金鑰登記：我自己的，與我可以背書的（我是本人的主管或登記人）。每筆附上指紋與我能做的動作；'
    '短碼由畫面從指紋自己算。呼叫者：sgn_app。規則：K-PASSKEY-ENROLL';

create function api.passkey_endorse_challenge(p_session text, p_enrollment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_enrollment sgn.passkey_enrollment;
    v_row sgn.auth_challenge;
begin
    select * into v_enrollment from sgn.passkey_enrollment where id = p_enrollment_id;
    perform sgn_internal.authorize(v_person_id, 'passkey.endorse', v_enrollment);
    v_row := sgn_internal.challenge_new('passkey.enrollment', jsonb_build_object('enrollment_id', v_enrollment.id), v_person_id);
    return jsonb_build_object('challenge_id', v_row.id, 'nonce', sgn_internal.b64url_encode(v_row.challenge), 'expires_at', v_row.expires_at);
end;
$$;

comment on function api.passkey_endorse_challenge(text, uuid) is
    '核准通行金鑰登記的第一步：發一次性亂數。瀏覽器用它和畫面上的登記編號、本人姓名、指紋、短碼自己算挑戰值再簽。'
    '呼叫者：sgn_app。規則：K-PASSKEY-ENROLL';

-- 核准後新金鑰生效的時間、事件與通知。
create function sgn_internal.enrollment_activate(
    p_enrollment sgn.passkey_enrollment,
    p_signer uuid,
    p_challenge sgn.auth_challenge,
    p_raw jsonb
)
returns sgn.passkey_enrollment
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_cooling int := sgn_internal.setting_int('passkey.cooling_workdays');
    v_usable_from timestamptz := sgn_internal.add_workdays(v_now, v_cooling);
    v_signed bytea := sgn_internal.signing_challenge(
        p_challenge.purpose, p_enrollment.id::text, sgn_internal.enrollment_signed_content(p_enrollment), 'endorse', p_challenge.challenge
    );
    v_fingerprint text := encode(sha256(p_enrollment.public_key), 'hex');
    v_seq bigint;
    v_row sgn.passkey_enrollment;
begin
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge)
    values (p_challenge.id, 'passkey', p_raw, sgn_internal.jcs_sha256(p_raw), v_now, v_signed);
    v_seq := sgn_internal.audit_append('passkey.endorsed', null, p_signer, jsonb_build_object(
        'enrollment_id', p_enrollment.id,
        'person', p_enrollment.person_id,
        'credential_id', sgn_internal.b64url_encode(p_enrollment.credential_id),
        'public_key_sha256', v_fingerprint,
        'by', case when p_signer = p_enrollment.person_id then 'own_key' else 'endorser' end,
        'challenge', sgn_internal.b64url_encode(v_signed),
        'proof_sha256', encode(sgn_internal.jcs_sha256(p_raw), 'hex'),
        'usable_from', v_usable_from,
        'settings', jsonb_build_object('passkey.cooling_workdays', v_cooling),
        'rules', jsonb_build_array('K-PASSKEY-ENROLL')
    ));
    insert into sgn.passkey_credential (credential_id, person_id, public_key, registered_at, registration_token_sha256, usable_from)
    values (p_enrollment.credential_id, p_enrollment.person_id, p_enrollment.public_key, v_now, p_enrollment.registration_token_sha256, v_usable_from);
    perform sgn_internal.audit_append('passkey.registered', null, p_enrollment.person_id, jsonb_build_object(
        'credential_id', sgn_internal.b64url_encode(p_enrollment.credential_id),
        'public_key_sha256', v_fingerprint,
        'usable_from', v_usable_from,
        'endorsed_seq', v_seq
    ));
    update sgn.passkey_enrollment
    set status = 'approved', endorsed_by = p_signer, endorsed_at = v_now, endorsed_seq = v_seq, endorsement_challenge_id = p_challenge.id
    where id = p_enrollment.id
    returning * into v_row;
    perform sgn_internal.notify(
        'passkey.endorsed',
        array[p_enrollment.person_id, (sgn_internal.resolve_manager(p_enrollment.person_id)).manager_person_id],
        null,
        jsonb_build_object(
            'person_name', sgn_internal.person_name(p_enrollment.person_id),
            'endorser_name', sgn_internal.person_name(p_signer),
            'usable_from', v_usable_from
        )
    );
    return v_row;
end;
$$;

create function api.passkey_endorse_passkey(
    p_challenge_id uuid,
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
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'passkey.enrollment');
    v_enrollment sgn.passkey_enrollment;
    v_signer uuid;
begin
    select * into v_enrollment from sgn.passkey_enrollment where id = (v_challenge.binding ->> 'enrollment_id')::uuid for update;
    v_signer := sgn_internal.signature_verify(
        v_challenge,
        v_enrollment.id::text,
        sgn_internal.enrollment_signed_content(v_enrollment),
        'endorse',
        p_credential_id,
        p_authenticator_data,
        p_client_data_json,
        p_signature
    );
    perform sgn_internal.authorize(v_signer, 'passkey.endorse', v_enrollment);
    perform sgn_internal.challenge_owner_check(v_challenge, v_signer);
    v_enrollment := sgn_internal.enrollment_activate(
        v_enrollment,
        v_signer,
        v_challenge,
        jsonb_build_object(
            'credential_id', p_credential_id,
            'authenticator_data', p_authenticator_data,
            'client_data_json', p_client_data_json,
            'signature', p_signature
        )
    );
    return sgn_internal.enrollment_json(v_enrollment, v_signer) || jsonb_build_object(
        'usable_from', (select k.usable_from from sgn.passkey_credential as k where k.credential_id = v_enrollment.credential_id)
    );
end;
$$;

comment on function api.passkey_endorse_passkey(uuid, text, text, text, text) is
    '核准通行金鑰登記的第二步：以通行金鑰的 assertion 核准（本人的舊金鑰，或主管、登記人背書）。核准人由資料庫驗章後從憑證得出；'
    '新金鑰過冷卻期才能簽章，登記、背書、生效都進鏈並通知本人與主管。呼叫者：sgn_app。規則：K-PASSKEY-ENROLL';

-- ── 系統的第一位登記人（安裝時由資料庫擁有者建立；沒有授權給任何執行期帳號）──

create function sgn_internal.passkey_bootstrap(p_person_id uuid, p_credential_id text, p_public_key_spki text, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_role text := sgn_internal.setting_text('passkey.registrar_role');
    v_point bytea := sgn_internal.p256_spki_to_point(sgn_internal.b64url_decode(p_public_key_spki));
    v_now timestamptz := sgn_internal.now();
    v_seq bigint;
begin
    if exists (
        select 1
        from unnest(sgn_internal.role_holders(v_role)) as h
        where sgn_internal.passkey_usable_count(h) > 0
    ) then
        perform sgn_internal.raise_error('PASSKEY_BOOTSTRAP_DONE');
    end if;
    if v_point is null then
        perform sgn_internal.raise_error('PASSKEY_KEY_INVALID');
    end if;
    v_seq := sgn_internal.audit_append('passkey.bootstrapped', null, null, jsonb_build_object(
        'person', p_person_id,
        'role', v_role,
        'credential_id', p_credential_id,
        'public_key_sha256', encode(sha256(v_point), 'hex'),
        'reason', p_reason,
        'rules', jsonb_build_array('K-PASSKEY-ENROLL')
    ));
    insert into sgn.role_assignment (person_id, role_code, valid_from, source, change_event_seq)
    values (p_person_id, v_role, v_now, 'manual', v_seq);
    insert into sgn.passkey_credential (credential_id, person_id, public_key, registered_at, registration_token_sha256, usable_from)
    values (sgn_internal.b64url_decode(p_credential_id), p_person_id, v_point, v_now, sha256(convert_to(p_reason, 'UTF8')), v_now);
    perform sgn_internal.audit_append('passkey.registered', null, p_person_id, jsonb_build_object(
        'credential_id', p_credential_id,
        'public_key_sha256', encode(sha256(v_point), 'hex'),
        'usable_from', v_now,
        'bootstrap_seq', v_seq
    ));
end;
$$;

insert into sgn.notification_template (event_code, subject, body) values
    ('passkey.enrollment_requested', '{{person_name}} 登記了一把新的通行金鑰', '短碼 {{short_code}}。要由本人用舊金鑰核准，或由主管、登記人當面或電話核對短碼後背書。不是本人登記的，請立刻通知資安。'),
    ('passkey.endorsed', '{{person_name}} 的新通行金鑰已核准', '由 {{endorser_name}} 核准，{{usable_from}} 起才能用來簽章。不是本人登記的，請在這之前通知資安。');

-- ── 目前登入的人（取代 60_views.sql 的版本）：可以簽章的金鑰數、待核准的登記、冷卻到什麼時候 ──

create or replace function api.me(p_session text)
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
            'name', sgn_internal.person_name(p.id),
            'passkeys', sgn_internal.passkey_usable_count(p.id),
            'passkey_cooling_until', (
                select min(k.usable_from) from sgn.passkey_credential as k where k.person_id = p.id and k.usable_from > sgn_internal.now()
            ),
            'passkey_pending', (
                select coalesce(jsonb_agg(sgn_internal.enrollment_json(e, p.id) order by e.requested_at), '[]'::jsonb)
                from sgn.passkey_enrollment as e
                where e.person_id = p.id and e.status = 'pending'
            ),
            'capabilities', sgn_internal.person_capabilities(p.id)
        )
        from sgn.person as p
        where p.id = v_person_id
    );
end;
$$;

comment on function api.me(text) is
    '目前登入的人：姓名、可以簽章的通行金鑰數、冷卻中的金鑰到什麼時候生效、待核准的登記、畫面可以顯示的功能。'
    '呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-PASSKEY-ENROLL';

-- 畫面可以顯示的功能（取代 220_role_change.sql 的版本）：多了「背書通行金鑰」。
create or replace function sgn_internal.person_capabilities(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select to_jsonb(array_remove(array[
        'case.submit',
        case when exists (select 1 from sgn_internal.person_waiting_cases(p_person_id)) then 'inbox' end,
        case when sgn_internal.denial_reason(p_person_id, 'audit.read', null::sgn.request_case) is null then 'audit' end,
        case when exists (
            select 1
            from sgn.role as r
            where sgn_internal.denial_reason(p_person_id, 'role_change.propose', r) is null
        ) or exists (
            select 1
            from sgn.role_change_request as q
            join sgn.role as r on r.code = q.role_code
            where sgn_internal.denial_reason(p_person_id, 'role_change.approve', r, q) is null
        ) then 'role_change' end,
        case when exists (
            select 1
            from sgn.passkey_enrollment as e
            where e.status = 'pending' and e.person_id <> p_person_id and sgn_internal.denial_reason(p_person_id, 'passkey.endorse', e) is null
        ) then 'passkey.endorse' end
    ], null))
$$;

select sgn_internal.register_rule(
    'K-PASSKEY-ENROLL',
    '通行金鑰的登記不只靠後端經手的登入：身分提供者再驗證之後只是待核准；本人用已生效的舊金鑰核准，'
    '第一把金鑰由本人的主管或登記人以通行金鑰背書（綁定新金鑰指紋與兩邊顯示的短碼，背書人不得是本人）；'
    '核准後有冷卻期（passkey.cooling_workdays）才能簽章；登記、背書、生效都進鏈並通知本人與主管；第一位登記人由資料庫擁有者在安裝時建立',
    null,
    'partial',
    '撤銷與遺失金鑰的停用沒做；通知只寫入待寄送佇列'
);
