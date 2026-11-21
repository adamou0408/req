-- 測試報告（裁決 D94；D64、D93 (4) 的落實；交接 docs/handoff/closed-loop-2.md）。rules.md 還沒有這幾條，條文草稿在交接。
--
-- 報告回答「正式區真的需要給這麼多嗎」。由系統從一張單（來源）的使用紀錄算出，不靠人寫；同一個 function（test_report）用在
-- 送審（來源＝引用的測試區單）與上線後的使用報告（來源＝這張單自己），之後的續期、定期複查也用它（D94 (5)）。
-- 七個區塊：tested（測試了什麼）、used（實際用了什麼：逐欄次數與最後使用時間）、unused（沒用到的欄位）、blocked（被擋下的嘗試）、
-- diff（與這次申請的差異）、application（應用面：申請人填的程式或報表、版本識別、結果給誰看、每欄用途）、completeness（紀錄完整性）。
-- 列條件實際用到的範圍：使用方的摘要沒有列層級的資料，報告照實寫「沒有回報」（限制，見交接）。
-- 警示（DA-TEST-REPORT-WARN）：沒測過的欄位、沒用到的欄位仍在申請裡、測試期間有被擋下的嘗試、測試量低於門檻（參數，依級別）；
-- 另有版本識別變動（DA-TEST-VERSION）與使用方沒有回報使用紀錄（紀錄不完整）。
-- 凍結：整理內容時把報告與它的雜湊放進內容（content.test_report），所以版本雜湊與顯示摘要都涵蓋它，簽核人簽的內容包含它。
-- 送審的那一刻重算一次，和內容裡的不同（使用紀錄又進來了）就擋下、請申請人重新整理；相同就寫進快照表 test_report_snapshot
-- （每張單每一版一筆，只增不改）——送審失敗時整個交易回滾，快照也不留。
-- 版本識別：以使用方系統在使用紀錄裡帶的為準（最新一個時段的最後一個），沒有才用來源單上申請人填的；和這次申請填的不同時
-- 依參數 data_access.version_change_action（依級別；L4 block＝要重新測試，L3 warn＝提示）。
-- 沒有測試紀錄就上線（DA-TEST-EXCEPTION）：生效的那一刻開帶期限的例外 DA-TEST-REPORT-FOLLOWUP（核心 K-GRANT-FOLLOWUP），
-- 申請人在期限內產生上線後的使用報告（api.data_access_usage_report，同一個 test_report，只增不改）才結案；逾期升級，不撤銷。

select sgn_sdk.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description, 'data_access')
from (values
    ('data_access.test_report_min_uses', 'integer', '10', array['tier'],
        '測試報告：測試期間的查詢加匯出次數低於這個數就警示「測試量低於門檻」'),
    ('data_access.version_change_action', 'text', '"warn"', array['tier'],
        '測試報告：測試時的程式或報表版本識別和這次申請填的不同時，warn（提示）或 block（要重新測試，擋下送審）'),
    ('data_access.post_launch_report_workdays', 'integer', '20', array['tier'],
        '沒有測試紀錄就上線的正式區授權：生效後幾個工作天內要產生上線後的使用報告；逾期升級，不撤銷')
) as d (key, value_type, default_value, scope_kinds, description);

select sgn_sdk.register_setting_value(s.key, s.scope_ref, s.value::jsonb, s.reason)
from (values
    ('data_access.test_report_min_uses', 'tier:data_access:L4', '20', '資料授權流程包初始值（L4 要求較多的測試量）'),
    ('data_access.version_change_action', 'tier:data_access:L4', '"block"', '資料授權流程包初始值（裁決 D94 (6)：L4 版本識別變動要重新測試）')
) as s (key, scope_ref, value, reason);

create table pack_data_access.test_report_snapshot (
    case_id uuid not null,
    version int not null,
    report jsonb not null,
    report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null,
    primary key (case_id, version)
);

create table pack_data_access.usage_report (
    id bigint generated always as identity primary key,
    case_id uuid not null,
    kind text not null check (kind in ('post_launch')),
    report jsonb not null,
    report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
    created_by uuid not null,
    created_at timestamptz not null,
    event_seq bigint not null
);

create function pack_data_access.reject_report_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_sdk.raise_error('DA-E-REPORT-APPEND-ONLY', tg_table_name || ' ' || tg_op);
    return null;
end;
$$;

create trigger test_report_snapshot_append_only before update or delete on pack_data_access.test_report_snapshot
    for each row execute function pack_data_access.reject_report_change();
create trigger test_report_snapshot_no_truncate before truncate on pack_data_access.test_report_snapshot
    for each statement execute function pack_data_access.reject_report_change();
create trigger usage_report_append_only before update or delete on pack_data_access.usage_report
    for each row execute function pack_data_access.reject_report_change();
create trigger usage_report_no_truncate before truncate on pack_data_access.usage_report
    for each statement execute function pack_data_access.reject_report_change();

