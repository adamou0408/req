-- 角色登記與角色指派的生效規則（骨幹 1.x 的 role、K-ROLE-SOURCE；紅隊 redteam/findings.md 高-1）。
--
-- 根因：人員同步把目錄群組名稱原封不動寫成角色指派、立即生效。資料庫不知道「角色」是什麼，
-- 所以分不出「業務角色」與「稽核、資安長、技術維運」這類控制角色，也就無從限制誰能指派。
-- 這個檔案：
--   1. sgn.role 登記每個角色的類別（business／control／platform／governance）與指派來源政策；
--      只有 business 能是 sync_proposed，其餘一律 manual（K-ROLE-SOURCE「平台管理類角色只能 manual」，以檢查條件強制）。
--   2. 指派可以「之後才生效」（effective_from）或「之後才結束」（valid_to 在未來），讓同步帶來的業務角色異動有冷卻期：
--      冷卻期內新持有人還不算，原持有人仍算（比照主管關係的冷卻期，K-HR-SYNC）。
--   3. 「現在有效的指派」只有一個判斷（role_assignment_active），has_role 與 role_holders 都用它。

create table sgn.role (
    code text primary key,
    name text not null,
    category text not null check (category in ('business', 'control', 'platform', 'governance')),
    assignment_source_policy text not null check (assignment_source_policy in ('manual', 'sync_proposed')),
    -- 平台內「角色指派變更」：誰可以提出、誰可以核准、提出與核准的人都不得持有的角色（例如稽核角色不得經技術維運之手）
    change_proposer_role text not null references sgn.role (code) deferrable initially deferred,
    change_approver_role text not null references sgn.role (code) deferrable initially deferred,
    change_excluded_role text references sgn.role (code) deferrable initially deferred,
    pack text,
    check (category = 'business' or assignment_source_policy = 'manual'),
    check (change_proposer_role <> change_approver_role)
);

comment on table sgn.role is '角色登記。類別決定能不能由外部同步帶入（K-ROLE-SOURCE）；程式只認類別與政策，不認角色名稱。';

insert into sgn.setting_definition (key, value_type, default_value, scope_kinds, description) values
    ('role_change.default_proposer_role', 'text', '"process_admin"', '{}',
        '登記角色時沒有指定提出人角色，就用這個角色提出角色指派變更'),
    ('role_change.default_approver_role', 'text', '"control_owner"', '{}',
        '登記角色時沒有指定核准人角色，就用這個角色核准角色指派變更');

-- 登記一個角色（可重複執行）。提出與核准的角色沒有指定時取參數的預設。
create function sgn_internal.register_role(
    p_code text,
    p_name text,
    p_category text,
    p_policy text,
    p_proposer_role text default null,
    p_approver_role text default null,
    p_excluded_role text default null,
    p_pack text default null
)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    insert into sgn.role (
        code, name, category, assignment_source_policy,
        change_proposer_role, change_approver_role, change_excluded_role, pack
    )
    values (
        p_code,
        p_name,
        p_category,
        p_policy,
        coalesce(p_proposer_role, sgn_internal.setting_text('role_change.default_proposer_role')),
        coalesce(p_approver_role, sgn_internal.setting_text('role_change.default_approver_role')),
        p_excluded_role,
        p_pack
    )
    on conflict (code) do update
    set name = excluded.name,
        category = excluded.category,
        assignment_source_policy = excluded.assignment_source_policy,
        change_proposer_role = excluded.change_proposer_role,
        change_approver_role = excluded.change_approver_role,
        change_excluded_role = excluded.change_excluded_role,
        pack = excluded.pack;
end;
$$;

