-- 通知真的寄出（裁決 D76「冷卻期內的通知要真的寄出」；紅隊第三輪 高-2 的根因之一）。
--
-- 根因：通知只寫進待寄送佇列（sgn.notification_outbox），沒有任何程式把它寄出去。新金鑰的冷卻期、治理類變更的冷卻期、
-- 決定後的通知，都靠「本人與主管收到通知、發現不是自己做的」才有意義；沒寄出就等於沒有。
--
-- 這一版：
--   1. 佇列多了寄送狀態：pending → sending（被寄送程式領走）→ sent，或 failed（超過 notification.max_attempts 次）。
--   2. api_job.notification_claim 領走一批：內容由範本（sgn.notification_template，改文字不需要重新部署）代入參數產生，
--      收件人是 sgn.person 的 email。領走的筆在 notification.claim_timeout_seconds 秒內沒有回報就可以再被領走。
--   3. api_job.notification_mark 回報結果。寄送程式是 api/src/mailer.ts（mail port 的 SMTP adapter，api/src/smtp.ts）。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('notification.max_attempts', 'integer', '5', '{}', '一則通知最多寄幾次，超過就標為失敗'),
    ('notification.claim_timeout_seconds', 'integer', '300', '{}', '寄送程式領走一則通知後，幾秒內沒有回報就可以再被領走');

alter table sgn.notification_outbox
    drop constraint notification_outbox_status_check,
    add constraint notification_outbox_status_check check (status in ('pending', 'sending', 'sent', 'failed')),
    add column attempts int not null default 0,
    add column claimed_at timestamptz,
    add column sent_at timestamptz,
    add column last_error text;

create index notification_outbox_due_idx on sgn.notification_outbox (id) where status in ('pending', 'sending');

-- 範本代入參數：{{鍵}} 換成 payload 裡同名的值（文字）；沒有的鍵換成空字串。
create function sgn_internal.template_render(p_template text, p_payload jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_out text := p_template;
    v_key text;
    v_value text;
begin
    for v_key, v_value in select key, value from jsonb_each_text(coalesce(p_payload, '{}'::jsonb)) loop
        v_out := replace(v_out, '{{' || v_key || '}}', coalesce(v_value, ''));
    end loop;
    return regexp_replace(v_out, '\{\{[a-z_]+\}\}', '', 'g');
end;
$$;

create function api_job.notification_claim(p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_timeout int := sgn_internal.setting_int('notification.claim_timeout_seconds');
    v_result jsonb;
begin
    with due as (
        select n.id
        from sgn.notification_outbox as n
        where n.status = 'pending'
           or (n.status = 'sending' and n.claimed_at < v_now - make_interval(secs => v_timeout))
        order by n.id
        limit greatest(coalesce(p_limit, 0), 0)
        for update skip locked
    ),
    claimed as (
        update sgn.notification_outbox as n
        set status = 'sending', claimed_at = v_now, attempts = n.attempts + 1
        from due
        where n.id = due.id
        returning n.*
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'event_code', c.event_code,
        'to_email', p.email,
        'to_name', p.display_name,
        'subject', sgn_internal.template_render(t.subject, c.payload),
        'body', sgn_internal.template_render(t.body, c.payload)
    ) order by c.id), '[]'::jsonb) into v_result
    from claimed as c
    join sgn.notification_template as t on t.event_code = c.event_code
    join sgn.person as p on p.id = c.person_id;
    return v_result;
end;
$$;

comment on function api_job.notification_claim(int) is
    '領走一批待寄的通知（最多 p_limit 則）：主旨與內文由範本代入參數產生，收件人是本人的 email。'
    '呼叫者：sgn_job（寄送程式 api/src/mailer.ts）。規則：K-NOTIFY-DELIVERED';

create function api_job.notification_mark(p_id bigint, p_sent boolean, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_max int := sgn_internal.setting_int('notification.max_attempts');
    v_row sgn.notification_outbox;
begin
    update sgn.notification_outbox as n
    set status = case when p_sent then 'sent' when n.attempts >= v_max then 'failed' else 'pending' end,
        sent_at = case when p_sent then sgn_internal.now() end,
        last_error = case when p_sent then null else left(coalesce(p_error, ''), 500) end
    where n.id = p_id and n.status = 'sending'
    returning n.* into v_row;
    return jsonb_build_object('id', p_id, 'status', v_row.status);
end;
$$;

comment on function api_job.notification_mark(bigint, boolean, text) is
    '回報一則通知的寄送結果：寄出就標為 sent；失敗就放回待寄，超過 notification.max_attempts 次標為 failed。'
    '呼叫者：sgn_job（寄送程式 api/src/mailer.ts）。規則：K-NOTIFY-DELIVERED';

select sgn_internal.register_rule(
    'K-NOTIFY-DELIVERED',
    '通知真的寄出（D76）：待寄送佇列由寄送程式經 mail port（SMTP adapter）寄給本人的 email，內容由範本產生；'
    '失敗會重試，超過次數標為失敗',
    null,
    'partial',
    '寄送程式由 sgn_job 執行：拿到 sgn_job 的人可以不寄（佇列仍留下 pending 或 sending 的紀錄，但沒有自動開例外）；'
    'Teams、LINE WORKS 等其他通道沒做'
);
