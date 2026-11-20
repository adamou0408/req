-- 測試專用（不進發行包）：核心的資料庫測試用的流程類型 probe。完全宣告、不登記任何 hook，
-- 讓核心的測試不依賴任何流程包：一關、申請人的主管簽，沒有執行關，核准完成即 completed。
-- 沒有設定最終決定者：主管線走到頂仍找不到人時停住並開例外（K-RESOLVE-HALT）。

select sgn_internal.register_process_type(jsonb_build_object(
    'code', 'probe',
    'name', '核心測試用的申請',
    'pack', 'testing',
    'options', '{}'::jsonb,
    'tiers', jsonb_build_array(jsonb_build_object('code', 'standard', 'name', '一般', 'sort_order', 1)),
    'hooks', '{}'::jsonb
));

select sgn_internal.register_approval_policy('probe', jsonb_build_object(
    'top_resolver_role', null,
    'stages', jsonb_build_array(jsonb_build_object(
        'seq', 10,
        'code', 'manager',
        'name', '申請人主管',
        'phase', 'approval',
        'side', 'demand',
        'resolver', jsonb_build_object('kind', 'applicant_manager'),
        'mode', 'one',
        'applies_when', null
    ))
));

-- probe_chain：測試認領、執行關與最終決定者。主管 → 群組認領（角色 mis）→ 執行（同一群組認領）；
-- 最終決定者是 board_chair。執行完成即生效（沒有被授權者與起迄，授權只記版本）。
select sgn_internal.register_process_type(jsonb_build_object(
    'code', 'probe_chain',
    'name', '核心測試用的多關申請',
    'pack', 'testing',
    'options', '{}'::jsonb,
    'tiers', jsonb_build_array(jsonb_build_object('code', 'standard', 'name', '一般', 'sort_order', 1)),
    'hooks', '{}'::jsonb
));

select sgn_internal.register_approval_policy('probe_chain', jsonb_build_object(
    'top_resolver_role', 'board_chair',
    'stages', jsonb_build_array(
        jsonb_build_object(
            'seq', 10, 'code', 'manager', 'name', '申請人主管', 'phase', 'approval', 'side', 'demand',
            'resolver', jsonb_build_object('kind', 'applicant_manager'), 'mode', 'one', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 20, 'code', 'check', 'name', '群組檢查', 'phase', 'approval', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'role_group_claim', 'role', 'mis'), 'mode', 'one', 'applies_when', null
        ),
        jsonb_build_object(
            'seq', 30, 'code', 'apply', 'name', '執行', 'phase', 'fulfilment', 'side', 'control',
            'resolver', jsonb_build_object('kind', 'role_group_claim', 'role', 'mis'), 'mode', 'one', 'applies_when', null
        )
    )
));
