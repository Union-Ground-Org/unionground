-- SEC-UG-LIVE-POLL-ROSTER-ELIGIBILITY-NOT-ROSTER-BOUND-20260920
--
-- Meeting-roster voting eligibility is staff-granted. New attendance rows
-- default to ineligible. Self-service RSVP and self check-in never write or
-- raise eligible. Staff roster writes and a staff-executed check-in of another
-- member remain the only granters. Existing attendance rows keep the eligible
-- value stored at insert; this migration does not rewrite them.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.organization_live_poll_attendance
  alter column eligible set default false;

comment on table public.organization_live_poll_attendance is
  'Meeting-roster attendance. eligible is staff-granted voting eligibility. Rows that predate the 2026-09-21 staff-only eligibility change keep their stored eligible value; this migration does not rewrite them.';

comment on column public.organization_live_poll_attendance.eligible is
  'Staff-granted voting eligibility on a meeting-roster poll. New rows default to false. Only public.set_organization_live_poll_roster and a staff-executed check-in of another member set this true. Rows that predate this default keep the value stored at insert and are not rewritten in place.';

create or replace function public.set_organization_live_poll_roster(
  p_poll_id uuid,
  p_user_ids uuid[]
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
  added integer;
begin
  perform private.engagement_require_staff(org);
  if not exists (
    select 1 from public.organization_live_polls p
    where p.id = p_poll_id and p.organization_id = org and p.state in ('draft', 'scheduled', 'open')
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if exists (
    select 1 from pg_catalog.unnest(coalesce(p_user_ids, '{}'::uuid[])) actor(user_id)
    where not private.engagement_user_in_organization(org, actor.user_id)
  ) then raise exception 'roster contains a non-member' using errcode = '42501'; end if;
  insert into public.organization_live_poll_attendance (
    organization_id, poll_id, user_id, eligible
  )
  select org, p_poll_id, actor.user_id, true
  from pg_catalog.unnest(coalesce(p_user_ids, '{}'::uuid[])) actor(user_id)
  on conflict (poll_id, user_id) do update set eligible = true, updated_at = pg_catalog.now();
  get diagnostics added = row_count;
  return pg_catalog.jsonb_build_object('pollId', p_poll_id, 'rosterCount', added);
end;
end;
$function$;

comment on function public.set_organization_live_poll_roster(uuid, uuid[]) is
  'Staff meeting-roster write. Inserts eligible = true for each named member and raises eligible on conflict. The case-graph lock is the first statement of the body.';

create or replace function public.rsvp_organization_live_poll(p_poll_id uuid, p_rsvp text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_rsvp not in ('yes', 'no', 'maybe') then raise exception 'invalid rsvp' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.organization_live_polls p
    where p.id = p_poll_id and p.organization_id = org and p.state in ('scheduled', 'open')
      and (p.chapter_id is null or p.chapter_id = private.current_member_chapter())
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  insert into public.organization_live_poll_attendance (
    organization_id, poll_id, user_id, rsvp
  ) values (org, p_poll_id, actor, p_rsvp)
  on conflict (poll_id, user_id) do update set rsvp = excluded.rsvp, updated_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('pollId', p_poll_id, 'rsvp', p_rsvp);
end;
end;
$function$;

comment on function public.rsvp_organization_live_poll(uuid, text) is
  'Member RSVP for a live poll. Inserts without eligible so the column default (false) applies, and never raises a stored eligible value. The case-graph lock is the first statement of the body.';

create or replace function public.check_in_organization_live_poll(
  p_poll_id uuid,
  p_user_id uuid default null
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
  actor uuid := (select auth.uid());
  target uuid := coalesce(p_user_id, actor);
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if target <> actor then perform private.engagement_require_staff(org); end if;
  if not private.engagement_user_in_organization(org, target) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.organization_live_polls p
    where p.id = p_poll_id and p.organization_id = org and p.state in ('scheduled', 'open')
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if target <> actor then
    insert into public.organization_live_poll_attendance (
      organization_id, poll_id, user_id, eligible, rsvp, checked_in_at, check_in_actor
    ) values (org, p_poll_id, target, true, 'yes', pg_catalog.now(), actor)
    on conflict (poll_id, user_id) do update
      set eligible = true,
          checked_in_at = pg_catalog.now(), check_in_actor = actor,
          rsvp = case when public.organization_live_poll_attendance.rsvp = 'no' then 'yes' else public.organization_live_poll_attendance.rsvp end,
          updated_at = pg_catalog.now();
  else
    -- self-service: never insert; require a pre-existing eligible row
    update public.organization_live_poll_attendance
      set checked_in_at = pg_catalog.now(), check_in_actor = actor,
          rsvp = case when rsvp = 'no' then 'yes' else rsvp end,
          updated_at = pg_catalog.now()
    where poll_id = p_poll_id and user_id = actor and eligible;
    if not found then
      raise exception 'check-in required' using errcode = '42501';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('pollId', p_poll_id, 'userId', target, 'checkedIn', true);
end;
end;
$function$;

comment on function public.check_in_organization_live_poll(uuid, uuid) is
  'Live-poll check-in. A staff-executed check-in of another member grants eligible. A member self check-in requires a pre-existing eligible row and never inserts or raises eligible. The case-graph lock is the first statement of the body.';

create or replace function private.engagement_member_snapshot_scoped()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  actor_chapter text := private.current_member_chapter();
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'quarterlyGate', public.get_quarterly_survey_gate(),
    'surveys', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', survey.id,
        'title', survey.title,
        'description', survey.description,
        'cadence', survey.cadence,
        'periodKey', survey.period_key,
        'opensAt', survey.opens_at,
        'closesAt', survey.closes_at,
        'session', case when session.id is null then null else pg_catalog.jsonb_build_object(
          'id', session.id, 'status', session.status,
          'updatedAt', session.updated_at, 'submittedAt', session.submitted_at,
          'answers', coalesce((
            select pg_catalog.jsonb_object_agg(answer.question_id::text, answer.value)
            from public.organization_survey_answers answer
            where answer.session_id = session.id and answer.organization_id = org
          ), '{}'::jsonb)
        ) end,
        'questions', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', question.id, 'sortIndex', question.sort_index,
            'type', question.question_type, 'label', question.label,
            'required', question.required, 'options', question.options,
            'sectionKey', question.section_key, 'sectionTitle', question.section_title,
            'branchParentId', question.branch_parent_id, 'branchValue', question.branch_value,
            'scaleMinLabel', question.scale_min_label, 'scaleMaxLabel', question.scale_max_label,
            'maxSelections', question.max_selections
          ) order by question.sort_index)
          from public.organization_survey_questions question
          where question.survey_id = survey.id and question.organization_id = org
        ), '[]'::jsonb)
      ) order by survey.closes_at nulls last, survey.updated_at desc)
      from public.organization_surveys survey
      left join public.organization_survey_sessions session
        on session.survey_id = survey.id and session.respondent_user_id = actor
      where survey.organization_id = org
        and survey.status = 'open'
        and (survey.chapter_id is null or survey.chapter_id = actor_chapter)
        and (survey.opens_at is null or survey.opens_at <= pg_catalog.now())
        and (survey.closes_at is null or survey.closes_at > pg_catalog.now())
    ), '[]'::jsonb),
    'pulsePrompts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', event.id, 'promptId', prompt.id,
        'eventKey', prompt.event_key, 'question', prompt.question,
        'options', prompt.options, 'contextKey', event.context_key,
        'shownAt', event.shown_at
      ) order by event.shown_at desc)
      from public.organization_pulse_events event
      join public.organization_pulse_prompts prompt on prompt.id = event.prompt_id
      where event.organization_id = org and event.user_id = actor and event.state = 'shown'
    ), '[]'::jsonb),
    'livePolls', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', poll.id, 'title', poll.title, 'description', poll.description,
        'state', poll.state, 'eligibility', poll.eligibility,
        'resultsVisibility', poll.results_visibility,
        'scheduledAt', poll.scheduled_at, 'opensAt', poll.opens_at,
        'closesAt', poll.closes_at, 'closedAt', poll.closed_at,
        'quorumTarget', poll.quorum_target, 'voteCount', poll.vote_count,
        'results', case
          when poll.results_visibility = 'live'
            or (poll.results_visibility = 'after_close' and poll.state = 'closed')
            then poll.result_cache else '[]'::jsonb end,
        'options', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', option.id, 'label', option.label, 'sortIndex', option.sort_index
          ) order by option.sort_index)
          from public.organization_live_poll_options option where option.poll_id = poll.id
        ), '[]'::jsonb),
        'attendance', case when attendance.user_id is null then null else pg_catalog.jsonb_build_object(
          'eligible', attendance.eligible, 'rsvp', attendance.rsvp,
          'checkedInAt', attendance.checked_in_at
        ) end,
        'canCheckIn', poll.eligibility = 'roster'
          and poll.state = 'open'
          and coalesce(attendance.eligible, false)
          and attendance.checked_in_at is null,
        'selectedOptionId', vote.option_id
      ) order by coalesce(poll.opens_at, poll.scheduled_at, poll.created_at) desc)
      from public.organization_live_polls poll
      left join public.organization_live_poll_attendance attendance
        on attendance.poll_id = poll.id and attendance.user_id = actor
      left join public.organization_live_poll_votes vote
        on vote.poll_id = poll.id and vote.voter_user_id = actor
      where poll.organization_id = org
        and poll.state in ('scheduled', 'open', 'closed')
        and (poll.chapter_id is null or poll.chapter_id = actor_chapter)
        and (poll.closed_at is null or poll.closed_at >= pg_catalog.now() - interval '90 days')
    ), '[]'::jsonb),
    'workspace', coalesce((
      select pg_catalog.jsonb_build_object(
        'moduleOrder', preference.module_order,
        'hiddenModules', preference.hidden_modules,
        'updatedAt', preference.updated_at
      )
      from public.compass_workspace_preferences preference
      where preference.organization_id = org and preference.user_id = actor
    ), pg_catalog.jsonb_build_object(
      'moduleOrder', '["inbox","surveys","tasks","cases"]'::jsonb,
      'hiddenModules', '[]'::jsonb
    )),
    'actions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', action.id, 'actionKind', action.action_kind,
        'sourceKind', action.source_kind, 'sourceId', action.source_id,
        'title', action.title, 'state', action.state,
        'resultTaskId', action.result_task_id, 'createdAt', action.created_at
      ) order by action.created_at desc)
      from public.compass_workspace_actions action
      where action.organization_id = org and action.actor_user_id = actor
        and action.state in ('proposed', 'failed')
    ), '[]'::jsonb),
    'briefings', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', briefing.id, 'sourceKind', briefing.source_kind,
        'targetId', briefing.target_id, 'summary', briefing.summary,
        'actionItems', briefing.action_items, 'createdAt', briefing.created_at
      ) order by briefing.created_at desc)
      from (
        select * from public.compass_message_briefings saved
        where saved.organization_id = org and saved.requested_by = actor
        order by saved.created_at desc limit 10
      ) briefing
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function private.engagement_member_snapshot_scoped()
  from public, anon, authenticated, service_role;

comment on function private.engagement_member_snapshot_scoped() is
  'Tenant-scoped member engagement snapshot. canCheckIn is true only for an open meeting-roster poll when the caller already holds a staff-granted eligible attendance row and has not checked in.';

notify pgrst, 'reload schema';

commit;
