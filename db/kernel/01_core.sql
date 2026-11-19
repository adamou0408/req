-- 核心：schema、錯誤目錄、時間、參數、規則代碼。以 owner 角色執行。
-- 命名依 docs/contract/00-spine.md 第 1.1 節。
--
-- schema 分工：
--   sgn           資料表。除了 owner 沒有人有權限。
--   sgn_internal  內部共用 function（含驗章與編碼、pgcrypto）。沒有人能直接執行。
--   api           人員介面（sgn_app）唯一能執行的入口。
--   api_sync      人員同步（sgn_sync）唯一能執行的入口。
--   api_job       排程：錨定與驗證工具（sgn_job）唯一能執行的入口，唯讀。
-- 測試專用的 schema（架構 (c) 的 api_verified）在 db/testing/，不進發行包。

create schema sgn;
create schema sgn_internal;
create schema api;
create schema api_sync;
create schema api_job;

-- http_status 讓後端啟動時讀表，不在程式裡另寫一份對照。
create table sgn.error_catalog (
    code text primary key,
    message text not null,
    http_status int not null
);

insert into sgn.error_catalog (code, message, http_status) values
    ('SESSION_INVALID', '登入已失效，請重新登入', 401),
    ('CHALLENGE_UNKNOWN', '挑戰值不存在', 422),
    ('CHALLENGE_EXPIRED', '挑戰值已過期', 422),
    ('CHALLENGE_USED', '挑戰值已使用過', 422),
    ('CHALLENGE_PURPOSE', '挑戰值的用途不符', 422),
    ('TOKEN_INVALID', '身分提供者的憑證無效', 422),
    ('TOKEN_NONCE', '身分提供者的憑證不是為這次操作簽發的', 422),
    ('TOKEN_STALE', '身分提供者的憑證太舊，請重新驗證', 422),
    ('PERSON_UNKNOWN', '找不到對應的人員或帳號已停用', 422),
    ('PASSKEY_UNKNOWN', '通行金鑰沒有登記', 422),
    ('PASSKEY_INVALID', '通行金鑰的簽章無效', 422),
    ('PASSKEY_KEY_INVALID', '通行金鑰的公開金鑰格式不正確', 422),
    ('PASSKEY_COUNTER', '通行金鑰的計數器倒退，可能被複製', 422),
    ('DECISION_MISMATCH', '證明的決定種類與要求的不同', 422),
    ('CONTENT_CHANGED', '申請內容在證明之後已變更', 409),
    ('CONTENT_NOT_CANONICAL', '申請內容含有無法標準化的值（數字超出範圍）', 400),
    ('CASE_UNKNOWN', '申請單不存在', 404),
    ('STATE_TRANSITION', '目前的狀態不允許這個動作', 409),
    ('NOT_APPLICANT', '只有申請人可以做這個動作', 403),
    ('NOT_APPROVER', '你不是這張單的簽核人', 403),
    ('SELF_APPROVAL', '申請人不能核准自己的申請', 403),
    ('NO_APPROVER', '找不到申請人的主管，無法送審', 409),
    ('AUDITOR_REQUIRED', '只有稽核人員可以查詢稽核紀錄', 403),
    ('ACTION_UNKNOWN', '沒有這個動作', 400),
    ('DIRECTORY_SOURCE_UNKNOWN', '這個人員來源沒有登記', 403),
    ('AUDIT_APPEND_ONLY', '稽核紀錄只能新增，不能修改或刪除', 409);

-- SQL 丟錯的唯一入口。SQLSTATE 固定為 P0001，訊息的開頭是代碼，後端只需取代碼查目錄。
create function sgn_internal.raise_error(p_code text, p_detail text default null)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_message text;
begin
    select message into v_message from sgn.error_catalog where code = p_code;
    if v_message is null then
        raise exception 'UNKNOWN_ERROR_CODE: %', p_code;
    end if;
    raise exception using
        errcode = 'P0001',
        message = p_code || ': ' || v_message,
        detail = coalesce(p_detail, '');
end;
$$;

-- 取得現在時間的唯一入口（骨幹 1.1）。用 clock_timestamp()：同一個交易裡的多個事件時間也要分得開。
create function sgn_internal.now()
returns timestamptz
language sql
volatile
set search_path = pg_catalog, pg_temp
as $$
    select clock_timestamp()
$$;

-- 參數。目前只有全域值；工程規範要求的生效時間與適用範圍還沒做（見 docs/handoff/promote.md）。
create table sgn.setting (
    key text primary key,
    value jsonb not null,
    description text not null
);

insert into sgn.setting (key, value, description) values
    ('challenge.ttl_seconds', '300', '決定挑戰值的有效秒數'),
    ('idp.token_max_age_seconds', '300', 'ID token 的 iat 最多可以早於現在幾秒'),
    ('idp.issuer', '"http://127.0.0.1:5556/dex"', '登記的身分提供者 issuer'),
    ('idp.client_id', '"sgn-api"', 'ID token 的 aud 必須包含的值'),
    ('idp.connector_id', '"ldap"', 'federated_claims.connector_id 必須等於的值'),
    ('idp.directory_source', '"sim-ldap"', 'federated_claims.user_id 對應到哪個身分來源'),
    ('session.ttl_seconds', '3600', '工作階段的有效秒數'),
    ('webauthn.rp_id', '"localhost"', 'WebAuthn relying party id'),
    ('webauthn.origin', '"http://localhost:3000"', 'clientDataJSON 的 origin 必須等於的值'),
    ('audit.auditor_role', '"auditor"', '可以查稽核紀錄的角色代碼');

create function sgn_internal.setting_text(p_key text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select value #>> '{}' from sgn.setting where key = p_key
$$;

create function sgn_internal.setting_int(p_key text)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select (value #>> '{}')::int from sgn.setting where key = p_key
$$;

-- 規則代碼：測試名稱引用這些代碼，run-tests 檢查每個代碼都有測試。
create table sgn.rule (
    code text primary key,
    description text not null
);

insert into sgn.rule (code, description) values
    ('PRB-APPLICANT', '只有申請人可以修改與送出自己的申請單'),
    ('PRB-STATE', '狀態轉移由轉移表決定；送審後內容不能改；只有送審中的單能做決定'),
    ('PRB-APPROVER', '只有送審時解析出的主管可以做決定'),
    ('PRB-SELF', '申請人不能核准自己的申請'),
    ('PRB-PROOF', '決定必須附上資料庫驗得過、綁定單號、內容雜湊與決定種類的一次性證明'),
    ('PRB-CHAIN', '每個狀態變更都寫進雜湊鏈'),
    ('PRB-AUDIT-READ', '只有稽核角色可以查稽核紀錄，且查詢是唯讀的'),
    ('PRB-DIRECTORY', '人員與主管關係由人員目錄同步而來，換主管會關閉舊關係'),
    ('PRB-SYNC-GUARD', '同步在基準之後寫入的主管關係異動逐筆留在鏈上；由這種關係解析出的簽核人，送審時開例外並在單上可見；送審後的同步異動不改變進行中單的簽核人'),
    ('PRB-SESSION', '登出後，資料庫裡的工作階段立即失效'),
    ('PRB-CONTENT-HASH', '內容雜湊是 RFC 8785 標準化 JSON 的 SHA-256，資料庫以外的程式能算出相同的值');
