-- 紅隊第七輪複核（裁決 D89；redteam/exploits/46 i）：人工執行的受管系統，授權正常到期時沒有人被通知。
-- 420 的假設是「外部系統依迄日擋下」，但人工設上去的權限不會自己消失：到期和撤銷一樣要有人到外部系統去拿掉。
-- 這一版：到期也開 K-DELIVERY-MANUAL 並通知該系統的管理人。過了迄日才標記（530 的 grant_lapse）走同一個
-- 授權結束入口，所以不再另外呼叫一次，例外只開一筆（event = 'expired'）。

create or replace function sgn_internal.grant_manual_followup(p_case sgn.request_case, p_event text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_scopes text[];
    v_people uuid[];
begin
    v_scopes := array(
        select s from unnest(sgn_internal.case_fulfilment_scopes(p_case, sgn_internal.case_fulfilment_stage_code(p_case))) as s
        where not sgn_internal.delivery_automated(s)
    );
    if cardinality(v_scopes) = 0 then
        return;
    end if;
    perform sgn_internal.exception_open('K-DELIVERY-MANUAL', p_case.id, jsonb_build_object('event', p_event, 'scopes', to_jsonb(v_scopes)));
    select coalesce(array_agg(distinct p), '{}') into v_people
    from unnest(v_scopes) as s
    cross join lateral unnest(sgn_internal.role_holders('system_custodian', s)) as p;
    perform sgn_internal.notify('delivery.manual_required', v_people, p_case.id,
        jsonb_build_object('case_no', p_case.case_no::text, 'event', p_event));
end;
$$;

create or replace function sgn_internal.grant_lapse(p_case sgn.request_case, p_when text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.grant_end(p_case, 'expired', null, 'valid_to passed before activation: ' || p_when, 'K-GRANT-LATE');
end;
$$;
