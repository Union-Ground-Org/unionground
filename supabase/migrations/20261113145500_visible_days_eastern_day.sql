-- BUG-UG-FUNCTIONS-AND-DATE-DEFAULTS-READ-THE-UTC-DAY-20261112 (#8568), part D of four,
-- the last: the other days people see, read on the Eastern day, and the
-- cut-offs that keep the UTC day on purpose.
--
-- These readers compare a calendar day with current_date, the session's day,
-- and the hosted projects run in UTC: from 7 PM Eastern (8 PM in daylight
-- time) a mentorship started or ended tomorrow, a chapter health snapshot for
-- today was refused as in the future while tomorrow's was accepted, the
-- report card's days since last activity, the catalog claim windows and the
-- notification daily caps ran a day ahead, and on a quarter's last evening
-- the quarterly survey gate and engagement snapshot already read the next
-- quarter. Each now reads private.eastern_day()
-- (20261113122500_eastern_day_helper.sql), written
-- (select private.eastern_day()) so it is read once per query, not once per
-- row; the report card reads the last activity on the Eastern calendar too.
-- The two retention cut-offs keep the UTC day, because page-view rows are
-- bucketed on it, and now read it explicitly. The member_mentorship_pairs
-- started_on default moves to the Eastern day inline, as the
-- member_workload_logs.logged_on default does. The reviewed_at defaults of
-- the two account-lifecycle manifests stay on the session day: only
-- migrations write those rows, and nothing reads them by day. Nothing else in
-- any body changes. Functions:
--   private.catalog_claim_domain_signals
--   private.enqueue_notification_deliveries
--   private.quarterly_survey_gate_state
--   public.create_member_mentorship_pair
--   public.get_chapter_health_portfolio
--   public.get_member_engagement_snapshot
--   public.get_my_analytics_report_card
--   public.list_vouchable_organization_claims
--   public.record_chapter_health_snapshot
--   public.transition_member_mentorship_pair
--   private.perform_organization_retention_run
--   private.retention_eligible_count
--   public.plan_dues_reminder_attempts (the dues reminder cron: only its p_today
--     default changes, from current_date to the Eastern day inline; its body is
--     unchanged. api/dues-reminders-dispatch.js now sends the Eastern date.)
-- Grants are unchanged (create or replace keeps them). A predecessor guard
-- refuses to run unless every live body is the reviewed one.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.catalog_claim_domain_signals(uuid)'::regprocedure)
    is distinct from 'a38a270906827b4cc8c1d2ecc2648d4a' then
    raise exception 'unreviewed predecessor: private.catalog_claim_domain_signals' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.enqueue_notification_deliveries()'::regprocedure)
    is distinct from '50f2814ac6fc96d1deea48c9ec4704dd' then
    raise exception 'unreviewed predecessor: private.enqueue_notification_deliveries' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.quarterly_survey_gate_state(uuid)'::regprocedure)
    is distinct from 'ea27444765fd44fce2611589e338ac0c' then
    raise exception 'unreviewed predecessor: private.quarterly_survey_gate_state' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.create_member_mentorship_pair(uuid,uuid,date,uuid)'::regprocedure)
    is distinct from '3dfd85d02b345d27c49ac05d64c49459' then
    raise exception 'unreviewed predecessor: public.create_member_mentorship_pair' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_chapter_health_portfolio()'::regprocedure)
    is distinct from '4374ac93c9c0e818acd6319b9fa58f23' then
    raise exception 'unreviewed predecessor: public.get_chapter_health_portfolio' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_member_engagement_snapshot()'::regprocedure)
    is distinct from '609de596c093818a4713a9bbe5dac34c' then
    raise exception 'unreviewed predecessor: public.get_member_engagement_snapshot' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_my_analytics_report_card()'::regprocedure)
    is distinct from 'f7d552678d266f80c2f45dc9520d99d5' then
    raise exception 'unreviewed predecessor: public.get_my_analytics_report_card' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.list_vouchable_organization_claims(text,uuid)'::regprocedure)
    is distinct from 'c30aabf765a367b5ebaaf78303ce3f86' then
    raise exception 'unreviewed predecessor: public.list_vouchable_organization_claims' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.record_chapter_health_snapshot(text,date,integer,integer,integer,integer,integer,integer)'::regprocedure)
    is distinct from 'c05de5ff30b2497ff5c08a0368bea1c4' then
    raise exception 'unreviewed predecessor: public.record_chapter_health_snapshot' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.transition_member_mentorship_pair(uuid,text,text,uuid)'::regprocedure)
    is distinct from '0f867cf55ab133a0f5c19f53e5bf748a' then
    raise exception 'unreviewed predecessor: public.transition_member_mentorship_pair' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.perform_organization_retention_run(uuid)'::regprocedure)
    is distinct from '4fd88aca7fe4bd599d1eb03c5dde4431' then
    raise exception 'unreviewed predecessor: private.perform_organization_retention_run' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.retention_eligible_count(uuid,text,integer)'::regprocedure)
    is distinct from 'c524189940ca3809a0eb3c5ae7a9c8fc' then
    raise exception 'unreviewed predecessor: private.retention_eligible_count' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.plan_dues_reminder_attempts(integer,date)'::regprocedure)
    is distinct from '075f0ad53895b228fecb068bc3ef8b16' then
    raise exception 'unreviewed predecessor: public.plan_dues_reminder_attempts' using errcode='55000';
  end if;
end
$preflight$;

CREATE OR REPLACE FUNCTION private.catalog_claim_domain_signals(p_claim_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  claim private.organization_claims%rowtype;
  target private.catalog_organizations%rowtype;
  email_host text;
  email_domain text;
  target_host text;
  target_domain text;
  reason text;
  owners text[];
  competing integer;
  election boolean;
  verified_elsewhere boolean;
  office_phone boolean;
  steward_count integer;
  member_count integer;
begin
  select * into claim from private.organization_claims as c where c.id = p_claim_id;
  if not found then
    return null;
  end if;

  competing := 0;
  election := false;
  verified_elsewhere := false;
  office_phone := false;

  select pg_catalog.count(*)::integer into member_count
    from public.organization_memberships as m
   where m.organization_id = claim.organization_id
     and m.status = 'active';
  select pg_catalog.count(distinct g.user_id)::integer into steward_count
    from public.organization_role_grants as g
    join public.organization_memberships as m
      on m.organization_id = g.organization_id and m.user_id = g.user_id and m.status = 'active'
   where g.organization_id = claim.organization_id
     and g.role = 'steward';

  if claim.catalog_key is null then
    reason := 'unlisted';
  else
    select * into target from private.catalog_organizations as o where o.catalog_key = claim.catalog_key;

    select pg_catalog.count(*)::integer into competing
      from private.organization_claims as other
     where other.catalog_key = claim.catalog_key
       and other.id <> claim.id
       and (other.status in ('under_review', 'held')
            or (other.status = 'approved' and other.organization_id is not null));
    election := target.next_election_on is not null
      and target.next_election_on between (select private.eastern_day()) - 30 and (select private.eastern_day()) + 90;
    verified_elsewhere := exists (
      select 1 from private.organization_catalog_placements as p
       where p.identity_catalog_key = claim.catalog_key
         and p.organization_id is distinct from claim.organization_id);
    office_phone := exists (
      select 1 from private.catalog_contacts as contact
       where contact.catalog_key = claim.catalog_key
         and contact.contact_kind = 'phone'
         and contact.retired_release_id is null);

    email_host := pg_catalog.lower(pg_catalog.split_part(coalesce(claim.claimant_email, ''), '@', 2));
    email_domain := private.catalog_registrable_domain(nullif(email_host, ''));

    if email_domain is null then
      reason := 'no_domain';
    elsif exists (
      select 1 from private.catalog_claim_blocked_domains as blocked
       where email_host = blocked.domain
          or pg_catalog.right(email_host, pg_catalog.char_length(blocked.domain) + 1) = '.' || blocked.domain
          or email_domain = blocked.domain
          or pg_catalog.right(email_domain, pg_catalog.char_length(blocked.domain) + 1) = '.' || blocked.domain) then
      reason := 'blocked_domain';
    elsif target.retired_release_id is not null or target.duplicate_of is not null then
      reason := 'target_inactive';
    elsif target.confidence is distinct from 'official_site'
          or target.researched_on is null
          or target.researched_on < (select private.eastern_day()) - 548 then
      reason := 'target_stale';
    else
      target_host := private.catalog_url_host(target.website);
      target_domain := private.catalog_registrable_domain(target_host);
      if target_domain is distinct from email_domain then
        reason := 'domain_mismatch';
      elsif target_host is distinct from target_domain
            and email_host is distinct from target_host
            and pg_catalog.right(email_host, pg_catalog.char_length(target_host) + 1) is distinct from '.' || target_host then
        -- The listing's site sits on a subdomain of a wider registrable domain
        -- (an employer's or a school district's): only mail on that site's own
        -- host speaks for the listing.
        reason := 'subdomain_site';
      else
        select pg_catalog.array_agg(distinct owner.catalog_key) into owners
          from (
            select o.catalog_key
              from private.catalog_organizations as o
             where o.retired_release_id is null
               and o.duplicate_of is null
               and o.website is not null
               and private.catalog_registrable_domain(private.catalog_url_host(o.website)) = email_domain
            union
            select s.catalog_key
              from private.catalog_subunits as s
              join private.catalog_organizations as o on o.catalog_key = s.catalog_key
             where s.retired_release_id is null
               and o.retired_release_id is null
               and o.duplicate_of is null
               and s.website is not null
               and private.catalog_registrable_domain(private.catalog_url_host(s.website)) = email_domain
            union
            select contact.catalog_key
              from private.catalog_contacts as contact
              join private.catalog_organizations as o on o.catalog_key = contact.catalog_key
             where contact.retired_release_id is null
               and o.retired_release_id is null
               and o.duplicate_of is null
               and contact.contact_kind in ('website', 'email')
               and private.catalog_registrable_domain(
                     case when contact.contact_kind = 'email'
                          then nullif(pg_catalog.lower(pg_catalog.split_part(contact.value, '@', 2)), '')
                          else private.catalog_url_host(contact.value) end) = email_domain
          ) as owner;
        if owners is distinct from array[claim.catalog_key] then
          reason := 'domain_shared';
        end if;
      end if;
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'domainMatch', reason is null,
    'domainReason', reason,
    'competingClaims', competing,
    'electionWindow', election,
    'targetVerifiedElsewhere', verified_elsewhere,
    'officePhoneAvailable', office_phone,
    'stewardCount', steward_count,
    'memberCount', member_count
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.enqueue_notification_deliveries()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  prefs jsonb;
  pref_value jsonb;
  outbound_on boolean;
  recent_hour integer;
  recent_day integer;
  recent_week integer := 0;
  org_today integer;
  limit_reason text;
  transactional_receipt boolean := new.kind = 'workload' and new.workload_event = 'receipt';
  notification_org uuid;
  max_per_recipient_hour integer;
  max_per_recipient_day integer;
  max_per_recipient_week integer;
  max_org_day integer;
begin
  -- Only a receipt created/locked by this very transaction can suppress task
  -- transport. A caller-set GUC alone, an old receipt, or another backend's
  -- pending receipt grants nothing. In-app notifications and audit still run.
  if new.kind='tasks' and exists(
    select 1 from public.organization_automation_effects e
    join public.organization_automation_runs r on r.id=e.run_id and r.organization_id=e.organization_id and r.status='in_progress'
    join public.organization_automation_definitions d on d.id=e.definition_id and d.schema_version=2
    where e.id::text=current_setting('app.automation_task_receipt',true)
    and e.status='pending' and e.mutation_xid=pg_current_xact_id()
    and e.action_kind in ('create_standard_task','assign_task','raise_task_priority')
    and (d.version=r.definition_version or e.rollback_target is not null)
  ) then return new; end if;
  if new.kind not in (
    'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks',
    'appointments', 'workload', 'dues', 'messages'
  ) then
    return new;
  end if;
  if exists (
    select 1 from private.member_stress_ledger l
    where l.user_id = new.user_id
  ) then
    return new;
  end if;
  begin
    select controls.outbound_enabled into outbound_on
    from private.notification_controls controls where controls.id;
    if not coalesce(outbound_on, false) then return new; end if;
    select p.notification_prefs into prefs
    from public.member_profiles p where p.id = new.user_id;
    pref_value := prefs -> new.kind;
    -- The recipient's active primary chapter is the durable tenant for this
    -- legacy notification row, which itself has no organization_id column.
    select c.organization_id into notification_org
    from public.member_profiles p
    join public.chapters c on c.id = p.chapter_id
    join public.member_chapter_memberships cm
      on cm.chapter_id = c.id and cm.user_id = p.id and cm.status = 'active'
    join public.organization_memberships om
      on om.organization_id = c.organization_id and om.user_id = p.id and om.status = 'active'
    where p.id = new.user_id;
    max_per_recipient_hour := private.organization_limit(notification_org, 'limits.notifications.member_hourly');
    max_per_recipient_day := private.organization_limit(notification_org, 'limits.notifications.member_daily');
    max_per_recipient_week := private.organization_limit(notification_org, 'limits.notifications.member_weekly_nudges');
    max_org_day := private.organization_limit(notification_org, 'limits.notifications.organization_daily');
    if pref_value = 'false'::jsonb then return new; end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_notification_rate:' || new.user_id::text, 0)
    );
    select pg_catalog.count(*) into recent_hour
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '1 hour';
    select pg_catalog.count(*) into recent_day
    from public.member_notification_deliveries d
    where d.user_id = new.user_id
      and d.created_at > pg_catalog.now() - interval '24 hours';
    if new.kind not in ('deadlines', 'cases') and not transactional_receipt then
      select pg_catalog.count(*) into recent_week
      from public.member_notification_deliveries d
      join public.member_notifications n2 on n2.id = d.notification_id
      where d.user_id = new.user_id
        and d.channel = 'email'
        and d.status <> 'skipped'
        and d.created_at > pg_catalog.now() - interval '7 days'
        and n2.kind not in ('deadlines', 'cases')
        and not (
          n2.kind = 'workload' and n2.workload_event = 'receipt'
      );
    end if;
    -- Serialize the organization total across counter shards. Every enqueue
    -- takes the member lock first, then this tenant lock, in the same order.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'organization_notification_rate:' || coalesce(notification_org::text, 'legacy'), 0
      )
    );
    select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
    from private.notification_outbound_counters c
    where c.day = (select private.eastern_day()) and notification_org is null;
    if notification_org is not null then
      select coalesce(pg_catalog.sum(c.enqueued), 0) into org_today
      from private.organization_notification_outbound_counters c
      where c.organization_id = notification_org and c.day = (select private.eastern_day());
    end if;
    if recent_hour >= max_per_recipient_hour then
      limit_reason := 'rate limited: recipient hour';
    elsif recent_day >= max_per_recipient_day then
      limit_reason := 'rate limited: recipient day';
    elsif new.kind not in ('deadlines', 'cases') and not transactional_receipt
      and recent_week >= max_per_recipient_week then
      limit_reason := 'rate limited: weekly nudge cap';
    elsif org_today >= max_org_day then
      limit_reason := 'rate limited: org day';
    end if;
    if limit_reason is not null then
      insert into public.member_notification_deliveries (
        notification_id, user_id, channel, status, last_error
      ) values (
        new.id, new.user_id, 'email', 'skipped', limit_reason
      ) on conflict (notification_id, channel) do nothing;
      return new;
    end if;
    if notification_org is null then
      insert into private.notification_outbound_counters (day, shard, enqueued)
      values ((select private.eastern_day()), (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
      on conflict (day, shard) do update
        set enqueued = private.notification_outbound_counters.enqueued + 1;
    else
      insert into private.organization_notification_outbound_counters
        (organization_id, day, shard, enqueued)
      values (notification_org, (select private.eastern_day()), (pg_catalog.pg_backend_pid() % 16)::smallint, 1)
      on conflict (organization_id, day, shard) do update
        set enqueued = private.organization_notification_outbound_counters.enqueued + 1;
    end if;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    ) values (
      new.id, new.user_id, 'email'
    ) on conflict (notification_id, channel) do nothing;
    insert into public.member_notification_deliveries (
      notification_id, user_id, channel
    )
    select new.id, new.user_id, 'push'
    where exists (
      select 1 from public.member_push_subscriptions s
      where s.user_id = new.user_id
    ) or exists (
      select 1 from public.member_native_push_installations i
      where i.user_id = new.user_id
    )
    on conflict (notification_id, channel) do nothing;
  exception
    when query_canceled then
      raise warning 'enqueue_notification_deliveries cancelled for notification %', new.id;
    when others then
      raise warning 'enqueue_notification_deliveries failed for notification %: % (%)',
        new.id, sqlerrm, sqlstate;
  end;
  return new;
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.quarterly_survey_gate_state(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid := p_organization_id;
  actor uuid := (select auth.uid());
  actor_chapter text := private.current_member_chapter();
  current_period text := pg_catalog.to_char((select private.eastern_day()), 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', (select private.eastern_day()))::integer;
  gate_enabled boolean;
  is_admin boolean;
  survey public.organization_surveys%rowtype;
  answerable boolean;
  session_status text;
  completed boolean;
  gate_reason text;
begin
  gate_enabled := private.organization_feature_enabled(org, 'features.engagement_voice.quarterly_survey_gate');
  is_admin := private.has_organization_role(org, array['admin']);

  select * into survey
  from public.organization_surveys s
  where s.organization_id = org
    and s.cadence = 'quarterly'
    and s.period_key = current_period
    and s.status in ('open', 'closed')
  order by case when s.status = 'open' then 0 else 1 end, s.updated_at desc
  limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'periodKey', current_period, 'surveyId', null, 'required', false,
      'completed', false, 'unlocked', true,
      'reason', case when is_admin then 'admin' when not gate_enabled then 'disabled' else 'no_survey' end,
      'gateEnabled', gate_enabled
    );
  end if;

  answerable := survey.status = 'open'
    and (survey.chapter_id is null or survey.chapter_id = actor_chapter)
    and (survey.opens_at is null or survey.opens_at <= pg_catalog.now())
    and (survey.closes_at is null or survey.closes_at > pg_catalog.now());

  select session.status into session_status
  from public.organization_survey_sessions session
  where session.organization_id = org
    and session.survey_id = survey.id
    and session.respondent_user_id = actor;
  completed := coalesce(session_status = 'submitted', false);

  gate_reason := case
    when is_admin then 'admin'
    when not gate_enabled then 'disabled'
    when completed then 'completed'
    when not answerable then 'unavailable'
    else 'incomplete'
  end;

  return pg_catalog.jsonb_build_object(
    'periodKey', current_period,
    'surveyId', survey.id,
    'title', survey.title,
    'required', answerable,
    'completed', completed,
    'unlocked', gate_reason <> 'incomplete',
    'reason', gate_reason,
    'gateEnabled', gate_enabled,
    'status', coalesce(session_status, 'not_started'),
    'closesAt', survey.closes_at
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_member_mentorship_pair(p_mentor_user_id uuid, p_mentee_user_id uuid, p_started_on date, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare org uuid := private.member_support_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if p_mentor_user_id is null or p_mentee_user_id is null or p_mentor_user_id = p_mentee_user_id then raise exception 'mentor and mentee must be different members' using errcode = '22023'; end if;
  if (select pg_catalog.count(*) from public.organization_memberships m where m.organization_id = org and m.user_id in (p_mentor_user_id, p_mentee_user_id) and m.status = 'active') <> 2 then raise exception 'both participants require active organization membership' using errcode = '22023'; end if;
  insert into public.member_mentorship_pairs (
    id, organization_id, mentor_user_id, mentee_user_id, started_on, created_by
  ) values (p_idempotency_key, org, p_mentor_user_id, p_mentee_user_id, coalesce(p_started_on, (select private.eastern_day())), (select auth.uid()))
  on conflict (id) do nothing;
  select id, status, started_on into row_out from public.member_mentorship_pairs
  where id = p_idempotency_key and organization_id = org;
  if row_out.id is null then raise exception 'pair already exists or idempotency key is invalid' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, p_mentee_user_id, 'mentorship_pair', row_out.id, 'created');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'startedOn', row_out.started_on);
exception when unique_violation then
  raise exception 'an active mentorship pair already exists' using errcode = '22023';
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_chapter_health_portfolio()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();
  return (
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'chapterId', chapter.id,
    'chapterName', chapter.name,
    'databaseDate', (select private.eastern_day()),
    'measuredOn', latest.measured_on,
    'cohortProtected', coalesce(latest.member_count, 0) < private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor'),
    'memberCount', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then latest.member_count else null end,
    'score', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then latest.score else null end,
    'recordedAt', latest.created_at,
    'recordedBy', case when latest.id is null then null else coalesce(
      nullif(pg_catalog.btrim(snapshot_creator.full_name), ''), 'Former staff member') end,
    'revisedAt', latest.updated_at,
    'revisedBy', case when latest.updated_at is null then null else coalesce(
      nullif(pg_catalog.btrim(snapshot_reviser.full_name), ''), 'Former staff member') end,
    'drivers', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then pg_catalog.jsonb_build_object(
      'participation', latest.participation,
      'caseTimeliness', latest.case_timeliness,
      'stewardCapacity', latest.steward_capacity,
      'trainingCoverage', latest.training_coverage,
      'communicationReach', latest.communication_reach,
      'governanceReadiness', latest.governance_readiness
    ) else null end,
    'trend', case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'measuredOn', trend.measured_on, 'score', trend.score
      ) order by trend.measured_on)
      from (
        select snapshot.measured_on, snapshot.score
        from public.chapter_health_snapshots snapshot
        where snapshot.chapter_id = chapter.id and snapshot.member_count >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor')
        order by snapshot.measured_on desc limit 12
      ) trend
    ), '[]'::jsonb) else '[]'::jsonb end,
    'coaching', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', coaching.id,
        'summary', coaching.summary,
        'nextAction', coaching.next_action,
        'attentionLevel', coaching.attention_level,
        'createdAt', coaching.created_at,
        'authorName', coalesce(nullif(pg_catalog.btrim(profile.full_name), ''), 'Former staff member')
      ) order by coaching.created_at desc)
      from (
        select * from public.chapter_health_coaching health_coaching
        where health_coaching.chapter_id = chapter.id
        order by health_coaching.created_at desc limit 20
      ) coaching
      left join public.member_profiles profile on profile.id = coaching.author_id
    ), '[]'::jsonb)
  ) order by
      case when coalesce(latest.member_count, 0) >= private.organization_limit(chapter.organization_id, 'limits.analytics.chapter_health_cohort_floor') then latest.score else null end nulls last,
      chapter.name), '[]'::jsonb)
  from public.chapters chapter
  left join lateral (
    select * from public.chapter_health_snapshots snapshot
    where snapshot.chapter_id = chapter.id
    order by snapshot.measured_on desc limit 1
  ) latest on true
  left join public.member_profiles snapshot_creator on snapshot_creator.id = latest.created_by
  left join public.member_profiles snapshot_reviser on snapshot_reviser.id = latest.updated_by
  where private.mfa_satisfied()
    and private.can_manage_chapter_health(chapter.id)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_member_engagement_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := (select auth.uid());
  org uuid := private.current_member_organization();
  current_period text := pg_catalog.to_char((select private.eastern_day()), 'YYYY')
    || '-Q' || pg_catalog.date_part('quarter', (select private.eastern_day()))::integer;
