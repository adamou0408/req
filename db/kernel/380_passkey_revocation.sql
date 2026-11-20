-- 通行金鑰的撤銷與遺失全部裝置的補救（裁決 D65 的「遺失全部裝置」、D76 之後留下的缺口）。
--
-- 根因：D76 讓「已有金鑰的人，新金鑰只能由本人用舊金鑰核准」。遺失全部裝置的人因此沒有正式的路可以換金鑰，
-- 被偷走的裝置也沒有辦法停用。
--
-- 這一版（威脅表見 docs/handoff/leftovers-1.md 第 2 節）：
--   1. 撤銷一個人的「全部」金鑰（含冷卻中的），立即生效：之後用這些金鑰簽的任何東西都被拒（PASSKEY_REVOKED），
--      進行中的挑戰值也一樣。已經做成的決定不變（當時金鑰有效；證據頁照樣驗得過，金鑰的撤銷事件也在鏈上）。
--   2. 誰能撤誰：
--        本人：用已生效的金鑰簽（signed），或遺失全部裝置時只憑登入（unsigned）；
--        本人的主管、登記人（passkey.registrar_role）：一律用自己的通行金鑰簽撤銷的顯示摘要（本人、每一把金鑰、原因）。
--        持有不能做決定的角色（稽核、技術維運）的人不能替別人撤銷。其他人都不行。
--   3. 撤銷後重新登記走「第一把金鑰」：主管或登記人背書。只憑登入的撤銷（被入侵的後端拿得到使用者的工作階段，
--      也做得到）之後，背書只能用參數 passkey.reenroll_after_unsigned_revocation 列的方式（預設只有當面掃 QR 碼），
--      讓「先撤銷、再用電話騙主管念碼」這條降級的路走不通。
--   4. 撤銷時這個人還沒被核准的登記一律作廢（可能是攻擊者趁機排進來的）；重新登記從頭來。
--   5. 這個人手上的工作不改派：他仍是可問責的簽核人，重新登記並過冷卻期後繼續處理；
--      撤銷若會讓工作換人，撤銷別人的金鑰就成了「挑簽核人」的手段。
--   6. 撤銷進鏈，通知本人與主管（經 SMTP 寄出）。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('passkey.reenroll_after_unsigned_revocation', 'json', '["qr"]', '{}',
        '本人只憑登入（沒有用通行金鑰簽）撤銷全部金鑰之後，重新登記的背書可以用的核對方式（qr：當面掃 QR 碼；code：12 位數核對碼）');

insert into sgn.error_catalog (code, message, http_status) values
    ('PASSKEY_REVOKED', '這把通行金鑰已經撤銷，不能再用來簽章；請重新登記', 403),
    ('PASSKEY_NONE', '這個人沒有可以撤銷的通行金鑰', 409),
    ('PASSKEY_REVOKE_NOT_ALLOWED', '你不能撤銷這個人的通行金鑰：只有本人、本人的主管或登記人可以，而且替別人撤銷要用你自己的通行金鑰確認', 403),
    ('PASSKEY_METHOD_NOT_ALLOWED', '這個人是自己撤銷金鑰的，重新登記要當面掃描新裝置上的 QR 碼核對，不能用念碼的方式', 403);

alter table sgn.auth_challenge
    drop constraint auth_challenge_purpose_check,
    add constraint auth_challenge_purpose_check check (purpose in (
        'session', 'passkey_register', 'decision', 'role_change',
        'case.decision', 'role_change.propose', 'role_change.decision', 'passkey.enrollment', 'passkey.revocation'
    ));

alter table sgn.passkey_credential
    add column revoked_at timestamptz,
    add column revoked_seq bigint;

alter table sgn.passkey_enrollment
    drop constraint passkey_enrollment_status_check;

alter table sgn.passkey_enrollment
    add constraint passkey_enrollment_status_check check (status in ('pending', 'approved', 'cancelled'));

create table sgn.passkey_revocation (
    id uuid primary key default gen_random_uuid(),
    person_id uuid not null references sgn.person (id),
    revoked_by uuid not null references sgn.person (id),
    -- 撤銷的人有沒有用通行金鑰簽（本人遺失全部裝置時沒有）
    signed boolean not null,
    reason text not null,
    credentials jsonb not null,
    revoked_at timestamptz not null,
    event_seq bigint not null,
    challenge_id uuid references sgn.auth_challenge (id),
    check (signed = (challenge_id is not null))
);

