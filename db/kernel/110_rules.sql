-- 規則代碼改成骨幹的命名（核心 K-*；流程包的代碼由流程包自己登記）。
-- 探針階段的 PRB-* 多數只是骨幹規則的部分實作，所以每個代碼記下涵蓋程度（coverage）與這一版做到哪裡（note），
-- 不宣稱涵蓋了骨幹完整的規則。對照：
--   PRB-APPLICANT → K-ACTOR-PROVEN       PRB-STATE → K-NO-REGRESS          PRB-APPROVER → K-DECISION-ELIGIBLE
--   PRB-SELF → K-SOD-APPLICANT           PRB-PROOF → K-DECISION-PROOF      PRB-CHAIN → K-AUDIT-APPEND
--   PRB-CONTENT-HASH → K-AUDIT-CHAIN     PRB-AUDIT-READ → K-AUDITOR-READONLY
--   PRB-DIRECTORY → K-HR-SYNC            PRB-SYNC-GUARD → K-DETECT-MANAGER-FLIP   PRB-SESSION → K-SESSION

alter table sgn.rule
    add column pack text,
    add column coverage text not null default 'full' check (coverage in ('full', 'partial')),
    add column note text;

-- 這時還沒有任何例外紀錄引用規則代碼（全新建置），可以直接換。
delete from sgn.rule where code like 'PRB-%';