begin
  if actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if org is null then
    return pg_catalog.jsonb_build_object(
      'quarterlyGate', pg_catalog.jsonb_build_object(
        'periodKey', current_period,
        'surveyId', null,
        'required', false,
        'completed', false,
        'unlocked', true
      ),
      'surveys', '[]'::jsonb,
      'pulsePrompts', '[]'::jsonb,
      'livePolls', '[]'::jsonb,
      'workspace', pg_catalog.jsonb_build_object(
        'moduleOrder', '["inbox","surveys","tasks","cases"]'::jsonb,
        'hiddenModules', '[]'::jsonb
      ),
      'actions', '[]'::jsonb,
      'briefings', '[]'::jsonb
    );
  end if;
  if not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return private.engagement_member_snapshot_scoped();
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_analytics_report_card()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        greatest(0, ((select private.eastern_day()) - (last_activity at time zone 'America/New_York')::date)))
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.list_vouchable_organization_claims(p_selected_hat text, p_expected_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  org uuid;
  voucher_key text;
begin
  org := private.mi1_require_expected_selected_organization(p_expected_organization_id);
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_selected_hat is distinct from 'admin'
     or not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- A banned or deleted account, or an organization that is no longer
  -- active, never acts as a verifier.
  if exists (
       select 1 from auth.users as u
        where u.id = (select auth.uid())
          and (u.deleted_at is not null or u.banned_until > pg_catalog.now()))
     or not exists (
       select 1 from public.organizations as o
        where o.id = org and o.status = 'active') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- The list shows other tenants' pending claims, so it takes the same
  -- step-up as the vouch it feeds: aal2 always, and an enrolled verified
  -- factor where the organization's policy requires staff MFA.
  if coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2'
     or (private.staff_mfa_required(org) and not private.has_second_factor((select auth.uid()))) then
    raise exception 'mfa required' using errcode = '42501';
  end if;

  select p.identity_catalog_key into voucher_key
    from private.organization_catalog_placements as p
    join private.organization_claims as verified_by on verified_by.id = p.verified_claim_id
    join private.catalog_organizations as own_listing on own_listing.catalog_key = p.identity_catalog_key
   where p.organization_id = org
     and p.verified_at is not null
     and verified_by.verifier_kind is distinct from 'sibling_organization'
     and own_listing.retired_release_id is null
     and own_listing.duplicate_of is null;
  if voucher_key is null then
    return pg_catalog.jsonb_build_object('claims', '[]'::jsonb);
  end if;

  return pg_catalog.jsonb_build_object('claims', coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'claimId', candidate.id,
      'relationship', candidate.relationship,
      'catalogKey', candidate.catalog_key,
      'targetName', candidate.target_name,
      'unlisted', candidate.catalog_key is null,
      'organizationName', candidate.organization_name,
      'confirmedAt', candidate.email_confirmed_at
    ) order by candidate.email_confirmed_at, candidate.id)
    from (
      select related.*
        from (
          select c.id, c.catalog_key, c.email_confirmed_at,
                 coalesce(target.name, c.unlisted_name) as target_name,
                 claimant_org.name as organization_name,
                 private.organization_claim_vouch_relationship(c.id, voucher_key) as relationship
            from private.organization_claims as c
            join public.organizations as claimant_org
              on claimant_org.id = c.organization_id and claimant_org.status = 'active'
            left join private.catalog_organizations as target on target.catalog_key = c.catalog_key
           where c.status = 'under_review'
             and c.organization_id <> org
             and (c.catalog_key is null or (
               target.retired_release_id is null
               and target.duplicate_of is null
               and not coalesce(target.next_election_on between (select private.eastern_day()) - 30 and (select private.eastern_day()) + 90, false)))
             and not exists (
               select 1 from private.organization_catalog_placements as own
                where own.organization_id = c.organization_id
                  and (own.verified_at is not null or own.parent_catalog_key = c.catalog_key))
             -- The vouch's contest refusal: nothing is offered on a listing
             -- another organization holds or another open claim contests.
             and (c.catalog_key is null or (
               not exists (
                 select 1 from private.organization_catalog_placements as elsewhere
                  where elsewhere.identity_catalog_key = c.catalog_key)
               and not exists (
                 select 1 from private.organization_claims as other
                  where other.catalog_key = c.catalog_key
                    and other.id <> c.id
                    and (other.status in ('under_review', 'held')
                         or (other.status = 'approved' and other.organization_id is not null)))))
             and c.claimant_user_id is distinct from (select auth.uid())
             and not exists (
               select 1 from public.organization_memberships as m
                where m.organization_id = c.organization_id
                  and m.user_id = (select auth.uid())
                  and m.status = 'active')
        ) as related
       where related.relationship is not null
       order by related.email_confirmed_at, related.id
       limit 200
    ) as candidate
  ), '[]'::jsonb));
