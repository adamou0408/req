-- 通行金鑰登記的強度以「攻擊者可以離線試幾次」來算（裁決 D76；紅隊第三輪 高-2），
-- 以及角色變更與金鑰背書的畫面只從資料庫的顯示摘要畫出、簽的就是它（裁決 D75 的同理部分）。
--
-- 根因（高-2）：
--   1. 六位數短碼約 20 位元，而且是被入侵的後端可以離線挑選的值：12–33 秒就能暴力產生短碼相同的金鑰。
--   2. 背書不檢查本人是否已有金鑰：已有金鑰的人，主管或登記人仍可背書後端造出的登記（D65 沒有落實）。
--   3. 通知只進佇列，沒有寄出。
--
-- 這一版：
--   1. 已有金鑰（已核准，含冷卻中）的人，新金鑰只能由本人用已生效的舊金鑰核准，任何人不得背書（PASSKEY_SELF_ONLY）。
--   2. 核准時比對的是完整指紋。兩種方式（挑戰值發出時選定，記在挑戰值裡）：
--        qr    背書人的裝置掃新裝置畫面上的 QR 碼，取得完整指紋，簽進內容；資料庫與自己的紀錄比對。
--        code  不在場時：12 位數核對碼由慢速雜湊（PBKDF2，2^passkey.enrollment_code_cost 次）從完整指紋算出
--              （web/lib/signing.js 的 shortCode）。背書人的畫面從清單上的指紋自己算、與本人念的碼比對，
--              再把指紋與成本簽進內容；資料庫比對指紋，並要求成本等於參數（後端不能讓背書人的頁面用便宜的成本）。
--      資料庫不必算慢速雜湊：簽進去的是完整指紋。離線碰撞要約 10^12 次慢速雜湊（新裝置的頁面只接受窄範圍的成本）。
--   3. 每個人 24 小時內「沒被核准的登記」有上限（passkey.enrollment_daily_max），限制線上嘗試的次數。
--   4. 通知的範本不再帶短碼；寄送由 api_job 的通知寄送（330）真的經 SMTP 寄出。
--   5. 清單與 me 的登記改成 {enrollment_id, credential_id, status, requested_at, actions, code_cost, display}；
--      display 是背書畫面唯一的資料來源（本人、金鑰編號、完整指紋）。
--   6. 角色變更：清單、提出與決定的內容改成顯示摘要 role_change_display（被指派人、角色、範圍與它的名稱、
--      授予或撤除、原因、提出人、核准人），畫面只從它畫、簽的就是它。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('passkey.enrollment_code_cost', 'integer', '22', '{}',
        '金鑰登記 12 位數核對碼的慢速雜湊成本（2 的幾次方次 PBKDF2-SHA256，約一秒）；頁面只接受 20–24'),
    ('passkey.enrollment_daily_max', 'integer', '5', '{}',
        '每個人 24 小時內最多可以有幾筆沒被核准的通行金鑰登記（限制被入侵的後端線上嘗試的次數）');

insert into sgn.error_catalog (code, message, http_status) values
    ('PASSKEY_SELF_ONLY', '這個人已經有通行金鑰，新金鑰只能由本人用舊金鑰核准，任何人都不能替他背書', 403),
    ('PASSKEY_ENROLLMENT_LIMIT', '24 小時內登記通行金鑰的次數太多，請明天再試或聯絡資安', 429),
    ('PASSKEY_METHOD_INVALID', '核對方式只能是掃描 QR 碼（qr）或 12 位數核對碼（code）', 422);

-- ── 金鑰登記 ──

-- 這個人有沒有任何已核准的金鑰（含冷卻中）。
create function sgn_internal.passkey_any_count(p_person_id uuid)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select count(*)::int from sgn.passkey_credential as k where k.person_id = p_person_id
$$;

-- 授權檢查的唯一入口（通行金鑰核准的版本；同 260 的簽章）：已有金鑰的人只能本人用舊金鑰核准。
-- 規則：K-PASSKEY-ENROLL、K-AUDITOR-INDEPENDENT
create or replace function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_enrollment sgn.passkey_enrollment)
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
        when sgn_internal.passkey_any_count(p_enrollment.person_id) > 0 then 'PASSKEY_SELF_ONLY'
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

