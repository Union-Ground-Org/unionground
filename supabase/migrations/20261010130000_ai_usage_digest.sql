-- REQ-UG-AI-USAGE-DIGEST-20261001
--
-- Restores the weekly and monthly app-usage trend digest admins, stewards and
-- chapter advisors used to read (de7df4b57c^:lib/analytics/usage-digest.ts,
-- usage-digest-store.ts, usage-digest-ai.ts,
-- app/api/cron/usage-trend-digest/route.ts,
-- components/analytics/ai-usage-digest-section.tsx). A scheduled job stores
-- one aggregate digest per organization and period; staff read it in the
-- analytics Usage view; optional Compass wording is requested from there.
--
-- Adaptations to this app, mirroring the issue-intelligence weekly digest
-- restore (20261002151000):
--   * Organization-scoped rows (the old store wrote two single-tenant
--     settings rows). pg_cron is the scheduler, in bounded continuation
--     batches that record every visit, so no organization is starved.
--   * The source is already aggregate: public.organization_page_views holds
--     (path, hat, day, view_count) with no member identifier at all. Distinct
--     actors and meeting check-ins are counted from
--     public.organization_engagement_events and only ever stored as counts,
--     so no digest, and nothing crossing the provider boundary, can name or
--     single out a person.
--   * Suppression is never weaker than the live analytics reader
--     (public.get_organization_analytics_snapshot, privacy threshold 25):
--     a bucket publishes nothing unless its own distinct-actor cohort reaches
--     the floor, every published total is floored to a multiple of 5, and the
--     configurable floor cannot be set below 25.
--   * AI wording follows the Platform AI ownership and failover contract
--: staff request it from the digest, api/guide.js (mode
--     usage_digest) reserves and dispatches through the governed mesh path
--     with Fireworks failover, and only the stored aggregate crosses the
--     boundary. It needs features.analytics.ai_usage_digest_wording AND the
--     organization AI switch features.ai_assistant.enabled (owned by
--     REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001); otherwise the
--     digest stays deterministic.
--
-- Defaults are the old app's effective production defaults:
--   features.analytics.ai_usage_digest = false
--     (de7df4b57c^:lib/settings/settings-keys.ts:170 ai_usage_digests_enabled,
--      read with getBoolean(..., false) in
--      de7df4b57c^:lib/analytics/usage-digest-store.ts;)
--   features.analytics.ai_usage_digest_wording = false
--     (the old narrative rode the master gate claude_enabled, 'false' in
--      production: de7df4b57c^:supabase/migrations/0023:153, 0404, 0406)
--   limits.analytics.ai_usage_digest_min_cohort = 25
--     (old MIN_DIGEST_COHORT_SIZE was 5 in
--      de7df4b57c^:lib/analytics/usage-digest.ts:33; this app's analytics
--      floor is 25 and restoring the behavior must not lower it)
--   limits.analytics.ai_usage_digest_sections = 5
--     (old USAGE_DIGEST_TOP_SECTION_LIMIT, de7df4b57c^:lib/analytics/usage-digest.ts:41)

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- de7df4b57c^ lib/settings/settings-keys.ts:170 ai_usage_digests_enabled, default-OFF read in usage-digest-store.ts.
  ('features.analytics.ai_usage_digest', 'boolean', 'Weekly and monthly usage digest',
   'Store a weekly and a monthly app-usage trend digest for this organization. Admins, stewards and chapter advisors read it in Analytics. Aggregate counts only, never individual activity.',
   'false', null, null, null, 300, 'analytics', false),
  -- The old narrative rode the master gate claude_enabled, 'false' in production (0023:153, 0404, 0406).
  ('features.analytics.ai_usage_digest_wording', 'boolean', 'Compass wording for the usage digest',
   'Let staff add Compass wording to a stored usage digest. Needs the organization AI assistant switch; only the stored aggregate figures are sent.',
   'false', null, null, null, 310, 'analytics', false),
  -- de7df4b57c^ lib/analytics/usage-digest.ts:33 MIN_DIGEST_COHORT_SIZE was 5; this app's analytics floor is 25 and is the minimum here.
  ('limits.analytics.ai_usage_digest_min_cohort', 'integer', 'Usage digest privacy floor',
   'People who must have used the app in a period before the digest reports any figure for it.',
   '25', 25, 200, null, 320, 'analytics', false),
  -- de7df4b57c^ lib/analytics/usage-digest.ts:41 USAGE_DIGEST_TOP_SECTION_LIMIT.
  ('limits.analytics.ai_usage_digest_sections', 'integer', 'Usage digest sections listed',
   'Most app sections listed for one period in the usage digest.',
   '5', 1, 12, null, 330, 'analytics', false)
