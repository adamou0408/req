-- 紅隊第五輪 高-1、推論未驗證 1（裁決 D84 (2)）：「不需要第二個因素」要以「身分提供者整個被冒用」為前提重新分類。
-- 只憑登入的動作裡，「撤銷自己的全部通行金鑰」被冒用時最壞會怎樣：本人再也不能簽核、要等主管背書重新登記；若是登記人，
-- 之後所有新金鑰都沒有人能背書。所以只憑登入改為「停用」，不是撤銷：
--   1. 停用（api.passkey_revoke_self，入口不變）：這個人全部沒撤銷的金鑰立即不能簽（PASSKEY_SUSPENDED）、沒被核准的登記作廢、
--      進鏈、通知本人與主管。每人每 24 小時最多 passkey.suspend_daily_max 次。持有治理類角色的人被停用即開例外 K-GOVERNANCE-KEY。
--   2. 恢復：本人用「原來的」金鑰（被停用的那幾把之一）簽恢復的顯示摘要，再由本人的主管或登記人（不是本人、不持有不能做決定的角色）
--      用自己的通行金鑰背書；兩個都到了才恢復，進鏈、通知。拿走裝置的人只有金鑰、沒有主管；冒用登入的人沒有金鑰。
--   3. 真的遺失或被偷：主管或登記人用通行金鑰簽的撤銷（K-PASSKEY-REVOKE，不變）連停用中的一起撤銷，之後走第一把金鑰的背書。
--      停用中的金鑰仍算「有金鑰」，所以停用之後不能只憑登入登記新的第一把（不能拿停用當降級的路）。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('passkey.suspend_daily_max', 'integer', '1', '{}',
        '每人 24 小時內最多只憑登入停用自己的通行金鑰幾次（K-PASSKEY-SUSPEND）');

insert into sgn.error_catalog (code, message, http_status) values
    ('PASSKEY_SUSPENDED', '這把通行金鑰已經停用；請本人用它申請恢復，再由主管或登記人背書', 403),
    ('PASSKEY_SUSPEND_LIMIT', '今天已經停用過通行金鑰；要再停用，請主管或登記人用通行金鑰撤銷', 429),
    ('PASSKEY_RESTORE_NOT_ALLOWED', '你不能處理這筆恢復：本人要用被停用的金鑰簽，背書要由本人的主管或登記人用自己的通行金鑰', 403),
    ('PASSKEY_RESTORE_KEY', '恢復要用被停用的那幾把金鑰之一來簽', 403);

alter table sgn.auth_challenge
    drop constraint auth_challenge_purpose_check,
    add constraint auth_challenge_purpose_check check (purpose in (
        'session', 'passkey_register', 'decision', 'role_change',
        'case.decision', 'role_change.propose', 'role_change.decision', 'passkey.enrollment', 'passkey.revocation',
        'passkey.restore', 'passkey.restore_endorse'
    ));

alter table sgn.passkey_credential
    add column suspended_at timestamptz,
    add column suspension_id uuid;

-- 一次停用：status suspended（等本人用原金鑰簽）→ self_confirmed（等主管或登記人背書）→ restored；被撤銷或過時時 closed。
create table sgn.passkey_suspension (
    id uuid primary key default gen_random_uuid(),
    person_id uuid not null references sgn.person (id),
    reason text not null,
    credentials jsonb not null,
    suspended_at timestamptz not null,
    event_seq bigint not null,
    status text not null check (status in ('suspended', 'self_confirmed', 'restored', 'closed')),
    self_signed_at timestamptz,
    self_credential_id bytea,
    restored_by uuid references sgn.person (id),
    restored_at timestamptz
);

create unique index passkey_suspension_open on sgn.passkey_suspension (person_id) where status in ('suspended', 'self_confirmed');

insert into sgn.state_transition (entity, from_state, action, to_state) values
    ('passkey_suspension', 'suspended', 'self_confirm', 'self_confirmed'),
    ('passkey_suspension', 'self_confirmed', 'restore', 'restored'),
    ('passkey_suspension', 'suspended', 'close', 'closed'),
    ('passkey_suspension', 'self_confirmed', 'close', 'closed');

