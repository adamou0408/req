-- 核心：schema、錯誤目錄、參數、規則代碼。以 owner 角色執行。
--
-- schema 分工：
--   sgn           資料表。除了 owner 沒有人有權限。
--   sgn_internal  內部共用 function。沒有人能直接執行。
--   sgn_crypto    驗章與編碼。沒有人能直接執行。
--   api           一般後端（sgn_probe_app）唯一能執行的入口。
--   api_verified  架構 (c) 的驗證服務（sgn_probe_verifier）唯一能執行的入口。
--   api_sync      人員同步（sgn_probe_sync）唯一能執行的入口。
--   api_audit     錨定與驗證工具（sgn_probe_anchor）唯一能執行的入口。

create schema sgn;
create schema sgn_internal;
create schema sgn_crypto;
create schema api;
create schema api_verified;
create schema api_sync;
create schema api_audit;

create table sgn.error_catalog (
    code text primary key,
    message text not null
);

insert into sgn.error_catalog (code, message) values
    ('SESSION_INVALID', '登入已失效，請重新登入'),
    ('CHALLENGE_UNKNOWN', '挑戰值不存在'),
    ('CHALLENGE_EXPIRED', '挑戰值已過期'),
    ('CHALLENGE_USED', '挑戰值已使用過'),
    ('CHALLENGE_PURPOSE', '挑戰值的用途不符'),
    ('TOKEN_INVALID', '身分提供者的憑證無效'),
    ('TOKEN_NONCE', '身分提供者的憑證不是為這次操作簽發的'),
    ('TOKEN_STALE', '身分提供者的憑證太舊，請重新驗證'),
    ('PERSON_UNKNOWN', '找不到對應的人員或帳號已停用'),
    ('PASSKEY_UNKNOWN', '通行金鑰沒有登記'),
    ('PASSKEY_INVALID', '通行金鑰的簽章無效'),
    ('PASSKEY_KEY_INVALID', '通行金鑰的公開金鑰格式不正確'),
    ('PASSKEY_COUNTER', '通行金鑰的計數器倒退，可能被複製'),
    ('DECISION_MISMATCH', '證明的決定種類與要求的不同'),
    ('CONTENT_CHANGED', '申請內容在證明之後已變更'),
    ('CASE_UNKNOWN', '申請單不存在'),
    ('STATE_TRANSITION', '目前的狀態不允許這個動作'),
    ('NOT_APPLICANT', '只有申請人可以做這個動作'),
    ('NOT_APPROVER', '你不是這張單的簽核人'),
    ('SELF_APPROVAL', '申請人不能核准自己的申請'),
    ('NO_APPROVER', '找不到申請人的主管，無法送審'),
    ('AUDITOR_REQUIRED', '只有稽核人員可以查詢稽核紀錄'),
    ('AUDIT_APPEND_ONLY', '稽核紀錄只能新增，不能修改或刪除');

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

-- 參數。探針只做全域值；正式版要有生效時間與適用範圍（見工程規範）。
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
    ('PRB-DIRECTORY', '人員與主管關係由人員目錄同步而來，換主管會關閉舊關係');
