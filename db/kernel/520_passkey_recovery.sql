-- 紅隊第七輪 高-1、中-1（裁決 D88 (1)(2)；redteam/exploits/49、48）。
--
-- 高-1 根因：D84 (2) 的分類漏了「復原路徑」。主管或登記人可以撤銷某人的全部金鑰（簽的撤銷），之後那個人走「第一把金鑰」的背書；
-- 冒用登入（金鑰同步帳號 G）替他登記攻擊者的金鑰，同一位主管或登記人背書，過冷卻期就能冒他做決定。
--   1. 撤銷某人金鑰的人，passkey.recovery_window_days 天內不得背書同一人的新金鑰（主管與登記人都適用；授權入口 denial_reason）。
--   2. 金鑰被別人撤銷之後（同一期間內）才登記的新金鑰是「復原」：冷卻期改用 passkey.recovery_cooling_workdays，
--      核准當下開例外 K-PASSKEY-RECOVERY，通知本人、本人的主管與 passkey.recovery_notify_categories 類別（預設治理類）的角色持有人。
--   3. 冷卻期內，本人只憑登入就能回報「不是我登記的」（api.passkey_report_not_me）：由別人背書、還在冷卻期的那把金鑰立即撤銷、
--      沒被核准的登記作廢、開例外 K-PASSKEY-NOT-ME、通知本人、主管、背書人與治理角色。只會收回（攻擊者冒用登入按它，最壞是作廢
--      一把合法的新金鑰），每人 passkey.not_me_window_days 天內最多 passkey.not_me_max 次，避免被拿來一直擋合法的重新登記。
--   殘餘（D88 接受）：兩位能背書的人串通（一人撤銷、另一人背書）再加冒用登入，仍可接管；但會開例外並通知，冷卻期加長，本人可回報。
--
-- 中-1 根因：只有一位登記人；全公司只憑登入的停用沒有上限。
--   4. 可用的登記人（持有登記人角色、有可用金鑰）少於 passkey.registrar_min（預設 2）即開例外 K-REGISTRAR-MIN 並通知；回到下限以上結案。
--      停用、撤銷、回報不是我、恢復時當場檢查，排程每輪檢查。
--   5. 全公司只憑登入的停用，passkey.suspend_global_window_hours 小時內最多 passkey.suspend_global_max 次；超過就拒絕（不停用）並開例外
--      K-PASSKEY-SUSPEND-FLOOD、通知。拒絕要留下例外，所以不丟錯（丟錯會連例外一起回捲），回傳 refused。
--   6. 破窗（資料庫擁有者的安裝儀式 sgn_internal.passkey_bootstrap）：只在可用的登記人少於下限時可以執行（原本是「一個都沒有」時），
--      進鏈；執行時機、見證與紀錄見 docs/handoff/redteam-fixes-7.md。

select sgn_internal.register_setting_definition(
    'passkey.recovery_window_days', 'integer', '30', array[]::text[],
    '別人撤銷某人的通行金鑰之後幾天內：撤銷的人不得背書此人的新金鑰；此人新登記的金鑰算「復原」（冷卻期加長、開例外 K-PASSKEY-RECOVERY）'
);
select sgn_internal.register_setting_definition(
    'passkey.recovery_cooling_workdays', 'integer', '5', array[]::text[],
    '復原的新金鑰（金鑰被別人撤銷之後才登記的）核准後幾個營業日才能簽章（一般的是 passkey.cooling_workdays）'
);
select sgn_internal.register_setting_definition(
    'passkey.recovery_notify_categories', 'json', '["governance"]', array[]::text[],
    '復原的新金鑰核准、本人回報不是我時，通知哪些類別（sgn.role.category）的角色持有人（本人與主管一律通知）'
);
select sgn_internal.register_setting_definition(
    'passkey.not_me_max', 'integer', '2', array[]::text[],
    '每人 passkey.not_me_window_days 天內最多回報幾次「不是我登記的」（K-PASSKEY-NOT-ME；只會收回，但不能一直擋合法的重新登記）'
);
select sgn_internal.register_setting_definition(
    'passkey.not_me_window_days', 'integer', '30', array[]::text[],
    '回報「不是我登記的」次數上限的時間窗（天）'
);
select sgn_internal.register_setting_definition(
    'passkey.registrar_min', 'integer', '2', array[]::text[],
    '可用的登記人（持有 passkey.registrar_role、有可用通行金鑰）少於幾位就開例外 K-REGISTRAR-MIN；也是安裝儀式（破窗）可以執行的條件'
);
select sgn_internal.register_setting_definition(
    'passkey.registrar_min_notify_roles', 'json', '["audit_head", "ciso", "passkey_registrar"]', array[]::text[],
    '可用的登記人少於下限（K-REGISTRAR-MIN）時通知哪些角色的持有人'
);
select sgn_internal.register_setting_definition(
    'passkey.suspend_global_max', 'integer', '10', array[]::text[],
    '全公司 passkey.suspend_global_window_hours 小時內最多幾次只憑登入的停用（K-PASSKEY-SUSPEND-FLOOD）；超過就拒絕並開例外'
);
select sgn_internal.register_setting_definition(
    'passkey.suspend_global_window_hours', 'integer', '24', array[]::text[],
    '全公司只憑登入停用次數上限的時間窗（小時）'
);
select sgn_internal.register_setting_definition(
    'passkey.suspend_global_notify_roles', 'json', '["audit_head", "ciso"]', array[]::text[],
    '全公司只憑登入的停用超過上限（K-PASSKEY-SUSPEND-FLOOD）時通知哪些角色的持有人'
);

