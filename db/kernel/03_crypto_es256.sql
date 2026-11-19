-- ES256（ECDSA，曲線 P-256，SHA-256）驗章：純 PL/pgSQL。
-- 曲線參數來自 SEC 2 / FIPS 186-4。點以 Jacobian 座標 (X, Y, Z) 表示，Z = 0 代表無窮遠點；
-- 只在最後做一次模反元素，避免每步都做除法。
-- 這裡只做「驗」，不做「簽」，所以沒有私鑰、也不需要常數時間。

create or replace function sgn_internal.p256_p() returns numeric language sql immutable as
$$ select 115792089210356248762697446949407573530086143415290314195533631308867097853951::numeric $$;

create or replace function sgn_internal.p256_n() returns numeric language sql immutable as
$$ select 115792089210356248762697446949407573529996955224135760342422259061068512044369::numeric $$;

create or replace function sgn_internal.p256_b() returns numeric language sql immutable as
$$ select 41058363725152142129326129780047268409114441015993725554835256314039467401291::numeric $$;

create or replace function sgn_internal.p256_gx() returns numeric language sql immutable as
$$ select 48439561293906451759052585252797914202762949526041747995844080717082404635286::numeric $$;

create or replace function sgn_internal.p256_gy() returns numeric language sql immutable as
$$ select 36134250956749795798585127919587881956611106672985015071877198253568414405109::numeric $$;

-- 公鑰必須在曲線上：y^2 = x^3 - 3x + b (mod p)。登記時檢查，避免無效曲線攻擊。
create or replace function sgn_internal.p256_on_curve(p_x numeric, p_y numeric)
returns boolean
language sql
immutable
strict
as $$
    select p_x >= 0 and p_x < sgn_internal.p256_p()
       and p_y >= 0 and p_y < sgn_internal.p256_p()
       and mod(p_y * p_y, sgn_internal.p256_p())
         = mod(mod(mod(p_x * p_x, sgn_internal.p256_p()) * p_x, sgn_internal.p256_p())
               - 3 * p_x + sgn_internal.p256_b() + 3 * sgn_internal.p256_p(), sgn_internal.p256_p())
$$;

-- 倍點（a = -3 的公式，dbl-2001-b）。
create or replace function sgn_internal.p256_double(p_pt numeric[])
returns numeric[]
language plpgsql
immutable
strict
as $$
declare
    p constant numeric := sgn_internal.p256_p();
    x numeric := p_pt[1];
    y numeric := p_pt[2];
    z numeric := p_pt[3];
    delta numeric;
    gamma numeric;
    beta numeric;
    alpha numeric;
    x3 numeric;
begin
    if z = 0 or y = 0 then
        return array[0, 1, 0]::numeric[];
    end if;
    delta := mod(z * z, p);
    gamma := mod(y * y, p);
    beta := mod(x * gamma, p);
    alpha := mod(3 * (x - delta + p) * (x + delta), p);
    x3 := mod(alpha * alpha - 8 * beta + 8 * p, p);
    return array[
        x3,
        mod(alpha * (4 * beta - x3 + p) - mod(8 * gamma * gamma, p) + p, p),
        mod((y + z) * (y + z) - gamma - delta + 2 * p, p)
    ];
end;
$$;

-- 加點（add-2007-bl）。兩點相同時改走倍點。
create or replace function sgn_internal.p256_add(p_a numeric[], p_b numeric[])
returns numeric[]
language plpgsql
immutable
strict
as $$
declare
    p constant numeric := sgn_internal.p256_p();
    z1z1 numeric;
    z2z2 numeric;
    u1 numeric;
    u2 numeric;
    s1 numeric;
    s2 numeric;
    h numeric;
    r numeric;
    i numeric;
    j numeric;
    v numeric;
    x3 numeric;
begin
    if p_a[3] = 0 then
        return p_b;
    end if;
    if p_b[3] = 0 then
        return p_a;
    end if;
    z1z1 := mod(p_a[3] * p_a[3], p);
    z2z2 := mod(p_b[3] * p_b[3], p);
    u1 := mod(p_a[1] * z2z2, p);
    u2 := mod(p_b[1] * z1z1, p);
    s1 := mod(p_a[2] * mod(p_b[3] * z2z2, p), p);
    s2 := mod(p_b[2] * mod(p_a[3] * z1z1, p), p);
    h := mod(u2 - u1 + p, p);
    r := mod(2 * (s2 - s1 + p), p);
    if h = 0 then
        if r = 0 then
            return sgn_internal.p256_double(p_a);
        end if;
        return array[0, 1, 0]::numeric[];
    end if;
    i := mod(4 * h * h, p);
    j := mod(h * i, p);
    v := mod(u1 * i, p);
    x3 := mod(r * r - j - 2 * v + 3 * p, p);
    return array[
        x3,
        mod(r * (v - x3 + p) - mod(2 * s1 * j, p) + p, p),
        mod(mod((p_a[3] + p_b[3]) * (p_a[3] + p_b[3]) - z1z1 - z2z2 + 2 * p, p) * h, p)
    ];
end;
$$;

-- 驗章核心：給定雜湊值 z、簽章 (r, s)、公鑰 (qx, qy)。
-- u1·G + u2·Q 用 Shamir 技巧一次掃 256 位元。
create or replace function sgn_internal.p256_verify_digest(
    p_digest bytea,
    p_r numeric,
    p_s numeric,
    p_qx numeric,
    p_qy numeric
)
returns boolean
language plpgsql
immutable
strict
as $$
declare
    n constant numeric := sgn_internal.p256_n();
    p constant numeric := sgn_internal.p256_p();
    g numeric[] := array[sgn_internal.p256_gx(), sgn_internal.p256_gy(), 1];
    q numeric[] := array[p_qx, p_qy, 1];
    gq numeric[];
    acc numeric[] := array[0, 1, 0];
    w numeric;
    u1_bits bit(256);
    u2_bits bit(256);
    b1 int;
    b2 int;
    zinv numeric;
