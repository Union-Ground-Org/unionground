-- REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001 (clean-room
-- parity CR-012/CR-013) and REQ-UG-LIVE-POLL-SCHEDULED-OPEN-CLOSE-20261001
-- (CR-015), restore-everything VOICE.
--
-- 1. Weekly question priority slot. promote_weekly_question() spent a
--    member's "priority-wq-slot" reward, but neither selection run read
--    member_weekly_question_promotions, so the reward bought nothing. The old
--    app (git ref de7df4b57c^, app/dashboard/polls/actions.ts:240-242 and
--    311-321) put a priority submission ahead of the draw: the first one
--    promoted wins the slot. Both runs now reserve promoted questions first,
--    oldest promotion first, then fill the remaining slots by the rule.
--    Switch features.engagement_voice.weekly_question_priority_slot (default
--    ON: the old app had no flag and honored the reward whenever it was
--    active). Off: the draw ignores promotions, promote_weekly_question()
--    refuses before spending a reward, and list_weekly_questions() reports no
--    promotion available, so the member's button is disabled honestly.
--
-- 2. Weighted random draw. The old draw (actions.ts:266-279) picked at random
--    with weight 1 + boosts, so support shifts the odds without guaranteeing a
--    winner. weekly_question_selection_policies.priority_rule gains
--    'weighted_random' and it becomes the default for new policies (the old
--    app had no other rule). 'support_then_oldest' stays available in the same
--    staff control. The draw is reproducible for audit: each run draws a
--    random seed (recorded as the run's runId in the audit event, in the
--    policy's last_result and in the manual run's receipt) and orders the
--    pool by the Efraimidis-Spirakis key ln(u)/w, u = md5(seed || question id)
--    mapped into (0, 1), w = 1 + support score. Re-running that ordering with
--    the recorded seed reproduces the selection.
--
-- 3. Scheduled live polls. Old app/api/cron/poll-close (every 15 minutes)
--    closed expired polls; the current transition RPC is manual only and
--    closes_at only blocked votes, so "after close" results never appeared
--    until someone pressed Close. private.run_due_live_poll_transitions()
--    runs every minute from pg_cron: a scheduled poll opens at its start time
--    and an open poll closes at its close time (a scheduled poll whose window
--    already passed closes without opening). Each transition writes the same
--    state, timestamps, result recalculation and live_poll_transitioned audit
--    event as the manual transition, attributed to the poll's author, so the
--    member snapshot's after-close results and the realtime refresh behave
--    exactly as after a manual close. Switch
--    features.engagement_voice.live_poll_auto_open_close (default ON, the old
--    cron ran for every organization). Off: staff open and close by hand.
--
-- Boundaries kept: every writer takes the case-graph entry lock first; no
-- grant widens; the scheduler is private and revoked from every client role;
-- tenant scope comes from the stored row, never from input. Production stays
-- empty: the only rows written are platform setting definitions.

begin;

set local lock_timeout = '5s';

