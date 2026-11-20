-- 紅隊第五輪 高-2（裁決 D84 (3)；redteam/exploits/34）：身分提供者金鑰同步帳號（或改得到它讀的 JWKS 的網路）一個人就能讓全公司
-- 登入不了而且不會自動恢復：交一份空的 JWKS → 真的金鑰全部退役；之後誠實的同步交回真的 JWKS，退役過的 kid 也不再信任。
-- 這一版的金鑰同步（取代 460 的 sgn_internal.idp_keys_sync）：
--   1. 不再公布的金鑰不立即退役：記下「從什麼時候開始沒公布」，開例外 K-IDP-KEY-RETIRE 並通知治理角色；
--      連續沒公布超過冷卻期（identity.idp_key_retire_cooldown_seconds）才退役。期間任何一次同步又看到就取消。
--   2. 不得退役到零把：退役之後至少要留一把「這一次有公布、而且信任」的金鑰，否則這一輪一把都不退役（開例外）。
--   3. 退役過的 kid 再出現、而且公開金鑰相同：經同一個程序恢復（算一次新增、進鏈、開 K-IDP-KEY-NEW 並通知）。
--      同一個 kid 換了公開金鑰：不信任（K-IDP-KEY-UNTRUSTED）。
--   4. 單一時間窗（identity.idp_key_new_window_seconds）內新增（含恢復）的金鑰有上限（identity.idp_key_new_max）；
--      超過的不信任，開例外 K-IDP-KEY-LIMIT 並通知（G 不能用大量金鑰輪流登入、灌爆例外）。
-- 仍然成立（裁決 D84 (3)，接受）：拿到這個帳號、或改得到明文的 JWKS，就能讓平台信任一把自己的金鑰並冒用登入（上限內、事後偵測）；
-- 冒用登入能做的動作見 D84 (2) 的重新分類。取得金鑰清單的 TLS 與憑證釘選是部署必要項。

alter table sgn.idp_key
    add column missing_since timestamptz,
    add column missing_exception_id bigint references sgn.exception_record (id);

-- 每一次「信任一把金鑰」（新增或恢復）：時間窗上限的計數來源。建置時由擁有者匯入的第一批不算。
create table sgn.idp_key_trust (
    id bigint generated always as identity primary key,
    kid text not null references sgn.idp_key (kid),
    kind text not null check (kind in ('registered', 'restored')),
    trusted_at timestamptz not null
);

select sgn_internal.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description)
from (values
    ('identity.idp_key_retire_cooldown_seconds', 'integer', '3600', array[]::text[],
        '身分提供者不再公布的金鑰，連續幾秒都沒再公布才退役（冷卻期；期間仍可用它登入，開例外並通知治理角色）'),
    ('identity.idp_key_new_window_seconds', 'integer', '21600', array[]::text[],
        '計算「新增金鑰上限」的時間窗（秒）；身分提供者正常輪替的週期（sim 的 Dex 是 6 小時）'),
    ('identity.idp_key_new_max', 'integer', '2', array[]::text[],
        '一個時間窗內最多新增（含恢復）幾把身分提供者的金鑰；超過的不信任，開例外 K-IDP-KEY-LIMIT')
) as d (key, value_type, default_value, scope_kinds, description);

-- 信任一把公布的金鑰（新增或恢復）：上限內就信任、進信任紀錄、開 K-IDP-KEY-NEW、通知；超過上限開 K-IDP-KEY-LIMIT（每把一次）。
-- 回傳 'registered'、'restored' 或 'limited'。
create function sgn_internal.idp_key_trust_one(p_issuer text, p_key jsonb, p_kind text, p_people uuid[])
returns text
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_kid text := p_key ->> 'kid';
    v_window int := sgn_internal.setting_int('identity.idp_key_new_window_seconds');
    v_max int := sgn_internal.setting_int('identity.idp_key_new_max');
    v_recent int := (select count(*) from sgn.idp_key_trust as t where t.trusted_at > sgn_internal.now() - make_interval(secs => v_window));
    v_n bytea := sgn_internal.b64url_decode(p_key ->> 'n');
    v_settings jsonb := jsonb_build_object('identity.idp_key_new_window_seconds', v_window, 'identity.idp_key_new_max', v_max);
