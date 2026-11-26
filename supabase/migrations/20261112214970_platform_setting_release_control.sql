-- REQ-UG-RELEASE-DATE-CONTROL-WITHOUT-MIGRATION-20261112 (#8580).
--
-- A held switch carries its release time in
-- public.platform_setting_definitions.release_at (20261112061000). Until now
-- every change to that time was a reviewed migration: a pull request, a gate
-- review and two applies for a one-week slip. The owner, November 12, 2026,
-- about 10:36 PM ET: "I need to, you know, be able to adjust by a week or two
-- weeks in case something gets delayed without having to go through an
-- extraordinary amount of effort to adjust the timeline."
--
-- The first hold of a switch stays a reviewed migration. After that its time is
-- operator data:
--
-- 1. private.platform_setting_release_changes: one audit row per change (who,
--    key, old time, new time, reason). No client role can read or write it.
-- 2. public.set_platform_setting_release(key, time, reason, actor): sets the
--    release time of ONE boolean features.* switch that is held or was held
--    before (release_at not null). A future time holds it, 'infinity' holds it
--    with no date, now or a past time releases it. A switch never held is
--    refused (55000): its first hold is a migration.
-- 3. public.shift_platform_setting_releases(day, weeks, previewed, reason,
--    actor): moves every dated hold still in the future at or after that
--    Eastern day by a number of weeks, keeping its Eastern wall-clock time.
--    'infinity' holds and released switches never move. The caller passes the
--    holds it previewed (key -> release time); under the row locks the set must
--    be exactly that, or nothing moves (PT409, HTTP 409, never retried), so a concurrent change can never
--    make a confirmed shift save other dates than the ones shown.
--
-- Who may call them: a platform operator (private.compass_platform_operator():
-- an active registry row and an aal2 session on an account with a verified
-- factor, no MFA recovery lock), with no actor name; or the database owner
-- session the Supabase Management API opens for scripts/release-calendar.mjs
-- (session user a member of postgres, no request JWT, no SET ROLE), which can
-- already update the row directly, with the person's name as actor. Everyone
-- else, organization admins included, is refused (42501).
--
-- Only release_at changes. The held-aware readers of 20261112061000 keep a held
-- switch off everywhere until its time, and no stored organization value is
-- touched.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The audit
-- ---------------------------------------------------------------------------

create table private.platform_setting_release_changes (
  id bigint generated always as identity primary key,
  batch_id uuid not null,
  action text not null,
  setting_key text not null,
  previous_release_at timestamptz,
  new_release_at timestamptz not null,
  reason text not null,
  actor_user_id uuid,
  actor_name text,
  session_role text not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint platform_setting_release_changes_action_check check (action in ('set', 'shift')),
  constraint platform_setting_release_changes_actor_check
    check ((actor_user_id is null) <> (actor_name is null))
);

create index platform_setting_release_changes_key_idx
  on private.platform_setting_release_changes (setting_key, created_at desc);

comment on table private.platform_setting_release_changes is
  'One row per release time change made by public.set_platform_setting_release or public.shift_platform_setting_releases: the key, the old and new time, the reason and who (an operator user id, or the named person on the database owner route). Holds made by migrations are not here.';

alter table private.platform_setting_release_changes enable row level security;
alter table private.platform_setting_release_changes force row level security;
revoke all on table private.platform_setting_release_changes from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Who may change a release time
-- ---------------------------------------------------------------------------

-- Returns the operator's user id, or null on the database owner route; raises
-- for everyone else. p_actor must be null for an operator (the audit names the
-- account) and is required on the owner route.
create function private.platform_setting_release_caller(p_actor text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  claims text := pg_catalog.current_setting('request.jwt.claims', true);
begin
  if caller is not null then
    if not (coalesce(private.mfa_satisfied(), false) and private.compass_platform_operator()) then
      raise exception 'platform operator required' using errcode = '42501';
    end if;
    if p_actor is not null then
      raise exception 'an operator is named by the account' using errcode = '22023';
    end if;
    return caller;
  end if;
  if coalesce(claims, '') <> ''
     or pg_catalog.current_setting('role') <> 'none'
     or not pg_catalog.pg_has_role(session_user, 'postgres', 'MEMBER') then
    raise exception 'platform operator required' using errcode = '42501';
  end if;
  if p_actor is null or pg_catalog.char_length(pg_catalog.btrim(p_actor)) not between 1 and 120
     or p_actor ~ '[[:cntrl:]]' then
    raise exception 'actor name required' using errcode = '22023';
  end if;
  return null;
end;
$function$;

revoke all on function private.platform_setting_release_caller(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. One switch
-- ---------------------------------------------------------------------------

create function public.set_platform_setting_release(
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
  kind text;
begin
  caller := private.platform_setting_release_caller(p_actor);
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

comment on function public.set_platform_setting_release(text, timestamptz, text, text) is
  'Platform operator (MFA step-up) or the database owner route of scripts/release-calendar.mjs: sets release_at of one held or previously held boolean features.* switch. Future = held, infinity = held with no date, now or past = released. Refuses a switch never held (its first hold is a migration). Writes one private.platform_setting_release_changes row.';

-- ---------------------------------------------------------------------------
-- 4. Everything after a day
-- ---------------------------------------------------------------------------

create function public.shift_platform_setting_releases(
  p_from date,
  p_weeks integer,
  p_expected jsonb,
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
  batch uuid := extensions.gen_random_uuid();
  moved jsonb := '[]'::jsonb;
  held record;
  next_at timestamptz;
  seen jsonb;
  previewed jsonb;
begin
  caller := private.platform_setting_release_caller(p_actor);
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) not between 1 and 500
     or p_reason ~ '[[:cntrl:]]' then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_from is null or p_weeks is null or p_weeks = 0 or p_weeks not between -8 and 8 then
    raise exception 'a day and a number of weeks from -8 to 8 are required' using errcode = '22023';
  end if;
  if p_expected is null or pg_catalog.jsonb_typeof(p_expected) <> 'object' then
    raise exception 'the previewed holds are required' using errcode = '22023';
  end if;

  -- Lock the holds this shift moves, then check they are exactly the ones the
  -- caller previewed, with the same times.
  select coalesce(pg_catalog.jsonb_object_agg(s.key, s.release_at), '{}'::jsonb) into seen
  from (
    select d.key, d.release_at
    from public.platform_setting_definitions d
    where d.value_kind = 'boolean' and d.key like 'features.%'
      and d.release_at > pg_catalog.now()
      and pg_catalog.isfinite(d.release_at)
      and d.release_at >= (p_from::timestamp at time zone 'America/New_York')
    order by d.key
    for update
  ) s;
  select coalesce(pg_catalog.jsonb_object_agg(e.key, (e.value #>> '{}')::timestamptz), '{}'::jsonb) into previewed
  from pg_catalog.jsonb_each(p_expected) e;
  if seen is distinct from previewed then
    raise exception 'the calendar changed since the preview' using errcode = 'PT409';
  end if;

  -- Move exactly the locked, validated set. Selecting the holds again would
  -- take a fresh snapshot, and under read committed a hold dated by another
  -- session after the check could join the shift unseen.
  for held in
    select e.key, (e.value #>> '{}')::timestamptz as release_at
    from pg_catalog.jsonb_each(seen) e
    order by e.key
  loop
    next_at := (held.release_at at time zone 'America/New_York'
      + pg_catalog.make_interval(weeks => p_weeks)) at time zone 'America/New_York';
    update public.platform_setting_definitions set release_at = next_at where key = held.key;
    insert into private.platform_setting_release_changes
      (batch_id, action, setting_key, previous_release_at, new_release_at, reason, actor_user_id, actor_name, session_role)
    values (batch, 'shift', held.key, held.release_at, next_at, pg_catalog.btrim(p_reason),
      caller, case when caller is null then pg_catalog.btrim(p_actor) end, session_user);
    moved := moved || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'key', held.key, 'previousReleaseAt', held.release_at, 'releaseAt', next_at, 'held', next_at > pg_catalog.now()));
  end loop;
  return pg_catalog.jsonb_build_object('moved', moved, 'count', pg_catalog.jsonb_array_length(moved));
end;
$function$;

revoke all on function public.shift_platform_setting_releases(date, integer, jsonb, text, text) from public, anon, authenticated, service_role;
grant execute on function public.shift_platform_setting_releases(date, integer, jsonb, text, text) to authenticated;

comment on function public.shift_platform_setting_releases(date, integer, jsonb, text, text) is
  'Platform operator (MFA step-up) or the database owner route of scripts/release-calendar.mjs: moves every dated hold still in the future at or after an Eastern day by -8..8 weeks, keeping its Eastern time of day, only when the locked holds are exactly the previewed ones (else PT409). Never moves an infinity hold or a released switch. One private.platform_setting_release_changes row per key, one batch id.';

notify pgrst, 'reload schema';

commit;
