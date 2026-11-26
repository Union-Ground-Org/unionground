-- SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001
-- BUG-UG-STEWARD-DEADLINE-REMINDERS-20261001
--
-- Restore-everything campaign, (owner request 2026-10-01).
--
-- 1. Engagement email honours the member's own email choices.
--
--    public.engagement_delivery_outbox carries four kinds of optional member
--    engagement mail: broadcasts and welcome-campaign steps (category
--    "announcements") and survey invitations and reminders (category
--    "surveys"). Until now every enqueue path queued every active member and
--    api/engagement-delivery.js sent without an unsubscribe header. The old
--    app (de7df4b57c^: lib/email/unsubscribe-token.ts,
--    app/api/email/unsubscribe/route.ts, supabase/migrations/0717) suppressed
--    broadcast and welcome mail for an unsubscribed address and signed an RFC
--    8058 one-click link into every message.
--
--    The choice lives where every other member notification choice already
--    lives: two keys in public.member_profiles.notification_prefs
--    ("announcements" and "surveys"; absent means enabled, exactly like the
--    topic keys). Web Settings and the native Account card show both switches.
--    No engagement kind is transactional or legally required: invitations,
--    passwords, sign-in recovery, security notices and the case and deadline
--    notification plane never enter this outbox, so every outbox kind honours
--    the opt-out. An unclassified future kind is treated as opted out until it
--    is classified here (fail closed).
--
--    * Enqueue: all four producers skip an opted-out recipient. A survey
--      distribution still records the recipient's delivery row (the survey
--      stays available in the app) in state 'suppressed'.
--    * Send: get_engagement_delivery_payload re-checks the choice at lease
--      time and answers suppressed; complete_engagement_delivery records
--      'recipient_opted_out' as a terminal 'suppressed' state, never a retry.
--    * One-click: the payload carries a signed token. The signing key is a
--      database-local 256-bit secret no client role can read;
--      public.apply_engagement_email_unsubscribe (service_role only) verifies
--      it in constant time over a digest, refuses a token older than 60 days,
--      and turns off exactly the token's category for exactly its member.
--    * A writer that predates the two keys (an installed phone build, a stale
--      browser tab) sends the topic map without them. Absent means enabled, so
--      a BEFORE UPDATE trigger keeps a stored engagement choice the new map
--      omits: an opt-out is reversed only by an explicit true.
--
-- 2. Assigned stewards and coordinators are warned about case deadlines.
--
--    private.case_deadline_notice_sweep notified only member_cases.user_id.
--    The old app's daily processDeadlineReminders
--    (de7df4b57c^:app/api/cron/notifications/_lib/cron-notification-jobs.ts,
--    DEADLINE_WINDOW_DAYS = 3, no feature flag) warned the assigned steward.
--    The casework suite's casework_deadlines (20260828210000, procedure
--    deadlines since 20260917133000) is the authoritative model of step
--    deadlines today, and member_cases.deadline is still the member-facing
--    case deadline, so both are covered.
--
--    private.staff_deadline_notice_sweep runs at the end of the existing daily
--    deadline tick. For each active case deadline inside the organization's
--    window it notifies the case's assigned steward and coordinator once per
--    threshold: entering the window, the day before, and the day itself. A
--    closer notice back-fills the farther ones; a changed due date starts a
--    fresh set. Access is re-checked for each recipient at fire time with
--    private.casework_reminder_owner_can_read. The notice is kind 'deadlines'
--    (the existing urgent classification: it pierces quiet hours only while
--    the recipient allows urgent alerts, honours the recipient's deadline
--    topic switch and bypasses the weekly nudge cap) and, like
--    casework.reminder.due (20260924190100), names no case, member, step or
--    narrative.
--
--    Switch features.notifications.steward_deadline_reminders (default ON: the
--    old app had no flag) and limit
--    limits.notifications.steward_deadline_reminder_days (default 3 = the old
--    DEADLINE_WINDOW_DAYS, bounds 1..30) are organization settings shown by the
--    existing admin configuration page. Member deadline notices are unchanged.
--
-- Settings are read through private.urgent_a_setting_enabled /
-- private.urgent_a_setting_integer. W1-SETTINGS ships the shared helpers
-- private.organization_feature_enabled / private.organization_limit; swap
-- these two calls for those at integration.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Organization switches and the lane-local setting readers
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, sort_order)
values
  ('features.notifications.steward_deadline_reminders', 'boolean', 'Steward deadline reminders',
   'Warn the assigned steward and coordinator when a case deadline is close. Member deadline notices are not affected.',
   'true', null, null, 200),
  ('limits.notifications.steward_deadline_reminder_days', 'integer', 'Steward deadline warning window (days)',
   'How many days before a case deadline the assigned steward and coordinator are first warned. They are warned again the day before and on the day.',
   '3', 1, 30, 210)