begin
    if v_recent >= v_max then
        if not exists (select 1 from sgn.exception_record as x where x.rule_code = 'K-IDP-KEY-LIMIT' and x.detail ->> 'kid' = v_kid
                       and x.opened_at > sgn_internal.now() - make_interval(secs => v_window)) then
            perform sgn_internal.exception_open('K-IDP-KEY-LIMIT', null, jsonb_build_object(
                'kid', v_kid, 'issuer', p_issuer, 'kind', p_kind, 'recent', v_recent,
                'n_sha256', encode(sgn_internal.digest(v_n, 'sha256'), 'hex'), 'settings', v_settings));
            perform sgn_internal.notify('identity.idp_key_changed', p_people, null,
                jsonb_build_object('kid', v_kid, 'change', '時間窗內新增的金鑰超過上限，沒有信任'));
        end if;
        return 'limited';
    end if;
    if p_kind = 'registered' then
        insert into sgn.idp_key (kid, issuer, n, e, imported_at)
        values (v_kid, p_issuer, v_n, sgn_internal.b64url_decode(p_key ->> 'e'), sgn_internal.now());
    else
        update sgn.idp_key set retired_at = null, missing_since = null, missing_exception_id = null where kid = v_kid;
    end if;
    insert into sgn.idp_key_trust (kid, kind, trusted_at) values (v_kid, p_kind, sgn_internal.now());
    perform sgn_internal.exception_open('K-IDP-KEY-NEW', null, jsonb_build_object(
        'kid', v_kid, 'issuer', p_issuer, 'kind', p_kind, 'n_sha256', encode(sgn_internal.digest(v_n, 'sha256'), 'hex'), 'settings', v_settings));
    perform sgn_internal.notify('identity.idp_key_changed', p_people, null,
        jsonb_build_object('kid', v_kid, 'change', case p_kind when 'registered' then '新的簽章金鑰已信任' else '退役過的金鑰再次公布，已恢復信任' end));
    return p_kind;
end;
$$;

-- 不能信任的金鑰（格式、kid 換了公開金鑰）：開例外並通知（每個 kid 一次）。回傳是不是這次新記下的。
create function sgn_internal.idp_key_reject_one(p_issuer text, p_key jsonb, p_problem text, p_people uuid[])
returns boolean
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if coalesce(p_key ->> 'kid', '') = '' or exists (select 1 from sgn.idp_key_rejected as r where r.kid = p_key ->> 'kid') then
        return false;
    end if;
    insert into sgn.idp_key_rejected (kid, reason, exception_id, seen_at)
    values (p_key ->> 'kid', p_problem, sgn_internal.exception_open('K-IDP-KEY-UNTRUSTED', null, jsonb_build_object(
        'kid', p_key ->> 'kid', 'issuer', p_issuer, 'reason', p_problem, 'kty', p_key ->> 'kty', 'alg', p_key ->> 'alg')), sgn_internal.now());
    perform sgn_internal.notify('identity.idp_key_changed', p_people, null,
        jsonb_build_object('kid', p_key ->> 'kid', 'change', '公布了不能信任的金鑰（' || p_problem || '）'));
    return true;
end;
$$;

-- 沒公布的金鑰：開始計冷卻（開例外、通知），冷卻期滿而且退役後仍留著至少一把這次有公布的信任金鑰才退役。回傳 {missing, retired}。
create function sgn_internal.idp_keys_retire(p_issuer text, p_jwks jsonb, p_people uuid[])
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooldown int := sgn_internal.setting_int('identity.idp_key_retire_cooldown_seconds');
    v_key sgn.idp_key;
    v_missing jsonb := '[]'::jsonb;
    v_retired jsonb := '[]'::jsonb;
    v_published_trusted int;