insert into sgn.error_catalog (code, message, http_status) values
    ('PASSKEY_ENDORSER_REVOKER', '你最近撤銷了這個人的通行金鑰，這段期間不能替他背書新的金鑰；請另一位主管或登記人背書', 403),
    ('PASSKEY_NOT_ME_NONE', '沒有可以回報的金鑰：只有別人背書、還在冷卻期的新金鑰可以回報「不是我登記的」', 409),
    ('PASSKEY_NOT_ME_LIMIT', '這段期間回報「不是我登記的」的次數已達上限；請聯絡你的主管或資安處理', 429),
    ('PASSKEY_SUSPEND_GLOBAL_LIMIT', '今天全公司只憑登入停用通行金鑰的次數已達上限，這次沒有停用；請主管或登記人用通行金鑰撤銷，資安已收到通知', 429);

update sgn.error_catalog
set message = '可用的登記人沒有少於下限（passkey.registrar_min），不能以安裝儀式建立登記人'
where code = 'PASSKEY_BOOTSTRAP_DONE';

-- ── 共用 ──

-- 這些類別（sgn.role.category）的角色持有人。
create function sgn_internal.category_holders(p_categories jsonb)
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(distinct h order by h), '{}')
    from sgn.role as r
    cross join lateral unnest(sgn_internal.role_holders(r.code)) as h
    where r.category in (select jsonb_array_elements_text(p_categories))
$$;

-- 這些角色的持有人。
create function sgn_internal.roles_holders(p_roles jsonb)
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(distinct h order by h), '{}')
    from jsonb_array_elements_text(p_roles) as r (code)
    cross join lateral unnest(sgn_internal.role_holders(r.code)) as h
$$;

-- 這個人最近一次「被別人」撤銷全部金鑰（passkey.recovery_window_days 天內）；沒有時各欄為 null。
create function sgn_internal.passkey_recovery_revocation(p_person_id uuid)
returns sgn.passkey_revocation
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select r.*
    from sgn.passkey_revocation as r
    where r.person_id = p_person_id
      and r.revoked_by <> p_person_id
      and r.revoked_at > sgn_internal.now() - make_interval(days => sgn_internal.setting_int('passkey.recovery_window_days'))
    order by r.revoked_at desc
    limit 1
$$;

-- p_revoker 在期間內撤銷過 p_holder 的金鑰（D88 (1)：撤銷的人不得背書替換的金鑰）。
create function sgn_internal.passkey_revoked_by(p_holder uuid, p_revoker uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from sgn.passkey_revocation as r
        where r.person_id = p_holder
          and r.revoked_by = p_revoker
          and r.revoked_by <> r.person_id
          and r.revoked_at > sgn_internal.now() - make_interval(days => sgn_internal.setting_int('passkey.recovery_window_days'))
    )
$$;

-- 本人可以回報「不是我登記的」的金鑰：沒撤銷、還在冷卻期、由別人背書（第一把金鑰的路徑）。
create function sgn_internal.passkey_disownable(p_person_id uuid)
returns setof sgn.passkey_credential
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select k.*
    from sgn.passkey_credential as k
    where k.person_id = p_person_id
      and k.revoked_at is null
      and k.usable_from > sgn_internal.now()
      and exists (
          select 1 from sgn.passkey_enrollment as e
          where e.credential_id = k.credential_id and e.status = 'approved' and e.endorsed_by <> p_person_id
      )
    order by k.credential_id
$$;

-- ── 授權檢查的唯一入口（同 310 的簽章，通行金鑰核准的版本）：多了「撤銷的人不得背書」 ──
-- 規則：K-PASSKEY-ENROLL、K-PASSKEY-RECOVERY、K-AUDITOR-INDEPENDENT
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
        when sgn_internal.passkey_revoked_by(p_enrollment.person_id, p_person_id) then 'PASSKEY_ENDORSER_REVOKER'
        when (sgn_internal.resolve_manager(p_enrollment.person_id)).manager_person_id is not distinct from p_person_id then null
        when sgn_internal.has_role(p_person_id, sgn_internal.setting_text('passkey.registrar_role')) then null
        else 'PASSKEY_ENDORSER_NOT_ALLOWED'
    end
$$;