-- ── 金鑰的計數：停用中的不能簽（usable 不算），但仍算「有金鑰」（any 算） ──

create or replace function sgn_internal.passkey_usable_count(p_person_id uuid)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select count(*)::int
    from sgn.passkey_credential as k
    where k.person_id = p_person_id
      and k.usable_from <= sgn_internal.now()
      and k.revoked_at is null
      and k.suspended_at is null
$$;

-- 沒撤銷也沒停用的金鑰（含冷卻中）：只憑登入的停用要至少有一把。
create function sgn_internal.passkey_unsuspended_count(p_person_id uuid)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select count(*)::int from sgn.passkey_credential as k where k.person_id = p_person_id and k.revoked_at is null and k.suspended_at is null
$$;

-- 這個人目前開著的那筆停用（金鑰都已被撤銷的停用先收掉）。
create function sgn_internal.passkey_suspension_open(p_person_id uuid)
returns sgn.passkey_suspension
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select s.* from sgn.passkey_suspension as s
    where s.person_id = p_person_id and s.status in ('suspended', 'self_confirmed')
      and exists (select 1 from sgn.passkey_credential as k where k.suspension_id = s.id and k.revoked_at is null)
$$;

-- ── WebAuthn assertion 驗證：停用中的金鑰只能用來簽自己的恢復 ──

create function sgn_internal.webauthn_verify_credential(
    p_expected_challenge bytea,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text,
    p_allow_suspended boolean
)
returns uuid
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cred sgn.passkey_credential;
    v_auth bytea := sgn_internal.b64url_decode(p_authenticator_data);
    v_client_raw bytea := sgn_internal.b64url_decode(p_client_data_json);
    v_signature bytea := sgn_internal.b64url_decode(p_signature);
    v_client jsonb;
    v_count bigint;
begin
    select * into v_cred
    from sgn.passkey_credential
    where credential_id = sgn_internal.b64url_decode(p_credential_id)
    for update;
    if v_cred.credential_id is null then
        perform sgn_internal.raise_error('PASSKEY_UNKNOWN');
    end if;
    if v_cred.revoked_at is not null then
        perform sgn_internal.raise_error('PASSKEY_REVOKED', 'revoked at ' || v_cred.revoked_at::text);
    end if;
    if v_cred.suspended_at is not null and not p_allow_suspended then
        perform sgn_internal.raise_error('PASSKEY_SUSPENDED', 'suspended at ' || v_cred.suspended_at::text);
    end if;
    if v_cred.usable_from > sgn_internal.now() then
        perform sgn_internal.raise_error('PASSKEY_NOT_ACTIVE', 'usable from ' || v_cred.usable_from::text);
    end if;
    begin
        v_client := convert_from(v_client_raw, 'UTF8')::jsonb;
    exception
        when others then
            perform sgn_internal.raise_error('PASSKEY_INVALID', 'clientDataJSON');
    end;
    if length(v_auth) < 37
       or v_client ->> 'type' is distinct from 'webauthn.get'
       or v_client ->> 'origin' is distinct from sgn_internal.setting_text('webauthn.origin')
       or substring(v_auth from 1 for 32) <> sha256(convert_to(sgn_internal.setting_text('webauthn.rp_id'), 'UTF8')) then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'client data or rp id');
    end if;
    if v_client ->> 'challenge' is distinct from sgn_internal.b64url_encode(p_expected_challenge) then
        perform sgn_internal.raise_error('SIGNED_CONTENT_MISMATCH');
    end if;
    -- 0x01 使用者在場、0x04 使用者驗證（生物辨識或 PIN）。決定類一律要求兩者。
    if get_byte(v_auth, 32) & 5 <> 5 then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'flags');
    end if;
    -- 只收 low-s（D71）
    if coalesce((sgn_internal.der_ecdsa_rs(v_signature)).s * 2 > sgn_internal.p256_n(), true) then
        perform sgn_internal.raise_error('PASSKEY_INVALID', 'high-s or malformed signature');
    end if;
    if not sgn_internal.es256_verify(v_auth || sha256(v_client_raw), v_signature, v_cred.public_key) then
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

