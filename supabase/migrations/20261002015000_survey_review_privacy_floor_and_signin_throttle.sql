-- SEC-UG-SURVEY-REVIEW-PRIVACY-FLOOR-20261001
-- SEC-UG-PASSWORD-SIGNIN-THROTTLE-20261001
--
-- Part 1. Survey review privacy floor.
--
-- Survey reports and exports are withheld until a survey's
-- privacy_min_responses (at least 3) submitted responses exist, but the
-- per-response review lane was not: get_organization_survey_review_detail
-- returned one respondent's full answers to staff at any count, the staff
-- snapshot listed every review row with its creation time (the submission
-- time), and update_organization_survey_review let staff triage single
-- responses before the floor. The old app kept the review lane in
-- "collection mode" below the floor and never showed raw answers there
-- (de7df4b57c^:lib/surveys/results-privacy.ts:58-63 and 160-171,
-- DEFAULT_SURVEY_RESULT_MIN_RESPONSES = 3 at line 1).
--
-- This migration restores that rule:
--   * private.organization_survey_review_lane(org, survey) answers
--     {state: 'collecting' | 'ready', responseCount, privacyMinResponses},
--     counting submitted sessions of the survey in that organization only;
--   * get_organization_survey_review_detail reads only a submitted session of
--     the selected organization and returns no answers while collecting;
--   * update_organization_survey_review refuses triage while collecting
--     (55000), keeping the 20260907151000 case-graph entry lock first;
--   * get_staff_engagement_snapshot (re-emitted from 20260923210000 with only
--     the review keys changed) returns reviewLane per survey and no review
--     rows, review-state counts or review timestamps while collecting.
-- Reports and exports already apply the same floor (20260828220000).
-- The per-survey privacy floor stays the control (survey editor and
-- set_organization_survey_privacy_floor, 3..50); there is no switch that
-- turns the floor off.
--
-- Part 2. Password sign-in throttle.
--
-- api/auth-password-signin.js proxied password grants to GoTrue with no
-- per-address or per-network limit, and GoTrue's own per-IP limit counts the
-- server's address. The old app limited each email address to 5 attempts an
-- hour and each network address to 20 an hour
-- (de7df4b57c^:lib/security/rate-limit.ts:152-160, emailLimiter and
-- ipLimiter; checked together before the credential check in
-- app/api/auth/otp/verify/route.ts:36-41), backed by the database because
-- serverless instances share no memory.
--
--   * private.auth_attempt_throttle is a generic fixed-window throttle keyed
--     by (scope, HMAC of the key). The HMAC key is generated in this database
--     at apply time (private.auth_attempt_throttle_key) and never leaves it,
--     so neither raw addresses nor network buckets are stored. Rows older
--     than two days are pruned opportunistically, up to 200 per call.
--   * private.auth_attempt_check(scope, key, limit, window) charges one
--     attempt and answers whether it is allowed. Later sign-in methods (for
--     example a PIN) reuse it with their own scope.
--   * public.consume_password_signin_attempt(email, network) is the
--     service-role entry for the route: it charges the network bucket, then
--     the address bucket, and answers false when either is full.
--
-- The two limits are platform setting definitions,
-- limits.security.signin_attempts_per_email_hour (default 5, 1..100) and
-- limits.security.signin_attempts_per_ip_hour (default 20, 1..1000). They are
-- platform-wide on purpose: a sign-in attempt arrives before any
-- organization is known, and a limit that followed the target account's
-- organization would make the 429 boundary reveal which addresses belong to
-- that organization. Organization rows for these two keys are refused by a
-- check constraint, the admin page shows them read-only, and the value is
-- the definition default (changed by a reviewed migration).
-- private.urgent_b_setting_limit is a local reader until the shared
-- organization settings helper lands; it returns the organization value
-- when one exists, else the definition default, and raises on an unknown
-- key.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- Settings definitions and a local reader
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order)
values
  ('limits.security.signin_attempts_per_email_hour', 'integer', 'Password sign-in attempts per address per hour',
   'Platform-wide. Password sign-in attempts allowed for one email address in an hour before the sign-in page asks the person to wait.',
   '5', 1, 100, null, 50),
  ('limits.security.signin_attempts_per_ip_hour', 'integer', 'Password sign-in attempts per network per hour',
   'Platform-wide. Password sign-in attempts allowed from one network address in an hour, across all email addresses.',
   '20', 1, 1000, null, 60)
