-- 匯出需求調查（閉環第三批 B；裁決 D96 (4)、D92 (7)；提案 docs/packs/data-access/export-purposes.md；交接 docs/handoff/closed-loop-3.md）。
-- rules.md 還沒有這幾條（條文草稿在交接，含「不記錄媒介」要補的一句）。
--
-- 申請人把「可否匯出」設為要匯出時，必填三項調查：目的、頻率、方法（三張代碼表，可以在資料層調整：改名稱、停用、加項目、改引導）。
-- 調查結果進申請內容（export_survey）與顯示摘要，所以版本雜湊與簽核人簽的內容都涵蓋它。調查只給簽核人判斷與之後收斂需求用：
-- 交給使用方系統的規則不因調查結果而異，仍只有可否匯出（build_fulfilment 不讀調查）。
-- 引導：
--   - 目的或方法標示 redirect（把資料送進另一個系統）：提示應由那個系統自己當被授權者申請授權；依參數 data_access.export_redirect_action
--     （block：關閉可否匯出；warn：只提示）。
--   - 目的有系統內的替代做法（alternative）：提示替代做法，不擋。
-- 必填的檢查：畫面送來調查（輸入有 export_survey 鍵）時即時列為要修正的地方；送審時一律檢查（送審複核），所以不經畫面也繞不過。
-- 舊單（升版前、沒有 environment 鍵的內容）與系統整理過、輸入沒有調查的內容：不重算、不追加，照樣能簽；
-- 生效後縮小時畫面沿用原本的調查（沒有就不送這個鍵）。
-- 彙總：api.data_access_export_survey_summary（稽核或 MIS），依目的、頻率、方法各算有幾張單、其中幾張最後可以匯出。

-- ── 代碼表 ──