on conflict (key) do nothing;

-- A derived, regenerable aggregate cache. It names no person, carries no
-- foreign key and holds only counts, so it sits outside the account case
-- graph; rows of an organization that no longer exists are removed by the
-- generator. Only the SECURITY DEFINER functions below read or write it.
create table private.analytics_usage_digests (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  period text not null
    constraint analytics_usage_digests_period_check check (period in ('weekly', 'monthly')),
  window_start date not null,
  window_end date not null,
  buckets jsonb not null default '[]'::jsonb
    constraint analytics_usage_digests_buckets_shape
    check (pg_catalog.jsonb_typeof(buckets) = 'array' and pg_catalog.octet_length(buckets::text) <= 8192),
  deltas jsonb not null default '[]'::jsonb
    constraint analytics_usage_digests_deltas_shape
    check (pg_catalog.jsonb_typeof(deltas) = 'array' and pg_catalog.octet_length(deltas::text) <= 2048),
  has_data boolean not null default false,
  ai_status text not null default 'not_requested'
    constraint analytics_usage_digests_ai_status_check
    check (ai_status in ('not_requested', 'available', 'enriched')),
  ai_summary jsonb
    constraint analytics_usage_digests_ai_summary_shape
    check (ai_summary is null or (pg_catalog.jsonb_typeof(ai_summary) = 'object' and pg_catalog.octet_length(ai_summary::text) <= 4096)),
  ai_model text
    constraint analytics_usage_digests_ai_model_bounded
    check (ai_model is null or pg_catalog.char_length(ai_model) between 1 and 160),
  generated_at timestamptz not null default pg_catalog.now(),
  enriched_at timestamptz,
  constraint analytics_usage_digests_window_order check (window_start <= window_end),
  constraint analytics_usage_digests_enrichment_coherent check (
    (ai_status = 'enriched') = (ai_summary is not null and enriched_at is not null)
  ),
  constraint analytics_usage_digests_one_per_window unique (organization_id, period, window_start)
);

create index analytics_usage_digests_recent_idx
  on private.analytics_usage_digests (organization_id, period, window_end desc);

revoke all on table private.analytics_usage_digests from public, anon, authenticated, service_role;

comment on table private.analytics_usage_digests is
  'REQ-UG-AI-USAGE-DIGEST-20261001: regenerable aggregate-only usage trend digest per organization and period. Counts and coarse segments only, no person, no identifier, no foreign key; written by private.generate_analytics_usage_digests and read through public.get_analytics_usage_digests.';

-- Per-window generation progress. Every organization the generator visits for
-- a window is recorded, whether or not a digest passed the privacy floor, so
-- each continuation batch moves on to organizations not yet visited. It holds
-- only an organization id, a period and a window; rows older than sixteen
-- weeks are pruned, which still covers the oldest fixed four-week block.
create table private.analytics_usage_digest_visits (
  organization_id uuid not null,
  period text not null
    constraint analytics_usage_digest_visits_period_check check (period in ('weekly', 'monthly')),
  window_start date not null,
  visited_at timestamptz not null default pg_catalog.now(),
  constraint analytics_usage_digest_visits_pkey primary key (organization_id, period, window_start)
);

revoke all on table private.analytics_usage_digest_visits from public, anon, authenticated, service_role;

comment on table private.analytics_usage_digest_visits is
  'REQ-UG-AI-USAGE-DIGEST-20261001: one row per organization, period and window the digest generator has visited, so bounded continuation batches never starve an organization.';

-- ---------------------------------------------------------------------------
-- Pure helpers
-- ---------------------------------------------------------------------------

-- The Monday that opens the fixed four-week block holding p_day. Blocks are
-- counted in 28-day steps from 2024-01-01, itself a Monday, so a block is
-- always exactly four ISO calendar weeks and the grid never shifts with the
-- day a release happens to run ( = A, October 10, 2026).
create function private.usage_digest_block_start(p_day date)
returns date
language sql
immutable
security definer
set search_path = ''
as $function$
  select date '2024-01-01' + (pg_catalog.floor((p_day - date '2024-01-01') / 28.0)::integer * 28)
$function$;

comment on function private.usage_digest_block_start(date) is
  'REQ-UG-AI-USAGE-DIGEST-20261001: start of the fixed four-ISO-week block holding a day, counted in 28-day steps from the Monday epoch 2024-01-01.';