-- 一般的驗證入口（同 380 的簽章）：停用中的金鑰一律 PASSKEY_SUSPENDED。
create or replace function sgn_internal.webauthn_verify(
    p_expected_challenge bytea,
    p_credential_id text,
    p_authenticator_data text,
    p_client_data_json text,
    p_signature text
)
returns uuid
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.webauthn_verify_credential(p_expected_challenge, p_credential_id, p_authenticator_data, p_client_data_json, p_signature, false)
$$;

-- ── 授權檢查的唯一入口（同 380 的簽章，以第三個參數的型別區分）：多了停用與恢復 ──
-- passkey.revoke（用自己的通行金鑰簽的撤銷）、passkey.revoke_self（本人只憑登入＝停用）、
-- passkey.restore（本人用原金鑰簽恢復）、passkey.restore_endorse（主管或登記人背書恢復）。規則：K-PASSKEY-REVOKE、K-PASSKEY-SUSPEND

create or replace function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_holder sgn.person)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_action not in ('passkey.revoke', 'passkey.revoke_self', 'passkey.restore', 'passkey.restore_endorse') then 'ACTION_UNKNOWN'
        when p_holder.id is null or not p_holder.active then 'PERSON_UNKNOWN'
        when p_action = 'passkey.restore' and p_person_id is distinct from p_holder.id then 'PASSKEY_RESTORE_NOT_ALLOWED'
        when p_action = 'passkey.restore'
             and (sgn_internal.passkey_suspension_open(p_holder.id)).status is distinct from 'suspended' then 'PASSKEY_NONE'
        when p_action = 'passkey.restore' then null
        when p_action = 'passkey.restore_endorse' and p_person_id = p_holder.id then 'PASSKEY_RESTORE_NOT_ALLOWED'
        when p_action = 'passkey.restore_endorse'
             and (sgn_internal.passkey_suspension_open(p_holder.id)).status is distinct from 'self_confirmed' then 'PASSKEY_NONE'
        when p_action = 'passkey.revoke_self' and p_person_id = p_holder.id and sgn_internal.passkey_unsuspended_count(p_holder.id) > 0 then null
        when p_action = 'passkey.revoke' and p_person_id = p_holder.id and sgn_internal.passkey_any_count(p_holder.id) > 0 then null
        when p_person_id = p_holder.id then 'PASSKEY_NONE'
        when p_action = 'passkey.revoke_self' then 'PASSKEY_REVOKE_NOT_ALLOWED'
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then 'DECIDER_ROLE_EXCLUDED'
        when (sgn_internal.resolve_manager(p_holder.id)).manager_person_id is distinct from p_person_id
             and not sgn_internal.has_role(p_person_id, sgn_internal.setting_text('passkey.registrar_role'))
            then case when p_action = 'passkey.restore_endorse' then 'PASSKEY_RESTORE_NOT_ALLOWED' else 'PASSKEY_REVOKE_NOT_ALLOWED' end
        when p_action = 'passkey.revoke' and sgn_internal.passkey_any_count(p_holder.id) = 0 then 'PASSKEY_NONE'
    end
$$;

-- ── 停用 ──

-- 停用這個人全部沒撤銷的金鑰（立即生效）：每日上限、作廢沒被核准的登記、進鏈、通知本人與主管；治理類持有人開例外。
create function sgn_internal.passkey_suspend_all(p_person_id uuid, p_reason text)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_max int := sgn_internal.setting_int('passkey.suspend_daily_max');
    v_credentials jsonb;
    v_cancelled int;
    v_seq bigint;
    v_id uuid := gen_random_uuid();
    v_roles jsonb;