on conflict (key) do nothing;

create function private.urgent_a_setting_enabled(p_organization_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select (v.value #>> '{}')::boolean
       from public.organization_setting_values v
      where p_organization_id is not null
        and v.organization_id = p_organization_id
        and v.setting_key = p_key
        and pg_catalog.jsonb_typeof(v.value) = 'boolean'),
    (select (d.default_value #>> '{}')::boolean
       from public.platform_setting_definitions d
      where d.key = p_key
        and d.value_kind = 'boolean'
        and pg_catalog.jsonb_typeof(d.default_value) = 'boolean'),
    false);
$function$;

create function private.urgent_a_setting_integer(p_organization_id uuid, p_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    (select (v.value #>> '{}')::integer
       from public.organization_setting_values v
       join public.platform_setting_definitions d on d.key = v.setting_key
      where p_organization_id is not null
        and v.organization_id = p_organization_id
        and v.setting_key = p_key
        and d.value_kind = 'integer'
        and private.setting_value_valid(d.value_kind, v.value, d.minimum, d.maximum, d.allowed_values)),
    (select (d.default_value #>> '{}')::integer
       from public.platform_setting_definitions d
      where d.key = p_key
        and d.value_kind = 'integer'
        and private.setting_value_valid(d.value_kind, d.default_value, d.minimum, d.maximum, d.allowed_values)));
$function$;

revoke all on function private.urgent_a_setting_enabled(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.urgent_a_setting_integer(uuid, text) from public, anon, authenticated, service_role;

comment on function private.urgent_a_setting_enabled(uuid, text) is
  'Boolean setting reader: the organization value, else the registry default, else false.';
comment on function private.urgent_a_setting_integer(uuid, text) is
  'Integer setting reader: the organization value when it validates against the registry bounds, else the registry default.';

-- ---------------------------------------------------------------------------
-- 1. Engagement email classification and the member's choice
-- ---------------------------------------------------------------------------

create function private.engagement_email_category(p_delivery_kind text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case p_delivery_kind
    when 'broadcast' then 'announcements'
    when 'welcome' then 'announcements'
    when 'survey_invitation' then 'surveys'
    when 'survey_reminder' then 'surveys'
  end;
$function$;

revoke all on function private.engagement_email_category(text) from public, anon, authenticated, service_role;

comment on function private.engagement_email_category(text) is
  'Classifies every engagement_delivery_outbox kind. All four are optional member engagement mail (none transactional or legally required), so each honours the member''s notification_prefs choice. A kind with no category is never sent.';

create function private.engagement_email_opted_out(p_user_id uuid, p_delivery_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.engagement_email_category(p_delivery_kind) is null
    or coalesce((
      select (profile.notification_prefs -> private.engagement_email_category(p_delivery_kind)) = 'false'::jsonb
        from public.member_profiles profile
       where profile.id = p_user_id
    ), false);
$function$;

revoke all on function private.engagement_email_opted_out(uuid, text) from public, anon, authenticated, service_role;

comment on function private.engagement_email_opted_out(uuid, text) is
  'True when the recipient turned off the delivery kind''s email category in notification_prefs (absent means enabled), or when the kind is unclassified.';

-- A stored engagement choice survives a write that omits its key.
create function private.preserve_engagement_email_preferences()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.notification_prefs := coalesce((
    select pg_catalog.jsonb_object_agg(stored.key, stored.value)
      from pg_catalog.jsonb_each(old.notification_prefs) stored
     where stored.key in ('announcements', 'surveys')
       and not (new.notification_prefs ? stored.key)
  ), '{}'::jsonb) || new.notification_prefs;
  return new;
end;
$function$;

revoke all on function private.preserve_engagement_email_preferences() from public, anon, authenticated, service_role;

create trigger preserve_engagement_email_preferences
before update of notification_prefs on public.member_profiles
for each row execute function private.preserve_engagement_email_preferences();

comment on function private.preserve_engagement_email_preferences() is
  'Keeps a stored announcements/surveys email choice when an older writer replaces notification_prefs without that key, so an unsubscribe is never silently reversed. Only an explicit true re-enables.';

-- ---------------------------------------------------------------------------
-- 2. Signed one-click unsubscribe
-- ---------------------------------------------------------------------------

create table private.engagement_email_unsubscribe_key (
  singleton boolean primary key default true check (singleton),
  secret bytea not null check (pg_catalog.octet_length(secret) = 32),
  created_at timestamptz not null default pg_catalog.now()
);

revoke all on table private.engagement_email_unsubscribe_key from public, anon, authenticated, service_role;

insert into private.engagement_email_unsubscribe_key (singleton, secret)
values (true, extensions.gen_random_bytes(32))
on conflict (singleton) do nothing;

comment on table private.engagement_email_unsubscribe_key is
  'Database-local HMAC key for engagement email one-click unsubscribe tokens. No client role can read it; rotating it invalidates every outstanding link (the stored choices stay).';

-- base64url HMAC-SHA256 (43 characters) over a domain-separated payload.
create function private.engagement_email_unsubscribe_signature(p_payload text)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.translate(pg_catalog.encode(extensions.hmac(
      pg_catalog.convert_to('engagement-email-unsubscribe-v1:' || p_payload, 'UTF8'),
      signing.secret,
      'sha256'), 'base64'), '+/=' || pg_catalog.chr(10), '-_')
    from private.engagement_email_unsubscribe_key signing
   where signing.singleton;
$function$;

-- <member uuid>.<category>.<issued unix seconds>.<signature>
create function private.engagement_email_unsubscribe_token(p_user_id uuid, p_category text)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select issued.payload || '.' || private.engagement_email_unsubscribe_signature(issued.payload)
    from (
      select p_user_id::text || '.' || p_category || '.'
        || pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()))::bigint::text as payload
    ) issued
   where p_user_id is not null
     and p_category in ('announcements', 'surveys');
$function$;

revoke all on function private.engagement_email_unsubscribe_signature(text) from public, anon, authenticated, service_role;
revoke all on function private.engagement_email_unsubscribe_token(uuid, text) from public, anon, authenticated, service_role;

create function public.apply_engagement_email_unsubscribe(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_parts text[];
  v_expected text;
  v_issued bigint;
  v_now bigint;
  v_user uuid;
  v_category text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if p_token is null
     or pg_catalog.char_length(p_token) > 160
     or p_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](announcements|surveys)[.][0-9]{10}[.][A-Za-z0-9_-]{43}$' then
    return pg_catalog.jsonb_build_object('applied', false);
  end if;
  v_parts := pg_catalog.string_to_array(p_token, '.');
  v_expected := coalesce(private.engagement_email_unsubscribe_signature(
    v_parts[1] || '.' || v_parts[2] || '.' || v_parts[3]), '');
  -- Compare digests, not the signatures, so the comparison time does not
  -- depend on how many leading characters of a forged signature are right.
  if extensions.digest(v_parts[4], 'sha256') is distinct from extensions.digest(v_expected, 'sha256') then
    return pg_catalog.jsonb_build_object('applied', false);
  end if;
  v_issued := v_parts[3]::bigint;
  v_now := pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()))::bigint;
  if v_issued > v_now + 300 or v_issued < v_now - 60 * 86400 then
    return pg_catalog.jsonb_build_object('applied', false);
  end if;
  v_user := v_parts[1]::uuid;
  v_category := v_parts[2];
  update public.member_profiles profile
     set notification_prefs = profile.notification_prefs || pg_catalog.jsonb_build_object(v_category, false)
   where profile.id = v_user;
  if not found then
    return pg_catalog.jsonb_build_object('applied', false);
  end if;
  return pg_catalog.jsonb_build_object('applied', true, 'category', v_category);
end;
$function$;

revoke all on function public.apply_engagement_email_unsubscribe(text) from public, anon, authenticated;
grant execute on function public.apply_engagement_email_unsubscribe(text) to service_role;

comment on function public.apply_engagement_email_unsubscribe(text) is
  'RFC 8058 one-click unsubscribe for engagement email (service_role only, called by api/email-unsubscribe.js). Verifies the database-signed token, refuses one older than 60 days, and sets exactly that member''s announcements or surveys email choice to false. Every refusal is the same {"applied": false}.';

-- ---------------------------------------------------------------------------
-- 3. Enqueue: every producer skips an opted-out recipient
-- ---------------------------------------------------------------------------

create or replace function private.queue_member_broadcast_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

begin
  if new.organization_id is null then return new; end if;
  insert into public.engagement_delivery_outbox (
    organization_id, recipient_user_id, delivery_kind, source_kind, source_id, locale
  )
  select new.organization_id, membership.user_id, 'broadcast', 'broadcast', new.id, new.locale
  from public.organization_memberships membership
  left join public.member_profiles profile on profile.id = membership.user_id
  where membership.organization_id = new.organization_id
    and membership.status = 'active'
    and membership.revoked_at is null
    and (new.audience_scope = 'organization' or profile.chapter_id = new.chapter_id)
    and not private.engagement_email_opted_out(membership.user_id, 'broadcast')
  on conflict (delivery_kind, source_id, recipient_user_id) do nothing;
  return new;
end;
end;
$function$;

create or replace function public.prepare_organization_survey_distribution(
  p_survey_id uuid,
  p_recipient_user_ids uuid[] default null
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
  survey public.organization_surveys%rowtype;
  queued integer := 0;
begin
  perform private.engagement_require_staff(org);
  select * into survey
  from public.organization_surveys
  where id = p_survey_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if survey.status <> 'open' then
    raise exception 'survey must be open before distribution' using errcode = '55000';
  end if;

  -- An opted-out member stays in the survey's audience (the survey is open
  -- to them in the app) but gets a suppressed delivery row and no email.
  with eligible as (
    select distinct membership.user_id,
      private.engagement_email_opted_out(membership.user_id, 'survey_invitation') as opted_out
    from public.organization_memberships membership
    left join public.member_profiles profile on profile.id = membership.user_id
    where membership.organization_id = org
      and membership.status = 'active'
      and membership.revoked_at is null
      and (p_recipient_user_ids is null or membership.user_id = any(p_recipient_user_ids))
      and (survey.chapter_id is null or profile.chapter_id = survey.chapter_id)
  ), inserted as (
    insert into public.organization_survey_deliveries (
      organization_id, survey_id, recipient_user_id, state, last_error_code
    )
    select org, survey.id, eligible.user_id,
      case when eligible.opted_out then 'suppressed' else 'queued' end,
      case when eligible.opted_out then 'recipient_opted_out' end
    from eligible
    on conflict (survey_id, recipient_user_id) do nothing
    returning recipient_user_id, state
  )
  insert into public.engagement_delivery_outbox (
    organization_id, recipient_user_id, delivery_kind, source_kind, source_id
  )
  select org, inserted.recipient_user_id, 'survey_invitation', 'survey', survey.id::text
  from inserted
  where inserted.state = 'queued'
  on conflict (delivery_kind, source_id, recipient_user_id) do nothing;

  get diagnostics queued = row_count;
  update public.organization_surveys
  set operations_state = 'distributing', updated_at = pg_catalog.now()
  where id = survey.id;
  insert into public.organization_survey_tasks (
    organization_id, survey_id, reason, status, assigned_to, created_by
  ) values (
    org, survey.id, 'distribution', 'in_progress', survey.owner_user_id, (select auth.uid())
  )
  on conflict (survey_id, reason) do update
    set status = 'in_progress', assigned_to = excluded.assigned_to, updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'survey_published', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', survey.id,
    'status', 'distributing',
    'count', queued,
    'reasonCode', 'distribution_prepared'
  ));
  return pg_catalog.jsonb_build_object('surveyId', survey.id, 'queued', queued);
