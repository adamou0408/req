-- 裁決 D86 (3)：只憑登入停用通行金鑰時，當事人只要持有控制類或治理類角色（資安長、登記人、三種治理角色……）就當場開例外並通知，
-- 不只三種治理角色。500 只看 category = 'governance'：登記人被冒用登入停用之後，所有新金鑰的背書都少了一個人，卻沒有人知道。
--   - 哪些類別算數是參數（passkey.suspend_exception_categories，預設控制類與治理類），依 sgn.role 的類別判斷，不寫死任何角色。
--   - 例外 K-PASSKEY-SUSPEND-HOLDER：detail 列出當事人持有的這些角色與類別、用到的參數；同時通知參數
--     passkey.suspend_exception_notify_roles 的角色持有人（不含當事人；當事人與主管已經收到 passkey.suspended）。
--   - K-GOVERNANCE-KEY 的語意是「治理類角色的持有人必須有可用的通行金鑰」，控制類不適用，所以另開新代碼；
--     治理類的持有人照舊另開 K-GOVERNANCE-KEY（否則排程 governance_check 也會在下一輪開，結果一樣但晚了）。

select sgn_internal.register_setting_definition(
    'passkey.suspend_exception_categories', 'json', '["control", "governance"]', array[]::text[],
    '只憑登入停用通行金鑰時，當事人持有哪些類別（sgn.role.category）的角色就開例外 K-PASSKEY-SUSPEND-HOLDER'
);

select sgn_internal.register_setting_definition(
    'passkey.suspend_exception_notify_roles', 'json', '["audit_head", "ciso", "passkey_registrar"]', array[]::text[],
    '控制類或治理類角色的持有人只憑登入停用通行金鑰（K-PASSKEY-SUSPEND-HOLDER）時通知哪些角色的持有人'
);