-- ── 授權檢查的唯一入口（同 500 的簽章，以人為對象的版本）：多了本人回報「不是我登記的」 ──
-- 規則：K-PASSKEY-REVOKE、K-PASSKEY-SUSPEND、K-PASSKEY-NOT-ME
create or replace function sgn_internal.denial_reason(p_person_id uuid, p_action text, p_holder sgn.person)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_action not in ('passkey.revoke', 'passkey.revoke_self', 'passkey.restore', 'passkey.restore_endorse', 'passkey.report_not_me')
            then 'ACTION_UNKNOWN'
        when p_holder.id is null or not p_holder.active then 'PERSON_UNKNOWN'
        when p_action = 'passkey.report_not_me' and p_person_id is distinct from p_holder.id then 'PASSKEY_REVOKE_NOT_ALLOWED'
        when p_action = 'passkey.report_not_me'
             and not exists (select 1 from sgn_internal.passkey_disownable(p_holder.id)) then 'PASSKEY_NOT_ME_NONE'
        when p_action = 'passkey.report_not_me' then null
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

-- ── 復原的新金鑰：冷卻期加長、當場開例外、通知（同 310 的簽章） ──

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
    v_revocation sgn.passkey_revocation := sgn_internal.passkey_recovery_revocation(p_enrollment.person_id);
    -- 復原：金鑰被別人撤銷之後才登記、由別人背書（本人用自己的舊金鑰核准的不算）
    v_recovery boolean := v_revocation.id is not null and p_enrollment.requested_at > v_revocation.revoked_at
        and p_signer <> p_enrollment.person_id;
    v_cooling_key text := case when v_recovery then 'passkey.recovery_cooling_workdays' else 'passkey.cooling_workdays' end;
    v_cooling int := sgn_internal.setting_int(v_cooling_key);
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
        'recovery_of', v_revocation.id,
        'settings', jsonb_build_object(
            v_cooling_key, v_cooling,
            'passkey.recovery_window_days', sgn_internal.setting_int('passkey.recovery_window_days'),
            'passkey.enrollment_code_cost', p_challenge.binding -> 'code_cost'
        ),
        'rules', jsonb_build_array('K-PASSKEY-ENROLL', 'K-DISPLAY-SIGNED', 'K-PASSKEY-RECOVERY')
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
    if v_recovery then
        perform sgn_internal.passkey_recovery_flag(v_row, v_revocation, v_usable_from, v_cooling);
    end if;
    return v_row;
end;
$$;

-- 復原的新金鑰：開例外、通知本人、主管與治理角色（K-PASSKEY-RECOVERY）。
create function sgn_internal.passkey_recovery_flag(
    p_enrollment sgn.passkey_enrollment, p_revocation sgn.passkey_revocation, p_usable_from timestamptz, p_cooling int
)
returns bigint
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_categories jsonb := sgn_internal.setting('passkey.recovery_notify_categories');
    v_id bigint;
begin
    v_id := sgn_internal.exception_open('K-PASSKEY-RECOVERY', null, jsonb_build_object(
        'person', p_enrollment.person_id,
        'credential_id', sgn_internal.b64url_encode(p_enrollment.credential_id),
        'enrollment', p_enrollment.id,
        'endorsed_by', p_enrollment.endorsed_by,
        'revocation', p_revocation.id,
        'revoked_by', p_revocation.revoked_by,
        'revoked_at', p_revocation.revoked_at,
        'usable_from', p_usable_from,
        'settings', jsonb_build_object(
            'passkey.recovery_window_days', sgn_internal.setting_int('passkey.recovery_window_days'),
            'passkey.recovery_cooling_workdays', p_cooling,
            'passkey.recovery_notify_categories', v_categories
        )
    ));
    perform sgn_internal.notify(
        'passkey.recovery_registered',
        array[p_enrollment.person_id, (sgn_internal.resolve_manager(p_enrollment.person_id)).manager_person_id]
            || sgn_internal.category_holders(v_categories),
        null,
        jsonb_build_object(
            'person_name', sgn_internal.person_name(p_enrollment.person_id),
            'revoked_by_name', sgn_internal.person_name(p_revocation.revoked_by),
            'endorser_name', sgn_internal.person_name(p_enrollment.endorsed_by),
            'usable_from', sgn_internal.local_minute_text(p_usable_from)
        )
    );
    return v_id;
end;
$$;

-- ── 可用的登記人下限（K-REGISTRAR-MIN） ──

-- 可用的登記人：持有登記人角色、有可用的通行金鑰、不持有不能做決定的角色（approval.excluded_decider_roles；那種人背書會被授權入口擋下）。
create function sgn_internal.registrar_available()
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(h order by h), '{}')
    from unnest(sgn_internal.role_holders(sgn_internal.setting_text('passkey.registrar_role'))) as h
    where sgn_internal.passkey_usable_count(h) > 0
      -- 和 holds_control_role 一樣直接看指派（不是授權判斷：只決定要不要開例外）
      and not exists (
          select 1
          from sgn.role_assignment as a
          where a.person_id = h
            and a.role_code in (select jsonb_array_elements_text(sgn_internal.setting('approval.excluded_decider_roles')))
            and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
      )
$$;

