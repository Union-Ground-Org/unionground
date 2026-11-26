-- REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030 (#6575).
--
-- The October 29-30, 2026 role-play run (findings 91 and 92):
--   * a duplicate ballot or pulse draft in Campaigns could not be deleted:
--     the registry offered only Edit and Publish;
--   * a live poll could not be tied to the meeting it is taken at: the roster
--     picker lists people, not events.
--
-- 1. public.delete_vote_campaign_draft removes a never-published standard
--    ballot or pulse draft the caller may manage, under exactly the predicate
--    publish_vote_campaign uses (staff role plus
--    private.can_manage_vote_campaign on the row's organization and chapter).
--    Officer-removal drafts keep their own governance lifecycle and are
--    refused. Options cascade with the campaign; a draft has no votes or
--    receipts. The audit row reuses the reviewed 'update_campaign_draft'
--    action with state 'deleted', so the member_admin_audit action list is
--    unchanged.
-- 2. organization_live_polls.event_id names the meeting a live poll belongs
--    to. It is validated on every write and read through a join, never
--    trusted: the event must be an uncancelled event in one of the selected
--    organization's chapters and in the caller's own chapter (the same
--    chapter rule public.get_admin_events applies to staff). A deleted or
--    moved event simply stops resolving. The column carries no FK constraint, so a
--    member_events delete never cascades into the poll.
--    public.set_organization_live_poll_event writes the link for an
--    engagement staff member of the selected organization;
--    public.get_live_poll_meetings returns the caller's choosable meetings
--    and the links on the organization's polls.

begin;

create function public.delete_vote_campaign_draft(p_kind text, p_campaign_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  campaign record;
begin
  if caller is null
     or not public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']) then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_kind = 'ballot' then
    select b.id, b.chapter_id into campaign
    from public.member_ballots b
    where b.id = p_campaign_id
      and private.can_manage_vote_campaign(b.organization_id, b.chapter_id)
      and b.campaign_state = 'draft' and b.published_at is null
      and b.ballot_type = 'standard'
    for update;
    if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
    delete from public.member_ballots where id = p_campaign_id;
  elsif p_kind = 'pulse' then
    select s.id, s.chapter_id into campaign
    from public.member_surveys s
    where s.id = p_campaign_id
      and private.can_manage_vote_campaign(s.organization_id, s.chapter_id)
      and s.campaign_state = 'draft' and s.published_at is null
    for update;
    if not found then raise exception 'campaign not found' using errcode = '22023'; end if;
    delete from public.member_surveys where id = p_campaign_id;
  else
    raise exception 'invalid campaign kind' using errcode = '22023';
  end if;
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'update_campaign_draft', pg_catalog.jsonb_build_object(
    'campaignId', p_campaign_id, 'kind', p_kind,
    'scope', case when campaign.chapter_id is null then 'union' else 'chapter' end,
    'state', 'deleted'));
  return pg_catalog.jsonb_build_object('id', p_campaign_id, 'kind', p_kind, 'state', 'deleted');
end;
end;
$function$;

revoke all on function public.delete_vote_campaign_draft(text, text) from public, anon, authenticated, service_role;
grant execute on function public.delete_vote_campaign_draft(text, text) to authenticated;
comment on function public.delete_vote_campaign_draft(text, text) is
  'REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: deletes a never-published standard ballot or pulse draft the caller may manage (the publish_vote_campaign predicate); officer-removal drafts are refused. Audited as update_campaign_draft with state deleted.';

alter table public.organization_live_polls
  add column event_id text;

alter table public.organization_live_polls
  add constraint organization_live_polls_event_id_bounded check (
    event_id is null or (
      pg_catalog.char_length(event_id) between 1 and 200
      and event_id !~ '[[:cntrl:]]'
    )
  );

comment on column public.organization_live_polls.event_id is
  'REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: the meeting (public.member_events.id) this live poll is taken at. Written only by public.set_organization_live_poll_event and resolved through private.live_poll_meeting_visible on read; no FK constraint, so an event delete never cascades into the poll.';

-- The meetings a staff member may tie a poll to: uncancelled events in one of
-- the organization's chapters and in the caller's own chapter.
create function private.live_poll_meeting_visible(p_organization_id uuid, p_event_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.member_events e
    where e.id = p_event_id
      and e.cancelled_at is null
      and e.chapter_id is not null
      and e.chapter_id = private.current_member_chapter()
      and private.mi1_w2_same_org_chapter(p_organization_id, e.chapter_id)
  )
$function$;

revoke all on function private.live_poll_meeting_visible(uuid, text) from public, anon, authenticated, service_role;

create function public.set_organization_live_poll_event(p_poll_id uuid, p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  next_event text := nullif(pg_catalog.btrim(coalesce(p_event_id, '')), '');
  poll public.organization_live_polls%rowtype;
begin
  perform private.engagement_require_staff(org);
  select * into poll from public.organization_live_polls
  where id = p_poll_id and organization_id = org
  for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  if poll.state not in ('draft', 'scheduled', 'open') then
    raise exception 'a closed or cancelled poll cannot be edited' using errcode = '55000';
  end if;
  if next_event is not null and not private.live_poll_meeting_visible(org, next_event) then
    raise exception 'meeting unavailable' using errcode = '42501';
  end if;
  update public.organization_live_polls
  set event_id = next_event, updated_at = pg_catalog.now()
  where id = poll.id;
  perform private.mi1_w2_write_audit(org, 'live_poll_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'pollId', poll.id, 'userId', (select auth.uid()), 'status', poll.state,
    'fieldsChanged', pg_catalog.jsonb_build_array('meeting')
  ));
  return pg_catalog.jsonb_build_object('pollId', poll.id, 'eventId', next_event);
end;
end;
$function$;

revoke all on function public.set_organization_live_poll_event(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_organization_live_poll_event(uuid, text) to authenticated;
comment on function public.set_organization_live_poll_event(uuid, text) is
  'REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: ties a draft, scheduled or open live poll of the selected organization to a meeting the caller may see (private.live_poll_meeting_visible), or clears the link. Engagement staff only.';

create function public.get_live_poll_meetings()
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
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', choice.id, 'title', choice.title, 'startsAt', choice.starts_at
      ) order by choice.starts_at, choice.id)
      from (
        select e.id, e.title, e.starts_at
        from public.member_events e
        where e.starts_at >= pg_catalog.now() - interval '1 day'
          and e.starts_at <= pg_catalog.now() + interval '180 days'
          and private.live_poll_meeting_visible(org, e.id)
        order by e.starts_at, e.id
        limit 50
      ) choice
    ), '[]'::jsonb),
    'links', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'pollId', poll.id, 'eventId', poll.event_id,
        'title', case when private.live_poll_meeting_visible(org, poll.event_id) then e.title else null end,
        'startsAt', case when private.live_poll_meeting_visible(org, poll.event_id) then e.starts_at else null end
      ) order by poll.id)
      from public.organization_live_polls poll
      left join public.member_events e on e.id = poll.event_id
      where poll.organization_id = org and poll.event_id is not null
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.get_live_poll_meetings() from public, anon, authenticated, service_role;
grant execute on function public.get_live_poll_meetings() to authenticated;
comment on function public.get_live_poll_meetings() is
  'REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030: for engagement staff of the selected organization, the meetings the caller may tie a live poll to (uncancelled events in the caller''s own chapter, from a day ago to 180 days ahead, at most 50) and the meeting links on the organization''s live polls; a link to a meeting the caller cannot see carries no title.';

