-- 交付的對外入口、申請單詳情上的交付與驗證進度、規則代碼與通知範本。
--   api_delivery：交付程式（帳號 sgn_delivery）領取與回報。後端（sgn_app）沒有這個 schema 的權限，
--                 所以被入侵的後端不能謊報套用成功或驗證結果。
--   api_job：排程（sgn_job）檢查卡住、處理到期。對帳在 440。

-- ── 申請單詳情上的交付與驗證（畫面依它顯示進度；人工退路只在有人工工作時出現）──

create function sgn_internal.case_delivery_view(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'ops', coalesce((
            select jsonb_agg(jsonb_build_object(
                'op_id', o.id,
                'channel', o.channel,
                'kind', o.kind,
                'version', o.version,
                'status', o.status,
                'attempts', o.attempts,
                'created_at', o.created_at,
                'finished_at', o.finished_at,
                'next_attempt_at', case when o.status = 'queued' then o.next_attempt_at end,
                'last_http_status', o.last_http_status,
                'last_error', coalesce(o.result ->> 'error', o.last_error)
            ) order by o.id)
            from sgn.delivery_op as o
            where o.case_id = p_case_id
        ), '[]'::jsonb),
        'verifications', coalesce((
            select jsonb_agg(jsonb_build_object(
                'run_id', r.id,
                'channel', r.channel,
                'version', r.version,
                'status', r.status,
                'created_at', r.created_at,
                'finished_at', r.finished_at,
                'cases', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                        'code', c ->> 'code',
                        'description', coalesce(c ->> 'description', c ->> 'code'),
                        'expected', c ->> 'expected',
                        'actual', a.actual,
                        -- 這個案例的實際結果是否等於預期（核心的判斷；畫面只顯示）；還沒有結果是 null
                        'match', case when a.actual is not null then a.actual = c ->> 'expected' end
                    ) order by n), '[]'::jsonb)
                    from jsonb_array_elements(r.cases) with ordinality as e (c, n)
                    left join lateral (
                        select x ->> 'actual' as actual from jsonb_array_elements(coalesce(r.results, '[]'::jsonb)) as x
                        where x ->> 'code' = c ->> 'code' limit 1
                    ) as a on true
                )
            ) order by r.id)
            from sgn.verification_run as r
            where r.case_id = p_case_id
        ), '[]'::jsonb)
    )
$$;

-- 申請單詳情（同 370 的簽章）：多了 delivery。
create or replace function sgn_internal.case_detail(p_case_id uuid, p_person_id uuid)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.case_summary(p_case_id, p_person_id) || jsonb_build_object(
        'stages', sgn_internal.case_stages_view(p_case_id),
        'versions', sgn_internal.case_versions_view(p_case_id),
        'overlap', sgn_internal.case_overlap_current(p_case_id),
        'fulfilment', (
            select jsonb_build_object('version', f.version, 'payload', f.payload, 'payload_sha256', encode(f.payload_sha256, 'hex'))
            from sgn.fulfilment as f
            where f.case_id = p_case_id
            order by f.id desc
            limit 1
        ),
        'grant', (
            select jsonb_build_object('grant_id', g.id, 'valid_from', g.valid_from, 'valid_to', g.valid_to, 'status', g.status)
            from sgn.grant_record as g
            where g.case_id = p_case_id
        ),
        'display', sgn_internal.case_display(p_case_id, p_person_id),
        'duplicates', sgn_internal.case_duplicates(p_case_id),
        'path', sgn_internal.case_path(p_case_id),
        'resubmit', sgn_internal.case_resubmit_preview(p_case_id),
        'delivery', sgn_internal.case_delivery_view(p_case_id)
    );
end;
$$;

-- ── 交付程式的入口 ──

create function api_delivery.delivery_claim(p_channel text, p_limit int)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.delivery_claim(p_channel, p_limit);
end;
$$;

