-- OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010
--
-- Repairs the usage digest (20261010130000_ai_usage_digest.sql) after review
-- round 1 on its merged SHA 71ffc5036 (, evidence in
--). Owner
-- default Q53 = A: the digest stops publishing page-view totals, the section
-- breakdown and the role rows, and keeps distinct-actor counts and meeting
-- check-ins, each under its own people floor.
--
--   F2, F3, F4 and G2 had page views as their subject: monthly section totals
--   minus weekly ones, the weekly view total minus the live analytics
--   reader's per-day cells, and view totals summed over pruned page-view rows
--   next to unpruned actor counts. No view figure, section or role row is
--   computed, stored or returned any more, and stored digests are rewritten
--   without them.
--   F1 and G1: check-ins were count(*) of check-in events gated only on
--   page-view people, so one person checking in five times read as 5. A
--   bucket now publishes check-ins only when enough distinct people checked
--   in, and a wider window publishes them only when the people it adds
--   beyond its separately publishable weeks reach the floor, the rule
--   distinct actors already follow.
--   F5: account deletion removes engagement events, so a week that once
--   published can fall under 25 and stop being treated as separately
--   publishable while its stored weekly figure stays readable. An inner week
--   now also counts as published when a stored, unsuppressed bucket covers
--   it.
--
-- features.analytics.ai_usage_digest and its wording switch stay off.

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Retired surface
-- ---------------------------------------------------------------------------

drop function private.usage_digest_bucket(uuid, date, date, integer, integer);
drop function private.usage_digest_window_publishable(uuid, date, date, integer);
drop function private.usage_digest_section(text);

-- The section list is gone, so its length limit configures nothing.
delete from public.organization_setting_values
where setting_key = 'limits.analytics.ai_usage_digest_sections';
delete from public.platform_setting_definitions
where key = 'limits.analytics.ai_usage_digest_sections';

-- ---------------------------------------------------------------------------
-- Bucket shape
-- ---------------------------------------------------------------------------

-- The one shape of a withheld window: no figure at all.
create function private.usage_digest_withheld_bucket(p_start date, p_end date, p_floor integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'start', p_start, 'end', p_end, 'suppressed', true,
    'minCohort', greatest(25, coalesce(p_floor, 25)),
    'actors', null, 'checkins', null)
$function$;

comment on function private.usage_digest_withheld_bucket(date, date, integer) is
  'OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010: the withheld digest window, with no figure.';

