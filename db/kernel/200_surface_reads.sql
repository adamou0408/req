-- 畫面需要、但前一版介面沒有提供的兩項讀取（docs/handoff/flow-surface.md §5）。只新增，不改既有檔案：
--   1. 新申請畫面要「即時顯示會經過哪些關卡」：流程類型的每個級別附上目前路徑的關卡（路徑是資料，畫面不自己推）。
--   2. 申請單詳情要「與前一版的差異」：版本歷程附上每一版的內容與 terms（差異由畫面比對兩份內容，判定縮小或擴大仍由資料庫做）。

-- 某級別在目前路徑上會經過的關卡（依順序）。沒有路徑時回傳空陣列（新申請畫面照樣能開，送審時才回 POLICY_MISSING）。
create function sgn_internal.policy_path(p_process_type text, p_tier text)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'seq', ps.seq,
        'code', ps.code,
        'name', ps.name,
        'phase', ps.phase,
        'mode', ps.mode
    ) order by ps.seq), '[]'::jsonb)
    from sgn.policy_stage as ps
    where ps.policy_id = (
        select p.id
        from sgn.approval_policy as p
        where p.process_type = p_process_type
          and p.effective_from <= sgn_internal.now()
        order by p.version desc
        limit 1
    )
      and sgn_internal.stage_applies(ps, p_tier)
$$;

create or replace function api.process_type_list(p_session text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_internal.session_person(p_session);
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'code', t.code,
            'name', t.name,
            'options', t.options,
            'tiers', (
                select jsonb_agg(jsonb_build_object(
                    'code', r.tier_code,
                    'name', r.name,
                    'stages', sgn_internal.policy_path(t.code, r.tier_code)
                ) order by r.sort_order)
                from sgn.process_tier as r
                where r.process_type = t.code
            )
        ) order by t.code)
        from sgn.process_type as t
    ), '[]'::jsonb);
end;
$$;

comment on function api.process_type_list(text) is
    '可以申請的流程類型與級別、選項（是否要選被授權者、填授權起迄），以及每個級別在目前路徑上會經過的關卡。'
    '新申請畫面用。呼叫者：sgn_app。規則：K-RESOLVE-STAGE-START（路徑是資料）';

create or replace function sgn_internal.case_versions_view(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
        'version', v.version,
        'change_kind', v.change_kind,
        'tier', v.tier,
        'created_by_name', sgn_internal.person_name(v.created_by),
        'created_at', v.created_at,
        'content_sha256', encode(v.content_sha256, 'hex'),
        'version_sha256', encode(v.version_sha256, 'hex'),
        'content', v.content,
        'terms', sgn_internal.case_terms_view(v.terms)
    ) order by v.version), '[]'::jsonb)
    from sgn.case_version as v
    where v.case_id = p_case_id
$$;