-- 背書畫面的顯示摘要：本人（id 與名字）、金鑰編號、完整指紋。
create function sgn_internal.enrollment_display(p_enrollment sgn.passkey_enrollment)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'person', sgn_internal.person_display(p_enrollment.person_id),
        'credential_id', sgn_internal.b64url_encode(p_enrollment.credential_id),
        'public_key_sha256', encode(sha256(p_enrollment.public_key), 'hex')
    )
$$;

-- 背書要簽的內容（唯一來源；瀏覽器端見 web/pages/passkeys.js）：顯示摘要、核對方式與核對碼的成本（qr 時為 null）。
-- 指紋是資料庫自己的紀錄：qr 時頁面簽的是掃到的指紋，code 時是頁面算過核對碼的那一個；不同就對不上。
create function sgn_internal.enrollment_signed_content(p_enrollment sgn.passkey_enrollment, p_binding jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.enrollment_display(p_enrollment) || jsonb_build_object(
        'method', p_binding ->> 'method',
        'code_cost', p_binding -> 'code_cost'
    )
$$;

create or replace function sgn_internal.enrollment_json(p_enrollment sgn.passkey_enrollment, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'enrollment_id', p_enrollment.id,
        'credential_id', sgn_internal.b64url_encode(p_enrollment.credential_id),
        'status', p_enrollment.status,
        'requested_at', p_enrollment.requested_at,
        'code_cost', sgn_internal.setting_int('passkey.enrollment_code_cost'),
        'display', sgn_internal.enrollment_display(p_enrollment),
        'actions', case
            when sgn_internal.denial_reason(p_viewer, 'passkey.endorse', p_enrollment) is null then '["endorse"]'::jsonb
            else '[]'::jsonb
        end
    )
$$;

-- 登記（同 260 的簽章）：多了每人 24 小時內沒被核准的登記上限；通知不再帶短碼。
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
    v_daily_max int := sgn_internal.setting_int('passkey.enrollment_daily_max');
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
    -- 同一個人的登記排隊，上限才不會被併發繞過
    perform pg_advisory_xact_lock(hashtext('sgn.passkey_register:' || v_person_id::text));
    if (
        select count(*)
        from sgn.passkey_enrollment as e
        where e.person_id = v_person_id and e.status = 'pending' and e.requested_at > sgn_internal.now() - interval '24 hours'
    ) >= v_daily_max then
        perform sgn_internal.audit_append('passkey.enrollment_refused', null, v_person_id, jsonb_build_object(
            'credential_id', p_credential_id,
            'public_key_sha256', encode(sha256(v_point), 'hex'),
            'settings', jsonb_build_object('passkey.enrollment_daily_max', v_daily_max),
            'rules', jsonb_build_array('K-PASSKEY-ENROLL')
        ));
        perform sgn_internal.raise_error('PASSKEY_ENROLLMENT_LIMIT');
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
            'settings', jsonb_build_object('passkey.enrollment_daily_max', v_daily_max),
            'rules', jsonb_build_array('K-PASSKEY-ENROLL')
        )),
        'pending'
    )
    returning * into v_enrollment;
    perform sgn_internal.notify(
        'passkey.enrollment_requested',
        array[v_person_id, (sgn_internal.resolve_manager(v_person_id)).manager_person_id],
        null,
        jsonb_build_object(
            'person_name', sgn_internal.person_name(v_person_id),
            'fingerprint_prefix', substr(encode(sha256(v_point), 'hex'), 1, 16)
        )
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
    '建立待核准的登記（每人 24 小時內沒被核准的登記不得超過 passkey.enrollment_daily_max）；金鑰要經 passkey_endorse_passkey '
    '核准並過冷卻期才能用。呼叫者：sgn_app（後端 /auth/oidc/callback）。規則：K-PASSKEY-ENROLL';

drop function api.passkey_endorse_challenge(text, uuid);

create function api.passkey_endorse_challenge(p_session text, p_enrollment_id uuid, p_method text)
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
    if p_method is null or p_method not in ('qr', 'code') then
        perform sgn_internal.raise_error('PASSKEY_METHOD_INVALID', p_method);
    end if;
    v_row := sgn_internal.challenge_new('passkey.enrollment', jsonb_build_object(
        'enrollment_id', v_enrollment.id,
        'method', p_method,
        'code_cost', case when p_method = 'code' then to_jsonb(sgn_internal.setting_int('passkey.enrollment_code_cost')) else 'null'::jsonb end
    ), v_person_id);
    return jsonb_build_object('challenge_id', v_row.id, 'nonce', sgn_internal.b64url_encode(v_row.challenge), 'expires_at', v_row.expires_at);
end;
$$;

comment on function api.passkey_endorse_challenge(text, uuid, text) is
    '核准通行金鑰登記的第一步：選定核對方式（qr：掃新裝置的 QR 碼取得完整指紋；code：12 位數核對碼，成本取參數 '
    'passkey.enrollment_code_cost），發一次性亂數。瀏覽器用它和畫面上的顯示摘要（本人、金鑰編號、指紋）、核對方式與成本'
    '自己算挑戰值再簽。呼叫者：sgn_app。規則：K-PASSKEY-ENROLL、K-DISPLAY-SIGNED';

-- 核准後新金鑰生效的時間、事件與通知（同 260 的簽章）：簽的內容依挑戰值記下的核對方式重算。
create or replace function sgn_internal.enrollment_activate(
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
        p_challenge.purpose, p_enrollment.id::text, sgn_internal.enrollment_signed_content(p_enrollment, p_challenge.binding),
        'endorse', p_challenge.challenge
    );
    v_fingerprint text := encode(sha256(p_enrollment.public_key), 'hex');
    v_seq bigint;
    v_row sgn.passkey_enrollment;
begin
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge, display_snapshot)
    values (p_challenge.id, 'passkey', p_raw, sgn_internal.jcs_sha256(p_raw), v_now, v_signed, sgn_internal.enrollment_display(p_enrollment));
    v_seq := sgn_internal.audit_append('passkey.endorsed', null, p_signer, jsonb_build_object(
        'enrollment_id', p_enrollment.id,
        'person', p_enrollment.person_id,
        'credential_id', sgn_internal.b64url_encode(p_enrollment.credential_id),
        'public_key_sha256', v_fingerprint,
        'by', case when p_signer = p_enrollment.person_id then 'own_key' else 'endorser' end,
        'method', p_challenge.binding ->> 'method',
        'challenge', sgn_internal.b64url_encode(v_signed),
        'proof_sha256', encode(sgn_internal.jcs_sha256(p_raw), 'hex'),
        'usable_from', v_usable_from,
        'settings', jsonb_build_object(
            'passkey.cooling_workdays', v_cooling,
            'passkey.enrollment_code_cost', p_challenge.binding -> 'code_cost'
        ),
        'rules', jsonb_build_array('K-PASSKEY-ENROLL', 'K-DISPLAY-SIGNED')
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
            'usable_from', v_usable_from,
            'fingerprint_prefix', substr(v_fingerprint, 1, 16)
        )
    );
    return v_row;
