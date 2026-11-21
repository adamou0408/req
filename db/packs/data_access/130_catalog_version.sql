-- 資料目錄的版本與綁定（裁決 D92 (1)、(6)；設計 docs/contract/pending-amendments.md D91-a；交接 docs/handoff/closed-loop-1.md）。
--
-- 目錄由平台維護：任何異動（catalog_load 套用一份快照）都算一次標準化快照的雜湊，與目前版本不同才產生新版本
-- （序號＋內容雜湊＋完整快照，只增不改）。雜湊涵蓋主題包、欄位、分級、列條件與列舉值，以及「代碼 → 實體資源」的對照
-- （主題包 → 資料表、欄位 → 欄、列條件 → 欄）：只換實體資源而代碼不變也是新版本。演算法見 catalog_snapshot 的註解；
-- 使用方系統用同一個演算法（測試向量 db/tests/packs/data_access/fixtures/catalog-vectors.json，sim/dc 共用）。
--
-- 綁定：每個內容版本整理時（normalize_content 的 hook）帶上整理當下的目錄版本 {version_no, sha256}，所以版本雜湊與
-- 顯示摘要都涵蓋它，簽核人簽的內容包含它（DA-CATALOG-BOUND）。比較內容時忽略這個鍵（版本號不同不算擴大）。
-- 交付的規則帶綁定的版本；使用方系統在已簽的回應裡回報它套用時用的版本。平台比較兩邊版本上「這張單引用到的那一部分」：
-- 不同就不生效並開例外（DA-CATALOG-MISMATCH），平台不認得的版本在寬限時間內重送、逾時開例外（DA-CATALOG-UNKNOWN）。
-- 對帳回報同樣比較（核心的 check_reconciliation_report）。
--
-- 目錄改版時（同一個交易）：逐張比較受影響的單——簽核中的重新綁定並從第一關重簽（核心 K-CONTENT-REBIND），
-- 待套用、驗證中、生效中的開例外並通知資料擁有者（DA-CATALOG-DRIFT）；只改名稱時由資料擁有者在期限內確認意義沒變
-- （DA-CATALOG-RENAME-CONFIRM），逾期升級、不撤銷（核心 K-EXCEPTION-FOLLOWUP）。
-- 舊單（這一版之前的內容沒有目錄版本）：已存的雜湊不重算；未結束的單記一筆事後基準（不在簽核內容內），只用來偵測之後的異動。

-- ── 代碼 → 實體資源的對照（快照的 resource 鍵；沒有給是 null，也算進雜湊）──

alter table pack_data_access.catalog_package add column resource text;
alter table pack_data_access.catalog_field add column resource text;
alter table pack_data_access.catalog_filter add column resource text;

-- ── 版本 ──

create table pack_data_access.catalog_version (
    version_no int primary key check (version_no > 0),
    catalog_sha256 text not null check (catalog_sha256 ~ '^[0-9a-f]{64}$'),
    snapshot jsonb not null,
    source text not null check (btrim(source) <> ''),
    created_at timestamptz not null,
    event_seq bigint not null
);

create index catalog_version_sha_idx on pack_data_access.catalog_version (catalog_sha256);

-- 舊單的事後基準：這一版之前建立、沒有目錄版本的內容版本，升版時記下當時的目錄版本（不在簽核內容內）。
create table pack_data_access.catalog_baseline (
    case_id uuid not null,
    version int not null,
    catalog_version_no int not null references pack_data_access.catalog_version (version_no),
    recorded_at timestamptz not null,
    primary key (case_id, version)
);

-- 資料擁有者確認「只改名稱、意義沒變」：之後這張單以確認的那一版目錄比對（不必重送規則）。
create table pack_data_access.catalog_ack (
    id bigint generated always as identity primary key,
    case_id uuid not null,
    catalog_version_no int not null references pack_data_access.catalog_version (version_no),
    exception_id bigint not null unique,
    confirmed_by uuid not null,
    confirmed_at timestamptz not null
);

-- 使用方回報、平台不認得的版本：第一次看到的時間（對帳的寬限從這裡算）。
create table pack_data_access.catalog_unknown_seen (
    channel text not null,
    catalog_sha256 text not null,
    first_seen timestamptz not null,
    primary key (channel, catalog_sha256)
);

select sgn_sdk.register_message(m.code, m.kind, m.message, m.http_status)
from (values
    ('DA-E-CATALOG-APPEND-ONLY', 'error', '資料目錄的版本與確認紀錄只增不改', 409),
    ('DA-E-CATALOG-VERSION-MISSING', 'error', '這張單沒有綁定資料目錄的版本，不能交付', 500),
    ('DA-E-CATALOG-CONFIRM-DENIED', 'error', '只有受影響主題包目前的資料擁有者可以確認這項目錄異動', 403),
    ('DA-E-CATALOG-CONFIRM-UNKNOWN', 'error', '沒有這筆待確認的目錄異動（可能已確認或不需要確認）', 404)
) as m (code, kind, message, http_status);

select sgn_sdk.register_message(m.code, 'notice', m.message)
from (values
    ('DA-T-CATALOG-LINE', '資料目錄第 %s 版（%s）')
) as m (code, message);

create function pack_data_access.reject_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_sdk.raise_error('DA-E-CATALOG-APPEND-ONLY', tg_table_name || ' ' || tg_op);
    return null;