-- Counts for one window of one organization: distinct page-view people and,
-- when enough distinct people checked in, meeting check-ins. Nothing reads
-- public.organization_page_views, so no view total, section or role row
-- exists to be differenced against the live reader or across windows.
create function private.usage_digest_bucket(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_floor integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  floor_size integer := greatest(25, coalesce(p_floor, 25));
  actors bigint;
  checkins bigint;
  checkin_people bigint;
begin
  select pg_catalog.count(distinct e.user_id) into actors
  from public.organization_engagement_events e
  where e.organization_id = p_organization_id and e.event_type = 'page_view'
    and e.occurred_at >= (p_start::timestamp at time zone 'UTC') and e.occurred_at < ((p_end + 1)::timestamp at time zone 'UTC');

  select pg_catalog.count(*), pg_catalog.count(distinct e.user_id) into checkins, checkin_people
  from public.organization_engagement_events e
  where e.organization_id = p_organization_id and e.event_type = 'meeting_check_in'
    and e.occurred_at >= (p_start::timestamp at time zone 'UTC') and e.occurred_at < ((p_end + 1)::timestamp at time zone 'UTC');

  if actors < floor_size then
    return private.usage_digest_withheld_bucket(p_start, p_end, floor_size);
  end if;

  return pg_catalog.jsonb_build_object(
    'start', p_start, 'end', p_end, 'suppressed', false, 'minCohort', floor_size,
    'actors', private.usage_digest_floored(actors),
    'checkins', case when checkin_people >= floor_size then private.usage_digest_floored(checkins) end
  );
end;
$function$;

comment on function private.usage_digest_bucket(uuid, date, date, integer) is
  'OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010: distinct page-view people and meeting check-ins for one digest window, each published only at or above the people floor and floored to five; no view, section or role figure.';

-- Windows are whole ISO weeks on one fixed grid, so an inner week of a wider
-- window either publishes on its own -- and a reader can subtract it -- or
-- never does. The people a window adds beyond every separately publishable
-- inner week are therefore what it discloses beyond its parts, and they must
-- reach the floor. p_event_type picks the figure: 'page_view' for distinct
-- actors, 'meeting_check_in' for check-ins. For check-ins, which are an event
-- total, the people who checked in during the remaining weeks include this
-- remainder, so their events are spread over at least the floor of people.
--
-- An inner week counts as publishable when its current count reaches 25, the
-- lowest floor any setting can produce, or when a stored, unsuppressed
-- bucket already covers it: account deletion removes engagement events, and a
-- week that published 30 people must not be treated as unpublished because
-- only 24 remain today (F5).
create function private.usage_digest_window_publishable(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_floor integer,
  p_event_type text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with weeks as (
    select (p_start + (span.n * 7)) as week_start, (p_start + (span.n * 7) + 6) as week_end
    from pg_catalog.generate_series(0, ((p_end - p_start + 1) / 7) - 1) as span(n)
  ), counted as (
    select weeks.week_start, weeks.week_end, (
      select pg_catalog.count(distinct e.user_id)
      from public.organization_engagement_events e
      where e.organization_id = p_organization_id and e.event_type = p_event_type
        and e.occurred_at >= (weeks.week_start::timestamp at time zone 'UTC')
        and e.occurred_at < ((weeks.week_end + 1)::timestamp at time zone 'UTC')
    ) as people, exists (
      select 1
      from private.analytics_usage_digests d
      cross join lateral pg_catalog.jsonb_array_elements(d.buckets) b
      where d.organization_id = p_organization_id
        and (b.value ->> 'start')::date = weeks.week_start
        and (b.value ->> 'end')::date = weeks.week_end
        and (b.value ->> 'suppressed')::boolean is false
    ) as stored
    from weeks
  ), publishable_weeks as (
    select counted.week_start, counted.week_end
    from counted
    where (counted.people >= 25 or counted.stored)
      and not (counted.week_start = p_start and counted.week_end = p_end)
  )
  -- Remove people, not just their events: someone in a publishable week is
  -- already in that week's figure.
  select p_event_type in ('page_view', 'meeting_check_in') and (
    select pg_catalog.count(distinct e.user_id)
    from public.organization_engagement_events e
    where e.organization_id = p_organization_id and e.event_type = p_event_type
      and e.occurred_at >= (p_start::timestamp at time zone 'UTC')
      and e.occurred_at < ((p_end + 1)::timestamp at time zone 'UTC')
      and not exists (
        select 1
        from public.organization_engagement_events p
        join publishable_weeks w
          on p.occurred_at >= (w.week_start::timestamp at time zone 'UTC')
          and p.occurred_at < ((w.week_end + 1)::timestamp at time zone 'UTC')
        where p.organization_id = p_organization_id and p.event_type = p_event_type
          and p.user_id = e.user_id
      )
  ) >= greatest(25, coalesce(p_floor, 25))
$function$;

comment on function private.usage_digest_window_publishable(uuid, date, date, integer, text) is
  'OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010: true when the people of one figure (page_view actors or meeting_check_in check-ins) a digest window adds beyond every separately publishable ISO week inside it -- by current count or by a stored unsuppressed bucket -- still reach the floor.';

-- ---------------------------------------------------------------------------
-- Generation (pg_cron), same schedule and signature
-- ---------------------------------------------------------------------------

create or replace function private.generate_analytics_usage_digests(
  p_now timestamptz default pg_catalog.now(),
  p_limit integer default 200,
  p_force boolean default false
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  local_now timestamp := coalesce(p_now, pg_catalog.now()) at time zone 'America/New_York';
  org record;
  period text;
  window_row record;
  first_start date;
  last_end date;
  buckets jsonb;
  deltas jsonb;
  bucket jsonb;
  floor_size integer;
  inserted integer := 0;
  added integer;
  org_inserted integer;
  has_data boolean;
begin
  if not coalesce(p_force, false) and pg_catalog.date_part('hour', local_now) < 9 then
    return 0;
  end if;
  delete from private.analytics_usage_digests d
  where not exists (select 1 from public.organizations o where o.id = d.organization_id);
  delete from private.analytics_usage_digest_visits v
  where v.window_start < ((coalesce(p_now, pg_catalog.now()) at time zone 'UTC')::date - 112)
     or not exists (select 1 from public.organizations o where o.id = v.organization_id);

  for org in
    select o.id
    from public.organizations o
    where o.status = 'active'
      and private.organization_feature_enabled(o.id, 'features.analytics.ai_usage_digest')
      and not exists (
        select 1 from private.analytics_usage_digest_visits v
        where v.organization_id = o.id
          and v.period = 'weekly'
          and v.window_start = (select min(w.bucket_start) from private.usage_digest_windows('weekly', p_now) w)
      )
    order by o.id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    begin
    org_inserted := 0;
    floor_size := greatest(25, coalesce(private.organization_limit(org.id, 'limits.analytics.ai_usage_digest_min_cohort'), 25),
      coalesce(private.organization_limit(org.id, 'limits.analytics.anonymity_floor'), 25));
    foreach period in array array['weekly', 'monthly'] loop
      buckets := '[]'::jsonb;
      deltas := '[]'::jsonb;
      first_start := null;
      last_end := null;
      for window_row in select w.bucket_start, w.bucket_end from private.usage_digest_windows(period, p_now) w order by w.bucket_start loop
        -- An interval stored by an earlier release keeps its first figures
        -- and suppression decision: a recount after account deletion or a
        -- floor change would differ from the published one by exactly what
        -- left the interval, and the difference would be subtractable.
        select b.value into bucket
        from private.analytics_usage_digests d
        cross join lateral pg_catalog.jsonb_array_elements(d.buckets) b
        where d.organization_id = org.id
          and (b.value ->> 'start')::date = window_row.bucket_start
          and (b.value ->> 'end')::date = window_row.bucket_end
        order by d.generated_at, d.id
        limit 1;
        -- Stored under a lower floor than today's: keep it dark rather than
        -- recount it.
        if bucket is not null and coalesce((bucket ->> 'minCohort')::integer, 0) < floor_size then
          bucket := private.usage_digest_withheld_bucket(window_row.bucket_start, window_row.bucket_end, floor_size);
        end if;
        if bucket is null then
          bucket := private.usage_digest_bucket(org.id, window_row.bucket_start, window_row.bucket_end, floor_size);
          -- A bucket that passed its own floors still withholds a figure when
          -- the people it adds beyond its separately publishable inner weeks
          -- are under the floor ( = A; F1 for check-ins).
          if (bucket ->> 'suppressed')::boolean is false
            and not private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size, 'page_view') then
            bucket := private.usage_digest_withheld_bucket(window_row.bucket_start, window_row.bucket_end, floor_size);
          elsif bucket ->> 'checkins' is not null
            and not private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size, 'meeting_check_in') then
            bucket := bucket || pg_catalog.jsonb_build_object('checkins', null);
          end if;
        end if;
        buckets := buckets || pg_catalog.jsonb_build_array(bucket);
        first_start := coalesce(first_start, window_row.bucket_start);
        last_end := window_row.bucket_end;
      end loop;
      insert into private.analytics_usage_digest_visits (organization_id, period, window_start)
      values (org.id, period, first_start)
      on conflict on constraint analytics_usage_digest_visits_pkey do nothing;
      -- The last two buckets are the comparison the old digest reported
      -- (de7df4b57c^:lib/analytics/usage-digest.ts deltas). A withheld figure
      -- on either side reports direction 'unknown' and no figures.
      if pg_catalog.jsonb_array_length(buckets) >= 2 then
        deltas := (
          select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'metric', metric.name,
            'current', current_bucket.value -> metric.name,
            'previous', previous_bucket.value -> metric.name,
            'direction', private.usage_digest_direction(
              (current_bucket.value ->> metric.name)::integer,
              (previous_bucket.value ->> metric.name)::integer)
          ) order by metric.ordinality), '[]'::jsonb)
          from pg_catalog.unnest(array['actors', 'checkins']) with ordinality as metric(name, ordinality)
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 1) as value) current_bucket
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 2) as value) previous_bucket
        );
      end if;
      has_data := exists (
        select 1 from pg_catalog.jsonb_array_elements(buckets) element
        where (element.value ->> 'suppressed')::boolean is false
          and (element.value ->> 'actors')::integer > 0
      );
      insert into private.analytics_usage_digests (
        organization_id, period, window_start, window_end, buckets, deltas, has_data, ai_status
      ) values (
        org.id, period, first_start, last_end, buckets, deltas,
        has_data,
        case when has_data and private.organization_feature_enabled(org.id, 'features.analytics.ai_usage_digest_wording')
          then 'available' else 'not_requested' end
      )
      on conflict on constraint analytics_usage_digests_one_per_window do nothing;
      get diagnostics added = row_count;
      org_inserted := org_inserted + added;
    end loop;
    inserted := inserted + org_inserted;
    exception when others then
      -- Do not expose SQL error details or hold later organizations behind a
      -- repeatedly failing first row. Retry this organization next window.
      insert into private.analytics_usage_digest_visits (organization_id, period, window_start)
      select org.id, 'weekly', min(w.bucket_start) from private.usage_digest_windows('weekly', p_now) w
      on conflict on constraint analytics_usage_digest_visits_pkey do nothing;
      raise warning 'usage digest organization skipped (SQLSTATE %)', sqlstate;
    end;
  end loop;
  return inserted;