-- 少於下限、還沒有未結案的就開一筆並通知；回到下限以上就結案。p_open = false 只結案（安裝儀式用）。回傳 opened／closed／null。
create function sgn_internal.registrar_min_check(p_open boolean default true)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_min int := sgn_internal.setting_int('passkey.registrar_min');
    v_available uuid[] := sgn_internal.registrar_available();
    v_open bigint := (select min(x.id) from sgn.exception_record as x where x.rule_code = 'K-REGISTRAR-MIN' and x.closed_at is null);
    v_detail jsonb := jsonb_build_object(
        'available', to_jsonb(v_available),
        'holders', to_jsonb(sgn_internal.role_holders(sgn_internal.setting_text('passkey.registrar_role'))),
        'settings', jsonb_build_object('passkey.registrar_min', v_min, 'passkey.registrar_role', sgn_internal.setting_text('passkey.registrar_role'))
    );
begin
    perform pg_advisory_xact_lock(hashtext('sgn.registrar_min_check'));
    if cardinality(v_available) >= v_min then
        if v_open is not null and sgn_internal.exception_close(v_open, v_detail || jsonb_build_object('rules', jsonb_build_array('K-REGISTRAR-MIN'))) then
            return 'closed';
        end if;
        return null;
    end if;
    if not p_open or v_open is not null then
        return null;
    end if;
    perform sgn_internal.exception_open('K-REGISTRAR-MIN', null, v_detail);
    perform sgn_internal.notify(
        'passkey.registrar_min', sgn_internal.roles_holders(sgn_internal.setting('passkey.registrar_min_notify_roles')), null,
        jsonb_build_object('available', cardinality(v_available)::text, 'min', v_min::text)
    );
    return 'opened';
end;
$$;

-- 全公司只憑登入的停用超過上限：時間窗內還沒有未結案的就開一筆並通知；窗內次數回到上限以下就結案。
create function sgn_internal.passkey_suspend_flood_check(p_refused_person uuid)
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_max int := sgn_internal.setting_int('passkey.suspend_global_max');
    v_hours int := sgn_internal.setting_int('passkey.suspend_global_window_hours');
    v_recent int := (
        select count(*) from sgn.passkey_suspension as s where s.suspended_at > sgn_internal.now() - make_interval(hours => v_hours)
    );
    v_open bigint := (select min(x.id) from sgn.exception_record as x where x.rule_code = 'K-PASSKEY-SUSPEND-FLOOD' and x.closed_at is null);
    v_settings jsonb := jsonb_build_object('passkey.suspend_global_max', v_max, 'passkey.suspend_global_window_hours', v_hours);
begin
    if v_recent < v_max then
        if v_open is not null and sgn_internal.exception_close(v_open, jsonb_build_object(
            'recent', v_recent, 'settings', v_settings, 'rules', jsonb_build_array('K-PASSKEY-SUSPEND-FLOOD'))) then
            return 'closed';
        end if;
        return null;
    end if;
    if p_refused_person is null or v_open is not null then
        return null;
    end if;
    perform sgn_internal.exception_open('K-PASSKEY-SUSPEND-FLOOD', null, jsonb_build_object(
        'recent', v_recent, 'refused_person', p_refused_person, 'settings', v_settings));
    perform sgn_internal.notify(
        'passkey.suspend_flood', sgn_internal.roles_holders(sgn_internal.setting('passkey.suspend_global_notify_roles')), null,
        jsonb_build_object('recent', v_recent::text, 'hours', v_hours::text, 'person_name', sgn_internal.person_name(p_refused_person))
    );
    return 'opened';
end;
$$;

-- 金鑰有變動之後的檢查（停用、撤銷、回報不是我、恢復、排程）：治理類持有人、持有人例外的結案、登記人下限。
create function sgn_internal.passkey_holders_settle()
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    -- 先結案再檢查：狀況解除的先結掉，仍成立而且沒有未結案的才開新的
    return jsonb_build_object(
        'closed', sgn_internal.holder_key_exceptions_settle(),
        'exceptions', sgn_internal.governance_key_check(),
        'registrar', sgn_internal.registrar_min_check()
    );
end;
$$;

-- ── 停用（同 510 的簽章）：全公司的上限；之後檢查登記人下限 ──

create or replace function sgn_internal.passkey_suspend_all(p_person_id uuid, p_reason text)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_max int := sgn_internal.setting_int('passkey.suspend_daily_max');
    v_global_max int := sgn_internal.setting_int('passkey.suspend_global_max');
    v_global_hours int := sgn_internal.setting_int('passkey.suspend_global_window_hours');
    v_credentials jsonb;
    v_cancelled int;
    v_seq bigint;
    v_id uuid := gen_random_uuid();
