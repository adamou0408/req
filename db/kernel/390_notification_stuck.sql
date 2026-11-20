-- 通知卡住要開例外（紅隊第三輪修復留下的缺口：docs/handoff/redteam-fixes-3.md 威脅表 D76 #8）。
--
-- 根因：寄送程式以排程帳號 sgn_job 執行。拿到 sgn_job（或寄送程式壞掉、SMTP 不通）時通知就不寄，
-- 佇列只留下 pending、sending 或 failed，沒有人會知道——而新金鑰、治理類變更的冷卻期，靠的就是本人與主管收到通知。
--
-- 這一版：
--   1. 一則通知建立後超過 notification.stuck_alert_seconds 秒還沒寄出（不論 pending、sending、failed），開例外 K-NOTIFY-STUCK，
--      每則只開一次（記在佇列上）。例外不掛在申請單上（不改變任何人的決定畫面），稽核的例外清單看得到。
--   2. 檢查有兩個入口，不只靠 sgn_job：排程（api_job.notification_stuck_check），以及任何寫入通知的交易
--      （寫入通知的唯一入口 sgn_internal.notify，由使用者的動作經 sgn_app 觸發）。sgn_job 停擺時，下一個寫入通知的
--      使用者動作就會開例外。
--   3. 做不到的：拿到 sgn_job 的人把沒寄的通知標成已寄（notification_mark），資料庫分辨不出來（威脅表標「未解」）。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('notification.stuck_alert_seconds', 'integer', '1800', '{}',
        '一則通知建立後超過幾秒還沒寄出，就開例外 K-NOTIFY-STUCK（寄送程式停擺、SMTP 不通、或排程帳號被拿去不寄）');

alter table sgn.notification_outbox
    add column stuck_exception_id bigint references sgn.exception_record (id);

create index notification_outbox_unsent_idx on sgn.notification_outbox (created_at) where status <> 'sent' and stuck_exception_id is null;

-- 超過時間還沒寄出的通知，每則開一次例外。並行的交易各自跳過別人鎖住的列（skip locked），不會重複開。回傳開了幾個。
create function sgn_internal.notification_stuck_check()
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_seconds int := sgn_internal.setting_int('notification.stuck_alert_seconds');
    v_row sgn.notification_outbox;
    v_opened int := 0;
begin
    for v_row in
        select n.*
        from sgn.notification_outbox as n
        where n.status <> 'sent'
          and n.stuck_exception_id is null
          and n.created_at < sgn_internal.now() - make_interval(secs => v_seconds)
        order by n.id
        for update skip locked
    loop
        update sgn.notification_outbox
        set stuck_exception_id = sgn_internal.exception_open('K-NOTIFY-STUCK', null, jsonb_build_object(
            'notification_id', v_row.id,
            'event_code', v_row.event_code,
            'person', v_row.person_id,
            'case_id', v_row.case_id,
            'status', v_row.status,
            'attempts', v_row.attempts,
            'last_error', v_row.last_error,
            'created_at', v_row.created_at,
            'settings', jsonb_build_object('notification.stuck_alert_seconds', v_seconds)
        ))
        where id = v_row.id;
        v_opened := v_opened + 1;
    end loop;
    return v_opened;
end;
$$;

-- 通知寫入的唯一入口（同 130 的簽章）：寫入前先檢查有沒有卡住的通知（第二個入口，不靠 sgn_job）。
create or replace function sgn_internal.notify(p_event_code text, p_person_ids uuid[], p_case_id uuid, p_payload jsonb)
returns int
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_count int;
begin
    perform sgn_internal.notification_stuck_check();
    insert into sgn.notification_outbox (event_code, person_id, case_id, payload, created_at, status)
    select distinct on (p) p_event_code, p, p_case_id, p_payload, sgn_internal.now(), 'pending'
    from unnest(p_person_ids) as p
    where p is not null;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

create function api_job.notification_stuck_check()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('opened', sgn_internal.notification_stuck_check());
end;
$$;

comment on function api_job.notification_stuck_check() is
    '超過 notification.stuck_alert_seconds 秒還沒寄出的通知，每則開一次例外 K-NOTIFY-STUCK。'
    '呼叫者：sgn_job（排程 db/tools/jobs.mjs）；寫入通知的交易也會檢查。規則：K-NOTIFY-STUCK';

select sgn_internal.register_rule(
    'K-NOTIFY-STUCK',
    '通知建立後超過 notification.stuck_alert_seconds 秒還沒寄出（待寄、寄送中或失敗），每則開一次例外；'
    '檢查的入口有排程與任何寫入通知的交易兩個，排程帳號停擺也擋不住',
    null,
    'partial',
    '拿到排程帳號的人把沒寄的通知標成已寄，資料庫分辨不出來（要郵件伺服器端的收據）'
);

select sgn_internal.register_rule(
    'K-NOTIFY-DELIVERED',
    '通知真的寄出（D76）：待寄送佇列由寄送程式經 mail port（SMTP adapter）寄給本人的 email，內容由範本產生；'
    '失敗會重試，超過次數標為失敗',
    null,
    'partial',
    '寄送程式由 sgn_job 執行：沒寄出的會開例外（K-NOTIFY-STUCK），但拿到 sgn_job 的人把沒寄的標成已寄分辨不出來；'
    'Teams、LINE WORKS 等其他通道沒做'
);
