-- REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001
--
-- Restores the old weekly issue-intelligence digest
-- (de7df4b57c^:app/api/cron/issue-intelligence-weekly/route.ts,
-- lib/issue-threads/weekly-digest.ts, weekly-digest-store.ts,
-- weekly-digest-ai.ts, supabase/migrations/0259_issue_intelligence_weekly_digest.sql):
-- every Monday at 9 AM America/New_York a stored digest is generated for the
-- completed week, per organization and per enabled issue family, with
-- deterministic recommendations (publish an explainer, brief stewards, run a
-- poll). Staff read it next to the issue-intelligence panel.
--
-- Adaptations:
--   * Organization-scoped rows (the old table was single-tenant). The same
--     privacy floor as the live signals applies
--     (REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001): a family below
--     limits.intelligence.issue_signal_min_segment (never below 15) produces
--     no digest at all.
--   * Evidence is stored as coarse bands (few / several / many), never exact
--     counts, people or text.
--   * The optional Compass summary is requested by staff from the digest and
--     runs through the existing governed server path (api/guide.js, mode
--     issue_digest, quota reservation and dispatch authorization). It needs
--     features.intelligence.weekly_digest_ai AND the organization AI switch
--     features.ai_assistant.enabled; otherwise the digest stays deterministic.
--     Only the stored aggregate (family, window, confidence, trend, bands,
--     recommendation kinds) crosses the provider boundary.
--
-- Defaults are the old app's effective production defaults (0259):
--   features.intelligence.weekly_digest = false     (0259:52 issue_intelligence_weekly_digest_enabled)
--   features.intelligence.weekly_digest_ai = false  (0259:53 issue_intelligence_ai_digest_enabled)
--   limits.intelligence.digest_max_recommendations = 3 (0259:55)

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.intelligence.weekly_digest', 'boolean', 'Weekly issue digest',
   'Every Monday at 9 AM Eastern, store a staff digest of last week''s issue patterns with recommended next steps.',
   'false', null, null, null, 50, 'intelligence', false),
  ('features.intelligence.weekly_digest_ai', 'boolean', 'Compass summary for the weekly digest',
   'Let staff add a Compass summary to a weekly digest. Needs the organization AI assistant switch; only aggregate digest facts are sent.',
   'false', null, null, null, 60, 'intelligence', false),
  ('limits.intelligence.digest_max_recommendations', 'integer', 'Digest recommendations',
   'Most recommended next steps shown in one weekly digest.',
   '3', 0, 3, null, 70, 'intelligence', false)
on conflict (key) do nothing;

-- A derived, regenerable aggregate cache. It names no person and carries no
-- foreign key, so it sits outside the account case graph; rows of an
-- organization that no longer exists are removed by the generator. Only the
-- SECURITY DEFINER functions below read or write it.
create table private.issue_intelligence_weekly_digests (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null,
  window_start date not null,
  window_end date not null,
  thread_family text not null
    constraint issue_intelligence_weekly_digests_family_check
    check (thread_family in ('contract_rights_confusion', 'retaliation_protected_activity_pressure')),
  confidence_label text not null
    constraint issue_intelligence_weekly_digests_confidence_check
    check (confidence_label in ('low', 'medium', 'high')),
  trend text not null
    constraint issue_intelligence_weekly_digests_trend_check
    check (trend in ('rising', 'stable', 'declining')),
  evidence jsonb not null default '{}'::jsonb
    constraint issue_intelligence_weekly_digests_evidence_shape
    check (pg_catalog.jsonb_typeof(evidence) = 'object' and pg_catalog.octet_length(evidence::text) <= 2048),
  recommendations text[] not null default array[]::text[]
    constraint issue_intelligence_weekly_digests_recommendations_check
    check (recommendations <@ array['publish_explainer', 'brief_stewards', 'run_full_poll']::text[]
      and pg_catalog.cardinality(recommendations) <= 3),
  ai_status text not null default 'not_requested'
    constraint issue_intelligence_weekly_digests_ai_status_check
    check (ai_status in ('not_requested', 'available', 'enriched')),
  ai_summary jsonb
    constraint issue_intelligence_weekly_digests_ai_summary_shape
    check (ai_summary is null or (pg_catalog.jsonb_typeof(ai_summary) = 'object' and pg_catalog.octet_length(ai_summary::text) <= 4096)),
  ai_model text
    constraint issue_intelligence_weekly_digests_ai_model_bounded
    check (ai_model is null or pg_catalog.char_length(ai_model) between 1 and 160),
  generated_at timestamptz not null default pg_catalog.now(),
  enriched_at timestamptz,
  constraint issue_intelligence_weekly_digests_window_order check (window_start <= window_end),
  constraint issue_intelligence_weekly_digests_enrichment_coherent check (
    (ai_status = 'enriched') = (ai_summary is not null and enriched_at is not null)
  ),
  constraint issue_intelligence_weekly_digests_one_per_week unique (organization_id, window_start, thread_family)
);