create table pack_data_access.export_purpose (
    purpose_code text primary key check (purpose_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name text not null check (btrim(name) <> ''),
    requires_description boolean not null,
    -- 把資料送進另一個系統：應由那個系統自己申請（D92 (7)）
    redirect boolean not null,
    -- 系統內的替代做法（顯示給申請人；沒有時為 null）
    alternative text,
    sort_order int not null,
    is_active boolean not null
);

create table pack_data_access.export_frequency (
    frequency_code text primary key check (frequency_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name text not null check (btrim(name) <> ''),
    sort_order int not null,
    is_active boolean not null
);

create table pack_data_access.export_method (
    method_code text primary key check (method_code ~ '^[a-z][a-z0-9_]{0,62}$'),
    name text not null check (btrim(name) <> ''),
    requires_description boolean not null,
    redirect boolean not null,
    sort_order int not null,
    is_active boolean not null
);

-- 目的：export-purposes.md 第 2 節的提案（待負責人以實際案例核對，E2）。
insert into pack_data_access.export_purpose (purpose_code, name, requires_description, redirect, alternative, sort_order, is_active) values
    ('external_handover', '交給外部單位（會計師、主管機關、客戶、廠商）', false, false,
        '對方的人可以以外部人員身分成為被授權者的成員，在系統內查看', 10, true),
    ('offline_analysis', '離線分析（Excel、統計軟體）', false, false,
        '使用方系統的分析環境或查詢介面可以直接算，資料不落地', 20, true),
    ('report_slides', '做簡報或報表', false, false, '在系統內產出彙總與圖表，帶走的是結果不是明細', 30, true),
    ('system_feed', '匯入另一個系統', false, true, null, 40, true),
    ('retention_copy', '留存備查', false, false, '由使用方系統保存查詢條件與結果的雜湊，個人不需要留副本', 50, true),
    ('manager_review', '給主管看', false, false, '請主管加入被授權者的成員，或在系統內分享唯讀的檢視', 60, true),
    ('legal_hold', '法務、訴訟或調查的證據保全', false, false, null, 70, true),
    ('other', '其他（需說明）', true, false, null, 80, true);

insert into pack_data_access.export_frequency (frequency_code, name, sort_order, is_active) values
    ('one_time', '一次性', 10, true),
    ('monthly', '每月', 20, true),
    ('weekly', '每週', 30, true),
    ('daily', '每日', 40, true),
    ('continuous', '持續', 50, true);

insert into pack_data_access.export_method (method_code, name, requires_description, redirect, sort_order, is_active) values
    ('manual_download', '人工下載檔案', false, false, 10, true),
    ('scheduled_file', '排程產出檔案', false, false, 20, true),
    ('system_integration', '介面串接到另一系統', false, true, 30, true),
    ('other', '其他（需說明）', true, false, 40, true);

-- ── 參數、訊息 ──

select sgn_sdk.register_setting_definition(
    'data_access.export_redirect_action', 'text', '"block"', array['process', 'tier'],
    '匯出需求調查的目的或方法是「把資料送進另一個系統」時：block（關閉可否匯出並提示由那個系統自己申請）或 warn（只提示）',
    'data_access'
);

select sgn_sdk.register_message(m.code, m.kind, m.message)
from (values
    ('DA-E-EXPORT-SURVEY-REQUIRED', 'check', '要匯出時，請填匯出需求調查的「%s」。'),
    ('DA-E-EXPORT-SURVEY-UNKNOWN', 'check', '匯出需求調查的「%s」沒有「%s」這個選項。'),
    ('DA-E-EXPORT-SURVEY-DESCRIPTION', 'check', '匯出需求調查選了「%s」，請寫說明。'),
    ('DA-N-EXPORT-REDIRECT-BLOCKED', 'notice',
        '匯出的%s是「%s」：資料要進另一個系統時，請由那個系統自己當被授權者申請授權（直接讀取，套用同一套規則與對帳）。這張單已改為只能查看、不能匯出。'),
    ('DA-N-EXPORT-REDIRECT', 'notice',
        '匯出的%s是「%s」：資料要進另一個系統時，建議由那個系統自己當被授權者申請授權（直接讀取，套用同一套規則與對帳）。'),
    ('DA-N-EXPORT-ALTERNATIVE', 'notice', '「%s」通常不必匯出：%s。真的需要帶走資料，請在說明寫明原因，簽核人會看到。'),
    ('DA-T-EXPORT-REDIRECT-HINT', 'notice', '資料要進另一個系統時，請由那個系統自己當被授權者申請授權；選了這一項，這張單會改為只能查看。'),
    ('DA-T-EXPORT-REDIRECT-WARN-HINT', 'notice', '資料要進另一個系統時，建議由那個系統自己當被授權者申請授權。'),
    ('DA-T-EXPORT-SURVEY-PURPOSE', 'notice', '目的'),
    ('DA-T-EXPORT-SURVEY-FREQUENCY', 'notice', '頻率'),
    ('DA-T-EXPORT-SURVEY-METHOD', 'notice', '方法'),
    ('DA-T-EXPORT-SURVEY-DESCRIPTION', 'notice', '說明'),
    ('DA-T-EXPORT-SURVEY-LINE', 'notice', '匯出需求調查：目的「%s」、頻率「%s」、方法「%s」%s'),
    ('DA-T-EXPORT-SURVEY-NOTE', 'notice', '（說明：%s）'),
    ('DA-T-EXPORT-SURVEY-CLOSED', 'notice', '；已依引導改為只能查看')
) as m (code, kind, message);

-- ── 讀取 ──

create function pack_data_access.export_purpose_row(p_code text)
returns pack_data_access.export_purpose
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from pack_data_access.export_purpose where purpose_code = p_code
$$;

create function pack_data_access.export_method_row(p_code text)
returns pack_data_access.export_method
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from pack_data_access.export_method where method_code = p_code
$$;

create function pack_data_access.export_frequency_row(p_code text)
returns pack_data_access.export_frequency
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select * from pack_data_access.export_frequency where frequency_code = p_code
$$;

create function pack_data_access.export_redirect_action(p_tier text)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_sdk.setting('data_access.export_redirect_action',
        case when p_tier is null then array['process:data_access'] else array['tier:data_access:' || p_tier, 'process:data_access'] end) #>> '{}'
$$;

-- ── 整理 ──

-- 只留表上的四個鍵、去頭尾空白；不是字串的當成沒填。
create function pack_data_access.export_survey_normalized(p_in jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'purpose', to_jsonb(nullif(btrim(case when jsonb_typeof(p_in -> 'purpose') = 'string' then p_in ->> 'purpose' end), '')),
        'frequency', to_jsonb(nullif(btrim(case when jsonb_typeof(p_in -> 'frequency') = 'string' then p_in ->> 'frequency' end), '')),
        'method', to_jsonb(nullif(btrim(case when jsonb_typeof(p_in -> 'method') = 'string' then p_in ->> 'method' end), '')),
        'description', to_jsonb(nullif(btrim(case when jsonb_typeof(p_in -> 'description') = 'string' then p_in ->> 'description' end), ''))
    )
$$;

-- 調查哪裡要修正（DA-EXPORT-SURVEY）：三項必填、代碼要是啟用中的、選了需說明的項目要寫說明。
create function pack_data_access.export_survey_errors(p_survey jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_errors jsonb := '[]'::jsonb;
    v_purpose pack_data_access.export_purpose := pack_data_access.export_purpose_row(p_survey ->> 'purpose');
    v_frequency pack_data_access.export_frequency := pack_data_access.export_frequency_row(p_survey ->> 'frequency');
    v_method pack_data_access.export_method := pack_data_access.export_method_row(p_survey ->> 'method');
    v_item record;
begin
    for v_item in
        select * from (values
            ('purpose', 'DA-T-EXPORT-SURVEY-PURPOSE', coalesce(v_purpose.is_active, false)),
            ('frequency', 'DA-T-EXPORT-SURVEY-FREQUENCY', coalesce(v_frequency.is_active, false)),
            ('method', 'DA-T-EXPORT-SURVEY-METHOD', coalesce(v_method.is_active, false))
        ) as x (key, label, ok)
    loop
        if p_survey ->> v_item.key is null then
            v_errors := v_errors || pack_data_access.error('export_survey.' || v_item.key, 'DA-E-EXPORT-SURVEY-REQUIRED', sgn_sdk.message(v_item.label));
        elsif not v_item.ok then
            v_errors := v_errors || pack_data_access.error('export_survey.' || v_item.key, 'DA-E-EXPORT-SURVEY-UNKNOWN',
                sgn_sdk.message(v_item.label), p_survey ->> v_item.key);
        end if;
    end loop;
    if p_survey ->> 'description' is null then
        if coalesce(v_purpose.requires_description, false) then
            v_errors := v_errors || pack_data_access.error('export_survey.description', 'DA-E-EXPORT-SURVEY-DESCRIPTION', v_purpose.name);
        elsif coalesce(v_method.requires_description, false) then
            v_errors := v_errors || pack_data_access.error('export_survey.description', 'DA-E-EXPORT-SURVEY-DESCRIPTION', v_method.name);
        end if;
    end if;
    return v_errors;
end;
$$;

-- 引導（DA-EXPORT-SURVEY-GUIDE）：回傳 {export_allowed, notices}。redirect 依參數關閉匯出或只提示；有替代做法的目的提示替代做法。
create function pack_data_access.export_survey_guided(p_survey jsonb, p_export boolean, p_tier text)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_purpose pack_data_access.export_purpose := pack_data_access.export_purpose_row(p_survey ->> 'purpose');
    v_method pack_data_access.export_method := pack_data_access.export_method_row(p_survey ->> 'method');
    v_block boolean := pack_data_access.export_redirect_action(p_tier) = 'block';
    v_export boolean := p_export;
    v_notices jsonb := '[]'::jsonb;
    v_label text;
    v_name text;
begin
    if coalesce(v_purpose.redirect and v_purpose.is_active, false) then
        v_label := sgn_sdk.message('DA-T-EXPORT-SURVEY-PURPOSE');
        v_name := v_purpose.name;
    elsif coalesce(v_method.redirect and v_method.is_active, false) then
        v_label := sgn_sdk.message('DA-T-EXPORT-SURVEY-METHOD');
        v_name := v_method.name;
    end if;
    if v_name is not null then
        if v_block then
            v_export := false;
        end if;
        v_notices := v_notices || pack_data_access.notice(
            case when v_block then 'DA-N-EXPORT-REDIRECT-BLOCKED' else 'DA-N-EXPORT-REDIRECT' end, v_label, v_name);
    elsif v_purpose.alternative is not null and v_purpose.is_active then
        v_notices := v_notices || pack_data_access.notice('DA-N-EXPORT-ALTERNATIVE', v_purpose.name, v_purpose.alternative);
    end if;
    return jsonb_build_object('export_allowed', v_export, 'notices', v_notices);
end;
$$;

-- 整理內容（hook）：160 之後，要匯出而且輸入帶了調查時，把調查放進內容、套用引導，並即時列出要修正的地方。
-- 輸入沒有帶調查（舊單、生效後縮小沿用原本內容、不經畫面的呼叫）：內容不多這個鍵，必填由送審複核檢查。
create function pack_data_access.normalize_surveyed(p_content jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_r jsonb := pack_data_access.normalize_reported(p_content);
    v_content jsonb := v_r -> 'content';
    v_in jsonb := case when jsonb_typeof(p_content) = 'object' then p_content else '{}'::jsonb end;
    v_survey jsonb;
    v_guided jsonb;
begin
    if (v_in -> 'export_allowed') is distinct from 'true'::jsonb or not v_in ? 'export_survey' then
        return v_r;
    end if;
    v_survey := pack_data_access.export_survey_normalized(case when jsonb_typeof(v_in -> 'export_survey') = 'object' then v_in -> 'export_survey'
                                                                else '{}'::jsonb end);
    v_guided := pack_data_access.export_survey_guided(v_survey, (v_content -> 'export_allowed') = 'true'::jsonb,
        pack_data_access.classify_tier(v_content));
    return jsonb_build_object(
        'content', v_content || jsonb_build_object('export_survey', v_survey, 'export_allowed', v_guided -> 'export_allowed'),
        'notices', (v_r -> 'notices') || (v_guided -> 'notices'),
        'errors', (v_r -> 'errors') || case when (v_content -> 'export_allowed') = 'true'::jsonb
                                            then pack_data_access.export_survey_errors(v_survey) else '[]'::jsonb end
    );
end;
$$;

-- 比較內容（hook）：仍要匯出時，調查不同算擴大（簽核人判斷的依據變了）；不匯出時調查不影響範圍。其餘同 160。
create function pack_data_access.compare_surveyed(p_old jsonb, p_new jsonb)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when (p_new -> 'export_allowed') = 'true'::jsonb
             and coalesce(p_old -> 'export_survey', 'null') is distinct from coalesce(p_new -> 'export_survey', 'null') then 'expand'
        else pack_data_access.compare_reported(p_old - 'export_survey', p_new - 'export_survey')
    end
$$;

-- 送審複核（hook）：160 之後；新的內容（有 environment 鍵）要匯出時，調查必填（不經畫面也繞不過）。舊單不追加。
create function pack_data_access.review_surveyed(p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_r jsonb := pack_data_access.review_reported(p_case_id, p_content);
begin
    if (p_content -> 'export_allowed') = 'true'::jsonb and p_content ? 'environment' then
        return v_r || jsonb_build_object('errors', (v_r -> 'errors') || pack_data_access.export_survey_errors(
            pack_data_access.export_survey_normalized(case when jsonb_typeof(p_content -> 'export_survey') = 'object'
                                                           then p_content -> 'export_survey' else '{}'::jsonb end)));
    end if;
    return v_r;
end;
$$;

-- ── 顯示（簽核人簽的內容）──

create function pack_data_access.export_survey_display(p_survey jsonb, p_export boolean)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'purpose', jsonb_build_object('code', p_survey ->> 'purpose', 'name', coalesce(p.name, p_survey ->> 'purpose')),
        'frequency', jsonb_build_object('code', p_survey ->> 'frequency', 'name', coalesce(f.name, p_survey ->> 'frequency')),
        'method', jsonb_build_object('code', p_survey ->> 'method', 'name', coalesce(m.name, p_survey ->> 'method')),
        'description', p_survey ->> 'description',
        'text', sgn_sdk.message('DA-T-EXPORT-SURVEY-LINE',
            coalesce(p.name, p_survey ->> 'purpose', '-'),
            coalesce(f.name, p_survey ->> 'frequency', '-'),
            coalesce(m.name, p_survey ->> 'method', '-'),
            case when p_survey ->> 'description' is not null
                 then sgn_sdk.message('DA-T-EXPORT-SURVEY-NOTE', p_survey ->> 'description') else '' end
            || case when not p_export then sgn_sdk.message('DA-T-EXPORT-SURVEY-CLOSED') else '' end)
    )
    from (select 1) as one
    left join pack_data_access.export_purpose as p on p.purpose_code = p_survey ->> 'purpose'
    left join pack_data_access.export_frequency as f on f.frequency_code = p_survey ->> 'frequency'
    left join pack_data_access.export_method as m on m.method_code = p_survey ->> 'method'
$$;

-- 顯示摘要（hook）：160 之後，多了匯出需求調查（沒有調查的內容不多這個鍵，舊的顯示摘要不變）。
create function pack_data_access.display_surveyed(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.display_reported(p_content)
        || case when jsonb_typeof(p_content -> 'export_survey') = 'object'
            then jsonb_build_object('export_survey',
                pack_data_access.export_survey_display(p_content -> 'export_survey', (p_content -> 'export_allowed') = 'true'::jsonb))
            else '{}'::jsonb end
$$;

-- ── 新申請畫面的選項 ──

create function pack_data_access.export_guidance(p_redirect boolean, p_alternative text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case
        when p_redirect then jsonb_build_object('kind', 'redirect', 'text', sgn_sdk.message(
            case when pack_data_access.export_redirect_action(null) = 'block' then 'DA-T-EXPORT-REDIRECT-HINT' else 'DA-T-EXPORT-REDIRECT-WARN-HINT' end))
        when p_alternative is not null then jsonb_build_object('kind', 'alternative', 'text', p_alternative)
    end
$$;

create function pack_data_access.export_survey_options()
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'purposes', (
            select coalesce(jsonb_agg(jsonb_build_object('code', p.purpose_code, 'name', p.name, 'requires_description', p.requires_description,
                'guidance', pack_data_access.export_guidance(p.redirect, p.alternative)) order by p.sort_order), '[]'::jsonb)
            from pack_data_access.export_purpose as p where p.is_active
        ),
        'frequencies', (
            select coalesce(jsonb_agg(jsonb_build_object('code', f.frequency_code, 'name', f.name) order by f.sort_order), '[]'::jsonb)
            from pack_data_access.export_frequency as f where f.is_active
        ),
        'methods', (
            select coalesce(jsonb_agg(jsonb_build_object('code', m.method_code, 'name', m.name, 'requires_description', m.requires_description,
                'guidance', pack_data_access.export_guidance(m.redirect, null)) order by m.sort_order), '[]'::jsonb)
            from pack_data_access.export_method as m where m.is_active
        )
    )
$$;

-- 新申請畫面用的資料目錄（150 api.data_access_catalog 的內容，移到這裡讓下面的路由加上調查的選項）。
create function pack_data_access.catalog_options()
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'packages', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', p.package_code,
                'name', p.name,
                'period_field', p.period_field_code,
                'fields', (
                    select jsonb_agg(jsonb_build_object('code', f.field_code, 'name', f.name, 'classification', f.classification,
                        'environments', (
                            select coalesce(jsonb_agg(jsonb_build_object('environment', z.environment_code, 'classification', z.classification,
                                'treatment_name', sgn_sdk.message('DA-T-TREATMENT-' || upper(z.treatment))) order by z.environment_code), '[]'::jsonb)
                            from pack_data_access.catalog_field_environment as z
                            where z.package_code = f.package_code and z.field_code = f.field_code
                        ))
                        order by f.sort_order)
                    from pack_data_access.catalog_field as f
                    where f.package_code = p.package_code and f.is_active
                ),
                'filters', (
                    select coalesce(jsonb_agg(jsonb_build_object(
                        'code', r.filter_code,
                        'name', r.name,
                        'value_type', r.value_type,
                        'values', (
                            select coalesce(jsonb_agg(jsonb_build_object('value', v.value, 'label', v.label) order by v.sort_order), '[]'::jsonb)
                            from pack_data_access.catalog_filter_value as v
                            where v.package_code = r.package_code and v.filter_code = r.filter_code and v.is_active
                        )
                    ) order by r.sort_order), '[]'::jsonb)
                    from pack_data_access.catalog_filter as r
                    where r.package_code = p.package_code and r.is_active
                )
            ) order by p.sort_order), '[]'::jsonb)
            from pack_data_access.catalog_package as p
            where p.is_active
        ),
        'purpose_categories', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', c.category_code,
                'name', c.name,
                'requires_description', c.requires_description
            ) order by c.sort_order), '[]'::jsonb)
            from pack_data_access.purpose_category as c
            where c.is_active
        ),
        'environments', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', e.environment_code,
                'name', e.name,
                'description', e.description,
                'requires_test_basis', e.requires_test_basis,
                'is_default', e.default_when_missing,
                'applies_to_legacy', e.applies_to_legacy,
                'max_months', (sgn_sdk.setting('data_access.environment_validity_max_months',
                    array['environment:data_access:' || e.environment_code]) #>> '{}')::int
            ) order by e.sort_order), '[]'::jsonb)
            from pack_data_access.data_environment as e
            where e.is_active
        )
    )
