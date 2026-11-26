-- SYS-UG-SHARED-EASTERN-TIME-GUARD-20261113 (#8625). The one
-- database helper for the Eastern day. The hosted projects run in UTC, so
-- current_date and now()::date name tomorrow from 7 PM Eastern (8 PM in
-- daylight time); the product counts a person's day in New York's zone.
-- #8563 (the tasks report) and #8568 (41 functions and six date defaults)
-- adopt this helper in their own migrations. From this migration on,
-- scripts/lib/eastern-time-scan.mjs refuses a new migration that reads the
-- session's day without a "-- utc-day:" reason.
--
-- stable, not immutable: the zone rules come from the server's tz data.
-- Called by security-definer functions only; no API role executes it.
begin;

create or replace function private.eastern_day(p_at timestamptz default pg_catalog.now())
returns date
language sql
stable
set search_path = ''
as $function$
  select (p_at at time zone 'America/New_York')::date;
$function$;

revoke all on function private.eastern_day(timestamptz) from public, anon, authenticated, service_role;

comment on function private.eastern_day(timestamptz) is
  'The Eastern (America/New_York) calendar day of an instant, now() by default. Use it wherever a day a person sees is counted; the session day is the UTC day on the hosted databases.';

commit;
