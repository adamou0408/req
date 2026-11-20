-- 身分提供者的金鑰更新程序（裁決 D81 (5)；紅隊第四輪 中-5）。
-- 身分提供者會依自己的排程輪替簽章金鑰（sim/idp 的 Dex 每 6 小時一次）；平台只在建置時匯入一次的話，輪替的當下全公司都登入不了。
-- 程序：專用帳號 sgn_idp_keys（db/tools/idp-keys.mjs，常駐每分鐘一次）讀身分提供者公布的 JWKS，交給 api_idp.idp_keys_sync：
--   - 新的 kid（RS256）立即信任：進鏈、開例外 K-IDP-KEY-NEW 並通知治理角色（參數 identity.idp_key_notify_roles），由人事後審視。
--     不設冷卻：冷卻期間全公司登入不了；而登入只能開工作階段，所有決定仍要通行金鑰（K-DECISION-PROOF），新金鑰換不到決定權。
--   - 公布的金鑰裡有平台不能信任的（不是 RS256、issuer 不符）：不信任，開例外 K-IDP-KEY-UNTRUSTED（每個 kid 一次）並通知。
--   - 不再公布的 kid 退役（之後用它簽的 token 不再接受），進鏈。
-- 威脅：拿到這個帳號、或能改這個程式讀到的 JWKS（網路），就能讓平台信任自己的金鑰並冒用任何人登入（但做不了決定）；
-- 每一次都進鏈並通知治理角色。傳輸加密（TLS 到身分提供者）是部署必要項。

create schema api_idp;

insert into sgn.error_catalog (code, message, http_status) values
    ('IDP_ISSUER_MISMATCH', '身分提供者的 issuer 和平台設定的不同', 422),
    ('IDP_JWKS_INVALID', '身分提供者公布的金鑰清單格式不正確', 422);

select sgn_internal.register_setting_definition(
    'identity.idp_key_notify_roles', 'json', '["audit_governor", "board_chair", "parent_officer", "ciso"]', array[]::text[],
    '身分提供者的金鑰有變動（新的金鑰被信任、不能信任的金鑰、退役）時通知哪些角色的持有人'
);

create table sgn.idp_key_rejected (
    kid text primary key,
    reason text not null,
    exception_id bigint not null references sgn.exception_record (id),
    seen_at timestamptz not null
);

create function sgn_internal.idp_key_notify_people()
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(distinct p), '{}')
    from jsonb_array_elements_text(sgn_internal.setting('identity.idp_key_notify_roles')) as r (code)
    cross join lateral unnest(sgn_internal.role_holders(r.code)) as p
$$;