begin
    if coalesce(btrim(p_reason), '') = '' then
        perform sgn_internal.raise_error('REASON_REQUIRED', 'passkey.suspend');
    end if;
    perform pg_advisory_xact_lock(hashtext('sgn.passkey_register:' || p_person_id::text));
    if (select count(*) from sgn.passkey_suspension as s where s.person_id = p_person_id and s.suspended_at > v_now - interval '24 hours') >= v_max then
        perform sgn_internal.raise_error('PASSKEY_SUSPEND_LIMIT', v_max::text);
    end if;
    -- 全公司的上限（D88 (2)）：先拿個人的鎖、再拿全公司的鎖（順序固定，不會互鎖）
    perform pg_advisory_xact_lock(hashtext('sgn.passkey_suspend_global'));
    if (select count(*) from sgn.passkey_suspension as s where s.suspended_at > v_now - make_interval(hours => v_global_hours)) >= v_global_max then
        perform sgn_internal.passkey_suspend_flood_check(p_person_id);
        return jsonb_build_object(
            'person', sgn_internal.person_display(p_person_id),
            'suspended', 0,
            'cancelled_enrollments', 0,
            'suspended_at', null,
            'refused', jsonb_build_object(
                'code', 'PASSKEY_SUSPEND_GLOBAL_LIMIT', 'message', sgn_internal.message_text('PASSKEY_SUSPEND_GLOBAL_LIMIT'))
        );
    end if;
    -- 先結掉這個人已經解除、排程還沒來得及結的持有人例外：這次是新的一次事故，要開新的一筆（去重只看未結案的）
    perform sgn_internal.holder_key_exceptions_settle(p_person_id);
    update sgn.passkey_suspension as s set status = sgn_internal.entity_transition('passkey_suspension', s.status, 'close')
    where s.person_id = p_person_id and s.status in ('suspended', 'self_confirmed');
    v_credentials := (sgn_internal.revocation_display(p_person_id)) -> 'credentials';
    update sgn.passkey_enrollment set status = 'cancelled' where person_id = p_person_id and status = 'pending';
    get diagnostics v_cancelled = row_count;
    v_seq := sgn_internal.audit_append('passkey.suspended', null, p_person_id, jsonb_build_object(
        'person', p_person_id, 'suspension', v_id, 'credentials', v_credentials,
        'reason_sha256', encode(sha256(convert_to(btrim(p_reason), 'UTF8')), 'hex'),
        'cancelled_enrollments', v_cancelled,
        'flagged_roles', sgn_internal.passkey_suspend_flagged_roles(p_person_id, sgn_internal.setting('passkey.suspend_exception_categories')),
        'settings', jsonb_build_object(
            'passkey.suspend_daily_max', v_max,
            'passkey.suspend_global_max', v_global_max,
            'passkey.suspend_global_window_hours', v_global_hours,
            'passkey.suspend_exception_categories', sgn_internal.setting('passkey.suspend_exception_categories')
        ),
        'rules', jsonb_build_array('K-PASSKEY-SUSPEND', 'K-PASSKEY-SUSPEND-FLOOD')
    ));
    insert into sgn.passkey_suspension (id, person_id, reason, credentials, suspended_at, event_seq, status)
    values (v_id, p_person_id, btrim(p_reason), v_credentials, v_now, v_seq, 'suspended');
    update sgn.passkey_credential set suspended_at = v_now, suspension_id = v_id
    where person_id = p_person_id and revoked_at is null and suspended_at is null;
    perform sgn_internal.passkey_suspend_flag(p_person_id, v_id);
    perform sgn_internal.notify(
        'passkey.suspended', array_remove(array[p_person_id, (sgn_internal.resolve_manager(p_person_id)).manager_person_id], null), null,
        jsonb_build_object('person_name', sgn_internal.person_name(p_person_id), 'count', jsonb_array_length(v_credentials))
    );
    perform sgn_internal.registrar_min_check();
    return jsonb_build_object(
        'person', sgn_internal.person_display(p_person_id),
        'suspended', jsonb_array_length(v_credentials),
        'cancelled_enrollments', v_cancelled,
        'suspended_at', v_now,
        'refused', null
    );
end;
$$;

comment on function api.passkey_revoke_self(text, text) is
    '本人只憑登入停用自己的全部通行金鑰（遺失裝置或懷疑被盜時；裁決 D84 (2)）：立即不能簽、沒被核准的登記作廢、進鏈、通知本人與主管；'
    '每人每 24 小時最多 passkey.suspend_daily_max 次；全公司 passkey.suspend_global_window_hours 小時內最多 passkey.suspend_global_max 次，'
    '超過就不停用、回傳 refused 並開例外 K-PASSKEY-SUSPEND-FLOOD（裁決 D88 (2)）；持有控制類或治理類角色的人當場開例外 '
    'K-PASSKEY-SUSPEND-HOLDER，治理類另開 K-GOVERNANCE-KEY；可用的登記人少於下限開 K-REGISTRAR-MIN。本人以原金鑰加上主管或登記人背書可恢復。'
    '呼叫者：sgn_app。規則：K-PASSKEY-SUSPEND、K-PASSKEY-SUSPEND-FLOOD、K-PASSKEY-SUSPEND-HOLDER、K-GOVERNANCE-KEY、K-REGISTRAR-MIN';

-- ── 撤銷（同 380 的簽章）：之後檢查治理類持有人與登記人下限 ──