end;
$$;

create trigger catalog_version_append_only before update or delete on pack_data_access.catalog_version
    for each row execute function pack_data_access.reject_change();
create trigger catalog_version_no_truncate before truncate on pack_data_access.catalog_version
    for each statement execute function pack_data_access.reject_change();
create trigger catalog_baseline_append_only before update or delete on pack_data_access.catalog_baseline
    for each row execute function pack_data_access.reject_change();
create trigger catalog_baseline_no_truncate before truncate on pack_data_access.catalog_baseline
    for each statement execute function pack_data_access.reject_change();
create trigger catalog_ack_append_only before update or delete on pack_data_access.catalog_ack
    for each row execute function pack_data_access.reject_change();
create trigger catalog_ack_no_truncate before truncate on pack_data_access.catalog_ack
    for each statement execute function pack_data_access.reject_change();

select sgn_sdk.register_setting_definition(d.key, d.value_type, d.default_value::jsonb, d.scope_kinds, d.description, 'data_access')
from (values
    ('data_access.catalog_unknown_grace_minutes', 'integer', '60', array['channel'],
        '使用方系統回報平台不認得的目錄版本時，幾分鐘內當成還沒送到（重送）；超過就開例外 DA-CATALOG-UNKNOWN'),
    ('data_access.catalog_rename_confirm_workdays', 'integer', '5', array['tier'],
        '目錄只改名稱時，資料擁有者要在幾個工作天內確認生效中的單意義沒有改變；逾期升級，不撤銷（D92 (6)）')
) as d (key, value_type, default_value, scope_kinds, description);

-- ── 標準化快照與雜湊 ──
-- 只列啟用中的項目。{format, packages[{code, name, system, period_field, resource, fields[{code, name, classification, resource}],
-- filters[{code, name, value_type, resource, values[{value, label}]}]}]}；主題包、欄位、列條件依代碼、列舉值依值的位元組順序排序。
-- 不含擁有者（角色指派另有紀錄）、排序欄位與說明文字。雜湊＝RFC 8785（核心的 JCS）標準化後的 SHA-256，小寫十六進位。

create function pack_data_access.catalog_filter_snapshot(p_package_code text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'code', r.filter_code, 'name', r.name, 'value_type', r.value_type, 'resource', r.resource,
        'values', (
            select coalesce(jsonb_agg(jsonb_build_object('value', v.value, 'label', v.label) order by v.value collate "C"), '[]'::jsonb)
            from pack_data_access.catalog_filter_value as v
            where v.package_code = r.package_code and v.filter_code = r.filter_code and v.is_active
        )
    ) order by r.filter_code collate "C"), '[]'::jsonb)
    from pack_data_access.catalog_filter as r
    where r.package_code = p_package_code and r.is_active
$$;

create function pack_data_access.catalog_snapshot()
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('format', 'data_access_catalog/1', 'packages', coalesce(jsonb_agg(jsonb_build_object(
        'code', p.package_code, 'name', p.name, 'system', p.system_code, 'period_field', p.period_field_code, 'resource', p.resource,
        'fields', (
            select coalesce(jsonb_agg(jsonb_build_object(
                'code', f.field_code, 'name', f.name, 'classification', f.classification, 'resource', f.resource
            ) order by f.field_code collate "C"), '[]'::jsonb)
            from pack_data_access.catalog_field as f
            where f.package_code = p.package_code and f.is_active
        ),
        'filters', pack_data_access.catalog_filter_snapshot(p.package_code)
    ) order by p.package_code collate "C"), '[]'::jsonb))
    from pack_data_access.catalog_package as p
    where p.is_active
$$;

-- 目前的版本：{version_no, sha256}；還沒有任何版本時是 null。
create function pack_data_access.catalog_current()
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('version_no', v.version_no, 'sha256', v.catalog_sha256)
    from pack_data_access.catalog_version as v
    order by v.version_no desc
    limit 1
$$;

-- 平台認得的版本（同一個雜湊可能出現在幾個版本：改回原樣時；取最新的那一個，快照相同）。
create function pack_data_access.catalog_version_of(p_sha256 text)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select max(v.version_no) from pack_data_access.catalog_version as v where v.catalog_sha256 = p_sha256
$$;

-- ── 引用摘要：一份內容在某個版本上引用到的部分（主題包、欄位與期間欄位、列條件、列舉值）──
-- 不存在的項目以 {code, missing: true} 表示；同一份內容在兩個版本上算出相同的摘要，代表這張單引用的部分沒有變。

