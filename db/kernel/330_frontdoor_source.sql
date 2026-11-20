-- 防濫用的上限不能變成別人拿來鎖死你的開關（裁決 D78；紅隊第三輪 中-2）。
--
-- 根因：每個來源的次數限制在後端的記憶體裡，全域的「未用登入挑戰值」上限在資料庫、不分來源。未登入的人從 34 個以上的
-- 位址各送 30 次，就把全域上限填滿，之後全公司都登入不了；挑戰值 300 秒才過期，攻擊者一直重送就一直鎖住。
--
-- 這一版：
--   1. 上限改為每個來源計算，放在資料庫：同一個來源還沒用掉、還沒過期的登入挑戰值不得超過 auth.login_pending_per_source。
--      不再有全域上限（auth.login_pending_max、後端記憶體裡的 auth.login_attempts_per_minute 都刪除）。
--   2. 數量改以短存活時間控制：登入挑戰值 auth.login_challenge_ttl_seconds 秒過期，過期就由排程清除（不等保留期）。
--   3. 來源的認定方式是設定（auth.client_source）：socket＝直接連線的位址；forwarded＝連線來自 auth.trusted_proxies
--      列出的代理時，取 X-Forwarded-For 最後一個位址（代理附加的那一個），否則仍用直接連線的位址。後端啟動時讀
--      frontdoor_policy，照這個設定把來源交給 session_begin；沒有給來源的呼叫都算同一個來源。

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('auth.login_pending_per_source', 'integer', '20', '{}',
        '同一個來源最多可以有幾筆還沒用掉、還沒過期的登入挑戰值；超過就拒絕這個來源的新登入（其他來源不受影響）'),
    ('auth.login_challenge_ttl_seconds', 'integer', '120', '{}',
        '登入挑戰值幾秒後過期（過期就由排程清除）；以短存活時間控制數量，取代全域上限'),
    ('auth.client_source', 'text', '"socket"', '{}',
        '登入來源的認定方式：socket（直接連線的位址）或 forwarded（連線來自受信任的代理時，取 X-Forwarded-For 最後一個位址）'),
    ('auth.trusted_proxies', 'json', '[]', '{}',
        'auth.client_source 為 forwarded 時，受信任的反向代理位址（只有來自這些位址的連線才看 X-Forwarded-For）');

delete from sgn.setting_definition as d
where d.key in ('auth.login_pending_max', 'auth.login_attempts_per_minute')
  and not exists (select 1 from sgn.setting_value as v where v.key = d.key);

alter table sgn.auth_challenge
    add column source text;

create index auth_challenge_session_source_idx on sgn.auth_challenge (source, expires_at)
    where purpose = 'session' and consumed_at is null;

drop function api.session_begin();

create function api.session_begin(p_source text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_source text := coalesce(nullif(btrim(p_source), ''), 'unknown');
    v_per_source int := sgn_internal.setting_int('auth.login_pending_per_source');
    v_ttl int := sgn_internal.setting_int('auth.login_challenge_ttl_seconds');
    v_challenge sgn.auth_challenge;
begin
    -- 同一個來源同時開始的登入排隊，數量的判斷才不會被併發繞過；不同來源互不影響
    perform pg_advisory_xact_lock(hashtext('sgn.session_begin:' || v_source));
    if (
        select count(*)
        from sgn.auth_challenge as c
        where c.purpose = 'session' and c.consumed_at is null and c.expires_at > sgn_internal.now() and c.source = v_source
    ) >= v_per_source then
        perform sgn_internal.raise_error('AUTH_RATE_LIMITED', 'pending login challenges for this source');
    end if;
    v_challenge := sgn_internal.challenge_new('session', '{}'::jsonb, null);
    update sgn.auth_challenge
    set source = v_source, expires_at = least(expires_at, created_at + make_interval(secs => v_ttl))
    where id = v_challenge.id;
    return jsonb_build_object(
        'challenge_id', v_challenge.id,
        'nonce', sgn_internal.b64url_encode(v_challenge.challenge)
    );
end;
$$;

comment on function api.session_begin(text) is
    '開始登入：發一次性 nonce，後端把它放進導向身分提供者的授權請求。p_source 是後端依 auth.client_source 認定的來源；'
    '同一個來源還沒用掉的登入挑戰值超過 auth.login_pending_per_source 就拒絕這個來源（沒有全域上限）；'
    '挑戰值 auth.login_challenge_ttl_seconds 秒過期。呼叫者：sgn_app（後端 /auth/login）。規則：K-DECISION-PROOF、K-LOGIN-THROTTLE';

drop function api.frontdoor_policy();

create function api.frontdoor_policy()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'client_source', sgn_internal.setting_text('auth.client_source'),
        'trusted_proxies', sgn_internal.setting('auth.trusted_proxies')
    )
$$;

comment on function api.frontdoor_policy() is
    '後端啟動時讀取的入口參數：登入來源的認定方式與受信任的反向代理。呼叫者：sgn_app（後端啟動）。規則：K-LOGIN-THROTTLE';

-- 清除挑戰值（同 290 的簽章）：過期的登入挑戰值一過期就清（沒有其他紀錄引用的）；其他用途照舊保留 auth.challenge_retention_hours。
create or replace function api_job.auth_challenge_purge()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_cutoff timestamptz := v_now - make_interval(hours => sgn_internal.setting_int('auth.challenge_retention_hours'));
    v_count int;
begin
    delete from sgn.auth_challenge as c
    where (
            (c.purpose = 'session' and c.expires_at < v_now)
            or (c.expires_at < v_cutoff and c.consumed_at is null)
        )
      and not exists (select 1 from sgn.decision_proof as d where d.challenge_id = c.id);
    get diagnostics v_count = row_count;
    return jsonb_build_object('purged', v_count, 'cutoff', v_cutoff);
end;
$$;

comment on function api_job.auth_challenge_purge() is
    '清除挑戰值：過期的登入挑戰值（短存活時間，一過期就清），以及其他用途沒用掉而且過期超過 auth.challenge_retention_hours 的；'
    '被決定證明引用的不清。呼叫者：sgn_job（排程 db/tools/jobs.mjs）。規則：K-LOGIN-THROTTLE';

select sgn_internal.register_rule(
    'K-LOGIN-THROTTLE',
    '未登入的人不能無限新增資料，也不能鎖住別人（D78）：同一個來源還沒用掉的登入挑戰值有上限（auth.login_pending_per_source，'
    '資料庫計算），沒有全域上限；登入挑戰值存活時間短（auth.login_challenge_ttl_seconds），過期就由排程清除；'
    '來源的認定方式是設定（auth.client_source、auth.trusted_proxies）',
    null,
    'partial',
    '來源由後端交給資料庫：拿到後端的人可以謊報來源（但他本來就能讓服務停擺）；一個攻擊者擁有很多位址（例如 IPv6）時，'
    '每個位址各有上限，數量靠短存活時間與清除控制'
);