-- Old defaults: no flag existed for either behavior (actions.ts:240-242 honored
-- an active priority-wq-slot reward; the poll-close cron ran unconditionally),
-- so both start ON.
insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.engagement_voice.weekly_question_priority_slot', 'boolean', 'Weekly question priority slot',
   'A member''s priority reward places their question ahead of the weekly draw. Off: promotions are refused and the draw ignores them.',
   'true', null, null, null, 20, 'engagement_voice', true),
  ('features.engagement_voice.live_poll_auto_open_close', 'boolean', 'Live polls open and close on schedule',
   'Scheduled live polls open at their start time and open polls close at their close time, checked every minute. Off: staff open and close polls by hand.',
   'true', null, null, null, 30, 'engagement_voice', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Weekly question selection
-- ---------------------------------------------------------------------------

alter table public.weekly_question_selection_policies
  drop constraint weekly_question_selection_policies_priority_rule_check;
alter table public.weekly_question_selection_policies
  add constraint weekly_question_selection_policies_priority_rule_check
    check (priority_rule in ('weighted_random', 'support_then_oldest'));
alter table public.weekly_question_selection_policies
  alter column priority_rule set default 'weighted_random';

-- Efraimidis-Spirakis weighted sampling key. u comes from the first 52 bits of
-- md5(seed:question), shifted off zero; a larger ln(u)/w wins.
create function private.weekly_question_draw_key(p_seed uuid, p_question_id uuid, p_weight integer)
returns double precision
language sql
immutable
set search_path = ''
as $function$
  select pg_catalog.ln(
    ((('x' || pg_catalog.lpad(pg_catalog.substr(pg_catalog.md5(p_seed::text || ':' || p_question_id::text), 1, 13), 16, '0'))::bit(64)::bigint)::double precision + 0.5)
    / 4503599627370496.0
  ) / greatest(coalesce(p_weight, 1), 1)::double precision
$function$;

revoke all on function private.weekly_question_draw_key(uuid, uuid, integer)
  from public, anon, authenticated, service_role;

-- Reserves up to p_count submitted questions of one chapter: promoted
-- questions first (when the priority slot is on), then the rule's order.
-- Callers have already authorized the chapter and checked the pool minimum.
create function private.reserve_weekly_questions(
  p_organization_id uuid,
  p_chapter_id text,
  p_rule text,
  p_count integer,
  p_seed uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  priority_enabled boolean;
  reserved_ids uuid[];
  priority_ids uuid[];
begin
  priority_enabled := private.organization_feature_enabled(
    p_organization_id, 'features.engagement_voice.weekly_question_priority_slot'
  );
  with candidates as (
    select question.id, question.created_at,
      coalesce((select pg_catalog.sum(case
        when private.member_reward_effect_enabled_in_organization(p_organization_id, support.user_id, 'wq-boost-2x') then 2 else 1 end)
        from public.member_weekly_question_supports support
        where support.question_id = question.id), 0)::integer as support_score,
      case when priority_enabled then (
        select promotion.promoted_at from public.member_weekly_question_promotions promotion
        where promotion.question_id = question.id
      ) end as promoted_at
    from public.member_weekly_questions question
    where question.chapter_id = p_chapter_id and question.editorial_state = 'submitted'
  ), ranked as (
    select candidate.id, candidate.promoted_at
    from candidates candidate
    join public.member_weekly_questions question on question.id = candidate.id
    order by (candidate.promoted_at is null), candidate.promoted_at,
      case when p_rule = 'weighted_random'
        then private.weekly_question_draw_key(p_seed, candidate.id, 1 + candidate.support_score) end desc nulls last,
      candidate.support_score desc, candidate.created_at asc, candidate.id asc
    for update of question skip locked
    limit greatest(p_count, 0)
  ), changed as (
    update public.member_weekly_questions question
    set editorial_state = 'reserved', updated_at = pg_catalog.now()
    from ranked where question.id = ranked.id
    returning question.id, ranked.promoted_at
  )
  select coalesce(pg_catalog.array_agg(changed.id order by changed.id), '{}'::uuid[]),
    coalesce(pg_catalog.array_agg(changed.id order by changed.id) filter (where changed.promoted_at is not null), '{}'::uuid[])
  into reserved_ids, priority_ids from changed;
  return pg_catalog.jsonb_build_object(
    'selectedIds', pg_catalog.to_jsonb(reserved_ids),
    'selectedCount', pg_catalog.cardinality(reserved_ids),
    'priorityIds', pg_catalog.to_jsonb(priority_ids),
    'rule', p_rule,
    'seed', p_seed,
    'prioritySlot', priority_enabled
  );
end;
end;
$function$;

revoke all on function private.reserve_weekly_questions(uuid, text, text, integer, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.promote_weekly_question(p_question_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  current_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date;
  grant_id uuid;
begin
  if caller is null or caller_chapter is null or caller_org is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  -- REQ-UG-WEEKLY-QUESTION-PRIORITY-AND-WEIGHTED-DRAW-20261001: refuse
  -- before a reward is spent when the organization turned the slot off.
  if not private.organization_feature_enabled(caller_org, 'features.engagement_voice.weekly_question_priority_slot') then
    raise exception 'weekly question priority is turned off' using errcode = '55000';
  end if;

  perform 1
  from public.member_weekly_questions q
  where q.id = p_question_id
    and q.user_id = caller
    and q.chapter_id = caller_chapter
    and q.week_start = current_week
    and q.editorial_state in ('submitted', 'reserved')
  for update;
  if not found then
    raise exception 'only your available question can be promoted' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.member_weekly_question_promotions p
    where p.question_id = p_question_id
  ) then
    return pg_catalog.jsonb_build_object('questionId', p_question_id, 'promoted', false, 'alreadyPromoted', true);
  end if;

  select g.id into grant_id
  from public.member_reward_grants g
  join public.member_reward_items i on i.key = g.item_key and i.active
  where g.organization_id = caller_org
    and g.user_id = caller
    and g.item_key = 'priority-wq-slot'
    and g.status in ('granted','shipped','delivered')
    and not exists (
      select 1 from public.member_weekly_question_promotions used
      where used.reward_grant_id = g.id
    )
  order by g.created_at, g.id
  limit 1
  for update of g;

  if grant_id is null then
    raise exception 'no unused promotion entitlement' using errcode = '22023';
  end if;

  insert into public.member_weekly_question_promotions (
    question_id, reward_grant_id, organization_id, chapter_id, user_id
  ) values (p_question_id, grant_id, caller_org, caller_chapter, caller);

  return pg_catalog.jsonb_build_object(
    'questionId', p_question_id,
    'promoted', true,
    'promotionCredits', 0
  );
end;
end;
$function$;

create or replace function public.list_weekly_questions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_chapter text := private.current_member_chapter();
  caller_org uuid := private.current_member_organization();
  current_week date := pg_catalog.date_trunc('week', pg_catalog.now() at time zone 'UTC')::date;
  promotion_available boolean;
begin
  if caller is null or caller_chapter is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select caller_org is not null
    and private.organization_feature_enabled(caller_org, 'features.engagement_voice.weekly_question_priority_slot')
    and exists (
    select 1
    from public.member_reward_grants g
    join public.member_reward_items i on i.key = g.item_key and i.active
    where g.organization_id = caller_org
      and g.user_id = caller
      and g.item_key = 'priority-wq-slot'
      and g.status in ('granted','shipped','delivered')
      and not exists (
        select 1 from public.member_weekly_question_promotions used
        where used.reward_grant_id = g.id
      )
  ) into promotion_available;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', ranked.id,
      'body', ranked.body,
      'options', ranked.options,
      'editorialState', ranked.editorial_state,
      'submittedByMe', ranked.user_id = caller,
      'boostedByMe', ranked.boosted_by_me,
      'promotedByMe', ranked.user_id = caller and ranked.priority,
      'promotionAvailable', promotion_available,
      'priority', ranked.priority,
      'score', ranked.score,
      'createdAt', ranked.created_at
    ) order by ranked.priority desc, ranked.score desc, ranked.created_at, ranked.id)
    from (
      select q.id, q.user_id, q.body, q.options, q.editorial_state, q.created_at,
        exists (
          select 1 from public.member_weekly_question_promotions p
          where p.question_id = q.id
        ) as priority,
        exists (
          select 1 from public.member_weekly_question_supports mine
          where mine.question_id = q.id and mine.user_id = caller
        ) as boosted_by_me,
        coalesce((
          select pg_catalog.sum(case
            when private.member_reward_effect_enabled(s.user_id, 'wq-boost-2x') then 2 else 1 end)::integer
          from public.member_weekly_question_supports s where s.question_id = q.id
        ), 0) as score
      from public.member_weekly_questions q
      where q.chapter_id = caller_chapter
        and q.week_start = current_week
        and q.editorial_state in ('submitted', 'reserved', 'published')
      order by priority desc, score desc, q.created_at, q.id
      limit 25
    ) ranked
  ), '[]'::jsonb);
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
     or p_priority_rule is null
     or p_priority_rule not in ('weighted_random', 'support_then_oldest') then
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
    'cadence', p_cadence_days::text, 'count', p_selection_count,
    'reasonCode', p_priority_rule
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
  draw jsonb;
  draw_seed uuid := extensions.gen_random_uuid();
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
  draw := private.reserve_weekly_questions(org, chapter, policy.priority_rule, policy.selection_count, draw_seed);
  result := draw || pg_catalog.jsonb_build_object('poolCount', pool_count, 'ranAt', pg_catalog.now());
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
    'reasonCode', 'manual', 'count', (draw ->> 'selectedCount')::integer,
    'kind', policy.priority_rule, 'runId', draw_seed
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
  draw jsonb;
  draw_seed uuid;
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
    draw_seed := extensions.gen_random_uuid();
    if pool_count >= target.minimum_pool_size then
      draw := private.reserve_weekly_questions(
        target.organization_id, target.chapter_id, target.priority_rule, target.selection_count, draw_seed
      );
    else
      draw := pg_catalog.jsonb_build_object(
        'selectedIds', '[]'::jsonb, 'selectedCount', 0, 'priorityIds', '[]'::jsonb,
        'rule', target.priority_rule, 'seed', draw_seed
      );
    end if;
    result := draw || pg_catalog.jsonb_build_object(
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
          'count', (draw ->> 'selectedCount')::integer,
          'kind', target.priority_rule, 'runId', draw_seed
        )
      );
    end if;
    processed := processed + 1;
    reserved := reserved + (draw ->> 'selectedCount')::integer;
  end loop;
  return pg_catalog.jsonb_build_object('processed', processed, 'reserved', reserved);
