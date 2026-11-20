-- 人員同步的身分與主管異動（裁決 D79 (1)(5)；紅隊第三輪 低-1、資訊 1、資訊 2）。
--
-- 根因：
--   低-1  同步可以新增和資安長同名、同 email 的人；畫面上的同名區分（加 email）因 email 也相同而失效，
--         名字夾帶零寬字元時完全不加區分。
--   資訊 1 同步改主管當下不開例外，要等冷卻期內剛好有人送單才會有人來看。
--   資訊 2 基準之後由同步新增的人（新到職），主管關係立即生效：同步帳號新增一個人並指定同謀當主管，新人的第一張單就由同謀簽。
--
-- 這一版：
--   1. 同步的每一筆先篩檢（directory_entries_screen）：姓名做 Unicode NFC 正規化；姓名含不可見字元（零寬、方向控制、
--      軟連字號、控制字元）或 email 與另一位在職的人相同（不分大小寫，含同一批之內）時，這一筆的姓名或 email 不採用：
--      新的人不建立，既有的人保留原本的姓名與 email（其餘欄位照常）；全部列進一筆 K-HR-SYNC 例外。不整批拒絕，
--      否則一筆髒資料就能擋住全公司的離職同步。
--   2. 同名的在職人員，畫面上的名字加上 email 與內部短代碼（person_name 是唯一入口）。目錄沒有單位資料，所以不加單位。
--   3. 同步改主管（基準之後）當下就開 K-HR-SYNC 例外，列出改了誰、從誰改成誰。
--   4. 新到職的人不再例外：沒有已生效的主管關係時，一律不用未生效的那一條（D70 的字面），由路徑的最終決定者或停住處理；
--      新人加入時的主管指定也照第 3 點開例外。