end;
end;
$function$;

create or replace function public.queue_organization_survey_reminders(p_survey_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  queued integer;
begin
  perform private.engagement_require_staff(org);
  if not exists (
    select 1 from public.organization_surveys s
    where s.id = p_survey_id and s.organization_id = org and s.status = 'open'
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  with candidates as (
    select d.recipient_user_id
    from public.organization_survey_deliveries d
    where d.organization_id = org
      and d.survey_id = p_survey_id
      and d.state in ('queued', 'sent', 'failed')
      and d.engaged_at is null
      and not private.engagement_email_opted_out(d.recipient_user_id, 'survey_reminder')
  ), inserted as (
    insert into public.engagement_delivery_outbox (
      organization_id, recipient_user_id, delivery_kind, source_kind, source_id
    )
    select org, candidates.recipient_user_id, 'survey_reminder', 'survey', p_survey_id::text
    from candidates
    on conflict (delivery_kind, source_id, recipient_user_id) do update
      set state = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.state
            else 'queued'
          end,
          available_at = case
            when public.engagement_delivery_outbox.state = 'sent' then public.engagement_delivery_outbox.available_at
            else pg_catalog.now()
          end,
          updated_at = pg_catalog.now()
      where public.engagement_delivery_outbox.state <> 'sent'
    returning recipient_user_id
  )
  select pg_catalog.count(*)::integer into queued from inserted;
  update public.organization_survey_deliveries
  set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
  where organization_id = org and survey_id = p_survey_id and engaged_at is null;
  perform private.mi1_w2_write_audit(org, 'survey_reminders_queued', pg_catalog.jsonb_build_object(
    'organizationId', org,
    'surveyId', p_survey_id,
    'userId', (select auth.uid()),
    'count', coalesce(queued, 0)
  ));
  return pg_catalog.jsonb_build_object('surveyId', p_survey_id, 'queued', coalesce(queued, 0));
end;
end;
$function$;

create or replace function public.queue_due_welcome_messages(p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.require_member_operations_admin();
  queued integer := 0;
  enrollment record;
  step_row public.organization_welcome_campaign_steps%rowtype;
  following_position integer;
  following_delay integer;
  member_locale text;
  request_payload jsonb := '{}'::jsonb;
  prior jsonb;
  result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'queue_due_welcome_messages', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  for enrollment in
    select active.* from public.member_welcome_enrollments active
    join public.organization_welcome_campaigns campaign
      on campaign.id = active.campaign_id and campaign.organization_id = active.organization_id
    join public.organization_memberships membership
      on membership.organization_id = active.organization_id
      and membership.user_id = active.member_user_id
    where active.organization_id = org and active.state = 'active' and active.next_due_at <= pg_catalog.now()
      and campaign.state = 'active' and membership.status = 'active' and membership.revoked_at is null
    order by active.next_due_at, active.id for update skip locked limit 100
  loop
    select coalesce(operational.preferred_language, profile.language, 'en')
    into member_locale
    from public.member_profiles profile
    left join public.organization_member_operational_profiles operational
      on operational.organization_id = org
     and operational.member_user_id = profile.id
    where profile.id = enrollment.member_user_id;
    select * into step_row from public.organization_welcome_campaign_steps step
    where step.campaign_id = enrollment.campaign_id and step.organization_id = org
      and step.position = enrollment.next_step_position and step.active
    order by case when step.locale = member_locale then 0 else 1 end,
      step.locale, step.id limit 1;
    if not found then
      select next_step.position, next_step.delay_days
      into following_position, following_delay
      from public.organization_welcome_campaign_steps next_step
      where next_step.campaign_id = enrollment.campaign_id
        and next_step.organization_id = org
        and next_step.active
        and next_step.position > enrollment.next_step_position
        and next_step.position = (
          select pg_catalog.min(candidate.position)
          from public.organization_welcome_campaign_steps candidate
          where candidate.campaign_id = enrollment.campaign_id
            and candidate.organization_id = org
            and candidate.active
            and candidate.position > enrollment.next_step_position
        )
      order by case when next_step.locale = member_locale then 0 else 1 end,
        next_step.locale,
        next_step.id
      limit 1;
      if following_position is null then
        update public.member_welcome_enrollments
        set state = 'completed', completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where id = enrollment.id and organization_id = org;
      else
        update public.member_welcome_enrollments
        set next_step_position = following_position,
            next_due_at = enrollment.enrolled_at + pg_catalog.make_interval(days => following_delay),
            updated_at = pg_catalog.now()
        where id = enrollment.id and organization_id = org;
      end if;
      continue;
    end if;
    -- An opted-out member's step is consumed without an email, so turning
    -- announcements back on later never replays an old welcome step.
    if not private.engagement_email_opted_out(enrollment.member_user_id, 'welcome') then
      insert into public.engagement_delivery_outbox (
        organization_id, recipient_user_id, delivery_kind, source_kind, source_id, locale,
        subject_snapshot, body_snapshot, action_path_snapshot
      ) values (
        org, enrollment.member_user_id, 'welcome', 'welcome_campaign',
        enrollment.id::text || ':' || step_row.id::text, step_row.locale,
        step_row.subject, step_row.body, '/m/support?welcome=' || enrollment.id::text
      ) on conflict (delivery_kind, source_id, recipient_user_id) do nothing;
      if found then queued := queued + 1; end if;
    end if;
    select next_step.position, next_step.delay_days
    into following_position, following_delay
    from public.organization_welcome_campaign_steps next_step
    where next_step.campaign_id = enrollment.campaign_id and next_step.organization_id = org
      and next_step.active and next_step.position > enrollment.next_step_position
      and next_step.position = (select pg_catalog.min(candidate.position)
        from public.organization_welcome_campaign_steps candidate
        where candidate.campaign_id = enrollment.campaign_id and candidate.organization_id = org
          and candidate.active and candidate.position > enrollment.next_step_position)
    order by case when next_step.locale = member_locale then 0 else 1 end,
      next_step.locale,
      next_step.id
    limit 1;
    if following_position is null then
      update public.member_welcome_enrollments
      set state = 'completed', completed_at = pg_catalog.now(), updated_at = pg_catalog.now()
      where id = enrollment.id and organization_id = org;
    else
      update public.member_welcome_enrollments
      set next_step_position = following_position,
          next_due_at = enrollment.enrolled_at + pg_catalog.make_interval(days => following_delay),
          updated_at = pg_catalog.now()
      where id = enrollment.id and organization_id = org;
    end if;
  end loop;
  perform private.mi1_w2_write_audit(org, 'welcome_messages_queued', pg_catalog.jsonb_build_object(
    'organizationId', org, 'count', queued, 'status', 'queued'
  ));
  result := pg_catalog.jsonb_build_object('queuedCount', queued);
  perform private.member_operations_store_receipt(
    org, 'queue_due_welcome_messages', p_idempotency_key, request_payload, result
  );
  return result;
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Send: re-check at lease time, carry the signed token, suppress terminally
-- ---------------------------------------------------------------------------

create or replace function public.get_engagement_delivery_payload(
  p_delivery_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  row public.engagement_delivery_outbox%rowtype;
  email text;
  title text;
  body text;
  action_path text;
  category text;
  unsubscribe_token text;
begin
  select * into row from public.engagement_delivery_outbox
  where id = p_delivery_id and state = 'leased' and lease_token = p_lease_token
    and lease_expires_at >= pg_catalog.now();
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  -- The member may have opted out after this row was queued.
  if private.engagement_email_opted_out(row.recipient_user_id, row.delivery_kind) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_opted_out');
  end if;
  category := private.engagement_email_category(row.delivery_kind);
  unsubscribe_token := private.engagement_email_unsubscribe_token(row.recipient_user_id, category);
  select user_row.email into email from auth.users user_row where user_row.id = row.recipient_user_id;
  if row.source_kind = 'broadcast' then
    select broadcast.title, broadcast.body, '/m/messages?broadcast=' || row.source_id into title, body, action_path
    from public.member_broadcasts broadcast where broadcast.id = row.source_id
      and broadcast.organization_id = row.organization_id and broadcast.retracted_at is null;
  elsif row.source_kind = 'survey' then
    select survey.title, case row.delivery_kind when 'survey_reminder'
      then 'A survey is still waiting for your response in Union Ground.'
      else 'A survey is ready for you in Union Ground.' end,
      '/m/voice?survey=' || row.source_id into title, body, action_path
    from public.organization_surveys survey where survey.id = row.source_id::uuid
      and survey.organization_id = row.organization_id and survey.status = 'open';
  else
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.member_welcome_enrollments enrollment
    join public.organization_memberships membership
      on membership.organization_id = enrollment.organization_id
      and membership.user_id = enrollment.member_user_id
    where enrollment.id = pg_catalog.split_part(row.source_id, ':', 1)::uuid
      and enrollment.organization_id = row.organization_id and enrollment.member_user_id = row.recipient_user_id
      and enrollment.state in ('active','completed')
      and membership.status = 'active' and membership.revoked_at is null;
  end if;
  if email is null or title is null or unsubscribe_token is null then
    return pg_catalog.jsonb_build_object('available', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'available', true, 'email', email, 'locale', row.locale,
    'subject', title, 'body', body, 'path', action_path,
    'category', category, 'transactional', false,
    'unsubscribeToken', unsubscribe_token
  );
end;
$function$;

create or replace function public.complete_engagement_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_success boolean,
  p_error_code text default null,
  p_retry_after_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  row public.engagement_delivery_outbox%rowtype;
  suppress boolean;
  next_state text;
begin
  if not p_success and pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, ''))) !~ '^[a-z0-9._:-]{1,80}$' then
    raise exception 'bounded error code required' using errcode = '22023';
  end if;
  if p_retry_after_seconds not between 60 and 86400 then
    raise exception 'invalid retry delay' using errcode = '22023';
  end if;
  select * into row from public.engagement_delivery_outbox outbox
  where outbox.id = p_delivery_id and outbox.state = 'leased' and outbox.lease_token = p_lease_token
  for update;
  if not found then raise exception 'delivery lease not found' using errcode = 'P0002'; end if;
  -- An opted-out recipient is terminal, never a retry. The dispatcher's claim
  -- is believed only when the database agrees the member opted out.
  suppress := not p_success
    and pg_catalog.lower(pg_catalog.btrim(coalesce(p_error_code, ''))) = 'recipient_opted_out'
    and private.engagement_email_opted_out(row.recipient_user_id, row.delivery_kind);
  next_state := case when p_success then 'sent' when suppress then 'suppressed' else 'failed' end;
  update public.engagement_delivery_outbox outbox
  set state = next_state,
      sent_at = case when p_success then pg_catalog.now() else null end,
      last_error_code = case when p_success then null else pg_catalog.lower(pg_catalog.btrim(p_error_code)) end,
      available_at = case when p_success or suppress then outbox.available_at else pg_catalog.now() + pg_catalog.make_interval(secs => p_retry_after_seconds) end,
      lease_token = null, lease_expires_at = null, updated_at = pg_catalog.now()
  where outbox.id = row.id
  returning * into row;
  if row.source_kind = 'survey' then
    update public.organization_survey_deliveries
    set state = next_state,
        attempt_count = row.attempt_count,
        last_attempt_at = pg_catalog.now(),
        sent_at = case when p_success then coalesce(sent_at, pg_catalog.now()) else sent_at end,
        last_error_code = row.last_error_code,
        updated_at = pg_catalog.now()
    where survey_id = row.source_id::uuid and recipient_user_id = row.recipient_user_id;
  end if;
  return pg_catalog.jsonb_build_object('id', row.id, 'state', row.state);
end;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Steward and coordinator deadline warnings
-- ---------------------------------------------------------------------------

insert into private.notification_copy (key, lang, title, body) values
  ('deadline.staff.days', 'en', 'Assigned case deadline approaching', 'A deadline on a case assigned to you is {days} days away. Open Casework for the details.'),
  ('deadline.staff.days', 'es', 'Se acerca un plazo de un caso asignado', 'Un plazo de un caso asignado a ti vence en {days} días. Abre Casos para ver los detalles.'),
  ('deadline.staff.tomorrow', 'en', 'Assigned case deadline tomorrow', 'A deadline on a case assigned to you is tomorrow. Open Casework for the details.'),
  ('deadline.staff.tomorrow', 'es', 'Plazo de un caso asignado mañana', 'Un plazo de un caso asignado a ti vence mañana. Abre Casos para ver los detalles.'),
  ('deadline.staff.today', 'en', 'Assigned case deadline today', 'A deadline on a case assigned to you is due today. Open Casework for the details.'),
  ('deadline.staff.today', 'es', 'Plazo de un caso asignado hoy', 'Un plazo de un caso asignado a ti vence hoy. Abre Casos para ver los detalles.')
on conflict (key, lang) do update
  set title = excluded.title, body = excluded.body;

-- One row per (deadline, due date): the highest threshold already announced.
-- No identity column and no foreign key: it names a deadline row, never a
-- person, and rows are pruned a week after their due date.
create table private.staff_deadline_notice_marks (
  source text not null check (source in ('member_case', 'casework_deadline')),
  deadline_id uuid not null,
  due_on date not null,
  stage smallint not null check (stage between 1 and 3),
  marked_at timestamptz not null default pg_catalog.now(),
  primary key (source, deadline_id, due_on)
);

revoke all on table private.staff_deadline_notice_marks from public, anon, authenticated, service_role;

comment on table private.staff_deadline_notice_marks is
  'Idempotency ledger for private.staff_deadline_notice_sweep: stage 1 = entered the warning window, 2 = day before, 3 = due day. A changed due date is a new key, so a moved deadline is announced again.';

create function private.staff_deadline_notice_sweep()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_deadline record;
  v_recipient uuid;
  v_window integer;
  v_stage smallint;
  v_days integer;
  v_sent integer;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  v_sent := 0;
  delete from private.staff_deadline_notice_marks mark
   where mark.due_on < current_date - 7;
  for v_deadline in
    select 'member_case'::text as source, c.id as deadline_id, c.id as case_id,
           c.organization_id, c.user_id as owner_id,
           c.steward_user_id, c.coordinator_user_id, c.deadline as due_on
      from public.member_cases c
     where c.status = 'active'
       and c.deadline between current_date and current_date + 30
       and (c.steward_user_id is not null or c.coordinator_user_id is not null)
    union all
    select 'casework_deadline', d.id, c.id,
           c.organization_id, c.user_id,
           c.steward_user_id, c.coordinator_user_id, (d.due_at at time zone 'UTC')::date
      from public.casework_deadlines d
      join public.member_cases c on c.id = d.case_id and c.organization_id = d.organization_id
     where d.status in ('active', 'extended')
       and c.status = 'active'
       and d.due_at >= (current_date::timestamp at time zone 'UTC')
       and d.due_at < ((current_date + 31)::timestamp at time zone 'UTC')
       and (c.steward_user_id is not null or c.coordinator_user_id is not null)
     order by 1, 2
  loop
    if not private.urgent_a_setting_enabled(v_deadline.organization_id, 'features.notifications.steward_deadline_reminders') then
      continue;
    end if;
    v_window := least(greatest(coalesce(private.urgent_a_setting_integer(
      v_deadline.organization_id, 'limits.notifications.steward_deadline_reminder_days'), 3), 1), 30);
    v_days := v_deadline.due_on - current_date;
    v_stage := case
      when v_days <= 0 then 3
      when v_days = 1 then 2
      when v_days <= v_window then 1
    end;
    if v_stage is null then
      continue;
    end if;
    insert into private.staff_deadline_notice_marks as mark (source, deadline_id, due_on, stage)
    values (v_deadline.source, v_deadline.deadline_id, v_deadline.due_on, v_stage)
    on conflict (source, deadline_id, due_on) do update
      set stage = excluded.stage, marked_at = pg_catalog.now()
      where mark.stage < excluded.stage;
    if not found then
      continue;
    end if;
    for v_recipient in
      select distinct assignee.user_id
        from (values (v_deadline.steward_user_id), (v_deadline.coordinator_user_id)) as assignee(user_id)
       where assignee.user_id is not null
         -- The case owner already gets the member deadline notice.
         and not (v_deadline.source = 'member_case' and assignee.user_id = v_deadline.owner_id)
    loop
      if private.casework_reminder_owner_can_read(v_recipient, v_deadline.case_id) then
        perform private.notify_member(
          v_recipient,
          case v_stage when 3 then 'deadline.staff.today' when 2 then 'deadline.staff.tomorrow' else 'deadline.staff.days' end,
          case when v_stage = 1 then pg_catalog.jsonb_build_object('days', v_days::text) else '{}'::jsonb end,
          'deadlines');
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;
  return v_sent;
end;
$function$;

revoke all on function private.staff_deadline_notice_sweep() from public, anon, authenticated, service_role;

comment on function private.staff_deadline_notice_sweep() is
  'BUG-UG-STEWARD-DEADLINE-REMINDERS-20261001: warns the assigned steward and coordinator of each active member_cases.deadline and casework_deadlines due date once per threshold (window, day before, due day), honouring the organization switch and window, re-checking case access per recipient, and naming no case.';

-- The member sweep is 20260809020000's body inside the 20260907151000 gate,
-- unchanged, followed by the staff sweep. A staff-sweep failure is reported
-- and contained so it can never roll back the member notices.
create or replace function private.case_deadline_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  r record;
begin
  for r in
    select c.id, c.user_id, (c.deadline - current_date) as days_left
    from public.member_cases c
    where c.status = 'active'
      and c.deadline is not null
      and (c.deadline - current_date) between 0 and 7
      and (
        ((c.deadline - current_date) <= 1 and c.deadline_notice_1_sent_at is null)
        or ((c.deadline - current_date) between 2 and 3 and c.deadline_notice_3_sent_at is null)
        or ((c.deadline - current_date) between 4 and 7 and c.deadline_notice_7_sent_at is null)
      )
    for update skip locked
  loop
    if r.days_left <= 1 then
      update public.member_cases
        set deadline_notice_1_sent_at = now(),
            deadline_notice_3_sent_at = coalesce(deadline_notice_3_sent_at, now()),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id,
        case when r.days_left <= 0 then 'deadline.case.today' else 'deadline.case.tomorrow' end,
        '{}'::jsonb, 'deadlines');
    elsif r.days_left <= 3 then
      update public.member_cases
        set deadline_notice_3_sent_at = now(),
            deadline_notice_7_sent_at = coalesce(deadline_notice_7_sent_at, now())
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    else
      update public.member_cases
        set deadline_notice_7_sent_at = now()
        where id = r.id;
      perform private.notify_member(
        r.user_id, 'deadline.case.days',
        pg_catalog.jsonb_build_object('days', r.days_left::text), 'deadlines');
    end if;
  end loop;
  begin
    perform private.staff_deadline_notice_sweep();
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'staff_deadline_notice_sweep failed: % (%)', sqlerrm, sqlstate;
  end;