begin
    if coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED', 'passkey.suspend');
    end if;
    perform pg_advisory_xact_lock(hashtext('sgn.passkey_register:' || p_person_id::text));
    if (select count(*) from sgn.passkey_suspension as s where s.person_id = p_person_id and s.suspended_at > v_now - interval '24 hours') >= v_max then
        perform sgn_internal.raise_error('PASSKEY_SUSPEND_LIMIT', v_max::text);
    end if;
    -- 之前那筆的金鑰已經全被撤銷（主管簽的撤銷）：收掉，這次重新開
    update sgn.passkey_suspension as s set status = sgn_internal.entity_transition('passkey_suspension', s.status, 'close')
    where s.person_id = p_person_id and s.status in ('suspended', 'self_confirmed');
    v_credentials := (sgn_internal.revocation_display(p_person_id)) -> 'credentials';
    update sgn.passkey_enrollment set status = 'cancelled' where person_id = p_person_id and status = 'pending';
    get diagnostics v_cancelled = row_count;
    v_roles := (
        select coalesce(jsonb_agg(distinct g.code order by g.code), '[]'::jsonb)
        from sgn.role as g
        where g.category = 'governance' and p_person_id = any (sgn_internal.role_holders(g.code))
    );
    v_seq := sgn_internal.audit_append('passkey.suspended', null, p_person_id, jsonb_build_object(
        'person', p_person_id, 'suspension', v_id, 'credentials', v_credentials,
        'reason_sha256', encode(sha256(convert_to(btrim(p_reason), 'UTF8')), 'hex'),
        'cancelled_enrollments', v_cancelled, 'governance_roles', v_roles,
        'settings', jsonb_build_object('passkey.suspend_daily_max', v_max),
        'rules', jsonb_build_array('K-PASSKEY-SUSPEND')
    ));
    insert into sgn.passkey_suspension (id, person_id, reason, credentials, suspended_at, event_seq, status)
    values (v_id, p_person_id, btrim(p_reason), v_credentials, v_now, v_seq, 'suspended');
    update sgn.passkey_credential set suspended_at = v_now, suspension_id = v_id
    where person_id = p_person_id and revoked_at is null and suspended_at is null;
    if v_roles <> '[]'::jsonb then
        perform sgn_internal.exception_open('K-GOVERNANCE-KEY', null, jsonb_build_object(
            'kind', 'governance_holder_suspended', 'person', p_person_id, 'roles', v_roles, 'suspension', v_id));
    end if;
    perform sgn_internal.notify(
        'passkey.suspended', array_remove(array[p_person_id, (sgn_internal.resolve_manager(p_person_id)).manager_person_id], null), null,
        jsonb_build_object('person_name', sgn_internal.person_name(p_person_id), 'count', jsonb_array_length(v_credentials))
    );
    return jsonb_build_object(
        'person', sgn_internal.person_display(p_person_id),
        'suspended', jsonb_array_length(v_credentials),
        'cancelled_enrollments', v_cancelled,
        'suspended_at', v_now
    );
end;
$$;