-- ── 金鑰的計數只算沒撤銷的 ──

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
$$;

-- 已核准（含冷卻中）、沒撤銷的金鑰數。0 就走「第一把金鑰」的背書（K-PASSKEY-ENROLL）。
create or replace function sgn_internal.passkey_any_count(p_person_id uuid)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select count(*)::int from sgn.passkey_credential as k where k.person_id = p_person_id and k.revoked_at is null
$$;

-- WebAuthn assertion 驗證（同 250 的簽章）：多了「金鑰已撤銷」。
create or replace function sgn_internal.webauthn_verify(
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

-- ── 撤銷之後的重新登記 ──

-- 這個人的登記可以用哪些核對方式背書：最近一次撤銷是本人只憑登入做的，就只能用參數列的方式。
create function sgn_internal.enrollment_methods(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when (
            select r.signed from sgn.passkey_revocation as r where r.person_id = p_person_id order by r.revoked_at desc limit 1
        ) is false then sgn_internal.setting('passkey.reenroll_after_unsigned_revocation')
        else '["qr", "code"]'::jsonb
    end
$$;

-- 待核准的登記（同 310 的簽章）：多了 methods（背書可以用的核對方式）。
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
        'methods', sgn_internal.enrollment_methods(p_enrollment.person_id),
        'display', sgn_internal.enrollment_display(p_enrollment),
        'actions', case
            when sgn_internal.denial_reason(p_viewer, 'passkey.endorse', p_enrollment) is null then '["endorse"]'::jsonb
            else '[]'::jsonb
        end
    )
$$;

-- 背書的第一步（同 310 的簽章）：核對方式必須是這筆登記允許的（本人只憑登入撤銷之後只能當面掃 QR 碼）。
create or replace function api.passkey_endorse_challenge(p_session text, p_enrollment_id uuid, p_method text)
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
    if v_person_id <> v_enrollment.person_id and not sgn_internal.enrollment_methods(v_enrollment.person_id) ? p_method then
        perform sgn_internal.raise_error('PASSKEY_METHOD_NOT_ALLOWED', p_method);
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
    'passkey.enrollment_code_cost），發一次性亂數。本人只憑登入撤銷全部金鑰之後，只能用 '
    'passkey.reenroll_after_unsigned_revocation 列的方式。瀏覽器用亂數和畫面上的顯示摘要、核對方式與成本自己算挑戰值再簽。'
    '呼叫者：sgn_app。規則：K-PASSKEY-ENROLL、K-PASSKEY-REVOKE、K-DISPLAY-SIGNED';

-- ── 撤銷 ──

-- 授權檢查的唯一入口（撤銷通行金鑰的版本；與申請單、金鑰登記的版本同名，以第三個參數的型別區分）。
-- 動作：passkey.revoke（用自己的通行金鑰簽）、passkey.revoke_self（本人只憑登入）。回傳拒絕代碼；可以時回 null。
-- 規則：K-PASSKEY-REVOKE、K-AUDITOR-INDEPENDENT
create or replace function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_holder sgn.person)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_action not in ('passkey.revoke', 'passkey.revoke_self') then 'ACTION_UNKNOWN'
        when p_holder.id is null or not p_holder.active then 'PERSON_UNKNOWN'
        when p_person_id = p_holder.id and sgn_internal.passkey_any_count(p_holder.id) > 0 then null
        when p_person_id = p_holder.id then 'PASSKEY_NONE'
        when p_action = 'passkey.revoke_self' then 'PASSKEY_REVOKE_NOT_ALLOWED'
        when exists (
            select 1
            from jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')) as r (role_code)
            where sgn_internal.has_role(p_person_id, r.role_code)
        ) then 'DECIDER_ROLE_EXCLUDED'
        when (sgn_internal.resolve_manager(p_holder.id)).manager_person_id is distinct from p_person_id
             and not sgn_internal.has_role(p_person_id, sgn_internal.setting_text('passkey.registrar_role')) then 'PASSKEY_REVOKE_NOT_ALLOWED'
        when sgn_internal.passkey_any_count(p_holder.id) = 0 then 'PASSKEY_NONE'
    end
$$;

-- 不允許就丟錯（撤銷通行金鑰的版本）。
create or replace function sgn_internal.authorize(p_person_id uuid, p_action text, p_holder sgn.person)
returns void
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_denial text := sgn_internal.denial_reason(p_person_id, p_action, p_holder);
begin
    if v_denial is not null then
        perform sgn_internal.raise_error(v_denial, p_action);
    end if;