-- 姓名裡不可見或會改變顯示方向的字元：零寬（U+200B–U+200F）、方向控制（U+202A–U+202E、U+2066–U+2069）、
-- 不可見運算子（U+2060–U+2064）、BOM（U+FEFF）、軟連字號（U+00AD）、控制字元。
create function sgn_internal.has_invisible_characters(p_text text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select p_text ~ '[​-‏‪-‮⁠-⁤⁦-⁩﻿­[:cntrl:]]'
$$;

-- 篩檢一批同步資料。回傳 {entries: 採用的資料（姓名已正規化）, rejected: [{external_id, field, reason}]}。
create function sgn_internal.directory_entries_screen(p_source text, p_entries jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_entry jsonb;
    v_current sgn.person;
    v_out jsonb := '[]'::jsonb;
    v_rejected jsonb := '[]'::jsonb;
    v_name text;
    v_email_taken boolean;
begin
    for v_entry in select e from jsonb_array_elements(p_entries) as x (e) loop
        select p.* into v_current
        from sgn.person_identity as i
        join sgn.person as p on p.id = i.person_id
        where i.source = p_source and i.external_id = v_entry ->> 'external_id';
        v_name := normalize(v_entry ->> 'display_name', nfc);
        v_email_taken := (v_entry ->> 'active')::boolean and (
            exists (
                select 1 from sgn.person as o
                where o.active and lower(o.email) = lower(v_entry ->> 'email') and o.id is distinct from v_current.id
            )
            or (
                select count(*) from jsonb_array_elements(p_entries) as y (e)
                where (y.e ->> 'active')::boolean and lower(y.e ->> 'email') = lower(v_entry ->> 'email')
            ) > 1
        );
        if sgn_internal.has_invisible_characters(v_name) then
            v_rejected := v_rejected || jsonb_build_object('external_id', v_entry ->> 'external_id', 'field', 'display_name', 'reason', 'invisible_characters');
        end if;
        if v_email_taken and lower(v_entry ->> 'email') is distinct from lower(v_current.email) then
            v_rejected := v_rejected || jsonb_build_object('external_id', v_entry ->> 'external_id', 'field', 'email', 'reason', 'email_taken');
        end if;
        if v_current.id is null then
            -- 新的人：任何一項不採用就不建立
            if not sgn_internal.has_invisible_characters(v_name) and not v_email_taken then
                v_out := v_out || (v_entry || jsonb_build_object('display_name', v_name));
            end if;
        else
            v_out := v_out || (v_entry || jsonb_build_object(
                'display_name', case when sgn_internal.has_invisible_characters(v_name) then v_current.display_name else v_name end,
                'email', case
                    when v_email_taken and lower(v_entry ->> 'email') is distinct from lower(v_current.email) then v_current.email
                    else v_entry ->> 'email'
                end
            ));
        end if;
    end loop;
    return jsonb_build_object('entries', v_out, 'rejected', v_rejected);
end;
$$;

-- ── 畫面上的姓名（同 280 的簽章）：同名的在職人員加上 email 與內部短代碼 ──

create or replace function sgn_internal.person_name(p_person_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select p.display_name || case
        when exists (
            select 1 from sgn.person as o
            where o.id <> p.id and o.active and normalize(o.display_name, nfc) = normalize(p.display_name, nfc)
        ) then '（' || p.email || '・#' || substr(replace(p.id::text, '-', ''), 1, 6) || '）'
        else ''
    end
    from sgn.person as p
    where p.id = p_person_id
$$;

-- ── 找主管（同 280 的簽章）：新到職的人不再例外 ──

create or replace function sgn_internal.resolve_manager_from(p_person_id uuid, p_seen uuid[])
returns sgn.reporting_line
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooling int := sgn_internal.setting_int('approval.manager_change_cooling_workdays');
    v_now timestamptz := sgn_internal.now();
    v_current sgn.reporting_line;
    v_line sgn.reporting_line;
    v_settled sgn.reporting_line;
    v_empty sgn.reporting_line;
begin
    select r.* into v_current from sgn.reporting_line as r where r.person_id = p_person_id and r.valid_to is null;
    if v_current.id is null then
        -- 目錄明寫沒有主管：不回頭用已結束的關係
        return v_empty;
    end if;
    for v_line in
        select r.* from sgn.reporting_line as r where r.person_id = p_person_id order by r.id desc
    loop
        if (case when v_line.origin = 'baseline' then v_line.valid_from else sgn_internal.add_workdays(v_line.valid_from, v_cooling) end) <= v_now
           and (
               v_line.valid_to is null
               or v_line.valid_to >= case when v_line.origin = 'baseline' then v_line.valid_from
                                          else sgn_internal.add_workdays(v_line.valid_from, v_cooling) end
           ) then
            v_settled := v_line;
            exit;
        end if;
    end loop;
    if v_settled.id is null then
        -- 沒有任何已生效的關係（含新到職的人）：不用未生效的那一條
        return v_empty;
    end if;
    if coalesce((select m.active from sgn.person as m where m.id = v_settled.manager_person_id), false) then
        return v_settled;
    end if;
    if v_settled.manager_person_id = any (p_seen) then
        return v_empty;
    end if;
    -- 已生效的主管已不在職：往上一層，同樣只用已生效的關係
    return sgn_internal.resolve_manager_from(v_settled.manager_person_id, p_seen || v_settled.manager_person_id);
end;
$$;

-- ── 寫入（同 280 的簽章）：多回傳 manager_changed（改了主管的人與新舊主管）──

create or replace function sgn_internal.directory_write_entries(p_source text, p_entries jsonb, p_is_baseline boolean, p_now timestamptz)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_ids jsonb := '{}'::jsonb;
    v_entry jsonb;
    v_written jsonb;
    v_person_id uuid;
    v_before uuid;
    v_after uuid;
    v_manager_changed jsonb := '[]'::jsonb;
    v_roles jsonb;
    v_deferred jsonb := '[]'::jsonb;
    v_role_changes jsonb := '[]'::jsonb;
    v_not_applied jsonb := '[]'::jsonb;
    v_ignored jsonb := '[]'::jsonb;
begin
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_written := sgn_internal.directory_write_person(p_source, v_entry, p_is_baseline, p_now);
        v_ids := v_ids || jsonb_build_object(v_entry ->> 'external_id', v_written -> 'id');
        v_deferred := v_deferred || (v_written -> 'deferred');
    end loop;
    for v_entry in select * from jsonb_array_elements(p_entries) loop
        v_person_id := (v_ids ->> (v_entry ->> 'external_id'))::uuid;
        select r.manager_person_id into v_before from sgn.reporting_line as r where r.person_id = v_person_id and r.valid_to is null;
        v_after := sgn_internal.directory_manager_id(p_source, v_entry ->> 'manager_external_id', v_ids);
        if sgn_internal.directory_set_manager(p_source, v_person_id, v_after, p_is_baseline, p_now) then
            v_manager_changed := v_manager_changed || jsonb_build_object('person', v_person_id, 'from', v_before, 'to', v_after);
        end if;
        v_roles := sgn_internal.directory_sync_roles(
            p_source,
            v_person_id,
            array(select jsonb_array_elements_text(v_entry -> 'roles')),
            p_is_baseline,
            p_now
        );
        v_role_changes := v_role_changes || (v_roles -> 'changes');
        v_not_applied := v_not_applied || (v_roles -> 'not_applied');
        v_ignored := v_ignored || (v_roles -> 'ignored');
    end loop;
    return jsonb_build_object(
        'ids', v_ids,
        'deferred', v_deferred,
        'manager_changes', jsonb_array_length(v_manager_changed),
        'manager_changed', v_manager_changed,
        'role_changes', v_role_changes,
        'not_applied', v_not_applied,
        'ignored', (select coalesce(jsonb_agg(distinct c), '[]'::jsonb) from jsonb_array_elements_text(v_ignored) as c)
    );
end;
$$;

-- 一個人的角色（同 230 的簽章）：目錄對錨點角色（ceremony）的說法也記成說法（不套用、基準之後開例外），
-- 和控制類角色一樣——錨點角色只能由資料庫擁有者的儀式指派（D77）。
create or replace function sgn_internal.directory_sync_roles(
    p_source text,
    p_person_id uuid,
    p_codes text[],
    p_is_baseline boolean,
    p_now timestamptz
)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_cooling int := sgn_internal.setting_int('directory.sync_cooling_workdays');
    v_until timestamptz := case when p_is_baseline then p_now else sgn_internal.add_workdays(p_now, v_cooling) end;
    v_business text[] := array(
        select r.code from sgn.role as r
        where r.code = any (p_codes) and r.category = 'business' and r.assignment_source_policy = 'sync_proposed'
    );
    v_manual text[] := array(
        select r.code from sgn.role as r where r.code = any (p_codes) and r.assignment_source_policy in ('manual', 'ceremony')
    );
    v_changes jsonb := '[]'::jsonb;
    v_not_applied jsonb;
    v_code text;
begin
    for v_code in
        select a.role_code
        from sgn.role_assignment as a
        join sgn.role as r on r.code = a.role_code and r.category = 'business'
        where a.person_id = p_person_id and a.source = p_source and a.scope_ref is null and a.valid_to is null
          and a.role_code <> all (v_business)
    loop
        v_changes := v_changes || sgn_internal.directory_role_change(p_source, p_person_id, v_code, 'remove', v_until, p_is_baseline, p_now);
    end loop;
    foreach v_code in array v_business loop
        v_changes := v_changes || sgn_internal.directory_role_change(p_source, p_person_id, v_code, 'add', v_until, p_is_baseline, p_now);
    end loop;
    update sgn.directory_role_claim
    set seen_to = p_now
    where source = p_source and person_id = p_person_id and seen_to is null and role_code <> all (v_manual);
    with added as (
        insert into sgn.directory_role_claim (source, person_id, role_code, seen_from)
        select p_source, p_person_id, c, p_now
        from unnest(v_manual) as c
        where not exists (
            select 1 from sgn.directory_role_claim as x
            where x.source = p_source and x.person_id = p_person_id and x.role_code = c and x.seen_to is null
        )
        returning role_code
    )
    select coalesce(jsonb_agg(jsonb_build_object('person', p_person_id, 'role', a.role_code)), '[]'::jsonb) into v_not_applied
    from added as a
    where not p_is_baseline;
    return jsonb_build_object(
        'changes', v_changes,
        'not_applied', v_not_applied,
        'ignored', to_jsonb(array(select c from unnest(p_codes) as c where not exists (select 1 from sgn.role as r where r.code = c)))
    );
end;
$$;

-- 同步改主管、篩掉的資料各開一筆例外，讓人當下就來看。回傳例外 id 的陣列。
create function sgn_internal.directory_sync_exceptions(p_source text, p_manager_changed jsonb, p_rejected jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_out jsonb := '[]'::jsonb;
begin
    if jsonb_array_length(p_manager_changed) > 0 then
        v_out := v_out || to_jsonb(sgn_internal.exception_open('K-HR-SYNC', null, jsonb_build_object(
            'kind', 'manager_changed', 'source', p_source, 'changes', p_manager_changed,
            'cooling_workdays', sgn_internal.setting_int('approval.manager_change_cooling_workdays')
        )));
    end if;
    if jsonb_array_length(p_rejected) > 0 then
        v_out := v_out || to_jsonb(sgn_internal.exception_open('K-HR-SYNC', null, jsonb_build_object(
            'kind', 'entries_screened', 'source', p_source, 'rejected', p_rejected
        )));
    end if;
    return v_out;
end;
$$;

create or replace function api_sync.directory_apply(p_source text, p_kind text, p_total int, p_entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_now timestamptz := sgn_internal.now();
    v_max_percent int := sgn_internal.setting_int('directory.full_snapshot_max_change_percent');
    v_source sgn.directory_source;
    v_is_baseline boolean;
    v_screened jsonb;
    v_entries jsonb;
    v_diff jsonb;
    v_written jsonb;
    v_status jsonb;
    v_exceptions jsonb := '[]'::jsonb;
    v_seq bigint;
begin
    select * into v_source from sgn.directory_source where code = p_source for update;
    if v_source.code is null then
        perform sgn_internal.raise_error('DIRECTORY_SOURCE_UNKNOWN', p_source);
    end if;
    if p_kind is null or p_kind not in ('full', 'incremental') then
        perform sgn_internal.raise_error('SYNC_KIND_REQUIRED', p_kind);
    end if;
    v_is_baseline := v_source.baseline_seq is null;
    if v_is_baseline and p_kind <> 'full' then
        perform sgn_internal.raise_error('SYNC_BASELINE_FULL');
    end if;
    perform sgn_internal.directory_entries_check(p_entries, p_total);
    perform sgn_internal.directory_apply_due(v_now);
    v_screened := sgn_internal.directory_entries_screen(p_source, p_entries);
    v_entries := v_screened -> 'entries';
    if p_kind = 'full' and not v_is_baseline then
        v_diff := sgn_internal.directory_snapshot_changes(p_source, v_entries);
        if (v_diff ->> 'changes')::int * 100 > v_max_percent * greatest((v_diff ->> 'current')::int, 1) then
            return sgn_internal.directory_reject(p_source, v_entries, v_diff, v_max_percent);
        end if;
    end if;
    v_written := sgn_internal.directory_write_entries(p_source, v_entries, v_is_baseline, v_now);
    v_status := sgn_internal.directory_status_apply(p_source, p_kind, v_entries, v_written -> 'ids', v_now);
    if v_status ->> 'exception' is not null then
        v_exceptions := v_exceptions || (v_status -> 'exception');
    end if;
    v_exceptions := v_exceptions
        || sgn_internal.directory_change_exceptions(p_source, (v_written -> 'deferred') || (v_status -> 'reactivations'));
    if not v_is_baseline then
        v_exceptions := v_exceptions
            || sgn_internal.directory_role_exceptions(p_source, v_written)
            || sgn_internal.directory_sync_exceptions(p_source, v_written -> 'manager_changed', v_screened -> 'rejected');
    end if;
    v_seq := sgn_internal.audit_append('directory.synced', null, null, jsonb_build_object(
        'source', p_source, 'kind', p_kind, 'baseline', v_is_baseline, 'entries', jsonb_array_length(p_entries),
        'screened', v_screened -> 'rejected',
        'diff', v_diff, 'manager_changes', v_written -> 'manager_changes',
        'person_changes_deferred', jsonb_array_length(v_written -> 'deferred'),
        'role_changes', jsonb_array_length(v_written -> 'role_changes'),
        'roles_not_applied', jsonb_array_length(v_written -> 'not_applied'),
        'status', v_status - 'exception' - 'reactivations', 'exceptions', v_exceptions,
        'settings', jsonb_build_object(
            'directory.sync_cooling_workdays', sgn_internal.setting_int('directory.sync_cooling_workdays'),
            'directory.full_snapshot_max_change_percent', v_max_percent,
            'directory.bulk_deactivation_max', sgn_internal.setting_int('directory.bulk_deactivation_max'),
            'directory.deactivation_window_hours', sgn_internal.setting_int('directory.deactivation_window_hours')
        ),
        'input_sha256', encode(sgn_internal.jcs_sha256(p_entries), 'hex')
    ));
    if v_is_baseline then
        update sgn.directory_source set baseline_seq = v_seq where code = p_source;
    end if;
    return jsonb_build_object(
        'kind', p_kind,
        'entries', jsonb_array_length(p_entries),
        'baseline', v_is_baseline,
        'rejected', false,
        'screened', v_screened -> 'rejected',
        'manager_changes', v_written -> 'manager_changes',
        'person_changes_deferred', jsonb_array_length(v_written -> 'deferred'),
        'role_changes', jsonb_array_length(v_written -> 'role_changes'),
        'roles_not_applied', jsonb_array_length(v_written -> 'not_applied'),
        'roles_ignored', v_written -> 'ignored',
        'deactivated', v_status -> 'deactivated',
        'deactivations_deferred', v_status -> 'deactivations_deferred',
        'reactivated', v_status -> 'reactivated',
        'reactivations_deferred', v_status -> 'reactivations_deferred',
        'exceptions', v_exceptions
    );
end;
$$;

comment on function api_sync.directory_apply(text, text, int, jsonb) is
    '人員同步。p_kind：full（完整快照，沒列到的人視為離職；與現況差異超過門檻整批拒絕並開例外）或 incremental（只動有列到的人）；'
    'p_total 必須等於筆數。每一筆先篩檢：姓名正規化，含不可見字元或 email 與另一位在職的人相同時不採用並開例外；'
    '新增人員、主管、角色、在職狀態的異動逐筆進鏈；改主管當下開例外；控制類角色不套用；業務角色異動、延後的停用、'
    '恢復在職、改姓名與 email 有冷卻期並開例外；停用的門檻在時間窗內累計。'
    '呼叫者：sgn_sync（目錄同步工具）。規則：K-HR-SYNC、K-DETECT-MANAGER-FLIP、K-ROLE-SOURCE';

select sgn_internal.register_rule(
    'K-HR-SYNC',
    '人員目錄是權威來源，但同步帳號被入侵時不能立即改變誰來簽：主管異動、業務角色、恢復在職、改姓名與 email 都有冷卻期並開例外'
    '（改主管當下就開）；新到職的人也只用已生效的主管關係；停用立即生效，但時間窗內累計超過門檻（directory.bulk_deactivation_max、'
    'directory.deactivation_window_hours）或持有控制類角色就延後；姓名正規化，含不可見字元或在職者 email 重複的資料不採用並開例外；'
    '找主管只用已生效的關係，主管不在職就往上一層；新增人員寫進鏈；同名的人在畫面上加上 email 與內部短代碼',
    null,
    'partial',
    '暫存區、雙人確認沒做；延後的異動要靠下一次同步或排程 api_job.directory_settle 套用；目錄沒有單位資料，同名區分不加單位'
);
