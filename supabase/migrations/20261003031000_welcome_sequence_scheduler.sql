-- REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001 (CR-110)
--
-- Restore-everything campaign, lane L7a (owner request 2026-10-01; owner
-- decision D2: a restored feature starts in the old app's effective production
-- default, behind a visible admin switch).
--
-- Old behavior (de7df4b57c^):
--   * vercel.ts:52 ran app/api/cron/email-dispatch every 15 minutes; its
--     welcome queue (route.ts:8, 123-137, dispatchPendingWelcomeEmails) sent
--     due welcome-sequence messages with no staff action and no flag.
--   * app/auth/confirm/route.ts:271 called lib/email/send-welcome-email.ts
--     sendWelcomeEmailIfFirst on a member's first successful sign-in, with no
--     flag (lib/email-templates/welcome.ts: contract, steward, rights).
--
-- Today (before this migration): welcome steps leave only when staff press
-- "Queue due messages" (public.queue_due_welcome_messages); nothing acts on
-- member_welcome_enrollments.next_due_at, and no first-sign-in email exists.
--
-- What this migration restores:
--
--   1. Scheduled welcome steps. The loop of queue_due_welcome_messages moves
--      unchanged into private.queue_due_welcome_steps_for(org, limit); the
--      staff RPC keeps its replay, audit and receipt and calls it with the same
--      limit of 100. private.run_welcome_automation(50) advances due steps for
--      every active organization whose switch
--      features.automation.welcome_sequence_auto is on (default ON, citations
--      above), auditing each organization's scheduled queue in the
--      organization audit ledger. It rides the existing minute
--      member-messaging-dispatch job (already mirrored by the job health
--      desk), exactly as dispatch_due_workflow_reminders does, and is
--      error-isolated so it can never abort the message dispatch it follows.
--
--   2. First-sign-in welcome email. Once per member per organization, after a
--      member whose membership began on or after this migration (and within
--      the last 30 days) signs in for the first time since joining, a welcome
--      email is queued through the engagement outbox (source_kind
--      'first_signin_welcome', delivery kind 'welcome'), in the member's
--      language, with the old three-point copy and no member-specific detail.
--      Members who joined before this migration are never emailed
--      retroactively. Switch features.automation.first_signin_welcome_email
--      (default ON: the old app sent it with no flag).
--
--   3. A "welcome" email category. Welcome mail (sequence steps and the
--      first-sign-in email) now has its own email choice,
--      notification_prefs.welcome, with the same one-click unsubscribe,
--      lease-time re-check and preserved-choice trigger W1-URGENT-A built for
--      announcements and surveys (20261002021000). A member who never set the
--      welcome choice follows their announcements choice, which governed
--      welcome mail until now, so no earlier opt-out is reversed. An opted-out
--      member's welcome is consumed (recorded as suppressed) without an email.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Seven functions from 20261002021000 are re-declared from their installed
-- bodies. Refuse any other predecessor.
do $predecessor$
declare
  r record;
  source text;
  digest text;
begin
  for r in select * from (values
    ('private.engagement_email_category(text)', 'fb4600de6db4bccc094795a74f1ba77dc30ad663c71b793eaee9abd360076c8d'),
    ('private.engagement_email_opted_out(uuid, text)', 'c37acf250b92adb17e1a42cea6a6d9807e6b4898d42fb2e2a23d330a2ff6b59b'),
    ('private.preserve_engagement_email_preferences()', 'cbbba5360b3a582b4fb8ed91f0785eae52a4213f6ab05cb2e90f86d4e5005580'),
    ('private.engagement_email_unsubscribe_token(uuid, text)', 'b579e468872f995f8e90e3b13b1e71f8b5df38b7109dd05c4684fbf533ce6bcc'),
    ('public.apply_engagement_email_unsubscribe(text)', '2f79189c783f6d159221134161467afdda474bf95919d49175f6679a35c0cd76'),
    ('public.get_engagement_delivery_payload(uuid, uuid)', '6e8afa103ae122d93180261f88f659a7d4479c1f73e6e3bab96213e0c15cdefb'),
    ('public.queue_due_welcome_messages(uuid)', 'a2594d58b0a2aa78493f79ed3e3a990679b12f56a4f8d576c4fa92050c8b4203')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc into strict source
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(r.signature);
    digest := pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'),
      'hex'
    );
    if digest is distinct from r.source_sha256 then
      raise exception 'unreviewed % predecessor: %', r.signature, digest
        using errcode = '55000';
    end if;
  end loop;