-- 核心登記的角色（骨幹 18.1 的平台管理、控制、治理角色；業務上常用的控制角色由核心登記代碼，持有人由客戶指派）。
-- 稽核與稽核主管的指派由稽核主管提出、稽核治理人核准（K-AUDITOR-INDEPENDENT），且不得經技術維運之手。
-- 提出人與核准人角色的外鍵延後到交易結束才檢查，所以同一個語句裡的登記順序不影響。
select sgn_internal.register_role(r.code, r.name, r.category, 'manual', r.proposer, r.approver, r.excluded)
from (values
    ('tech_ops', '技術維運', 'platform', null, null, null),
    ('process_admin', '流程管理者', 'platform', null, null, null),
    ('control_owner', '控制負責人', 'control', null, null, null),
    ('auditor', '稽核', 'platform', 'audit_head', 'audit_governor', 'tech_ops'),
    ('audit_head', '稽核主管', 'platform', 'audit_head', 'audit_governor', 'tech_ops'),
    ('audit_governor', '稽核治理人', 'governance', null, null, 'tech_ops'),
    ('key_custodian', '金鑰保管人', 'platform', null, null, null),
    ('security_responder', '資安緊急停權', 'control', null, null, null),
    ('board_chair', '董事長', 'governance', null, null, null),
    ('parent_officer', '母公司指定主管', 'governance', null, null, null),
    ('ciso', '資安長', 'control', null, null, null),
    ('compliance_officer', '法遵', 'control', null, null, null),
    ('privacy_officer', '個資窗口', 'control', null, null, null),
    ('legal_head', '法務主管', 'control', null, null, null),
    ('hr_data_steward', '人資的資料管理人', 'control', null, null, null),
    ('mis', 'MIS（資安合規檢查）', 'control', null, null, null),
    ('system_custodian', '系統管理人', 'control', null, null, null)
) as r (code, name, category, proposer, approver, excluded);

-- ── 指派的生效期間 ──
-- effective_from：這筆指派從什麼時候起才算數（null＝valid_from）。同步帶來的業務角色新增，要過冷卻期才算。
-- valid_to 可以在未來：同步帶來的業務角色移除，冷卻期內原持有人仍算。
-- change_event_seq：帶來這筆指派（或排定它結束）的異動事件。
alter table sgn.role_assignment
    add column effective_from timestamptz,
    add column change_event_seq bigint;

-- 「這筆指派現在算不算數」的唯一判斷。
create function sgn_internal.role_assignment_active(p_valid_from timestamptz, p_effective_from timestamptz, p_valid_to timestamptz)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(p_effective_from, p_valid_from) <= sgn_internal.now()
       and (p_valid_to is null or p_valid_to > sgn_internal.now())
$$;

-- 同 20_directory.sql 的簽章，改用 role_assignment_active（冷卻期內的新增不算、排定結束前仍算）。
create or replace function sgn_internal.has_role(p_person_id uuid, p_role_code text)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from sgn.role_assignment as a
        where a.person_id = p_person_id
          and a.role_code = p_role_code
          and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
    )
$$;

-- 同 130_principal_grant.sql 的簽章，改用 role_assignment_active。
create or replace function sgn_internal.role_holders(p_role text, p_scope_ref text default null)
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(distinct a.person_id order by a.person_id), '{}')
    from sgn.role_assignment as a
    join sgn.person as p on p.id = a.person_id
    where a.role_code = p_role
      and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
      and p.active
      and a.scope_ref is not distinct from p_scope_ref
$$;

-- 這個人現在是否持有任何非業務類的角色（控制、平台、治理）。停用這種人要進冷卻期（K-HR-SYNC）。
create function sgn_internal.holds_control_role(p_person_id uuid)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1
        from sgn.role_assignment as a
        join sgn.role as r on r.code = a.role_code
        where a.person_id = p_person_id
          and r.category <> 'business'
          and sgn_internal.role_assignment_active(a.valid_from, a.effective_from, a.valid_to)
    )
$$;

select sgn_internal.register_rule(
    'K-ROLE-SOURCE',
    '角色指派的來源依角色登記的政策：控制、平台、治理類只能在平台內指派（一人提出、另一位有權的人以通行金鑰核准）；'
    '外部同步只能帶入業務類角色，且有冷卻期：參數 directory.sync_cooling_workdays 個營業日內新持有人不算、原持有人仍算，並開例外',
    null,
    'partial',
    '提出與核准只看是否持有角色，不比對範圍；沒有職責衝突矩陣（K-ADMIN-SOD）；變更單沒有駁回與撤回'
);

insert into sgn.error_catalog (code, message, http_status) values
    ('ROLE_UNKNOWN', '沒有這個角色', 422);

-- 流程包登記自己的角色（骨幹 6.1 的 register_role）。流程包只能登記業務類或手動指派的角色，政策一樣受 sgn.role 的檢查條件約束。
create function sgn_sdk.register_role(p_code text, p_name text, p_category text, p_policy text, p_pack text)
returns void
language sql
set search_path = pg_catalog, pg_temp
as $$
    select sgn_internal.register_role(p_code, p_name, p_category, p_policy, null, null, null, p_pack)
$$;

revoke all on function sgn_sdk.register_role(text, text, text, text, text) from public;