end;
end;
$function$;

create or replace function public.get_weekly_question_selection_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.engagement_selected_organization();
  chapter text := private.current_member_chapter();
  page jsonb;
begin
  perform private.engagement_require_weekly_selection_staff(org, chapter);
  if chapter is null or not private.mi1_w2_same_org_chapter(org, chapter) then
    raise exception 'chapter context required' using errcode = '42501';
  end if;
  page := public.list_weekly_question_selection_page('active', null, null, 26);
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'chapterId', chapter,
    'policy', coalesce((
      select pg_catalog.to_jsonb(policy) - 'organization_id' - 'chapter_id' - 'updated_by'
      from public.weekly_question_selection_policies policy
      where policy.organization_id = org and policy.chapter_id = chapter
    ), pg_catalog.jsonb_build_object(
      'enabled', false, 'cadence_days', 7, 'minimum_pool_size', 3,
      'selection_count', 1, 'priority_rule', 'weighted_random'
    )),
    'prioritySlot', private.organization_feature_enabled(org, 'features.engagement_voice.weekly_question_priority_slot'),
    'items', coalesce(page -> 'items', '[]'::jsonb),
    'nextCursor', page -> 'nextCursor'
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Scheduled live poll open / close
-- ---------------------------------------------------------------------------

create index if not exists organization_live_polls_schedule_due_idx
  on public.organization_live_polls (state, opens_at, closes_at)
  where state in ('scheduled', 'open');