on conflict (key) do nothing;

alter table public.organization_setting_values
  add constraint organization_setting_values_platform_wide_keys
  check (setting_key not in (
    'limits.security.signin_attempts_per_email_hour',
    'limits.security.signin_attempts_per_ip_hour'
  ));

create function private.urgent_b_setting_limit(p_organization_id uuid, p_key text)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  definition public.platform_setting_definitions%rowtype;
  stored jsonb;
begin
  select * into definition from public.platform_setting_definitions d where d.key = p_key;
  if not found or definition.value_kind <> 'integer' then
    raise exception 'unknown integer setting %', p_key using errcode = '22023';
  end if;
  if p_organization_id is not null then
    select v.value into stored
    from public.organization_setting_values v
    where v.organization_id = p_organization_id and v.setting_key = p_key;
    if stored is not null and private.setting_value_valid(
      definition.value_kind, stored, definition.minimum, definition.maximum, definition.allowed_values
    ) then
      return (stored #>> '{}')::integer;
    end if;
  end if;
  return (definition.default_value #>> '{}')::integer;
end;
$function$;

revoke all on function private.urgent_b_setting_limit(uuid, text)
  from public, anon, authenticated, service_role;

comment on function private.urgent_b_setting_limit(uuid, text) is
  'Local integer setting reader (W1-URGENT-B): the organization value when one is stored and valid, else the definition default; a null organization reads the default. Raises 22023 for an unknown or non-integer key. To be replaced by the shared organization settings helper.';

-- ---------------------------------------------------------------------------
-- Generic authentication attempt throttle
-- ---------------------------------------------------------------------------

create table private.auth_attempt_throttle_key (
  id boolean primary key default true check (id),
  secret bytea not null check (pg_catalog.octet_length(secret) = 32),
  created_at timestamptz not null default pg_catalog.now()
);

alter table private.auth_attempt_throttle_key enable row level security;
alter table private.auth_attempt_throttle_key force row level security;
revoke all on private.auth_attempt_throttle_key from public, anon, authenticated, service_role;

insert into private.auth_attempt_throttle_key (id, secret)
values (true, extensions.gen_random_bytes(32))
on conflict (id) do nothing;

comment on table private.auth_attempt_throttle_key is
  'One database-local 256-bit HMAC key for private.auth_attempt_throttle, generated at apply time. Holds no person data. Replacing it only resets open throttle windows.';

create table private.auth_attempt_throttle (
  scope text not null check (scope ~ '^[a-z][a-z0-9-]{2,62}$'),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count > 0),
  primary key (scope, key_hash)
);

create index auth_attempt_throttle_window_idx
  on private.auth_attempt_throttle (window_started_at);

alter table private.auth_attempt_throttle enable row level security;
alter table private.auth_attempt_throttle force row level security;
revoke all on private.auth_attempt_throttle from public, anon, authenticated, service_role;

comment on table private.auth_attempt_throttle is
  'Fixed-window counters for authentication attempts. Keys are HMAC-SHA-256 digests under private.auth_attempt_throttle_key, never raw addresses. Rows older than 2 days are pruned opportunistically (up to 200 per call). Written only by private.auth_attempt_check.';

create function private.auth_attempt_check(
  p_scope text,
  p_key text,
  p_limit integer,
  p_window interval
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  key_secret bytea;
  digest text;
  moment timestamptz := pg_catalog.clock_timestamp();
  current_row private.auth_attempt_throttle%rowtype;
begin
  if p_scope is null or p_scope !~ '^[a-z][a-z0-9-]{2,62}$'
     or p_key is null or pg_catalog.char_length(p_key) not between 1 and 512
     or p_limit is null or p_limit < 1
     or p_window is null or p_window < interval '1 second' or p_window > interval '1 day' then
    raise exception 'invalid attempt throttle' using errcode = '22023';
  end if;
  select k.secret into key_secret from private.auth_attempt_throttle_key k where k.id;
  if key_secret is null then
    raise exception 'attempt throttle key unavailable' using errcode = '55000';
  end if;
  digest := pg_catalog.encode(extensions.hmac(
    pg_catalog.convert_to(p_scope || ':' || p_key, 'UTF8'), key_secret, 'sha256'), 'hex');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('auth-attempt-throttle:' || p_scope || ':' || digest, 509));

  delete from private.auth_attempt_throttle stale
  where stale.ctid in (
    select old.ctid from private.auth_attempt_throttle old
    where old.window_started_at < moment - interval '2 days'
    limit 200);

  select * into current_row
  from private.auth_attempt_throttle t
  where t.scope = p_scope and t.key_hash = digest
  for update;

  if not found then
    insert into private.auth_attempt_throttle (scope, key_hash, window_started_at, attempt_count)
    values (p_scope, digest, moment, 1);
    return true;
  end if;
  if current_row.window_started_at + p_window <= moment then
    update private.auth_attempt_throttle t
    set window_started_at = moment, attempt_count = 1
    where t.scope = p_scope and t.key_hash = digest;
    return true;
  end if;
  if current_row.attempt_count >= p_limit then
    return false;
  end if;
  update private.auth_attempt_throttle t
  set attempt_count = t.attempt_count + 1
  where t.scope = p_scope and t.key_hash = digest;
  return true;
end;
$function$;

revoke all on function private.auth_attempt_check(text, text, integer, interval)
  from public, anon, authenticated, service_role;

comment on function private.auth_attempt_check(text, text, integer, interval) is
  'Charges one attempt against the fixed window for (scope, HMAC(key)) and returns false once p_limit attempts are already counted in the current window. Windows from 1 second to 1 day. Not executable by any client role; reached through method-specific service RPCs such as public.consume_password_signin_attempt.';

create function public.consume_password_signin_attempt(p_email text, p_network text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  network text := coalesce(p_network, '');
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     or network !~ '^(ipv4:[0-9]{1,3}(\.[0-9]{1,3}){3}|ipv6:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::/64|unknown)$' then
    raise exception 'invalid sign-in attempt' using errcode = '22023';
  end if;
  -- The network bucket is charged first: a network that is already over its
  -- budget does not also spend the address's budget.
  if not private.auth_attempt_check('password-signin-network', network,
      private.urgent_b_setting_limit(null, 'limits.security.signin_attempts_per_ip_hour'),
      interval '1 hour') then
    return false;
  end if;
  return private.auth_attempt_check('password-signin-email', normalized_email,
    private.urgent_b_setting_limit(null, 'limits.security.signin_attempts_per_email_hour'),
    interval '1 hour');
end;
$function$;

revoke all on function public.consume_password_signin_attempt(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_password_signin_attempt(text, text) to service_role;

comment on function public.consume_password_signin_attempt(text, text) is
  'Service-role throttle for api/auth-password-signin.js. Charges one attempt to the network bucket and then to the normalized address bucket (fixed one-hour windows, platform-wide limits limits.security.signin_attempts_per_ip_hour and limits.security.signin_attempts_per_email_hour) and returns false when either is full. Never reads whether the address has an account.';

-- ---------------------------------------------------------------------------
-- Survey review privacy floor
-- ---------------------------------------------------------------------------

create function private.organization_survey_review_lane(p_organization_id uuid, p_survey_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'state', case when counted.responses >= survey.privacy_min_responses then 'ready' else 'collecting' end,
    'responseCount', counted.responses,
    'privacyMinResponses', survey.privacy_min_responses
  )
  from public.organization_surveys survey
  cross join lateral (
    select pg_catalog.count(*)::integer as responses
    from public.organization_survey_sessions session
    where session.organization_id = p_organization_id
      and session.survey_id = survey.id
      and session.status = 'submitted'
  ) counted
  where survey.id = p_survey_id and survey.organization_id = p_organization_id
$function$;

revoke all on function private.organization_survey_review_lane(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.organization_survey_review_lane(uuid, uuid) is
  'Review-lane privacy state of one survey in one organization: collecting until the submitted responses reach the survey privacy_min_responses, then ready. Null when the survey is not in that organization.';

create or replace function public.get_organization_survey_review_detail(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  target_survey uuid;
  lane jsonb;
begin
  perform private.engagement_require_staff(org);
  select session.survey_id into target_survey
  from public.organization_survey_sessions session
  where session.id = p_session_id
    and session.organization_id = org
    and session.status = 'submitted';
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  lane := private.organization_survey_review_lane(org, target_survey);
  if lane ->> 'state' is distinct from 'ready' then
    return pg_catalog.jsonb_build_object(
      'sessionId', p_session_id,
      'surveyId', target_survey,
      'available', false,
      'state', 'collecting',
      'responseCount', (lane ->> 'responseCount')::integer,
      'privacyMinResponses', (lane ->> 'privacyMinResponses')::integer,
      'answers', '[]'::jsonb
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'sessionId', p_session_id,
    'surveyId', target_survey,
    'available', true,
    'state', 'ready',
    'responseCount', (lane ->> 'responseCount')::integer,
    'privacyMinResponses', (lane ->> 'privacyMinResponses')::integer,
    'answers', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'questionId', answer.question_id,
        'label', question.label,
        'type', question.question_type,
        'value', answer.value
      ) order by question.sort_index)
      from public.organization_survey_answers answer
      join public.organization_survey_questions question on question.id = answer.question_id
      where answer.session_id = p_session_id and answer.organization_id = org
    ), '[]'::jsonb)
  );
end;
$function$;

comment on function public.get_organization_survey_review_detail(uuid) is
  'Staff read of one submitted survey response in the selected organization. While the survey has fewer submitted responses than its privacy floor it returns state collecting with the counts and no answers.';

create or replace function public.update_organization_survey_review(
  p_review_id uuid,
  p_state text,
  p_assigned_to uuid default null,
  p_disposition text default null,
  p_follow_up_due_at timestamp with time zone default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  review public.organization_survey_reviews%rowtype;
  target_survey uuid;
begin
  perform private.engagement_require_staff(org);
  if p_state not in ('unreviewed', 'assigned', 'follow_up', 'resolved', 'dismissed') then
    raise exception 'invalid review state' using errcode = '22023';
  end if;
  if p_assigned_to is not null and not private.engagement_user_in_organization(org, p_assigned_to) then
    raise exception 'reviewer is not an active organization member' using errcode = '42501';
  end if;
  select existing.survey_id into target_survey
  from public.organization_survey_reviews existing
  where existing.id = p_review_id and existing.organization_id = org;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if private.organization_survey_review_lane(org, target_survey) ->> 'state' is distinct from 'ready' then
    raise exception 'survey review is collecting responses' using errcode = '55000';
  end if;
  update public.organization_survey_reviews
  set state = p_state,
      assigned_to = p_assigned_to,
      disposition = nullif(pg_catalog.btrim(coalesce(p_disposition, '')), ''),
      follow_up_due_at = p_follow_up_due_at,
      updated_at = pg_catalog.now()
  where id = p_review_id and organization_id = org
  returning * into review;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'survey_response_review_updated', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', review.survey_id,
    'sessionId', review.session_id,
    'reviewId', review.id,
    'userId', (select auth.uid()),
    'status', review.state,
    'fieldsChanged', pg_catalog.jsonb_build_array('assignment', 'state', 'disposition', 'followUpDueAt')
  ));
  return pg_catalog.jsonb_build_object(
    'id', review.id, 'surveyId', review.survey_id, 'sessionId', review.session_id,
    'state', review.state, 'assignedTo', review.assigned_to,
    'disposition', review.disposition, 'followUpDueAt', review.follow_up_due_at
  );