end;
$predecessor$;

-- ---------------------------------------------------------------------------
-- 1. Organization switches (Feature switches & limits, category automation)
-- ---------------------------------------------------------------------------

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  -- Old default ON: de7df4b57c^:vercel.ts:52 email-dispatch every 15 minutes
  -- sent due welcome messages (app/api/cron/email-dispatch/route.ts:123-137).
  ('features.automation.welcome_sequence_auto', 'boolean', 'Send welcome steps automatically',
   'Send each member''s next welcome-sequence message when it comes due, without staff pressing Queue due messages.',
   'true', null, null, null, 30, 'automation', false),
  -- Old default ON: de7df4b57c^:app/auth/confirm/route.ts:271 always called
  -- sendWelcomeEmailIfFirst (lib/email/send-welcome-email.ts), no flag.
  ('features.automation.first_signin_welcome_email', 'boolean', 'Welcome email on first sign-in',
   'Email a member who joined the organization a short welcome the first time they sign in. Members can turn welcome emails off.',
   'true', null, null, null, 40, 'automation', false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The welcome email category (same mechanism as announcements/surveys)
-- ---------------------------------------------------------------------------

create or replace function private.engagement_email_category(p_delivery_kind text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case p_delivery_kind
    when 'broadcast' then 'announcements'
    when 'welcome' then 'welcome'
    when 'survey_invitation' then 'surveys'
    when 'survey_reminder' then 'surveys'
  end;
$function$;

create or replace function private.engagement_email_opted_out(p_user_id uuid, p_delivery_kind text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  -- A welcome choice the member never set follows the announcements choice
  -- that governed welcome mail before 20261003031000, so no earlier opt-out
  -- is reversed by the new category.
  select private.engagement_email_category(p_delivery_kind) is null
    or coalesce((
      select case
        when private.engagement_email_category(p_delivery_kind) = 'welcome'
          and not (profile.notification_prefs ? 'welcome')
          then (profile.notification_prefs -> 'announcements') = 'false'::jsonb
        else (profile.notification_prefs -> private.engagement_email_category(p_delivery_kind)) = 'false'::jsonb
      end
        from public.member_profiles profile
       where profile.id = p_user_id
    ), false);
$function$;

create or replace function private.preserve_engagement_email_preferences()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.notification_prefs := coalesce((
    select pg_catalog.jsonb_object_agg(stored.key, stored.value)
      from pg_catalog.jsonb_each(old.notification_prefs) stored
     where stored.key in ('announcements', 'surveys', 'welcome')
       and not (new.notification_prefs ? stored.key)
  ), '{}'::jsonb) || new.notification_prefs;
  return new;
end;
$function$;

create or replace function private.engagement_email_unsubscribe_token(p_user_id uuid, p_category text)
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
     and p_category in ('announcements', 'surveys', 'welcome');
$function$;

create or replace function public.apply_engagement_email_unsubscribe(p_token text)
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
     or p_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](announcements|surveys|welcome)[.][0-9]{10}[.][A-Za-z0-9_-]{43}$' then
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

comment on function private.engagement_email_category(text) is
  'Classifies every engagement_delivery_outbox kind: broadcasts are announcements, survey invitations and reminders are surveys, welcome-sequence and first-sign-in mail is welcome (20261003031000). None is transactional or legally required. A kind with no category is never sent.';
comment on function private.engagement_email_opted_out(uuid, text) is
  'True when the recipient turned off the delivery kind''s email category in notification_prefs (absent means enabled; an unset welcome choice follows announcements), or when the kind is unclassified.';
comment on function private.preserve_engagement_email_preferences() is
  'Keeps a stored announcements, surveys or welcome email choice when an older writer replaces notification_prefs without that key, so an unsubscribe is never silently reversed. Only an explicit true re-enables.';
comment on function public.apply_engagement_email_unsubscribe(text) is
  'RFC 8058 one-click unsubscribe for engagement email (service_role only, called by api/email-unsubscribe.js). Verifies the database-signed token, refuses one older than 60 days, and sets exactly that member''s announcements, surveys or welcome email choice to false. Every refusal is the same {"applied": false}.';

-- ---------------------------------------------------------------------------
-- 3. First-sign-in welcome email
-- ---------------------------------------------------------------------------

alter table public.engagement_delivery_outbox
  drop constraint engagement_delivery_outbox_source_kind_check,
  add constraint engagement_delivery_outbox_source_kind_check
    check (source_kind in ('broadcast', 'survey', 'welcome_campaign', 'first_signin_welcome'));

-- Members who joined before this migration are never emailed retroactively.
create table private.welcome_automation_state (
  singleton boolean primary key default true check (singleton),
  first_signin_since timestamptz not null
);

revoke all on table private.welcome_automation_state from public, anon, authenticated, service_role;

insert into private.welcome_automation_state (singleton, first_signin_since)
values (true, pg_catalog.now())
on conflict (singleton) do nothing;

comment on table private.welcome_automation_state is
  'REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001: the instant the first-sign-in welcome email was installed. Only memberships created on or after it are eligible.';

create function private.queue_first_signin_welcome_emails(p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  since timestamptz;
  candidate record;
  queued integer := 0;
  org_name text;
  opted_out boolean;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid first sign-in welcome request' using errcode = '22023';
  end if;
  select s.first_signin_since into since from private.welcome_automation_state s where s.singleton;
  if since is null then
    return 0;
  end if;
  for candidate in
    select m.organization_id, m.user_id, o.name,
           case when coalesce(op.preferred_language, p.language, 'en') = 'es' then 'es' else 'en' end as locale
    from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id and o.status = 'active'
    join auth.users u on u.id = m.user_id
    left join public.member_profiles p on p.id = m.user_id
    left join public.organization_member_operational_profiles op
      on op.organization_id = m.organization_id and op.member_user_id = m.user_id
    where m.status = 'active'
      and m.revoked_at is null
      and m.created_at >= since
      and m.created_at >= pg_catalog.now() - interval '30 days'
      and u.last_sign_in_at is not null
      and u.last_sign_in_at >= m.created_at
      and not exists (
        select 1 from public.engagement_delivery_outbox x
        where x.delivery_kind = 'welcome' and x.source_kind = 'first_signin_welcome'
          and x.source_id = m.organization_id::text and x.recipient_user_id = m.user_id
      )
      and private.organization_feature_enabled(m.organization_id, 'features.automation.first_signin_welcome_email')
    order by u.last_sign_in_at, m.organization_id, m.user_id
    limit p_limit
  loop
    org_name := pg_catalog.left(pg_catalog.btrim(candidate.name), 150);
    opted_out := private.engagement_email_opted_out(candidate.user_id, 'welcome');
    insert into public.engagement_delivery_outbox (
      organization_id, recipient_user_id, delivery_kind, source_kind, source_id, locale,
      subject_snapshot, body_snapshot, action_path_snapshot, state, last_error_code
    ) values (
      candidate.organization_id, candidate.user_id, 'welcome', 'first_signin_welcome',
      candidate.organization_id::text, candidate.locale,
      case candidate.locale
        when 'es' then 'Te damos la bienvenida a ' || org_name
        else 'Welcome to ' || org_name end,
      -- Old copy (de7df4b57c^:lib/email-templates/welcome.ts), without the
      -- member's name or any record detail.
      case candidate.locale
        when 'es' then 'Ya iniciaste sesión en Union Ground con ' || org_name || '. Así puedes aprovecharlo:'
          || pg_catalog.chr(10) || pg_catalog.chr(10)
          || '1. Lee el contrato. Encuentra el lenguaje que te protege sobre horas extra, disciplina, carga de trabajo y licencias antes de necesitarlo.'
          || pg_catalog.chr(10)
          || '2. Conoce a tu delegado o delegada. Puede responder preguntas sobre el contrato y acompañarte en una queja.'
          || pg_catalog.chr(10)
          || '3. Conoce tus derechos. Si algo en el trabajo no parece correcto, anótalo en la app para que nada quede sin registrar.'
          || pg_catalog.chr(10) || pg_catalog.chr(10)
          || '¿Preguntas? Inicia sesión y envía un mensaje a tu delegado o delegada.'
        else 'You are now signed in to Union Ground with ' || org_name || '. Here is how to put it to work:'
          || pg_catalog.chr(10) || pg_catalog.chr(10)
          || '1. Read the contract. Find the language that protects you on overtime, discipline, workload and leave before you need it.'
          || pg_catalog.chr(10)
          || '2. Meet your steward. Your steward can answer contract questions and walk a grievance with you.'
          || pg_catalog.chr(10)
          || '3. Know your rights. If something at work feels wrong, write it down in the app so nothing goes undocumented.'
          || pg_catalog.chr(10) || pg_catalog.chr(10)
          || 'Questions? Sign in and send a message to your steward.'
      end,
      '/m',
      case when opted_out then 'suppressed' else 'queued' end,
      case when opted_out then 'recipient_opted_out' end
    ) on conflict (delivery_kind, source_id, recipient_user_id) do nothing;
    if found and not opted_out then
      queued := queued + 1;
    end if;
  end loop;
  return queued;
end;
end;
$function$;

comment on function private.queue_first_signin_welcome_emails(integer) is
  'REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001: once per member per organization, queues the first-sign-in welcome email for members who joined since installation (and within 30 days) and have signed in since joining, while features.automation.first_signin_welcome_email is on. An opted-out member''s welcome is recorded as suppressed without an email.';

-- ---------------------------------------------------------------------------
-- 4. Scheduled welcome steps
-- ---------------------------------------------------------------------------

create function private.queue_due_welcome_steps_for(p_org uuid, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org uuid := p_org;
  queued integer := 0;
  enrollment record;
  step_row public.organization_welcome_campaign_steps%rowtype;
  following_position integer;
  following_delay integer;
  member_locale text;
begin
  if org is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid welcome queue request' using errcode = '22023';
  end if;
  for enrollment in
    select active.* from public.member_welcome_enrollments active
    join public.organization_welcome_campaigns campaign
      on campaign.id = active.campaign_id and campaign.organization_id = active.organization_id
    join public.organization_memberships membership
      on membership.organization_id = active.organization_id
      and membership.user_id = active.member_user_id
    where active.organization_id = org and active.state = 'active' and active.next_due_at <= pg_catalog.now()
      and campaign.state = 'active' and membership.status = 'active' and membership.revoked_at is null
    order by active.next_due_at, active.id for update skip locked limit p_limit
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
  return queued;
end;
end;
$function$;

comment on function private.queue_due_welcome_steps_for(uuid, integer) is
  'REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001: the welcome-step loop shared by the staff RPC queue_due_welcome_messages and the scheduled private.run_welcome_automation. Queues each due step through the engagement outbox (an opted-out member''s step is consumed without an email) and advances the enrollment.';

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
  request_payload jsonb := '{}'::jsonb;
  prior jsonb;
  result jsonb;
begin
  prior := private.member_operations_replay(
    org, 'queue_due_welcome_messages', p_idempotency_key, request_payload
  );
  if prior is not null then return prior; end if;
  queued := private.queue_due_welcome_steps_for(org, 100);
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

create function private.run_welcome_automation(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org_row record;
  queued_steps integer := 0;
  queued_first integer := 0;
  per_org integer;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid welcome automation limit' using errcode = '22023';
  end if;
  -- Each half is isolated: this runs inside the minute message dispatch
  -- command, and a fault here must never undo the dispatch it follows.
  begin
    for org_row in
      select due.organization_id
      from (
        select distinct e.organization_id
        from public.member_welcome_enrollments e
        join public.organization_welcome_campaigns c
          on c.id = e.campaign_id and c.organization_id = e.organization_id and c.state = 'active'
        join public.organizations o on o.id = e.organization_id and o.status = 'active'
        where e.state = 'active' and e.next_due_at <= pg_catalog.now()
      ) due
      where private.organization_feature_enabled(due.organization_id, 'features.automation.welcome_sequence_auto')
      order by due.organization_id
      limit p_limit
    loop
      per_org := private.queue_due_welcome_steps_for(org_row.organization_id, p_limit);
      queued_steps := queued_steps + per_org;
      if per_org > 0 then
        perform private.cr108_record_audit(
          org_row.organization_id, 'welcome_messages_queued', 'send', 'campaign', null, null,
          pg_catalog.jsonb_build_object('count', per_org, 'status', 'scheduled'),
          extensions.gen_random_uuid()
        );
      end if;
    end loop;
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'scheduled welcome steps failed: % (%)', sqlerrm, sqlstate;
  end;
  begin
    queued_first := private.queue_first_signin_welcome_emails(p_limit);
  exception
    when query_canceled then
      raise;
    when others then
      raise warning 'first sign-in welcome failed: % (%)', sqlerrm, sqlstate;
  end;
  return pg_catalog.jsonb_build_object('welcomeSteps', queued_steps, 'firstSignin', queued_first);
end;
end;
$function$;

comment on function private.run_welcome_automation(integer) is
  'REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001: minute tick (inside member-messaging-dispatch) that sends due welcome-sequence steps for organizations with features.automation.welcome_sequence_auto on and queues first-sign-in welcome emails. Error-isolated.';

-- ---------------------------------------------------------------------------
-- 5. Delivery payload: first-sign-in rows
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
  -- The newest Main contract rechecks active membership and the current
  -- broadcast or survey audience at send time. Revoked rows are terminally
  -- suppressed by complete_engagement_delivery.
  if not private.engagement_delivery_recipient_eligible(
    row.organization_id, row.recipient_user_id, row.source_kind, row.source_id
  ) then
    return pg_catalog.jsonb_build_object('available', false, 'suppressed', true, 'reason', 'recipient_access_revoked');
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
  elsif row.source_kind = 'first_signin_welcome' then
    -- Restored first-sign-in welcome (20261003031000): sent only while the
    -- member still belongs to the organization.
    select row.subject_snapshot, row.body_snapshot, row.action_path_snapshot into title, body, action_path
    from public.organization_memberships membership
    where membership.organization_id = row.organization_id
      and membership.user_id = row.recipient_user_id
      and membership.status = 'active' and membership.revoked_at is null;
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

-- ---------------------------------------------------------------------------
-- 6. Grants, trigger inventory and schedule
-- ---------------------------------------------------------------------------

revoke all on function private.engagement_email_category(text) from public, anon, authenticated, service_role;
revoke all on function private.engagement_email_opted_out(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.preserve_engagement_email_preferences() from public, anon, authenticated, service_role;
revoke all on function private.engagement_email_unsubscribe_token(uuid, text) from public, anon, authenticated, service_role;
revoke all on function private.queue_first_signin_welcome_emails(integer) from public, anon, authenticated, service_role;
revoke all on function private.queue_due_welcome_steps_for(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function private.run_welcome_automation(integer) from public, anon, authenticated, service_role;

-- The three re-declared trigger-surface functions (the member_profiles choice
-- guard and the two helpers it and the broadcast enqueue reach).
delete from private.account_lifecycle_trigger_review review
using (values
  ('function', 'private', '', 'engagement_email_category(p_delivery_kind text)'),
  ('function', 'private', '', 'engagement_email_opted_out(p_user_id uuid, p_delivery_kind text)'),
  ('function', 'private', '', 'preserve_engagement_email_preferences()')
) as changed(kind, schema_name, table_name, object_name)
where review.kind = changed.kind and review.schema_name = changed.schema_name
  and review.table_name = changed.table_name and review.object_name = changed.object_name;

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select surface.kind, surface.schema_name, surface.table_name, surface.object_name, surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
  ('function', 'private', '', 'engagement_email_category(p_delivery_kind text)'),
  ('function', 'private', '', 'engagement_email_opted_out(p_user_id uuid, p_delivery_kind text)'),
  ('function', 'private', '', 'preserve_engagement_email_preferences()')
) as changed(kind, schema_name, table_name, object_name)
  on surface.kind = changed.kind and surface.schema_name = changed.schema_name
 and surface.table_name = changed.table_name and surface.object_name = changed.object_name;

do $assert_welcome_scheduler_lifecycle$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the welcome scheduler';
  end if;
end;
$assert_welcome_scheduler_lifecycle$;

-- Scheduled welcome steps ride the existing minute dispatcher job (already
-- mirrored by the job health desk) instead of adding a job, like
-- dispatch_due_workflow_reminders (20261001020000). run_welcome_automation is
-- error-isolated, so it cannot abort the dispatch it follows.
do $cron$
begin
  if not exists (select 1 from pg_catalog.pg_available_extensions where name = 'pg_cron') then return; end if;
  if coalesce(pg_catalog.current_setting('cron.database_name', true), 'postgres') <> pg_catalog.current_database() then return; end if;
  perform cron.alter_job(
    j.jobid,
    command := 'select private.dispatch_due_member_messaging(); select private.dispatch_due_workflow_reminders(200); select private.run_welcome_automation(50);')
  from cron.job j
  where j.jobname = 'member-messaging-dispatch';
end;
$cron$;

notify pgrst, 'reload schema';

commit;