end;
end;
$function$;

revoke all on function private.case_deadline_notice_sweep() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Account-lifecycle trigger inventory: review exactly what this changes
-- ---------------------------------------------------------------------------

-- The new member_profiles trigger and its function, the redefined broadcast
-- trigger function, and the two helpers it now reaches. Nothing else on the
-- trigger surface changes.
delete from private.account_lifecycle_trigger_review review
using (values
  ('function', 'private', '', 'queue_member_broadcast_delivery()'),
  ('function', 'private', '', 'engagement_email_category(p_delivery_kind text)'),
  ('function', 'private', '', 'engagement_email_opted_out(p_user_id uuid, p_delivery_kind text)'),
  ('function', 'private', '', 'preserve_engagement_email_preferences()'),
  ('trigger', 'public', 'member_profiles', 'preserve_engagement_email_preferences')
) as changed(kind, schema_name, table_name, object_name)
where review.kind = changed.kind and review.schema_name = changed.schema_name
  and review.table_name = changed.table_name and review.object_name = changed.object_name;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
  ('function', 'private', '', 'queue_member_broadcast_delivery()'),
  ('function', 'private', '', 'engagement_email_category(p_delivery_kind text)'),
  ('function', 'private', '', 'engagement_email_opted_out(p_user_id uuid, p_delivery_kind text)'),
  ('function', 'private', '', 'preserve_engagement_email_preferences()'),
  ('trigger', 'public', 'member_profiles', 'preserve_engagement_email_preferences')
) as changed(kind, schema_name, table_name, object_name)
  on surface.kind = changed.kind and surface.schema_name = changed.schema_name
 and surface.table_name = changed.table_name and surface.object_name = changed.object_name;

do $assert_engagement_opt_out_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after engagement email opt-out';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_restrictive_fks()) then
    raise exception 'unmanaged restrictive auth.users reference after engagement email opt-out';
  end if;
  if exists (select 1 from private.account_lifecycle_unmanaged_export_fks()) then
    raise exception 'account lifecycle export ownership inventory is incomplete after engagement email opt-out';
  end if;
end;
$assert_engagement_opt_out_lifecycle$;

notify pgrst, 'reload schema';

commit;