comment on function api_delivery.delivery_claim(text, int) is
    '交付程式領走這個通道最多 p_limit 筆該送的交付（同一張單一次只給最前面一筆），附上租約、冪等鍵、方法與路徑、這次領取的一次性亂數、'
    '要原樣送出的本文（套用與撤回是帶通道、環境、方法、路徑與期限的信封）與資料庫的簽章。'
    '呼叫者：sgn_delivery（api/src/delivery.ts）。規則：K-DELIVERY-AUTO、K-DELIVERY-SIGNED、K-DELIVERY-ATTESTED、K-DELIVERY-ORDER、K-DELIVERY-STUCK';

create function api_delivery.delivery_report(p_op_id bigint, p_lease_token uuid, p_outcome jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.delivery_report(p_op_id, p_lease_token, p_outcome);
end;
$$;

comment on function api_delivery.delivery_report(bigint, uuid, jsonb) is
    '交付程式回報一筆的結果 {http_status（連不上為 null）, response, error}。只收租約內的回報；成功、重送（退避）、拒絕由資料庫依外部系統的證明'
    '（驗章、方法與路徑、送出位元組的摘要、這次的一次性亂數）判斷，證明不符當成沒送到；撤回被拒絕不是終態（重送並升級）。'
    '驗證的結果由資料庫比對預期。呼叫者：sgn_delivery。規則：K-DELIVERY-RETRY、K-DELIVERY-REJECTED、K-DELIVERY-ATTESTED、K-VERIFY-AUTO';

-- ── 排程的入口 ──

create function api_job.delivery_stuck_check()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('opened', sgn_internal.delivery_stuck_check());
end;
$$;

comment on function api_job.delivery_stuck_check() is
    '超過 delivery.stuck_alert_seconds 秒還沒有結果的交付，每筆開一次例外 K-DELIVERY-STUCK 並通知升級對象（交付程式停擺也擋不住）。'
    '呼叫者：sgn_job（db/tools/jobs.mjs）。規則：K-DELIVERY-STUCK';

create function api_job.grant_expire_due()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return jsonb_build_object('expired', sgn_internal.grant_expire_due());
end;
$$;

comment on function api_job.grant_expire_due() is
    '授權迄日已過的授權結束（到期），並排一筆清除，把到期的權限從外部系統的目錄上拿掉。呼叫者：sgn_job（db/tools/jobs.mjs）。'
    '規則：K-GRANT-EXPIRE';

-- ── 規則代碼 ──

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-DELIVERY-AUTO',
        '核准之後不經人手：交付方式是 system 的受管系統，執行關開始時自動排套用；生效以外部系統套用成功並通過自動驗證為準（D63）',
        'partial', 'file（檔案交換）這一版視同人工'),
    ('K-DELIVERY-SIGNED',
        '交付內容由資料庫從核准的內容版本產生，以資料庫內的 Ed25519 金鑰簽章；後端與交付程式都拿不到私鑰',
        'partial', '資料庫擁有者讀得到私鑰；沒有硬體金鑰'),
    ('K-DELIVERY-RETRY', '送不到（連不上、5xx、408、429、沒有有效的外部系統證明、信封過期）就以參數的退避重送，冪等鍵不變；其他 4xx 不重送（撤回除外）', 'full', null),
    ('K-DELIVERY-STUCK', '一筆交付超過 delivery.stuck_alert_seconds 秒還沒有結果就開例外並通知升級對象', 'full', null),
    ('K-DELIVERY-REJECTED', '外部系統拒絕交付（簽章不符、版本衝突、格式錯誤）就開例外；套用被拒的單不生效並撤回已送出的部分；'
        '撤回被拒不是終態：開例外、升級並以退避繼續重送', 'full', null),
    ('K-DELIVERY-ORDER', '同一張單在同一通道一次只送最前面一筆；撤銷時還沒送出的套用與驗證作廢，撤回不會被較舊的套用蓋掉', 'full', null),
    ('K-DELIVERY-MANUAL', '人工執行只在受管系統的交付方式是 manual 時出現；每次走人工都開常設例外，撤銷時通知該系統的管理人', 'full', null),
    ('K-VERIFY-AUTO',
        '每筆套用成功後自動驗證：案例由流程包從送出的規則產生（範圍內應允許、範圍外應拒絕），由核心比對；不一致不得生效，開例外並撤回',
        'partial', '申請人確認驗證結果（rules.md「驗證中」）沒做'),
    ('K-GRANT-REVOKE', '撤銷不需要簽核但必須填原因；申請人、被授權者負責人、簽核人、執行人、參數列的角色可以做；外部系統的規則自動撤回', 'full', null),
    ('K-GRANT-REDUCE', '生效中的授權只做縮小時不用重簽；新的一版自動送出並重新驗證，驗證沒過由系統撤銷', 'partial', '畫面沒有生效後縮小的入口'),
    ('K-GRANT-EXPIRE', '授權迄日過了由排程結束授權並排清除，到期的權限從外部系統的目錄上拿掉', 'full', null)
) as r (code, description, coverage, note);