-- Bucket windows, oldest first, all UTC, and every window is a whole number of
-- ISO calendar weeks taken from one fixed grid. weekly: the four completed ISO
-- weeks before the current one (de7df4b57c^:lib/analytics/usage-digest.ts:118-131).
-- monthly: the two completed four-week blocks before the block holding today,
-- so each monthly window is exactly four ISO weeks and every generation inside
-- the same block asks for the same two windows. The earlier rolling 28-day
-- windows moved with the generation date, which let a reader subtract one
-- release's totals from the next release's partly overlapping totals and
-- recover a cohort that both digests had suppressed; nothing here depends on
-- the release history or on the weekday the generator runs (owner decision
-- Q40 = A, October 10, 2026). The oldest window reaches at most 84 days back,
-- inside the 90-day engagement-event retention minimum. Page views can be
-- pruned after 30 days, so a window that comes back in a later release is
-- never recomputed: the generator reuses the bucket it first stored for that
-- interval, and a recount over pruned totals cannot be subtracted from it.
create function private.usage_digest_windows(p_period text, p_now timestamptz)
returns table (bucket_start date, bucket_end date)
language sql
immutable
security definer
set search_path = ''
as $function$
  select w.bucket_start, w.bucket_end
  from (
    select
      case when p_period = 'weekly'
        then (pg_catalog.date_trunc('week', (p_now at time zone 'UTC'))::date - (offsets.n * 7))
        else (private.usage_digest_block_start((p_now at time zone 'UTC')::date) - (offsets.n * 28))
      end as bucket_start,
      case when p_period = 'weekly'
        then (pg_catalog.date_trunc('week', (p_now at time zone 'UTC'))::date - ((offsets.n - 1) * 7) - 1)
        else (private.usage_digest_block_start((p_now at time zone 'UTC')::date) - ((offsets.n - 1) * 28) - 1)
      end as bucket_end
    from pg_catalog.generate_series(case when p_period = 'weekly' then 4 else 2 end, 1, -1) as offsets(n)
    where p_period in ('weekly', 'monthly')
  ) w
$function$;

comment on function private.usage_digest_windows(text, timestamptz) is
  'REQ-UG-AI-USAGE-DIGEST-20261001: oldest-first completed bucket windows in UTC on one fixed ISO-week grid — four ISO weeks for weekly, two completed four-week blocks for monthly, never a window anchored on the release date.';

-- The first two path segments, so per-record routes aggregate into a section
-- (de7df4b57c^:lib/analytics/usage-digest.ts:177-182).
create function private.usage_digest_section(p_path text)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select coalesce(nullif('/' || pg_catalog.array_to_string(
    (pg_catalog.string_to_array(pg_catalog.btrim(pg_catalog.split_part(pg_catalog.split_part(coalesce(p_path, ''), '?', 1), '#', 1), '/'), '/'))[1:2],
    '/'), '/'), '/')
$function$;

comment on function private.usage_digest_section(text) is
  'REQ-UG-AI-USAGE-DIGEST-20261001: collapses a page key to its first two path segments so per-record routes aggregate.';

-- Published totals are floored to a multiple of five, exactly as the live
-- analytics reader publishes usageViews.
create function private.usage_digest_floored(p_count bigint)
returns integer
language sql
immutable
security definer
set search_path = ''
as $function$
  select (pg_catalog.floor(coalesce(p_count, 0) / 5.0) * 5)::integer
$function$;

create function private.usage_digest_direction(p_current integer, p_previous integer)
returns text
language sql
immutable
security definer
set search_path = ''
as $function$
  select case
    when p_current is null or p_previous is null then 'unknown'
    when p_current > p_previous then 'up'
    when p_current < p_previous then 'down'
    else 'flat'
  end
$function$;

-- ---------------------------------------------------------------------------
-- One bucket of aggregates
-- ---------------------------------------------------------------------------