$$;

-- 新申請畫面用的資料目錄（同 150 的簽章）：多了匯出需求調查的選項與引導。
create or replace function api.data_access_catalog(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_sdk.session_person(p_session);
    return pack_data_access.catalog_options() || jsonb_build_object('export_survey', pack_data_access.export_survey_options());
end;
$$;

comment on function api.data_access_catalog(text) is
    '新申請畫面用的資料目錄：主題包、欄位（含分級與各區已去識別或遮罩後的分級；L1、L2 欄位顯示為自動給）、列條件欄位與可選的值、期間欄位、'
    '使用情境分類、環境的選項（是否要測試依據、期限上限），以及匯出需求調查的選項（目的、頻率、方法）與引導。呼叫者：sgn_app。'
    '規則：DA-SCOPE-STRUCTURED、DA-TIER-AUTO-GRANT、DA-PURPOSE、DA-ENV-FIELD、DA-ENV-TIER、DA-ENV-VALIDITY、DA-EXPORT-SURVEY、DA-EXPORT-SURVEY-GUIDE';

-- ── 彙總（DA-EXPORT-SURVEY-SUMMARY）──

-- 送審過的單（草稿與捨棄的不算）裡，帶調查的單依某一項分組：每個選項幾張、其中幾張最後可以匯出。停用的選項有單時也列出。
create function pack_data_access.export_survey_counts(p_key text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    with s as (
        select c.content -> 'export_survey' ->> p_key as code, (c.content -> 'export_allowed') = 'true'::jsonb as exported
        from sgn_sdk.cases_in_states('data_access', array['in_approval', 'returned', 'rejected', 'pending_fulfilment', 'verifying', 'active',
            'completed', 'expired', 'revoked', 'fulfilment_failed']) as c
        where jsonb_typeof(c.content -> 'export_survey') = 'object'
    ),
    o as (
        select purpose_code as code, name, sort_order, is_active from pack_data_access.export_purpose where p_key = 'purpose'
        union all
        select frequency_code, name, sort_order, is_active from pack_data_access.export_frequency where p_key = 'frequency'
        union all
        select method_code, name, sort_order, is_active from pack_data_access.export_method where p_key = 'method'
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'code', o.code,
        'name', o.name,
        'cases', (select count(*) from s where s.code = o.code),
        'exported', (select count(*) from s where s.code = o.code and s.exported)
    ) order by o.sort_order), '[]'::jsonb)
    from o
    where o.is_active or exists (select 1 from s where s.code = o.code)