create function sgn_internal.register_rule(
    p_code text,
    p_description text,
    p_pack text default null,
    p_coverage text default 'full',
    p_note text default null
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    insert into sgn.rule (code, description, pack, coverage, note)
    values (p_code, p_description, p_pack, p_coverage, p_note)
    on conflict (code) do update
    set description = excluded.description,
        pack = excluded.pack,
        coverage = excluded.coverage,
        note = excluded.note;
end;
$$;

select sgn_internal.register_rule(code, description, null, coverage, note)
from (values
    ('K-ACTOR-PROVEN', '行為人只由資料庫從 session 得出；只有申請人可以修改、送出與撤回自己的申請單', 'partial',
        '沒有填單人；session 的閒置時限與來源突變沒做'),
    ('K-NO-REGRESS', '狀態只能依轉移表前進；已送審的內容不能直接修改，修改一律是新版本', 'partial',
        '更正流程（sys_correction）沒做'),
    ('K-DECISION-ELIGIBLE', '決定當下重驗：必須是這一關目前的指派對象，並重新套用職責分離', 'partial',
        '雇用狀態只看 person.active；沒有代理'),
    ('K-SOD-APPLICANT', '申請人不能簽自己的單，不論以主管、角色、群組哪種方式被指派', 'full', null),
    ('K-SOD-DISTINCT', '同一張單的每一關都是不同的人；解析到已經在其他關的人時，往上一層主管找', 'partial',
        '撞到時一律由後開的那一關往上找，沒有依「解析依據最具體」保留；沒有迴避替代人'),
    ('K-AUDITOR-INDEPENDENT', '持有參數 approval.excluded_decider_roles 列出的角色（稽核、技術維運）的人不會被解析為任何關卡的決定者', 'partial',
        '只涵蓋簽核與執行的指派；例外責任人、設定變更核准人、金鑰保管人沒有這些流程'),
    ('K-RESOLVE-STAGE-START', '簽核人在每一關開始時解析，不在送審時一次算完', 'partial',
        '人事事件到達時主動重新解析沒做'),
    ('K-RESOLVE-HALT', '解析不到合格的人時關卡停住並開例外，不自動通過、不跳關', 'partial',
        '例外沒有派給流程擁有單位主管'),
    ('K-TOP-RESOLVER', '往上找到最頂層仍沒有合格的人時，交給路徑設定的最終決定者；沒有設定就停住', 'partial',
        '沒有「必須設定才能啟用」的檢查'),
    ('K-PARALLEL-ALL', '並行的關卡（mode = all）每件工作都核准才往下', 'full', null),
    ('K-CLAIM', '群組關卡由一人認領後負責；被職責分離排除的人不能認領', 'partial', '放回群組沒做'),
    ('K-VERSION-BOUND', '每個決定綁定當時的內容版本（含被授權者與授權起迄）', 'full', null),
    ('K-CHANGE-REDUCE', '簽核人只能做縮小的修改，縮小後不用重簽並通知申請人；被授權者與授權起迄由核心比較，與內容的比較取較嚴重者', 'full', null),
    ('K-CHANGE-EXPAND', '擴大或無法判定的修改從第一關重簽；每個新版本重新分級，級別升高一律視為擴大', 'full', null),
    ('K-RETURN', '退回或撤回後，申請人只做縮小就從退回的那一關繼續，否則從第一關重簽，並改用最新版路徑', 'partial',
        '退回逾時自動取消沒做'),
    ('K-REJECT', '駁回是終局', 'partial', '重送自動連結前案沒做'),
    ('K-RECALL', '申請人可以把簽核中的單撤回修改，狀態轉 returned，重送依 K-RETURN 判定', 'full', null),
    ('K-OVERLAP-BLOCK', '被同一被授權者的既有有效授權完全涵蓋就擋下', 'partial', '到期提醒期間改為部分重疊沒做'),
    ('K-OVERLAP-REASON', '部分重疊必須填理由', 'partial', '比對在途申請單與被駁回的單沒做'),
    ('K-VALIDITY-MAX', '授權起迄不得超過參數 validity.max_months（可依流程類型與級別設定）', 'full', null),
    ('K-NO-BACKDATE', '授權起日不得早於送審當天', 'partial', '骨幹以核准完成時間為準；這一版在送審時檢查'),
    ('K-PRINCIPAL', '被授權者是團隊、專案或 agent，一定有在職的負責人；專案與 agent 必有結束日', 'partial',
        '建立被授權者與相似名稱比對沒做；只有種子資料'),
    ('K-FULFIL', '核准後產生交付內容；執行人標記完成（需決定證明）後才產生授權並生效，交付的就是核准的那一版', 'partial',
        '驗證、確認、交付信封的鑑別碼沒做'),
    ('K-DECISION-PROOF', '每個決定類動作都要附上資料庫驗得過、綁定單號、內容版本雜湊與決定種類的一次性證明', 'partial',
        '證明等級只有 passkey 一種；沒有顯示快照雜湊'),
    ('K-AUDIT-APPEND', '每個狀態變更與決定都寫一筆事件進雜湊鏈；紀錄只增不改', 'partial', 'denied 事件與列層級安全沒做'),
    ('K-AUDIT-CHAIN', '雜湊以 RFC 8785 標準化 JSON 計算，資料庫以外的程式能算出相同的值', 'partial', '分段封印沒做'),
    ('K-AUDITOR-READONLY', '只有稽核角色可以查稽核紀錄，查詢是唯讀的', 'partial', '稽核範圍與匯出沒做'),
    ('K-HR-SYNC', '人員與主管關係由人員目錄同步；基準之後的主管異動逐筆進鏈，並有冷卻期：參數 approval.manager_change_cooling_workdays 個營業日內仍由原主管簽', 'partial',
        '暫存、差異、門檻、雙人確認沒做'),
    ('K-DETECT-MANAGER-FLIP', '由基準之後同步異動而來的主管關係被用來指派簽核時開例外，申請人、簽核人、稽核都看得到', 'partial',
        '「用於簽核後又改回」的偵測沒做'),
    ('K-SESSION', '登出後，資料庫裡的工作階段立即失效', 'partial', '閒置時限、身分提供者的登出事件沒做')
) as r (code, description, coverage, note);

insert into sgn.error_catalog (code, message, http_status) values
    ('PROCESS_UNKNOWN', '沒有這種申請', 404),
    ('REGISTRATION_INVALID', '流程登記的資料不正確', 500),
    ('POLICY_MISSING', '這種申請沒有可用的簽核路徑', 500),
    ('CONTENT_INVALID', '申請內容還有需要修正的地方', 422),
    ('PRINCIPAL_REQUIRED', '請選擇被授權者', 422),
    ('PRINCIPAL_UNKNOWN', '被授權者不存在、已結束，或負責人已不在職', 422),
    ('VALIDITY_REQUIRED', '請填寫授權起日與迄日', 422),
    ('VALIDITY_ORDER', '授權起日不能晚於迄日', 422),
    ('VALIDITY_TOO_LONG', '授權期間超過這個級別的上限', 422),
    ('VALIDITY_BACKDATED', '授權起日不能早於今天', 422),
    ('OVERLAP_COVERED', '已經被既有的有效授權完全涵蓋，不需要再申請', 409),
    ('OVERLAP_REASON_REQUIRED', '和既有的有效授權部分重疊，請填寫理由', 422),
    ('CHANGE_NOT_REDUCE', '簽核人只能縮小申請內容（欄位、列條件、期間、匯出）', 422),
    ('REASON_REQUIRED', '請填寫原因', 422),
    ('NOT_CLAIMABLE', '這張單沒有你可以認領的工作', 403),
    ('NOT_FULFILLER', '你不是這張單的執行人', 403),
    ('SOD_DISTINCT', '你已經是這張單另一關的簽核人或執行人', 403),
    ('DECIDER_ROLE_EXCLUDED', '你的角色不能擔任簽核人或執行人', 403);
