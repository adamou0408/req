-- Ed25519 簽章（RFC 8032，純 Ed25519）：純 PL/pgSQL，以 numeric 當任意精度整數（同 02_crypto_bignum.sql）。
-- 為什麼在資料庫裡簽：交付給外部系統的規則由資料庫從核准的內容版本產生，簽章也必須由資料庫做，
-- 交付程式與後端都拿不到私鑰，就不能改內容、不能簽自己編的規則（docs/handoff/delivery.md 威脅表）。
-- 只用到 pgcrypto 的 digest（SHA-512）與 gen_random_bytes；工程規範只允許 pgcrypto，它沒有 Ed25519。
-- 點用擴充座標 (X, Y, Z, T)，a = -1 的扭曲愛德華曲線；加法用 add-2008-hwcd-3（完整、統一），倍點用 dbl-2008-hwcd。

insert into sgn.error_catalog (code, message, http_status) values
    ('ED25519_KEY_MISMATCH', '簽章金鑰的公鑰和私鑰種子不一致', 500);

create function sgn_internal.ed25519_p()
returns numeric
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select 57896044618658097711785492504343953926634992332820282019728792003956564819949::numeric
$$;

create function sgn_internal.ed25519_l()
returns numeric
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select 7237005577332262213973186563042994240857116359379907606001950938285454250989::numeric
$$;

-- 2d mod p（加法公式用）
create function sgn_internal.ed25519_d2()
returns numeric
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select 16295367250680780974490674513165176452449235426866156013048779062215315747161::numeric
$$;

-- 基點 B（y = 4/5，x 取偶數的那一個），擴充座標
create function sgn_internal.ed25519_base()
returns numeric[]
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select array[
        15112221349535400772501151409588531511454012693041857206046113283949847762202,
        46316835694926478169428394003475163141307993866256225615783033603165251855960,
        1,
        46827403850823179245072216630277197565144205554125654976674165829533817101731
    ]::numeric[]
$$;

-- 位元組順序反轉（Ed25519 的整數與座標都是小端序）
create function sgn_internal.bytea_reverse(p_bytes bytea)
returns bytea
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(string_agg(substring(p_bytes from i for 1), ''::bytea order by i desc), ''::bytea)
    from generate_series(1, length(p_bytes)) as i
$$;

create function sgn_internal.le_to_int(p_bytes bytea)
returns numeric
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.bytes_to_int(sgn_internal.bytea_reverse(p_bytes))
$$;

create function sgn_internal.int_to_le(p_value numeric, p_len int)
returns bytea
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.bytea_reverse(sgn_internal.int_to_bytes(p_value, p_len))
$$;

create function sgn_internal.ed25519_add(p_a numeric[], p_b numeric[])
returns numeric[]
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    p constant numeric := sgn_internal.ed25519_p();
    a numeric := mod((p_a[2] - p_a[1]) * (p_b[2] - p_b[1]), p);
    b numeric := mod((p_a[2] + p_a[1]) * (p_b[2] + p_b[1]), p);
    c numeric := mod(mod(p_a[4] * sgn_internal.ed25519_d2(), p) * p_b[4], p);
    d numeric := mod(2 * p_a[3] * p_b[3], p);
    e numeric := b - a;
    f numeric := d - c;
    g numeric := d + c;
    h numeric := b + a;
begin
    return array[mod(e * f, p), mod(g * h, p), mod(f * g, p), mod(e * h, p)];
end;
$$;

create function sgn_internal.ed25519_double(p_a numeric[])
returns numeric[]
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    p constant numeric := sgn_internal.ed25519_p();
    a numeric := mod(p_a[1] * p_a[1], p);
    b numeric := mod(p_a[2] * p_a[2], p);
    c numeric := mod(2 * p_a[3] * p_a[3], p);
    e numeric := mod((p_a[1] + p_a[2]) * (p_a[1] + p_a[2]), p) - a - b;
    g numeric := b - a;
    f numeric := g - c;
    h numeric := -a - b;
begin
    return array[mod(e * f, p), mod(g * h, p), mod(f * g, p), mod(e * h, p)];
end;
$$;