end;
$$;

create or replace function api.passkey_endorse_passkey(
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
        sgn_internal.enrollment_signed_content(v_enrollment, v_challenge.binding),
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
        sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature)
    );
    return sgn_internal.enrollment_json(v_enrollment, v_signer) || jsonb_build_object(
        'usable_from', (select k.usable_from from sgn.passkey_credential as k where k.credential_id = v_enrollment.credential_id)
    );
end;
$$;

comment on function api.passkey_endorse_passkey(uuid, text, text, text, text) is
    '核准通行金鑰登記的第二步：以通行金鑰的 assertion 核准（已有金鑰的人只能本人用舊金鑰；第一把由主管或登記人背書）。'
    '簽的內容是背書畫面的顯示摘要（本人、金鑰編號、完整指紋）加核對方式與成本，資料庫以自己的紀錄重算；核准人由資料庫驗章後'
    '從憑證得出；新金鑰過冷卻期才能簽章，登記、背書、生效都進鏈並通知本人與主管。呼叫者：sgn_app。'
    '規則：K-PASSKEY-ENROLL、K-DISPLAY-SIGNED';

drop function sgn_internal.enrollment_signed_content(sgn.passkey_enrollment);
drop function sgn_internal.passkey_short_code(text);

insert into sgn.notification_template (event_code, subject, body) values
    ('passkey.enrollment_requested', '{{person_name}} 登記了一把新的通行金鑰',
        '金鑰指紋開頭 {{fingerprint_prefix}}。已有金鑰的人要由本人用舊金鑰核准；第一把金鑰由主管或登記人掃描新裝置的 QR 碼，'
        '或核對 12 位數核對碼後背書。不是本人登記的，請立刻通知資安。'),
    ('passkey.endorsed', '{{person_name}} 的新通行金鑰已核准',
        '由 {{endorser_name}} 核准（金鑰指紋開頭 {{fingerprint_prefix}}），{{usable_from}} 起才能用來簽章。不是本人登記的，請在這之前通知資安。')