create index issue_intelligence_weekly_digests_recent_idx
  on private.issue_intelligence_weekly_digests (organization_id, window_end desc);

-- Per-week generation progress. Every organization the generator has visited
-- for a completed week is recorded here, whether or not a family passed the
-- privacy floor, so each continuation batch moves on to organizations not yet
-- visited and no organization is starved behind the first batch. It holds
-- only an organization id and a week; rows older than eight weeks are pruned.
create table private.issue_intelligence_digest_visits (
  organization_id uuid not null,
  window_start date not null,
  visited_at timestamptz not null default pg_catalog.now(),
  constraint issue_intelligence_digest_visits_pkey primary key (organization_id, window_start)
);

revoke all on table private.issue_intelligence_digest_visits from public, anon, authenticated, service_role;

comment on table private.issue_intelligence_digest_visits is
  'REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001: which organizations the weekly digest generator has visited for a completed week (digest or not), so bounded continuation batches reach every eligible organization.';

revoke all on table private.issue_intelligence_weekly_digests from public, anon, authenticated, service_role;

comment on table private.issue_intelligence_weekly_digests is
  'REQ-UG-ISSUE-INTELLIGENCE-WEEKLY-DIGEST-20261001: one stored digest per organization, completed week and issue family. Aggregate bands only; no people, counts or text.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Coarse evidence band: the digest never stores an exact count.
create function private.issue_digest_band(p_count integer)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when coalesce(p_count, 0) <= 0 then null
    when p_count < 5 then 'few'
    when p_count < 15 then 'several'
    else 'many' end
$function$;

-- The completed Monday-Sunday week in America/New_York before p_now.
create function private.issue_digest_completed_week(p_now timestamptz)
returns table (window_start date, window_end date, ends_at timestamptz)
language sql
stable
set search_path = ''
as $function$
  with local_day as (
    select (coalesce(p_now, pg_catalog.now()) at time zone 'America/New_York')::date as today
  ),
  bounds as (
    select (today - ((pg_catalog.date_part('isodow', today)::integer - 1)))::date as this_monday
    from local_day
  )
  select this_monday - 7, this_monday - 1,
    (this_monday::timestamp at time zone 'America/New_York')
  from bounds
$function$;

-- Old buildRecommendations (weekly-digest.ts:118-160), in its order.
create function private.issue_digest_recommendations(p_signal jsonb, p_limit integer)
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select coalesce((
    select pg_catalog.array_agg(kind order by position)
    from (
      select kind, position
      from (values
        ('publish_explainer', 1, (p_signal -> 'evidenceFamilies') ?| array['qa', 'reviewed_themes']),
        ('brief_stewards', 2, (p_signal -> 'evidenceFamilies') ?| array['messages', 'cases', 'retaliation_reports', 'kyr']),
        ('run_full_poll', 3, p_signal ->> 'confidence' = 'strong')
      ) as candidate(kind, position, applies)
      where applies
      order by position
      limit greatest(0, least(3, coalesce(p_limit, 3)))
    ) chosen
  ), array[]::text[])
$function$;

-- ---------------------------------------------------------------------------
-- Generation (pg_cron)
-- ---------------------------------------------------------------------------