create function private.run_due_live_poll_transitions(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  cap integer := coalesce(p_limit, 200);
  poll public.organization_live_polls%rowtype;
  next_state text;
  transition_action text;
  opened integer := 0;
  closed integer := 0;
begin
  if cap not between 1 and 1000 then
    raise exception 'invalid live poll scheduler limit' using errcode = '22023';
  end if;
  for poll in
    select candidate.*
    from public.organization_live_polls candidate
    where (
        candidate.state = 'scheduled'
        and (
          (candidate.opens_at is not null and candidate.opens_at <= pg_catalog.now())
          or (candidate.closes_at is not null and candidate.closes_at <= pg_catalog.now())
        )
      ) or (
        candidate.state = 'open'
        and candidate.closes_at is not null and candidate.closes_at <= pg_catalog.now()
      )
    order by coalesce(candidate.closes_at, candidate.opens_at), candidate.id
    for update skip locked
    limit cap
  loop
    if not private.organization_feature_enabled(poll.organization_id, 'features.engagement_voice.live_poll_auto_open_close') then
      continue;
    end if;
    if poll.closes_at is not null and poll.closes_at <= pg_catalog.now() then
      next_state := 'closed';
      transition_action := 'close';
    else
      next_state := 'open';
      transition_action := 'open';
    end if;
    update public.organization_live_polls
    set state = next_state,
        opens_at = case when next_state = 'open' then coalesce(opens_at, pg_catalog.now()) else opens_at end,
        closed_at = case when next_state = 'closed' then pg_catalog.now() else null end,
        updated_at = pg_catalog.now()
    where id = poll.id returning * into poll;
    perform private.recalculate_organization_live_poll(poll.id);
    -- actor_user_id is NOT NULL: the scheduled transition is attributed to the
    -- poll's author, whose schedule authorized it. An authorless poll still
    -- transitions; it is not audited rather than failing the whole tick.
    if poll.created_by is not null then
      insert into public.organization_audit_events (
        organization_id, event_type, actor_user_id, idempotency_key, metadata
      ) values (
        poll.organization_id, 'live_poll_transitioned', poll.created_by, extensions.gen_random_uuid(),
        pg_catalog.jsonb_build_object(
          'organizationId', poll.organization_id, 'pollId', poll.id, 'userId', poll.created_by,
          'status', next_state, 'action', transition_action, 'count', poll.vote_count, 'reasonCode', 'scheduled'
        )
      );
    end if;
    if next_state = 'open' then opened := opened + 1; else closed := closed + 1; end if;
  end loop;
  return pg_catalog.jsonb_build_object('opened', opened, 'closed', closed);
end;
end;
$function$;

revoke all on function private.run_due_live_poll_transitions(integer)
  from public, anon, authenticated, service_role;

comment on function private.run_due_live_poll_transitions(integer) is
  'Bounded pg_cron target (CR-015): opens scheduled live polls at opens_at and closes open (or never-opened scheduled) polls at closes_at, per organization switch features.engagement_voice.live_poll_auto_open_close, with the manual transition''s state, result recalculation and live_poll_transitioned audit event.';

do $scheduler$
begin
  if pg_catalog.to_regnamespace('cron') is not null then
    perform cron.unschedule(jobid) from cron.job where jobname = 'live-poll-schedule-tick';
    perform cron.schedule(
      'live-poll-schedule-tick',
      '* * * * *',
      $job$select private.run_due_live_poll_transitions(200);$job$
    );
  end if;
end;
$scheduler$;

-- Monitoring: live-poll-schedule-tick joins the four copies of the monitored
-- set (the job-name CHECK, the mirror's jobname allow-list, the
-- list_organization_job_health() catalog, and PRODUCT_JOBS in
-- src/features/operations/jobRegistry.js). The three database copies are
-- re-emitted from 20260930040000 with only that name added.

alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'account-deletion-reconcile-tick', 'appointment-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
    'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
    'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
    'event-checkin-token-retention',
    'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'live-poll-schedule-tick',
    'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
    'mi1-analytics-receipt-retention',
    'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
    'notifications-expiry-sweep',
    'organization-claim-retention',
    'organization-automation-tick',
    'task-files-reconcile-tick', 'task-maintenance-daily',
    'union-ground-organization-retention', 'weekly-question-selection-tick',
    'workload-reminders-tick'
  ));

