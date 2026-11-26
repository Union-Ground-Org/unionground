-- A caller-supplied project ref is not a database identity. Keep every seed
-- mutation disabled until an administrator binds this exact Postgres cluster
-- and database to the isolated SAMPLE ref out of band. The migration never
-- creates that binding, so applying schema to production remains fail-closed.

create table private.demo_seed_installation_bindings (
  project_ref text primary key,
  system_identifier numeric not null,
  database_oid oid not null,
  bound_at timestamptz not null default pg_catalog.now(),
  constraint demo_seed_installation_bindings_sample_only
    check (project_ref = 'sampledemoprojectref')
);

alter table private.demo_seed_installation_bindings enable row level security;
revoke all on table private.demo_seed_installation_bindings
  from public, anon, authenticated, service_role;

comment on table private.demo_seed_installation_bindings is
  'Out-of-band administrator binding for the isolated SAMPLE seed database. Migrations intentionally leave this table empty.';

create or replace function private.presg_demo_authorize(
  p_target_ref text,
  p_confirm_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  live_system_identifier numeric;
  live_database_oid oid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'presg demo RPC requires service_role';
  end if;
  if p_target_ref <> 'sampledemoprojectref' then
    raise exception 'presg demo target mismatch';
  end if;

  select control.system_identifier::numeric
  into live_system_identifier
  from pg_catalog.pg_control_system() as control;

  select database.oid
  into live_database_oid
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();

  if not exists (
    select 1
    from private.demo_seed_installation_bindings as binding
    where binding.project_ref = p_target_ref
      and binding.system_identifier = live_system_identifier
      and binding.database_oid = live_database_oid
  ) then
    raise exception 'presg demo database identity is not bound to SAMPLE';
  end if;

  if p_confirm_token <> 'SEED_UNION_GROUND_SAMPLE_DEMO' then
    raise exception 'presg demo confirmation mismatch';
  end if;
end;
$function$;

create or replace function private.uniondemo_authorize(
  p_target_ref text,
  p_confirm_token text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  live_system_identifier numeric;
  live_database_oid oid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'union demo RPC requires service_role';
  end if;
  if p_target_ref <> 'sampledemoprojectref' then
    raise exception 'union demo target mismatch';
  end if;

  select control.system_identifier::numeric
  into live_system_identifier
  from pg_catalog.pg_control_system() as control;

  select database.oid
  into live_database_oid
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();

  if not exists (
    select 1
    from private.demo_seed_installation_bindings as binding
    where binding.project_ref = p_target_ref
      and binding.system_identifier = live_system_identifier
      and binding.database_oid = live_database_oid
  ) then
    raise exception 'union demo database identity is not bound to SAMPLE';
  end if;

  if p_confirm_token <> 'SEED_UNION_DEMO_ORG_SAMPLE_30K' then
    raise exception 'union demo confirmation mismatch';
  end if;
end;
$function$;

revoke all on function private.presg_demo_authorize(text, text)
  from public, anon, authenticated, service_role;
revoke all on function private.uniondemo_authorize(text, text)
  from public, anon, authenticated, service_role;
