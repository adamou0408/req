-- 外部系統交付介面的完整等級（裁決 D81 (2)；紅隊第四輪 高-2、中-1、中-2、中-3）。
--
-- 平台送出的請求：被簽的是一個信封（format、channel、environment、method、path、not_after、payload），
-- 外部系統只在通道、環境、方法、路徑都對、而且還沒過期時才收；整張單撤回之後封存，任何版本都不再收。
-- 外部系統的回應：每個回應都帶外部系統以自己的金鑰（ES256）簽的證明，內容是這次請求的摘要（方法、路徑、請求本文的
-- SHA-256、平台給的一次性亂數）、HTTP 狀態、時間與結果本身。資料庫驗章、比對摘要與亂數之後才採信結果；
-- 沒有證明或證明不符的回應一律當成「沒有送到」（重送、超過時間開卡住例外）。網路上的人因此只剩「擋下」。
-- 對帳回報同樣以證明的內容為準（440）。
--
-- 為什麼回應用 ES256：資料庫已經有經過 Wycheproof 向量測試的 P-256 驗章（03、22），不必再寫一套 Ed25519 驗章。

insert into sgn.error_catalog (code, message, http_status) values
    ('CHANNEL_KEY_INVALID', '外部系統的回應金鑰格式不正確（只接受 P-256 的 SPKI PEM）', 422);

select sgn_internal.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description)
from (values
    ('delivery.target_environment', 'text', '""', array['channel'],
        '這個交付通道的外部系統環境代碼：簽章的信封與外部系統的證明都要指名它（同一份已簽章的規則不能送到另一個環境）。'
        '沒有設定時任何證明都不符，交付一律送不到（從嚴）'),
    ('delivery.signature_ttl_seconds', 'integer', '300', array['channel'],
        '平台簽的信封幾秒後失效（not_after）。過期的在下次領取時重新簽；外部系統不收過期的'),
    ('delivery.attestation_context', 'text', '"sgn-dc-attestation/1"', array['channel'],
        '外部系統回應證明的領域分隔：被簽的位元組＝這個字串＋換行＋證明的 payload')
) as d (key, value_type, default_value, scope_kinds, description);

