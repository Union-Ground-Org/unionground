-- BUG-UG-PROFILE-FOCUS-TIMEZONE-TRIGGER-COST-20261027
--
-- member_profiles_validate_focus_timezone checked each new or changed
-- quiet_hours_timezone against pg_catalog.pg_timezone_names, a set-returning
-- view Postgres rebuilds from the tz database on disk at every call: about
-- 19 ms a row, paid by every signup (private.handle_new_member inserts the
-- profile) and every zone change.
--
-- The zone names are now copied once from this server's own
-- pg_timezone_names into a primary-keyed table, so an accepted name costs one
-- index probe. A name the copy does not hold still falls back to the full
-- view, so the accept/reject set stays exactly pg_timezone_names: exact-case
-- names pass; null, unknown and wrong-case names raise
-- 'Unknown IANA timezone: %' with SQLSTATE 22023. A zone that a later Postgres
-- or tzdata update adds is accepted through that fallback without a refresh;
-- tests/member-focus-timezone-lookup-db.test.js proves the copy equals
-- pg_timezone_names on the disposable stack, and a refresh migration
-- re-copies it if a server ever drops a zone the copy holds.
--
-- The function becomes security definer because the copy is private:
-- service_role has no USAGE on schema private, and authenticated holds no
-- grant on the table. The body reads only the copy and the catalog view.

begin;

create table private.iana_timezone_names (
  name text primary key
);
revoke all on table private.iana_timezone_names from public, anon, authenticated, service_role;

insert into private.iana_timezone_names(name)
select distinct timezone.name
from pg_catalog.pg_timezone_names timezone;

create or replace function private.validate_member_focus_timezone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from private.iana_timezone_names zone
    where zone.name = new.quiet_hours_timezone
  ) then
    return new;
  end if;
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone
    where timezone.name = new.quiet_hours_timezone
  ) then
    raise exception 'Unknown IANA timezone: %', new.quiet_hours_timezone
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.validate_member_focus_timezone() from public, anon, authenticated;

-- The trigger is reachable from the account-lifecycle trigger surface, which
-- fingerprints its function. Refresh only that fingerprint, then require a
-- clean inventory.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select kind,schema_name,table_name,object_name,definition_hash from private.account_lifecycle_trigger_surface()
where kind='function' and table_name='' and schema_name='private'
  and object_name = 'validate_member_focus_timezone()'
on conflict(kind,schema_name,table_name,object_name) do update set definition_hash=excluded.definition_hash;
do $inventory$
begin
  if exists(select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger inventory differs from review';
  end if;
end;
$inventory$;

commit;
