-- plpgsql_check：逐一檢查自家 schema 的每個 PL/pgSQL function（不存在的欄位、型別不符、沒用到的變數、漏掉的 return）。
-- trigger function 要配上它掛的資料表才能檢查。沒有輸出＝沒有問題。由 db/build.sh --plpgsql-check 執行。
select p.oid::regprocedure::text
    || ' 第 ' || coalesce(r.lineno::text, '?') || ' 行 '
    || r.level || ': ' || r.message
    || coalesce(' (' || r.detail || ')', '')
from pg_proc as p
join pg_language as l on l.oid = p.prolang and l.lanname = 'plpgsql'
left join lateral (
    select t.tgrelid from pg_trigger as t where t.tgfoid = p.oid limit 1
) as trg on true
cross join lateral plpgsql_check.plpgsql_check_function_tb(
    p.oid,
    coalesce(trg.tgrelid, 0),
    extra_warnings => true
) as r
where p.pronamespace::regnamespace::text in ('sgn_internal', 'sgn_sdk', 'api', 'api_sync', 'api_job', 'api_delivery', 'api_verified')
   or p.pronamespace::regnamespace::text like 'pack\_%'
order by 1;
