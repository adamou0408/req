-- 裁決 D86 (4)：移除合併角色 sgn_job（建置不再建立它，db/build.sh；架構測試 12 斷言它不存在）。
-- 已套用的 migration 不改，所以之前的 COMMENT ON FUNCTION 還寫著「呼叫者：sgn_job」。這裡改寫成不指名角色的說法：
-- 每個 api_job function 由哪個程式角色執行，唯一來源是路由表的四張允許清單（packages/contract/src/routes.ts），
-- 註解再寫一次角色名就是第二份。架構測試 12 檢查沒有任何 function 的註解還提到 sgn_job。

do $$
declare
    v_fn regprocedure;
begin
    for v_fn in
        select p.oid::regprocedure
        from pg_proc as p
        join pg_namespace as n on n.oid = p.pronamespace
        where n.nspname not like 'pg\_%'
          and n.nspname <> 'information_schema'
          and obj_description(p.oid, 'pg_proc') like '%sgn\_job%'
    loop
        execute format(
            'comment on function %s is %L',
            v_fn,
            replace(obj_description(v_fn, 'pg_proc'), 'sgn_job', '程式自己的資料庫角色')
        );
    end loop;
end;
$$;