create function pack_data_access.catalog_ref_package(p_pkg jsonb, p_item jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select (p_pkg - 'fields' - 'filters') || jsonb_build_object(
        'fields', (
            select coalesce(jsonb_agg(coalesce(
                (select f from jsonb_array_elements(p_pkg -> 'fields') as f where f ->> 'code' = c.code),
                jsonb_build_object('code', c.code, 'missing', true)
            ) order by c.code collate "C"), '[]'::jsonb)
            from (
                select distinct x.code from (
                    select coalesce(rf ->> 'code', rf #>> '{}') as code
                    from jsonb_array_elements(case when jsonb_typeof(p_item -> 'fields') = 'array' then p_item -> 'fields' else '[]' end) as rf
                    union all
                    select p_pkg ->> 'period_field'
                ) as x
                where x.code is not null
            ) as c
        ),
        'filters', (
            select coalesce(jsonb_agg(coalesce(
                (select (fd - 'values') || jsonb_build_object('values', (
                    select coalesce(jsonb_agg(coalesce(
                        (select v from jsonb_array_elements(fd -> 'values') as v where v ->> 'value' = rv.val),
                        jsonb_build_object('value', rv.val, 'missing', true)
                    ) order by rv.val collate "C"), '[]'::jsonb)
                    from (
                        select distinct vv #>> '{}' as val
                        from jsonb_array_elements(p_item -> 'row_filters') as rf2
                        cross join lateral jsonb_array_elements(
                            case when rf2 ->> 'filter' = fc.code and rf2 ->> 'op' = 'in' and jsonb_typeof(rf2 -> 'values') = 'array'
                                 then rf2 -> 'values' else '[]' end) as vv
                    ) as rv
                ))
                 from jsonb_array_elements(p_pkg -> 'filters') as fd where fd ->> 'code' = fc.code),
                jsonb_build_object('code', fc.code, 'missing', true)
            ) order by fc.code collate "C"), '[]'::jsonb)
            from (
                select distinct rf ->> 'filter' as code
                from jsonb_array_elements(case when jsonb_typeof(p_item -> 'row_filters') = 'array' then p_item -> 'row_filters' else '[]' end) as rf
                where rf ->> 'filter' is not null
            ) as fc
        )
    )
$$;

create function pack_data_access.catalog_ref(p_content jsonb, p_version_no int)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('packages', coalesce(jsonb_agg(coalesce(
        (select pack_data_access.catalog_ref_package(p, s.item)
         from pack_data_access.catalog_version as v
         cross join lateral jsonb_array_elements(v.snapshot -> 'packages') as p
         where v.version_no = p_version_no and p ->> 'code' = s.item ->> 'package'),
        jsonb_build_object('code', s.item ->> 'package', 'missing', true)
    ) order by s.item ->> 'package' collate "C"), '[]'::jsonb))
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'scope') = 'array' then p_content -> 'scope' else '[]' end) as s (item)
$$;

create function pack_data_access.catalog_ref_sha256(p_content jsonb, p_version_no int)
returns text
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select sgn_sdk.jcs_sha256(pack_data_access.catalog_ref(p_content, p_version_no))
$$;