-- k·B（k < 2^256）：由高位到低位的倍點與加法。
create function sgn_internal.ed25519_base_mul(p_k numeric)
returns numeric[]
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    v_bits bit(256) := ('x' || encode(sgn_internal.int_to_bytes(p_k, 32), 'hex'))::bit(256);
    v_base numeric[] := sgn_internal.ed25519_base();
    v_r numeric[] := array[0, 1, 1, 0]::numeric[];
    v_started boolean := false;
begin
    for i in 0..255 loop
        if v_started then
            v_r := sgn_internal.ed25519_double(v_r);
        end if;
        if get_bit(v_bits, i) = 1 then
            v_r := sgn_internal.ed25519_add(v_r, v_base);
            v_started := true;
        end if;
    end loop;
    return v_r;
end;
$$;

-- 點的編碼：y 的小端序 32 bytes，最高位元放 x 的最低位元。
create function sgn_internal.ed25519_encode(p_pt numeric[])
returns bytea
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    p constant numeric := sgn_internal.ed25519_p();
    v_zinv numeric := sgn_internal.mod_inv(mod(mod(p_pt[3], p) + p, p), p);
    v_x numeric := mod(mod(p_pt[1] * v_zinv, p) + p, p);
    v_y numeric := mod(mod(p_pt[2] * v_zinv, p) + p, p);
    v_out bytea := sgn_internal.int_to_le(v_y, 32);
begin
    if mod(v_x, 2) = 1 then
        v_out := set_byte(v_out, 31, get_byte(v_out, 31) | 128);
    end if;
    return v_out;
end;
$$;

-- 私鑰種子（32 bytes）展開成 {scalar, prefix}（RFC 8032 5.1.5）。
create function sgn_internal.ed25519_expand(p_seed bytea, out scalar numeric, out prefix bytea)
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    v_h bytea := sgn_internal.digest(p_seed, 'sha512');
    v_a bytea := substring(v_h from 1 for 32);
begin
    if length(p_seed) <> 32 then
        raise exception 'ed25519 seed must be 32 bytes';
    end if;
    v_a := set_byte(v_a, 0, get_byte(v_a, 0) & 248);
    v_a := set_byte(v_a, 31, (get_byte(v_a, 31) & 127) | 64);
    scalar := sgn_internal.le_to_int(v_a);
    prefix := substring(v_h from 33 for 32);
end;
$$;

create function sgn_internal.ed25519_public_key(p_seed bytea)
returns bytea
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.ed25519_encode(sgn_internal.ed25519_base_mul((sgn_internal.ed25519_expand(p_seed)).scalar))
$$;

-- 簽章（RFC 8032 5.1.6）。公鑰一律由種子自己導出（紅隊第四輪 資訊 3）：呼叫者傳入的公鑰若和種子不一致，
-- 同一則訊息兩次簽章的 r 相同、k 不同，就能解出私鑰純量。參數 p_public_key 保留（既有呼叫介面），只用來比對，不一致就拒絕。
create function sgn_internal.ed25519_sign(p_seed bytea, p_public_key bytea, p_message bytea)
returns bytea
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    l constant numeric := sgn_internal.ed25519_l();
    v_key record := sgn_internal.ed25519_expand(p_seed);
    v_public bytea := sgn_internal.ed25519_encode(sgn_internal.ed25519_base_mul(v_key.scalar));
    v_r numeric := mod(sgn_internal.le_to_int(sgn_internal.digest(v_key.prefix || p_message, 'sha512')), l);
    v_big_r bytea := sgn_internal.ed25519_encode(sgn_internal.ed25519_base_mul(v_r));
    v_k numeric := mod(sgn_internal.le_to_int(sgn_internal.digest(v_big_r || v_public || p_message, 'sha512')), l);
begin
    if p_public_key is distinct from v_public then
        perform sgn_internal.raise_error('ED25519_KEY_MISMATCH');
    end if;
    return v_big_r || sgn_internal.int_to_le(mod(v_r + v_k * v_key.scalar, l), 32);
end;
$$;

-- 公鑰的 SPKI（DER）與 PEM：外部系統的信任清單用。
create function sgn_internal.ed25519_spki_pem(p_public_key bytea)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
    select '-----BEGIN PUBLIC KEY-----' || chr(10)
        || replace(encode('\x302a300506032b6570032100'::bytea || p_public_key, 'base64'), chr(10), '')
        || chr(10) || '-----END PUBLIC KEY-----' || chr(10)
$$;
