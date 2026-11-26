-- OPS-UG-SIGNUP-READINESS-COVERAGE-REFRESH-20261016
-- Public signup also requires a current operator-availability lease: the solo
-- operator authorizes a bounded window inside the approved support hours
-- (Monday-Friday, 9 AM-5 PM America/New_York, project decision October 15, 2026)
-- and checks in by hand; the refresh only carries the time of the operator's
-- last check-in to the database. Outside the window, after a missed check-in
-- or after revocation, every signup entry point fails closed, and a lapsed
-- lease needs a new authorization. Only a privileged operator session writes.
-- Applying this migration creates no lease and never opens signup.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.open_signup_operator_coverage (
  id bigint generated always as identity primary key,
  authorized_at timestamptz not null default pg_catalog.now(),
  window_starts_at timestamptz not null,
  window_ends_at timestamptz not null,
  check_in_interval interval not null default interval '30 minutes'
    check (check_in_interval > interval '0' and check_in_interval <= interval '60 minutes'),
  last_check_in_at timestamptz,
  -- A non-contact label such as "owner"; never an email address or phone number.
  operator_label text not null
    check (operator_label ~ '^[A-Za-z][A-Za-z ._-]{0,79}$'),
  evidence_reference text not null
    check (length(trim(evidence_reference)) between 1 and 2048),
  revoked_at timestamptz,
  constraint open_signup_operator_coverage_window_check
    check (window_ends_at > window_starts_at and window_ends_at <= window_starts_at + interval '8 hours'),
  constraint open_signup_operator_coverage_check_in_check
    check (last_check_in_at is null
      or (last_check_in_at >= window_starts_at and last_check_in_at < window_ends_at)),
  constraint open_signup_operator_coverage_revoked_check
    check (revoked_at is null or revoked_at >= authorized_at)
);
alter table private.open_signup_operator_coverage enable row level security;
alter table private.open_signup_operator_coverage force row level security;
revoke all on private.open_signup_operator_coverage from public, anon, authenticated, service_role;
revoke all on sequence private.open_signup_operator_coverage_id_seq from public, anon, authenticated, service_role;

comment on table private.open_signup_operator_coverage is
  'Append-only operator-availability leases for public signup. The latest lease wins; it must be unrevoked, inside its approved Monday-Friday 9 AM-5 PM ET window and recently checked in. No client access.';

-- Every revocation is recorded, even when no lease exists yet, so a refresh
-- already in flight cannot check in a lease with an operator check-in made at
-- or before the revocation.
create table private.open_signup_coverage_revocations (
  id bigint generated always as identity primary key,
  revoked_at timestamptz not null default pg_catalog.now()
);
alter table private.open_signup_coverage_revocations enable row level security;
alter table private.open_signup_coverage_revocations force row level security;
revoke all on private.open_signup_coverage_revocations from public, anon, authenticated, service_role;
revoke all on sequence private.open_signup_coverage_revocations_id_seq from public, anon, authenticated, service_role;

comment on table private.open_signup_coverage_revocations is
  'Operator coverage revocations. A check-in made at or before any revocation never activates a lease. No client access.';

-- The approved hours are enforced here rather than in a CHECK constraint so
-- disposable-database fixtures can install an out-of-hours lease inside a
-- rolled-back transaction with session_replication_role, instead of taking a
-- table-wide DDL lock that would serialize concurrent proofs. The guard also
-- keeps the table append-only: a lease can only be checked in or revoked.
create function private.enforce_open_signup_coverage_lease()
returns trigger language plpgsql security definer set search_path = ''
as $function$
declare local_start timestamp; local_end timestamp;
begin
  if tg_op = 'TRUNCATE' or tg_op = 'DELETE' then
    raise exception 'Operator coverage leases are append-only; revoke instead'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'INSERT' then
    local_start := new.window_starts_at at time zone 'America/New_York';
    local_end := new.window_ends_at at time zone 'America/New_York';
    if pg_catalog.date_part('isodow', local_start) not between 1 and 5
      or local_start::time < time '09:00'
      or local_end::time > time '17:00'
      or local_end::date <> local_start::date then
      raise exception 'Coverage window must fall inside Monday-Friday 9 AM-5 PM America/New_York'
        using errcode = 'check_violation';
    end if;
    if new.window_ends_at <= pg_catalog.now() then
      raise exception 'Coverage window has already ended' using errcode = 'check_violation';
    end if;
    if new.last_check_in_at is not null or new.revoked_at is not null then
      raise exception 'A new lease starts unchecked and unrevoked' using errcode = 'check_violation';
    end if;
    new.authorized_at := pg_catalog.now();
    return new;
  end if;
  if (new.id, new.authorized_at, new.window_starts_at, new.window_ends_at, new.check_in_interval,
      new.operator_label, new.evidence_reference)
    is distinct from (old.id, old.authorized_at, old.window_starts_at, old.window_ends_at,
      old.check_in_interval, old.operator_label, old.evidence_reference)
    or (old.revoked_at is not null and new is distinct from old)
    or (new.revoked_at is null and old.revoked_at is not null)
    or (new.last_check_in_at is distinct from old.last_check_in_at
      and (new.last_check_in_at is null or new.last_check_in_at < coalesce(old.last_check_in_at, '-infinity'))) then
    raise exception 'A coverage lease can only be checked in or revoked'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$function$;
