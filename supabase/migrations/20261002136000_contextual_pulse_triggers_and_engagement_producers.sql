-- REQ-UG-CONTEXTUAL-PULSE-PRODUCT-TRIGGERS-20261001 (CR-014)
-- REQ-UG-ENGAGEMENT-SCORE-EVENT-PRODUCERS-20261001 (CR-039/CR-040)
--
-- Restore-everything campaign,. Two restorations that share the
-- member-engagement data model.
--
-- A. Contextual quick checks on reading screens (old lib/contextual-pulse/*,
--    app/dashboard/polls/pulse-actions.ts, components/contextual-pulse/*,
--    supabase/migrations/0258_contextual_pulse_polls.sql at de7df4b57c^).
--    The old app asked a staff-written one-question prompt on the contract
--    page, the know-your-rights panel, Q&A detail and issue-thread pages after
--    the member had read for 20 seconds or scrolled half the page, never on the
--    report-issue, retaliation, grievance-filing or account-recovery pages, at
--    most once per browser session, after a per-prompt cooldown, until the
--    prompt reached its weekly response target, and only for a sampled share
--    of members. Today the only trigger is "voice.open" on the Voice page.
--      1. Five platform settings (category engagement_voice), defaults cited
--         below; the switch gates only the restored reading-screen triggers,
--         so the Voice-page prompts that work today keep working unchanged.
--      2. private.contextual_pulse_context_class(key): the closed registry of
--         screens a prompt may target ('voice', 'product') and the sensitive
--         screens it never may ('blocked').
--      3. A BEFORE INSERT/UPDATE OF event_key guard on organization_pulse_prompts
--         refuses a new or changed event key outside the registry (old
--         upsertContextualPulsePrompt: "limited to low-risk contexts").
--         Existing rows are untouched.
--      4. organization_pulse_events.session_key (nullable uuid) and
--         public.evaluate_contextual_pulse_in_context(context, session, dwell,
--         scroll): session-derived organization, MFA, active membership,
--         switch, blocked context, dwell OR scroll threshold (old client and
--         server both used OR), once per session, per-prompt cooldown, weekly
--         response target and deterministic weekly sampling; it records the
--         shown event that respond_contextual_pulse already answers.
--    The per-prompt cooldown and active flag are W1-SETTINGS controls;
--    this file only reads them.
--
-- B. Engagement events from real member actions. The analytics readers weigh
--    meeting_check_in, qa_contribution, poll_vote, survey_response,
--    event_rsvp and authorized_contact, but the only production writer was
--    record_workspace_page_view, whose page_view rows the weights ignore and
--    the report card counted as "Protected activities". The old app scored
--    from the source tables directly (0080_analytics_per_member_scoring.sql:
--    meetings, Q&A posts and replies, poll votes, surveys, event RSVPs going/
--    maybe, contact log), refreshed by triggers. Here:
--      5. features.analytics.engagement_event_producers (old app: no flag,
--         scoring always on, so default ON).
--      6. AFTER triggers on the ballot, live-poll and channel-poll vote tables,
--         event RSVPs and check-ins, live-meeting RSVP and check-in, survey
--         sessions, Q&A questions and replies and the steward contact log write
--         one idempotent event per (organization, member, kind, source) and
--         retract it when the source row is withdrawn (vote removed, RSVP
--         changed to not going, Q&A post deleted, contact entry archived).
--         Only active members of the source's own organization are recorded;
--         a source whose organization cannot be resolved records nothing.
--      7. A bounded 180-day backfill from existing source rows.
--      8. get_my_analytics_report_card and get_organization_analytics_workspace
--         count real participation only (page views excluded). The old caps
--         and weights (0080: meetings 10/30, Q&A 15/25, polls 5/10, surveys
--         3/10, events 8/15, contacts 5/10) were constants in the old app, not
--         settings, and remain the analytics snapshot's weights unchanged.
--
-- Boundaries kept: organization_engagement_events stays RPC-only (no client
-- grants); readers keep their privacy floors and self-only report card; every
-- producer is SECURITY DEFINER with an empty search path and no EXECUTE for
-- browser or service roles. Production stays empty: the only rows written
-- are platform definitions and events derived from rows that already exist.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $predecessors$
declare
  report_card text;
  workspace text;
begin
  select pg_catalog.md5(p.prosrc) into strict report_card
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_my_analytics_report_card()'::regprocedure;
  select pg_catalog.md5(p.prosrc) into strict workspace
    from pg_catalog.pg_proc p
   where p.oid = 'public.get_organization_analytics_workspace()'::regprocedure;
  -- The reviewed predecessor is 20261002135600_restore_review_hotfixes.sql's
  -- report card (quarterly survey gate), which section 8 keeps.
  if report_card is distinct from '2459dc7683f0a3f6e642ff08304c15da' then
    raise exception 'unreviewed get_my_analytics_report_card predecessor: %', report_card
      using errcode = '55000';
  end if;
  if workspace is distinct from '0088b0285d933ed75cecfc438fa09c75' then
    raise exception 'unreviewed get_organization_analytics_workspace predecessor: %', workspace
      using errcode = '55000';
  end if;
end;
$predecessors$;

-- ---------------------------------------------------------------------------
-- 1 and 5. Settings (W1-SETTINGS registry contract)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old supabase/migrations/0258_contextual_pulse_polls.sql:2-9 seeded
  -- contextual_pulse_polls_enabled = 'false', and every caller read it with a
  -- false fallback (app/dashboard/contract/page.tsx:45-49).
  -- default ON by (2026-10-02); old app default was off
  ('features.engagement_voice.contextual_pulses', 'boolean', 'Quick checks on reading screens',
   'Ask a staff-written quick check after a member reads the contract, rights, a Q&A answer or a topic thread for a while. Never on case, report or account recovery screens.',
   'true', null, null, null, 300, 'engagement_voice', true),
  -- Old lib/contextual-pulse/contexts.ts:17-20 SHARED_ENGAGEMENT_THRESHOLD dwellMs 20_000.
  ('limits.engagement_voice.pulse_dwell_seconds', 'integer', 'Quick check reading time (seconds)',
   'Seconds a member stays on a reading screen before a quick check may appear, unless the scroll depth is reached first.',
   '20', 5, 600, null, 310, 'engagement_voice', true),
  -- Old lib/contextual-pulse/contexts.ts:17-20 SHARED_ENGAGEMENT_THRESHOLD scrollPercent 50.
  ('limits.engagement_voice.pulse_scroll_percent', 'integer', 'Quick check scroll depth (percent)',
   'How far down a reading screen a member scrolls before a quick check may appear, unless the reading time passes first.',
   '50', 10, 100, null, 320, 'engagement_voice', true),
  -- Old app/dashboard/polls/pulse-actions.ts:98 DEFAULT_PULSE_TARGET_MIN_RESPONSES = 40
  -- (every saved prompt was written with it).
  ('limits.engagement_voice.pulse_weekly_target', 'integer', 'Quick check weekly response target',
   'Stop asking a quick check for the rest of the week once it has this many answers.',
   '40', 1, 10000, null, 330, 'engagement_voice', false),
  -- Old app/dashboard/polls/pulse-actions.ts:95 DEFAULT_PULSE_SAMPLE_RATE = 0.35.
  ('limits.engagement_voice.pulse_sampling_percent', 'integer', 'Quick check share of members (percent)',
   'Percent of eligible members asked each quick check in a given week. The rest are not asked that week.',
   '35', 1, 100, null, 340, 'engagement_voice', false),
  -- Old app: no flag; compute_member_scores ran on every write through the
  -- 0080_analytics_per_member_scoring.sql triggers and nightly. Restored
  -- feature with no old flag, so ON.
  ('features.analytics.engagement_event_producers', 'boolean', 'Count member actions in engagement',
   'Record votes, RSVPs, check-ins, survey submissions, Q&A posts and steward contact log entries for report cards and chapter engagement.',
   'true', null, null, null, 300, 'analytics', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The screen registry
-- ---------------------------------------------------------------------------

create function private.contextual_pulse_context_class(p_context_key text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case p_context_key
    -- The Voice page trigger that works today.
    when 'voice.open' then 'voice'
    -- Reading screens restored from the old PULSE_CONTEXTS.
    when 'contract.page' then 'product'
    when 'rights.page' then 'product'
    when 'qa.detail' then 'product'
    when 'issue-thread.detail' then 'product'
    -- Never: the old blocked contexts and today's sensitive screens.
    when 'report-issue.form' then 'blocked'
    when 'retaliation.report' then 'blocked'
    when 'grievance.filing' then 'blocked'
    when 'account.recovery' then 'blocked'
    when 'case.detail' then 'blocked'
    when 'case.updated' then 'blocked'
    when 'mfa.challenge' then 'blocked'
    else null
  end
$function$;

revoke all on function private.contextual_pulse_context_class(text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Prompts may only target registered low-risk screens
-- ---------------------------------------------------------------------------

create function private.organization_pulse_prompt_event_key_guard()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' or new.event_key is distinct from old.event_key then
    if coalesce(private.contextual_pulse_context_class(new.event_key), 'blocked') not in ('voice', 'product') then
      raise exception 'contextual pulse prompts are limited to low-risk screens' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function private.organization_pulse_prompt_event_key_guard()
  from public, anon, authenticated, service_role;

create trigger organization_pulse_prompts_event_key_guard
  before insert or update of event_key on public.organization_pulse_prompts
  for each row execute function private.organization_pulse_prompt_event_key_guard();

-- ---------------------------------------------------------------------------
-- 4. Reading-screen evaluation
-- ---------------------------------------------------------------------------

alter table public.organization_pulse_events
  add column session_key uuid;

comment on column public.organization_pulse_events.session_key is
  'Client session that saw a reading-screen quick check (one prompt per session). Null for Voice-page prompts.';

create index organization_pulse_events_session_idx
  on public.organization_pulse_events (user_id, session_key)
  where session_key is not null;

create function public.evaluate_contextual_pulse_in_context(
  p_context_key text,
  p_session_key uuid,
  p_dwell_seconds integer,
  p_scroll_percent integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  actor uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  actor_chapter text := private.current_member_chapter();
  screen_key text := pg_catalog.btrim(coalesce(p_context_key, ''));
  context_class text;
  week_start timestamptz := pg_catalog.date_trunc('week', pg_catalog.now());
  week_bucket text := pg_catalog.to_char(pg_catalog.now(), 'IYYY-"W"IW');
  weekly_target integer;
  sampling_percent integer;
  candidate public.organization_pulse_prompts%rowtype;
  fallback text;
  event_row public.organization_pulse_events%rowtype;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if screen_key !~ '^[a-z0-9._:-]{1,80}$' then
    raise exception 'invalid pulse context' using errcode = '22023';
  end if;
  if p_session_key is null
     or p_dwell_seconds is null or p_dwell_seconds < 0 or p_dwell_seconds > 86400
     or p_scroll_percent is null or p_scroll_percent < 0 or p_scroll_percent > 100 then
    raise exception 'invalid pulse engagement' using errcode = '22023';
  end if;
  context_class := private.contextual_pulse_context_class(screen_key);
  if context_class = 'blocked' then
    return pg_catalog.jsonb_build_object('eligible', false, 'reason', 'blocked_context');
  end if;
  if context_class is distinct from 'product' then
    raise exception 'invalid pulse context' using errcode = '22023';
  end if;
  -- A newly provisioned account has no organization yet: quiet, no records.
  if org is null then
    return null;
  end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.engagement_voice.contextual_pulses') then
    return pg_catalog.jsonb_build_object('eligible', false, 'reason', 'disabled');
  end if;
  -- Old pulse-actions.ts evaluateContextualPulse: suppressed only when BOTH
  -- the reading time and the scroll depth are below their thresholds.
  if p_dwell_seconds < private.organization_limit(org, 'limits.engagement_voice.pulse_dwell_seconds')
     and p_scroll_percent < private.organization_limit(org, 'limits.engagement_voice.pulse_scroll_percent') then
    return pg_catalog.jsonb_build_object('eligible', false, 'reason', 'engagement_not_met');
  end if;

  -- Two tabs of one session evaluating at once still show one prompt.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'contextual-pulse-session:' || actor::text || ':' || p_session_key::text, 0));
  if exists (
    select 1 from public.organization_pulse_events seen
    where seen.user_id = actor and seen.session_key = p_session_key
  ) then
    return pg_catalog.jsonb_build_object('eligible', false, 'reason', 'session_already_used');
  end if;

  weekly_target := private.organization_limit(org, 'limits.engagement_voice.pulse_weekly_target');
  sampling_percent := private.organization_limit(org, 'limits.engagement_voice.pulse_sampling_percent');

  for candidate in
    select prompt.*
    from public.organization_pulse_prompts prompt
    where prompt.organization_id = org
      and prompt.active
      and prompt.event_key = screen_key
      and (prompt.chapter_id is null or prompt.chapter_id = actor_chapter)
    order by (prompt.chapter_id is not null) desc, prompt.updated_at desc, prompt.id
  loop
    if exists (
      select 1 from public.organization_pulse_events previous
      where previous.prompt_id = candidate.id
        and previous.user_id = actor
        and previous.updated_at > pg_catalog.now() - pg_catalog.make_interval(hours => candidate.cooldown_hours)
    ) then
      fallback := coalesce(fallback, 'cooldown_active');
      continue;
    end if;
    if (
      select pg_catalog.count(*) from public.organization_pulse_events answered
      where answered.prompt_id = candidate.id
        and answered.state = 'responded'
        and answered.responded_at >= week_start
    ) >= weekly_target then
      fallback := coalesce(fallback, 'target_reached');
      continue;
    end if;
    -- Deterministic per member, prompt and ISO week, as the old FNV bucket.
    if ((pg_catalog.hashtextextended(actor::text || ':' || candidate.id::text || ':' || week_bucket, 0) % 100) + 100) % 100
       >= sampling_percent then
      fallback := coalesce(fallback, 'sampled_out');
      continue;
    end if;

    insert into public.organization_pulse_events (
      organization_id, prompt_id, user_id, context_key, session_key
    ) values (
      org, candidate.id, actor, screen_key || ':' || p_session_key::text, p_session_key
    )
    on conflict (prompt_id, user_id, context_key) do nothing
    returning * into event_row;
    if not found then
      return pg_catalog.jsonb_build_object('eligible', false, 'reason', 'session_already_used');
    end if;
    return pg_catalog.jsonb_build_object(
      'eligible', true,
      'eventId', event_row.id,
      'promptId', candidate.id,
      'question', candidate.question,
      'options', candidate.options,
      'contextKey', screen_key
    );
  end loop;

  return pg_catalog.jsonb_build_object('eligible', false, 'reason', coalesce(fallback, 'no_matching_prompt'));
end;
end;
$function$;

revoke all on function public.evaluate_contextual_pulse_in_context(text, uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.evaluate_contextual_pulse_in_context(text, uuid, integer, integer) to authenticated;

comment on function public.evaluate_contextual_pulse_in_context(text, uuid, integer, integer) is
  'CR-014 reading-screen quick check: session-derived organization, MFA, membership, organization switch, blocked screens refused, dwell OR scroll threshold, one prompt per client session, per-prompt cooldown, weekly response target and weekly sampling. Records the shown event respond_contextual_pulse answers.';

-- ---------------------------------------------------------------------------
-- 6. Engagement event producers
-- ---------------------------------------------------------------------------

create function private.engagement_source_key(p_source text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when pg_catalog.char_length(p_source) <= 128 then p_source
    else pg_catalog.left(p_source, 95) || ':' || pg_catalog.md5(p_source)
  end
$function$;

create function private.engagement_producer_record(
  p_organization_id uuid,
  p_user_id uuid,
  p_chapter_id text,
  p_event_type text,
  p_source text,
  p_occurred_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  event_chapter text := p_chapter_id;
begin
  if p_organization_id is null or p_user_id is null or p_source is null then
    return;
  end if;
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
  ) then
    return;
  end if;
  if not private.organization_feature_enabled(p_organization_id, 'features.analytics.engagement_event_producers') then
    return;
  end if;
  if event_chapter is null or not exists (
    select 1 from public.chapters chapter
    where chapter.id = event_chapter and chapter.organization_id = p_organization_id
  ) then
    select profile.chapter_id into event_chapter
    from public.member_profiles profile
    join public.chapters chapter
      on chapter.id = profile.chapter_id and chapter.organization_id = p_organization_id
    where profile.id = p_user_id;
  end if;
  insert into public.organization_engagement_events
    (organization_id, user_id, chapter_id, event_type, source_id, occurred_at)
  values (
    p_organization_id, p_user_id, event_chapter, p_event_type,
    private.engagement_source_key(p_source), coalesce(p_occurred_at, pg_catalog.now())
  )
  on conflict (organization_id, user_id, event_type, source_id) do nothing;
end;
end;
$function$;

create function private.engagement_producer_retract(
  p_user_id uuid,
  p_event_type text,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  delete from public.organization_engagement_events event
  where event.user_id = p_user_id
    and event.event_type = p_event_type
    and event.source_id = private.engagement_source_key(p_source);
end;
$function$;

-- Retraction runs without the organization (a cascading parent may already be
-- gone), so it needs its own index.
create index organization_engagement_events_source_idx
  on public.organization_engagement_events (user_id, event_type, source_id);

create function private.engagement_produce_ballot_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  ballot_org uuid;
  ballot_chapter text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' then
    perform private.engagement_producer_retract(old.user_id, 'poll_vote', 'ballot:' || old.ballot_id);
    return old;
  end if;
  select coalesce(ballot.organization_id, chapter.organization_id), ballot.chapter_id
    into ballot_org, ballot_chapter
  from public.member_ballots ballot
  left join public.chapters chapter on chapter.id = ballot.chapter_id
  where ballot.id = new.ballot_id;
  perform private.engagement_producer_record(
    ballot_org, new.user_id, ballot_chapter, 'poll_vote', 'ballot:' || new.ballot_id, new.submitted_at);
  return new;
end;
$function$;

create function private.engagement_produce_live_poll_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' then
    perform private.engagement_producer_retract(old.voter_user_id, 'poll_vote', 'live-poll:' || old.poll_id::text);
    return old;
  end if;
  perform private.engagement_producer_record(
    new.organization_id, new.voter_user_id,
    (select poll.chapter_id from public.organization_live_polls poll where poll.id = new.poll_id),
    'poll_vote', 'live-poll:' || new.poll_id::text, new.created_at);
  return new;
end;
$function$;

create function private.engagement_produce_channel_poll_vote()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  poll_org uuid;
  poll_chapter text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' then
    perform private.engagement_producer_retract(old.user_id, 'poll_vote', 'channel-poll:' || old.poll_id::text);
    return old;
  end if;
  select chapter.organization_id, poll.chapter_id into poll_org, poll_chapter
  from public.chapter_channel_polls poll
  join public.chapters chapter on chapter.id = poll.chapter_id
  where poll.id = new.poll_id;
  perform private.engagement_producer_record(
    poll_org, new.user_id, poll_chapter, 'poll_vote', 'channel-poll:' || new.poll_id::text, new.created_at);
  return new;
end;
$function$;

create function private.engagement_produce_event_rsvp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  event_org uuid;
  event_chapter text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' or new.status <> 'going' then
    perform private.engagement_producer_retract(
      case when tg_op = 'DELETE' then old.user_id else new.user_id end,
      'event_rsvp',
      'event:' || case when tg_op = 'DELETE' then old.event_id else new.event_id end);
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select chapter.organization_id, event.chapter_id into event_org, event_chapter
  from public.member_events event
  join public.chapters chapter on chapter.id = event.chapter_id
  where event.id = new.event_id;
  perform private.engagement_producer_record(
    event_org, new.user_id, event_chapter, 'event_rsvp', 'event:' || new.event_id, new.updated_at);
  return new;
end;
$function$;

create function private.engagement_produce_event_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  event_org uuid;
  event_chapter text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' then
    perform private.engagement_producer_retract(old.user_id, 'meeting_check_in', 'event:' || old.event_id);
    return old;
  end if;
  select chapter.organization_id, event.chapter_id into event_org, event_chapter
  from public.member_events event
  join public.chapters chapter on chapter.id = event.chapter_id
  where event.id = new.event_id;
  perform private.engagement_producer_record(
    event_org, new.user_id, event_chapter, 'meeting_check_in', 'event:' || new.event_id, new.checked_in_at);
  return new;
end;
$function$;

create function private.engagement_produce_live_poll_attendance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  poll_chapter text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' then
    perform private.engagement_producer_retract(old.user_id, 'event_rsvp', 'live-poll:' || old.poll_id::text);
    perform private.engagement_producer_retract(old.user_id, 'meeting_check_in', 'live-poll:' || old.poll_id::text);
    return old;
  end if;
  select poll.chapter_id into poll_chapter
  from public.organization_live_polls poll where poll.id = new.poll_id;
  -- Old event_rsvps counted 'going' and 'maybe'.
  if new.rsvp in ('yes', 'maybe') then
    perform private.engagement_producer_record(
      new.organization_id, new.user_id, poll_chapter, 'event_rsvp', 'live-poll:' || new.poll_id::text, new.updated_at);
  else
    perform private.engagement_producer_retract(new.user_id, 'event_rsvp', 'live-poll:' || new.poll_id::text);
  end if;
  if new.checked_in_at is not null then
    perform private.engagement_producer_record(
      new.organization_id, new.user_id, poll_chapter, 'meeting_check_in', 'live-poll:' || new.poll_id::text, new.checked_in_at);
  else
    perform private.engagement_producer_retract(new.user_id, 'meeting_check_in', 'live-poll:' || new.poll_id::text);
  end if;
  return new;
end;
$function$;

create function private.engagement_produce_survey_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' or new.status <> 'submitted' then
    perform private.engagement_producer_retract(
      case when tg_op = 'DELETE' then old.respondent_user_id else new.respondent_user_id end,
      'survey_response',
      'survey:' || (case when tg_op = 'DELETE' then old.survey_id else new.survey_id end)::text);
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform private.engagement_producer_record(
    new.organization_id, new.respondent_user_id,
    (select survey.chapter_id from public.organization_surveys survey where survey.id = new.survey_id),
    'survey_response', 'survey:' || new.survey_id::text, new.submitted_at);
  return new;
end;
$function$;

create function private.engagement_produce_qa_question()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' or new.deleted_at is not null then
    perform private.engagement_producer_retract(
      case when tg_op = 'DELETE' then old.author_user_id else new.author_user_id end,
      'qa_contribution',
      'qa-question:' || (case when tg_op = 'DELETE' then old.id else new.id end)::text);
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform private.engagement_producer_record(
    new.organization_id, new.author_user_id, new.chapter_id,
    'qa_contribution', 'qa-question:' || new.id::text, new.created_at);
  return new;
end;
$function$;

create function private.engagement_produce_qa_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op = 'DELETE' or new.deleted_at is not null then
    perform private.engagement_producer_retract(
      case when tg_op = 'DELETE' then old.author_user_id else new.author_user_id end,
      'qa_contribution',
      'qa-reply:' || (case when tg_op = 'DELETE' then old.id else new.id end)::text);
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  perform private.engagement_producer_record(
    new.organization_id, new.author_user_id,
    (select question.chapter_id from public.member_qa_questions question where question.id = new.question_id),
    'qa_contribution', 'qa-reply:' || new.id::text, new.created_at);
  return new;
end;
$function$;

-- The old contact_log counted toward the contacted member's engagement.
create function private.engagement_produce_contact_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if tg_op in ('UPDATE', 'DELETE') and old.subject_user_id is not null
     and (tg_op = 'DELETE'
       or old.subject_user_id is distinct from new.subject_user_id
       or new.contact_kind <> 'member'
       or new.archived_at is not null) then
    perform private.engagement_producer_retract(old.subject_user_id, 'authorized_contact', 'contact:' || old.id::text);
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.contact_kind = 'member' and new.subject_user_id is not null and new.archived_at is null then
    perform private.engagement_producer_record(
      new.organization_id, new.subject_user_id, new.chapter_id,
      'authorized_contact', 'contact:' || new.id::text, new.occurred_at);
  end if;
  return new;
end;
$function$;

revoke all on function private.engagement_source_key(text) from public, anon, authenticated, service_role;
revoke all on function private.engagement_producer_record(uuid, uuid, text, text, text, timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.engagement_producer_retract(uuid, text, text) from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_ballot_vote() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_live_poll_vote() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_channel_poll_vote() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_event_rsvp() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_event_checkin() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_live_poll_attendance() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_survey_session() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_qa_question() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_qa_reply() from public, anon, authenticated, service_role;
revoke all on function private.engagement_produce_contact_log() from public, anon, authenticated, service_role;

create trigger engagement_producer_ballot_vote
  after insert or delete on public.member_ballot_votes
  for each row execute function private.engagement_produce_ballot_vote();
create trigger engagement_producer_live_poll_vote
  after insert or delete on public.organization_live_poll_votes
  for each row execute function private.engagement_produce_live_poll_vote();
create trigger engagement_producer_channel_poll_vote
  after insert or delete on public.chapter_channel_poll_votes
  for each row execute function private.engagement_produce_channel_poll_vote();
create trigger engagement_producer_event_rsvp
  after insert or update of status or delete on public.member_event_rsvps
  for each row execute function private.engagement_produce_event_rsvp();
create trigger engagement_producer_event_checkin
  after insert or delete on public.member_event_checkins
  for each row execute function private.engagement_produce_event_checkin();
create trigger engagement_producer_live_poll_attendance
  after insert or update of rsvp, checked_in_at or delete on public.organization_live_poll_attendance
  for each row execute function private.engagement_produce_live_poll_attendance();
create trigger engagement_producer_survey_session
  after insert or update of status or delete on public.organization_survey_sessions
  for each row execute function private.engagement_produce_survey_session();
create trigger engagement_producer_qa_question
  after insert or update of deleted_at or delete on public.member_qa_questions
  for each row execute function private.engagement_produce_qa_question();
create trigger engagement_producer_qa_reply
  after insert or update of deleted_at or delete on public.member_qa_replies
  for each row execute function private.engagement_produce_qa_reply();
create trigger engagement_producer_contact_log
  after insert or update of subject_user_id, contact_kind, archived_at or delete on public.chapter_contact_log
  for each row execute function private.engagement_produce_contact_log();

-- ---------------------------------------------------------------------------
-- 7. Bounded backfill: the scoring window is 180 days
-- ---------------------------------------------------------------------------

do $backfill$
declare
  since timestamptz := pg_catalog.now() - interval '180 days';
begin
  perform private.engagement_producer_record(
    coalesce(ballot.organization_id, chapter.organization_id), vote.user_id, ballot.chapter_id,
    'poll_vote', 'ballot:' || vote.ballot_id, vote.submitted_at)
  from public.member_ballot_votes vote
  join public.member_ballots ballot on ballot.id = vote.ballot_id
  left join public.chapters chapter on chapter.id = ballot.chapter_id
  where vote.submitted_at >= since;

  perform private.engagement_producer_record(
    vote.organization_id, vote.voter_user_id, poll.chapter_id,
    'poll_vote', 'live-poll:' || vote.poll_id::text, vote.created_at)
  from public.organization_live_poll_votes vote
  join public.organization_live_polls poll on poll.id = vote.poll_id
  where vote.created_at >= since;

  perform private.engagement_producer_record(
    chapter.organization_id, vote.user_id, poll.chapter_id,
    'poll_vote', 'channel-poll:' || vote.poll_id::text, vote.created_at)
  from public.chapter_channel_poll_votes vote
  join public.chapter_channel_polls poll on poll.id = vote.poll_id
  join public.chapters chapter on chapter.id = poll.chapter_id
  where vote.created_at >= since;

  perform private.engagement_producer_record(
    chapter.organization_id, rsvp.user_id, event.chapter_id,
    'event_rsvp', 'event:' || rsvp.event_id, rsvp.updated_at)
  from public.member_event_rsvps rsvp
  join public.member_events event on event.id = rsvp.event_id
  join public.chapters chapter on chapter.id = event.chapter_id
  where rsvp.status = 'going' and rsvp.updated_at >= since;

  perform private.engagement_producer_record(
    chapter.organization_id, checkin.user_id, event.chapter_id,
    'meeting_check_in', 'event:' || checkin.event_id, checkin.checked_in_at)
  from public.member_event_checkins checkin
  join public.member_events event on event.id = checkin.event_id
  join public.chapters chapter on chapter.id = event.chapter_id
  where checkin.checked_in_at >= since;

  perform private.engagement_producer_record(
    attendance.organization_id, attendance.user_id, poll.chapter_id,
    'event_rsvp', 'live-poll:' || attendance.poll_id::text, attendance.updated_at)
  from public.organization_live_poll_attendance attendance
  join public.organization_live_polls poll on poll.id = attendance.poll_id
  where attendance.rsvp in ('yes', 'maybe') and attendance.updated_at >= since;

  perform private.engagement_producer_record(
    attendance.organization_id, attendance.user_id, poll.chapter_id,
    'meeting_check_in', 'live-poll:' || attendance.poll_id::text, attendance.checked_in_at)
  from public.organization_live_poll_attendance attendance
  join public.organization_live_polls poll on poll.id = attendance.poll_id
  where attendance.checked_in_at >= since;

  perform private.engagement_producer_record(
    session.organization_id, session.respondent_user_id, survey.chapter_id,
    'survey_response', 'survey:' || session.survey_id::text, session.submitted_at)
  from public.organization_survey_sessions session
  join public.organization_surveys survey on survey.id = session.survey_id
  where session.status = 'submitted' and session.submitted_at >= since;

  perform private.engagement_producer_record(
    question.organization_id, question.author_user_id, question.chapter_id,
    'qa_contribution', 'qa-question:' || question.id::text, question.created_at)
  from public.member_qa_questions question
  where question.deleted_at is null and question.created_at >= since;

  perform private.engagement_producer_record(
    reply.organization_id, reply.author_user_id, question.chapter_id,
    'qa_contribution', 'qa-reply:' || reply.id::text, reply.created_at)
  from public.member_qa_replies reply
  join public.member_qa_questions question on question.id = reply.question_id
  where reply.deleted_at is null and reply.created_at >= since;

  perform private.engagement_producer_record(
    contact.organization_id, contact.subject_user_id, contact.chapter_id,
    'authorized_contact', 'contact:' || contact.id::text, contact.occurred_at)
  from public.chapter_contact_log contact
  where contact.contact_kind = 'member' and contact.subject_user_id is not null
    and contact.archived_at is null and contact.occurred_at >= since;
end;
$backfill$;

-- ---------------------------------------------------------------------------
-- 8. Readers count real participation only
-- ---------------------------------------------------------------------------

create or replace function public.get_my_analytics_report_card()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  event_count integer := 0;
  participation integer := 0;
  profile_readiness integer := 0;
  follow_through integer := 0;
  last_activity timestamptz;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Built on 20261002135600's definition, which it keeps unchanged apart from
  -- the page-view filter below. Quarterly "give to view": a locked member
  -- gets no report card.
  if private.quarterly_survey_gate_locks_caller() then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'locked', true, 'reason', 'quarterly_survey_gate',
      'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;

  -- Protected activities are real participation: page views are usage
  -- telemetry, not activity (REQ-UG-ENGAGEMENT-SCORE-EVENT-PRODUCERS-20261001).
  select pg_catalog.count(*)::integer, pg_catalog.max(e.occurred_at)
    into event_count, last_activity
  from public.organization_engagement_events e
  where e.organization_id = org
    and e.user_id = caller
    and e.event_type <> 'page_view'
    and e.occurred_at >= pg_catalog.now() - interval '180 days';

  if event_count = 0 then
    return pg_catalog.jsonb_build_object(
      'overall', null, 'generatedAt', pg_catalog.now(), 'signals', '[]'::jsonb
    );
  end if;

  select
    (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end)
    + (case when exists (
        select 1
        from public.member_chapter_memberships m
        join public.chapters c on c.id = m.chapter_id and c.organization_id = org
        where m.user_id = caller and m.status = 'active' and m.chapter_id = p.chapter_id
      ) then 50 else 0 end)
    into profile_readiness
  from public.member_profiles p
  where p.id = caller;

  participation := least(100, event_count * 10);
  select least(100, pg_catalog.count(*)::integer * 20)
    into follow_through
  from public.organization_engagement_events e
  where e.organization_id = org
    and e.user_id = caller
    and e.occurred_at >= pg_catalog.now() - interval '90 days'
    and e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp');

  return pg_catalog.jsonb_build_object(
    'overall', pg_catalog.round((participation + profile_readiness + follow_through)::numeric / 3),
    'participation', participation,
    'profileReadiness', profile_readiness,
    'followThrough', follow_through,
    'generatedAt', pg_catalog.now(),
    'signals', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('label', 'Protected activities (180 days)', 'value', event_count),
      pg_catalog.jsonb_build_object('label', 'Days since last activity', 'value',
        greatest(0, (current_date - last_activity::date)))
    )
  );
end;
$function$;

revoke all on function public.get_my_analytics_report_card() from public, anon, authenticated, service_role;
grant execute on function public.get_my_analytics_report_card() to authenticated;

create or replace function public.get_organization_analytics_workspace()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_selected_organization();
  generated timestamptz := pg_catalog.now();
  privacy_threshold integer := 25;
  actor uuid := (select auth.uid());
  may_read_unassigned boolean;
begin
  if org is null then
    raise exception 'organization required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Necessary candidate condition only, never an authorization result.
  -- Deliberately retain roles in ANY tenant/chapter (including inactive or
  -- otherwise unusable grants): false positives still reach the shared final
  -- predicate. All current organization, chapter and legacy role sources are
  -- included. Assignment is checked per case below.
  may_read_unassigned := exists (
    select 1 from public.organization_role_grants g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_role_chapters g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  ) or exists (
    select 1 from public.member_roles g
    where g.user_id = actor
      and g.role = any(array['coordinator','advisor','admin','vp'])
  );

  perform private.mi1_write_tenant_audit(org, 'analytics_snapshot_read', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surface', 'analytics_parity_workspace'
  ));

  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', generated,
    'privacyThreshold', privacy_threshold,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'id', m.user_id::text || ':' || m.chapter_id,
        'name', p.full_name,
        'chapterId', c.id,
        'chapterName', c.name,
        'participationScore', least(100, activity.event_count * 10),
        'profileReadiness',
          (case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50,
        'followThrough', least(100, activity.follow_count * 20),
        'overallScore', pg_catalog.round((
          least(100, activity.event_count * 10)
          + ((case when pg_catalog.char_length(pg_catalog.btrim(p.full_name)) >= 2 then 50 else 0 end) + 50)
          + least(100, activity.follow_count * 20)
        )::numeric / 3),
        'attention', case
          when cases.overdue_cases > 0 then 'urgent'
          when activity.event_count = 0 then 'support'
          when activity.event_count < 5 then 'watch'
          else 'steady'
        end,
        'activeCases', cases.active_cases,
        'overdueCases', cases.overdue_cases,
        'lastActivityAt', activity.last_activity
      ) order by c.name, p.full_name, m.user_id)
      from public.member_chapter_memberships m
      join public.chapters c on c.id = m.chapter_id and c.organization_id = org
      join public.organization_memberships om
        on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
      join public.member_profiles p on p.id = m.user_id
      cross join lateral (
        select
          pg_catalog.count(*)::integer as event_count,
          pg_catalog.count(*) filter (
            where e.event_type in ('authorized_contact', 'survey_response', 'event_rsvp')
              and e.occurred_at >= generated - interval '90 days'
          )::integer as follow_count,
          pg_catalog.max(e.occurred_at) as last_activity
        from public.organization_engagement_events e
        where e.organization_id = org
          and e.user_id = m.user_id
          -- Page views are usage telemetry, not participation
          -- (REQ-UG-ENGAGEMENT-SCORE-EVENT-PRODUCERS-20261001).
          and e.event_type <> 'page_view'
          and e.occurred_at >= generated - interval '180 days'
      ) activity
      cross join lateral (
        select
          pg_catalog.count(*) filter (where cs.status = 'active')::integer as active_cases,
          pg_catalog.count(*) filter (
            where cs.status = 'active' and cs.deadline < generated::date
          )::integer as overdue_cases
        from public.member_cases cs
        where cs.organization_id = org
          and cs.chapter_id = c.id
          and cs.user_id = m.user_id
          and cs.status = 'active'
          and (may_read_unassigned or cs.steward_user_id = actor or cs.coordinator_user_id = actor)
          and private.casework_staff_can_access(cs.id)
      ) cases
      where m.status = 'active'
    ), '[]'::jsonb),
    'chapterHealth', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'organizationId', org,
        'chapterId', c.id,
        'chapterName', c.name,
        'memberCount', totals.member_count,
        'protected', totals.member_count < privacy_threshold,
        'score', case when totals.member_count >= privacy_threshold then latest.score else null end,
        'drivers', case when totals.member_count >= privacy_threshold and latest.id is not null
          then pg_catalog.jsonb_build_object(
            'participation', latest.participation,
            'caseTimeliness', latest.case_timeliness,
            'stewardCapacity', latest.steward_capacity,
            'trainingCoverage', latest.training_coverage,
            'communicationReach', latest.communication_reach,
            'governanceReadiness', latest.governance_readiness
          ) else null end,
        'trend', case when totals.member_count >= privacy_threshold then coalesce(trend.points, '[]'::jsonb) else '[]'::jsonb end
      ) order by c.name)
      from public.chapters c
      cross join lateral (
        select pg_catalog.count(*)::integer as member_count
        from public.member_chapter_memberships m
        join public.organization_memberships om
          on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
        where m.chapter_id = c.id and m.status = 'active'
      ) totals
      left join lateral (
        select s.* from public.chapter_health_snapshots s
        where s.chapter_id = c.id order by s.measured_on desc limit 1
      ) latest on true
      left join lateral (
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'measuredOn', history.measured_on, 'score', history.score
        ) order by history.measured_on) as points
        from (
          select s.measured_on, s.score
          from public.chapter_health_snapshots s
          where s.chapter_id = c.id
          order by s.measured_on desc limit 36
        ) history
      ) trend on true
      where c.organization_id = org
    ), '[]'::jsonb),
    'datasets', coalesce((
      select pg_catalog.jsonb_agg(dataset.value order by dataset.sort_key)
      from (
        select 0 as sort_key, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'organization:chapter-health',
          'label', 'Chapter health',
          'description', 'Latest protected chapter health score.',
          'scope', 'organization',
          'chapterId', null,
          'rows', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'label', qualified.name, 'value', qualified.score
          ) order by qualified.name), '[]'::jsonb)
        ) as value
        from (
          select c.name, latest.score
          from public.chapters c
          cross join lateral (
            select pg_catalog.count(*)::integer as member_count
            from public.member_chapter_memberships m
            join public.organization_memberships om
              on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
            where m.chapter_id = c.id and m.status = 'active'
          ) totals
          join lateral (
            select s.score from public.chapter_health_snapshots s
            where s.chapter_id = c.id order by s.measured_on desc limit 1
          ) latest on true
          where c.organization_id = org and totals.member_count >= privacy_threshold
        ) qualified
        union all
        select 100 + c.order_index, pg_catalog.jsonb_build_object(
          'organizationId', org,
          'id', 'chapter:' || c.id || ':health-trend',
          'label', c.name || ' health trend',
          'description', 'Protected chapter score history.',
          'scope', 'chapter',
          'chapterId', c.id,
          'rows', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'label', s.measured_on::text, 'value', s.score
            ) order by s.measured_on)
            from public.chapter_health_snapshots s where s.chapter_id = c.id
          ), '[]'::jsonb)
        )
        from public.chapters c
        where c.organization_id = org
          and (select pg_catalog.count(*) from public.member_chapter_memberships m
               join public.organization_memberships om
                 on om.organization_id = org and om.user_id = m.user_id and om.status = 'active'
               where m.chapter_id = c.id and m.status = 'active') >= privacy_threshold
      ) dataset
    ), '[]'::jsonb),
    'layouts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', l.id,
        'organizationId', l.organization_id,
        'name', l.name,
        'scope', l.scope,
        'chapterId', l.chapter_id,
        'spec', l.spec,
        'canEdit', l.owner_user_id = (select auth.uid())
          or private.has_organization_role(org, array['admin']),
        'updatedAt', l.updated_at
      ) order by l.updated_at desc)
      from public.organization_analytics_layouts l
      where l.organization_id = org
        and (
          (l.scope = 'personal' and l.owner_user_id = (select auth.uid()))
          or l.scope in ('chapter', 'organization')
        )
    ), '[]'::jsonb)
  );
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Account lifecycle trigger inventory: review the new triggers and the
-- functions they reach, then prove the inventory is complete.
-- ---------------------------------------------------------------------------

-- The new triggers, the functions they run, and what those reach (the pulse
-- guard's registry, the producers' helpers and the W1-SETTINGS switch
-- readers). Nothing else on the trigger surface changes.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
  ('trigger', 'public', 'organization_pulse_prompts', 'organization_pulse_prompts_event_key_guard'),
  ('trigger', 'public', 'member_ballot_votes', 'engagement_producer_ballot_vote'),
  ('trigger', 'public', 'organization_live_poll_votes', 'engagement_producer_live_poll_vote'),
  ('trigger', 'public', 'chapter_channel_poll_votes', 'engagement_producer_channel_poll_vote'),
  ('trigger', 'public', 'member_event_rsvps', 'engagement_producer_event_rsvp'),
  ('trigger', 'public', 'member_event_checkins', 'engagement_producer_event_checkin'),
  ('trigger', 'public', 'organization_live_poll_attendance', 'engagement_producer_live_poll_attendance'),
  ('trigger', 'public', 'organization_survey_sessions', 'engagement_producer_survey_session'),
  ('trigger', 'public', 'member_qa_questions', 'engagement_producer_qa_question'),
  ('trigger', 'public', 'member_qa_replies', 'engagement_producer_qa_reply'),
  ('trigger', 'public', 'chapter_contact_log', 'engagement_producer_contact_log'),
  ('function', 'private', '', 'contextual_pulse_context_class(p_context_key text)'),
  ('function', 'private', '', 'organization_pulse_prompt_event_key_guard()'),
  ('function', 'private', '', 'engagement_source_key(p_source text)'),
  ('function', 'private', '', 'engagement_producer_record(p_organization_id uuid, p_user_id uuid, p_chapter_id text, p_event_type text, p_source text, p_occurred_at timestamp with time zone)'),
  ('function', 'private', '', 'engagement_producer_retract(p_user_id uuid, p_event_type text, p_source text)'),
  ('function', 'private', '', 'engagement_produce_ballot_vote()'),
  ('function', 'private', '', 'engagement_produce_live_poll_vote()'),
  ('function', 'private', '', 'engagement_produce_channel_poll_vote()'),
  ('function', 'private', '', 'engagement_produce_event_rsvp()'),
  ('function', 'private', '', 'engagement_produce_event_checkin()'),
  ('function', 'private', '', 'engagement_produce_live_poll_attendance()'),
  ('function', 'private', '', 'engagement_produce_survey_session()'),
  ('function', 'private', '', 'engagement_produce_qa_question()'),
  ('function', 'private', '', 'engagement_produce_qa_reply()'),
  ('function', 'private', '', 'engagement_produce_contact_log()'),
  ('function', 'private', '', 'organization_feature_enabled(p_organization_id uuid, p_key text)'),
  ('function', 'private', '', 'organization_setting_effective(p_organization_id uuid, p_key text, p_kind text)')
) as changed(kind, schema_name, table_name, object_name)
  on surface.kind = changed.kind and surface.schema_name = changed.schema_name
 and surface.table_name = changed.table_name and surface.object_name = changed.object_name
on conflict (kind, schema_name, table_name, object_name) do update
  set definition_hash = excluded.definition_hash;

do $assert_l2_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the engagement producers';
  end if;
end;
$assert_l2_lifecycle$;

notify pgrst, 'reload schema';

commit;