-- ---------------------------------------------------------------------------
-- Survey reminders stop at the close time. The builder now sets a close time
-- on any survey, and answers stop then, so the scheduled sweep, the manual
-- reminder and the sender all skip a survey past it (an already-queued email
-- is reported unavailable instead of sent). Bodies copied from the installed
-- definitions; only the closes_at conditions are new.
-- ---------------------------------------------------------------------------

create or replace function private.run_survey_operations_sweep(p_limit integer DEFAULT 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := coalesce(p_limit, 100);
  survey public.organization_surveys%rowtype;
  attention jsonb;
  created integer := 0;
  marked integer := 0;
  escalated integer := 0;
  reminders integer := 0;
  step integer;
  actor uuid;
begin
  if cap not between 1 and 500 then
    raise exception 'invalid survey sweep limit' using errcode = '22023';
  end if;
  -- Switched-off organizations are excluded before LIMIT, and the durable
  -- per-survey cursor puts the least recently swept surveys first, so neither
  -- a disabled tenant nor the oldest 100 surveys can starve the rest.
  for survey in
    select candidate.*
    from public.organization_surveys candidate
    where (candidate.status = 'open'
       or (candidate.status = 'closed' and candidate.operations_state <> 'complete'))
      and private.organization_feature_enabled(candidate.organization_id, 'features.engagement_voice.survey_follow_up_automation')
    order by candidate.operations_swept_at nulls first, candidate.id
    for update skip locked
    limit cap
  loop
    update public.organization_surveys
    set operations_swept_at = pg_catalog.now()
    where id = survey.id;
    attention := private.survey_operations_state(survey.id);

    if (attention ->> 'reviewReady')::boolean then
      if private.open_survey_follow_up_task(survey, 'response_review', null) then created := created + 1; end if;
    end if;
    if (attention ->> 'closeoutDue')::boolean then
      if private.open_survey_follow_up_task(survey, 'closeout', null) then created := created + 1; end if;
    end if;
    if (attention #>> '{lowResponse,due}')::boolean then
      if private.open_survey_follow_up_task(survey, 'low_response', null) then created := created + 1; end if;
    end if;
    if attention #>> '{escalation,level}' in ('elevated', 'urgent') then
      if private.open_survey_follow_up_task(survey, 'coverage_escalation', pg_catalog.now()) then created := created + 1; end if;
    end if;

    -- A survey past its close time takes no answers, so it gets no more
    -- reminders either (REQ-UG-SURVEY-AND-POLL-BUILDER-OPTIONS-20261030).
    if survey.status = 'open' and (survey.closes_at is null or survey.closes_at > pg_catalog.now()) then
      -- Reminder cadence: unanswered deliveries become reminder_due once the
      -- survey's reminder date passes, then escalated when a due reminder is
      -- still unanswered after the progress window.
      if (attention #>> '{reminder,due}')::boolean then
        update public.organization_survey_deliveries delivery
        set escalation_state = 'reminder_due', updated_at = pg_catalog.now()
        where delivery.survey_id = survey.id and delivery.engaged_at is null
          and delivery.state in ('queued', 'sent', 'failed') and delivery.escalation_state = 'none';
        get diagnostics step = row_count;
        marked := marked + step;
      end if;
      update public.organization_survey_deliveries delivery
      set escalation_state = 'escalated', updated_at = pg_catalog.now()
      where delivery.survey_id = survey.id and delivery.engaged_at is null
        and delivery.escalation_state = 'reminder_due'
        and delivery.updated_at <= pg_catalog.now() - pg_catalog.make_interval(days => (attention ->> 'progressStaleDays')::integer);
      get diagnostics step = row_count;
      escalated := escalated + step;

      if private.organization_feature_enabled(survey.organization_id, 'features.engagement_voice.survey_scheduled_reminders') then
        with candidates as (
          select delivery.recipient_user_id
          from public.organization_survey_deliveries delivery
          where delivery.survey_id = survey.id and delivery.engaged_at is null
            and delivery.state in ('queued', 'sent', 'failed')
            and delivery.escalation_state in ('reminder_due', 'escalated')
            -- Same producer-side opt-out as the manual Remind button
            -- (20261002021000); the lease-time payload check stays the backstop.
            and not private.engagement_email_opted_out(delivery.recipient_user_id, 'survey_reminder')
            and not exists (
              select 1 from public.engagement_delivery_outbox outbox
              where outbox.delivery_kind = 'survey_reminder' and outbox.source_id = survey.id::text
                and outbox.recipient_user_id = delivery.recipient_user_id
            )
        ), inserted as (
          insert into public.engagement_delivery_outbox (
            organization_id, recipient_user_id, delivery_kind, source_kind, source_id
          )
          select survey.organization_id, candidates.recipient_user_id, 'survey_reminder', 'survey', survey.id::text
          from candidates
          on conflict (delivery_kind, source_id, recipient_user_id) do nothing
          returning recipient_user_id
        )
        select pg_catalog.count(*)::integer into step from inserted;
        if step > 0 then
          reminders := reminders + step;
          actor := coalesce(survey.owner_user_id, survey.created_by);
          if actor is not null then
            insert into public.organization_audit_events (
              organization_id, event_type, actor_user_id, idempotency_key, metadata
            ) values (
              survey.organization_id, 'survey_reminders_queued', actor, extensions.gen_random_uuid(),
              pg_catalog.jsonb_build_object(
                'organizationId', survey.organization_id, 'surveyId', survey.id,
                'userId', actor, 'count', step, 'reasonCode', 'scheduled'
              )
            );
          end if;
        end if;
      end if;
    end if;
  end loop;
  return pg_catalog.jsonb_build_object(
    'tasksCreated', created, 'remindersDue', marked, 'escalated', escalated, 'remindersQueued', reminders
  );
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
      and (s.closes_at is null or s.closes_at > pg_catalog.now())
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

create or replace function public.get_engagement_delivery_payload(p_delivery_id uuid, p_lease_token uuid)
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
      and survey.organization_id = row.organization_id and survey.status = 'open'
      -- An email queued before the close time is not sent after it.
      and (survey.closes_at is null or survey.closes_at > pg_catalog.now());
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

notify pgrst, 'reload schema';

commit;
