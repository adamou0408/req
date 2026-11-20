-- 主題包的範圍代碼（data_access:bundle:<主題包>）登記到核心的範圍登記（裁決 D69：角色指派的範圍必須是登記過的）。
-- 目錄載入（catalog_load）新增或更新主題包時一併登記；已經載入的主題包在這裡補登記。

create function pack_data_access.scope_register()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
    perform sgn_sdk.register_scope(pack_data_access.owner_scope(new.package_code), new.name, 'data_access');
    return new;
end;
$$;

create trigger catalog_package_scope
    after insert or update on pack_data_access.catalog_package
    for each row execute function pack_data_access.scope_register();

select sgn_sdk.register_scope(pack_data_access.owner_scope(p.package_code), p.name, 'data_access')
from pack_data_access.catalog_package as p;
