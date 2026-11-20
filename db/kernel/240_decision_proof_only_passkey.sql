-- 決定只能走通行金鑰（K-DECISION-PROOF；紅隊 redteam/findings.md 高-2）。
--
-- 根因：「刻意不開放」只寫在路由表（後端不註冊路由），資料庫卻把 api schema 的全部 function 授權給 sgn_app，
-- 所以只靠身分提供者再驗證（等於只靠密碼）的 api.case_decide_idp 任何持有後端連線的人都能呼叫。
-- 修法分三層：
--   1. 正式建置沒有這個 function：這裡刪除；比較用的版本只裝在資料庫測試用的資料庫（db/testing/70_idp_decide.sql）。
--   2. 決定證明的種類由參數 decision.allowed_proof_kinds 限制（預設只有 passkey）；寫入證明時檢查，
--      所以就算之後又有人加了一條別的證明路徑，正式環境也存不進去。
--   3. 執行權限改成逐一列名的允許清單，來源是路由表（db/tools/grants-sql.mjs，建置的最後一步）；
--      新建立的 function 預設不對任何人開放（PUBLIC 的 EXECUTE 由預設權限撤掉）。

drop function api.case_decide_idp(uuid, text, text);

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('decision.allowed_proof_kinds', 'json', '["passkey"]', '{}',
        '可以作為決定證明的種類；正式環境只有通行金鑰');

insert into sgn.error_catalog (code, message, http_status) values
    ('PROOF_KIND_NOT_ALLOWED', '這種證明不能用來做決定，請用通行金鑰', 403);

create function sgn_internal.decision_proof_kind_check()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    if not sgn_internal.setting('decision.allowed_proof_kinds') ? new.kind then
        perform sgn_internal.raise_error('PROOF_KIND_NOT_ALLOWED', new.kind);
    end if;
    return new;
end;
$$;

create trigger decision_proof_kind_allowed
    before insert on sgn.decision_proof
    for each row execute function sgn_internal.decision_proof_kind_check();

-- 已經建好的環境：之後由 owner 建立的 function 不再預設開放給 PUBLIC（新建置在 db/build.sh 建庫時就先設定）。
alter default privileges revoke execute on functions from public;

select sgn_internal.register_rule(
    'K-DECISION-PROOF',
    '每個決定類動作都要附上資料庫驗得過、綁定單號、內容版本雜湊與決定種類的一次性證明；'
    '證明的種類由參數 decision.allowed_proof_kinds 限制（正式環境只有通行金鑰），後端帳號沒有其他做決定的 function',
    null,
    'partial',
    '沒有顯示快照雜湊'
);