end;
$function$;

comment on function private.generate_analytics_usage_digests(timestamptz, integer, boolean) is
  'Bounded pg_cron target (REQ-UG-AI-USAGE-DIGEST-20261001, repaired by OPS-UG-AI-USAGE-DIGEST-PRIVACY-REVIEW-20261010): from 9 AM America/New_York in continuation batches, one weekly and one monthly digest of distinct people and check-ins per opted-in organization, each figure under its own people floor of at least 25, every visit recorded, idempotent.';

-- ---------------------------------------------------------------------------
-- Read projection
-- ---------------------------------------------------------------------------

create or replace function private.usage_digest_projection(d private.analytics_usage_digests, p_ai_allowed boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with privacy as (
    select greatest(25,
      coalesce(private.organization_limit(d.organization_id, 'limits.analytics.ai_usage_digest_min_cohort'), 25),
      coalesce(private.organization_limit(d.organization_id, 'limits.analytics.anonymity_floor'), 25)) as floor_size
  ), checked as (
    select floor_size, not exists (
      select 1 from pg_catalog.jsonb_array_elements(d.buckets) b
      where coalesce((b ->> 'minCohort')::integer, 0) < floor_size
    ) as current from privacy
  )
  select pg_catalog.jsonb_build_object(
    'id', d.id,
    'period', d.period,
    'windowStart', d.window_start,
    'windowEnd', d.window_end,
    'buckets', case when checked.current then d.buckets else (
      select pg_catalog.jsonb_agg(private.usage_digest_withheld_bucket(
        (b ->> 'start')::date, (b ->> 'end')::date, checked.floor_size))
      from pg_catalog.jsonb_array_elements(d.buckets) b
    ) end,
    'deltas', case when checked.current then d.deltas else '[]'::jsonb end,
    'hasData', checked.current and d.has_data,
    'generatedAt', d.generated_at,
    'ai', pg_catalog.jsonb_build_object(
      -- Current eligibility decides both what is offered and what is shown.
      'status', case when not checked.current or not d.has_data or not p_ai_allowed then 'off'
        when d.ai_status = 'enriched' then 'enriched'
        when d.ai_status in ('available', 'not_requested') then 'available'
        else 'off' end,
      'summary', case when checked.current and d.has_data and p_ai_allowed then d.ai_summary end,
      'model', case when checked.current and d.has_data and p_ai_allowed then d.ai_model end,
      'enrichedAt', case when checked.current and d.has_data and p_ai_allowed then d.enriched_at end
    )
  ) from checked
$function$;

-- ---------------------------------------------------------------------------
-- Stored digests
-- ---------------------------------------------------------------------------

-- Every stored digest loses its view, section and role figures. Its
-- check-ins were published without a people floor, so they are withheld
-- rather than recounted; the reuse rule then keeps them withheld. Stored
-- wording may quote a dropped figure, so it is cleared and can be asked for
-- again. Actor counts and suppression decisions stay as first stored. Each
-- rewritten digest also gets a new id: a Compass save already in flight was
-- authorized against the old payload, which carried the dropped figures, and
-- public.save_analytics_usage_digest_ai finds a digest by id, so that save
-- now matches no row instead of storing wording that quotes them.
update private.analytics_usage_digests d
set id = extensions.gen_random_uuid(),
    buckets = coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'start', b.value -> 'start', 'end', b.value -> 'end',
          'suppressed', b.value -> 'suppressed', 'minCohort', b.value -> 'minCohort',
          'actors', b.value -> 'actors', 'checkins', null)
        order by b.ordinality)
      from pg_catalog.jsonb_array_elements(d.buckets) with ordinality as b(value, ordinality)
    ), '[]'::jsonb),
    deltas = coalesce((
      select pg_catalog.jsonb_agg(case when x.value ->> 'metric' = 'checkins'
          then pg_catalog.jsonb_build_object('metric', 'checkins', 'current', null, 'previous', null, 'direction', 'unknown')
          else x.value end
        order by x.ordinality)
      from pg_catalog.jsonb_array_elements(d.deltas) with ordinality as x(value, ordinality)
      where x.value ->> 'metric' in ('actors', 'checkins')
    ), '[]'::jsonb),
    has_data = exists (
      select 1 from pg_catalog.jsonb_array_elements(d.buckets) b
      where (b.value ->> 'suppressed')::boolean is false and (b.value ->> 'actors')::integer > 0
    ),
    ai_status = 'not_requested',
    ai_summary = null,
    ai_model = null,
    enriched_at = null;

revoke all on function private.usage_digest_withheld_bucket(date, date, integer) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_bucket(uuid, date, date, integer) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_window_publishable(uuid, date, date, integer, text) from public, anon, authenticated, service_role;
revoke all on function private.generate_analytics_usage_digests(timestamptz, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_projection(private.analytics_usage_digests, boolean) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
