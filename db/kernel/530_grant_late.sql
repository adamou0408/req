-- 紅隊第七輪 低-2（裁決 D88 (5)；redteam/exploits/46 h）：核准後一直沒執行、過了授權迄日才標記已套用並確認，
-- 單會先顯示生效（產生一筆「已過期卻生效」的授權），下一輪排程才轉為到期。外部系統以迄日擋，實際不放行，但平台上的紀錄不對。
-- 這一版：要生效或要開確認之前（執行人標記已套用、自動驗證通過、申請人確認）先看授權迄日；已過就不生效，直接走到期
-- （同一個授權結束入口 grant_end：清除外部系統上的規則、進鏈、通知），人工執行的受管系統另開例外並通知管理人去拿掉。

insert into sgn.state_transition (entity, from_state, action, to_state) values
    ('case', 'pending_fulfilment', 'expire', 'expired'),
    ('case', 'verifying', 'expire', 'expired');

-- 這一版的授權迄日已過（和排程的到期同一個判斷：迄日 < 今天）。
create function sgn_internal.case_terms_lapsed(p_case sgn.request_case)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(sgn_internal.try_date(v.terms ->> 'valid_to') < sgn_internal.today(), false)
    from sgn.case_version as v
    where v.case_id = p_case.id and v.version = p_case.current_version
$$;

-- 迄日已過才要生效：走到期，不產生授權。人工執行的受管系統要有人去拿掉（執行人已經在外部系統上設好了）。
create function sgn_internal.grant_lapse(p_case sgn.request_case, p_when text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.grant_end(p_case, 'expired', null, 'valid_to passed before activation: ' || p_when, 'K-GRANT-LATE');
    perform sgn_internal.grant_manual_followup(p_case, 'lapsed');
end;
$$;

-- 往下一個適用的關卡走（同 480 的簽章）：執行關完成、要開確認或生效之前，迄日已過就走到期。
create or replace function sgn_internal.case_advance(p_case_id uuid)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case;
    v_next sgn.policy_stage;
begin
    loop
        select * into v_case from sgn.request_case where id = p_case_id;
        if exists (select 1 from sgn.case_stage where case_id = p_case_id and status in ('open', 'halted')) then
            return;
        end if;
        select ps.* into v_next
        from sgn.policy_stage as ps
        where ps.policy_id = v_case.policy_id
          and sgn_internal.stage_applies_to_case(ps, v_case)
          and not exists (
              select 1 from sgn.case_stage as s
              where s.case_id = p_case_id and s.policy_id = ps.policy_id and s.seq = ps.seq and s.status = 'done'
          )
        order by ps.seq
        limit 1;
        if v_next.seq is null then
            if v_case.state = 'in_approval' then
                perform sgn_internal.case_transition(p_case_id, 'finish_approval_final');
                perform sgn_internal.audit_append(
                    'case.completed', p_case_id, null,
                    jsonb_build_object('version', v_case.current_version, 'rules', jsonb_build_array('K-PARALLEL-ALL'))
                );
            elsif v_case.state in ('pending_fulfilment', 'verifying') and sgn_internal.case_terms_lapsed(v_case) then
                perform sgn_internal.grant_lapse(v_case, case v_case.state when 'pending_fulfilment' then 'fulfil' else 'verified' end);
            elsif v_case.state in ('pending_fulfilment', 'verifying') and sgn_internal.process_option(v_case.process_type, 'requires_confirmation') then
                if v_case.state = 'pending_fulfilment' then
                    perform sgn_internal.case_transition(p_case_id, 'manual_applied');
                    perform sgn_internal.audit_append('case.manual_applied', p_case_id, null,
                        jsonb_build_object('version', v_case.current_version, 'rules', jsonb_build_array('K-CONFIRM-MANUAL', 'K-FULFIL')));
                    select * into v_case from sgn.request_case where id = p_case_id;
                end if;
                perform sgn_internal.confirmation_open(v_case);
            elsif v_case.state in ('pending_fulfilment', 'verifying') then
                perform sgn_internal.case_transition(p_case_id, 'finish_fulfilment');
                perform sgn_internal.grant_activate(v_case);
            end if;
            return;
        end if;
        if v_next.phase = 'fulfilment' and v_case.state = 'in_approval' then
            perform sgn_internal.case_transition(p_case_id, 'finish_approval');
            perform sgn_internal.fulfilment_prepare(v_case);
        end if;
        perform sgn_internal.stage_open(v_case, v_next);
    end loop;
end;
$$;

-- 申請人確認驗證結果（同 470 的簽章）：迄日已過就不生效，走到期（回傳的詳情狀態是 expired）。
create or replace function api.case_confirm_verification(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person_id uuid := sgn_internal.session_person(p_session);
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
begin
    perform sgn_internal.authorize(v_person_id, 'confirm_verification', v_case);
    if sgn_internal.case_terms_lapsed(v_case) then
        perform sgn_internal.grant_lapse(v_case, 'confirm');
        return sgn_internal.case_detail(p_case_id, v_person_id);
    end if;
    perform sgn_internal.confirmation_close(p_case_id, 'confirm', v_person_id, null);
    perform sgn_internal.case_transition(p_case_id, 'confirm_verification');
    perform sgn_internal.grant_activate(v_case);
    return sgn_internal.case_detail(p_case_id, v_person_id);
end;
$$;

comment on function api.case_confirm_verification(text, uuid) is
    '使用者動作「確認驗證結果」：自動驗證全部通過、開了確認之後，申請人本人確認外部系統上的結果正確，授權才生效。'
    '授權迄日已過時不生效，直接走到期（K-GRANT-LATE；回傳的詳情狀態是 expired）。不是簽核決定，不需要通行金鑰；逾期不能確認。'
    '只有申請人可以做（骨幹附錄 B：資料授權的 confirmation_parties 只有申請人）。回傳申請單詳情。呼叫者：sgn_app。規則：K-CONFIRM、K-GRANT-LATE';

select sgn_internal.register_rule(
    'K-GRANT-LATE',
    '要生效或開確認之前（執行人標記已套用、自動驗證通過、申請人確認）先看這一版的授權迄日：已過（迄日 < 今天）就不生效，'
    '直接走到期（清除外部系統上的規則、進鏈、通知），人工執行的受管系統另開例外並通知管理人去拿掉（裁決 D88 (5)）',
    null,
    'full',
    null
);
