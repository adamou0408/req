-- 送審時的流程包複核與授權紀錄的讀取（閉環第二批；交接 docs/handoff/closed-loop-2.md）。
--
-- 1. 送審複核（K-SUBMIT-REVIEW）：整理內容的 hook 看不到「這是誰的哪一張單」，有些送審前的檢查要同時看內容、申請人、被授權者
--    與授權起迄（例如：引用的另一張單是不是同一位申請人或同一個被授權者的、依內容決定的期限上限）。核心在送審的那一刻呼叫流程包的
--    review_submission(case_id, content)：回傳 {errors, exceptions, settings}。有錯誤就和整理內容的錯誤一樣擋下送審（CONTENT_INVALID）；
--    沒有錯誤時，送審成功之後由核心開每一筆要求的例外（同一張單、同一規則代碼還沒結案的不重開），參數值記進送審的稽核事件。
--    核心不解讀內容，也不知道流程包為什麼要開例外。
-- 2. 授權紀錄（sgn_sdk.case_grant）：流程包判斷「另一張單曾經生效過沒有、生效期間是哪一段」時用，不直接讀核心的表。

insert into sgn.hook_definition (hook, arg_types, result_type, returns_set, description) values
    ('review_submission', 'uuid, jsonb', 'jsonb', false,
        '送審的那一刻再複核（可以讀這張單的申請人、被授權者、授權起迄）。回傳 {errors: [{path, code, message}], '
        'exceptions: [{rule_code, detail}], settings: {}}。有錯誤就擋下送審；沒有錯誤時核心在送審後開每一筆例外。沒有登記：沒有問題');

create function sgn_internal.hook_review_submission(p_process_type text, p_case_id uuid, p_content jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_fn text := sgn_internal.hook_fn(p_process_type, 'review_submission');
    v_result jsonb;
begin
    if v_fn is null then
        return jsonb_build_object('errors', '[]'::jsonb, 'exceptions', '[]'::jsonb, 'settings', '{}'::jsonb);
    end if;
    execute format('select %s($1, $2)', v_fn::regprocedure::regproc) into v_result using p_case_id, p_content;
    return jsonb_build_object(
        'errors', coalesce(v_result -> 'errors', '[]'::jsonb),
        'exceptions', coalesce(v_result -> 'exceptions', '[]'::jsonb),
        'settings', coalesce(v_result -> 'settings', '{}'::jsonb)
    );
end;
$$;

-- 流程包要求的例外：同一張單、同一規則代碼還沒結案就不重開（退回後重送不會多開一筆）。回傳開了哪幾筆。
create function sgn_internal.case_review_exceptions(p_case_id uuid, p_exceptions jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_item jsonb;
    v_opened jsonb := '[]'::jsonb;
begin
    for v_item in select x from jsonb_array_elements(p_exceptions) as x loop
        continue when exists (
            select 1 from sgn.exception_record as r
            where r.case_id = p_case_id and r.rule_code = v_item ->> 'rule_code' and r.closed_at is null
        );
        v_opened := v_opened || to_jsonb(sgn_internal.exception_open(v_item ->> 'rule_code', p_case_id, coalesce(v_item -> 'detail', '{}'::jsonb)));
    end loop;
    return v_opened;
end;
$$;

-- 送審（同 160 的簽章）：多了流程包的送審複核。
create or replace function sgn_internal.case_submit_draft(p_person_id uuid, p_case_id uuid, p_overlap_reason text)
returns void
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
declare
    v_case sgn.request_case := sgn_internal.case_lock(p_case_id);
    v_version sgn.case_version;
    v_errors jsonb;
    v_review jsonb;
    v_overlap jsonb;
    v_mode jsonb;
begin
    perform sgn_internal.authorize(p_person_id, 'submit', v_case);
    select * into v_version from sgn.case_version where case_id = p_case_id and version = v_case.current_version;
    v_errors := v_version.errors || sgn_internal.terms_errors(v_case.process_type, v_version.terms, v_version.tier);
    -- 流程包的複核只在內容本身沒錯時才有意義（例如引用的單要和整理好的範圍比）
    if jsonb_array_length(v_errors) = 0 then
        v_review := sgn_internal.hook_review_submission(v_case.process_type, p_case_id, v_version.content);
        v_errors := v_review -> 'errors';
    end if;
    if jsonb_array_length(v_errors) > 0 then
        perform sgn_internal.raise_error('CONTENT_INVALID', v_errors::text);
    end if;
    v_overlap := sgn_internal.case_overlap_check(v_case, v_version.content, p_overlap_reason);
    v_mode := sgn_internal.case_resume_mode(v_case);
    if v_mode ->> 'mode' <> 'resume' then
        update sgn.case_stage set status = 'cancelled', close_reason = 'restart'
        where case_id = p_case_id and status in ('done', 'returned');
        update sgn.request_case set policy_id = (sgn_internal.policy_latest(v_case.process_type)).id where id = p_case_id;
    end if;
    update sgn.request_case set resume_seq = null, returned_version = null where id = p_case_id;
    perform sgn_internal.case_transition(p_case_id, 'submit');
    perform sgn_internal.audit_append(
        'case.submitted', p_case_id, p_person_id,
        jsonb_build_object(
            'version', v_case.current_version,
            'content_sha256', encode(v_version.content_sha256, 'hex'),
            'version_sha256', encode(v_version.version_sha256, 'hex'),
            'tier', v_version.tier,
            'policy_version', (select p.version from sgn.approval_policy as p join sgn.request_case as c on c.policy_id = p.id where c.id = p_case_id),
            'path', v_mode,
            'overlap', v_overlap,
            'review', jsonb_build_object('exceptions', v_review -> 'exceptions'),
            'settings', jsonb_build_object(
                'validity.max_months',
                sgn_internal.setting('validity.max_months', sgn_internal.validity_scopes(v_case.process_type, v_version.tier))
            ) || (v_review -> 'settings'),
            'rules', jsonb_build_array('K-VALIDITY-MAX', 'K-NO-BACKDATE', 'K-PRINCIPAL', 'K-OVERLAP-BLOCK', 'K-OVERLAP-REASON', 'K-RETURN',
                'K-SUBMIT-REVIEW')
        )
    );
    perform sgn_internal.case_review_exceptions(p_case_id, v_review -> 'exceptions');
    perform sgn_internal.case_advance(p_case_id);
end;
$$;

-- ── 授權紀錄 ──

-- 一張單的授權：{status, principal_id, valid_from, valid_to, created_at, ended_at}；從來沒有生效過是 null。
create function sgn_sdk.case_grant(p_case_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, pg_temp
as $$
    select jsonb_build_object(
        'status', g.status, 'principal_id', g.principal_id, 'valid_from', g.valid_from, 'valid_to', g.valid_to,
        'created_at', g.created_at, 'ended_at', g.ended_at)
    from sgn.grant_record as g
    where g.case_id = p_case_id
$$;

select sgn_internal.register_rule(r.code, r.description, null, 'full', null)
from (values
    ('K-SUBMIT-REVIEW', '送審的那一刻由流程包複核（可以看申請人、被授權者與授權起迄）：有錯就擋下送審；流程包要求的例外在送審後開，同一張單同一規則未結案不重開')
) as r (code, description);