-- Counts for one window of one organization. public.organization_page_views
-- carries no member identifier; distinct actors and meeting check-ins are
-- counted from public.organization_engagement_events and leave this function
-- as counts only. The bucket publishes nothing at all unless its own
-- distinct-actor cohort reaches the floor; a segment is published only when
-- its own distinct-actor count reaches the floor. Roles cannot be attributed
-- from page-view events, so role breakdowns are withheld entirely.
create function private.usage_digest_bucket(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_floor integer,
  p_sections integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  floor_size integer := greatest(25, coalesce(p_floor, 25));
  section_limit integer := greatest(1, least(coalesce(p_sections, 5), 12));
  views bigint;
  actors bigint;
  checkins bigint;
  hats jsonb;
  sections jsonb;
  hidden_hats integer;
  hidden_sections integer;
begin
  select coalesce(pg_catalog.sum(v.view_count), 0) into views
  from public.organization_page_views v
  where v.organization_id = p_organization_id and v.day >= p_start and v.day <= p_end;

  select pg_catalog.count(distinct e.user_id) into actors
  from public.organization_engagement_events e
  where e.organization_id = p_organization_id and e.event_type = 'page_view'
    and e.occurred_at >= (p_start::timestamp at time zone 'UTC') and e.occurred_at < ((p_end + 1)::timestamp at time zone 'UTC');

  select pg_catalog.count(*) into checkins
  from public.organization_engagement_events e
  where e.organization_id = p_organization_id and e.event_type = 'meeting_check_in'
    and e.occurred_at >= (p_start::timestamp at time zone 'UTC') and e.occurred_at < ((p_end + 1)::timestamp at time zone 'UTC');

  if actors < floor_size then
    return pg_catalog.jsonb_build_object(
      'start', p_start, 'end', p_end, 'suppressed', true, 'minCohort', floor_size,
      'views', null, 'actors', null, 'checkins', null,
      'byHat', '[]'::jsonb, 'topSections', '[]'::jsonb,
      'suppressedHats', 0, 'suppressedSections', 0
    );
  end if;

  -- Events do not record the selected hat; no person floor can be proved
  -- for a role row, even when that role generated many requests.
  hats := '[]'::jsonb;
  select pg_catalog.count(distinct v.hat) into hidden_hats
  from public.organization_page_views v
  where v.organization_id = p_organization_id and v.day between p_start and p_end;

  with grouped as (
    select private.usage_digest_section(v.path) as key, pg_catalog.sum(v.view_count) as total
    from public.organization_page_views v
    where v.organization_id = p_organization_id and v.day between p_start and p_end
    group by private.usage_digest_section(v.path)
  ), people as (
    select private.usage_digest_section(pg_catalog.split_part(e.source_id, '|', 1)) as key,
      pg_catalog.count(distinct e.user_id) as actors
    from public.organization_engagement_events e
    where e.organization_id = p_organization_id and e.event_type = 'page_view'
      and e.occurred_at >= (p_start::timestamp at time zone 'UTC')
      and e.occurred_at < ((p_end + 1)::timestamp at time zone 'UTC')
    group by private.usage_digest_section(pg_catalog.split_part(e.source_id, '|', 1))
  ), ranked as (
    select g.*, coalesce(p.actors, 0) as people,
      pg_catalog.row_number() over (order by g.total desc, g.key) as rank
    from grouped g left join people p using (key)
  )
  select coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('key', r.key, 'views', private.usage_digest_floored(r.total))
      order by r.total desc, r.key) filter (where r.people >= floor_size and r.rank <= section_limit), '[]'::jsonb),
    pg_catalog.count(*) filter (where r.people < floor_size or r.rank > section_limit)
  into sections, hidden_sections
  from ranked r;

  -- Publishing the total alongside any hidden section would reveal the
  -- remainder by subtraction. Withhold the section breakdown as a whole.
  if hidden_sections > 0 then
    select pg_catalog.count(distinct private.usage_digest_section(v.path)) into hidden_sections
    from public.organization_page_views v
    where v.organization_id = p_organization_id and v.day between p_start and p_end;
    sections := '[]'::jsonb;
  end if;

  return pg_catalog.jsonb_build_object(
    'start', p_start, 'end', p_end, 'suppressed', false, 'minCohort', floor_size,
    'views', private.usage_digest_floored(views),
    'actors', private.usage_digest_floored(actors),
    'checkins', private.usage_digest_floored(checkins),
    'byHat', hats, 'topSections', sections,
    'suppressedHats', coalesce(hidden_hats, 0),
    'suppressedSections', coalesce(hidden_sections, 0)
  );
end;
$function$;

comment on function private.usage_digest_bucket(uuid, date, date, integer, integer) is
  'REQ-UG-AI-USAGE-DIGEST-20261001: aggregate counts for one digest window — suppressed entirely below the distinct-actor floor, every published total floored to five, segments below the floor counted but never disclosed.';