select sgn_internal.register_rule(
    'K-FULFIL',
    '核准後產生交付內容；人工執行時執行人標記完成（需決定證明）後才產生授權並生效，交付的就是核准的那一版',
    null,
    'partial',
    '系統對系統的交付見 K-DELIVERY-AUTO；申請人確認沒做'
);

insert into sgn.notification_template (event_code, subject, body) values
    ('delivery.stuck', '交付卡住：{{case_no}}',
        '{{case_no}} 的交付（{{kind}}）送到 {{channel}} 超過時限還沒有結果（已試 {{attempts}} 次）。已開例外，請確認外部系統與交付程式。'),
    ('delivery.rejected', '外部系統拒絕交付：{{case_no}}', '{{case_no}} 的交付（{{kind}}）被 {{channel}} 拒絕：{{error}}。已開例外。'),
    ('verification.failed', '交付沒有通過：{{case_no}}',
        '{{case_no}} 在 {{channel}} 的實際權限與核准的內容不一致或被拒絕，沒有生效；已送出的規則會撤回，並已開例外。'),
    ('delivery.manual_required', '受管系統要人工處理：{{case_no}}',
        '{{case_no}} 的授權已{{event}}，但有受管系統是人工執行，請到該系統處理並留下紀錄。'),
    ('case.revoked', '授權已撤銷：{{case_no}}', '{{case_no}} 已撤銷，原因：{{reason}}。外部系統上的權限會自動撤回。'),
    ('case.expired', '授權已到期：{{case_no}}', '{{case_no}} 的授權期間已結束，外部系統上的權限會自動清除。'),
    ('case.reduced_active', '授權已縮小：{{case_no}}', '{{case_no}} 已縮小，原因：{{reason}}。新的範圍會自動送到外部系統並重新驗證。');

-- 流程包產生驗證案例時要知道：同一個被授權者還有哪些單的權限可能在外部系統上（執行中、生效、或撤回還沒完成）。
-- 外部系統以被授權者的身分判斷，看到的是這些權限的聯集；範圍外的反例若被別張單合法放行，不能當成這張單設定錯誤的證據。
create function sgn_sdk.cases_possibly_granted(p_process_type text, p_principal_id text, p_except uuid)
returns setof uuid
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select c.id
    from sgn.request_case as c
    join sgn.case_version as v on v.case_id = c.id and v.version = c.current_version
    where c.process_type = p_process_type
      and v.terms ->> 'principal_id' = p_principal_id
      and c.id is distinct from p_except
      and (
          c.state in ('pending_fulfilment', 'verifying', 'active')
          or exists (select 1 from sgn.delivery_op as o where o.case_id = c.id and o.kind = 'withdraw' and o.status in ('queued', 'sending'))
      )
    order by c.case_no
$$;