on conflict (event_code) do update set subject = excluded.subject, body = excluded.body;

select sgn_internal.register_rule(
    'K-PASSKEY-ENROLL',
    '通行金鑰的登記不只靠後端經手的登入：身分提供者再驗證之後只是待核准；已有金鑰的人只能本人用已生效的舊金鑰核准，'
    '任何人不得背書；第一把金鑰由本人的主管或登記人以通行金鑰背書，比對完整指紋（掃 QR 碼，或由慢速雜湊算出的 12 位數核對碼，'
    '成本 passkey.enrollment_code_cost），背書人不得是本人；每人 24 小時內沒被核准的登記有上限（passkey.enrollment_daily_max）；'
    '核准後有冷卻期（passkey.cooling_workdays）才能簽章；登記、背書、生效都進鏈並經 SMTP 通知本人與主管；'
    '第一位登記人由資料庫擁有者在安裝時建立',
    null,
    'partial',
    '撤銷與遺失金鑰的停用沒做；畫面只做了 12 位數核對碼，掃 QR 碼只有資料庫與測試的流程（頁面沒有 QR 的產生與掃描）'
);

-- ── 角色指派變更的顯示摘要 ──

-- 範圍在畫面上的樣子：代碼與登記的名稱（流程類型取流程類型的名稱）。不限範圍為 null。
create function sgn_internal.scope_display(p_scope_ref text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case when p_scope_ref is not null then jsonb_build_object(
        'ref', p_scope_ref,
        'label', coalesce(
            (select s.label from sgn.scope_registry as s where s.scope_ref = p_scope_ref),
            (select t.name from sgn.process_type as t where 'process:' || t.code = p_scope_ref),
            p_scope_ref
        )
    ) end
$$;

-- 角色變更的顯示摘要（取代 270 的內容；同簽章）：被指派人、角色、範圍、授予或撤除、原因、提出人、核准人。
-- 提出的當下 p_request.proposed_by 是提出人自己。
create or replace function sgn_internal.role_change_signed_content(p_request sgn.role_change_request)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'holder', sgn_internal.person_display(p_request.holder_person_id),
        'role', (select jsonb_build_object('code', r.code, 'name', r.name) from sgn.role as r where r.code = p_request.role_code),
        'scope', sgn_internal.scope_display(p_request.scope_ref),
        'change', p_request.change,
        'reason', p_request.reason,
        'proposed_by', sgn_internal.person_display(p_request.proposed_by),
        'approved_by', sgn_internal.person_display(p_request.approved_by)
    )
$$;

create or replace function sgn_internal.role_change_json(p_request sgn.role_change_request, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'request_id', p_request.id,
        'status', p_request.status,
        'proposed_at', p_request.proposed_at,
        'approved_at', p_request.approved_at,
        'effective_at', p_request.effective_at,
        'blocked_by_name', sgn_internal.person_name(p_request.blocked_by),
        'display', sgn_internal.role_change_signed_content(p_request),
        'actions', to_jsonb(array_remove(array[
            case when sgn_internal.denial_reason(p_viewer, 'role_change.approve', r, p_request) is null then 'approve' end,
            case when sgn_internal.denial_reason(p_viewer, 'role_change.block', r, p_request) is null then 'block' end
        ], null))
    )
    from sgn.role as r
    where r.code = p_request.role_code
$$;

-- 提出的第一步（同 270 的簽章）：挑戰值記下變更的參數；多回傳 display（提出確認畫面唯一的資料來源，簽的就是它）。
create or replace function api.role_change_propose_challenge(
    p_session text,
    p_holder_id uuid,
    p_role_code text,
    p_scope_ref text,
    p_change text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_request sgn.role_change_request;
    v_row sgn.auth_challenge;
begin
    if coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED');
    end if;
    v_request.holder_person_id := p_holder_id;
    v_request.role_code := p_role_code;
    v_request.scope_ref := p_scope_ref;
    v_request.change := p_change;
    v_request.reason := p_reason;
    v_request.proposed_by := v_person_id;
    perform sgn_internal.role_change_check(v_person_id, 'role_change.propose', v_request);
    v_row := sgn_internal.challenge_new('role_change.propose', jsonb_build_object(
        'holder_id', p_holder_id, 'role_code', p_role_code, 'scope_ref', p_scope_ref, 'change', p_change, 'reason', p_reason
    ), v_person_id);
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'nonce', sgn_internal.b64url_encode(v_row.challenge),
        'expires_at', v_row.expires_at,
        'display', sgn_internal.role_change_signed_content(v_request)
    );
