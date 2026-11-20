-- 開發與驗收環境的期初基準（不進正式環境）：人員目錄對控制、平台、治理類角色的說法
-- （sgn.directory_role_claim，基準同步時記下），在這裡直接當成平台內的指派（source = manual）。
-- 正式環境不能這樣做：這類角色不由同步帶入（K-ROLE-SOURCE），期初基準走導入時的設定變更（骨幹第 18 節）。
with bootstrapped as (
    insert into sgn.role_assignment (person_id, role_code, valid_from, source)
    select c.person_id, c.role_code, sgn_internal.now(), 'manual'
    from sgn.directory_role_claim as c
    join sgn.role as r on r.code = c.role_code
    -- 最高治理角色（錨點）不在這裡：只能由資料庫擁有者的儀式指派（裁決 D77），見下面
    where c.seen_to is null and r.assignment_source_policy = 'manual'
    returning person_id, role_code
)
select sgn_internal.audit_append(
    'role.bootstrapped',
    null,
    null,
    jsonb_build_object(
        'source', 'db/seed/kernel/005_bootstrap_roles.sql',
        'assignments', (select jsonb_agg(jsonb_build_object('person', b.person_id, 'role', b.role_code)) from bootstrapped as b)
    )
);

-- 最高治理角色（錨點，裁決 D77）：示範資料以資料庫擁有者的儀式指派目錄對它的說法（正式環境在安裝時由擁有者執行一次）。
select sgn_internal.governance_anchor_install(c.role_code, c.person_id, 'db/seed/kernel/005_bootstrap_roles.sql：開發與驗收環境的安裝儀式')
from sgn.directory_role_claim as c
join sgn.role as r on r.code = c.role_code
where c.seen_to is null and r.anchor;