-- 當事人現在持有、而且類別在參數裡的角色（任何適用範圍都算）：[{code, category}]，依代碼排序。
create function sgn_internal.passkey_suspend_flagged_roles(p_person_id uuid, p_categories jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    -- 和 sgn_internal.holds_control_role 同樣直接看指派（不是授權判斷：不決定誰能做什麼，只決定要不要開例外）
    select coalesce(jsonb_agg(jsonb_build_object('code', r.code, 'category', r.category) order by r.code), '[]'::jsonb)
    from sgn.role as r
    where r.category in (select jsonb_array_elements_text(p_categories))
      and exists (
          select 1
          from sgn.role_assignment as a
          where a.person_id = p_person_id
            and a.role_code = r.code
            and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
      )
$$;

-- 停用之後的例外與通知（K-PASSKEY-SUSPEND-HOLDER；治理類另開 K-GOVERNANCE-KEY）。回傳被列入的角色。
create function sgn_internal.passkey_suspend_flag(p_person_id uuid, p_suspension_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_categories jsonb := sgn_internal.setting('passkey.suspend_exception_categories');
    v_notify_roles jsonb := sgn_internal.setting('passkey.suspend_exception_notify_roles');
    v_roles jsonb := sgn_internal.passkey_suspend_flagged_roles(p_person_id, v_categories);
    v_governance jsonb;
    v_people uuid[];
begin
    if v_roles = '[]'::jsonb then
        return v_roles;
    end if;
    perform sgn_internal.exception_open('K-PASSKEY-SUSPEND-HOLDER', null, jsonb_build_object(
        'person', p_person_id, 'roles', v_roles, 'suspension', p_suspension_id,
        'settings', jsonb_build_object(
            'passkey.suspend_exception_categories', v_categories,
            'passkey.suspend_exception_notify_roles', v_notify_roles
        )
    ));
    v_governance := (
        select coalesce(jsonb_agg(r -> 'code' order by r ->> 'code'), '[]'::jsonb)
        from jsonb_array_elements(v_roles) as r
        where r ->> 'category' = 'governance'
    );
    if v_governance <> '[]'::jsonb then
        perform sgn_internal.exception_open('K-GOVERNANCE-KEY', null, jsonb_build_object(
            'kind', 'governance_holder_suspended', 'person', p_person_id, 'roles', v_governance, 'suspension', p_suspension_id));
    end if;
    select coalesce(array_agg(distinct h), '{}') into v_people
    from jsonb_array_elements_text(v_notify_roles) as n (code)
    cross join lateral unnest(sgn_internal.role_holders(n.code)) as h
    where h <> p_person_id;
    perform sgn_internal.notify('passkey.holder_suspended', v_people, null, jsonb_build_object(
        'person_name', sgn_internal.person_name(p_person_id),
        'roles', (select string_agg(g.name, '、' order by g.code) from sgn.role as g
                  where g.code in (select r ->> 'code' from jsonb_array_elements(v_roles) as r))
    ));
    return v_roles;
end;
$$;

-- 同 500 的簽章：類別的判斷與例外移到 passkey_suspend_flag；其餘不變。
create or replace function sgn_internal.passkey_suspend_all(p_person_id uuid, p_reason text)
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
    v_seq := sgn_internal.audit_append('passkey.suspended', null, p_person_id, jsonb_build_object(
        'person', p_person_id, 'suspension', v_id, 'credentials', v_credentials,
        'reason_sha256', encode(sha256(convert_to(btrim(p_reason), 'UTF8')), 'hex'),
        'cancelled_enrollments', v_cancelled,
        'flagged_roles', sgn_internal.passkey_suspend_flagged_roles(p_person_id, sgn_internal.setting('passkey.suspend_exception_categories')),
        'settings', jsonb_build_object(
            'passkey.suspend_daily_max', v_max,
            'passkey.suspend_exception_categories', sgn_internal.setting('passkey.suspend_exception_categories')
        ),
        'rules', jsonb_build_array('K-PASSKEY-SUSPEND')
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
    return jsonb_build_object(
        'person', sgn_internal.person_display(p_person_id),
        'suspended', jsonb_array_length(v_credentials),
        'cancelled_enrollments', v_cancelled,
        'suspended_at', v_now
    );
end;
$$;

comment on function api.passkey_revoke_self(text, text) is
    '本人只憑登入停用自己的全部通行金鑰（遺失裝置或懷疑被盜時；裁決 D84 (2)）：立即不能簽、沒被核准的登記作廢、進鏈、通知本人與主管；'
    '每人每 24 小時最多 passkey.suspend_daily_max 次；持有控制類或治理類角色（passkey.suspend_exception_categories）的人'
    '當場開例外 K-PASSKEY-SUSPEND-HOLDER 並通知（裁決 D86 (3)），治理類另開 K-GOVERNANCE-KEY。本人以原金鑰加上主管或登記人背書可恢復；'
    '真的遺失由主管或登記人用通行金鑰撤銷。呼叫者：sgn_app。規則：K-PASSKEY-SUSPEND、K-PASSKEY-SUSPEND-HOLDER、K-GOVERNANCE-KEY';

select sgn_internal.register_rule(
    'K-PASSKEY-SUSPEND',
    '本人只憑登入只能「停用」自己的全部通行金鑰（不是撤銷；裁決 D84 (2)）：立即不能簽、沒被核准的登記作廢、進鏈、通知本人與主管；'
    '每人每 24 小時最多 passkey.suspend_daily_max 次；持有控制類或治理類角色的人被停用即開例外（K-PASSKEY-SUSPEND-HOLDER）；'
    '本人用被停用的原金鑰簽恢復、再由本人的主管或登記人（不是本人、不持有不能做決定的角色）用自己的通行金鑰背書，才恢復可用',
    null,
    'full',
    null
);

select sgn_internal.register_rule(
    'K-PASSKEY-SUSPEND-HOLDER',
    '只憑登入停用通行金鑰時，當事人持有參數 passkey.suspend_exception_categories 所列類別的角色（預設控制類與治理類，'
    '依 sgn.role 的類別判斷，任何適用範圍都算；裁決 D86 (3)）就當場開例外，列出這些角色與用到的參數，'
    '並通知參數 passkey.suspend_exception_notify_roles 的角色持有人（不含當事人）；治理類的持有人另開 K-GOVERNANCE-KEY',
    null,
    'partial',
    '例外沒有結案流程（同 K-GOVERNANCE-KEY：例外的覆核與結案是核心尚未做的部分）'
);

insert into sgn.notification_template (event_code, subject, body) values
    ('passkey.holder_suspended', '{{person_name}}（{{roles}}）的通行金鑰已被停用',
        '{{person_name}} 只憑登入停用了自己的全部通行金鑰。他持有控制類或治理類角色（{{roles}}），停用期間這些角色的簽核與背書都少了一個人，'
        '系統已開例外。請確認是本人所為；不是的話，請主管或登記人用通行金鑰撤銷，並檢查登入來源。');
