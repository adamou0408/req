-- 大數運算與編碼：純 PL/pgSQL，以 numeric 當任意精度整數。
-- 為什麼不用擴充套件：工程規範只允許 pgcrypto，而 pgcrypto 沒有非對稱簽章驗證。
-- 這些 function 都是 IMMUTABLE、無副作用，只放在 sgn_internal，沒有人能直接執行（見 90_grants.sql）。

create or replace function sgn_internal.b64url_decode(p_text text)
returns bytea
language sql
immutable
strict
as $$
    select decode(
        translate(p_text, '-_', '+/')
            || repeat('=', (4 - length(p_text) % 4) % 4),
        'base64'
    )
$$;

create or replace function sgn_internal.b64url_encode(p_bytes bytea)
returns text
language sql
immutable
strict
as $$
    select rtrim(translate(replace(encode(p_bytes, 'base64'), E'\n', ''), '+/', '-_'), '=')
$$;

-- 大端序 bytes → 非負整數。每次吃 6 bytes（48 位元，bigint 放得下）以減少迴圈次數。
create or replace function sgn_internal.bytes_to_int(p_bytes bytea)
returns numeric
language plpgsql
immutable
strict
as $$
declare
    v_len int := length(p_bytes);
    v_head int := v_len % 6;
    v_result numeric := 0;
    v_pos int;
begin
    if v_head > 0 then
        v_result := ('x' || lpad(encode(substring(p_bytes from 1 for v_head), 'hex'), 16, '0'))::bit(64)::bigint;
    end if;
    v_pos := v_head + 1;
    while v_pos <= v_len loop
        v_result := v_result * 281474976710656
            + ('x' || lpad(encode(substring(p_bytes from v_pos for 6), 'hex'), 16, '0'))::bit(64)::bigint;
        v_pos := v_pos + 6;
    end loop;
    return v_result;
end;
$$;

-- 非負整數 → 固定長度的大端序 bytes；放不下就丟錯（代表輸入不合法）。
create or replace function sgn_internal.int_to_bytes(p_value numeric, p_len int)
returns bytea
language plpgsql
immutable
strict
as $$
declare
    v_hex text := '';
    v_rest numeric := p_value;
    v_chunk bigint;
begin
    while v_rest > 0 loop
        v_chunk := mod(v_rest, 281474976710656)::bigint;
        v_hex := lpad(to_hex(v_chunk), 12, '0') || v_hex;
        v_rest := div(v_rest, 281474976710656);
    end loop;
    v_hex := ltrim(v_hex, '0');
    if length(v_hex) > p_len * 2 then
        raise exception 'int_to_bytes: value does not fit in % bytes', p_len;
    end if;
    return decode(lpad(v_hex, p_len * 2, '0'), 'hex');
end;
$$;

-- 模冪：由低位往高位的平方乘法。
create or replace function sgn_internal.mod_pow(p_base numeric, p_exp numeric, p_mod numeric)
returns numeric
language plpgsql
immutable
strict
as $$
declare
    v_result numeric := 1;
    v_base numeric := mod(p_base, p_mod);
    v_exp numeric := p_exp;
begin
    while v_exp > 0 loop
        if mod(v_exp, 2) = 1 then
            v_result := mod(v_result * v_base, p_mod);
        end if;
        v_base := mod(v_base * v_base, p_mod);
        v_exp := div(v_exp, 2);
    end loop;
    return v_result;
end;
$$;

-- 質數模數的反元素（費馬小定理）。
create or replace function sgn_internal.mod_inv(p_value numeric, p_prime numeric)
returns numeric
language sql
immutable
strict
as $$
    select sgn_internal.mod_pow(p_value, p_prime - 2, p_prime)
$$;