-- Windows are whole numbers of ISO calendar weeks on one fixed grid, so an
-- inner week of a wider window either reaches the floor on its own -- in which
-- case some weekly digest publishes it and a reader can subtract it from this
-- window -- or it never publishes at all. The actors left after removing every
-- separately publishable inner week are therefore the cohort this window
-- discloses beyond its parts, and that cohort must itself reach the floor.
-- Deciding it from the weeks' own counts needs no record of what earlier
-- releases published, which is why the windows above never move with the
-- release date ( = A, October 10, 2026).
create function private.usage_digest_window_publishable(
  p_organization_id uuid,
  p_start date,
  p_end date,
  p_floor integer
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
      where e.organization_id = p_organization_id and e.event_type = 'page_view'
        and e.occurred_at >= (weeks.week_start::timestamp at time zone 'UTC')
        and e.occurred_at < ((weeks.week_end + 1)::timestamp at time zone 'UTC')
    ) as actors
    from weeks
  ), publishable_weeks as (
    select counted.week_start, counted.week_end
    from counted
    -- 25 is the lowest floor any setting can produce, so a week at 25 may be
    -- published by a later weekly digest even when today's floor is higher.
    where counted.actors >= 25
      and not (counted.week_start = p_start and counted.week_end = p_end)
  )
  -- Remove people, not just their events: someone active in a publishable week
  -- is already in that week's published total, so subtracting it from this
  -- window takes them out even when they were also active in a quieter week.
  select (
    select pg_catalog.count(distinct e.user_id)
    from public.organization_engagement_events e
    where e.organization_id = p_organization_id and e.event_type = 'page_view'
      and e.occurred_at >= (p_start::timestamp at time zone 'UTC')
      and e.occurred_at < ((p_end + 1)::timestamp at time zone 'UTC')
      and not exists (
        select 1
        from public.organization_engagement_events p
        join publishable_weeks w
          on p.occurred_at >= (w.week_start::timestamp at time zone 'UTC')
          and p.occurred_at < ((w.week_end + 1)::timestamp at time zone 'UTC')
        where p.organization_id = p_organization_id and p.event_type = 'page_view'
          and p.user_id = e.user_id
      )
  ) >= greatest(25, coalesce(p_floor, 25))
$function$;

comment on function private.usage_digest_window_publishable(uuid, date, date, integer) is
  'REQ-UG-AI-USAGE-DIGEST-20261001: true when the actors a digest window adds beyond every separately publishable ISO week inside it still reach the distinct-actor floor, so no arithmetic over published windows, in one release or across releases, can recover a suppressed cohort.';

-- ---------------------------------------------------------------------------
-- Generation (pg_cron)
-- ---------------------------------------------------------------------------