select sgn_sdk.register_message(m.code, m.kind, m.message, m.http_status)
from (values
    ('DA-E-USAGE-REPORT-DENIED', 'error', '只有申請人可以產生這張單的使用報告', 403),
    ('DA-E-REPORT-APPEND-ONLY', 'error', '測試報告的快照與使用報告只增不改', 409),
    ('DA-E-USAGE-REPORT-STATE', 'error', '這張單還沒有生效過，沒有使用紀錄可以做報告', 409)
) as m (code, kind, message, http_status);

select sgn_sdk.register_message(m.code, m.kind, m.message)
from (values
    ('DA-E-APPLICATION-REQUIRED', 'check', '%s的申請要寫應用面：用在哪支程式或報表、結果給誰看。'),
    ('DA-E-TEST-REPORT-STALE', 'check', '引用的測試區單有新的使用紀錄，測試報告已經不同，請重新整理後再送出。'),
    ('DA-E-VERSION-RETEST', 'check', '測試時的版本是 %s，這次申請的是 %s；%s 的申請版本變動要重新在測試區測過。'),
    ('DA-T-RPT-SOURCE', 'notice', '來源：%s單 %s，生效 %s 至 %s'),
    ('DA-T-RPT-FIELD', 'notice', '%s・%s：查詢 %s 次、匯出 %s 次、被擋 %s 次，最後使用 %s'),
    ('DA-T-RPT-UNUSED', 'notice', '沒用到的欄位：%s'),
    ('DA-T-RPT-BLOCKED', 'notice', '被擋下的嘗試：%s 次'),
    ('DA-T-RPT-BLOCKED-OUTSIDE', 'notice', '範圍以外被擋下的欄位：%s'),
    ('DA-T-RPT-UNTESTED', 'notice', '這次申請、測試時沒有的欄位：%s'),
    ('DA-T-RPT-UNUSED-REQUESTED', 'notice', '測試時沒用到、這次仍申請的欄位：%s'),
    ('DA-T-RPT-DROPPED', 'notice', '測試時有、這次沒申請的欄位：%s'),
    ('DA-T-RPT-ROWS', 'notice', '列條件實際用到的範圍：使用方系統沒有回報（摘要沒有列層級的資料）'),
    ('DA-T-RPT-APP', 'notice', '應用面：%s（版本 %s，%s）；結果給 %s 看'),
    ('DA-T-RPT-APP-USE', 'notice', '%s・%s 的用途：%s'),
    ('DA-T-RPT-VERSION-USAGE', 'notice', '版本識別以使用方系統帶的為準'),
    ('DA-T-RPT-VERSION-APPLICANT', 'notice', '使用方系統沒有帶版本識別，以申請人填的為準'),
    ('DA-T-RPT-COMPLETE', 'notice', '紀錄完整性：使用方系統回報了 %s 個時段（%s 至 %s），%s 人使用，查詢加匯出共 %s 次'),
    ('DA-T-RPT-UNREPORTED', 'notice', '紀錄完整性：使用方系統沒有回報這張單的使用紀錄，報告裡的次數不代表沒有使用'),
    ('DA-T-RPT-NONE', 'notice', '（無）'),
    ('DA-T-RPT-NEVER', 'notice', '沒有使用'),
    ('DA-T-RPT-OPEN', 'notice', '至今'),
    ('DA-T-RPT-SHA', 'notice', '測試報告（雜湊前 12 碼 %s）'),
    ('DA-T-RW-UNTESTED', 'notice', '有沒測過的欄位：%s'),
    ('DA-T-RW-UNUSED-REQUESTED', 'notice', '測試時沒用到的欄位仍在申請裡：%s（建議從這次申請拿掉）'),
    ('DA-T-RW-BLOCKED', 'notice', '測試期間有 %s 次被擋下的嘗試'),
    ('DA-T-RW-LOW-VOLUME', 'notice', '測試量 %s 次，低於門檻 %s 次'),
    ('DA-T-RW-VERSION', 'notice', '版本識別變了：測試時 %s，這次 %s'),
    ('DA-T-RW-UNREPORTED', 'notice', '使用方系統沒有回報使用紀錄，無法確認測試期間實際用了什麼'),
    ('DA-T-FOLLOWUP-WHAT', 'notice', '這張正式區的單沒有測試紀錄就上線，請在期限內產生上線後的使用報告（逾期會升級，不會撤銷）。'),
    ('DA-T-POST-LAUNCH-LINE', 'notice', '上線後的使用報告：%s 產生')
) as m (code, kind, message);

-- ── 應用面（申請人填）──

