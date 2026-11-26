-- BUG-UG-WEB-ENGAGEMENT-SURVEYS-UNPAGED-20261002
-- BUG-UG-WEB-ENGAGEMENT-CHANNEL-CARDS-OMIT-CHAPTER-20261002
--
-- get_staff_engagement_snapshot (last emitted by 20261002015000) returned
-- every survey of the organization, each with its coverage counts, tasks,
-- review rows and questions, ordered by updated_at; the Surveys tab then drew
-- every one as a full card (420 surveys made a 130,000px page). Its channel
-- projection carried only the space id and name, so the 20 chapters' copies
-- of the same four spaces were 80 identical cards and staff could not tell
-- which chapter a control changes.
--
-- This migration:
--   * adds private.staff_engagement_survey_page(org, status, after, limit):
--     one bounded page (1..100, default 20) of the organization's surveys in
--     the order staff work them (open, then draft, then closed; newest first
--     inside each), the keyset cursor of the next page, and the
--     organization's survey counts by status. Each survey's projection is the
--     one 20261002015000 emitted, unchanged, including the review-lane
--     privacy floor;
--   * adds public.get_staff_engagement_surveys(status, after, limit), the
--     staff read of further pages behind the same staff gate as the snapshot;
--   * re-emits get_staff_engagement_snapshot with only two changes: 'surveys'
--     is the first page of that read (with 'surveyCounts' and
--     'surveyCursor' beside it), and each channel carries 'chapterId' and
--     'chapterName' and is ordered by chapter, then space name.
-- Nothing else in the snapshot changes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function private.staff_engagement_survey_page(
  p_organization_id uuid,
  p_status text,
  p_after jsonb,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  page_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  after_rank integer;
  after_updated_at timestamptz;
  after_id uuid;
  page_ids uuid[];
  has_more boolean;
  next_cursor jsonb;
  surveys jsonb;
  counts jsonb;
begin
  if p_status is not null and p_status not in ('draft', 'open', 'closed') then
    raise exception 'unknown survey status' using errcode = '22023';
  end if;
  if p_after is not null then
    begin
      after_rank := (p_after ->> 'rank')::integer;
      after_updated_at := (p_after ->> 'updatedAt')::timestamptz;
      after_id := (p_after ->> 'id')::uuid;
    exception when others then
      raise exception 'invalid survey cursor' using errcode = '22023';
    end;
    if after_rank is null or after_updated_at is null or after_id is null then
      raise exception 'invalid survey cursor' using errcode = '22023';
    end if;
  end if;

  with ranked as (
    select survey.id, survey.updated_at,
      case survey.status when 'open' then 0 when 'draft' then 1 else 2 end as status_rank
    from public.organization_surveys survey
    where survey.organization_id = p_organization_id
      and (p_status is null or survey.status = p_status)
  ), window_rows as (
    select ranked.id, ranked.updated_at, ranked.status_rank,
      pg_catalog.row_number() over (order by ranked.status_rank, ranked.updated_at desc, ranked.id desc) as position
    from ranked
    where after_rank is null
       or ranked.status_rank > after_rank
       or (ranked.status_rank = after_rank and (ranked.updated_at, ranked.id) < (after_updated_at, after_id))
    order by ranked.status_rank, ranked.updated_at desc, ranked.id desc
    limit page_limit + 1
  )
  select
    coalesce(pg_catalog.array_agg(window_rows.id order by window_rows.position) filter (where window_rows.position <= page_limit), '{}'::uuid[]),
    pg_catalog.count(*) > page_limit,
    (pg_catalog.array_agg(pg_catalog.jsonb_build_object(
      'rank', window_rows.status_rank, 'updatedAt', window_rows.updated_at, 'id', window_rows.id
    )) filter (where window_rows.position = page_limit))[1]
  into page_ids, has_more, next_cursor
  from window_rows;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
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
  ) order by page.position), '[]'::jsonb)
  into surveys
  from pg_catalog.unnest(page_ids) with ordinality as page(id, position)
  join public.organization_surveys survey
    on survey.id = page.id and survey.organization_id = p_organization_id
  cross join lateral (
    select private.organization_survey_review_lane(p_organization_id, survey.id) as value
  ) lane;

  select pg_catalog.jsonb_build_object(
    'all', pg_catalog.count(*),
    'open', pg_catalog.count(*) filter (where survey.status = 'open'),
    'draft', pg_catalog.count(*) filter (where survey.status = 'draft'),
    'closed', pg_catalog.count(*) filter (where survey.status = 'closed')
  )
  into counts
  from public.organization_surveys survey
  where survey.organization_id = p_organization_id;

  return pg_catalog.jsonb_build_object(
    'surveys', surveys,
    'nextCursor', case when has_more then next_cursor else null end,
    'counts', counts,
    'status', p_status,
    'limit', page_limit
  );
end;
$function$;

revoke all on function private.staff_engagement_survey_page(uuid, text, jsonb, integer)
  from public, anon, authenticated, service_role;

comment on function private.staff_engagement_survey_page(uuid, text, jsonb, integer) is
  'One bounded page (1..100) of an organization''s surveys for the staff engagement workspace: open, then draft, then closed, newest first inside each, with the keyset cursor of the next page and the organization''s survey counts by status. Callers must have passed private.engagement_require_staff for the same organization.';

create function public.get_staff_engagement_surveys(
  p_status text default null,
  p_after jsonb default null,
  p_limit integer default 20
)
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
  return private.staff_engagement_survey_page(org, p_status, p_after, p_limit);
end;
$function$;

revoke all on function public.get_staff_engagement_surveys(text, jsonb, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_staff_engagement_surveys(text, jsonb, integer) to authenticated;

comment on function public.get_staff_engagement_surveys(text, jsonb, integer) is
  'Staff engagement survey pages after the snapshot''s first page: optional status filter (draft, open, closed), keyset cursor from the previous page, page size 1..100. Same staff gate and organization as get_staff_engagement_snapshot.';

-- Re-emitted from 20261002015000_survey_review_privacy_floor_and_signin_throttle.sql.
-- Only 'surveys' (now the first page, with 'surveyCounts' and 'surveyCursor')
-- and 'channels' (now with the chapter, ordered by chapter) change.
create or replace function public.get_staff_engagement_snapshot()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  survey_page jsonb;
begin
  perform private.engagement_require_staff(org);
  survey_page := private.staff_engagement_survey_page(org, null, null, 20);
  return pg_catalog.jsonb_build_object(
    'surveys', survey_page -> 'surveys',
    'surveyCounts', survey_page -> 'counts',
    'surveyCursor', survey_page -> 'nextCursor',
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
        'chapterId', chapter.id, 'chapterName', chapter.name,
        'postingMode', coalesce(control.posting_mode, 'members'),
        'slowModeSeconds', coalesce(control.slow_mode_seconds, 0),
        'approvalsRequired', coalesce(control.approvals_required, false)
      ) order by chapter.order_index, chapter.name, chapter.id, space.name, space.id)
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