$$;

create function api.data_access_export_survey_summary(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_sdk.authorize_any(sgn_sdk.session_person(p_session), array['audit.read', 'report.mis_read']);
    return jsonb_build_object(
        'total', (
            select count(*)
            from sgn_sdk.cases_in_states('data_access', array['in_approval', 'returned', 'rejected', 'pending_fulfilment', 'verifying', 'active',
                'completed', 'expired', 'revoked', 'fulfilment_failed']) as c
            where jsonb_typeof(c.content -> 'export_survey') = 'object'
        ),
        'by_purpose', pack_data_access.export_survey_counts('purpose'),
        'by_frequency', pack_data_access.export_survey_counts('frequency'),
        'by_method', pack_data_access.export_survey_counts('method')
    );
end;
$$;

comment on function api.data_access_export_survey_summary(text) is
    '匯出需求調查的彙總：送審過、帶調查的單依目的、頻率、方法各有幾張，其中幾張最後可以匯出（給之後收斂資料應用需求用）。'
    '稽核或 MIS（參數 report.mis_role）可以看，唯讀。呼叫者：sgn_app。規則：DA-EXPORT-SURVEY-SUMMARY';

-- ── 登記 ──

select sgn_sdk.register_hook('data_access', h.hook, h.fn)
from (values
    ('normalize_content', 'pack_data_access.normalize_surveyed'),
    ('compare_content', 'pack_data_access.compare_surveyed'),
    ('display_content', 'pack_data_access.display_surveyed'),
    ('review_submission', 'pack_data_access.review_surveyed')
) as h (hook, fn);

select sgn_sdk.register_rule(r.code, r.description, 'data_access', r.coverage, r.note)
from (values
    ('DA-EXPORT-SURVEY', '要匯出時必填匯出需求調查：目的、頻率、方法（三張代碼表，可以在資料層調整；選了需說明的項目要寫說明）；'
        '調查進申請內容與顯示摘要（版本雜湊與簽核人簽的內容涵蓋它）；舊單沒有調查不重算、照樣能簽', 'full', null),
    ('DA-EXPORT-SURVEY-GUIDE', '目的或方法是「把資料送進另一個系統」時提示由那個系統自己申請，依參數關閉可否匯出（初始值 block）；'
        '能在系統內完成的目的提示替代做法', 'full', null),
    ('DA-EXPORT-SURVEY-RULES', '交給使用方系統的規則不因匯出需求調查而異：仍只有可否匯出', 'full', null),
    ('DA-EXPORT-SURVEY-SUMMARY', '稽核與 MIS 可以看匯出需求調查依目的、頻率、方法的彙總', 'full', null)
) as r (code, description, coverage, note);

revoke all on all functions in schema pack_data_access from public;