begin
    if p_r < 1 or p_r >= n or p_s < 1 or p_s >= n then
        return false;
    end if;
    if not sgn_internal.p256_on_curve(p_qx, p_qy) then
        return false;
    end if;
    w := sgn_internal.mod_inv(p_s, n);
    u1_bits := ('x' || encode(sgn_internal.int_to_bytes(mod(sgn_internal.bytes_to_int(p_digest) * w, n), 32), 'hex'))::bit(256);
    u2_bits := ('x' || encode(sgn_internal.int_to_bytes(mod(p_r * w, n), 32), 'hex'))::bit(256);
    gq := sgn_internal.p256_add(g, q);
    for k in 0..255 loop
        acc := sgn_internal.p256_double(acc);
        b1 := get_bit(u1_bits, k);
        b2 := get_bit(u2_bits, k);
        if b1 = 1 and b2 = 1 then
            acc := sgn_internal.p256_add(acc, gq);
        elsif b1 = 1 then
            acc := sgn_internal.p256_add(acc, g);
        elsif b2 = 1 then
            acc := sgn_internal.p256_add(acc, q);
        end if;
    end loop;
    if acc[3] = 0 then
        return false;
    end if;
    zinv := sgn_internal.mod_inv(acc[3], p);
    -- 仿射 x = X / Z^2
    return mod(mod(acc[1] * mod(zinv * zinv, p), p), n) = p_r;
end;
$$;

-- DER INTEGER 的內容是否為嚴格 DER：非負（最高位元為 0）且最短編碼（只有在下一個 byte 最高位元為 1 時才能補 0x00）。
-- 為什麼嚴格：寬鬆的 BER 會讓同一個簽章有多種位元組表示（可延展性）；Wycheproof 的 MissingZero、BerEncodedSignature 等向量就是測這個。
create or replace function sgn_internal.der_integer_strict(p_int bytea)
returns boolean
language sql
immutable
strict
as $$
    select length(p_int) >= 1
       and get_byte(p_int, 0) < 128
       and not (length(p_int) > 1 and get_byte(p_int, 0) = 0 and get_byte(p_int, 1) < 128)
$$;

-- DER 編碼的 ECDSA 簽章（WebAuthn 用這種格式）→ (r, s)。不是嚴格 DER 就回 null。
-- 結構：30 len 02 rlen r 02 slen s；長度一律短格式（P-256 的簽章最長 72 bytes）。
create or replace function sgn_internal.der_ecdsa_rs(p_der bytea, out r numeric, out s numeric)
language plpgsql
immutable
strict
as $$
declare
    v_len int := length(p_der);
    v_rlen int;
    v_slen int;
    v_r bytea;
    v_s bytea;
begin
    if v_len < 8 or get_byte(p_der, 0) <> 48 or get_byte(p_der, 1) <> v_len - 2
       or get_byte(p_der, 2) <> 2 then
        return;
    end if;
    v_rlen := get_byte(p_der, 3);
    if v_rlen < 1 or v_rlen > 33 or 4 + v_rlen + 2 > v_len or get_byte(p_der, 4 + v_rlen) <> 2 then
        return;
    end if;
    v_slen := get_byte(p_der, 5 + v_rlen);
    if v_slen < 1 or v_slen > 33 or 6 + v_rlen + v_slen <> v_len then
        return;
    end if;
    v_r := substring(p_der from 5 for v_rlen);
    v_s := substring(p_der from 7 + v_rlen for v_slen);
    if not sgn_internal.der_integer_strict(v_r) or not sgn_internal.der_integer_strict(v_s) then
        return;
    end if;
    r := sgn_internal.bytes_to_int(v_r);
    s := sgn_internal.bytes_to_int(v_s);
end;
$$;

-- ES256：訊息 bytes、DER 簽章、未壓縮公鑰（04 || X || Y）。
create or replace function sgn_internal.es256_verify(p_message bytea, p_der_sig bytea, p_pubkey bytea)
returns boolean
language plpgsql
immutable
strict
as $$
declare
    v_rs record;
begin
    if length(p_pubkey) <> 65 or get_byte(p_pubkey, 0) <> 4 then
        return false;
    end if;
    v_rs := sgn_internal.der_ecdsa_rs(p_der_sig);
    if v_rs.r is null then
        return false;
    end if;
    return sgn_internal.p256_verify_digest(
        sha256(p_message),
        v_rs.r,
        v_rs.s,
        sgn_internal.bytes_to_int(substring(p_pubkey from 2 for 32)),
        sgn_internal.bytes_to_int(substring(p_pubkey from 34 for 32))
    );
end;
$$;

-- SPKI DER（瀏覽器 getPublicKey() 的格式）→ 未壓縮公鑰。只接受 P-256 的固定前綴。
create or replace function sgn_internal.p256_spki_to_point(p_spki bytea)
returns bytea
language sql
immutable
strict
as $$
    select case
        when length(p_spki) = 91
         and substring(p_spki from 1 for 26)
             = '\x3059301306072a8648ce3d020106082a8648ce3d030107034200'::bytea
         and get_byte(p_spki, 26) = 4
        then substring(p_spki from 27 for 65)
    end
$$;
