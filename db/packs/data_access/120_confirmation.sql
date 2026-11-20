-- 資料授權：驗證中要申請人確認（rules.md「驗證中：系統自動測試……再由申請人確認。兩者都通過才結案生效」
-- 「申請人逾期沒有確認驗證結果，自動撤銷」「驗證結果確認時限 5 個工作天」；契約 02 §3 requires_confirmation）。
-- 確認的人只有申請人（骨幹附錄 B：資料授權的 confirmation_parties 只有申請人）；逾期一律撤銷（核心 K-CONFIRM-TIMEOUT）。

select sgn_sdk.register_process_options('data_access', jsonb_build_object('requires_confirmation', true));

select sgn_sdk.register_setting_value(
    'confirmation.due_workdays', 'process:data_access', '5'::jsonb, '資料授權流程包初始值（rules.md：驗證結果確認時限 5 個工作天）'
);