revoke all on function private.enforce_open_signup_coverage_lease()
  from public, anon, authenticated, service_role;

create trigger enforce_open_signup_coverage_lease
before insert or update or delete on private.open_signup_operator_coverage
for each row execute function private.enforce_open_signup_coverage_lease();
create trigger enforce_open_signup_coverage_lease_truncate
before truncate on private.open_signup_operator_coverage
for each statement execute function private.enforce_open_signup_coverage_lease();

create function private.open_signup_coverage_active()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((
    select c.revoked_at is null
      and c.window_starts_at <= pg_catalog.now()
      and pg_catalog.now() < c.window_ends_at
      and c.last_check_in_at is not null
      and c.last_check_in_at <= pg_catalog.now()
      and pg_catalog.now() <= c.last_check_in_at + c.check_in_interval
      and not exists (select 1 from private.open_signup_coverage_revocations r
        where r.revoked_at >= c.last_check_in_at)
    from private.open_signup_operator_coverage c
    order by c.id desc limit 1
  ), false);
$function$;
revoke all on function private.open_signup_coverage_active() from public, anon, authenticated, service_role;

-- Records the operator's own check-in time (by default now, when the operator
-- runs it by hand) on the latest lease. Refused when that lease is revoked,
-- now is outside its window, the check-in is in the future, before the window,
-- already older than the interval or not after the latest revocation, and when
-- the lease already lapsed: a lapsed lease needs a new authorization. An older
-- lease never stands in for a newer one. Returns whether coverage holds.
create function private.open_signup_coverage_check_in(p_attended_at timestamptz default pg_catalog.now())
returns boolean language plpgsql volatile security definer set search_path = ''
as $function$
declare latest record;
begin
  if p_attended_at is null or p_attended_at > pg_catalog.now()
    or exists (select 1 from private.open_signup_coverage_revocations r where r.revoked_at >= p_attended_at) then
    return false;
  end if;
  select c.id, c.window_starts_at, c.window_ends_at, c.check_in_interval, c.last_check_in_at, c.revoked_at
    into latest
    from private.open_signup_operator_coverage c order by c.id desc limit 1 for update;
  if not found or latest.revoked_at is not null
    or pg_catalog.now() < latest.window_starts_at or pg_catalog.now() >= latest.window_ends_at
    or p_attended_at < latest.window_starts_at
    or pg_catalog.now() > p_attended_at + latest.check_in_interval
    or (latest.last_check_in_at is not null
      and pg_catalog.now() > latest.last_check_in_at + latest.check_in_interval) then
    return false;
  end if;
  if latest.last_check_in_at is null or p_attended_at > latest.last_check_in_at then
    update private.open_signup_operator_coverage c
      set last_check_in_at = p_attended_at where c.id = latest.id;
  end if;
  return true;
end;
$function$;
revoke all on function private.open_signup_coverage_check_in(timestamptz) from public, anon, authenticated, service_role;

-- Records a revocation and ends every unrevoked lease now. Returns how many
-- leases were revoked; the revocation is recorded even when that is zero.
create function private.open_signup_coverage_revoke()
returns integer language plpgsql volatile security definer set search_path = ''
as $function$
declare revoked integer;
begin
  insert into private.open_signup_coverage_revocations default values;
  update private.open_signup_operator_coverage c
    set revoked_at = pg_catalog.now()
    where c.revoked_at is null;
  get diagnostics revoked = row_count;
  return revoked;
end;
$function$;
revoke all on function private.open_signup_coverage_revoke() from public, anon, authenticated, service_role;

-- The owner period, current recovery/launch readiness and operator coverage
-- must all hold. Direct create_my_organization and the service-role signup
-- limiter use this predicate, so both fail closed outside coverage.
create or replace function private.open_signup_is_open()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((select p.opens_at <= pg_catalog.now()
    from private.open_signup_period p where p.singleton), false)
    and private.open_signup_recovery_ready()
    and private.open_signup_coverage_active();
$function$;
revoke all on function private.open_signup_is_open() from public, anon, authenticated, service_role;

create function public.open_signup_coverage_active()
returns boolean language sql stable security definer set search_path = ''
as $function$ select private.open_signup_coverage_active(); $function$;
revoke all on function public.open_signup_coverage_active() from public, anon, authenticated;
grant execute on function public.open_signup_coverage_active() to service_role;

comment on function public.open_signup_coverage_active() is
  'Operator coverage only; never grants permission to open signup. The owner switch and recovery readiness are separately required.';

-- The new guard triggers and their function join the reviewed trigger surface.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'private' and s.table_name = 'open_signup_operator_coverage'
    and s.object_name in ('enforce_open_signup_coverage_lease', 'enforce_open_signup_coverage_lease_truncate'))
  or (s.kind = 'function' and s.schema_name = 'private'
    and s.object_name = 'enforce_open_signup_coverage_lease()')
on conflict do nothing;

do $assert_open_signup_coverage_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the signup coverage lease';
  end if;
end
$assert_open_signup_coverage_trigger_review$;

notify pgrst, 'reload schema';
commit;