begin
    -- 又公布了：取消冷卻
    update sgn.idp_key as i set missing_since = null, missing_exception_id = null
    where i.retired_at is null and i.missing_since is not null
      and exists (select 1 from jsonb_array_elements(p_jwks -> 'keys') as k where k ->> 'kid' = i.kid);
    for v_key in
        select * from sgn.idp_key as i
        where i.retired_at is null
          and not exists (select 1 from jsonb_array_elements(p_jwks -> 'keys') as k where k ->> 'kid' = i.kid)
        order by i.kid
        for update
    loop
        if v_key.missing_since is null then
            update sgn.idp_key
            set missing_since = sgn_internal.now(),
                missing_exception_id = sgn_internal.exception_open('K-IDP-KEY-RETIRE', null, jsonb_build_object(
                    'kid', v_key.kid, 'issuer', p_issuer, 'retire_after', sgn_internal.now() + make_interval(secs => v_cooldown),
                    'settings', jsonb_build_object('identity.idp_key_retire_cooldown_seconds', v_cooldown)))
            where kid = v_key.kid;
            perform sgn_internal.notify('identity.idp_key_changed', p_people, null,
                jsonb_build_object('kid', v_key.kid, 'change', format('身分提供者不再公布這把金鑰；%s 秒內沒再公布就退役', v_cooldown)));
            v_missing := v_missing || to_jsonb(v_key.kid);
            continue;
        end if;
        if v_key.missing_since > sgn_internal.now() - make_interval(secs => v_cooldown) then
            continue;
        end if;
        select count(*) into v_published_trusted from sgn.idp_key as i
        where i.retired_at is null and i.kid <> v_key.kid
          and exists (select 1 from jsonb_array_elements(p_jwks -> 'keys') as k where k ->> 'kid' = i.kid);
        if v_published_trusted = 0 then
            -- 退役會讓平台一把可用的金鑰都沒有：不退役（每段一筆例外）
            if not exists (select 1 from sgn.exception_record as x where x.rule_code = 'K-IDP-KEY-RETIRE'
                           and x.detail ->> 'kid' = v_key.kid and x.detail ->> 'kind' = 'would_leave_none' and x.opened_at >= v_key.missing_since) then
                perform sgn_internal.exception_open('K-IDP-KEY-RETIRE', null, jsonb_build_object(
                    'kid', v_key.kid, 'issuer', p_issuer, 'kind', 'would_leave_none', 'published', jsonb_array_length(p_jwks -> 'keys')));
                perform sgn_internal.notify('identity.idp_key_changed', p_people, null,
                    jsonb_build_object('kid', v_key.kid, 'change', '退役之後就沒有可用的金鑰，沒有退役'));
            end if;
            continue;
        end if;
        update sgn.idp_key set retired_at = sgn_internal.now() where kid = v_key.kid;
        v_retired := v_retired || to_jsonb(v_key.kid);
    end loop;
    return jsonb_build_object('missing', v_missing, 'retired', v_retired);
end;
$$;

