-- 未登入可達的面與離線驗證的小修（裁決 D71；紅隊第二輪 低-1、低-2 的 G2）。
--   1. 登入入口：資料庫限制「還沒用掉、還沒過期」的登入挑戰值總數（auth.login_pending_max），超過就拒絕；
--      每個來源每分鐘的登入次數（auth.login_attempts_per_minute）由後端依這裡給的參數擋（frontdoor_policy）。
--   2. 過期的挑戰值由排程清除（api_job.auth_challenge_purge）：沒用掉而且過期超過 auth.challenge_retention_hours，
--      以及已經用掉的登入挑戰值（沒有其他紀錄引用）。
--   3. 離線驗證工具的錨點落後門檻（api_job.anchor_policy）：最後一個錨點之後的筆數與最舊一筆的時間超過參數即判失敗。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('auth.login_pending_max', 'integer', '1000', '{}',
        '還沒用掉、還沒過期的登入挑戰值最多幾筆；超過就拒絕新的登入（未登入的人不能無限新增資料）'),
    ('auth.login_attempts_per_minute', 'integer', '30', '{}',
        '同一個來源每分鐘最多開始幾次登入（後端依這個值擋）'),
    ('auth.challenge_retention_hours', 'integer', '24', '{}',
        '過期而沒用掉的挑戰值保留幾小時後清除'),
    ('audit.anchor_max_lag_events', 'integer', '10000', '{}',
        '離線驗證：最後一個外部錨點之後最多可以有幾筆紀錄，超過即判失敗'),
    ('audit.anchor_max_lag_seconds', 'integer', '3600', '{}',
        '離線驗證：最後一個外部錨點之後最舊的那一筆最多可以是幾秒前，超過即判失敗（錨定程式停擺）');

insert into sgn.error_catalog (code, message, http_status) values
    ('AUTH_RATE_LIMITED', '登入的嘗試太多，請稍後再試', 429);

create index auth_challenge_purpose_created_idx on sgn.auth_challenge (purpose, created_at);

-- 開始登入（同 30_identity.sql 的簽章）：多了未用登入挑戰值的總數上限。
create or replace function api.session_begin()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_challenge sgn.auth_challenge;
begin
    -- 同時開始的登入排隊，總數的判斷才不會被併發繞過
    perform pg_advisory_xact_lock(hashtext('sgn.session_begin'));
    if (
        select count(*)
        from sgn.auth_challenge as c
        where c.purpose = 'session' and c.consumed_at is null and c.expires_at > sgn_internal.now()
    ) >= sgn_internal.setting_int('auth.login_pending_max') then
        perform sgn_internal.raise_error('AUTH_RATE_LIMITED', 'pending login challenges');
    end if;
    v_challenge := sgn_internal.challenge_new('session', '{}'::jsonb, null);
    return jsonb_build_object(
        'challenge_id', v_challenge.id,
        'nonce', sgn_internal.b64url_encode(v_challenge.challenge)
    );
end;
$$;

comment on function api.session_begin() is
    '開始登入：發一次性 nonce，後端把它放進導向身分提供者的授權請求。還沒用掉的登入挑戰值超過參數 auth.login_pending_max 就拒絕。'
    '呼叫者：sgn_app（後端 /auth/login）。規則：K-DECISION-PROOF、K-LOGIN-THROTTLE';

create function api.frontdoor_policy()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('login_attempts_per_minute', sgn_internal.setting_int('auth.login_attempts_per_minute'))
$$;

comment on function api.frontdoor_policy() is
    '後端啟動時讀取的入口參數（每個來源每分鐘的登入次數）。呼叫者：sgn_app（後端啟動）。規則：K-LOGIN-THROTTLE';

create function api_job.auth_challenge_purge()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cutoff timestamptz := sgn_internal.now() - make_interval(hours => sgn_internal.setting_int('auth.challenge_retention_hours'));
    v_count int;
begin
    delete from sgn.auth_challenge as c
    where c.expires_at < v_cutoff
      and (c.consumed_at is null or c.purpose = 'session')
      and not exists (select 1 from sgn.decision_proof as d where d.challenge_id = c.id);
    get diagnostics v_count = row_count;
    return jsonb_build_object('purged', v_count, 'cutoff', v_cutoff);
end;
$$;

comment on function api_job.auth_challenge_purge() is
    '清除過期的挑戰值：沒用掉而且過期超過參數 auth.challenge_retention_hours 的，以及已經用掉的登入挑戰值。'
    '呼叫者：sgn_job（排程 db/tools/jobs.mjs）。規則：K-LOGIN-THROTTLE';

create function api_job.anchor_policy()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'max_lag_events', sgn_internal.setting_int('audit.anchor_max_lag_events'),
        'max_lag_seconds', sgn_internal.setting_int('audit.anchor_max_lag_seconds')
    )
$$;

comment on function api_job.anchor_policy() is
    '離線驗證工具的錨點落後門檻（最後一個錨點之後的筆數與時間）。呼叫者：sgn_job（db/tools/chain-lib.mjs）。規則：K-ANCHOR-LAG';

select sgn_internal.register_rule(
    'K-LOGIN-THROTTLE',
    '未登入的人不能無限新增資料：還沒用掉的登入挑戰值有總數上限（auth.login_pending_max），每個來源每分鐘的登入次數有上限'
    '（auth.login_attempts_per_minute，後端擋），過期的挑戰值由排程清除（auth.challenge_retention_hours）',
    null,
    'partial',
    '每個來源的次數限制在後端的記憶體裡，後端重啟就歸零；拿到後端的人可以不擋'
);

select sgn_internal.register_rule(
    'K-ANCHOR-LAG',
    '離線驗證工具回報最後一個外部錨點之後有幾筆紀錄、最舊一筆多久，超過參數 audit.anchor_max_lag_events 或 audit.anchor_max_lag_seconds 即判失敗；'
    '完全沒有錨點也算落後',
    null,
    'full',
    null
);
