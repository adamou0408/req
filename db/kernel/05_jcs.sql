-- 標準化 JSON（RFC 8785，JSON Canonicalization Scheme）。規則：PRB-CONTENT-HASH。
-- 為什麼：內容雜湊、事件 body、決定證明的雜湊都要能由資料庫以外的程式（稽核人員的瀏覽器、離線工具）
-- 從解析過的 JSON 自己重算；jsonb 的文字輸出不是公開標準，外部程式排不回相同的位元組。
-- 涵蓋 RFC 8785 的三件事：
--   1. 物件的鍵依 UTF-16 code unit 排序（3.2.3）
--   2. 字串依 ECMAScript JSON.stringify 的跳脫規則（3.2.2.2）
--   3. 數字依 ECMAScript Number.prototype.toString，以 IEEE 754 double 表示（3.2.2.3）
-- 跨語言對照測試：db/tests/kernel/25-jcs.test.mjs（資料庫算一次、Node 算一次）。

-- 鍵的排序依據：字串轉成 UTF-16BE 的位元組。bytea 依位元組比較，就等於依 UTF-16 code unit 比較。
-- 為什麼不用 collate "C"：UTF-8 的位元組順序等於 code point 順序，U+E000–U+FFFF 與補充平面字元的先後和 UTF-16 相反。
create function sgn_internal.jcs_key_order(p_key text)
returns bytea
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
    select decode(
        coalesce(
            string_agg(
                case
                    when c.cp < 65536 then lpad(to_hex(c.cp), 4, '0')
                    else lpad(to_hex(55296 + ((c.cp - 65536) >> 10)), 4, '0')
                        || lpad(to_hex(56320 + ((c.cp - 65536) & 1023)), 4, '0')
                end,
                ''
                order by c.i
            ),
            ''
        ),
        'hex'
    )
    from (
        select g.i, ascii(substr(p_key, g.i, 1)) as cp
        from generate_series(1, length(p_key)) as g (i)
    ) as c
$$;

-- 字串：只跳脫 "、\ 與 U+0000–U+001F（有短形式的用短形式，其餘 \u00xx 小寫），其他字元原樣輸出。
create function sgn_internal.jcs_string(p_text text)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    v_out text := replace(replace(p_text, '\', '\\'), '"', '\"');
begin
    if v_out ~ '[\x01-\x1f]' then
        for v_code in 1..31 loop
            v_out := replace(
                v_out,
                chr(v_code),
                case v_code
                    when 8 then '\b'
                    when 9 then '\t'
                    when 10 then '\n'
                    when 12 then '\f'
                    when 13 then '\r'
                    else '\u' || lpad(to_hex(v_code), 4, '0')
                end
            );
        end loop;
    end if;
    return '"' || v_out || '"';
end;
$$;

-- double 的最短十進位位數：回傳 digits（不含前後的 0）與 point，數值 = 0.<digits> × 10^point。
-- 起點是 float8 的文字輸出（extra_float_digits >= 1 時能還原、通常也最短）。但 PostgreSQL 在十進位值剛好落在
-- 兩個 double 的中點時會多給位數（例如 1e23 印成 9.999999999999999e+22），ECMAScript 則要「轉回來仍是同一個 double
-- 的最短位數」，所以再由短到長試一次。
create function sgn_internal.jcs_shortest(p_double float8, out digits text, out point int)
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
set extra_float_digits = 1
as $$
declare
    v_parts text[] := regexp_match(abs(p_double)::text, '^([0-9]+)(?:\.([0-9]+))?(?:e([+-][0-9]+))?$');
    v_k int;
    v_try numeric;
    v_candidate numeric;
begin
    digits := v_parts[1] || coalesce(v_parts[2], '');
    point := length(v_parts[1]) + coalesce(v_parts[3]::int, 0);
    v_k := length(digits);
    digits := ltrim(digits, '0');
    point := point - (v_k - length(digits));
    digits := rtrim(digits, '0');
    v_k := length(digits);
    for v_try_k in 1..v_k - 1 loop
        v_try := round(digits::numeric / 10::numeric ^ (v_k - v_try_k));
        v_candidate := (v_try::text || 'e' || (point - v_try_k)::text)::numeric;
        -- 往上進位可能超出 double 的最大值（例如 1.79e308 → 2e308），那樣的候選不可能是答案
        if v_candidate <= 1.7976931348623157e308 and v_candidate::float8 = abs(p_double) then
            -- 進位（例如 9.99 → 10）時位數多一位，小數點跟著右移
            point := point + length(v_try::text) - v_try_k;
            digits := rtrim(v_try::text, '0');
            return;
        end if;
    end loop;
end;
$$;

-- 數字：先轉成 IEEE 754 double（RFC 8785 只定義 double），再依 ECMAScript Number::toString 排版。
-- 超出 double 範圍的值無法標準化，丟 CONTENT_NOT_CANONICAL。
create function sgn_internal.jcs_number(p_value numeric)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    v_double float8;
    v_digits text;
    v_point int;
    v_k int;
begin
    begin
        v_double := p_value::float8;
    exception
        when numeric_value_out_of_range then
            perform sgn_internal.raise_error('CONTENT_NOT_CANONICAL', p_value::text);
    end;
    if v_double = 0 then
        if p_value <> 0 then
            -- 小到 double 表示不了（下溢成 0）：同樣無法標準化，不能悄悄變成 0
            perform sgn_internal.raise_error('CONTENT_NOT_CANONICAL', p_value::text);
        end if;
        return '0';
    end if;
    select s.digits, s.point into v_digits, v_point from sgn_internal.jcs_shortest(v_double) as s;
    v_k := length(v_digits);
    return case when v_double < 0 then '-' else '' end || case
        when v_k <= v_point and v_point <= 21 then v_digits || repeat('0', v_point - v_k)
        when 0 < v_point and v_point <= 21 then substr(v_digits, 1, v_point) || '.' || substr(v_digits, v_point + 1)
        when -6 < v_point and v_point <= 0 then '0.' || repeat('0', -v_point) || v_digits
        else
            substr(v_digits, 1, 1)
            || case when v_k > 1 then '.' || substr(v_digits, 2) else '' end
            || 'e' || case when v_point - 1 >= 0 then '+' else '-' end
            || abs(v_point - 1)::text
    end;
end;
$$;

-- 標準化 JSON 的唯一入口。
create function sgn_internal.jcs(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
declare
    v_out text;
begin
    case jsonb_typeof(p_value)
        when 'object' then
            select '{' || coalesce(
                string_agg(
                    sgn_internal.jcs_string(e.key) || ':' || sgn_internal.jcs(e.value),
                    ','
                    order by sgn_internal.jcs_key_order(e.key)
                ),
                ''
            ) || '}'
            into v_out
            from jsonb_each(p_value) as e;
        when 'array' then
            select '[' || coalesce(string_agg(sgn_internal.jcs(e.value), ',' order by e.ord), '') || ']'
            into v_out
            from jsonb_array_elements(p_value) with ordinality as e (value, ord);
        when 'string' then
            v_out := sgn_internal.jcs_string(p_value #>> '{}');
        when 'number' then
            v_out := sgn_internal.jcs_number(p_value::numeric);
        else
            -- boolean 與 null 的 jsonb 文字輸出就是標準形式
            v_out := p_value::text;
    end case;
    return v_out;
end;
$$;

-- 標準化 JSON 的 SHA-256。內容雜湊、證明雜湊都經過這裡。
create function sgn_internal.jcs_sha256(p_value jsonb)
returns bytea
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
    select sha256(convert_to(sgn_internal.jcs(p_value), 'UTF8'))
$$;