create or replace function sgn_internal.passkey_revoke_all(p_target uuid, p_actor uuid, p_reason text, p_challenge sgn.auth_challenge, p_raw jsonb)
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
    perform pg_advisory_xact_lock(hashtext('sgn.passkey_register:' || p_target::text));
    perform 1 from sgn.passkey_credential where person_id = p_target and revoked_at is null for update;
    -- 先結掉已經解除、排程還沒來得及結的持有人例外（同停用）：撤光之後若仍是持有人，要開新的一筆
    perform sgn_internal.holder_key_exceptions_settle(p_target);
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
            'passkey.reenroll_after_unsigned_revocation', sgn_internal.setting('passkey.reenroll_after_unsigned_revocation'),
            'passkey.recovery_window_days', sgn_internal.setting_int('passkey.recovery_window_days')
        ),
        'rules', jsonb_build_array('K-PASSKEY-REVOKE', 'K-PASSKEY-RECOVERY')
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
    perform sgn_internal.passkey_holders_settle();
    return jsonb_build_object(
        'person', v_display -> 'person',
        'revoked', jsonb_array_length(v_display -> 'credentials'),
        'cancelled_enrollments', v_cancelled,
        'revoked_at', v_now,
        'reenroll_methods', sgn_internal.enrollment_methods(p_target)
    );
end;
$$;

-- ── 恢復（同 500 的簽章）：背書恢復之後當場結案狀況已解除的持有人例外、檢查登記人下限 ──

create or replace function sgn_internal.passkey_restore_step(
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
    if not p_self then
        perform sgn_internal.passkey_holders_settle();
    end if;
    return jsonb_build_object('suspension_id', p_suspension.id, 'status', v_status, 'person', sgn_internal.person_display(p_suspension.person_id));
end;
$$;

-- ── 本人回報「不是我登記的」（K-PASSKEY-NOT-ME） ──

create table sgn.passkey_disowned (
    id bigint generated always as identity primary key,
    person_id uuid not null references sgn.person (id),
    credential_id bytea not null,
    endorsed_by uuid references sgn.person (id),
    reported_at timestamptz not null,
    event_seq bigint not null
);

create index passkey_disowned_person_idx on sgn.passkey_disowned (person_id, reported_at);

-- 回報清單的一列：金鑰、誰背書、什麼時候背書、冷卻到什麼時候（畫面只從它畫）。
create function sgn_internal.passkey_disownable_display(p_credential sgn.passkey_credential)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'credential_id', sgn_internal.b64url_encode(p_credential.credential_id),
        'public_key_sha256', encode(sha256(p_credential.public_key), 'hex'),
        'endorsed_by', sgn_internal.person_display(e.endorsed_by),
        'endorsed_at', e.endorsed_at,
        'usable_from', p_credential.usable_from
    )
    from sgn.passkey_enrollment as e
    where e.credential_id = p_credential.credential_id and e.status = 'approved'
    order by e.endorsed_at desc
    limit 1
$$;

