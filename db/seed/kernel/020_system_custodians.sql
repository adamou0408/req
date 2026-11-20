-- 示範與驗收用的種子（不進正式環境）：docs/contract/seed-directory.md「受管系統」的主要與備援管理人，
-- 以依範圍的角色指派 system_custodian（scope_ref＝system:<代碼>）表示。外部廠商 x01 不在 sim-ldap，沒有載入。
select sgn_internal.sync_scoped_role_assignments(
    'seed-directory',
    'system_custodian',
    (
        select jsonb_agg(jsonb_build_object('scope_ref', s.scope_ref, 'person_id', sgn_internal.person_by_identity('sim-ldap', s.person)))
        from (values
            ('system:dc', 'p17'),
            ('system:dc', 'p18'),
            ('system:hr_saas', 'p30'),
            ('system:erp', 'p12'),
            ('system:erp', 'p13'),
            ('system:cicd', 'p18'),
            ('system:cicd', 'p17'),
            ('system:jp_crm', 'p35')
        ) as s (scope_ref, person)
    )
);
