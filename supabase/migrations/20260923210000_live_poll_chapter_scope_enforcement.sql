-- SEC-UG-LIVE-POLL-CHAPTER-SCOPE-UNENFORCED-20260920
--
-- public.save_organization_live_poll accepted eligibility = 'chapter' while
-- taking chapter_id only from a payload key no authoring surface sent, so a
-- Chapter-scope poll persisted with no chapter and stayed organization-wide.
-- Edits also wrote that payload-derived (often null) chapter unconditionally.
--
-- Disposition of already-stored Chapter-scope rows with a null chapter_id:
-- they keep the organization-wide reach they have today. This migration does
-- not backfill or narrow those rows. A later edit that does not change the
-- scope and does not supply chapterId also leaves them unchanged.
--
-- New and edited Chapter-scope saves must resolve a specific same-organization
-- chapter (payload chapterId, then the stored chapter on edit, then the
-- caller's own chapter) or are refused.
--
-- Organization and roster eligibility store no chapter. Editing a chapter-scoped
-- draft or scheduled poll to roster clears the leftover chapter so the member
-- snapshot and vote RPC do not reject other-chapter roster members first.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.save_organization_live_poll(p_poll jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  poll_id uuid := nullif(p_poll ->> 'id', '')::uuid;
  payload_has_chapter boolean := pg_catalog.jsonb_exists(p_poll, 'chapterId');
  payload_chapter text := nullif(pg_catalog.btrim(coalesce(p_poll ->> 'chapterId', '')), '');
  options jsonb := coalesce(p_poll -> 'options', '[]'::jsonb);
  saved public.organization_live_polls%rowtype;
  resolved_eligibility text;
  chapter text;
begin
  perform private.engagement_require_staff(org);
  if payload_chapter is not null and not private.mi1_w2_same_org_chapter(org, payload_chapter) then
    raise exception 'chapter is not in the selected organization' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(options) <> 'array' or pg_catalog.jsonb_array_length(options) not between 2 and 10 then
    raise exception 'live polls require between 2 and 10 options' using errcode = '22023';
  end if;
  if poll_id is null then
    resolved_eligibility := coalesce(nullif(p_poll ->> 'eligibility', ''), 'organization');
    if resolved_eligibility = 'chapter' then
      chapter := coalesce(payload_chapter, private.current_member_chapter());
      if chapter is null then
        raise exception using
          errcode = '22023',
          message = 'chapter scope requires a specific chapter';
      end if;
      if not private.mi1_w2_same_org_chapter(org, chapter) then
        raise exception 'chapter is not in the selected organization' using errcode = '42501';
      end if;
    else
      chapter := null;
    end if;
    insert into public.organization_live_polls (
      organization_id, chapter_id, title, description, eligibility,
      results_visibility, scheduled_at, opens_at, closes_at, quorum_target, created_by
    ) values (
      org, chapter, pg_catalog.btrim(coalesce(p_poll ->> 'title', '')),
      pg_catalog.btrim(coalesce(p_poll ->> 'description', '')),
      resolved_eligibility,
      coalesce(nullif(p_poll ->> 'resultsVisibility', ''), 'after_close'),
      nullif(p_poll ->> 'scheduledAt', '')::timestamptz,
      nullif(p_poll ->> 'opensAt', '')::timestamptz,
      nullif(p_poll ->> 'closesAt', '')::timestamptz,
      nullif(p_poll ->> 'quorumTarget', '')::integer,
      (select auth.uid())
    ) returning * into saved;
  else
    select * into saved from public.organization_live_polls
    where id = poll_id and organization_id = org for update;
    if not found then raise exception 'not found' using errcode = 'P0002'; end if;
    if saved.state not in ('draft', 'scheduled') then
      raise exception 'an active or closed poll cannot be edited' using errcode = '55000';
    end if;
    resolved_eligibility := coalesce(nullif(p_poll ->> 'eligibility', ''), saved.eligibility);
    if resolved_eligibility in ('organization', 'roster') then
      chapter := null;
    elsif payload_has_chapter or resolved_eligibility is distinct from saved.eligibility then
      chapter := coalesce(payload_chapter, saved.chapter_id, private.current_member_chapter());
      if resolved_eligibility = 'chapter' and chapter is null then
        raise exception using
          errcode = '22023',
          message = 'chapter scope requires a specific chapter';
      end if;
      if chapter is not null and not private.mi1_w2_same_org_chapter(org, chapter) then
        raise exception 'chapter is not in the selected organization' using errcode = '42501';
      end if;
    else
      chapter := saved.chapter_id;
    end if;
    update public.organization_live_polls
    set chapter_id = case
          when resolved_eligibility in ('organization', 'roster') then null
          when payload_has_chapter or resolved_eligibility is distinct from saved.eligibility then chapter
          else saved.chapter_id
        end,
        title = pg_catalog.btrim(coalesce(p_poll ->> 'title', '')),
        description = pg_catalog.btrim(coalesce(p_poll ->> 'description', '')),
        eligibility = resolved_eligibility,
        results_visibility = coalesce(nullif(p_poll ->> 'resultsVisibility', ''), results_visibility),
        scheduled_at = nullif(p_poll ->> 'scheduledAt', '')::timestamptz,
        opens_at = nullif(p_poll ->> 'opensAt', '')::timestamptz,
        closes_at = nullif(p_poll ->> 'closesAt', '')::timestamptz,
        quorum_target = nullif(p_poll ->> 'quorumTarget', '')::integer,
        updated_at = pg_catalog.now()
    where id = saved.id returning * into saved;
    delete from public.organization_live_poll_options option where option.poll_id = saved.id;
  end if;
  insert into public.organization_live_poll_options (
    organization_id, poll_id, label, sort_index
  )
  select org, saved.id,
    pg_catalog.btrim(case when pg_catalog.jsonb_typeof(item.value) = 'string' then item.value #>> '{}' else item.value ->> 'label' end),
    item.ordinality::integer - 1
  from pg_catalog.jsonb_array_elements(options) with ordinality item(value, ordinality);
  perform private.mi1_w2_write_audit(org, 'survey_draft_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'runId', saved.id, 'status', saved.state,
    'reasonCode', 'live_poll_saved', 'count', pg_catalog.jsonb_array_length(options)
  ));
  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'title', saved.title, 'state', saved.state,
    'scheduledAt', saved.scheduled_at, 'opensAt', saved.opens_at,
    'closesAt', saved.closes_at, 'eligibility', saved.eligibility,
    'resultsVisibility', saved.results_visibility,
    'chapterId', saved.chapter_id
  );
end;
end;
$function$;

revoke all on function public.save_organization_live_poll(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.save_organization_live_poll(jsonb) to authenticated;

comment on function public.save_organization_live_poll(jsonb) is
  'Staff live-poll save. Chapter eligibility requires a resolved same-organization chapter; organization and roster eligibility store no chapter. Existing Chapter-scope rows with a null chapter are left as they are.';

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
        'reviewCounts', coalesce((
          select pg_catalog.jsonb_object_agg(counts.state, counts.count)
          from (
            select review.state, pg_catalog.count(*)::integer as count
            from public.organization_survey_reviews review
            where review.survey_id = survey.id group by review.state
          ) counts
        ), '{}'::jsonb),
        'reviews', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', review.id, 'sessionId', review.session_id,
            'state', review.state, 'assignedTo', review.assigned_to,
            'disposition', review.disposition,
            'followUpDueAt', review.follow_up_due_at,
            'createdAt', review.created_at
          ) order by review.created_at desc)
          from public.organization_survey_reviews review
          where review.survey_id = survey.id
        ), '[]'::jsonb),
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
      from public.organization_surveys survey where survey.organization_id = org
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
