-- SEC-UG-ENGAGEMENT-AUDIT-EVENT-TAXONOMY-20260921 (part 2 of 2)
--
-- Re-emits the weekly-question and live-poll engagement writers onto the
-- operation-specific event types that 20260925120000 admitted, so no
-- engagement writer audits a non-draft operation as 'survey_draft_saved'
-- any more. The manual and scheduled weekly selections share
-- 'weekly_question_selection_run' and are told apart by reasonCode
-- ('manual' / 'scheduled'); a live-poll transition names its action.
--
-- The scheduler used to insert its audit row with a null actor into the
-- NOT NULL actor_user_id column, so every weekly-question-selection-tick
-- with a due policy raised and rolled back. The scheduled row now names the
-- policy's updated_by (the staff member whose standing policy authorized the
-- run), and a policy whose author was deleted runs without an audit row.
--
-- Each writer is re-declared from its installed definition on Main with the
-- case-graph entry lock still ahead of the declaration initializers, and the
-- three weekly-question writers keep the chapter-staff guard that
-- 20260925130200 installed; every authorization check, write and return
-- shape is unchanged. Only the audit
-- append differs: its event type, the row identifier, and the actor.

begin;

set local lock_timeout = '5s';

create or replace function public.review_weekly_poll_question(
  p_question_id uuid,
  p_editorial_state text,
  p_editor_note text default null
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
  caller_chapter text := private.current_member_chapter();
begin
  perform private.engagement_require_weekly_selection_staff(org, caller_chapter);
  if caller_chapter is null or not private.mi1_w2_same_org_chapter(org, caller_chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  if p_editorial_state not in ('submitted', 'reserved', 'archived')
     or pg_catalog.char_length(coalesce(p_editor_note, '')) > 1000 then
    raise exception 'invalid editorial decision' using errcode = '22023';
  end if;
  update public.member_weekly_questions q
  set editorial_state = p_editorial_state,
      editor_note = nullif(pg_catalog.btrim(coalesce(p_editor_note, '')), ''),
      published_survey_id = null,
      updated_at = pg_catalog.now()
  where q.id = p_question_id
    and q.chapter_id = caller_chapter
    and q.editorial_state <> 'published';
  if not found then raise exception 'editable weekly question not found' using errcode = 'P0002'; end if;
  perform private.mi1_w2_write_audit(org, 'weekly_question_reviewed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', caller_chapter, 'questionId', p_question_id,
    'userId', (select auth.uid()), 'status', p_editorial_state
  ));
  return pg_catalog.jsonb_build_object('id', p_question_id, 'editorialState', p_editorial_state);
end;
end;
$function$;

create or replace function public.save_weekly_question_selection_policy(
  p_enabled boolean,
  p_cadence_days integer,
  p_minimum_pool_size integer,
  p_selection_count integer,
  p_priority_rule text,
  p_next_run_at timestamp with time zone
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
  chapter text := private.current_member_chapter();
  effective_next_run_at timestamptz;
begin
  perform private.engagement_require_weekly_selection_staff(org, chapter);
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  if p_cadence_days not between 1 and 31
     or p_minimum_pool_size not between 1 and 100
     or p_selection_count not between 1 and 10
     or p_selection_count > p_minimum_pool_size
     or p_priority_rule <> 'support_then_oldest' then
    raise exception 'invalid weekly selection policy' using errcode = '22023';
  end if;
  effective_next_run_at := case
    when coalesce(p_enabled, false) then coalesce(
      p_next_run_at,
      pg_catalog.now() + pg_catalog.make_interval(days => p_cadence_days)
    )
    else null
  end;
  insert into public.weekly_question_selection_policies (
    organization_id, chapter_id, enabled, cadence_days, minimum_pool_size,
    selection_count, priority_rule, next_run_at, updated_by
  ) values (
    org, chapter, coalesce(p_enabled, false), p_cadence_days, p_minimum_pool_size,
    p_selection_count, p_priority_rule, effective_next_run_at, (select auth.uid())
  ) on conflict (organization_id, chapter_id) do update
    set enabled = excluded.enabled,
        cadence_days = excluded.cadence_days,
        minimum_pool_size = excluded.minimum_pool_size,
        selection_count = excluded.selection_count,
        priority_rule = excluded.priority_rule,
        next_run_at = excluded.next_run_at,
        updated_by = excluded.updated_by,
        updated_at = pg_catalog.now();
  perform private.mi1_w2_write_audit(org, 'weekly_question_policy_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'userId', (select auth.uid()),
    'status', case when p_enabled then 'enabled' else 'disabled' end,
    'cadence', p_cadence_days::text, 'count', p_selection_count
  ));
  return public.get_weekly_question_selection_workspace();
end;
end;
$function$;

create or replace function public.run_weekly_question_selection(p_idempotency_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  chapter text := private.current_member_chapter();
  policy public.weekly_question_selection_policies%rowtype;
  pool_count integer;
  reserved_ids uuid[];
  request_payload jsonb;
  prior jsonb;
  result jsonb;
begin
  perform private.engagement_require_weekly_selection_staff(org, chapter);
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter)
     or p_idempotency_key is null then
    raise exception 'invalid selection request' using errcode = '22023';
  end if;
  request_payload := pg_catalog.jsonb_build_object('chapterId', chapter);
  prior := private.member_operations_replay(org, 'weekly_question_selection', p_idempotency_key, request_payload);
  if prior is not null then return prior; end if;
  select * into policy from public.weekly_question_selection_policies
  where organization_id = org and chapter_id = chapter for update;
  if not found or not policy.enabled then
    raise exception 'weekly selection is disabled' using errcode = '55000';
  end if;
  select pg_catalog.count(*) into pool_count
  from public.member_weekly_questions question
  where question.chapter_id = chapter and question.editorial_state = 'submitted';
  if pool_count < policy.minimum_pool_size then
    raise exception 'minimum pool size not met' using errcode = '55000';
  end if;
  with ranked as (
    select question.id,
      coalesce((select pg_catalog.sum(case
        when private.member_reward_effect_enabled_in_organization(org, support.user_id, 'wq-boost-2x') then 2 else 1 end)
        from public.member_weekly_question_supports support where support.question_id = question.id), 0) as support_score,
      question.created_at
    from public.member_weekly_questions question
    where question.chapter_id = chapter and question.editorial_state = 'submitted'
    order by support_score desc, question.created_at asc, question.id asc
    for update skip locked
    limit policy.selection_count
  ), changed as (
    update public.member_weekly_questions question
    set editorial_state = 'reserved', updated_at = pg_catalog.now()
    from ranked where question.id = ranked.id
    returning question.id
  ) select coalesce(pg_catalog.array_agg(changed.id order by changed.id), '{}'::uuid[])
    into reserved_ids from changed;
  result := pg_catalog.jsonb_build_object(
    'selectedIds', pg_catalog.to_jsonb(reserved_ids), 'selectedCount', pg_catalog.cardinality(reserved_ids),
    'poolCount', pool_count, 'ranAt', pg_catalog.now()
  );
  update public.weekly_question_selection_policies
  set last_run_at = pg_catalog.now(), last_result = result,
      next_run_at = pg_catalog.now() + pg_catalog.make_interval(days => cadence_days),
      updated_by = (select auth.uid()), updated_at = pg_catalog.now()
  where organization_id = org and chapter_id = chapter;
  perform private.member_operations_store_receipt(
    org, 'weekly_question_selection', p_idempotency_key, request_payload, result
  );
  perform private.mi1_w2_write_audit(org, 'weekly_question_selection_run', pg_catalog.jsonb_build_object(
    'organizationId', org, 'chapterId', chapter, 'userId', (select auth.uid()), 'status', 'reserved',
    'reasonCode', 'manual', 'count', pg_catalog.cardinality(reserved_ids)
  ));
  return result;
end;
end;
$function$;

create or replace function private.run_due_weekly_question_selections(p_limit integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := coalesce(p_limit, 25);
  target public.weekly_question_selection_policies%rowtype;
  pool_count integer;
  selected_ids uuid[];
  result jsonb;
  processed integer := 0;
  reserved integer := 0;
begin
  if cap not between 1 and 100 then
    raise exception 'invalid weekly scheduler limit' using errcode = '22023';
  end if;
  for target in
    select policy.*
    from public.weekly_question_selection_policies policy
    where policy.enabled and policy.next_run_at is not null
      and policy.next_run_at <= pg_catalog.now()
    order by policy.next_run_at, policy.organization_id, policy.chapter_id
    for update skip locked
    limit cap
  loop
    select pg_catalog.count(*) into pool_count
    from public.member_weekly_questions question
    where question.chapter_id = target.chapter_id and question.editorial_state = 'submitted';
    selected_ids := '{}'::uuid[];
    if pool_count >= target.minimum_pool_size then
      with ranked as (
        select question.id,
          coalesce((select pg_catalog.sum(case
            when private.member_reward_effect_enabled_in_organization(target.organization_id, support.user_id, 'wq-boost-2x') then 2 else 1 end)
            from public.member_weekly_question_supports support
            where support.question_id = question.id), 0) as support_score,
          question.created_at
        from public.member_weekly_questions question
        where question.chapter_id = target.chapter_id and question.editorial_state = 'submitted'
        order by support_score desc, question.created_at asc, question.id asc
        for update skip locked
        limit target.selection_count
      ), changed as (
        update public.member_weekly_questions question
        set editorial_state = 'reserved', updated_at = pg_catalog.now()
        from ranked where question.id = ranked.id
        returning question.id
      )
      select coalesce(pg_catalog.array_agg(changed.id order by changed.id), '{}'::uuid[])
      into selected_ids from changed;
    end if;
    result := pg_catalog.jsonb_build_object(
      'selectedIds', pg_catalog.to_jsonb(selected_ids),
      'selectedCount', pg_catalog.cardinality(selected_ids),
      'poolCount', pool_count,
      'ranAt', pg_catalog.now(),
      'mode', 'scheduled',
      'reason', case when pool_count < target.minimum_pool_size then 'minimum_pool_not_met' else null end
    );
    update public.weekly_question_selection_policies
    set last_run_at = pg_catalog.now(), last_result = result,
        next_run_at = pg_catalog.now() + pg_catalog.make_interval(days => cadence_days),
        updated_at = pg_catalog.now()
    where organization_id = target.organization_id and chapter_id = target.chapter_id;
    -- actor_user_id is NOT NULL, so the scheduled row is attributed to the
    -- staff member whose standing policy authorized the run. A policy whose
    -- author was deleted still runs; it is not audited rather than failing
    -- the whole tick.
    if target.updated_by is not null then
      insert into public.organization_audit_events (
        organization_id, event_type, actor_user_id, idempotency_key, metadata
      ) values (
        target.organization_id, 'weekly_question_selection_run', target.updated_by, extensions.gen_random_uuid(),
        pg_catalog.jsonb_build_object(
          'organizationId', target.organization_id, 'chapterId', target.chapter_id,
          'userId', target.updated_by, 'status', 'reserved', 'reasonCode', 'scheduled',
          'count', pg_catalog.cardinality(selected_ids)
        )
      );
    end if;
    processed := processed + 1;
    reserved := reserved + pg_catalog.cardinality(selected_ids);
  end loop;
  return pg_catalog.jsonb_build_object('processed', processed, 'reserved', reserved);
end;
end;
$function$;

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
  perform private.mi1_w2_write_audit(org, 'live_poll_saved', pg_catalog.jsonb_build_object(
    'organizationId', org, 'pollId', saved.id, 'userId', (select auth.uid()), 'status', saved.state,
    'count', pg_catalog.jsonb_array_length(options)
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

create or replace function public.transition_organization_live_poll(
  p_poll_id uuid,
  p_action text
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
  poll public.organization_live_polls%rowtype;
  next_state text;
begin
  perform private.engagement_require_staff(org);
  select * into poll from public.organization_live_polls
  where id = p_poll_id and organization_id = org for update;
  if not found then raise exception 'not found' using errcode = 'P0002'; end if;
  next_state := case p_action
    when 'schedule' then 'scheduled'
    when 'open' then 'open'
    when 'close' then 'closed'
    when 'cancel' then 'cancelled'
    when 'archive' then 'closed'
    else null
  end;
  if next_state is null then raise exception 'invalid poll action' using errcode = '22023'; end if;
  if p_action = 'schedule' and poll.state <> 'draft' then raise exception 'poll is not a draft' using errcode = '55000'; end if;
  if p_action = 'open' and poll.state not in ('draft', 'scheduled') then raise exception 'poll cannot be opened' using errcode = '55000'; end if;
  if p_action in ('close', 'archive') and poll.state <> 'open' then raise exception 'poll is not open' using errcode = '55000'; end if;
  if p_action = 'cancel' and poll.state not in ('draft', 'scheduled', 'open') then raise exception 'poll cannot be cancelled' using errcode = '55000'; end if;
  update public.organization_live_polls
  set state = next_state,
      opens_at = case when p_action = 'open' then coalesce(opens_at, pg_catalog.now()) else opens_at end,
      closed_at = case when next_state in ('closed', 'cancelled') then pg_catalog.now() else null end,
      updated_at = pg_catalog.now()
  where id = poll.id returning * into poll;
  perform private.recalculate_organization_live_poll(poll.id);
  perform private.mi1_w2_write_audit(org, 'live_poll_transitioned', pg_catalog.jsonb_build_object(
    'organizationId', org, 'pollId', poll.id, 'userId', (select auth.uid()), 'status', next_state,
    'action', p_action, 'count', poll.vote_count
  ));
  return pg_catalog.jsonb_build_object(
    'id', poll.id, 'state', next_state, 'opensAt', poll.opens_at,
    'closesAt', poll.closes_at, 'closedAt', poll.closed_at
  );
end;
end;
$function$;

revoke all on function public.review_weekly_poll_question(uuid, text, text) from public, anon, authenticated;
revoke all on function public.save_weekly_question_selection_policy(boolean, integer, integer, integer, text, timestamptz) from public, anon, authenticated;
revoke all on function public.run_weekly_question_selection(uuid) from public, anon, authenticated;
revoke all on function public.save_organization_live_poll(jsonb) from public, anon, authenticated;
revoke all on function public.transition_organization_live_poll(uuid, text) from public, anon, authenticated;
grant execute on function public.review_weekly_poll_question(uuid, text, text) to authenticated;
grant execute on function public.save_weekly_question_selection_policy(boolean, integer, integer, integer, text, timestamptz) to authenticated;
grant execute on function public.run_weekly_question_selection(uuid) to authenticated;
grant execute on function public.save_organization_live_poll(jsonb) to authenticated;
grant execute on function public.transition_organization_live_poll(uuid, text) to authenticated;
revoke execute on function public.review_weekly_poll_question(uuid, text, text) from service_role;
revoke execute on function public.save_weekly_question_selection_policy(boolean, integer, integer, integer, text, timestamptz) from service_role;
revoke execute on function public.run_weekly_question_selection(uuid) from service_role;
revoke execute on function public.save_organization_live_poll(jsonb) from service_role;
revoke execute on function public.transition_organization_live_poll(uuid, text) from service_role;
revoke all on function private.run_due_weekly_question_selections(integer) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