end;
$function$;

CREATE OR REPLACE FUNCTION public.record_chapter_health_snapshot(p_chapter_id text, p_measured_on date, p_participation integer, p_case_timeliness integer, p_steward_capacity integer, p_training_coverage integer, p_communication_reach integer, p_governance_readiness integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  members integer;
  calculated integer;
  saved public.chapter_health_snapshots%rowtype;
begin
  if caller is null
     or not private.mfa_satisfied()
     or not private.can_manage_chapter_health(p_chapter_id) then
    raise exception 'leadership role required' using errcode = '42501';
  end if;
  if p_measured_on is null or p_measured_on > (select private.eastern_day())
     or p_participation not between 0 and 100 or p_case_timeliness not between 0 and 100
     or p_steward_capacity not between 0 and 100 or p_training_coverage not between 0 and 100
     or p_communication_reach not between 0 and 100 or p_governance_readiness not between 0 and 100 then
    raise exception 'invalid health drivers' using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer into members
  from public.member_chapter_memberships membership
  where membership.chapter_id = p_chapter_id and membership.status = 'active';
  calculated := pg_catalog.round((p_participation + p_case_timeliness + p_steward_capacity
    + p_training_coverage + p_communication_reach + p_governance_readiness)::numeric / 6)::integer;
  insert into public.chapter_health_snapshots
    (chapter_id, measured_on, member_count, participation, case_timeliness,
     steward_capacity, training_coverage, communication_reach, governance_readiness,
     score, created_by)
  values (p_chapter_id, p_measured_on, members, p_participation, p_case_timeliness,
    p_steward_capacity, p_training_coverage, p_communication_reach, p_governance_readiness,
    calculated, caller)
  on conflict (chapter_id, measured_on) do update
    set member_count = excluded.member_count, participation = excluded.participation,
        case_timeliness = excluded.case_timeliness, steward_capacity = excluded.steward_capacity,
        training_coverage = excluded.training_coverage, communication_reach = excluded.communication_reach,
        governance_readiness = excluded.governance_readiness, score = excluded.score,
        updated_by = caller, updated_at = pg_catalog.clock_timestamp()
  returning * into saved;
  return pg_catalog.to_jsonb(saved);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION public.transition_member_mentorship_pair(p_pair_id uuid, p_status text, p_outcome text, p_idempotency_key uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare org uuid := private.member_support_selected_organization(); row_out record;
begin
  if not private.member_support_is_staff(org) then raise exception 'staff role and MFA required' using errcode = '42501'; end if;
  if p_status not in ('active', 'completed', 'cancelled') or pg_catalog.char_length(coalesce(p_outcome, '')) > 2000 then raise exception 'invalid mentorship transition' using errcode = '22023'; end if;
  update public.member_mentorship_pairs set
    status = p_status, outcome = coalesce(p_outcome, ''),
    ended_on = case when p_status = 'active' then null else (select private.eastern_day()) end,
    updated_at = pg_catalog.now()
  where id = p_pair_id and organization_id = org
  returning id, mentee_user_id, status, ended_on into row_out;
  if row_out.id is null then raise exception 'mentorship pair not found' using errcode = '22023'; end if;
  perform private.member_support_record_event(p_idempotency_key, org, row_out.mentee_user_id, 'mentorship_pair', row_out.id, 'transitioned');
  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', row_out.status, 'endedOn', row_out.ended_on);
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.perform_organization_retention_run(p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  run_row public.organization_retention_runs%rowtype;
  policy_row public.organization_retention_policies%rowtype;
  removed integer := 0;
  remaining integer := 0;
  extra integer := 0;
  candidate_id uuid;
begin
  perform private.lock_message_lifecycle();
  select r.* into run_row
  from public.organization_retention_runs r
  where r.id = p_run_id
  for update;
  if run_row.id is null or run_row.status <> 'authorized' then
    raise exception 'authorized retention run required' using errcode = '22023';
  end if;
  if run_row.authorization_expires_at <= pg_catalog.now() then
    update public.organization_retention_runs
      set status = 'expired', completed_at = pg_catalog.now(),
          failure_code = 'authorization_expired'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'expired');
  end if;

  select p.* into policy_row
  from public.organization_retention_policies p
  where p.organization_id = run_row.organization_id and p.data_class = run_row.data_class
  for key share;
  if policy_row.organization_id is null or not policy_row.execution_enabled then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_disabled'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'execution_disabled');
  end if;
  if policy_row.retention_days <> run_row.retention_days then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'policy_changed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object('id', run_row.id, 'status', 'failed', 'failureCode', 'policy_changed');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(run_row.organization_id::text || ':' || run_row.data_class, 0)
  );
  update public.organization_retention_runs
    set status = 'running', started_at = pg_catalog.now()
    where id = run_row.id;

  begin
    case run_row.data_class
      when 'organization_page_views' then
        with candidates as (
          select v.ctid
          from public.organization_page_views v
          where v.organization_id = run_row.organization_id
            -- Page-view rows are bucketed on the UTC day (public.record_workspace_page_view),
            -- so the cut-off reads the UTC day explicitly, whatever the session time
            -- zone (#8568).
            and v.day < (pg_catalog.now() at time zone 'UTC')::date - run_row.retention_days
          order by v.day, v.path, v.hat
          limit 5000
          for update skip locked
        )
        delete from public.organization_page_views target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'organization_engagement_events' then
        with candidates as (
          select e.ctid
          from public.organization_engagement_events e
          where e.organization_id = run_row.organization_id
            and e.occurred_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by e.occurred_at, e.user_id, e.event_type, e.source_id
          limit 5000
          for update skip locked
        )
        delete from public.organization_engagement_events target
        where target.ctid in (select candidates.ctid from candidates);
        get diagnostics removed = row_count;
      when 'integration_job_history' then
        with candidates as (
          select j.id
          from public.integration_jobs j
          where j.organization_id = run_row.organization_id
            and j.status in ('success', 'failed', 'skipped', 'dead')
            and j.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by j.updated_at, j.id
          limit 5000
          for update skip locked
        )
        delete from public.integration_jobs target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'public_event_rsvps' then
        with candidates as (
          select r.id
          from public.public_event_rsvps r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update skip locked
        )
        delete from public.public_event_rsvps target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'deleted_chapter_tasks' then
        with candidates as (
          select t.id
          from public.chapter_tasks t
          join public.chapters c on c.id = t.chapter_id
          where c.organization_id = run_row.organization_id
            and t.deleted_at is not null
            and t.deleted_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by t.deleted_at, t.id
          limit 5000
          for update of t skip locked
        )
        delete from public.chapter_tasks target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'member_message_bodies' then
        -- Row-at-a-time on purpose. private.redact_member_message_row is the
        -- only path allowed to destroy a body: it re-checks the preservation
        -- order under the row lock and sweeps the duplicate scheduled-message
        -- copy. A set-based UPDATE here would be faster and would leave that
        -- second plaintext copy behind. A hold placed mid-run raises and the
        -- handler below fails the run without redacting further — preservation
        -- wins over the retention window, deliberately.
        for candidate_id in
          select m.id
          from public.member_messages m
          join public.member_conversations c on c.id = m.conversation_id
          where c.organization_id = run_row.organization_id
            and m.redacted_at is null
            and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(m.conversation_id)
          order by m.created_at, m.id
          limit 5000
        loop
          if private.redact_member_message_row(candidate_id, 'retention_expired', run_row.authorized_by) then
            removed := removed + 1;
          end if;
        end loop;
        -- The second durable copy with no delivered row behind it. A draft that
        -- was never dispatched is not reachable from the loop above — nothing
        -- points at it — so without this it would keep its plaintext body past
        -- the window forever, which is exactly what the class promises to
        -- prevent. Same bound, same preservation-order refusal.
        for candidate_id in
          select s.id
          from public.member_scheduled_messages s
          join public.member_conversations c on c.id = s.conversation_id
          where c.organization_id = run_row.organization_id
            and s.redacted_at is null
            and s.sent_message_id is null
            and s.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not private.member_message_under_legal_hold(s.conversation_id)
          order by s.created_at, s.id
          limit 5000
        loop
          if private.redact_member_scheduled_message_row(candidate_id) then
            removed := removed + 1;
          end if;
        end loop;
      when 'casework_record_versions' then
        -- Same bound and the same skip-locked candidate shape as every other
        -- deleting class. `case_id is null` is the whole disposition: a
        -- case-scoped snapshot is out of reach of this branch and stays out of
        -- reach, because its lifetime is the case's lifetime, not a window.
        with candidates as (
          select v.id
          from private.casework_record_versions v
          where v.organization_id = run_row.organization_id
            and v.case_id is null
            and v.at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by v.at, v.id
          limit 5000
          for update skip locked
        )
        delete from private.casework_record_versions target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'member_notifications' then
        -- Deliveries cascade with their notification; dues and automation
        -- references detach (on delete set null).
        with candidates as (
          select n.id
          from public.member_notifications n
          where n.organization_id = run_row.organization_id
            and n.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by n.created_at, n.id
          limit 5000
          for update of n skip locked
        )
        delete from public.member_notifications target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
      when 'ai_assistant_conversations' then
        -- One 5,000-row budget covers both statements, and a conversation is
        -- removed only once it holds no messages at all.
        --
        -- BUG-UG-AI-RETENTION-CASCADE-BATCH-COUNT-20261010: the thread
        -- foreign key added in 20260721000709 is `on delete cascade`, so
        -- deleting a thread that still held expired messages destroyed them
        -- outside `removed` and outside the batch bound. Testing for "no
        -- recent messages" was what let that happen: a thread older than the
        -- window whose expired messages had not fitted in the message
        -- statement's own 5,000 rows still qualified. `not exists (any
        -- message)` is the condition the class description has always
        -- advertised, and it leaves nothing for the cascade to find.
        with candidates as (
          select m.id
          from public.member_guide_messages m
          where m.organization_id = run_row.organization_id
            and m.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by m.created_at, m.id
          limit 5000
          for update of m skip locked
        )
        delete from public.member_guide_messages target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
        -- Whatever the message statement left of the shared budget. A
        -- conversation whose expired messages outlast one execution keeps its
        -- thread row until a later execution empties it, so the continuation
        -- the scheduler already performs finishes the work; private.retention_eligible_count
        -- counts that thread as eligible throughout, so remaining_count stays
        -- exact. The emptiness test is repeated in the DELETE itself: the
        -- candidate scan cannot be the only guard against a message inserted
        -- into an expired thread between the scan and the delete.
        with candidates as (
          select t.id
          from public.member_guide_threads t
          where t.organization_id = run_row.organization_id
            and t.updated_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
            and not exists (
              select 1 from public.member_guide_messages m
              where m.thread_id = t.id
            )
          order by t.updated_at, t.id
          limit 5000 - removed
          for update of t skip locked
        )
        delete from public.member_guide_threads target
        where target.id in (select candidates.id from candidates)
          and not exists (
            select 1 from public.member_guide_messages m
            where m.thread_id = target.id
          );
        get diagnostics extra = row_count;
        removed := removed + extra;
      when 'ai_usage_counters' then
        with candidates as (
          select r.id
          from public.member_ai_requests r
          where r.organization_id = run_row.organization_id
            and r.created_at < pg_catalog.now() - pg_catalog.make_interval(days => run_row.retention_days)
          order by r.created_at, r.id
          limit 5000
          for update of r skip locked
        )
        delete from public.member_ai_requests target
        where target.id in (select candidates.id from candidates);
        get diagnostics removed = row_count;
    end case;

    remaining := private.retention_eligible_count(
      run_row.organization_id, run_row.data_class, run_row.retention_days
    );
    update public.organization_retention_runs
      set status = 'completed', deleted_count = removed,
          remaining_count = remaining, completed_at = pg_catalog.now()
      where id = run_row.id;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, idempotency_key, metadata
    ) values (
      run_row.organization_id, 'privacy', 'retention.completed', 'delete', run_row.authorized_by,
      'retention_run', run_row.id::text, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object(
        'dataClass', run_row.data_class,
        'retentionDays', run_row.retention_days,
        'eligibleCount', run_row.eligible_count,
        'deletedCount', removed,
        'remainingCount', remaining,
        'mode', run_row.mode,
        'operation', private.retention_data_class_config(run_row.data_class) ->> 'operation'
      ) || case
        -- A scheduled run has no actor (actor_user_id stays null). The admin
        -- whose standing policy authorized it is recorded separately as
        -- userId, so the ledger never shows that person performing the run.
        when run_row.mode = 'scheduled' and policy_row.updated_by is not null
          then pg_catalog.jsonb_build_object('userId', policy_row.updated_by)
        else '{}'::jsonb
      end
    );
  exception when others then
    update public.organization_retention_runs
      set status = 'failed', completed_at = pg_catalog.now(),
          failure_code = 'execution_failed'
      where id = run_row.id;
    return pg_catalog.jsonb_build_object(
      'id', run_row.id, 'status', 'failed', 'failureCode', 'execution_failed'
    );
  end;

  return pg_catalog.jsonb_build_object(
    'id', run_row.id,
    'dataClass', run_row.data_class,
    'status', 'completed',
    'deletedCount', removed,
    'remainingCount', remaining
  );
end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.retention_eligible_count(p_organization_id uuid, p_data_class text, p_retention_days integer)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  eligible bigint;
  cutoff timestamptz := pg_catalog.now() - pg_catalog.make_interval(days => p_retention_days);
begin
  if private.retention_data_class_config(p_data_class) is null then
    raise exception 'unsupported retention data class' using errcode = '22023';
  end if;

  case p_data_class
    when 'organization_page_views' then
      select pg_catalog.count(*) into eligible
      from public.organization_page_views v
      where v.organization_id = p_organization_id
        -- Page-view rows are bucketed on the UTC day (public.record_workspace_page_view),
        -- so the cut-off reads the UTC day explicitly, whatever the session time
        -- zone (#8568).
        and v.day < (pg_catalog.now() at time zone 'UTC')::date - p_retention_days;
    when 'organization_engagement_events' then
      select pg_catalog.count(*) into eligible
      from public.organization_engagement_events e
      where e.organization_id = p_organization_id
        and e.occurred_at < cutoff;
    when 'integration_job_history' then
      select pg_catalog.count(*) into eligible
      from public.integration_jobs j
      where j.organization_id = p_organization_id
        and j.status in ('success', 'failed', 'skipped', 'dead')
        and j.updated_at < cutoff;
    when 'public_event_rsvps' then
      select pg_catalog.count(*) into eligible
      from public.public_event_rsvps r
      where r.organization_id = p_organization_id
        and r.created_at < cutoff;
    when 'deleted_chapter_tasks' then
      select pg_catalog.count(*) into eligible
      from public.chapter_tasks t
      join public.chapters c on c.id = t.chapter_id
      where c.organization_id = p_organization_id
        and t.deleted_at is not null
        and t.deleted_at < cutoff;
    when 'member_message_bodies' then
      select
        (select pg_catalog.count(*)
         from public.member_messages m
         join public.member_conversations c on c.id = m.conversation_id
         where c.organization_id = p_organization_id
           and m.redacted_at is null
           and m.created_at < cutoff
           and not private.member_message_under_legal_hold(m.conversation_id))
        + (select pg_catalog.count(*)
           from public.member_scheduled_messages s
           join public.member_conversations c on c.id = s.conversation_id
           where c.organization_id = p_organization_id
             and s.redacted_at is null
             and s.sent_message_id is null
             and s.created_at < cutoff
             and not private.member_message_under_legal_hold(s.conversation_id))
      into eligible;
    when 'casework_record_versions' then
      select pg_catalog.count(*) into eligible
      from private.casework_record_versions v
      where v.organization_id = p_organization_id
        and v.case_id is null
        and v.at < cutoff;
    -- Unattributed legacy rows are deliberately outside tenant purges.
    when 'member_notifications' then
      select pg_catalog.count(*) into eligible
      from public.member_notifications n
      where n.organization_id = p_organization_id
        and n.created_at < cutoff;
    when 'ai_assistant_conversations' then
      select
        (select pg_catalog.count(*)
         from public.member_guide_messages m
         where m.organization_id = p_organization_id
           and m.created_at < cutoff)
        + (select pg_catalog.count(*)
           from public.member_guide_threads t
           where t.organization_id = p_organization_id
             and t.updated_at < cutoff
             and not exists (
               select 1 from public.member_guide_messages m
               where m.thread_id = t.id and m.created_at >= cutoff
             ))
      into eligible;
    when 'ai_usage_counters' then
      select pg_catalog.count(*) into eligible
      from public.member_ai_requests r
      where r.organization_id = p_organization_id
        and r.created_at < cutoff;
  end case;

  if eligible > 2147483647 then
    return 2147483647;
  end if;
  return eligible::integer;
end;
$function$;

-- The dues reminder cron files reminders in the month of p_today. Its default
-- read the session day, so a call without p_today on a month's last evening
-- filed next month's window. Only the default changes; a parameter default is
-- evaluated with the caller's privileges, so it is the inline Eastern day, not
-- private.eastern_day(), which the service role cannot execute.
CREATE OR REPLACE FUNCTION public.plan_dues_reminder_attempts(p_limit integer, p_today date DEFAULT ((pg_catalog.now() AT TIME ZONE 'America/New_York'::text))::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  inserted_count integer;
begin
  -- A case-graph writer (dues_reminder_attempts): the transaction entry gate
  -- comes first, as 20260907151000 installed it for the prior definition.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 500 or p_today is null then
    raise exception 'invalid dues reminder planning limit' using errcode = '22023';
  end if;
  with candidates as materialized (
    select obligation.organization_id, obligation.id
    from public.dues_obligations obligation
    where obligation.due_on < p_today
      and private.organization_feature_enabled(obligation.organization_id, 'features.notifications.dues_reminders')
      and obligation.due_on <= p_today - private.organization_limit(obligation.organization_id, 'limits.notifications.dues_reminder_days_past_due')
      and private.dues_balance_cents(obligation.organization_id, obligation.id) > 0
    order by obligation.due_on asc, obligation.id asc
    limit p_limit
  ), inserted as (
    insert into public.dues_reminder_attempts (organization_id, obligation_id, policy_window, channel)
    select organization_id, id, date_trunc('month', p_today)::date, 'in_app'
    from candidates
    on conflict (organization_id, obligation_id, policy_window, channel) do nothing
    returning id
  )
  select count(*) into inserted_count from inserted;
  return inserted_count;
end;
$function$;

alter table public.member_mentorship_pairs
  alter column started_on set default ((pg_catalog.now() at time zone 'America/New_York'))::date;
-- The account-lifecycle trigger review follows every changed function that a
-- lifecycle trigger reaches, and the Eastern-day helper they now call.
insert into private.account_lifecycle_trigger_review(kind,schema_name,table_name,object_name,definition_hash)
select surface.kind,surface.schema_name,surface.table_name,surface.object_name,surface.definition_hash
from private.account_lifecycle_trigger_surface() surface
join (values
    ('private','catalog_claim_domain_signals'),
    ('private','enqueue_notification_deliveries'),
    ('private','quarterly_survey_gate_state'),
    ('public','create_member_mentorship_pair'),
    ('public','get_chapter_health_portfolio'),
    ('public','get_member_engagement_snapshot'),
    ('public','get_my_analytics_report_card'),
    ('public','list_vouchable_organization_claims'),
    ('public','record_chapter_health_snapshot'),
    ('public','transition_member_mentorship_pair'),
    ('private','perform_organization_retention_run'),
    ('private','retention_eligible_count'),
    ('public','plan_dues_reminder_attempts'),
    ('private','eastern_day')
) changed(schema_name,function_name)
  on changed.schema_name=surface.schema_name
 and changed.function_name=pg_catalog.split_part(surface.object_name,'(',1)
where surface.kind='function'
on conflict(kind,schema_name,table_name,object_name)
do update set definition_hash=excluded.definition_hash;

commit;