-- 只留表上的鍵、去頭尾空白；每欄用途只留這次申請有的欄位。
create function pack_data_access.application_normalized(p_in jsonb, p_scope jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case when jsonb_typeof(p_in) = 'object' then jsonb_build_object(
        'program', nullif(btrim(case when jsonb_typeof(p_in -> 'program') = 'string' then p_in ->> 'program' else '' end), ''),
        'version', nullif(btrim(case when jsonb_typeof(p_in -> 'version') = 'string' then p_in ->> 'version' else '' end), ''),
        'audience', nullif(btrim(case when jsonb_typeof(p_in -> 'audience') = 'string' then p_in ->> 'audience' else '' end), ''),
        'field_uses', coalesce((
            select jsonb_agg(jsonb_build_object('package', u ->> 'package', 'field', u ->> 'field', 'use', btrim(u ->> 'use'))
                order by u ->> 'package' collate "C", u ->> 'field' collate "C")
            from jsonb_array_elements(case when jsonb_typeof(p_in -> 'field_uses') = 'array' then p_in -> 'field_uses' else '[]' end) as u
            where jsonb_typeof(u -> 'use') = 'string' and btrim(u ->> 'use') <> ''
              and exists (select 1 from jsonb_array_elements(p_scope) as s cross join jsonb_array_elements(s -> 'fields') as f
                          where s ->> 'package' = u ->> 'package' and f ->> 'code' = u ->> 'field')
        ), '[]'::jsonb)
    ) end
$$;

-- ── 報告（可重用：來源單的使用紀錄 × 這次的內容）──

-- 一份內容的（主題包, 欄位）。
create function pack_data_access.content_fields(p_content jsonb)
returns table (package text, field text)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select s ->> 'package', f ->> 'code'
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'scope') = 'array' then p_content -> 'scope' else '[]' end) as s
    cross join lateral jsonb_array_elements(case when jsonb_typeof(s -> 'fields') = 'array' then s -> 'fields' else '[]' end) as f
$$;

-- 使用摘要逐欄加總：{package, field, queries, exports, blocked, last_used_at}。
create function pack_data_access.usage_by_field(p_usage jsonb)
returns table (package text, field text, queries bigint, exports bigint, blocked bigint, last_used_at text)
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select f ->> 'package', f ->> 'field', sum((f ->> 'queries')::bigint), sum((f ->> 'exports')::bigint), sum((f ->> 'blocked')::bigint),
           max(f ->> 'last_used_at')
    from jsonb_array_elements(coalesce(p_usage -> 'items', '[]')) as i
    cross join lateral jsonb_array_elements(coalesce(i -> 'fields', '[]')) as f
    group by 1, 2
$$;

-- 欄位清單 → [{package, field}]（依代碼排序）。
create function pack_data_access.field_list(p_rows jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object('package', r ->> 'package', 'field', r ->> 'field')
        order by r ->> 'package' collate "C", r ->> 'field' collate "C"), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_rows, '[]')) as r
$$;