-- 比對公布的金鑰與資料庫信任的金鑰（同 460 的簽章）。回傳 {registered, restored, rejected, limited, missing, retired}。
create or replace function sgn_internal.idp_keys_sync(p_issuer text, p_jwks jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_key jsonb;
    v_problem text;
    v_existing sgn.idp_key;
    v_outcome text;
    v_out jsonb := jsonb_build_object('registered', '[]'::jsonb, 'restored', '[]'::jsonb, 'rejected', '[]'::jsonb, 'limited', '[]'::jsonb);
    v_retire jsonb;
    v_people uuid[] := sgn_internal.idp_key_notify_people();
begin
    if p_issuer is distinct from sgn_internal.setting_text('idp.issuer') then
        perform sgn_internal.raise_error('IDP_ISSUER_MISMATCH', p_issuer);
    end if;
    if jsonb_typeof(p_jwks -> 'keys') is distinct from 'array' then
        perform sgn_internal.raise_error('IDP_JWKS_INVALID');
    end if;
    perform pg_advisory_xact_lock(hashtext('sgn.idp_keys_sync'));
    for v_key in select k from jsonb_array_elements(p_jwks -> 'keys') as k loop
        v_problem := sgn_internal.idp_jwk_problem(v_key);
        v_existing := null;
        select * into v_existing from sgn.idp_key as i where i.kid = v_key ->> 'kid';
        if v_problem is null and v_existing.kid is not null
           and (v_existing.n <> sgn_internal.b64url_decode(v_key ->> 'n') or v_existing.e <> sgn_internal.b64url_decode(v_key ->> 'e')) then
            v_problem := 'kid_reused';
        end if;
        if v_problem is not null then
            if sgn_internal.idp_key_reject_one(p_issuer, v_key, v_problem, v_people) then
                v_out := jsonb_set(v_out, '{rejected}', (v_out -> 'rejected') || to_jsonb(v_key ->> 'kid'));
            end if;
            continue;
        end if;
        if v_existing.kid is not null and v_existing.retired_at is null then
            continue;
        end if;
        v_outcome := sgn_internal.idp_key_trust_one(p_issuer, v_key, case when v_existing.kid is null then 'registered' else 'restored' end, v_people);
        v_out := jsonb_set(v_out, array[v_outcome], (v_out -> v_outcome) || to_jsonb(v_key ->> 'kid'));
    end loop;
    v_retire := sgn_internal.idp_keys_retire(p_issuer, p_jwks, v_people);
    v_out := v_out || v_retire;
    if exists (select 1 from jsonb_each(v_out) as e where e.value <> '[]'::jsonb) then
        perform sgn_internal.audit_append('identity.idp_keys_synced', null, null, v_out || jsonb_build_object(
            'issuer', p_issuer, 'jwks_sha256', encode(sgn_internal.jcs_sha256(p_jwks), 'hex'),
            'settings', jsonb_build_object(
                'identity.idp_key_retire_cooldown_seconds', sgn_internal.setting_int('identity.idp_key_retire_cooldown_seconds'),
                'identity.idp_key_new_window_seconds', sgn_internal.setting_int('identity.idp_key_new_window_seconds'),
                'identity.idp_key_new_max', sgn_internal.setting_int('identity.idp_key_new_max')),
            'rules', jsonb_build_array('K-IDP-KEY-NEW', 'K-IDP-KEY-UNTRUSTED', 'K-IDP-KEY-RETIRE', 'K-IDP-KEY-LIMIT')));
    end if;
    return v_out;
end;
$$;

comment on function api_idp.idp_keys_sync(text, jsonb) is
    '身分提供者的金鑰更新程序：交上身分提供者公布的 JWKS。新的 RS256 金鑰在時間窗上限內立即信任（進鏈、開例外 K-IDP-KEY-NEW、通知治理角色），'
    '超過上限不信任（K-IDP-KEY-LIMIT）；不能信任的、kid 換了公開金鑰的開 K-IDP-KEY-UNTRUSTED；不再公布的開 K-IDP-KEY-RETIRE，'
    '冷卻期滿才退役，而且不得退役到零把；退役過的再公布（公開金鑰相同）就恢復。issuer 必須是平台設定的身分提供者。'
    '呼叫者：sgn_idp_keys（db/tools/idp-keys.mjs）。規則：K-IDP-KEY-NEW、K-IDP-KEY-UNTRUSTED、K-IDP-KEY-RETIRE、K-IDP-KEY-LIMIT';

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-IDP-KEY-NEW',
        '身分提供者輪替出新的簽章金鑰（或退役過的金鑰再次公布、公開金鑰相同）時，由專用帳號的程序在時間窗上限內立即信任（不設冷卻）、'
        '進鏈、開例外並通知治理角色',
        'full', null),
    ('K-IDP-KEY-RETIRE',
        '身分提供者不再公布的金鑰：開例外並通知治理角色，連續冷卻期（identity.idp_key_retire_cooldown_seconds）都沒再公布才退役；'
        '不得退役到零把（退役後至少留一把這次有公布的信任金鑰），期間又公布就取消',
        'full', null),
    ('K-IDP-KEY-LIMIT',
        '單一時間窗（identity.idp_key_new_window_seconds）內新增（含恢復）的身分提供者金鑰超過上限（identity.idp_key_new_max）時不信任，'
        '開例外並通知治理角色',
        'full', null)
) as r (code, description, coverage, note);
