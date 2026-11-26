-- REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003
-- The owner-only public signup switch (owner ruling, October 4, 2026: create
-- the switch, but it must remain off).
--
-- The one switch is the existing private.open_signup_period row
-- (20260930040200_self_serve_organization_shell.sql): signup is open only once
-- that row has an opens_at at or before now, and no row means closed. No
-- client role, the service role included, can read or write it, so only the
-- owner changes it, with SQL. This migration adds what the switch lacked:
--
--   * every insert, update, delete and truncate of that row is recorded in
--     private.open_signup_switch_changes (when, which database session, the
--     opens_at before and after, and whether signup is open afterwards);
--   * public.open_signup_switch_open() lets the server signup routes ask only
--     whether the switch is open. It is executable by the service role alone
--     and returns nothing else.
--
-- It never inserts an open time: signup ships OFF and stays off until the
-- owner opens the period. Hosted application needs its own owner go-ahead.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.open_signup_switch_changes (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default pg_catalog.now(),
  operation text not null check (operation in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  session_role text not null,
  application_name text not null,
  old_opens_at timestamptz,
  new_opens_at timestamptz,
  open_after boolean not null
);

alter table private.open_signup_switch_changes enable row level security;
alter table private.open_signup_switch_changes force row level security;
revoke all on private.open_signup_switch_changes from public, anon, authenticated, service_role;

comment on table private.open_signup_switch_changes is
  'Audit of every change to the public signup switch (private.open_signup_period). Written only by its trigger; no client grant.';

create function private.record_open_signup_switch_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  application text := pg_catalog.left(coalesce(pg_catalog.current_setting('application_name', true), ''), 120);
begin
  if tg_op = 'TRUNCATE' then
    insert into private.open_signup_switch_changes
      (operation, session_role, application_name, old_opens_at, new_opens_at, open_after)
    values ('TRUNCATE', session_user, application, null, null, false);
  elsif tg_op = 'DELETE' then
    insert into private.open_signup_switch_changes
      (operation, session_role, application_name, old_opens_at, new_opens_at, open_after)
    values ('DELETE', session_user, application, old.opens_at, null, false);
  elsif tg_op = 'UPDATE' then
    insert into private.open_signup_switch_changes
      (operation, session_role, application_name, old_opens_at, new_opens_at, open_after)
    values ('UPDATE', session_user, application, old.opens_at, new.opens_at,
      coalesce(new.opens_at <= pg_catalog.now(), false));
  else
    insert into private.open_signup_switch_changes
      (operation, session_role, application_name, old_opens_at, new_opens_at, open_after)
    values ('INSERT', session_user, application, null, new.opens_at,
      coalesce(new.opens_at <= pg_catalog.now(), false));
  end if;
  return null;
end;
$function$;

revoke all on function private.record_open_signup_switch_change()
  from public, anon, authenticated, service_role;

create trigger record_open_signup_switch_change
after insert or update or delete on private.open_signup_period
for each row execute function private.record_open_signup_switch_change();

create trigger record_open_signup_switch_truncate
after truncate on private.open_signup_period
for each statement execute function private.record_open_signup_switch_change();

create function public.open_signup_switch_open()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.open_signup_is_open();
$function$;

revoke all on function public.open_signup_switch_open() from public, anon, authenticated;
grant execute on function public.open_signup_switch_open() to service_role;

comment on function public.open_signup_switch_open() is
  'True only while the owner has opened public signup (private.open_signup_period). Service role only; used by the server signup routes.';

-- Account lifecycle trigger review. Neither private.open_signup_period nor
-- private.open_signup_switch_changes has a foreign key, so no account deletion
-- or other referential action reaches these triggers; they fire only on the
-- owner's own changes to the switch and write only the audit row.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'private' and s.table_name = 'open_signup_period'
    and s.object_name in ('record_open_signup_switch_change', 'record_open_signup_switch_truncate'))
  or (s.kind = 'function' and s.schema_name = 'private'
    and s.object_name = 'record_open_signup_switch_change()')
on conflict do nothing;

do $assert_open_signup_switch_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the public signup switch audit';
  end if;
end
$assert_open_signup_switch_trigger_review$;

notify pgrst, 'reload schema';
commit;