create or replace function private.sync_organization_job_runs_from_cron_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  changed_count integer;
  window_start timestamptz;
  open_runs bigint[];
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  -- Incremental window: the newest cron start already mirrored, minus a
  -- fixed two-hour look-back, bounded below by the fourteen-day floor.
  select greatest(
      coalesce(pg_catalog.max(mirrored.started_at), pg_catalog.now() - interval '14 days')
        - interval '2 hours',
      pg_catalog.now() - interval '14 days')
    into window_start
  from public.organization_job_runs mirrored
  where mirrored.organization_id is null
    and mirrored.run_id like 'cron:%';

  -- Runs still mirrored as in progress are re-read whatever their start, so a
  -- completion later than the look-back still lands.
  select coalesce(pg_catalog.array_agg(pg_catalog.substr(open_run.run_id, 6)::bigint), array[]::bigint[])
    into open_runs
  from public.organization_job_runs open_run
  where open_run.organization_id is null
    and open_run.status = 'in_progress'
    and open_run.run_id like 'cron:%';

  -- Candidates are the eligible cron rows inside the window plus the still-open
  -- runs. Only a candidate whose mirrored outcome is missing or different
  -- reaches the insert, so the BEFORE INSERT row trigger fires for new or
  -- changed runs alone; the ON CONFLICT guard remains for a concurrent tick.
  with candidate as (
    select j.jobname as job_name,
      'cron:' || d.runid::text as run_id,
      case d.status when 'succeeded' then 'completed' when 'failed' then 'failed' else 'in_progress' end as status,
      coalesce(d.start_time, pg_catalog.now()) as started_at,
      d.end_time as finished_at,
      case when d.status = 'failed' then 'cron_failed' end as failure_code,
      case when d.status = 'failed' then 'Scheduled command failed.' end as redacted_summary
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
    where j.jobname in (
      'appointment-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick', 'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'live-poll-schedule-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep',
      'organization-claim-retention',
      'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ) and (d.start_time >= window_start or d.runid = any(open_runs))
  )
  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  )
  select null, c.job_name, c.run_id, c.status, c.started_at, c.finished_at,
    c.failure_code, c.redacted_summary
  from candidate c
  left join public.organization_job_runs mirrored
    on mirrored.job_name = c.job_name
   and mirrored.run_id = c.run_id
   and mirrored.organization_id is null
  where mirrored.id is null
     or mirrored.status is distinct from c.status
     or mirrored.finished_at is distinct from c.finished_at
     or mirrored.failure_code is distinct from c.failure_code
     or mirrored.redacted_summary is distinct from c.redacted_summary
  on conflict (job_name, run_id, organization_id) do update
    set status = excluded.status, finished_at = excluded.finished_at,
        failure_code = excluded.failure_code,
        redacted_summary = excluded.redacted_summary
    where organization_job_runs.status is distinct from excluded.status
       or organization_job_runs.finished_at is distinct from excluded.finished_at
       or organization_job_runs.failure_code is distinct from excluded.failure_code
       or organization_job_runs.redacted_summary is distinct from excluded.redacted_summary;
  get diagnostics changed_count = row_count;
  return changed_count;
end;
$function$;

revoke all on function private.sync_organization_job_runs_from_cron_history()
  from public, anon, authenticated, service_role;

create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array[
      'account-deletion-reconcile-tick', 'appointment-reminders-tick',
      'ballot-choices-mix', 'ballot-choices-mix-recent', 'ballot-notices-tick',
      'casework-alert-escalation-tick', 'casework-reminder-delivery-tick',
      'deadline-notices-tick',
      'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
      'event-checkin-token-retention',
      'event-notices-tick', 'integration-webhooks-dispatch-tick',
    'live-poll-schedule-tick',
      'member-messaging-dispatch', 'mesh-agency-usage-aggregate-tick',
      'mi1-analytics-receipt-retention',
      'mi1-public-rsvp-retention', 'notifications-dispatch-tick',
      'notifications-expiry-sweep',
      'organization-claim-retention',
      'organization-automation-tick',
      'task-files-reconcile-tick', 'task-maintenance-daily',
      'union-ground-organization-retention', 'weekly-question-selection-tick',
      'workload-reminders-tick'
    ]) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

notify pgrst, 'reload schema';

commit;