create or replace function api.passkey_revoke_self(p_session text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    perform sgn_internal.authorize(v_person_id, 'passkey.revoke_self', sgn_internal.person_row(v_person_id));
    return sgn_internal.passkey_suspend_all(v_person_id, p_reason);
end;
$$;

comment on function api.passkey_revoke_self(text, text) is
    '本人只憑登入停用自己的全部通行金鑰（遺失裝置或懷疑被盜時；裁決 D84 (2)）：立即不能簽、沒被核准的登記作廢、進鏈、通知本人與主管；'
    '每人每 24 小時最多 passkey.suspend_daily_max 次；治理類角色的持有人開例外 K-GOVERNANCE-KEY。本人以原金鑰加上主管或登記人背書可恢復；'
    '真的遺失由主管或登記人用通行金鑰撤銷。呼叫者：sgn_app。規則：K-PASSKEY-SUSPEND、K-GOVERNANCE-KEY';

-- ── 恢復 ──

-- 恢復的顯示摘要（本人、停用的每一把金鑰、停用時間；畫面只從它畫，簽的也是它）。
create function sgn_internal.suspension_display(p_suspension sgn.passkey_suspension)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'suspension_id', p_suspension.id::text,
        'person', sgn_internal.person_display(p_suspension.person_id),
        'credentials', p_suspension.credentials,
        'suspended_at', to_char(p_suspension.suspended_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    )
$$;

create function sgn_internal.suspension_by_id(p_suspension_id uuid)
returns sgn.passkey_suspension
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from sgn.passkey_suspension where id = p_suspension_id
$$;

-- 看的人可以處理的停用：本人（restore：用原金鑰簽）、他是主管或登記人的人（endorse_restore：本人簽過之後背書）。
create function api.passkey_suspension_list(p_session text)
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
        select jsonb_agg(r.row order by r.person_id <> v_person_id, r.row #>> '{display,person,name}')
        from (
            select s.person_id, jsonb_build_object(
                'display', sgn_internal.suspension_display(s),
                'status', s.status,
                'actions', to_jsonb(array_remove(array[
                    case when sgn_internal.denial_reason(v_person_id, 'passkey.restore', p) is null then 'restore' end,
                    case when sgn_internal.passkey_usable_count(v_person_id) > 0
                              and sgn_internal.denial_reason(v_person_id, 'passkey.restore_endorse', p) is null then 'endorse_restore' end
                ], null))
            ) as row
            from sgn.person as p
            cross join lateral sgn_internal.passkey_suspension_open(p.id) as s
            where p.active and s.id is not null
        ) as r
        where r.person_id = v_person_id or jsonb_array_length(r.row -> 'actions') > 0
    ), '[]'::jsonb);
end;
$$;

comment on function api.passkey_suspension_list(text) is
    '看的人自己的停用（restore：用原來的金鑰簽恢復）與他是主管或登記人、本人已簽過恢復的停用（endorse_restore：用自己的通行金鑰背書）。'
    'display 是恢復畫面唯一的資料來源。呼叫者：sgn_app。規則：K-PASSKEY-SUSPEND';

-- 恢復的第一步（本人與背書人共用）：檢查資格、發一次性亂數。本人簽 decision restore，背書人簽 decision endorse。
create function api.passkey_restore_challenge(p_session text, p_suspension_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_suspension sgn.passkey_suspension := sgn_internal.suspension_by_id(p_suspension_id);
    v_self boolean := v_person_id = v_suspension.person_id;
    v_row sgn.auth_challenge;
begin
    perform sgn_internal.authorize(v_person_id, case when v_self then 'passkey.restore' else 'passkey.restore_endorse' end,
        sgn_internal.person_row(v_suspension.person_id));
    if (sgn_internal.passkey_suspension_open(v_suspension.person_id)).id is distinct from v_suspension.id then
        perform sgn_internal.raise_error('PASSKEY_NONE', 'suspension');
    end if;
    v_row := sgn_internal.challenge_new(case when v_self then 'passkey.restore' else 'passkey.restore_endorse' end,
        jsonb_build_object('suspension_id', v_suspension.id), v_person_id);
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'nonce', sgn_internal.b64url_encode(v_row.challenge),
        'expires_at', v_row.expires_at,
        'decision', case when v_self then 'restore' else 'endorse' end,
        'display', sgn_internal.suspension_display(v_suspension)
    );
end;
$$;

comment on function api.passkey_restore_challenge(text, uuid) is
    '恢復停用的通行金鑰的第一步：本人（用被停用的原金鑰簽）或本人的主管、登記人（用自己的通行金鑰背書，本人簽過之後）取得一次性亂數。'
    '瀏覽器從顯示摘要與亂數自己算挑戰值。呼叫者：sgn_app。規則：K-PASSKEY-SUSPEND、K-DISPLAY-SIGNED';