-- Stores the weekly and monthly digest for up to p_limit organizations not yet
-- visited for the current window. Idempotent: a window already stored for an
-- organization and period is never rewritten. It acts from 9 AM
-- America/New_York; pg_cron calls it through the rest of the day so bounded
-- continuation batches visit every eligible organization. Outside that window
-- it does nothing unless p_force (used only by tests and operators). Returns
-- the number of digests inserted.
create function private.generate_analytics_usage_digests(
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
  section_limit integer;
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
    section_limit := coalesce(private.organization_limit(org.id, 'limits.analytics.ai_usage_digest_sections'), 5);
    foreach period in array array['weekly', 'monthly'] loop
      buckets := '[]'::jsonb;
      deltas := '[]'::jsonb;
      first_start := null;
      last_end := null;
      for window_row in select w.bucket_start, w.bucket_end from private.usage_digest_windows(period, p_now) w order by w.bucket_start loop
        -- An interval stored by an earlier release keeps its first figures
        -- and suppression decision: a recount after page-view retention or a
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
        if coalesce((bucket ->> 'minCohort')::integer, 0) < floor_size then
          bucket := bucket || pg_catalog.jsonb_build_object(
            'minCohort', floor_size, 'suppressed', true, 'views', null, 'actors', null, 'checkins', null,
            'byHat', '[]'::jsonb, 'topSections', '[]'::jsonb,
            'suppressedHats', 0, 'suppressedSections', 0);
        end if;
        if bucket is null then
          bucket := private.usage_digest_bucket(org.id, window_row.bucket_start, window_row.bucket_end, floor_size, section_limit);
          -- A bucket that passed its own floor still goes dark when the cohort
          -- it adds beyond its separately publishable inner weeks is under the
          -- floor: that remainder would otherwise follow from subtracting the
          -- weekly digests from this one, across releases as easily as inside a
          -- single run ( = A, October 10, 2026).
          if (bucket ->> 'suppressed')::boolean is false
            and not private.usage_digest_window_publishable(org.id, window_row.bucket_start, window_row.bucket_end, floor_size) then
            bucket := bucket || pg_catalog.jsonb_build_object(
              'suppressed', true, 'views', null, 'actors', null, 'checkins', null,
              'byHat', '[]'::jsonb, 'topSections', '[]'::jsonb,
              'suppressedHats', 0, 'suppressedSections', 0);
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
      -- (de7df4b57c^:lib/analytics/usage-digest.ts deltas). A suppressed
      -- bucket on either side reports direction 'unknown' and no figures.
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
          from pg_catalog.unnest(array['views', 'actors', 'checkins']) with ordinality as metric(name, ordinality)
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 1) as value) current_bucket
          cross join lateral (select buckets -> (pg_catalog.jsonb_array_length(buckets) - 2) as value) previous_bucket
        );
      end if;
      has_data := exists (
        select 1 from pg_catalog.jsonb_array_elements(buckets) element
        where (element.value ->> 'suppressed')::boolean is false
          and (element.value ->> 'views')::integer > 0
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
  'Bounded pg_cron target (REQ-UG-AI-USAGE-DIGEST-20261001): from 9 AM America/New_York in continuation batches, one weekly and one monthly aggregate digest per opted-in organization, every visit recorded so no organization is starved, privacy floor never below 25, idempotent.';

-- ---------------------------------------------------------------------------
-- Staff read and Compass wording
-- ---------------------------------------------------------------------------

-- The organization AI switch is owned by REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001.
-- Until that definition exists the Compass wording stays off (never an error).
create function private.usage_digest_ai_assistant_enabled(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (select 1 from public.platform_setting_definitions d where d.key = 'features.ai_assistant.enabled')
    and private.organization_feature_enabled(p_organization_id, 'features.ai_assistant.enabled')
$function$;

-- The record names admins, stewards and chapter advisors. The digest lives in
-- organization analytics, which already opens for the same staff hats, so the
-- hat set here is the analytics staff set and nothing wider: every one of
-- these hats already reads the same page-view aggregates at this floor
-- through public.get_organization_analytics_snapshot.
create function private.usage_digest_staff_organization(p_selected_hat text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp') then
    raise exception 'staff hat required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array[hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create function private.usage_digest_projection(d private.analytics_usage_digests, p_ai_allowed boolean)
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
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'start', b -> 'start', 'end', b -> 'end', 'minCohort', checked.floor_size,
        'suppressed', true, 'views', null, 'actors', null, 'checkins', null,
        'byHat', '[]'::jsonb, 'topSections', '[]'::jsonb,
        'suppressedHats', 0, 'suppressedSections', 0))
      from pg_catalog.jsonb_array_elements(d.buckets) b
    ) end,
    'deltas', case when checked.current then d.deltas else '[]'::jsonb end,
    'hasData', checked.current and d.has_data,
    'generatedAt', d.generated_at,
    'ai', pg_catalog.jsonb_build_object(
      -- Current eligibility decides both what is offered and what is shown.
      -- A digest generated while the wording switch was off stored
      -- not_requested, so turning the switch on does not wait for the next
      -- window; on the fixed grid the next monthly window can be four weeks
      -- away. Turning the switch back off hides wording that is already
      -- stored instead of leaving the last enriched summary readable.
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

-- Latest stored digest per period for the caller's organization. The digest
-- switch hides stored rows from staff when it is turned off, so turning the
-- switch off makes the behavior inert rather than merely hidden in the client.
create function public.get_analytics_usage_digests(p_selected_hat text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.usage_digest_staff_organization(p_selected_hat);
  ai_allowed boolean;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.analytics.ai_usage_digest') then
    return pg_catalog.jsonb_build_object('enabled', false, 'digests', '[]'::jsonb);
  end if;
  ai_allowed := private.organization_feature_enabled(org, 'features.analytics.ai_usage_digest_wording')
    and private.usage_digest_ai_assistant_enabled(org);
  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'minCohort', greatest(25, coalesce(private.organization_limit(org, 'limits.analytics.ai_usage_digest_min_cohort'), 25),
      coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25)),
    'digests', coalesce((
      select pg_catalog.jsonb_agg(private.usage_digest_projection(latest.digest, ai_allowed)
        order by case latest.period when 'weekly' then 0 else 1 end)
      from (
        select distinct on (d.period) d.period as period, d as digest
        from private.analytics_usage_digests d
        where d.organization_id = org
        order by d.period, d.window_end desc, d.generated_at desc
      ) latest
    ), '[]'::jsonb)
  );
