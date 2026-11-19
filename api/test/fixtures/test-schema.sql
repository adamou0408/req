-- 測試用的假 api schema：只用來驗證後端骨架（callApi、錯誤對應、路由表、workers）。
-- 和真正的契約無關；真正的 schema 在 db/。
-- 結構照正式的做法：資料表在 das、function 在 api（SECURITY DEFINER），app 角色只能 EXECUTE api.*。

create schema das;
create schema api;

create table das.people (
  id text primary key,
  name text not null,
  email text not null unique,
  totp_secret text
);
insert into das.people values
  ('u1', '王小明', 'u1@example.test', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'),
  ('u2', '陳小華', 'u2@example.test', null);

create table das.outbox (
  id bigint generated always as identity primary key,
  recipients text[] not null,
  cc text[] not null default '{}',
  subject text not null,
  body_text text not null,
  body_html text,
  status text not null default 'pending',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  provider_ref text
);

create table das.job_runs (
  id bigint generated always as identity primary key,
  actor text,
  ran_at timestamptz not null default now()
);

create table das.imports (
  kind text not null,
  data jsonb not null
);

create table das.things (id int primary key);

-- ── 一般範例 ────────────────────────────────────────────────────

create function api.ping(p_actor text) returns jsonb
language sql security definer set search_path = pg_catalog, das as $$
  select jsonb_build_object('pong', true, 'actor', p_actor);
$$;

create function api.whoami(p_actor text) returns jsonb
language sql security definer set search_path = pg_catalog, das as $$
  select jsonb_build_object('actor', p_actor);
$$;

create function api.echo(p_actor text, p_payload jsonb, p_ip text, p_device text, p_mfa boolean) returns jsonb
language sql security definer set search_path = pg_catalog, das as $$
  select jsonb_build_object('actor', p_actor, 'payload', p_payload, 'ip', p_ip, 'device', p_device, 'mfa', p_mfa);
$$;

create function api.echo_text(p_actor text, p_value text) returns text
language sql security definer set search_path = pg_catalog, das as $$
  select p_value;
$$;

create function api.to_int(p_actor text, p_value int) returns int
language sql security definer set search_path = pg_catalog, das as $$
  select p_value;
$$;

create function api.list_items(p_actor text, p_n int) returns table (n int, label text)
language sql security definer set search_path = pg_catalog, das as $$
  select g, 'item-' || g from generate_series(1, p_n) as g;
$$;

create function api.secure_action(p_actor text, p_note text) returns jsonb
language sql security definer set search_path = pg_catalog, das as $$
  select jsonb_build_object('done', true, 'by', p_actor, 'note', p_note);
$$;

create function api.add_thing(p_actor text, p_id int) returns jsonb
language plpgsql security definer set search_path = pg_catalog, das as $$
begin
  insert into das.things values (p_id);
  return jsonb_build_object('id', p_id);
end $$;

create function api.delete_thing(p_actor text, p_id int) returns void
language plpgsql security definer set search_path = pg_catalog, das as $$
begin
  delete from das.things where id = p_id;
  if not found then
    raise exception 'thing_not_found' using errcode = 'DT404', detail = '找不到這個東西';
  end if;
end $$;

-- ── 會丟錯的 ────────────────────────────────────────────────────

create function api.fail(p_actor text, p_sqlstate text, p_message text, p_detail text) returns void
language plpgsql security definer set search_path = pg_catalog, das as $$
begin
  if p_detail is null then
    raise exception using errcode = p_sqlstate, message = p_message;
  else
    raise exception using errcode = p_sqlstate, message = p_message, detail = p_detail;
  end if;
end $$;

create function api.boom(p_actor text) returns int
language plpgsql security definer set search_path = pg_catalog, das as $$
declare
  secret text := 'internal-secret-value';
begin
  raise exception 'leaked % from das.people', secret;
end $$;

create function api.slow(p_actor text, p_seconds numeric) returns text
language plpgsql security definer set search_path = pg_catalog, das as $$
begin
  perform pg_sleep(p_seconds);
  return 'done';
end $$;

-- 存在於資料庫，但不在後端的白名單裡。
create function api.not_whitelisted(p_actor text) returns text
language sql security definer set search_path = pg_catalog, das as $$
  select 'should never be reachable';
$$;

-- ── 後端自己呼叫的（對應 src/contract/systemCalls.ts 假設的簽章）──

create function api.auth_me(p_actor text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, das as $$
declare
  result jsonb;
begin
  select jsonb_build_object('id', id, 'name', name) into result from das.people where id = p_actor;
  if result is null then
    raise exception 'unknown_actor' using errcode = 'DT404', detail = '找不到這個人';
  end if;
  return result;
end $$;

create function api.auth_resolve_login(p_actor text, p_identity jsonb, p_ip text, p_device text) returns text
language sql security definer set search_path = pg_catalog, das as $$
  select id from das.people where email = p_identity ->> 'email';
$$;

create function api.mfa_totp_secret(p_actor text) returns text
language sql security definer set search_path = pg_catalog, das as $$
  select totp_secret from das.people where id = p_actor;
$$;

create function api.outbox_claim(p_actor text, p_limit int)
returns table (id bigint, recipients text[], cc text[], subject text, body_text text, body_html text, attempts int)
language sql security definer set search_path = pg_catalog, das as $$
  select o.id, o.recipients, o.cc, o.subject, o.body_text, o.body_html, o.attempts
  from das.outbox o
  where o.status = 'pending' and o.next_attempt_at <= now()
  order by o.id
  limit p_limit
  for update skip locked;
$$;

create function api.outbox_mark_sent(p_actor text, p_id bigint, p_provider_ref text) returns void
language sql security definer set search_path = pg_catalog, das as $$
  update das.outbox set status = 'sent', provider_ref = p_provider_ref, last_error = null where id = p_id;
$$;

create function api.outbox_mark_failed(p_actor text, p_id bigint, p_error text, p_retry_after_sec int) returns void
language sql security definer set search_path = pg_catalog, das as $$
  update das.outbox
  set attempts = attempts + 1,
      last_error = p_error,
      next_attempt_at = now() + make_interval(secs => p_retry_after_sec)
  where id = p_id;
$$;

create function api.run_scheduled_jobs(p_actor text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, das as $$
declare
  total bigint;
begin
  insert into das.job_runs (actor) values (p_actor);
  select count(*) into total from das.job_runs;
  return jsonb_build_object('runs', total);
end $$;

create function api.directory_import(p_actor text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, das as $$
begin
  insert into das.imports values ('directory', p_data);
  return jsonb_build_object('people', jsonb_array_length(p_data -> 'people'), 'teams', jsonb_array_length(p_data -> 'teams'));
end $$;

create function api.catalog_import(p_actor text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = pg_catalog, das as $$
begin
  insert into das.imports values ('catalog', p_data);
  return jsonb_build_object('packages', jsonb_array_length(p_data -> 'packages'));
end $$;