end;
end;
$function$;

-- Re-emitted from 20260923210000_live_poll_chapter_scope_enforcement.sql.
-- Only the review keys change: reviewLane is added, and reviewCounts and
-- reviews are empty while the survey is collecting.
create or replace function public.get_staff_engagement_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
begin
  perform private.engagement_require_staff(org);
  return pg_catalog.jsonb_build_object(
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', survey.id, 'title', survey.title, 'status', survey.status,
        'cadence', survey.cadence, 'periodKey', survey.period_key,
        'privacyMinResponses', survey.privacy_min_responses,
        'operationsState', survey.operations_state, 'ownerUserId', survey.owner_user_id,
        'opensAt', survey.opens_at, 'closesAt', survey.closes_at,
        'reviewDueAt', survey.review_due_at,
        'coverage', pg_catalog.jsonb_build_object(
          'total', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id),
          'sent', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state in ('sent', 'engaged')),
          'engaged', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'engaged'),
          'failed', (select pg_catalog.count(*) from public.organization_survey_deliveries delivery where delivery.survey_id = survey.id and delivery.state = 'failed')
        ),
        'tasks', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', task.id, 'reason', task.reason, 'status', task.status,
            'assignedTo', task.assigned_to, 'dueAt', task.due_at
          ) order by task.created_at)
          from public.organization_survey_tasks task where task.survey_id = survey.id
        ), '[]'::jsonb),
        'reviewLane', lane.value,
        'reviewCounts', case when lane.value ->> 'state' = 'ready' then coalesce((
          select pg_catalog.jsonb_object_agg(counts.state, counts.count)
          from (
            select review.state, pg_catalog.count(*)::integer as count
            from public.organization_survey_reviews review
            where review.survey_id = survey.id group by review.state
          ) counts
        ), '{}'::jsonb) else '{}'::jsonb end,
        'reviews', case when lane.value ->> 'state' = 'ready' then coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', review.id, 'sessionId', review.session_id,
            'state', review.state, 'assignedTo', review.assigned_to,
            'disposition', review.disposition,
            'followUpDueAt', review.follow_up_due_at,
            'createdAt', review.created_at
          ) order by review.created_at desc)
          from public.organization_survey_reviews review
          where review.survey_id = survey.id
        ), '[]'::jsonb) else '[]'::jsonb end,
        'questions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', question.id, 'sortIndex', question.sort_index,
            'type', question.question_type, 'label', question.label,
            'required', question.required, 'options', question.options,
            'sectionKey', question.section_key, 'sectionTitle', question.section_title,
            'branchParentId', question.branch_parent_id,
            'branchValue', question.branch_value
          ) order by question.sort_index)
          from public.organization_survey_questions question
          where question.survey_id = survey.id
        ), '[]'::jsonb)
      ) order by survey.updated_at desc)
      from public.organization_surveys survey
      cross join lateral (
        select private.organization_survey_review_lane(org, survey.id) as value
      ) lane
      where survey.organization_id = org
    ), '[]'::jsonb),
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', prompt.id, 'chapterId', prompt.chapter_id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'active', prompt.active,
        'cooldownHours', prompt.cooldown_hours,
        'shown', (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id),
        'responded', (select pg_catalog.count(*) from public.organization_pulse_events event where event.prompt_id = prompt.id and event.state = 'responded')
      ) order by prompt.updated_at desc)
      from public.organization_pulse_prompts prompt where prompt.organization_id = org
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', poll.vote_count,
        'results', poll.result_cache,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', pg_catalog.jsonb_build_object(
          'roster', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.eligible),
          'rsvpYes', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.rsvp = 'yes'),
          'checkedIn', (select pg_catalog.count(*) from public.organization_live_poll_attendance attendance where attendance.poll_id = poll.id and attendance.checked_in_at is not null)
        )
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll where poll.organization_id = org
    ), '[]'::jsonb),
    'delivery', coalesce((
      select pg_catalog.jsonb_object_agg(summary.state, summary.count)
      from (
        select outbox.state, pg_catalog.count(*)::integer as count
        from public.engagement_delivery_outbox outbox
        where outbox.organization_id = org group by outbox.state
      ) summary
    ), '{}'::jsonb),
    'presence', pg_catalog.jsonb_build_object(
      'online', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.status = 'online' and presence.last_seen_at >= pg_catalog.now() - interval '2 minutes'),
      'away', (select pg_catalog.count(*) from public.member_presence presence where presence.organization_id = org and presence.last_seen_at >= pg_catalog.now() - interval '15 minutes')
    ),
    'chapters', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', chapter.id, 'name', chapter.name
      ) order by chapter.order_index, chapter.name, chapter.id)
      from public.chapters chapter
      where chapter.organization_id = org
    ), '[]'::jsonb),
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', membership.user_id,
        'name', coalesce(profile.full_name, 'Member'),
        'chapterId', profile.chapter_id
      ) order by coalesce(profile.full_name, ''), membership.user_id)
      from public.organization_memberships membership
      left join public.member_profiles profile on profile.id = membership.user_id
      where membership.organization_id = org
        and membership.status = 'active' and membership.revoked_at is null
    ), '[]'::jsonb),
    'channels', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'spaceId', space.id, 'name', space.name,
        'postingMode', coalesce(control.posting_mode, 'members'),
        'slowModeSeconds', coalesce(control.slow_mode_seconds, 0),
        'approvalsRequired', coalesce(control.approvals_required, false)
      ) order by space.name, space.id)
      from public.chapter_spaces space
      join public.chapters chapter on chapter.id = space.chapter_id and chapter.organization_id = org
      left join public.chapter_space_controls control on control.space_id = space.id
      where space.archived_at is null
    ), '[]'::jsonb)
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;
