-- 權限。:"owner" 等變數由 db/build.sh 以 psql -v 傳入。
-- 原則：每個登入角色只對「自己的」schema 有 USAGE 與 EXECUTE，對任何資料表都沒有權限（骨幹 1.1）。

revoke all on schema public from public;
revoke all on all functions in schema sgn_internal, api, api_sync, api_job from public;
-- pgcrypto 的 function 屬於 superuser；撤掉 PUBLIC 之後要明確給 owner（SECURITY DEFINER 以 owner 身分執行）。
grant execute on all functions in schema sgn_internal to :"owner";

grant usage on schema api to :"app";
grant execute on all functions in schema api to :"app";

grant usage on schema api_sync to :"sync";
grant execute on all functions in schema api_sync to :"sync";

grant usage on schema api_job to :"job";
grant execute on all functions in schema api_job to :"job";