-- 引用摘要去掉名稱與標籤：兩個版本只差在名稱時相同（只改名稱，D92 (6)）。
create function pack_data_access.catalog_ref_unnamed(p_ref jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object('packages', coalesce(jsonb_agg((p - 'name') || jsonb_build_object(
        'fields', (select coalesce(jsonb_agg(f - 'name'), '[]'::jsonb) from jsonb_array_elements(coalesce(p -> 'fields', '[]')) as f),
        'filters', (select coalesce(jsonb_agg((fl - 'name') || jsonb_build_object(
            'values', (select coalesce(jsonb_agg(v - 'label'), '[]'::jsonb) from jsonb_array_elements(coalesce(fl -> 'values', '[]')) as v)
        )), '[]'::jsonb) from jsonb_array_elements(coalesce(p -> 'filters', '[]')) as fl)
    )), '[]'::jsonb))
    from jsonb_array_elements(p_ref -> 'packages') as p
$$;

-- 名稱或標籤的變動（給資料擁有者看）：[{code, before, after}]。
create function pack_data_access.catalog_name_changes(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    with items as (
        select 'old' as side, p ->> 'code' as code, p ->> 'name' as name from jsonb_array_elements(p_old -> 'packages') as p
        union all
        select 'new', p ->> 'code', p ->> 'name' from jsonb_array_elements(p_new -> 'packages') as p
        union all
        select s.side, (p ->> 'code') || '.' || (f ->> 'code'), f ->> 'name'
        from (values ('old', p_old), ('new', p_new)) as s (side, ref)
        cross join lateral jsonb_array_elements(s.ref -> 'packages') as p
        cross join lateral jsonb_array_elements(coalesce(p -> 'fields', '[]') || coalesce(p -> 'filters', '[]')) as f
        union all
        select s.side, (p ->> 'code') || '.' || (fl ->> 'code') || '=' || (v ->> 'value'), v ->> 'label'
        from (values ('old', p_old), ('new', p_new)) as s (side, ref)
        cross join lateral jsonb_array_elements(s.ref -> 'packages') as p
        cross join lateral jsonb_array_elements(coalesce(p -> 'filters', '[]')) as fl
        cross join lateral jsonb_array_elements(coalesce(fl -> 'values', '[]')) as v
    )
    select coalesce(jsonb_agg(jsonb_build_object('code', o.code, 'before', o.name, 'after', n.name) order by o.code collate "C"), '[]'::jsonb)
    from items as o
    join items as n on n.code = o.code and n.side = 'new'
    where o.side = 'old' and o.name is distinct from n.name
$$;

-- ── 一張單比對用的版本：資料擁有者確認過的最新一版 → 內容綁定的那一版 → 舊單的事後基準 ──

create function pack_data_access.case_catalog_version(p_case_id uuid, p_content jsonb)
returns int
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(
        (select max(a.catalog_version_no) from pack_data_access.catalog_ack as a where a.case_id = p_case_id),
        (p_content #>> '{catalog,version_no}')::int,
        (select b.catalog_version_no from pack_data_access.catalog_baseline as b where b.case_id = p_case_id order by b.version desc limit 1)
    )
$$;

-- 這張單可以接受的版本：綁定（或事後基準）的那一版，加上資料擁有者確認過的每一版（只改名稱：兩者意義相同，
-- 使用方系統還沒換新版本或已經換了都接受）。
create function pack_data_access.case_catalog_versions(p_case_id uuid, p_content jsonb)
returns int[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select array(
        select x from (
            select (p_content #>> '{catalog,version_no}')::int as x
            union
            select b.catalog_version_no from pack_data_access.catalog_baseline as b where b.case_id = p_case_id
            union
            select a.catalog_version_no from pack_data_access.catalog_ack as a where a.case_id = p_case_id
        ) as v
        where x is not null
        order by x
    )
$$;

-- ── hook 的包裝：綁定、比較、顯示、交付 ──

create function pack_data_access.normalize_bound(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select r || jsonb_build_object('content', (r -> 'content') || jsonb_build_object('catalog', pack_data_access.catalog_current()))
    from (select pack_data_access.normalize_content(p_content) as r) as x
$$;

-- 綁定的目錄版本不是申請範圍的一部分：版本號不同不算擴大（引用的項目有沒有變，由目錄改版時處理）。
create function pack_data_access.compare_bound(p_old jsonb, p_new jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.compare_content(p_old - 'catalog', p_new - 'catalog')
$$;

-- 顯示摘要多一行「資料目錄第 N 版（雜湊前 12 碼）」（沒有綁定的舊內容不多這一行，舊的顯示摘要不變）。
create function pack_data_access.display_bound(p_content jsonb)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.display_content(p_content) || case
        when jsonb_typeof(p_content -> 'catalog') = 'object' then jsonb_build_object('catalog', jsonb_build_object(
            'version_no', p_content #>> '{catalog,version_no}',
            'sha256', p_content #>> '{catalog,sha256}',
            'text', sgn_sdk.message('DA-T-CATALOG-LINE', p_content #>> '{catalog,version_no}', left(p_content #>> '{catalog,sha256}', 12))
        ))
        else '{}'::jsonb
    end
$$;

-- 交給外部系統的規則帶綁定的目錄版本（舊單取事後基準）；找不到就不交付。
create function pack_data_access.fulfilment_bound(p_case_id uuid)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_content jsonb := sgn_sdk.case_context(p_case_id) -> 'content';
    v_no int := coalesce((v_content #>> '{catalog,version_no}')::int,
        (select b.catalog_version_no from pack_data_access.catalog_baseline as b where b.case_id = p_case_id order by b.version desc limit 1));
    v_sha text := (select v.catalog_sha256 from pack_data_access.catalog_version as v where v.version_no = v_no);
begin
    if v_sha is null then
        perform sgn_sdk.raise_error('DA-E-CATALOG-VERSION-MISSING', p_case_id::text);
    end if;
    return pack_data_access.build_fulfilment(p_case_id) || jsonb_build_object('catalog', jsonb_build_object('version_no', v_no, 'sha256', v_sha));
end;
$$;

-- 交給某一組受管系統的規則（同 110 的簽章）：改用帶目錄版本的那一份。
create or replace function pack_data_access.build_delivery(p_case_id uuid, p_scopes text[])
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select case when jsonb_array_length(k.rules) = 0 then null else f.rs || jsonb_build_object('rules', k.rules) end
    from (select pack_data_access.fulfilment_bound(p_case_id) as rs) as f
    cross join lateral (
        select coalesce(jsonb_agg(r.rule order by r.n), '[]'::jsonb) as rules
        from jsonb_array_elements(f.rs -> 'rules') with ordinality as r (rule, n)
        where 'system:' || (r.rule ->> 'system') = any (p_scopes)
    ) as k
$$;

-- ── 使用方系統的回報（DA-CATALOG-MISMATCH、DA-CATALOG-UNKNOWN）──

-- 回報的版本和這張單比對用的版本，在引用的部分是否相同。p_bound：比對用的版本號（可以有幾個：綁定的與確認過的）。
create function pack_data_access.catalog_ref_matches(p_content jsonb, p_bound int[], p_reported int)
returns boolean
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select exists (
        select 1 from unnest(p_bound) as b
        where b is not null
          and pack_data_access.catalog_ref_sha256(p_content, b) = pack_data_access.catalog_ref_sha256(p_content, p_reported)
    )
$$;

-- 核心的 check_delivery_result：套用與驗證的回應裡，使用方系統當時用的目錄版本。
create function pack_data_access.check_delivery_result(p_case_id uuid, p_context jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
declare
    v_reported text := p_context #>> '{result,catalog_sha256}';
    v_reported_no int := pack_data_access.catalog_version_of(v_reported);
    v_sent int := (p_context #>> '{rule_set,catalog,version_no}')::int;
    v_content jsonb := sgn_sdk.case_context(p_case_id) -> 'content';
    v_grace int := (sgn_sdk.setting('data_access.catalog_unknown_grace_minutes', array['channel:' || (p_context ->> 'channel')]) #>> '{}')::int;
    v_detail jsonb := jsonb_build_object('reported_sha256', v_reported, 'sent', p_context #> '{rule_set,catalog}',
        'settings', jsonb_build_object('data_access.catalog_unknown_grace_minutes', v_grace));
begin
    if v_reported_no is null then
        if extract(epoch from sgn_sdk.now() - (p_context ->> 'created_at')::timestamptz) < v_grace * 60 then
            return v_detail || jsonb_build_object('action', 'retry', 'reason', 'DA-CATALOG-UNKNOWN');
        end if;
        return v_detail || jsonb_build_object('rule_code', 'DA-CATALOG-UNKNOWN', 'reason', 'DA-CATALOG-UNKNOWN');
    end if;
    if pack_data_access.catalog_ref_matches(v_content, v_sent || pack_data_access.case_catalog_versions(p_case_id, v_content), v_reported_no) then
        return null;
    end if;
    return v_detail || jsonb_build_object('rule_code', 'DA-CATALOG-MISMATCH', 'reason', 'DA-CATALOG-MISMATCH', 'reported_version_no', v_reported_no);
end;
$$;

-- 核心的 check_reconciliation_report：對帳回報裡使用方系統的目錄版本。不認得的版本超過寬限開一筆（每個通道一筆）；
-- 認得的版本逐張比對該有權限的單。
create function pack_data_access.check_reconciliation_report(p_channel text, p_report jsonb, p_case_ids uuid[])
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_reported text := p_report ->> 'catalog_sha256';
    v_reported_no int := pack_data_access.catalog_version_of(v_reported);
    v_grace int := (sgn_sdk.setting('data_access.catalog_unknown_grace_minutes', array['channel:' || p_channel]) #>> '{}')::int;
    v_seen timestamptz;
begin
    if v_reported_no is null then
        insert into pack_data_access.catalog_unknown_seen (channel, catalog_sha256, first_seen)
        values (p_channel, coalesce(v_reported, ''), sgn_sdk.now())
        on conflict do nothing;
        select s.first_seen into v_seen from pack_data_access.catalog_unknown_seen as s
        where s.channel = p_channel and s.catalog_sha256 = coalesce(v_reported, '');
        if extract(epoch from sgn_sdk.now() - v_seen) < v_grace * 60 then
            return '[]'::jsonb;
        end if;
        return jsonb_build_array(jsonb_build_object('rule_code', 'DA-CATALOG-UNKNOWN', 'case_id', null, 'detail', jsonb_build_object(
            'reported_sha256', v_reported, 'first_seen', v_seen,
            'settings', jsonb_build_object('data_access.catalog_unknown_grace_minutes', v_grace))));
    end if;
    return (
        select coalesce(jsonb_agg(jsonb_build_object('rule_code', 'DA-CATALOG-MISMATCH', 'case_id', c.case_id, 'detail', jsonb_build_object(
            'reported_sha256', v_reported, 'reported_version_no', v_reported_no,
            'bound_version_no', pack_data_access.case_catalog_version(c.case_id, c.content))) order by c.case_no), '[]'::jsonb)
        from sgn_sdk.cases_in_states('data_access', array['pending_fulfilment', 'verifying', 'active', 'expired', 'revoked']) as c
        where c.case_id = any (p_case_ids)
          and not pack_data_access.catalog_ref_matches(c.content, pack_data_access.case_catalog_versions(c.case_id, c.content), v_reported_no)
    );
end;
$$;

-- ── 目錄改版（DA-CATALOG-DRIFT）──

-- 受影響主題包目前的資料擁有者。
create function pack_data_access.content_owners(p_content jsonb)
returns uuid[]
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(array_agg(distinct o order by o), '{}')
    from jsonb_array_elements(case when jsonb_typeof(p_content -> 'scope') = 'array' then p_content -> 'scope' else '[]' end) as s
    cross join lateral unnest(sgn_sdk.role_holders('data_owner', pack_data_access.owner_scope(s ->> 'package'))) as o
$$;

-- 已核准的單（待套用、驗證中、生效中）的引用部分變了：開例外並通知資料擁有者。只改名稱時給確認期限（逾期由核心升級）。
create function pack_data_access.catalog_drift_open(p_case_id uuid, p_case_no bigint, p_state text, p_content jsonb, p_from int, p_to int)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_old jsonb := pack_data_access.catalog_ref(p_content, p_from);
    v_new jsonb := pack_data_access.catalog_ref(p_content, p_to);
    v_rename boolean := pack_data_access.catalog_ref_unnamed(v_old) = pack_data_access.catalog_ref_unnamed(v_new);
    v_owners uuid[] := pack_data_access.content_owners(p_content);
    v_tier text := sgn_sdk.case_context(p_case_id) ->> 'tier';
    v_days int := (sgn_sdk.setting('data_access.catalog_rename_confirm_workdays', array['tier:data_access:' || v_tier]) #>> '{}')::int;
    v_detail jsonb := jsonb_build_object(
        'kind', case when v_rename then 'rename_only' else 'changed' end, 'from_version_no', p_from, 'to_version_no', p_to,
        'state', p_state, 'owners', to_jsonb(v_owners),
        'packages', (select coalesce(jsonb_agg(s ->> 'package' order by s ->> 'package'), '[]'::jsonb) from jsonb_array_elements(p_content -> 'scope') as s),
        'changes', pack_data_access.catalog_name_changes(v_old, v_new),
        'rules', jsonb_build_array('DA-CATALOG-DRIFT') || case when v_rename then '["DA-CATALOG-RENAME-CONFIRM"]'::jsonb else '[]'::jsonb end);
begin
    if v_rename then
        perform sgn_sdk.exception_open_due('DA-CATALOG-DRIFT', p_case_id,
            v_detail || jsonb_build_object('settings', jsonb_build_object('data_access.catalog_rename_confirm_workdays', v_days)),
            sgn_sdk.add_workdays(sgn_sdk.now(), v_days), v_owners);
    else
        perform sgn_sdk.exception_open('DA-CATALOG-DRIFT', p_case_id, v_detail);
    end if;
    perform sgn_sdk.notify('data_access.catalog_drift', v_owners, p_case_id, jsonb_build_object(
        'case_no', p_case_no::text, 'from', p_from::text, 'to', p_to::text,
        'what', sgn_sdk.message(case when v_rename then 'DA-T-DRIFT-RENAME' else 'DA-T-DRIFT-CHANGED' end)));
end;
$$;

-- 新版本產生的同一個交易內：逐張比較引用摘要，相同就不動。簽核中的重新綁定（從第一關重簽），已核准的開例外。
-- 草稿與退回的單不動（下次儲存或送審時重新整理並綁新版本）。回傳 {rebound, exceptions}。
create function pack_data_access.catalog_drift(p_to int)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case record;
    v_from int;
    v_rebound int := 0;
    v_opened int := 0;
begin
    for v_case in select * from sgn_sdk.cases_in_states('data_access', array['in_approval', 'pending_fulfilment', 'verifying', 'active']) loop
        v_from := pack_data_access.case_catalog_version(v_case.case_id, v_case.content);
        continue when v_from is null or v_from = p_to
            or pack_data_access.catalog_ref_sha256(v_case.content, v_from) = pack_data_access.catalog_ref_sha256(v_case.content, p_to);
        if v_case.state = 'in_approval' then
            perform sgn_sdk.case_rebind(v_case.case_id, 'DA-CATALOG-DRIFT', jsonb_build_object('from_version_no', v_from, 'to_version_no', p_to));
            v_rebound := v_rebound + 1;
        else
            perform pack_data_access.catalog_drift_open(v_case.case_id, v_case.case_no, v_case.state, v_case.content, v_from, p_to);
            v_opened := v_opened + 1;
        end if;
    end loop;
    return jsonb_build_object('rebound', v_rebound, 'exceptions', v_opened);
end;
$$;

-- 目前的目錄與最新版本不同才產生新版本（進鏈），再處理受影響的單。目錄是空的（還沒載入）不產生。回傳目前版本與處理結果。
create function pack_data_access.catalog_record(p_source text)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_snapshot jsonb := pack_data_access.catalog_snapshot();
    v_sha text := sgn_sdk.jcs_sha256(v_snapshot);
    v_current jsonb := pack_data_access.catalog_current();
    v_no int := coalesce((v_current ->> 'version_no')::int, 0) + 1;
    v_seq bigint;
begin
    if jsonb_array_length(v_snapshot -> 'packages') = 0 or v_current ->> 'sha256' = v_sha then
        return jsonb_build_object('version', v_current, 'changed', false);
    end if;
    v_seq := sgn_sdk.audit_append('data_access.catalog_versioned', null, null, jsonb_build_object(
        'version_no', v_no, 'catalog_sha256', v_sha, 'previous', v_current, 'source', p_source,
        'packages', jsonb_array_length(v_snapshot -> 'packages'), 'rules', jsonb_build_array('DA-CATALOG-VERSION')));
    insert into pack_data_access.catalog_version (version_no, catalog_sha256, snapshot, source, created_at, event_seq)
    values (v_no, v_sha, v_snapshot, p_source, sgn_sdk.now(), v_seq);
    return jsonb_build_object('version', pack_data_access.catalog_current(), 'changed', true, 'drift', pack_data_access.catalog_drift(v_no));
end;
$$;

-- 載入一份完整的目錄快照（同 010 的簽章）：多了實體資源的對照，套用後產生版本。
create or replace function pack_data_access.catalog_load(p_snapshot jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_pkg jsonb;
    v_item jsonb;
    v_val jsonb;
    v_pos int;
    v_vpos int;
    v_value_pos int;
    v_owners jsonb := '[]'::jsonb;
    v_owner uuid;
    v_sync jsonb;
begin
    update pack_data_access.catalog_package set is_active = false;
    update pack_data_access.catalog_field set is_active = false;
    update pack_data_access.catalog_filter set is_active = false;
    update pack_data_access.catalog_filter_value set is_active = false;
    for v_pkg, v_pos in select e, o::int from jsonb_array_elements(p_snapshot -> 'packages') with ordinality as x (e, o) loop
        insert into pack_data_access.catalog_package (package_code, name, system_code, period_field_code, sort_order, is_active, resource)
        values (v_pkg ->> 'code', v_pkg ->> 'name', v_pkg ->> 'system', v_pkg ->> 'period_field', v_pos, true, v_pkg ->> 'resource')
        on conflict (package_code) do update
        set name = excluded.name, system_code = excluded.system_code, period_field_code = excluded.period_field_code,
            sort_order = excluded.sort_order, is_active = true, resource = excluded.resource;
        for v_item, v_vpos in select e, o::int from jsonb_array_elements(v_pkg -> 'fields') with ordinality as x (e, o) loop
            insert into pack_data_access.catalog_field (package_code, field_code, name, classification, sort_order, is_active, resource)
            values (v_pkg ->> 'code', v_item ->> 'code', v_item ->> 'name', v_item ->> 'classification', v_vpos, true, v_item ->> 'resource')
            on conflict (package_code, field_code) do update
            set name = excluded.name, classification = excluded.classification, sort_order = excluded.sort_order, is_active = true,
                resource = excluded.resource;
        end loop;
        for v_item, v_vpos in select e, o::int from jsonb_array_elements(coalesce(v_pkg -> 'filters', '[]'::jsonb)) with ordinality as x (e, o) loop
            insert into pack_data_access.catalog_filter (package_code, filter_code, name, value_type, sort_order, is_active, resource)
            values (v_pkg ->> 'code', v_item ->> 'code', v_item ->> 'name', v_item ->> 'value_type', v_vpos, true, v_item ->> 'resource')
            on conflict (package_code, filter_code) do update
            set name = excluded.name, value_type = excluded.value_type, sort_order = excluded.sort_order, is_active = true,
                resource = excluded.resource;
            for v_val, v_value_pos in select e, o::int from jsonb_array_elements(coalesce(v_item -> 'values', '[]'::jsonb)) with ordinality as y (e, o) loop
                insert into pack_data_access.catalog_filter_value (package_code, filter_code, value, label, sort_order, is_active)
                values (v_pkg ->> 'code', v_item ->> 'code', v_val ->> 'value', v_val ->> 'label', v_value_pos, true)
                on conflict (package_code, filter_code, value) do update
                set label = excluded.label, sort_order = excluded.sort_order, is_active = true;
            end loop;
        end loop;
        v_owner := sgn_sdk.person_by_identity(v_pkg #>> '{owner,provider}', v_pkg #>> '{owner,external_id}');
        if v_owner is not null then
            v_owners := v_owners || jsonb_build_object('scope_ref', pack_data_access.owner_scope(v_pkg ->> 'code'), 'person_id', v_owner);
        end if;
    end loop;
    v_sync := sgn_sdk.sync_scoped_role_assignments('data_access.catalog', 'data_owner', v_owners);
    return v_sync || jsonb_build_object('catalog', pack_data_access.catalog_record('catalog_load'));
end;
$$;

-- ── 資料擁有者確認「只改名稱」（DA-CATALOG-RENAME-CONFIRM）──

-- 等這個人確認的目錄異動：他是受影響主題包目前的資料擁有者、只改名稱、還沒結案。
create function pack_data_access.catalog_pending_for(p_person uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'exception_id', x.id,
        'case_id', x.case_id,
        'case_no', (sgn_sdk.case_context(x.case_id) ->> 'case_no')::bigint,
        'from_version_no', (x.detail ->> 'from_version_no')::int,
        'to_version_no', (x.detail ->> 'to_version_no')::int,
        'due_at', (x.detail ->> 'due_at')::timestamptz,
        'packages', (select coalesce(jsonb_agg(pack_data_access.package_label(p #>> '{}') order by p #>> '{}'), '[]'::jsonb)
                     from jsonb_array_elements(x.detail -> 'packages') as p),
        'changes', x.detail -> 'changes'
    ) order by x.id), '[]'::jsonb)
    from sgn_sdk.exceptions_open('DA-CATALOG-DRIFT') as x
    where x.detail ->> 'kind' = 'rename_only'
      and p_person = any (pack_data_access.content_owners(sgn_sdk.case_context(x.case_id) -> 'content'))
$$;

create function api.data_access_catalog_pending(p_session text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
    select pack_data_access.catalog_pending_for(sgn_sdk.session_person(p_session))
$$;

comment on function api.data_access_catalog_pending(text) is
    '等看的人確認的資料目錄異動：生效中（或待套用、驗證中）的單引用的主題包、欄位或列條件只改了名稱，'
    '看的人是受影響主題包目前的資料擁有者。每項帶期限與改了哪些名稱。呼叫者：sgn_app。規則：DA-CATALOG-DRIFT、DA-CATALOG-RENAME-CONFIRM';

create function api.data_access_catalog_confirm(p_session text, p_exception_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
    v_person uuid := sgn_sdk.session_person(p_session);
    v_row record;
begin
    select * into v_row from sgn_sdk.exceptions_open('DA-CATALOG-DRIFT') as x
    where x.id = p_exception_id and x.detail ->> 'kind' = 'rename_only';
    if v_row.id is null then
        perform sgn_sdk.raise_error('DA-E-CATALOG-CONFIRM-UNKNOWN', p_exception_id::text);
    end if;
    if not v_person = any (pack_data_access.content_owners(sgn_sdk.case_context(v_row.case_id) -> 'content')) then
        perform sgn_sdk.raise_error('DA-E-CATALOG-CONFIRM-DENIED', p_exception_id::text);
    end if;
    insert into pack_data_access.catalog_ack (case_id, catalog_version_no, exception_id, confirmed_by, confirmed_at)
    values (v_row.case_id, (v_row.detail ->> 'to_version_no')::int, v_row.id, v_person, sgn_sdk.now());
    perform sgn_sdk.audit_append('data_access.catalog_rename_confirmed', v_row.case_id, v_person, jsonb_build_object(
        'exception', v_row.id, 'from_version_no', v_row.detail -> 'from_version_no', 'to_version_no', v_row.detail -> 'to_version_no',
        'changes', v_row.detail -> 'changes', 'rules', jsonb_build_array('DA-CATALOG-RENAME-CONFIRM')));
    perform sgn_sdk.exception_close(v_row.id, jsonb_build_object('resolved', 'owner_confirmed', 'person', v_person,
        'rules', jsonb_build_array('DA-CATALOG-RENAME-CONFIRM')));
    return pack_data_access.catalog_pending_for(v_person);
end;
$$;

comment on function api.data_access_catalog_confirm(text, bigint) is
    '使用者動作「確認目錄只改名稱」：受影響主題包目前的資料擁有者確認生效中的單意義沒有改變；之後這張單以新的目錄版本比對，'
    '不必重送規則。確認進稽核鏈並結案。回傳看的人還要確認的項目。呼叫者：sgn_app。規則：DA-CATALOG-RENAME-CONFIRM';

-- ── 舊單的事後基準與第一個版本 ──

-- 升版時：目錄已有內容就先產生版本；未結束、沒有綁定的單記下基準（不在簽核內容內，只用來偵測之後的異動）。
select pack_data_access.catalog_record('migration 130_catalog_version');

with baselined as (
    insert into pack_data_access.catalog_baseline (case_id, version, catalog_version_no, recorded_at)
    select c.case_id, c.version, (pack_data_access.catalog_current() ->> 'version_no')::int, sgn_sdk.now()
    from sgn_sdk.cases_in_states('data_access', array['draft', 'returned', 'in_approval', 'pending_fulfilment', 'verifying', 'active']) as c
    where c.content -> 'catalog' is null and pack_data_access.catalog_current() is not null
    returning case_id, version, catalog_version_no
)
select sgn_sdk.audit_append('data_access.catalog_baselined', b.case_id, null, jsonb_build_object(
    'version', b.version, 'catalog_version_no', b.catalog_version_no, 'basis', 'baseline', 'rules', jsonb_build_array('DA-CATALOG-BOUND')))
from baselined as b;

-- ── 登記 ──

select sgn_sdk.register_hook('data_access', h.hook, h.fn)
from (values
    ('normalize_content', 'pack_data_access.normalize_bound'),
    ('compare_content', 'pack_data_access.compare_bound'),
    ('display_content', 'pack_data_access.display_bound'),
    ('build_fulfilment', 'pack_data_access.fulfilment_bound'),
    ('check_delivery_result', 'pack_data_access.check_delivery_result'),
    ('check_reconciliation_report', 'pack_data_access.check_reconciliation_report')
) as h (hook, fn);

select sgn_sdk.register_message(m.code, 'notice', m.message)
from (values
    ('DA-T-DRIFT-RENAME', '只改了名稱：請在期限內確認意義沒有改變（逾期會升級，不會撤銷）'),
    ('DA-T-DRIFT-CHANGED', '對照或分級有變：使用方系統實際擋的可能和簽核人看到的不同，請處理')
) as m (code, message);

select sgn_sdk.register_notification_template('data_access.catalog_drift', '資料目錄異動影響已核准的單：{{case_no}}',
    '資料目錄從第 {{from}} 版改為第 {{to}} 版，{{case_no}} 引用的項目有變。{{what}}');

select sgn_sdk.register_rule(r.code, r.description, 'data_access', r.coverage, r.note)
from (values
    ('DA-CATALOG-VERSION', '資料目錄由平台維護，任何異動產生新版本（序號＋內容雜湊，涵蓋主題包、欄位、分級、列條件與代碼到實體資源的對照），只增不改',
        'full', null),
    ('DA-CATALOG-BOUND', '每個內容版本綁定整理當下的目錄版本，進入版本雜湊與顯示摘要（簽核人簽的內容包含它）；交付的規則帶出它；'
        '舊單的已存雜湊不重算，未結束的記事後基準', 'full', null),
    ('DA-CATALOG-MISMATCH', '使用方系統回報的目錄版本在這張單引用的部分和綁定的版本不同：不生效、撤回已送出的部分、開例外；對帳回報同樣比對',
        'full', null),
    ('DA-CATALOG-UNKNOWN', '使用方系統回報平台不認得的目錄版本：寬限時間內重送，逾時開例外（對帳時每個通道一筆）', 'partial',
        '不會觸發目錄同步（平台維護目錄，沒有從使用方同步的入口）'),
    ('DA-CATALOG-DRIFT', '目錄改版影響到單引用的部分：簽核中的重新綁定並從第一關重簽；待套用、驗證中、生效中的開例外並通知資料擁有者',
        'partial', '分級調高時的重新核准（K-REAPPROVE）、項目停用時由系統縮小沒有做，只開例外'),
    ('DA-CATALOG-RENAME-CONFIRM', '目錄只改名稱時，資料擁有者在參數的工作天內確認已核准的單意義沒變（進鏈）；逾期升級，不撤銷', 'full', null)
) as r (code, description, coverage, note);

revoke all on all functions in schema pack_data_access from public;
