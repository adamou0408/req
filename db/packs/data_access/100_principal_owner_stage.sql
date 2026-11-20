-- 資料授權的簽核路徑第 2 版（裁決 D79 (2)）：申請人不是被授權者的負責人時，第一關是「被授權者負責人確認」。
-- 路徑是資料：只新增一版（register_approval_policy 只增不改），已送審的單仍綁定送審當時的第 1 版；
-- 退回後重送時若要重簽，會改用這一版（K-RETURN）。其餘關卡與第 1 版相同。

select sgn_sdk.register_approval_policy('data_access', jsonb_build_object(
    'top_resolver_role', 'board_chair',
    'stages', jsonb_build_array(
        jsonb_build_object(
            'seq', 5, 'code', 'principal_owner', 'name', '被授權者負責人確認', 'phase', 'approval', 'side', 'demand',
            'resolver', jsonb_build_object('kind', 'principal_owner'), 'mode', 'one',
            'applies_when', jsonb_build_object('applicant_not_principal_owner', true)
        ),
        jsonb_build_object(
            'seq', 10, 'code', 'manager', 'name', '申請人主管', 'phase', 'approval', 'side', 'demand',
            'resolver', jsonb_build_object('kind', 'applicant_manager'), 'mode', 'one', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 20, 'code', 'data_owner', 'name', '資料擁有者', 'phase', 'approval', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'scoped_role', 'role', 'data_owner'), 'mode', 'all', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 30, 'code', 'ciso', 'name', '資安長', 'phase', 'approval', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'role_holder', 'role', 'ciso'), 'mode', 'one',
            'applies_when', jsonb_build_object('tier_in', jsonb_build_array('L4'))
        ),
        jsonb_build_object(
            'seq', 40, 'code', 'mis', 'name', '資安合規檢查', 'phase', 'approval', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'role_group_claim', 'role', 'mis'), 'mode', 'one', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 50, 'code', 'fulfil', 'name', '執行設定', 'phase', 'fulfilment', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'system_custodian', 'role', 'system_custodian'), 'mode', 'one', 'applies_when', null
        )
    )
));
