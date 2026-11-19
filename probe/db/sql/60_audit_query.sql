-- 稽核唯讀查詢（PRB-AUDIT-READ）。function 是 STABLE：在 PostgreSQL 裡 STABLE function 內做寫入會被拒絕，
-- 所以「唯讀」是由資料庫保證，不是靠寫程式的人小心。

create function api.audit_events(p_session text, p_case_id uuid)
returns table (
    seq bigint,
    occurred_at timestamptz,
    event_type text,
    case_id uuid,
    actor_person_id uuid,
    actor_name text,
    data jsonb,
    hash text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
    if not sgn_internal.has_role(sgn_internal.session_person(p_session), sgn_internal.setting_text('audit.auditor_role')) then
        perform sgn_internal.raise_error('AUDITOR_REQUIRED');
    end if;
    return query
    select e.seq, e.occurred_at, e.event_type, e.case_id, e.actor_person_id, p.display_name,
           convert_from(e.body, 'UTF8')::jsonb -> 'data', encode(e.hash, 'hex')
    from sgn.audit_event e
    left join sgn.person p on p.id = e.actor_person_id
    where p_case_id is null or e.case_id = p_case_id
    order by e.seq;
end;
$$;

comment on function api.audit_events(text, uuid) is
    '稽核人員查詢稽核事件（可依申請單篩選），附每筆的鏈雜湊。只限稽核角色，唯讀。呼叫者：sgn_probe_app。規則：PRB-AUDIT-READ';