create function api.passkey_not_me_list(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_actions jsonb := case
        when sgn_internal.denial_reason(v_person_id, 'passkey.report_not_me', sgn_internal.person_row(v_person_id)) is null
            then '["report_not_me"]'::jsonb
        else '[]'::jsonb
    end;
begin
    return coalesce((
        select jsonb_agg(jsonb_build_object('display', sgn_internal.passkey_disownable_display(k), 'actions', v_actions)
            order by k.usable_from)
        from sgn_internal.passkey_disownable(v_person_id) as k
    ), '[]'::jsonb);
end;
$$;

comment on function api.passkey_not_me_list(text) is
    '看的人自己的、由別人背書而且還在冷卻期的新通行金鑰（可以回報「不是我登記的」；actions 是 report_not_me）。'
    'display 是回報畫面唯一的資料來源。呼叫者：sgn_app。規則：K-PASSKEY-NOT-ME';

create function api.passkey_report_not_me(p_session text, p_credential_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_now timestamptz := sgn_internal.now();
    v_max int := sgn_internal.setting_int('passkey.not_me_max');
    v_days int := sgn_internal.setting_int('passkey.not_me_window_days');
    v_categories jsonb := sgn_internal.setting('passkey.recovery_notify_categories');
    v_cred sgn.passkey_credential;
    v_display jsonb;
    v_reports int;
    v_cancelled int;
    v_seq bigint;
begin
    perform sgn_internal.authorize(v_person_id, 'passkey.report_not_me', sgn_internal.person_row(v_person_id));
    perform pg_advisory_xact_lock(hashtext('sgn.passkey_register:' || v_person_id::text));
    select * into v_cred from sgn_internal.passkey_disownable(v_person_id) as k
    where k.credential_id = sgn_internal.b64url_decode(p_credential_id);
    if v_cred.credential_id is null then
        perform sgn_internal.raise_error('PASSKEY_NOT_ME_NONE', p_credential_id);
    end if;
    v_reports := (select count(*) from sgn.passkey_disowned as d where d.person_id = v_person_id
                  and d.reported_at > v_now - make_interval(days => v_days));
    if v_reports >= v_max then
        perform sgn_internal.raise_error('PASSKEY_NOT_ME_LIMIT', format('%s in %s days', v_max, v_days));
    end if;
    v_display := sgn_internal.passkey_disownable_display(v_cred);
    update sgn.passkey_enrollment set status = 'cancelled' where person_id = v_person_id and status = 'pending';
    get diagnostics v_cancelled = row_count;
    v_seq := sgn_internal.audit_append('passkey.disowned', null, v_person_id, jsonb_build_object(
        'person', v_person_id, 'credential', v_display, 'cancelled_enrollments', v_cancelled, 'reports_in_window', v_reports + 1,
        'settings', jsonb_build_object('passkey.not_me_max', v_max, 'passkey.not_me_window_days', v_days),
        'rules', jsonb_build_array('K-PASSKEY-NOT-ME')
    ));
    update sgn.passkey_credential set revoked_at = v_now, revoked_seq = v_seq where credential_id = v_cred.credential_id;
    -- 本人只憑登入的撤銷：之後重新登記只能用 passkey.reenroll_after_unsigned_revocation 的核對方式（enrollment_methods）
    insert into sgn.passkey_revocation (person_id, revoked_by, signed, reason, credentials, revoked_at, event_seq, challenge_id)
    values (v_person_id, v_person_id, false, 'K-PASSKEY-NOT-ME', jsonb_build_array(v_display), v_now, v_seq, null);
    insert into sgn.passkey_disowned (person_id, credential_id, endorsed_by, reported_at, event_seq)
    values (v_person_id, v_cred.credential_id, (v_display #>> '{endorsed_by,id}')::uuid, v_now, v_seq);
    perform sgn_internal.exception_open('K-PASSKEY-NOT-ME', null, jsonb_build_object(
        'person', v_person_id, 'credential', v_display, 'reports_in_window', v_reports + 1,
        'settings', jsonb_build_object('passkey.not_me_max', v_max, 'passkey.not_me_window_days', v_days,
            'passkey.recovery_notify_categories', v_categories)
    ));
    perform sgn_internal.notify(
        'passkey.disowned',
        array[v_person_id, (sgn_internal.resolve_manager(v_person_id)).manager_person_id, (v_display #>> '{endorsed_by,id}')::uuid]
            || sgn_internal.category_holders(v_categories),
        null,
        jsonb_build_object('person_name', sgn_internal.person_name(v_person_id), 'endorser_name', v_display #>> '{endorsed_by,name}')
    );
    perform sgn_internal.passkey_holders_settle();
    return jsonb_build_object(
        'person', sgn_internal.person_display(v_person_id),
        'revoked', 1,
        'cancelled_enrollments', v_cancelled,
        'revoked_at', v_now,
        'reports_left', greatest(v_max - v_reports - 1, 0)
    );
end;
$$;

comment on function api.passkey_report_not_me(text, text) is
    '本人只憑登入回報「不是我登記的」（裁決 D88 (1)）：由別人背書、還在冷卻期的那把新金鑰立即撤銷、沒被核准的登記作廢、進鏈、'
    '開例外 K-PASSKEY-NOT-ME、通知本人、主管、背書人與 passkey.recovery_notify_categories 的角色持有人。只會收回；每人 '
    'passkey.not_me_window_days 天內最多 passkey.not_me_max 次。之後重新登記只能當面核對。呼叫者：sgn_app。規則：K-PASSKEY-NOT-ME';

-- ── 破窗：資料庫擁有者的安裝儀式（同 260 的簽章）：可用的登記人少於下限時才能執行 ──

create or replace function sgn_internal.passkey_bootstrap(p_person_id uuid, p_credential_id text, p_public_key_spki text, p_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_role text := sgn_internal.setting_text('passkey.registrar_role');
    v_point bytea := sgn_internal.p256_spki_to_point(sgn_internal.b64url_decode(p_public_key_spki));
    v_now timestamptz := sgn_internal.now();
    v_min int := sgn_internal.setting_int('passkey.registrar_min');
    v_available uuid[] := sgn_internal.registrar_available();
    v_seq bigint;
begin
    if cardinality(v_available) >= v_min then
        perform sgn_internal.raise_error('PASSKEY_BOOTSTRAP_DONE', format('%s available, min %s', cardinality(v_available), v_min));
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
        'available_before', to_jsonb(v_available),
        'settings', jsonb_build_object('passkey.registrar_min', v_min),
        'rules', jsonb_build_array('K-PASSKEY-ENROLL', 'K-REGISTRAR-MIN')
    ));
    if not p_person_id = any (sgn_internal.role_holders(v_role)) then
        insert into sgn.role_assignment (person_id, role_code, valid_from, source, change_event_seq)
        values (p_person_id, v_role, v_now, 'manual', v_seq);
    end if;
    insert into sgn.passkey_credential (credential_id, person_id, public_key, registered_at, registration_token_sha256, usable_from)
    values (sgn_internal.b64url_decode(p_credential_id), p_person_id, v_point, v_now, sha256(convert_to(p_reason, 'UTF8')), v_now);
    perform sgn_internal.audit_append('passkey.registered', null, p_person_id, jsonb_build_object(
        'credential_id', p_credential_id,
        'public_key_sha256', encode(sha256(v_point), 'hex'),
        'usable_from', v_now,
        'bootstrap_seq', v_seq
    ));
    perform sgn_internal.registrar_min_check(false);
end;
$$;

-- ── 排程（同 320 的簽章）：治理類持有人、持有人例外的結案、登記人下限、停用上限的結案 ──

create or replace function api_job.governance_check()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.passkey_holders_settle() || jsonb_build_object('suspend_flood', sgn_internal.passkey_suspend_flood_check(null));
end;
$$;

comment on function api_job.governance_check() is
    '治理類角色的持有人沒有可用的通行金鑰時開例外 K-GOVERNANCE-KEY；狀況解除的 K-GOVERNANCE-KEY、K-PASSKEY-SUSPEND-HOLDER 結案；'
    '可用的登記人少於 passkey.registrar_min 時開 K-REGISTRAR-MIN（回到下限結案）；只憑登入的停用回到上限以下時 K-PASSKEY-SUSPEND-FLOOD 結案。'
    '呼叫者：程式自己的資料庫角色（排程 db/tools/jobs.mjs）。規則：K-GOVERNANCE-KEY、K-EXCEPTION-CLOSE、K-REGISTRAR-MIN、K-PASSKEY-SUSPEND-FLOOD';

-- ── 目前登入的人（同 500 的簽章）：多 passkey_disownable（可以回報「不是我登記的」的金鑰數；首頁提示） ──

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
            'passkey_disownable', (select count(*)::int from sgn_internal.passkey_disownable(p.id)),
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
    '目前登入的人：姓名、可以簽章的通行金鑰數（沒撤銷、沒停用、已過冷卻期）、停用中的金鑰數、冷卻中的金鑰到什麼時候生效、'
    '可以回報「不是我登記的」的金鑰數、待核准的登記、畫面可以顯示的功能。呼叫者：sgn_app。'
    '規則：K-ACTOR-PROVEN、K-PASSKEY-ENROLL、K-PASSKEY-REVOKE、K-PASSKEY-SUSPEND、K-PASSKEY-NOT-ME';

-- ── 規則代碼與通知範本 ──

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-PASSKEY-RECOVERY',
        '復原路徑（裁決 D88 (1)）：撤銷某人金鑰的人 passkey.recovery_window_days 天內不得背書同一人的新金鑰（主管與登記人都適用）；'
        '金鑰被別人撤銷之後才登記、由別人背書的新金鑰，冷卻期改用 passkey.recovery_cooling_workdays，核准當下開例外，'
        '通知本人、本人的主管與 passkey.recovery_notify_categories 類別的角色持有人',
        'partial', '兩位能背書的人串通（一人撤銷、另一人背書）再加冒用登入仍可接管（D88 接受的殘餘）；只有事後的例外、通知與「不是我」'),
    ('K-PASSKEY-NOT-ME',
        '冷卻期內本人只憑登入就能回報「不是我登記的」：由別人背書、還在冷卻期的那把金鑰立即撤銷、沒被核准的登記作廢、進鏈、開例外、'
        '通知本人、主管、背書人與治理角色；只會收回，每人 passkey.not_me_window_days 天內最多 passkey.not_me_max 次',
        'full', null),
    ('K-REGISTRAR-MIN',
        '可用的登記人（持有 passkey.registrar_role、有可用通行金鑰）少於 passkey.registrar_min 就開例外並通知 '
        'passkey.registrar_min_notify_roles 的持有人，回到下限以上結案；停用、撤銷、回報不是我、恢復時當場檢查，排程每輪檢查；'
        '安裝儀式（破窗）只在少於下限時可以執行（裁決 D88 (2)）',
        'full', null),
    ('K-PASSKEY-SUSPEND-FLOOD',
        '全公司只憑登入的停用在 passkey.suspend_global_window_hours 小時內最多 passkey.suspend_global_max 次；超過就不停用、開例外並通知 '
        'passkey.suspend_global_notify_roles 的持有人（裁決 D88 (2)）；時間窗內的次數回到上限以下時結案',
        'full', null)
) as r (code, description, coverage, note);

insert into sgn.notification_template (event_code, subject, body) values
    ('passkey.recovery_registered', '{{person_name}} 的金鑰被撤銷後登記了新的金鑰',
        '{{person_name}} 的通行金鑰被 {{revoked_by_name}} 撤銷之後，{{endorser_name}} 背書了一把新的金鑰，{{usable_from}} 起才能簽章（冷卻期加長）。'
        '不是本人登記的，本人請在這之前登入平台，在「通行金鑰」頁按「不是我登記的」；系統已開例外。'),
    ('passkey.disowned', '{{person_name}} 回報新的通行金鑰不是本人登記的',
        '{{person_name}} 回報 {{endorser_name}} 背書的新金鑰不是本人登記的，這把金鑰已經撤銷。請資安檢查登入來源與背書的經過；重新登記只能當面核對。'),
    ('passkey.registrar_min', '可用的通行金鑰登記人只剩 {{available}} 位',
        '可用的登記人（有可用通行金鑰）少於 {{min}} 位，第一把金鑰與恢復的背書少了人。請盡快恢復或指派登記人；都不可用時由資料庫擁有者執行安裝儀式。'),
    ('passkey.suspend_flood', '只憑登入停用通行金鑰的次數超過上限',
        '{{hours}} 小時內已有 {{recent}} 次只憑登入的停用，這次（{{person_name}}）沒有停用。可能有人冒用登入大量停用金鑰，請檢查登入來源。');