-- 一把公布的金鑰：能信任的回傳 null，否則回傳原因。
create function sgn_internal.idp_jwk_problem(p_key jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when jsonb_typeof(p_key -> 'kid') is distinct from 'string' or p_key ->> 'kid' = '' then 'kid'
        when p_key ->> 'kty' is distinct from 'RSA' then 'kty'
        when coalesce(p_key ->> 'alg', 'RS256') <> 'RS256' then 'alg'
        when coalesce(p_key ->> 'use', 'sig') <> 'sig' then 'use'
        when jsonb_typeof(p_key -> 'n') is distinct from 'string' or jsonb_typeof(p_key -> 'e') is distinct from 'string' then 'n_e'
    end
$$;

-- 比對公布的金鑰與資料庫信任的金鑰：新的登記、不能信任的開例外、不再公布的退役。回傳 {registered, rejected, retired}。
create function sgn_internal.idp_keys_sync(p_issuer text, p_jwks jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_key jsonb;
    v_problem text;
    v_registered jsonb := '[]'::jsonb;
    v_rejected jsonb := '[]'::jsonb;
    v_retired jsonb;
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
        if v_problem is null and not exists (select 1 from sgn.idp_key as i where i.kid = v_key ->> 'kid') then
            insert into sgn.idp_key (kid, issuer, n, e, imported_at)
            values (v_key ->> 'kid', p_issuer, sgn_internal.b64url_decode(v_key ->> 'n'), sgn_internal.b64url_decode(v_key ->> 'e'), sgn_internal.now());
            perform sgn_internal.exception_open('K-IDP-KEY-NEW', null, jsonb_build_object(
                'kid', v_key ->> 'kid', 'issuer', p_issuer,
                'n_sha256', encode(sgn_internal.digest(sgn_internal.b64url_decode(v_key ->> 'n'), 'sha256'), 'hex')));
            perform sgn_internal.notify('identity.idp_key_changed', v_people, null,
                jsonb_build_object('kid', v_key ->> 'kid', 'change', '新的簽章金鑰已信任'));
            v_registered := v_registered || to_jsonb(v_key ->> 'kid');
        elsif v_problem is not null and coalesce(v_key ->> 'kid', '') <> ''
              and not exists (select 1 from sgn.idp_key_rejected as r where r.kid = v_key ->> 'kid') then
            insert into sgn.idp_key_rejected (kid, reason, exception_id, seen_at)
            values (v_key ->> 'kid', v_problem, sgn_internal.exception_open('K-IDP-KEY-UNTRUSTED', null, jsonb_build_object(
                'kid', v_key ->> 'kid', 'issuer', p_issuer, 'reason', v_problem, 'kty', v_key ->> 'kty', 'alg', v_key ->> 'alg')), sgn_internal.now());
            perform sgn_internal.notify('identity.idp_key_changed', v_people, null,
                jsonb_build_object('kid', v_key ->> 'kid', 'change', '公布了不能信任的金鑰（' || v_problem || '）'));
            v_rejected := v_rejected || to_jsonb(v_key ->> 'kid');
        end if;
    end loop;
    with gone as (
        update sgn.idp_key as i set retired_at = sgn_internal.now()
        where i.retired_at is null
          and not exists (select 1 from jsonb_array_elements(p_jwks -> 'keys') as k where k ->> 'kid' = i.kid)
        returning i.kid
    )
    select coalesce(jsonb_agg(kid order by kid), '[]'::jsonb) into v_retired from gone;
    if v_registered <> '[]'::jsonb or v_rejected <> '[]'::jsonb or v_retired <> '[]'::jsonb then
        perform sgn_internal.audit_append('identity.idp_keys_synced', null, null, jsonb_build_object(
            'issuer', p_issuer, 'registered', v_registered, 'rejected', v_rejected, 'retired', v_retired,
            'jwks_sha256', encode(sgn_internal.jcs_sha256(p_jwks), 'hex'),
            'rules', jsonb_build_array('K-IDP-KEY-NEW', 'K-IDP-KEY-UNTRUSTED')));
    end if;
    return jsonb_build_object('registered', v_registered, 'rejected', v_rejected, 'retired', v_retired);
end;
$$;

create function api_idp.idp_keys_sync(p_issuer text, p_jwks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    return sgn_internal.idp_keys_sync(p_issuer, p_jwks);
end;
$$;

comment on function api_idp.idp_keys_sync(text, jsonb) is
    '身分提供者的金鑰更新程序：交上身分提供者公布的 JWKS。新的 RS256 金鑰立即信任（進鏈、開例外 K-IDP-KEY-NEW、通知治理角色），'
    '不能信任的開例外 K-IDP-KEY-UNTRUSTED，不再公布的退役。issuer 必須是平台設定的身分提供者。'
    '呼叫者：sgn_idp_keys（db/tools/idp-keys.mjs）。規則：K-IDP-KEY-NEW、K-IDP-KEY-UNTRUSTED';

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-IDP-KEY-NEW', '身分提供者輪替出新的簽章金鑰時，由專用帳號的程序立即信任（不設冷卻）、進鏈、開例外並通知治理角色', 'full', null),
    ('K-IDP-KEY-UNTRUSTED', '身分提供者公布了平台不能信任的金鑰（不是 RS256 等）時不信任，開例外並通知治理角色', 'full', null)
) as r (code, description, coverage, note);

insert into sgn.notification_template (event_code, subject, body) values
    ('identity.idp_key_changed', '身分提供者的金鑰有變動：{{kid}}', '身分提供者的簽章金鑰 {{kid}}：{{change}}。已進鏈並開例外，請審視這次變動。');