end;
$$;

create function sgn_internal.person_row(p_person_id uuid)
returns sgn.person
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p.* from sgn.person as p where p.id = p_person_id
$$;

-- 撤銷的顯示摘要：本人、每一把沒撤銷的金鑰（編號、完整指紋、從什麼時候能用）。畫面只從它畫。
create function sgn_internal.revocation_display(p_person_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'person', sgn_internal.person_display(p_person_id),
        'credentials', coalesce((
            select jsonb_agg(jsonb_build_object(
                'credential_id', sgn_internal.b64url_encode(k.credential_id),
                'public_key_sha256', encode(sha256(k.public_key), 'hex'),
                'usable_from', to_char(k.usable_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            ) order by k.credential_id)
            from sgn.passkey_credential as k
            where k.person_id = p_person_id
              and k.revoked_at is null
        ), '[]'::jsonb)
    )
$$;

-- 撤銷要簽的內容（唯一來源；瀏覽器端見 web/pages/passkeys.js）：顯示摘要加上原因（去掉前後空白）。
create function sgn_internal.revocation_signed_content(p_person_id uuid, p_reason text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.revocation_display(p_person_id) || jsonb_build_object('reason', btrim(p_reason))
$$;

-- 撤銷這個人的全部金鑰（立即生效）：作廢沒被核准的登記、進鏈、通知本人與主管。手上的工作不改派。
create function sgn_internal.passkey_revoke_all(p_target uuid, p_actor uuid, p_reason text, p_challenge sgn.auth_challenge, p_raw jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_signed boolean := p_challenge.id is not null;
    v_display jsonb;
    v_cancelled int;
    v_seq bigint;
begin
    if coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED', 'passkey.revoke');
    end if;
    -- 同一個人的撤銷與登記排隊（和 passkey_register 同一把鎖）
    perform pg_advisory_xact_lock(hashtext('sgn.passkey_register:' || p_target::text));
    perform 1 from sgn.passkey_credential where person_id = p_target and revoked_at is null for update;
    v_display := sgn_internal.revocation_display(p_target);
    if v_signed then
        insert into sgn.decision_proof (challenge_id, kind, raw, raw_sha256, created_at, signed_challenge, display_snapshot)
        values (
            p_challenge.id, 'passkey', p_raw, sgn_internal.jcs_sha256(p_raw), v_now,
            sgn_internal.signing_challenge(
                p_challenge.purpose, p_target::text, sgn_internal.revocation_signed_content(p_target, p_reason), 'revoke', p_challenge.challenge
            ),
            v_display
        );
    end if;
    update sgn.passkey_enrollment set status = 'cancelled' where person_id = p_target and status = 'pending';
    get diagnostics v_cancelled = row_count;
    v_seq := sgn_internal.audit_append('passkey.revoked', null, p_actor, jsonb_build_object(
        'person', p_target,
        'by', case when p_actor = p_target then 'self' else 'other' end,
        'signed', v_signed,
        'credentials', (select jsonb_agg(c - 'usable_from') from jsonb_array_elements(v_display -> 'credentials') as c),
        'reason_sha256', encode(sha256(convert_to(btrim(p_reason), 'UTF8')), 'hex'),
        'cancelled_enrollments', v_cancelled,
        'proof_sha256', case when v_signed then encode(sgn_internal.jcs_sha256(p_raw), 'hex') end,
        'reenroll_methods', case
            when v_signed then '["qr", "code"]'::jsonb
            else sgn_internal.setting('passkey.reenroll_after_unsigned_revocation')
        end,
        'settings', jsonb_build_object(
            'passkey.reenroll_after_unsigned_revocation', sgn_internal.setting('passkey.reenroll_after_unsigned_revocation')
        ),
        'rules', jsonb_build_array('K-PASSKEY-REVOKE')
    ));
    update sgn.passkey_credential set revoked_at = v_now, revoked_seq = v_seq where person_id = p_target and revoked_at is null;
    insert into sgn.passkey_revocation (person_id, revoked_by, signed, reason, credentials, revoked_at, event_seq, challenge_id)
    values (p_target, p_actor, v_signed, btrim(p_reason), v_display -> 'credentials', v_now, v_seq, p_challenge.id);
    perform sgn_internal.notify(
        'passkey.revoked',
        array[p_target, (sgn_internal.resolve_manager(p_target)).manager_person_id],
        null,
        jsonb_build_object(
            'person_name', sgn_internal.person_name(p_target),
            'revoked_by_name', sgn_internal.person_name(p_actor),
            'count', jsonb_array_length(v_display -> 'credentials')
        )
    );
    return jsonb_build_object(
        'person', v_display -> 'person',
        'revoked', jsonb_array_length(v_display -> 'credentials'),
        'cancelled_enrollments', v_cancelled,
        'revoked_at', v_now,
        'reenroll_methods', sgn_internal.enrollment_methods(p_target)
    );
end;
$$;

-- 撤銷清單的一列：看的人可以做的動作（revoke_self＝本人只憑登入；revoke＝用通行金鑰簽）。
create function sgn_internal.revocation_row(p_holder sgn.person, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'display', sgn_internal.revocation_display(p_holder.id),
        'actions', to_jsonb(array_remove(array[
            case when sgn_internal.denial_reason(p_viewer, 'passkey.revoke_self', p_holder) is null then 'revoke_self' end,
            case
                when sgn_internal.passkey_usable_count(p_viewer) > 0
                     and sgn_internal.denial_reason(p_viewer, 'passkey.revoke', p_holder) is null then 'revoke'
            end
        ], null))
    )
$$;

create function api.passkey_revocation_list(p_session text)
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
            select p.id as person_id, sgn_internal.revocation_row(p, v_person_id) as row
            from sgn.person as p
            where p.active
              and exists (select 1 from sgn.passkey_credential as k where k.person_id = p.id and k.revoked_at is null)
        ) as r
        where jsonb_array_length(r.row -> 'actions') > 0
    ), '[]'::jsonb);