-- 恢復的第二步：本人簽過 → 等背書；背書簽過 → 金鑰恢復可用。簽的人由驗章得出；本人只能用被停用的那幾把之一。
create function api.passkey_restore_passkey(
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
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume_any(p_challenge_id, array['passkey.restore', 'passkey.restore_endorse']);
    v_self boolean := v_challenge.purpose = 'passkey.restore';
    v_suspension sgn.passkey_suspension := sgn_internal.suspension_by_id((v_challenge.binding ->> 'suspension_id')::uuid);
    v_signer uuid;
    v_cred bytea := sgn_internal.b64url_decode(p_credential_id);
begin
    if v_self and not exists (select 1 from sgn.passkey_credential as k where k.credential_id = v_cred and k.suspension_id = v_suspension.id) then
        perform sgn_internal.raise_error('PASSKEY_RESTORE_KEY');
    end if;
    v_signer := sgn_internal.webauthn_verify_credential(
        sgn_internal.signing_challenge(v_challenge.purpose, v_suspension.id::text, sgn_internal.suspension_display(v_suspension),
            case when v_self then 'restore' else 'endorse' end, v_challenge.challenge),
        p_credential_id, p_authenticator_data, p_client_data_json, p_signature, v_self
    );
    perform sgn_internal.challenge_owner_check(v_challenge, v_signer);
    perform sgn_internal.authorize(v_signer, case when v_self then 'passkey.restore' else 'passkey.restore_endorse' end,
        sgn_internal.person_row(v_suspension.person_id));
    if (sgn_internal.passkey_suspension_open(v_suspension.person_id)).id is distinct from v_suspension.id then
        perform sgn_internal.raise_error('PASSKEY_NONE', 'suspension');
    end if;
    return sgn_internal.passkey_restore_step(v_suspension, v_signer, v_self,
        sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature), v_challenge);
end;
$$;

comment on function api.passkey_restore_passkey(uuid, text, text, text, text) is
    '恢復停用的通行金鑰的第二步：本人用被停用的原金鑰簽恢復的顯示摘要（之後等背書），或主管、登記人用自己的通行金鑰背書（之後金鑰恢復可用）。'
    '簽的人由驗章得出，進鏈並通知本人與主管。呼叫者：sgn_app。規則：K-PASSKEY-SUSPEND、K-DISPLAY-SIGNED';

-- 一步恢復（本人簽或背書）：存證明、轉移狀態、進鏈、通知。
create function sgn_internal.passkey_restore_step(
    p_suspension sgn.passkey_suspension, p_signer uuid, p_self boolean, p_raw jsonb, p_challenge sgn.auth_challenge
)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_status text;
    v_manager uuid := (sgn_internal.resolve_manager(p_suspension.person_id)).manager_person_id;
begin
    insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge, display_snapshot)
    values (p_challenge.id, 'passkey', p_raw, sgn_internal.jcs_sha256(p_raw), v_now,
        sgn_internal.signing_challenge(p_challenge.purpose, p_suspension.id::text, sgn_internal.suspension_display(p_suspension),
            case when p_self then 'restore' else 'endorse' end, p_challenge.challenge),
        sgn_internal.suspension_display(p_suspension));
    v_status := sgn_internal.entity_transition('passkey_suspension', p_suspension.status, case when p_self then 'self_confirm' else 'restore' end);
    update sgn.passkey_suspension
    set status = v_status,
        self_signed_at = case when p_self then v_now else self_signed_at end,
        self_credential_id = case when p_self then sgn_internal.b64url_decode(p_raw ->> 'credential_id') else self_credential_id end,
        restored_by = case when p_self then null else p_signer end,
        restored_at = case when p_self then null else v_now end
    where id = p_suspension.id;
    if not p_self then
        update sgn.passkey_credential set suspended_at = null, suspension_id = null
        where suspension_id = p_suspension.id and revoked_at is null;
    end if;
    perform sgn_internal.audit_append(case when p_self then 'passkey.restore_requested' else 'passkey.restored' end, null, p_signer,
        jsonb_build_object('person', p_suspension.person_id, 'suspension', p_suspension.id, 'credentials', p_suspension.credentials,
            'proof_sha256', encode(sgn_internal.jcs_sha256(p_raw), 'hex'), 'rules', jsonb_build_array('K-PASSKEY-SUSPEND')));
    perform sgn_internal.notify(
        case when p_self then 'passkey.restore_requested' else 'passkey.restored' end,
        array_remove(array[p_suspension.person_id, v_manager], null), null,
        jsonb_build_object('person_name', sgn_internal.person_name(p_suspension.person_id), 'by_name', sgn_internal.person_name(p_signer))
    );
    return jsonb_build_object('suspension_id', p_suspension.id, 'status', v_status, 'person', sgn_internal.person_display(p_suspension.person_id));