-- 外部系統回應證明的公鑰（每個通道可以有幾把：輪替時新舊並存；退役的不再採信）。只有 owner 寫入（db/build.sh）。
create table sgn.channel_key (
    channel text not null check (channel <> ''),
    key_id text not null check (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
    -- 未壓縮的 P-256 公鑰（04 || X || Y）
    public_key bytea not null check (length(public_key) = 65 and get_byte(public_key, 0) = 4),
    registered_at timestamptz not null,
    retired_at timestamptz,
    primary key (channel, key_id)
);

-- 登記外部系統的回應金鑰。p_only：同一通道其他還在用的金鑰一律退役（建置與輪替時：信任清單只有目前那一把）。
create function sgn_internal.channel_key_register(p_channel text, p_key_id text, p_spki_pem text, p_only boolean)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_point bytea;
begin
    begin
        v_point := sgn_internal.p256_spki_to_point(decode(
            regexp_replace(p_spki_pem, '-----(BEGIN|END) PUBLIC KEY-----|\s', '', 'g'), 'base64'));
    exception
        when invalid_parameter_value then
            v_point := null;
    end;
    if v_point is null then
        perform sgn_internal.raise_error('CHANNEL_KEY_INVALID', p_key_id);
    end if;
    if p_only then
        update sgn.channel_key set retired_at = sgn_internal.now()
        where channel = p_channel and key_id <> p_key_id and retired_at is null;
    end if;
    insert into sgn.channel_key (channel, key_id, public_key, registered_at)
    values (p_channel, p_key_id, v_point, sgn_internal.now())
    on conflict (channel, key_id) do update set public_key = excluded.public_key, retired_at = null;
    perform sgn_internal.audit_append(
        'delivery.channel_key_registered', null, null,
        jsonb_build_object('channel', p_channel, 'key_id', p_key_id, 'public_key', encode(v_point, 'hex'), 'only', p_only,
            'rules', jsonb_build_array('K-DELIVERY-ATTESTED'))
    );
end;
$$;

-- 外部系統的時間：格式不對時是 null。
create function sgn_internal.try_timestamptz(p_text text)
returns timestamptz
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
    return p_text::timestamptz;
exception
    when others then
        return null;
end;
$$;

create function sgn_internal.try_jsonb(p_text text)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
    return p_text::jsonb;
exception
    when invalid_text_representation then
        return null;
end;
$$;

create function sgn_internal.try_base64(p_text text)
returns bytea
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
begin
    return decode(p_text, 'base64');
exception
    when invalid_parameter_value then
        return null;
end;
$$;

-- 驗一份回應證明。p_expect：{method, path, request_sha256（hex）, nonce}，有給的鍵才比對（nonce 給 null 也要相符）。
-- 回傳 {ok, reason, payload}：ok 時 payload 是驗過的證明內容（結果在 payload.result）；不 ok 時 reason 說明哪裡不符。
create function sgn_internal.attestation_open(p_channel text, p_response jsonb, p_expect jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_att jsonb := case when jsonb_typeof(p_response) = 'object' then p_response -> 'attestation' end;
    v_key bytea;
    v_sig bytea;
    v_text text;
    v_payload jsonb;
    v_field text;
    v_context text := sgn_internal.setting('delivery.attestation_context', array['channel:' || p_channel]) #>> '{}';
begin
    if jsonb_typeof(v_att) is distinct from 'object' or v_att ->> 'alg' is distinct from 'es256'
       or jsonb_typeof(v_att -> 'payload') is distinct from 'string' then
        return jsonb_build_object('ok', false, 'reason', 'missing');
    end if;
    select k.public_key into v_key
    from sgn.channel_key as k
    where k.channel = p_channel and k.key_id = v_att ->> 'key_id' and k.retired_at is null;
    if v_key is null then
        return jsonb_build_object('ok', false, 'reason', 'unknown_key', 'key_id', v_att ->> 'key_id');
    end if;
    v_text := v_att ->> 'payload';
    v_sig := sgn_internal.try_base64(v_att ->> 'sig');
    if v_sig is null or not sgn_internal.es256_verify(convert_to(v_context || chr(10) || v_text, 'UTF8'), v_sig, v_key) then
        return jsonb_build_object('ok', false, 'reason', 'signature');
    end if;
    v_payload := sgn_internal.try_jsonb(v_text);
    if jsonb_typeof(v_payload) is distinct from 'object' or v_payload ->> 'format' is distinct from 'sgn_dc_attestation/1' then
        return jsonb_build_object('ok', false, 'reason', 'format');
    end if;
    if v_payload ->> 'channel' is distinct from p_channel
       or v_payload ->> 'environment' is distinct from (sgn_internal.setting('delivery.target_environment', array['channel:' || p_channel]) #>> '{}') then
        return jsonb_build_object('ok', false, 'reason', 'target', 'environment', v_payload ->> 'environment');
    end if;
    for v_field in select k from jsonb_object_keys(p_expect) as k loop
        if v_payload -> v_field is distinct from p_expect -> v_field then
            return jsonb_build_object('ok', false, 'reason', v_field);
        end if;
    end loop;
    return jsonb_build_object('ok', true, 'payload', v_payload);
end;
$$;

select sgn_internal.register_rule(r.code, r.description, null, r.coverage, r.note)
from (values
    ('K-DELIVERY-ATTESTED', '外部系統的回應與對帳回報只在外部系統的證明驗章、請求摘要、一次性亂數（或新鮮度）都相符時才採信；'
        '平台簽的請求帶通道、環境、方法、路徑與期限', 'full', null)
) as r (code, description, coverage, note);