end;
$$;

comment on function api.passkey_revocation_list(text) is
    '看的人可以撤銷誰的通行金鑰：本人（revoke_self 只憑登入；有可用金鑰時也可以 revoke 用金鑰簽），'
    '以及他是主管或登記人的人（revoke，一律用自己的通行金鑰簽）。display 是撤銷畫面唯一的資料來源。'
    '呼叫者：sgn_app。規則：K-PASSKEY-REVOKE';

-- 本人遺失全部裝置：只憑登入撤銷自己的全部金鑰。之後重新登記只能用 passkey.reenroll_after_unsigned_revocation 的方式背書。
create function api.passkey_revoke_self(p_session text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
begin
    perform sgn_internal.authorize(v_person_id, 'passkey.revoke_self', sgn_internal.person_row(v_person_id));
    return sgn_internal.passkey_revoke_all(v_person_id, v_person_id, p_reason, null::sgn.auth_challenge, null);
end;
$$;

comment on function api.passkey_revoke_self(text, text) is
    '本人撤銷自己的全部通行金鑰（遺失全部裝置時，只憑登入）：立即生效、沒被核准的登記作廢、進鏈、通知本人與主管；'
    '重新登記走第一把金鑰的背書，只能用 passkey.reenroll_after_unsigned_revocation 的核對方式。手上的工作不改派。'
    '呼叫者：sgn_app。規則：K-PASSKEY-REVOKE';

-- 用通行金鑰撤銷（本人、主管、登記人）的第一步：發一次性亂數；畫面從清單的顯示摘要加上原因自己算挑戰值。
create function api.passkey_revoke_challenge(p_session text, p_holder_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_row sgn.auth_challenge;
begin
    perform sgn_internal.authorize(v_person_id, 'passkey.revoke', sgn_internal.person_row(p_holder_id));
    if coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED', 'passkey.revoke');
    end if;
    v_row := sgn_internal.challenge_new(
        'passkey.revocation', jsonb_build_object('holder_id', p_holder_id, 'reason', btrim(p_reason)), v_person_id
    );
    return jsonb_build_object(
        'challenge_id', v_row.id,
        'nonce', sgn_internal.b64url_encode(v_row.challenge),
        'expires_at', v_row.expires_at,
        'display', sgn_internal.revocation_display(p_holder_id)
    );
end;
$$;

comment on function api.passkey_revoke_challenge(text, uuid, text) is
    '用通行金鑰撤銷某人全部金鑰的第一步：檢查資格（本人、本人的主管或登記人；不得持有不能做決定的角色）、發一次性亂數。'
    '呼叫者：sgn_app。規則：K-PASSKEY-REVOKE、K-DISPLAY-SIGNED';

create function api.passkey_revoke_passkey(
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
    v_challenge sgn.auth_challenge := sgn_internal.challenge_consume(p_challenge_id, 'passkey.revocation');
    v_target uuid := (v_challenge.binding ->> 'holder_id')::uuid;
    v_reason text := v_challenge.binding ->> 'reason';
    v_signer uuid;
begin
    v_signer := sgn_internal.signature_verify(
        v_challenge,
        v_target::text,
        sgn_internal.revocation_signed_content(v_target, v_reason),
        'revoke',
        p_credential_id,
        p_authenticator_data,
        p_client_data_json,
        p_signature
    );
    perform sgn_internal.authorize(v_signer, 'passkey.revoke', sgn_internal.person_row(v_target));
    perform sgn_internal.challenge_owner_check(v_challenge, v_signer);
    return sgn_internal.passkey_revoke_all(
        v_target, v_signer, v_reason, v_challenge,
        sgn_internal.passkey_raw(p_credential_id, p_authenticator_data, p_client_data_json, p_signature)
    );
end;
$$;

comment on function api.passkey_revoke_passkey(uuid, text, text, text, text) is
    '用通行金鑰撤銷某人全部金鑰的第二步：簽的是撤銷的顯示摘要（本人、每一把金鑰、原因），資料庫以自己的紀錄重算；'
    '撤銷人由驗章得出。立即生效、沒被核准的登記作廢、進鏈、通知本人與主管；手上的工作不改派。'
    '呼叫者：sgn_app。規則：K-PASSKEY-REVOKE、K-DISPLAY-SIGNED';

-- 目前登入的人（同 260 的簽章）：冷卻中的金鑰不算撤銷了的。
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
                select min(k.usable_from)
                from sgn.passkey_credential as k
                where k.person_id = p.id and k.usable_from > sgn_internal.now() and k.revoked_at is null
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
    '目前登入的人：姓名、可以簽章的通行金鑰數（沒撤銷、已過冷卻期）、冷卻中的金鑰到什麼時候生效、待核准的登記、'
    '畫面可以顯示的功能。呼叫者：sgn_app。規則：K-ACTOR-PROVEN、K-PASSKEY-ENROLL、K-PASSKEY-REVOKE';

insert into sgn.notification_template (event_code, subject, body) values
    ('passkey.revoked', '{{person_name}} 的通行金鑰已全部撤銷',
        '由 {{revoked_by_name}} 撤銷了 {{count}} 把通行金鑰，立即生效。要再簽核，請重新登記一把，並請主管或登記人背書。'
        '不是你做的，請立刻通知資安。')
on conflict (event_code) do update set subject = excluded.subject, body = excluded.body;

select sgn_internal.register_rule(
    'K-PASSKEY-REVOKE',
    '撤銷一個人的全部通行金鑰（含冷卻中的）立即生效、進鏈、通知本人與主管：本人可以只憑登入（遺失全部裝置）或用金鑰簽，'
    '本人的主管與登記人一律用自己的通行金鑰簽撤銷的顯示摘要，其他人與不能做決定的角色都不行；沒被核准的登記一律作廢；'
    '手上的工作不改派；重新登記走第一把金鑰的背書，本人只憑登入撤銷之後只能用 passkey.reenroll_after_unsigned_revocation 的方式',
    null,
    'full',
    null
);

select sgn_internal.register_rule(
    'K-PASSKEY-ENROLL',
    '通行金鑰的登記不只靠後端經手的登入：身分提供者再驗證之後只是待核准；已有金鑰的人只能本人用已生效的舊金鑰核准，'
    '任何人不得背書；第一把金鑰由本人的主管或登記人以通行金鑰背書，比對完整指紋（當面用手機掃新裝置畫面上的 QR 碼，或不在場時'
    '由慢速雜湊算出的 12 位數核對碼，成本 passkey.enrollment_code_cost），背書人不得是本人；每人 24 小時內沒被核准的登記有上限'
    '（passkey.enrollment_daily_max）；核准後有冷卻期（passkey.cooling_workdays）才能簽章；登記、背書、生效都進鏈並經 SMTP '
    '通知本人與主管；第一位登記人由資料庫擁有者在安裝時建立',
    null,
    'partial',
    '掃 QR 碼用瀏覽器內建的 BarcodeDetector：iPhone 的 Safari 沒有，只能當面掃的登記（本人只憑登入撤銷之後）在 iPhone 上背書不了'
);
