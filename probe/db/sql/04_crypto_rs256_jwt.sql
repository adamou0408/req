-- RS256（RSASSA-PKCS1-v1_5 + SHA-256）驗章與 JWT 拆解：純 PL/pgSQL。

-- 比對整段編碼後的訊息（EMSA-PKCS1-v1_5），不做解析，避免 Bleichenbacher 類的寬鬆解析漏洞。
create or replace function sgn_crypto.rs256_verify(p_message bytea, p_sig bytea, p_n bytea, p_e bytea)
returns boolean
language plpgsql
immutable
strict
as $$
declare
    v_k int := length(ltrim(p_n, '\x00'::bytea));
    v_n numeric := sgn_crypto.bytes_to_int(p_n);
    v_s numeric;
    v_digest_info constant bytea := '\x3031300d060960864801650304020105000420'::bytea;
    v_expected bytea;
begin
    if v_k < 256 or length(p_sig) <> v_k then
        return false;
    end if;
    v_s := sgn_crypto.bytes_to_int(p_sig);
    if v_s >= v_n then
        return false;
    end if;
    v_expected := '\x0001'::bytea
        || decode(repeat('ff', v_k - 3 - length(v_digest_info) - 32), 'hex')
        || '\x00'::bytea
        || v_digest_info
        || sha256(p_message);
    return sgn_crypto.int_to_bytes(
        sgn_crypto.mod_pow(v_s, sgn_crypto.bytes_to_int(p_e), v_n),
        v_k
    ) = v_expected;
end;
$$;

-- JWT compact 格式拆成 header、payload（jsonb）、簽章與被簽的 bytes。格式不對回 null。
create or replace function sgn_crypto.jwt_split(
    p_jwt text,
    out header jsonb,
    out payload jsonb,
    out signing_input bytea,
    out signature bytea
)
language plpgsql
immutable
strict
as $$
declare
    v_parts text[] := string_to_array(p_jwt, '.');
begin
    if array_length(v_parts, 1) <> 3 then
        return;
    end if;
    header := convert_from(sgn_crypto.b64url_decode(v_parts[1]), 'UTF8')::jsonb;
    payload := convert_from(sgn_crypto.b64url_decode(v_parts[2]), 'UTF8')::jsonb;
    signing_input := convert_to(v_parts[1] || '.' || v_parts[2], 'UTF8');
    signature := sgn_crypto.b64url_decode(v_parts[3]);
exception
    when others then
        header := null;
        payload := null;
end;
$$;
