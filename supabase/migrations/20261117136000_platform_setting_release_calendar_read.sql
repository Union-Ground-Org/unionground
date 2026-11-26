-- REQ-UG-RELEASE-CALENDAR-SCREEN-WITH-RELEASE-AND-HOLD-BUTTONS-20261117 (#9039).
--
-- The release calendar screen (src/features/operations/ReleaseCalendarPanel.jsx)
-- shows a platform operator every switch with a release time, its state and
-- the release audit. Releasing and holding stay with scripts/release-calendar.mjs,
-- which changes Production and SAMPLE together through
-- public.set_platform_setting_release (20261112214970). Nothing let a browser
-- read that list or the release audit: public.platform_setting_definitions has
-- no client grants and private.platform_setting_release_changes is private.
--
-- public.get_platform_setting_release_calendar() is that read, and only that:
-- it writes nothing and changes neither control function. It admits exactly
-- the callers private.platform_setting_release_caller admits from the browser,
-- a platform operator with an MFA step-up (no typed name); everyone else gets
-- 42501, the database owner route included (it has the command line).
--
-- It answers the database's now() (the screen shows it as the database
-- time), every switch whose release_at is set
-- (key, label, release time, held) in key order, and the newest 50 audit rows
-- with who made each: "you" when the row is the caller's, the typed name on
-- the owner route, and no other operator's account id.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.get_platform_setting_release_calendar()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid;
begin
  -- A browser session only: the owner route has the command line.
  if (select auth.uid()) is null then
    raise exception 'platform operator required' using errcode = '42501';
  end if;
  caller := private.platform_setting_release_caller(null);
  return pg_catalog.jsonb_build_object(
    'now', pg_catalog.now(),
    'switches', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'key', d.key,
        'label', d.label,
        'releaseAt', d.release_at,
        'held', d.release_at > pg_catalog.now()) order by d.key)
      from public.platform_setting_definitions d
      where d.release_at is not null), '[]'::jsonb),
    'changes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id,
        'at', c.created_at,
        'key', c.setting_key,
        'action', c.action,
        'previousReleaseAt', c.previous_release_at,
        'releaseAt', c.new_release_at,
        'reason', c.reason,
        'byYou', c.actor_user_id is not distinct from caller,
        'actorName', c.actor_name) order by c.id desc)
      from (
        select x.id, x.created_at, x.setting_key, x.action, x.previous_release_at,
          x.new_release_at, x.reason, x.actor_user_id, x.actor_name
        from private.platform_setting_release_changes x
        order by x.id desc
        limit 50
      ) c), '[]'::jsonb));
end;
$function$;

revoke all on function public.get_platform_setting_release_calendar() from public, anon, authenticated, service_role;
grant execute on function public.get_platform_setting_release_calendar() to authenticated;

comment on function public.get_platform_setting_release_calendar() is
  'Platform operator (MFA step-up) only: the release calendar screen read. The database now(), every switch with a release_at (key, label, releaseAt, held) and the newest 50 private.platform_setting_release_changes rows (byYou, or the owner-route actor name; never another operator''s id). Writes nothing. Everyone else, the owner route included, 42501.';

commit;
