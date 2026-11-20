-- 申請單的完整模型（骨幹第 2 節 01e、第 4 節）：流程類型、級別、被授權者與授權起迄、多關卡與工作、
-- 內容版本的變更分類、重疊檢查紀錄、執行內容。狀態依骨幹 4.1 命名。
-- 只新增：40_case.sql 的單一簽核人欄位（approver_person_id、approver_line_id）由每一關的工作（case_task）取代，
-- 用到它們的 function 在後面的檔案以同樣的名稱重建。

alter table sgn.request_case
    add column process_type text not null references sgn.process_type (code),
    add column policy_id bigint references sgn.approval_policy (id),
    add column tier text,
    -- 退回或撤回時記下：從哪一關繼續（只做縮小時）與當時的版本（K-RETURN、K-RECALL）
    add column resume_seq int,
    add column returned_version int;

alter table sgn.request_case
    drop column approver_person_id,
    drop column approver_line_id;

-- terms：核心保存與判定的欄位（被授權者、授權起迄），不在流程包的內容裡（骨幹 6.2）。
-- version_sha256：決定綁定的雜湊，涵蓋內容與 terms（K-VERSION-BOUND）。
alter table sgn.case_version
    add column terms jsonb not null default '{}'::jsonb,
    add column version_sha256 bytea,
    add column tier text,
    add column change_kind text check (change_kind in ('initial', 'same', 'reduce', 'expand')),
    add column created_by uuid references sgn.person (id),
    add column notices jsonb not null default '[]'::jsonb,
    add column errors jsonb not null default '[]'::jsonb;

-- 關卡實例：關卡開始時才建立（K-RESOLVE-STAGE-START）。
--   open      等工作完成；halted 解析不到合格的人（K-RESOLVE-HALT）；done 全部工作完成
--   returned  在這一關被退回或撤回，重送時可能從這一關繼續；cancelled 從第一關重簽或駁回時作廢
create table sgn.case_stage (
    id bigint generated always as identity primary key,
    case_id uuid not null references sgn.request_case (id),
    policy_id bigint not null references sgn.approval_policy (id),
    seq int not null,
    status text not null check (status in ('open', 'halted', 'done', 'returned', 'cancelled')),
    opened_version int not null,
    opened_at timestamptz not null,
    closed_at timestamptz,
    close_reason text,
    foreign key (policy_id, seq) references sgn.policy_stage (policy_id, seq)
);

create index case_stage_case_idx on sgn.case_stage (case_id);

-- 工作：一關裡指派給一個人（或等群組認領）的一件事。
--   unclaimed 群組未認領（claim_role、claim_scope 決定誰可以認領）；pending 等指派對象決定
create table sgn.case_task (
    id bigint generated always as identity primary key,
    case_id uuid not null references sgn.request_case (id),
    stage_id bigint not null references sgn.case_stage (id),
    assignee_person_id uuid references sgn.person (id),
    claim_role text,
    claim_scope text,
    scope_refs text[] not null default '{}',
    status text not null
        check (status in ('unclaimed', 'pending', 'approved', 'returned', 'rejected', 'completed', 'cancelled')),
    -- 解析依據（resolver、主管關係、往上找的路徑、候選人），K-AUDIT-SNAPSHOT 的一部分
    basis jsonb not null,
    opened_at timestamptz not null,
    claimed_at timestamptz,
    closed_at timestamptz,
    decided_version int,
    decision_challenge_id uuid references sgn.auth_challenge (id),
    reason text,
    check ((status = 'unclaimed') = (assignee_person_id is null))
);

create index case_task_case_idx on sgn.case_task (case_id);
create index case_task_assignee_idx on sgn.case_task (assignee_person_id) where status = 'pending';

create table sgn.case_overlap (
    id bigint generated always as identity primary key,
    case_id uuid not null references sgn.request_case (id),
    version int not null,
    level text not null check (level in ('none', 'partial', 'covered')),
    items jsonb not null,
    reason text,
    checked_at timestamptz not null
);

-- 交給外部系統的執行內容：核准完成時由流程包的 build_fulfilment 產生，執行人標記完成時綁定它的雜湊（K-FULFIL）。
create table sgn.fulfilment (
    id bigint generated always as identity primary key,
    case_id uuid not null references sgn.request_case (id),
    version int not null,
    payload jsonb not null,
    payload_sha256 bytea not null,
    created_at timestamptz not null
);

create index fulfilment_case_idx on sgn.fulfilment (case_id);

-- ── 狀態轉移表（骨幹 4.1）。system 動作只由核心在關卡推進時執行 ──

delete from sgn.state_transition;

insert into sgn.state_transition (from_state, action, to_state) values
    ('draft', 'revise', 'draft'),
    ('draft', 'submit', 'in_approval'),
    ('returned', 'revise', 'returned'),
    ('returned', 'submit', 'in_approval'),
    ('in_approval', 'approve', 'in_approval'),
    ('in_approval', 'approve_reduced', 'in_approval'),
    ('in_approval', 'return', 'returned'),
    ('in_approval', 'reject', 'rejected'),
    ('in_approval', 'recall', 'returned'),
    ('in_approval', 'claim', 'in_approval'),
    ('pending_fulfilment', 'claim', 'pending_fulfilment'),
    ('pending_fulfilment', 'fulfil', 'pending_fulfilment'),
    ('in_approval', 'finish_approval', 'pending_fulfilment'),
    ('in_approval', 'finish_approval_final', 'completed'),
    ('pending_fulfilment', 'finish_fulfilment', 'active');

-- ── 動作目錄 ──
--   applicant  只有申請人             assignee  這一關（簽核）目前指派給他的人
--   claimant   可以認領群組工作的人   fulfiller 執行關目前指派給他的人
--   case_party 申請人或這張單任一件工作的指派對象、候選人
--   role       持有 role_setting 指定的角色          system 只由核心執行，不開放給任何人

alter table sgn.action
    drop constraint action_actor_rule_check,
    drop constraint action_check;

delete from sgn.action;

alter table sgn.action
    add constraint action_actor_rule_check
        check (actor_rule in ('applicant', 'assignee', 'claimant', 'fulfiller', 'case_party', 'role', 'system')),
    add constraint action_check check ((actor_rule = 'role') = (role_setting is not null and denied_code is not null));

insert into sgn.action (action, scope, actor_rule, role_setting, denied_code, needs_proof, changes_state) values
    ('revise', 'case', 'applicant', null, null, false, true),
    ('submit', 'case', 'applicant', null, null, false, true),
    ('recall', 'case', 'applicant', null, null, true, true),
    ('approve', 'case', 'assignee', null, null, true, true),
    ('approve_reduced', 'case', 'assignee', null, null, true, true),
    ('return', 'case', 'assignee', null, null, true, true),
    ('reject', 'case', 'assignee', null, null, true, true),
    ('claim', 'case', 'claimant', null, null, false, true),
    ('fulfil', 'case', 'fulfiller', null, null, true, true),
    ('read', 'case', 'case_party', null, null, false, false),
    ('audit.read', 'global', 'role', 'audit.auditor_role', 'AUDITOR_REQUIRED', false, false),
    ('finish_approval', 'case', 'system', null, null, false, true),
    ('finish_approval_final', 'case', 'system', null, null, false, true),
    ('finish_fulfilment', 'case', 'system', null, null, false, true);