-- Generates last week's digests for up to p_limit organizations not yet
-- visited for that week, and records each visit (digest or not). Idempotent:
-- a week already stored for an organization and family is never rewritten.
-- It acts on Monday from 9 AM America/New_York; pg_cron calls it every ten
-- minutes through the rest of Monday, so bounded continuation batches visit
-- every eligible organization. Outside that window it does nothing unless
-- p_force (used only by tests and operators). Returns the number of digests
-- inserted.
create function private.generate_issue_intelligence_weekly_digests(
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
  week record;
  org record;
  family text;
  signal jsonb;
  floor_size integer;
  inserted integer := 0;
  added integer;
begin
  if not coalesce(p_force, false)
     and (pg_catalog.date_part('isodow', local_now) <> 1 or pg_catalog.date_part('hour', local_now) < 9) then
    return 0;
  end if;
  select * into week from private.issue_digest_completed_week(p_now);
  delete from private.issue_intelligence_weekly_digests d
  where not exists (select 1 from public.organizations o where o.id = d.organization_id);
  delete from private.issue_intelligence_digest_visits v
  where v.window_start < week.window_start - 56
     or not exists (select 1 from public.organizations o where o.id = v.organization_id);

  for org in
    select o.id
    from public.organizations o
    where o.status = 'active'
      and private.organization_feature_enabled(o.id, 'features.intelligence.issue_signals')
      and private.organization_feature_enabled(o.id, 'features.intelligence.weekly_digest')
      and not exists (
        select 1 from private.issue_intelligence_digest_visits v
        where v.organization_id = o.id and v.window_start = week.window_start
      )
    order by o.id
    limit greatest(1, least(coalesce(p_limit, 200), 1000))
  loop
    insert into private.issue_intelligence_digest_visits (organization_id, window_start)
    values (org.id, week.window_start)
    on conflict on constraint issue_intelligence_digest_visits_pkey do nothing;
    floor_size := greatest(15, coalesce(private.organization_limit(org.id, 'limits.intelligence.issue_signal_min_segment'), 15));
    foreach family in array array['retaliation_protected_activity_pressure', 'contract_rights_confusion'] loop
      if family = 'retaliation_protected_activity_pressure'
         and not private.organization_feature_enabled(org.id, 'features.intelligence.issue_signals_retaliation_family') then
        continue;
      end if;
      if family = 'contract_rights_confusion'
         and not private.organization_feature_enabled(org.id, 'features.intelligence.issue_signals_contract_rights_family') then
        continue;
      end if;
      -- The old digest used the completed week as its window (weekly-digest-store.ts:259-276).
      signal := private.issue_intelligence_family_signal(org.id, family, week.ends_at, 7);
      if not (signal ->> 'active')::boolean or (signal ->> 'contributors')::integer < floor_size then
        continue;
      end if;
      insert into private.issue_intelligence_weekly_digests (
        organization_id, window_start, window_end, thread_family, confidence_label, trend, evidence, recommendations, ai_status
      ) values (
        org.id, week.window_start, week.window_end, family,
        case signal ->> 'confidence' when 'strong' then 'high' when 'active' then 'medium' else 'low' end,
        signal ->> 'trend',
        pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'evidenceFamilies', signal -> 'evidenceFamilies',
          'qa', private.issue_digest_band((signal #>> '{evidence,qa}')::integer),
          'messages', private.issue_digest_band((signal #>> '{evidence,messages}')::integer),
          'cases', private.issue_digest_band((signal #>> '{evidence,cases}')::integer),
          'polls', private.issue_digest_band((signal #>> '{evidence,polls}')::integer),
          'retaliationReports', private.issue_digest_band((signal #>> '{evidence,retaliationReports}')::integer),
          'kyr', private.issue_digest_band((signal #>> '{evidence,kyr}')::integer),
          'reviewedThemes', case when (signal #>> '{evidence,reviewedThemes}')::boolean then true end
        )),
        private.issue_digest_recommendations(signal, private.organization_limit(org.id, 'limits.intelligence.digest_max_recommendations')),
        case when private.organization_feature_enabled(org.id, 'features.intelligence.weekly_digest_ai')
          then 'available' else 'not_requested' end
      )
      on conflict on constraint issue_intelligence_weekly_digests_one_per_week do nothing;
      get diagnostics added = row_count;
      inserted := inserted + added;
    end loop;
  end loop;
  return inserted;
end;
$function$;

comment on function private.generate_issue_intelligence_weekly_digests(timestamptz, integer, boolean) is
  'Bounded pg_cron target: Monday from 9 AM America/New_York in continuation batches, last completed week, one digest per enabled family per opted-in organization, every visit recorded so no organization is starved, privacy floor enforced, idempotent.';

-- ---------------------------------------------------------------------------
-- Staff read and Compass enrichment
-- ---------------------------------------------------------------------------

-- The organization AI switch is owned by REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001.
-- Until that definition exists the Compass summary stays off (never an error).
create function private.issue_digest_ai_assistant_enabled(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (select 1 from public.platform_setting_definitions d where d.key = 'features.ai_assistant.enabled')
    and private.organization_feature_enabled(p_organization_id, 'features.ai_assistant.enabled')
$function$;

create function private.issue_digest_staff_organization(p_selected_hat text)
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
  if hat not in ('steward', 'coordinator', 'admin') then
    raise exception 'staff hat required' using errcode = '42501';
  end if;
  if not (
    private.has_organization_role(org, array[hat])
    or exists (
      select 1 from public.chapters c
      where c.organization_id = org and private.member_has_chapter_role(c.id, array[hat])
    )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return org;
end;
$function$;

create function private.issue_digest_projection(d private.issue_intelligence_weekly_digests, p_ai_allowed boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'id', d.id,
    'family', d.thread_family,
    'windowStart', d.window_start,
    'windowEnd', d.window_end,
    'confidence', d.confidence_label,
    'trend', d.trend,
    'evidence', d.evidence,
    'recommendations', pg_catalog.to_jsonb(d.recommendations),
    'generatedAt', d.generated_at,
    'ai', pg_catalog.jsonb_build_object(
      'status', case when d.ai_status = 'enriched' then 'enriched'
        when d.ai_status = 'available' and p_ai_allowed then 'available'
        else 'off' end,
      'summary', d.ai_summary,
      'model', d.ai_model,
      'enrichedAt', d.enriched_at
    )
  )
$function$;

-- Latest stored digest per family for the caller's organization. The weekly
-- digest switch hides stored rows from staff when it is turned off.
create function public.get_issue_intelligence_weekly_digests(p_selected_hat text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.issue_digest_staff_organization(p_selected_hat);
  ai_allowed boolean;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.intelligence.weekly_digest') then
    return pg_catalog.jsonb_build_object('enabled', false, 'digests', '[]'::jsonb);
  end if;
  ai_allowed := private.organization_feature_enabled(org, 'features.intelligence.weekly_digest_ai')
    and private.issue_digest_ai_assistant_enabled(org);
  return pg_catalog.jsonb_build_object(
    'enabled', true,
    'digests', coalesce((
      select pg_catalog.jsonb_agg(private.issue_digest_projection(latest.digest, ai_allowed)
        order by case latest.family when 'retaliation_protected_activity_pressure' then 0 else 1 end)
      from (
        select distinct on (d.thread_family) d.thread_family as family, d as digest
        from private.issue_intelligence_weekly_digests d
        where d.organization_id = org
        order by d.thread_family, d.window_end desc, d.generated_at desc
      ) latest
    ), '[]'::jsonb)
  );
end;
$function$;

-- api/guide.js (mode issue_digest) asks for the aggregate-only payload with
-- the staff member's own token. Refuses unless the digest belongs to the
-- caller's organization, both AI switches are on and it is not enriched yet.
create function public.authorize_issue_intelligence_digest_ai(p_selected_hat text, p_digest_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.issue_digest_staff_organization(p_selected_hat);
  digest private.issue_intelligence_weekly_digests%rowtype;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  select * into digest from private.issue_intelligence_weekly_digests d
  where d.id = p_digest_id and d.organization_id = org;
  if not found then
    raise exception 'digest not found' using errcode = 'P0002';
  end if;
  if not private.organization_feature_enabled(org, 'features.intelligence.weekly_digest')
     or not private.organization_feature_enabled(org, 'features.intelligence.weekly_digest_ai')
     or not private.issue_digest_ai_assistant_enabled(org) then
    raise exception 'compass digest summary is turned off' using errcode = '42501';
  end if;
  if digest.ai_status <> 'available' then
    raise exception 'digest summary unavailable' using errcode = '22023';
  end if;
  -- organizationId is the digest's own organization. api/guide.js binds the
  -- governed dispatch (primary and failover) to it and never sends it to the
  -- model, so a workspace switch after this read cannot carry the aggregate
  -- into another organization's reservation.
  return pg_catalog.jsonb_build_object(
    'digestId', digest.id,
    'organizationId', digest.organization_id,
    'family', digest.thread_family,
    'windowStart', digest.window_start,
    'windowEnd', digest.window_end,
    'confidence', digest.confidence_label,
    'trend', digest.trend,
    'evidence', digest.evidence,
    'recommendations', pg_catalog.to_jsonb(digest.recommendations)
  );
end;
$function$;

-- Stores a validated Compass summary once. api/guide.js calls it with the
-- staff member's token after the governed completion succeeds.
create function public.save_issue_intelligence_digest_ai(
  p_selected_hat text,
  p_digest_id uuid,
  p_summary text,
  p_recommendations text[],
  p_caution text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.issue_digest_staff_organization(p_selected_hat);
  saved private.issue_intelligence_weekly_digests%rowtype;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.intelligence.weekly_digest_ai')
     or not private.issue_digest_ai_assistant_enabled(org) then
    raise exception 'compass digest summary is turned off' using errcode = '42501';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 20 and 600
     or p_summary ~ '[[:cntrl:]]'
     or pg_catalog.cardinality(coalesce(p_recommendations, array[]::text[])) > 3
     or exists (select 1 from pg_catalog.unnest(coalesce(p_recommendations, array[]::text[])) item
       where pg_catalog.char_length(pg_catalog.btrim(item)) not between 4 and 160 or item ~ '[[:cntrl:]]')
     or (p_caution is not null and (pg_catalog.char_length(pg_catalog.btrim(p_caution)) not between 4 and 200 or p_caution ~ '[[:cntrl:]]'))
     or p_model is null or pg_catalog.char_length(p_model) not between 1 and 160 then
    raise exception 'invalid digest summary' using errcode = '22023';
  end if;
  update private.issue_intelligence_weekly_digests d
  set ai_status = 'enriched',
      ai_summary = pg_catalog.jsonb_build_object(
        'summary', pg_catalog.btrim(p_summary),
        'recommendations', pg_catalog.to_jsonb(coalesce(p_recommendations, array[]::text[])),
        'caution', nullif(pg_catalog.btrim(coalesce(p_caution, '')), '')
      ),
      ai_model = p_model,
      enriched_at = pg_catalog.now()
  where d.id = p_digest_id and d.organization_id = org and d.ai_status = 'available'
  returning d.* into saved;
  if saved.id is null then
    raise exception 'digest summary unavailable' using errcode = '22023';
  end if;
  return private.issue_digest_projection(saved, true);
end;
$function$;

revoke all on function private.issue_digest_band(integer) from public, anon, authenticated, service_role;
revoke all on function private.issue_digest_completed_week(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.issue_digest_recommendations(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function private.generate_issue_intelligence_weekly_digests(timestamptz, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.issue_digest_ai_assistant_enabled(uuid) from public, anon, authenticated, service_role;
revoke all on function private.issue_digest_staff_organization(text) from public, anon, authenticated, service_role;
revoke all on function private.issue_digest_projection(private.issue_intelligence_weekly_digests, boolean) from public, anon, authenticated, service_role;
revoke all on function public.get_issue_intelligence_weekly_digests(text) from public, anon, authenticated, service_role;
revoke all on function public.authorize_issue_intelligence_digest_ai(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.save_issue_intelligence_digest_ai(text, uuid, text, text[], text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_issue_intelligence_weekly_digests(text) to authenticated;
grant execute on function public.authorize_issue_intelligence_digest_ai(text, uuid) to authenticated;
grant execute on function public.save_issue_intelligence_digest_ai(text, uuid, text, text[], text, text) to authenticated;

-- Monday 9 AM America/New_York is 13:00 UTC in daylight time and 14:00 UTC in
-- standard time. The job fires every ten minutes from 13:00 to 23:50 UTC on
-- Mondays; the function acts only from 9 AM local time, so the first batch
-- lands at 9 AM ET all year and later batches continue with organizations not
-- yet visited for the week (each run is bounded to 200).
do $block$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  execute 'create extension if not exists pg_cron';
  perform cron.unschedule(jobid) from cron.job where jobname = 'issue-intelligence-weekly-digest';
  perform cron.schedule('issue-intelligence-weekly-digest', '*/10 13-23 * * 1', 'select private.generate_issue_intelligence_weekly_digests(pg_catalog.now(), 200, false)');
end;
$block$;

notify pgrst, 'reload schema';

commit;