end;
$function$;

-- api/guide.js (mode usage_digest) asks for the aggregate-only payload with
-- the staff member's own token. Refuses unless the digest belongs to the
-- caller's organization, both switches are on and it is not worded yet.
create function public.authorize_analytics_usage_digest_ai(p_selected_hat text, p_digest_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.usage_digest_staff_organization(p_selected_hat);
  digest private.analytics_usage_digests%rowtype;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into digest from private.analytics_usage_digests d
  where d.id = p_digest_id and d.organization_id = org;
  if not found then
    raise exception 'digest not found' using errcode = 'P0002';
  end if;
  if not private.organization_feature_enabled(org, 'features.analytics.ai_usage_digest')
     or not private.organization_feature_enabled(org, 'features.analytics.ai_usage_digest_wording')
     or not private.usage_digest_ai_assistant_enabled(org) then
    raise exception 'compass usage digest wording is turned off' using errcode = '42501';
  end if;
  if digest.ai_status not in ('available', 'not_requested')
     or not (private.usage_digest_projection(digest, true) -> 'hasData')::boolean then
    raise exception 'digest wording unavailable' using errcode = '22023';
  end if;
  -- organizationId is the digest's own organization. api/guide.js binds the
  -- governed dispatch (primary and failover) to it and never sends it to the
  -- model, so a workspace switch after this read cannot carry the aggregate
  -- into another organization's reservation.
  return pg_catalog.jsonb_build_object(
    'digestId', digest.id,
    'organizationId', digest.organization_id,
    'period', digest.period,
    'windowStart', digest.window_start,
    'windowEnd', digest.window_end,
    'buckets', digest.buckets,
    'deltas', digest.deltas
  );
end;
$function$;

-- Stores validated Compass wording once. api/guide.js calls it with the staff
-- member's token after the governed completion succeeds.
create function public.save_analytics_usage_digest_ai(
  p_selected_hat text,
  p_digest_id uuid,
  p_summary text,
  p_highlights text[],
  p_caution text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.usage_digest_staff_organization(p_selected_hat);
  saved private.analytics_usage_digests%rowtype;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.analytics.ai_usage_digest')
     or not private.organization_feature_enabled(org, 'features.analytics.ai_usage_digest_wording')
     or not private.usage_digest_ai_assistant_enabled(org) then
    raise exception 'compass usage digest wording is turned off' using errcode = '42501';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 20 and 600
     or p_summary ~ '[[:cntrl:]]'
     or pg_catalog.cardinality(coalesce(p_highlights, array[]::text[])) > 3
     or exists (select 1 from pg_catalog.unnest(coalesce(p_highlights, array[]::text[])) item
       where pg_catalog.char_length(pg_catalog.btrim(item)) not between 4 and 160 or item ~ '[[:cntrl:]]')
     or (p_caution is not null and (pg_catalog.char_length(pg_catalog.btrim(p_caution)) not between 4 and 200 or p_caution ~ '[[:cntrl:]]'))
     or p_model is null or pg_catalog.char_length(p_model) not between 1 and 160 then
    raise exception 'invalid digest wording' using errcode = '22023';
  end if;
  update private.analytics_usage_digests d
  set ai_status = 'enriched',
      ai_summary = pg_catalog.jsonb_build_object(
        'summary', pg_catalog.btrim(p_summary),
        'highlights', pg_catalog.to_jsonb(coalesce(p_highlights, array[]::text[])),
        'caution', nullif(pg_catalog.btrim(coalesce(p_caution, '')), '')
      ),
      ai_model = p_model,
      enriched_at = pg_catalog.now()
  where d.id = p_digest_id and d.organization_id = org and d.ai_status in ('available', 'not_requested')
    and (private.usage_digest_projection(d, true) -> 'hasData')::boolean
  returning d.* into saved;
  if saved.id is null then
    raise exception 'digest wording unavailable' using errcode = '22023';
  end if;
  return private.usage_digest_projection(saved, true);
end;
$function$;

revoke all on function private.usage_digest_block_start(date) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_windows(text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_window_publishable(uuid, date, date, integer) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_section(text) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_floored(bigint) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_direction(integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_bucket(uuid, date, date, integer, integer) from public, anon, authenticated, service_role;
revoke all on function private.generate_analytics_usage_digests(timestamptz, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_ai_assistant_enabled(uuid) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_staff_organization(text) from public, anon, authenticated, service_role;
revoke all on function private.usage_digest_projection(private.analytics_usage_digests, boolean) from public, anon, authenticated, service_role;
revoke all on function public.get_analytics_usage_digests(text) from public, anon, authenticated, service_role;
revoke all on function public.authorize_analytics_usage_digest_ai(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_analytics_usage_digest_ai(text, uuid, text, text[], text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_analytics_usage_digests(text) to authenticated;
grant execute on function public.authorize_analytics_usage_digest_ai(text, uuid) to authenticated;
grant execute on function public.save_analytics_usage_digest_ai(text, uuid, text, text[], text, text) to authenticated;

-- The old cron ran weekly (de7df4b57c^:app/api/cron/usage-trend-digest/route.ts
-- suggested Mondays 13:30 UTC, with the rolling monthly window refreshed on
-- the same cadence). Here the job fires every twenty minutes from 13:00 to
-- 23:40 UTC every day; the function acts only from 9 AM America/New_York and
-- skips any organization already visited for the current window, so the first
-- batch lands at 9 AM ET all year, later batches continue with organizations
-- not yet visited, and a new week's windows are picked up the morning they
-- complete. Each run is bounded to 200 organizations.
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'analytics-usage-digest';
  perform cron.schedule('analytics-usage-digest', '*/20 13-23 * * *', 'select private.generate_analytics_usage_digests(pg_catalog.now(), 200, false)');
end;
$block$;

notify pgrst, 'reload schema';

-- Carry the new schedule into every job-health registry without changing
-- the existing bounded mirror, lifecycle lock or staff authorization.
alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in ('account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick'));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
-- Generic plans overestimate the moving cron window; compiling that estimate
-- costs more than the indexed work. This setting is local to this routine.
set jit = off
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  --
  -- One tick mirrors at most 2,000 pending runs, oldest start first (ties by
  -- run id), so a cold or lagging mirror catches up across ticks instead of
  -- writing fourteen days of history in one transaction under the lifecycle
  -- gate. Taking the oldest first keeps the newest-start watermark honest:
  -- this tick's newest mirrored start is no later than any run it left
  -- pending, so every left-over run stays inside the next tick's window. Open
  -- runs are re-read whatever their start, so late completions still land.
  -- Each tick is one transaction and one batch; nothing loops here.
  with candidate as (
    select j.jobname as job_name,
      d.runid as cron_runid,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in ('analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick') and (d.start_time >= window_start or d.runid = any(open_runs))
  ), pending as (
    select c.*
    from candidate c
    left join lateral (
      -- The unique (job_name, run_id, organization_id) identity admits at
      -- most one row. Keep this a candidate lookup: a merge/hash join may read
      -- the entire retained mirror while the lifecycle gate is held.
      select existing.*
      from public.organization_job_runs existing
      where existing.job_name = c.job_name
        and existing.run_id = c.run_id
        and existing.organization_id is null
      limit 1
    ) mirrored on true
    where mirrored.id is null
       or mirrored.status is distinct from c.status
       or mirrored.finished_at is distinct from c.finished_at
       or mirrored.failure_code is distinct from c.failure_code
       or mirrored.redacted_summary is distinct from c.redacted_summary
    order by c.started_at, c.cron_runid
    limit 2000
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, p.job_name, p.run_id, p.status, p.started_at, p.finished_at,
    p.failure_code, p.redacted_summary
  from pending p
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array['account-deletion-reconcile-tick', 'analytics-usage-digest', 'appointment-reminders-tick', 'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick', 'casework-alert-escalation-tick', 'casework-deadline-reminder-tick', 'casework-reminder-delivery-tick', 'casework-retaliation-timing-tick', 'casework-ulp-deadline-tick', 'chapter-leadership-claims-tick', 'deadline-notices-tick', 'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick', 'event-checkin-token-retention', 'event-notices-tick', 'integration-webhooks-dispatch-tick', 'issue-intelligence-weekly-digest', 'knowledge-source-health-tick', 'live-poll-schedule-tick', 'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick', 'mi1-analytics-receipt-retention', 'mi1-public-rsvp-retention', 'minutes-pre-event-notices-tick', 'notifications-dispatch-tick', 'notifications-expiry-sweep', 'organization-automation-tick', 'organization-claim-retention', 'sso-identity-link-sweep', 'survey-operations-sweep', 'task-files-reconcile-tick', 'task-maintenance-daily', 'union-ground-organization-retention', 'weekly-question-selection-tick', 'workload-reminders-tick']) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

commit;