end;
$$;

-- 消耗一個挑戰值，用途是其中之一（同一個入口收本人與背書人的簽章）。
create function sgn_internal.challenge_consume_any(p_challenge_id uuid, p_purposes text[])
returns sgn.auth_challenge
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_purpose text := (select c.purpose from sgn.auth_challenge as c where c.id = p_challenge_id);
begin
    if v_purpose is null or not v_purpose = any (p_purposes) then
        perform sgn_internal.raise_error('CHALLENGE_PURPOSE', coalesce(v_purpose, 'unknown'));
    end if;
    return sgn_internal.challenge_consume(p_challenge_id, v_purpose);
end;
$$;

-- 目前登入的人（同 380 的簽章）：多 passkey_suspended（停用中的金鑰數；畫面提示恢復）。
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
            'passkey_suspended', (
                select count(*)::int from sgn.passkey_credential as k where k.person_id = p.id and k.revoked_at is null and k.suspended_at is not null
            ),
            'passkey_cooling_until', (
                select min(k.usable_from)
                from sgn.passkey_credential as k
                where k.person_id = p.id and k.usable_from > sgn_internal.now() and k.revoked_at is null and k.suspended_at is null
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
    '目前登入的人：姓名、可以簽章的通行金鑰數（沒撤銷、沒停用、已過冷卻期）、停用中的金鑰數、冷卻中的金鑰到什麼時候生效、待核准的登記、'
    '畫面可以顯示的功能。呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-PASSKEY-ENROLL、K-PASSKEY-REVOKE、K-PASSKEY-SUSPEND';

select sgn_internal.register_rule(
    'K-PASSKEY-SUSPEND',
    '本人只憑登入只能「停用」自己的全部通行金鑰（不是撤銷；裁決 D84 (2)）：立即不能簽、沒被核准的登記作廢、進鏈、通知本人與主管；'
    '每人每 24 小時最多 passkey.suspend_daily_max 次；持有治理類角色的人被停用即開例外 K-GOVERNANCE-KEY；'
    '本人用被停用的原金鑰簽恢復、再由本人的主管或登記人（不是本人、不持有不能做決定的角色）用自己的通行金鑰背書，才恢復可用',
    null,
    'full',
    null
);

select sgn_internal.register_rule(
    'K-PASSKEY-REVOKE',
    '撤銷一個人的全部通行金鑰（含冷卻中與停用中的）立即生效、進鏈、通知本人與主管：本人用金鑰簽，或本人的主管與登記人用自己的通行金鑰'
    '簽撤銷的顯示摘要；只憑登入只能停用（K-PASSKEY-SUSPEND）；其他人與不能做決定的角色都不行；沒被核准的登記一律作廢；'
    '手上的工作不改派；重新登記走第一把金鑰的背書',
    null,
    'full',
    null
);

insert into sgn.notification_template (event_code, subject, body) values
    ('passkey.suspended', '{{person_name}} 的通行金鑰已全部停用',
        '{{person_name}} 只憑登入停用了 {{count}} 把通行金鑰，立即生效。要恢復：本人用原來的金鑰申請，再請主管或登記人背書；'
        '裝置真的遺失，請主管或登記人撤銷後重新登記。不是你做的，請立刻通知資安。'),
    ('passkey.restore_requested', '{{person_name}} 申請恢復通行金鑰，等主管或登記人背書',
        '{{person_name}} 已用原來的通行金鑰簽了恢復。請主管或登記人在「通行金鑰」頁確認是本人之後背書。'),
    ('passkey.restored', '{{person_name}} 的通行金鑰已恢復',
        '{{by_name}} 背書了 {{person_name}} 的通行金鑰恢復，停用的金鑰已經可以再用來簽章。');
