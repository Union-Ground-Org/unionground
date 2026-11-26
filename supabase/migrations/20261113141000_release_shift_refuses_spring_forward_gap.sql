-- OPS-UG-RELEASE-DATE-SHIFT-MOVES-A-SPRING-FORWARD-GAP-TIME-SILENTLY-20261115 (#8783).
--
-- public.shift_platform_setting_releases (20261112214970, #8580) moves each
-- dated hold by converting it to Eastern wall time, adding whole weeks and
-- converting back. When the new wall time falls in the spring-forward gap
-- (2:30 AM on Sun Mar 14, 2027, say) PostgreSQL turns it into 3:30 AM, so the
-- operator's shift landed an hour off, and scripts/release-calendar.mjs saw
-- the mismatch only after both sites had committed.
--
-- Now the function checks every new wall time round-trips before it writes
-- anything; one that does not refuses the whole shift (22023), naming the
-- switch and the time, and nothing moves. A time in the fall-back hour exists
-- (twice) and moves as before, keeping its wall time. The operator script
-- refuses the same times at its preview, before it calls either site. The
-- body is the live definition from 20261112214970 with only that check and
-- its variable added; grants and the comment are unchanged by CREATE OR
-- REPLACE.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.shift_platform_setting_releases(
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
  next_wall timestamp;
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

  -- #8783: an Eastern wall time in the spring-forward gap does not exist, and
  -- PostgreSQL would move it an hour later without saying so. Every new time
  -- is checked before anything is written; one that does not exist refuses
  -- the whole shift, naming the switch and the time.
  for held in
    select e.key, (e.value #>> '{}')::timestamptz as release_at
    from pg_catalog.jsonb_each(seen) e
    order by e.key
  loop
    next_wall := held.release_at at time zone 'America/New_York'
      + pg_catalog.make_interval(weeks => p_weeks);
    if (next_wall at time zone 'America/New_York') at time zone 'America/New_York' <> next_wall then
      raise exception '% would move to %, which does not exist in Eastern time (the clocks spring forward that night); nothing moved',
        held.key, pg_catalog.to_char(next_wall, 'YYYY-MM-DD HH24:MI')
        using errcode = '22023';
    end if;
  end loop;

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

notify pgrst, 'reload schema';

commit;