-- 測試時的版本識別：使用方系統在使用紀錄裡帶的（最新一個時段的最後一個），沒有才用來源單上申請人填的。
create function pack_data_access.tested_version(p_usage jsonb, p_source_content jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        (select jsonb_build_object('value', i -> 'client_versions' ->> (jsonb_array_length(i -> 'client_versions') - 1), 'source', 'usage')
         from jsonb_array_elements(coalesce(p_usage -> 'items', '[]')) as i
         where jsonb_array_length(coalesce(i -> 'client_versions', '[]')) > 0
         order by i #>> '{period,from}' desc
         limit 1),
        jsonb_build_object('value', p_source_content #>> '{application,version}', 'source', 'applicant')
    )
$$;

create function pack_data_access.test_report_warnings(p_report jsonb, p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_min int := (sgn_sdk.setting('data_access.test_report_min_uses',
        array['tier:data_access:' || pack_data_access.classify_tier(p_content)]) #>> '{}')::int;
    v_out jsonb := '[]'::jsonb;
    v_tested text := p_report #>> '{application,tested_version,value}';
    v_now text := p_content #>> '{application,version}';
begin
    if jsonb_array_length(p_report #> '{diff,untested}') > 0 then
        v_out := v_out || jsonb_build_object('code', 'untested_fields', 'fields', p_report #> '{diff,untested}');
    end if;
    if jsonb_array_length(p_report #> '{diff,unused_requested}') > 0 then
        v_out := v_out || jsonb_build_object('code', 'unused_requested', 'fields', p_report #> '{diff,unused_requested}');
    end if;
    if (p_report #>> '{blocked,total}')::int > 0 then
        v_out := v_out || jsonb_build_object('code', 'blocked_attempts', 'count', (p_report #>> '{blocked,total}')::int);
    end if;
    if (p_report #>> '{completeness,total_uses}')::int < v_min then
        v_out := v_out || jsonb_build_object('code', 'low_volume', 'count', (p_report #>> '{completeness,total_uses}')::int, 'threshold', v_min);
    end if;
    if v_tested is not null and v_now is not null and v_tested <> v_now then
        v_out := v_out || jsonb_build_object('code', 'version_changed', 'tested', v_tested, 'requested', v_now);
    end if;
    if not (p_report #>> '{completeness,reported}')::boolean then
        v_out := v_out || jsonb_build_object('code', 'usage_unreported');
    end if;
    return v_out;
end;
$$;

-- 一張來源單的使用紀錄 × 這次的內容 → 報告（data_access_test_report/1）；最後帶 settings（算的時候用到的參數）。
create function pack_data_access.test_report(p_source uuid, p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_src jsonb := sgn_sdk.case_context(p_source);
    v_grant jsonb := sgn_sdk.case_grant(p_source);
    v_usage jsonb := sgn_sdk.case_usage_detail(p_source);
    v_used jsonb;
    v_report jsonb;
begin
    with tested as (select * from pack_data_access.content_fields(v_src -> 'content')),
         u as (select * from pack_data_access.usage_by_field(v_usage))
    select coalesce(jsonb_agg(jsonb_build_object('package', t.package, 'field', t.field,
        'queries', coalesce(u.queries, 0), 'exports', coalesce(u.exports, 0), 'blocked', coalesce(u.blocked, 0), 'last_used_at', u.last_used_at)
        order by t.package collate "C", t.field collate "C"), '[]'::jsonb) into v_used
    from tested as t left join u on u.package = t.package and u.field = t.field;
    v_report := jsonb_build_object(
        'format', 'data_access_test_report/1',
        'source', jsonb_build_object('case_id', p_source, 'case_no', v_src ->> 'case_no',
            'environment', pack_data_access.content_environment(v_src -> 'content'),
            'active_from', v_grant ->> 'created_at', 'active_to', v_grant ->> 'ended_at',
            'valid_from', v_grant ->> 'valid_from', 'valid_to', v_grant ->> 'valid_to'),
        'tested', (select coalesce(jsonb_agg(jsonb_build_object('package', s ->> 'package',
                       'fields', (select jsonb_agg(f ->> 'code' order by f ->> 'code' collate "C") from jsonb_array_elements(s -> 'fields') as f),
                       'row_filters', s -> 'row_filters') order by s ->> 'package' collate "C"), '[]'::jsonb)
                   from jsonb_array_elements(coalesce(v_src #> '{content,scope}', '[]')) as s),
        'used', v_used,
        'rows', jsonb_build_object('reported', false),
        'unused', pack_data_access.field_list((select jsonb_agg(x) from jsonb_array_elements(v_used) as x
                                               where (x ->> 'queries')::int + (x ->> 'exports')::int = 0)),
        'blocked', jsonb_build_object(
            'total', (select coalesce(sum((i ->> 'blocked')::int), 0) from jsonb_array_elements(v_usage -> 'items') as i),
            'outside_scope', (select coalesce(jsonb_agg(jsonb_build_object('package', u.package, 'field', u.field, 'blocked', u.blocked)
                                  order by u.package collate "C", u.field collate "C"), '[]'::jsonb)
                              from pack_data_access.usage_by_field(v_usage) as u
                              where u.blocked > 0 and not exists (select 1 from pack_data_access.content_fields(v_src -> 'content') as t
                                                                  where t.package = u.package and t.field = u.field))),
        'diff', jsonb_build_object(
            'untested', pack_data_access.field_list((select jsonb_agg(jsonb_build_object('package', r.package, 'field', r.field))
                from pack_data_access.content_fields(p_content) as r
                where not exists (select 1 from pack_data_access.content_fields(v_src -> 'content') as t where t.package = r.package and t.field = r.field))),
            'unused_requested', pack_data_access.field_list((select jsonb_agg(jsonb_build_object('package', r.package, 'field', r.field))
                from pack_data_access.content_fields(p_content) as r
                join jsonb_array_elements(v_used) as x on x ->> 'package' = r.package and x ->> 'field' = r.field
                where (x ->> 'queries')::int + (x ->> 'exports')::int = 0)),
            'dropped', pack_data_access.field_list((select jsonb_agg(jsonb_build_object('package', t.package, 'field', t.field))
                from pack_data_access.content_fields(v_src -> 'content') as t
                where not exists (select 1 from pack_data_access.content_fields(p_content) as r where r.package = t.package and r.field = t.field)))
        ),
        'application', coalesce(p_content -> 'application', '{}'::jsonb)
            || jsonb_build_object('tested_version', pack_data_access.tested_version(v_usage, v_src -> 'content')),
        'completeness', jsonb_build_object(
            'reported', coalesce((v_usage ->> 'reported')::boolean, false),
            'first_batch_at', v_usage ->> 'first_batch_at', 'last_batch_at', v_usage ->> 'last_batch_at',
            'periods', (select count(distinct i #>> '{period,from}') from jsonb_array_elements(v_usage -> 'items') as i),
            'people', (select count(distinct i -> 'actor') from jsonb_array_elements(v_usage -> 'items') as i
                       where (i ->> 'queries')::int + (i ->> 'exports')::int + (i ->> 'blocked')::int > 0),
            'total_uses', (select coalesce(sum((i ->> 'queries')::int + (i ->> 'exports')::int), 0) from jsonb_array_elements(v_usage -> 'items') as i)
        )
    );
    return v_report || jsonb_build_object('warnings', pack_data_access.test_report_warnings(v_report, p_content),
        'settings', jsonb_build_object('data_access.test_report_min_uses', (sgn_sdk.setting('data_access.test_report_min_uses',
            array['tier:data_access:' || pack_data_access.classify_tier(p_content)]) #>> '{}')::int));
end;
$$;

-- 報告加上它自己的雜湊（RFC 8785），放進內容的那一份。
create function pack_data_access.test_report_frozen(p_source uuid, p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select r || jsonb_build_object('sha256', sgn_sdk.jcs_sha256(r))
    from (select pack_data_access.test_report(p_source, p_content - 'test_report') as r) as x
$$;

-- ── hook 的包裝 ──

-- 整理內容（hook，DA-TEST-REPORT）：150 之後，加上應用面；有引用測試區單時把報告凍結進內容。
create function pack_data_access.normalize_reported(p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_r jsonb := pack_data_access.normalize_environment(p_content);
    v_content jsonb := v_r -> 'content';
    v_in jsonb := case when jsonb_typeof(p_content) = 'object' then p_content else '{}'::jsonb end;
begin
    v_content := v_content || jsonb_build_object('application', pack_data_access.application_normalized(v_in -> 'application', v_content -> 'scope'));
    if jsonb_typeof(v_content -> 'test_basis') = 'object' and sgn_sdk.case_context((v_content #>> '{test_basis,case_id}')::uuid) is not null then
        v_content := v_content || jsonb_build_object('test_report',
            pack_data_access.test_report_frozen((v_content #>> '{test_basis,case_id}')::uuid, v_content));
    end if;
    return jsonb_build_object('content', v_content, 'notices', v_r -> 'notices', 'errors', v_r -> 'errors');
end;
$$;

-- 比較內容（hook）：應用面不同算擴大（簽核人看到的用途變了）；報告是從依據與使用紀錄算出的，不算申請範圍（縮小後重算）。
create function pack_data_access.compare_reported(p_old jsonb, p_new jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when coalesce(p_old -> 'application', 'null') is distinct from coalesce(p_new -> 'application', 'null') then 'expand'
        else pack_data_access.compare_environment(p_old - 'application' - 'test_report', p_new - 'application' - 'test_report')
    end
$$;

-- 送審複核（hook）：150 之後，正式區要寫應用面；報告要是最新的；版本識別變動依參數擋下或提示。
-- 沒有錯誤時把這一版的報告寫進快照表（同一版再送審不重寫；送審在之後失敗時整個交易回滾）。
create function pack_data_access.review_reported(p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_r jsonb := pack_data_access.review_submission(p_case_id, p_content);
    v_errors jsonb := v_r -> 'errors';
    v_env pack_data_access.data_environment := pack_data_access.environment_row(pack_data_access.content_environment(p_content));
    v_tier text := pack_data_access.classify_tier(p_content);
    v_action text := sgn_sdk.setting('data_access.version_change_action', array['tier:data_access:' || v_tier]) #>> '{}';
    v_fresh jsonb;
    v_version jsonb;
begin
    if v_env.requires_test_basis and p_content ? 'environment'
       and (p_content #>> '{application,program}' is null or p_content #>> '{application,audience}' is null) then
        v_errors := v_errors || pack_data_access.error('application', 'DA-E-APPLICATION-REQUIRED', v_env.name);
    end if;
    if jsonb_typeof(p_content -> 'test_report') = 'object' then
        v_fresh := pack_data_access.test_report_frozen((p_content #>> '{test_basis,case_id}')::uuid, p_content);
        if v_fresh ->> 'sha256' is distinct from p_content #>> '{test_report,sha256}' then
            v_errors := v_errors || pack_data_access.error('test_basis', 'DA-E-TEST-REPORT-STALE');
        end if;
        v_version := (select w from jsonb_array_elements(p_content #> '{test_report,warnings}') as w where w ->> 'code' = 'version_changed');
        if v_version is not null and v_action = 'block' then
            v_errors := v_errors || pack_data_access.error('application.version', 'DA-E-VERSION-RETEST', v_version ->> 'tested', v_version ->> 'requested', v_tier);
        end if;
        if jsonb_array_length(v_errors) = 0 then
            insert into pack_data_access.test_report_snapshot (case_id, version, report, report_sha256, created_at)
            values (p_case_id, (sgn_sdk.case_context(p_case_id) ->> 'version')::int, p_content -> 'test_report',
                p_content #>> '{test_report,sha256}', sgn_sdk.now())
            on conflict (case_id, version) do nothing;
        end if;
    end if;
    return v_r || jsonb_build_object('errors', v_errors, 'settings', (v_r -> 'settings')
        || jsonb_build_object('data_access.version_change_action', v_action)
        || coalesce(p_content #> '{test_report,settings}', '{}'::jsonb));
end;
$$;

-- ── 顯示（簽核人簽的內容）──

create function pack_data_access.fields_named(p_list jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(string_agg(pack_data_access.package_label(x ->> 'package') || '・' || pack_data_access.field_label(x ->> 'package', x ->> 'field'), '、'
        order by x ->> 'package' collate "C", x ->> 'field' collate "C"), sgn_sdk.message('DA-T-RPT-NONE'))
    from jsonb_array_elements(coalesce(p_list, '[]')) as x
$$;

create function pack_data_access.local_time_text(p_at text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(to_char((p_at::timestamptz) at time zone (sgn_sdk.setting('calendar.timezone') #>> '{}'), 'YYYY-MM-DD HH24:MI'),
                    sgn_sdk.message('DA-T-RPT-NEVER'))
$$;

create function pack_data_access.report_warning_text(p_w jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case p_w ->> 'code'
        when 'untested_fields' then sgn_sdk.message('DA-T-RW-UNTESTED', pack_data_access.fields_named(p_w -> 'fields'))
        when 'unused_requested' then sgn_sdk.message('DA-T-RW-UNUSED-REQUESTED', pack_data_access.fields_named(p_w -> 'fields'))
        when 'blocked_attempts' then sgn_sdk.message('DA-T-RW-BLOCKED', p_w ->> 'count')
        when 'low_volume' then sgn_sdk.message('DA-T-RW-LOW-VOLUME', p_w ->> 'count', p_w ->> 'threshold')
        when 'version_changed' then sgn_sdk.message('DA-T-RW-VERSION', p_w ->> 'tested', p_w ->> 'requested')
        when 'usage_unreported' then sgn_sdk.message('DA-T-RW-UNREPORTED')
    end
$$;

-- 報告的顯示（可重用的元件 web/packs/data_access.js reportView 畫這一份）：每一個字都由資料庫產生，只有字串。
create function pack_data_access.report_display(p_report jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'sha256', p_report ->> 'sha256',
        'title', sgn_sdk.message('DA-T-RPT-SHA', left(coalesce(p_report ->> 'sha256', ''), 12)),
        'warnings', (select coalesce(jsonb_agg(jsonb_build_object('code', w ->> 'code', 'text', pack_data_access.report_warning_text(w)) order by n), '[]'::jsonb)
                     from jsonb_array_elements(coalesce(p_report -> 'warnings', '[]')) with ordinality as x (w, n)),
        'sections', jsonb_build_array(
            jsonb_build_object('key', 'tested', 'lines', jsonb_build_array(sgn_sdk.message('DA-T-RPT-SOURCE',
                pack_data_access.environment_label(p_report #>> '{source,environment}'), coalesce(p_report #>> '{source,case_no}', '-'),
                pack_data_access.local_time_text(p_report #>> '{source,active_from}'),
                case when p_report #>> '{source,active_to}' is null then sgn_sdk.message('DA-T-RPT-OPEN')
                     else pack_data_access.local_time_text(p_report #>> '{source,active_to}') end))
                || (select coalesce(jsonb_agg(to_jsonb(pack_data_access.package_label(t ->> 'package') || '：'
                        || (select string_agg(pack_data_access.field_label(t ->> 'package', f #>> '{}'), '、') from jsonb_array_elements(t -> 'fields') as f))), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(p_report -> 'tested', '[]')) as t)),
            jsonb_build_object('key', 'used', 'lines', (select coalesce(jsonb_agg(to_jsonb(sgn_sdk.message('DA-T-RPT-FIELD',
                    pack_data_access.package_label(u ->> 'package'), pack_data_access.field_label(u ->> 'package', u ->> 'field'),
                    u ->> 'queries', u ->> 'exports', u ->> 'blocked', pack_data_access.local_time_text(u ->> 'last_used_at')))), '[]'::jsonb)
                from jsonb_array_elements(coalesce(p_report -> 'used', '[]')) as u) || jsonb_build_array(sgn_sdk.message('DA-T-RPT-ROWS'))),
            jsonb_build_object('key', 'unused', 'lines', jsonb_build_array(sgn_sdk.message('DA-T-RPT-UNUSED', pack_data_access.fields_named(p_report -> 'unused')))),
            jsonb_build_object('key', 'blocked', 'lines', jsonb_build_array(sgn_sdk.message('DA-T-RPT-BLOCKED', p_report #>> '{blocked,total}'),
                sgn_sdk.message('DA-T-RPT-BLOCKED-OUTSIDE', pack_data_access.fields_named(p_report #> '{blocked,outside_scope}')))),
            jsonb_build_object('key', 'diff', 'lines', jsonb_build_array(
                sgn_sdk.message('DA-T-RPT-UNTESTED', pack_data_access.fields_named(p_report #> '{diff,untested}')),
                sgn_sdk.message('DA-T-RPT-UNUSED-REQUESTED', pack_data_access.fields_named(p_report #> '{diff,unused_requested}')),
                sgn_sdk.message('DA-T-RPT-DROPPED', pack_data_access.fields_named(p_report #> '{diff,dropped}')))),
            jsonb_build_object('key', 'application', 'lines', jsonb_build_array(sgn_sdk.message('DA-T-RPT-APP',
                coalesce(p_report #>> '{application,program}', '-'),
                coalesce(p_report #>> '{application,tested_version,value}', '-'),
                sgn_sdk.message(case p_report #>> '{application,tested_version,source}' when 'usage' then 'DA-T-RPT-VERSION-USAGE' else 'DA-T-RPT-VERSION-APPLICANT' end),
                coalesce(p_report #>> '{application,audience}', '-')))
                || (select coalesce(jsonb_agg(to_jsonb(sgn_sdk.message('DA-T-RPT-APP-USE', pack_data_access.package_label(u ->> 'package'),
                        pack_data_access.field_label(u ->> 'package', u ->> 'field'), u ->> 'use'))), '[]'::jsonb)
                    from jsonb_array_elements(coalesce(p_report #> '{application,field_uses}', '[]')) as u)),
            jsonb_build_object('key', 'completeness', 'lines', jsonb_build_array(case when (p_report #>> '{completeness,reported}')::boolean
                then sgn_sdk.message('DA-T-RPT-COMPLETE', p_report #>> '{completeness,periods}',
                    pack_data_access.local_time_text(p_report #>> '{completeness,first_batch_at}'),
                    pack_data_access.local_time_text(p_report #>> '{completeness,last_batch_at}'),
                    p_report #>> '{completeness,people}', p_report #>> '{completeness,total_uses}')
                else sgn_sdk.message('DA-T-RPT-UNREPORTED') end))
        )
    )
$$;

-- 顯示摘要（hook）：150 之後，多了應用面與測試報告（沒有的內容不多這兩個鍵）。
create function pack_data_access.display_reported(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.display_environment(p_content)
        || case when jsonb_typeof(p_content -> 'application') = 'object' and p_content #>> '{application,program}' is not null
            then jsonb_build_object('application', jsonb_build_object('text', sgn_sdk.message('DA-T-RPT-APP',
                p_content #>> '{application,program}', coalesce(p_content #>> '{application,version}', '-'),
                sgn_sdk.message('DA-T-RPT-VERSION-APPLICANT'), coalesce(p_content #>> '{application,audience}', '-'))))
            else '{}'::jsonb end
        || case when jsonb_typeof(p_content -> 'test_report') = 'object'
            then jsonb_build_object('test_report', pack_data_access.report_display(p_content -> 'test_report'))
            else '{}'::jsonb end
$$;

-- ── 沒有測試紀錄就上線：限期補上線後的使用報告（DA-TEST-REPORT-FOLLOWUP）──

-- 授權生效（核心 K-GRANT-FOLLOWUP 的 hook）：沒有測試紀錄的正式區授權開帶期限的例外，通知申請人。
create function pack_data_access.after_grant_activated(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case when jsonb_typeof(c #> '{content,test_exception}') = 'object' then jsonb_build_array(jsonb_build_object(
        'rule_code', 'DA-TEST-REPORT-FOLLOWUP',
        'detail', jsonb_build_object('reason', c #>> '{content,test_exception,reason}',
            'settings', jsonb_build_object('data_access.post_launch_report_workdays', d.days)),
        'due_workdays', d.days,
        'people', jsonb_build_array(c ->> 'applicant_id'),
        'what', sgn_sdk.message('DA-T-FOLLOWUP-WHAT')
    )) else '[]'::jsonb end
    from sgn_sdk.case_context(p_case_id) as c
    cross join lateral (select (sgn_sdk.setting('data_access.post_launch_report_workdays', array['tier:data_access:' || (c ->> 'tier')]) #>> '{}')::int as days) as d
$$;

create function api.data_access_usage_report(p_session text, p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person uuid := sgn_sdk.session_person(p_session);
    v_case jsonb := sgn_sdk.case_context(p_case_id);
    v_report jsonb;
    v_seq bigint;
    v_x record;
begin
    if v_case is null or v_case ->> 'process_type' <> 'data_access' or v_case ->> 'applicant_id' is distinct from v_person::text then
        perform sgn_sdk.raise_error('DA-E-USAGE-REPORT-DENIED', p_case_id::text);
    end if;
    if sgn_sdk.case_grant(p_case_id) is null then
        perform sgn_sdk.raise_error('DA-E-USAGE-REPORT-STATE', p_case_id::text);
    end if;
    v_report := pack_data_access.test_report_frozen(p_case_id, v_case -> 'content');
    v_seq := sgn_sdk.audit_append('data_access.usage_report', p_case_id, v_person, jsonb_build_object(
        'kind', 'post_launch', 'report_sha256', v_report ->> 'sha256', 'warnings', v_report -> 'warnings',
        'settings', v_report -> 'settings', 'rules', jsonb_build_array('DA-TEST-REPORT-FOLLOWUP', 'DA-TEST-REPORT')));
    insert into pack_data_access.usage_report (case_id, kind, report, report_sha256, created_by, created_at, event_seq)
    values (p_case_id, 'post_launch', v_report, v_report ->> 'sha256', v_person, sgn_sdk.now(), v_seq);
    for v_x in select * from sgn_sdk.exceptions_open('DA-TEST-REPORT-FOLLOWUP') as x where x.case_id = p_case_id loop
        perform sgn_sdk.exception_close(v_x.id, jsonb_build_object('resolved', 'post_launch_report', 'person', v_person,
            'report_sha256', v_report ->> 'sha256', 'rules', jsonb_build_array('DA-TEST-REPORT-FOLLOWUP')));
    end loop;
    return jsonb_build_object('case_id', p_case_id, 'report_sha256', v_report ->> 'sha256', 'display', pack_data_access.report_display(v_report));
end;
$$;

comment on function api.data_access_usage_report(text, uuid) is
    '使用者動作「產生上線後的使用報告」：申請人以這張單自己的使用紀錄產生報告（和送審的測試報告同一套），'
    '只增不改、進鏈，並結掉「限期補上線後使用報告」的例外。呼叫者：sgn_app。規則：DA-TEST-REPORT-FOLLOWUP、DA-TEST-REPORT';

create function api.data_access_report_pending(p_session text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'exception_id', x.id,
        'case_id', x.case_id,
        'case_no', (c ->> 'case_no')::bigint,
        'due_at', x.detail ->> 'due_at',
        'due_text', pack_data_access.local_time_text(x.detail ->> 'due_at')
    ) order by x.detail ->> 'due_at', x.id), '[]'::jsonb)
    from sgn_sdk.exceptions_open('DA-TEST-REPORT-FOLLOWUP') as x
    cross join lateral (select sgn_sdk.case_context(x.case_id) as c) as k
    where c ->> 'applicant_id' = sgn_sdk.session_person(p_session)::text
$$;

comment on function api.data_access_report_pending(text) is
    '首頁：等看的人（申請人）補的上線後使用報告（沒有測試紀錄就上線的正式區授權），每項帶期限。呼叫者：sgn_app。規則：DA-TEST-REPORT-FOLLOWUP';

-- ── 登記 ──

select sgn_sdk.register_hook('data_access', h.hook, h.fn)
from (values
    ('normalize_content', 'pack_data_access.normalize_reported'),
    ('compare_content', 'pack_data_access.compare_reported'),
    ('display_content', 'pack_data_access.display_reported'),
    ('review_submission', 'pack_data_access.review_reported'),
    ('after_grant_activated', 'pack_data_access.after_grant_activated')
) as h (hook, fn);

select sgn_sdk.register_rule(r.code, r.description, 'data_access', r.coverage, r.note)
from (values
    ('DA-TEST-REPORT', '正式區的單引用測試區單時，系統從那張單的使用紀錄算出測試報告（七個區塊），凍結進內容（版本雜湊與顯示摘要涵蓋它，'
        '簽核人簽的內容包含它）；送審時重算，不同就擋下', 'partial', '列條件實際用到的範圍：使用方的摘要沒有列層級的資料，報告寫「沒有回報」'),
    ('DA-TEST-REPORT-WARN', '測試報告自動標警示：有沒測過的欄位、沒用到的欄位仍在申請裡、測試期間有被擋下的嘗試、測試量低於門檻（參數，依級別）；'
        '使用方沒有回報使用紀錄也標示', 'full', null),
    ('DA-TEST-VERSION', '應用面的版本識別以使用方系統在使用紀錄裡帶的為準，沒有才用申請人填的；和這次申請的不同時依參數（L4 要重新測試、L3 提示）',
        'full', null),
    ('DA-TEST-REPORT-FOLLOWUP', '沒有測試紀錄就上線的正式區授權：生效時開帶期限的例外，申請人在期限內產生上線後的使用報告（同一套報告，只增不改）才結案；'
        '逾期升級，不撤銷', 'full', null)
) as r (code, description, coverage, note);

-- DA-TEST-EXCEPTION 的後續（上線後的使用報告）已由 DA-TEST-REPORT-FOLLOWUP 做到
select sgn_sdk.register_rule('DA-TEST-EXCEPTION', '正式區的單沒有測試紀錄時，送審後開例外並帶理由，簽核人在決定畫面看得到；核准生效後限期補上線後使用報告',
    'data_access', 'full', null);

revoke all on all functions in schema pack_data_access from public;