end;
$$;

comment on function api.role_change_propose_challenge(text, uuid, text, text, text, text) is
    '提出角色指派變更的第一步：檢查我能不能提出、這張變更合不合規（範圍、衝突、最後一位持有人），發一次性亂數，'
    '並回傳這張變更的顯示摘要（被指派人、角色、範圍名稱、授予或撤除、原因、提出人）。瀏覽器只從摘要畫出確認畫面，'
    '用它的內容與 nonce 自己算挑戰值再簽。呼叫者：sgn_app。'
    '規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-ADMIN-SOD、K-AUDITOR-INDEPENDENT、K-DISPLAY-SIGNED';

-- 提出的第二步（同 270 的簽章）：內容依挑戰值發給的人（提出人）重算顯示摘要。
create or replace function api.role_change_propose_passkey(
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
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'role_change.propose');
    v_request sgn.role_change_request;
    v_signer uuid;
    v_raw jsonb := sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature);
    v_content jsonb;
    v_signed bytea;
    v_role sgn.role;
begin
    v_request.holder_person_id := (v_challenge.binding ->> 'holder_id')::uuid;
    v_request.role_code := v_challenge.binding ->> 'role_code';
    v_request.scope_ref := v_challenge.binding ->> 'scope_ref';
    v_request.change := v_challenge.binding ->> 'change';
    v_request.reason := v_challenge.binding ->> 'reason';
    v_request.proposed_by := v_challenge.person_id;
    v_content := sgn_internal.role_change_signed_content(v_request);
    v_signer := sgn_internal.signature_verify(
        v_challenge, 'new', v_content, 'propose', p_credential_id, p_authenticator_data, p_client_data_json, p_signature
    );
    perform sgn_internal.role_change_check(v_signer, 'role_change.propose', v_request);
    perform sgn_internal.challenge_owner_check(v_challenge, v_signer);
    v_role := sgn_internal.role_of(v_request.role_code);
    v_signed := sgn_internal.signing_challenge(v_challenge.purpose, 'new', v_content, 'propose', v_challenge.challenge);
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge, display_snapshot)
    values (v_challenge.id, 'passkey', v_raw, sgn_internal.jcs_sha256(v_raw), sgn_internal.now(), v_signed, v_content);
    insert into sgn.role_change_request (
        holder_person_id, role_code, scope_ref, change, reason, status, proposed_by, proposed_at, proposed_seq, propose_challenge_id
    )
    values (
        v_request.holder_person_id, v_request.role_code, v_request.scope_ref, v_request.change, v_request.reason, 'pending',
        v_signer, sgn_internal.now(),
        sgn_internal.audit_append('role.change_proposed', null, v_signer, jsonb_build_object(
            'holder', v_request.holder_person_id,
            'role', v_request.role_code,
            'scope_ref', v_request.scope_ref,
            'change', v_request.change,
            'reason', v_request.reason,
            'approver_role', v_role.change_approver_role,
            'challenge', sgn_internal.b64url_encode(v_signed),
            'display_sha256', encode(sgn_internal.jcs_sha256(v_content), 'hex'),
            'proof_kind', 'passkey',
            'proof_sha256', encode(sgn_internal.jcs_sha256(v_raw), 'hex'),
            'rules', jsonb_build_array('K-ROLE-SOURCE', 'K-ROLE-CHANGE-GOVERNANCE', 'K-AUDITOR-INDEPENDENT', 'K-DISPLAY-SIGNED')
        )),
        v_challenge.id
    )
    returning * into v_request;
    return sgn_internal.role_change_json(v_request, v_signer);
end;
$$;

comment on function api.role_change_propose_passkey(uuid, text, text, text, text) is
    '提出角色指派變更的第二步：以通行金鑰的 assertion 提出。簽的內容是顯示摘要，資料庫依挑戰值發給的人重算；'
    '提出人由資料庫驗章後從憑證得出，提出當下重新檢查。呼叫者：sgn_app。'
    '規則：K-ROLE-SOURCE、K-ROLE-CHANGE-GOVERNANCE、K-ADMIN-SOD、K-AUDITOR-INDEPENDENT、K-DISPLAY-SIGNED';
