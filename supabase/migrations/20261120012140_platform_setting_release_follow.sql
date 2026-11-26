-- REQ-UG-RELEASE-CALENDAR-SCREEN-RELEASE-AND-HOLD-CHANGE-BOTH-DATABASES-20261117 (#9077).
--
-- The release calendar screen gets Release and Hold buttons that change
-- Production and SAMPLE together, through the server route
-- api/release-calendar.js. The route changes Production with the operator's
-- own stepped-up session (public.set_platform_setting_release, operator route
-- of private.platform_setting_release_caller), then makes SAMPLE follow with
-- SAMPLE's service key. The operator's Production session means nothing on
-- SAMPLE, and set_platform_setting_release refuses the service role on purpose,
-- so SAMPLE needs its own way in:
--
-- 1. private.platform_setting_release_previous(key, time, reason): the checks
--    and the row lock the writers share (reason, time, a boolean features.*
--    switch, held before). It returns the time the row holds now. One copy:
--    set_platform_setting_release uses it from here on, with the same refusals
--    in the same order, and so does the new function.
-- 2. private.platform_setting_release_service_caller(): the one check that
--    the caller is a service-key request (the service_role role and claims,
--    no person's account); 42501 for everyone else.
-- 3. public.get_platform_setting_release_for_follow(key): the service role
--    only. SAMPLE's release time for one key (null when it was never held or
--    is no feature switch) and the database clock. The route reads it before
--    any write and after.
-- 4. public.follow_platform_setting_release(key, time, expected, reason,
--    actor): the service role only. It needs the actor's name and a reason,
--    refuses what the set function refuses, changes the row only while it
--    still holds the time the caller read (else PT409, nothing written),
--    changes nothing when the row already holds the time, and writes one
--    audit row naming the actor.
--
-- What this changes in the security posture: the service role gains a way to
-- read and set the release time of a switch that was held before. It had
-- none: public.platform_setting_definitions grants it no select or update on
-- a migrated database, and set_platform_setting_release refuses it. The new
-- write is narrow (release_at of one boolean features.* switch held before,
-- compare-and-set, an actor name and a reason, one audit row). The functions
-- exist on both databases; the route calls them on SAMPLE only. No table
-- changes, private.platform_setting_release_caller is untouched, and
-- shift_platform_setting_releases is untouched.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The refusals both writers share
-- ---------------------------------------------------------------------------

create function private.platform_setting_release_previous(
  p_key text,
  p_release_at timestamptz,
  p_reason text
)
returns timestamptz
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  previous timestamptz;
  kind text;
begin
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 1 and 500
     or p_reason ~ '[[:cntrl:]]' then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_release_at is null or p_release_at = '-infinity'::timestamptz then
    raise exception 'release time required' using errcode = '22023';
  end if;

  select d.value_kind, d.release_at into kind, previous
  from public.platform_setting_definitions d
  where d.key = p_key
  for update;
  if not found or kind is distinct from 'boolean' or p_key not like 'features.%' then
    raise exception 'not a feature switch: %', p_key using errcode = '22023';
  end if;
  if previous is null then
    raise exception 'switch % was never held; its first hold is a reviewed migration', p_key using errcode = '55000';
  end if;
  return previous;
end;
$function$;

revoke all on function private.platform_setting_release_previous(text, timestamptz, text) from public, anon, authenticated, service_role;

comment on function private.platform_setting_release_previous(text, timestamptz, text) is
  'The refusals public.set_platform_setting_release and public.follow_platform_setting_release share: a reason (1-500, one line), a release time (not null, not -infinity), a boolean features.* switch held before. Locks the definition row and returns its release_at. Not executable by any API role.';

-- ---------------------------------------------------------------------------
-- 2. One switch, as before, with the shared refusals
-- ---------------------------------------------------------------------------

create or replace function public.set_platform_setting_release(
  p_key text,
  p_release_at timestamptz,
  p_reason text,
  p_actor text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  previous timestamptz;
begin
  caller := private.platform_setting_release_caller(p_actor);
  previous := private.platform_setting_release_previous(p_key, p_release_at, p_reason);
  if previous = p_release_at then
    return pg_catalog.jsonb_build_object('key', p_key, 'previousReleaseAt', previous,
      'releaseAt', p_release_at, 'held', p_release_at > pg_catalog.now(), 'updated', false);
  end if;

  update public.platform_setting_definitions set release_at = p_release_at where key = p_key;
  insert into private.platform_setting_release_changes
    (batch_id, action, setting_key, previous_release_at, new_release_at, reason, actor_user_id, actor_name, session_role)
  values (extensions.gen_random_uuid(), 'set', p_key, previous, p_release_at, pg_catalog.btrim(p_reason),
    caller, case when caller is null then pg_catalog.btrim(p_actor) end, session_user);
  return pg_catalog.jsonb_build_object('key', p_key, 'previousReleaseAt', previous,
    'releaseAt', p_release_at, 'held', p_release_at > pg_catalog.now(), 'updated', true);
end;
$function$;

revoke all on function public.set_platform_setting_release(text, timestamptz, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_platform_setting_release(text, timestamptz, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The service-key check both SAMPLE functions share
-- ---------------------------------------------------------------------------

create function private.platform_setting_release_service_caller()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  claims text := pg_catalog.current_setting('request.jwt.claims', true);
begin
  -- A service-key request only: the service_role role and claims, no account.
  if pg_catalog.current_setting('role') is distinct from 'service_role'
     or coalesce(claims, '') = ''
     or (claims::jsonb ->> 'role') is distinct from 'service_role'
     or (select auth.uid()) is not null then
    raise exception 'service role required' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function private.platform_setting_release_service_caller() from public, anon, authenticated, service_role;

comment on function private.platform_setting_release_service_caller() is
  'Raises 42501 unless the caller is a service-key request (role and claims service_role, no account). Shared by public.get_platform_setting_release_for_follow and public.follow_platform_setting_release. Not executable by any API role.';

-- ---------------------------------------------------------------------------
-- 4. SAMPLE's release time, for the server route only
-- ---------------------------------------------------------------------------

create function public.get_platform_setting_release_for_follow(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.platform_setting_release_service_caller();
  return pg_catalog.jsonb_build_object(
    'key', p_key,
    'releaseAt', (
      select d.release_at
      from public.platform_setting_definitions d
      where d.key = p_key and d.value_kind = 'boolean' and d.key like 'features.%'),
    'now', pg_catalog.now());
end;
$function$;

revoke all on function public.get_platform_setting_release_for_follow(text) from public, anon, authenticated, service_role;
grant execute on function public.get_platform_setting_release_for_follow(text) to service_role;

comment on function public.get_platform_setting_release_for_follow(text) is
  'Service role only (api/release-calendar.js, on SAMPLE): the release_at of one boolean features.* switch (null when never held or no such switch) and now(). Writes nothing.';

-- ---------------------------------------------------------------------------
-- 5. SAMPLE follows Production, from the server route only
-- ---------------------------------------------------------------------------

create function public.follow_platform_setting_release(
  p_key text,
  p_release_at timestamptz,
  p_expected timestamptz,
  p_reason text,
  p_actor text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  previous timestamptz;
begin
  perform private.platform_setting_release_service_caller();
  if p_actor is null or pg_catalog.char_length(pg_catalog.btrim(p_actor)) not between 1 and 120
     or p_actor ~ '[[:cntrl:]]' then
    raise exception 'actor name required' using errcode = '22023';
  end if;
  if p_expected is null then
    raise exception 'the release time read before the change is required' using errcode = '22023';
  end if;
  previous := private.platform_setting_release_previous(p_key, p_release_at, p_reason);
  if previous = p_release_at then
    return pg_catalog.jsonb_build_object('key', p_key, 'previousReleaseAt', previous,
      'releaseAt', p_release_at, 'held', p_release_at > pg_catalog.now(), 'updated', false);
  end if;
  if previous is distinct from p_expected then
    raise exception 'the release time changed since it was read' using errcode = 'PT409';
  end if;

  update public.platform_setting_definitions set release_at = p_release_at where key = p_key;
  insert into private.platform_setting_release_changes
    (batch_id, action, setting_key, previous_release_at, new_release_at, reason, actor_user_id, actor_name, session_role)
  values (extensions.gen_random_uuid(), 'set', p_key, previous, p_release_at, pg_catalog.btrim(p_reason),
    null, pg_catalog.btrim(p_actor), pg_catalog.current_setting('role'));
  return pg_catalog.jsonb_build_object('key', p_key, 'previousReleaseAt', previous,
    'releaseAt', p_release_at, 'held', p_release_at > pg_catalog.now(), 'updated', true);
end;
$function$;

revoke all on function public.follow_platform_setting_release(text, timestamptz, timestamptz, text, text) from public, anon, authenticated, service_role;
grant execute on function public.follow_platform_setting_release(text, timestamptz, timestamptz, text, text) to service_role;

comment on function public.follow_platform_setting_release(text, timestamptz, timestamptz, text, text) is
  'Service role only (api/release-calendar.js, on SAMPLE after Production accepted a stepped-up operator): sets release_at of one held or previously held boolean features.* switch to Production''s time, only while the row still holds the expected time (else PT409). Same refusals as public.set_platform_setting_release; the same time again changes nothing. Needs an actor name and a reason; one private.platform_setting_release_changes row naming the actor.';

notify pgrst, 'reload schema';

commit;
