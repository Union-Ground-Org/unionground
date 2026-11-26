-- REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104 (#7013). The three
-- server pieces the admin onboarding desk (#7003, #7008) could not be built
-- on:
--
-- 1. By-chapter counts. get_member_onboarding_oversight() gains
--    chapterSummary: plans grouped by the member's profile chapter inside the
--    session organization. A chapter's counts are returned only when it has
--    at least the privacy floor of plans: the organization's analytics
--    anonymity floor, never below 25. Chapters under the floor and members
--    with no chapter are pooled into otherChapters; while that pool is
--    non-empty and under the floor, the smallest shown chapter joins it, so a
--    withheld count can never be recovered by subtraction from the totals.
--    The roster rows themselves carry no chapter.
-- 2. public.send_member_onboarding_reminder(uuid, uuid). Onboarding staff
--    (the oversight roles, MFA included) send one fixed reminder to a stalled
--    member through member_notifications, the path the learning-period
--    reminders use. At most one per member per organization in any 24 hours,
--    refused for a member who turned onboarding reminders off
--    (notification_prefs.onboarding = false; absent means on), recorded in
--    public.organization_audit_ledger, and idempotent by key. The reminder
--    copy names no organization, staff member or step.
-- 3. A skip needs a reason. staff_update_member_onboarding_plan takes a
--    trailing p_reason (default null) and refuses a skip without one; the
--    reason is stored in private.member_onboarding_skip_reasons and shown
--    read-only on each roster row as skippedSteps. A reset clears them. The
--    four-argument function is dropped, so four-argument callers resolve to
--    the new one.
--
-- private.preserve_engagement_email_preferences() also keeps a stored
-- onboarding choice when an older writer (the native app) replaces
-- notification_prefs without that key, so a member's opt-out is never
-- silently reversed.
--
-- Apply order: after 20261104030000 (#7000) and 20261104071500 (#7016);
-- this migration depends on neither.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Skip reasons (RPC-only storage)
-- ---------------------------------------------------------------------------

create table private.member_onboarding_skip_reasons (
  plan_id uuid not null references public.member_onboarding_plans(id) on update cascade on delete cascade,
  step_id uuid not null references public.organization_onboarding_steps(id) on update cascade on delete cascade,
  reason text not null,
  skipped_at timestamptz not null default pg_catalog.now(),
  primary key (plan_id, step_id),
  -- Trimmed of every whitespace character at both ends (tabs, newlines and
  -- Unicode spaces too, as the browser's String.prototype.trim does), so a
  -- whitespace-only reason can never be stored.
  constraint member_onboarding_skip_reasons_reason_length check (
    pg_catalog.char_length(reason) between 1 and 500
    and reason = pg_catalog.regexp_replace(reason, '^[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')
  )
);

create index member_onboarding_skip_reasons_step_idx on private.member_onboarding_skip_reasons (step_id);

alter table private.member_onboarding_skip_reasons enable row level security;
alter table private.member_onboarding_skip_reasons force row level security;
revoke all on table private.member_onboarding_skip_reasons from public, anon, authenticated, service_role;
create policy mfa_assurance on private.member_onboarding_skip_reasons as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.member_onboarding_skip_reasons is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; staff_update_member_onboarding_plan writes it and get_member_onboarding_oversight reads it.';
-- A child of member_onboarding_plans, so it joins the account case graph. It
-- has no person or case column of its own, so the row-key gate locks nothing
-- extra; the statement gate keeps every write behind the graph lock.
create trigger a00_case_graph_lock before insert or update or delete on private.member_onboarding_skip_reasons
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_onboarding_skip_reasons
for each row execute function private.lock_case_graph_row_keys('', '');
comment on table private.member_onboarding_skip_reasons is
  'REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: the reason staff gave for skipping a step in a member''s onboarding plan. The acting staff member is in member_support_events (step_skipped); a reset deletes the plan''s rows.';

-- ---------------------------------------------------------------------------
-- 2. Shared helpers
-- ---------------------------------------------------------------------------

-- The stalled rule the roster has applied since 20261002121000, in one place
-- so the reminder RPC and the roster can never disagree.
create function private.member_onboarding_plan_stalled(
  p_flag_enabled boolean,
  p_after_days integer,
  p_below_percent integer,
  p_total_steps integer,
  p_percent_complete integer,
  p_status text,
  p_assigned_at timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select coalesce(p_flag_enabled, false)
    and p_status <> 'completed'
    and p_total_steps > 0
    and p_percent_complete < p_below_percent
    and p_assigned_at < pg_catalog.now() - pg_catalog.make_interval(days => p_after_days)
$function$;

revoke all on function private.member_onboarding_plan_stalled(boolean, integer, integer, integer, integer, text, timestamptz) from public, anon, authenticated, service_role;

comment on function private.member_onboarding_plan_stalled(boolean, integer, integer, integer, integer, text, timestamptz) is
  'REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: an onboarding plan is stalled when the flag is on, it is not completed, the organization has an active step, it is under the percent threshold and it was assigned longer ago than the waiting period.';

-- Plans grouped by the member's profile chapter, with the floor applied.
create function private.member_onboarding_chapter_summary(
  p_organization_id uuid,
  p_floor integer,
  p_stalled_enabled boolean,
  p_stalled_days integer,
  p_stalled_percent integer,
  p_total_steps integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  floor_value integer := greatest(25, coalesce(p_floor, 25));
  groups jsonb;
  total integer;
  pooled integer;
  shown jsonb := '[]'::jsonb;
  shown_ids text[] := array[]::text[];
  item jsonb;
  pool jsonb;
  withheld_chapters integer;
begin
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(g) order by g.enrolled, g.chapter_id desc), '[]'::jsonb),
         coalesce(pg_catalog.sum(g.enrolled), 0)::integer
    into groups, total
  from (
    select
      c.id chapter_id,
      pg_catalog.max(c.name) chapter_name,
      pg_catalog.count(*)::integer enrolled,
      (pg_catalog.count(*) filter (where p.status = 'not_started'))::integer not_started,
      (pg_catalog.count(*) filter (where p.status = 'in_progress'))::integer in_progress,
      (pg_catalog.count(*) filter (where p.status = 'completed'))::integer completed,
      (pg_catalog.count(*) filter (where private.member_onboarding_plan_stalled(
        p_stalled_enabled, p_stalled_days, p_stalled_percent, p_total_steps, done.percent, p.status, p.created_at
      )))::integer stalled
    from public.member_onboarding_plans p
    left join public.member_profiles pr on pr.id = p.member_user_id
    left join public.chapters c on c.id = pr.chapter_id and c.organization_id = p_organization_id
    cross join lateral (
      select case when p_total_steps = 0 then 100
        else (pg_catalog.count(*) * 100 / p_total_steps)::integer end percent
      from public.organization_onboarding_steps s
      where s.organization_id = p_organization_id and s.active and s.id = any(p.completed_step_ids)
    ) done
    where p.organization_id = p_organization_id
    group by c.id
  ) g;

  -- Chapters at the floor, largest first, are candidates; everything else is
  -- pooled. A pool under the floor takes the smallest candidate until it
  -- reaches the floor or no candidate is left.
  pooled := coalesce((
    select pg_catalog.sum((value ->> 'enrolled')::integer)
    from pg_catalog.jsonb_array_elements(groups) value
    where value ->> 'chapter_id' is null or (value ->> 'enrolled')::integer < floor_value
  ), 0)::integer;
  for item in
    select value from pg_catalog.jsonb_array_elements(groups) value
    where value ->> 'chapter_id' is not null and (value ->> 'enrolled')::integer >= floor_value
    order by (value ->> 'enrolled')::integer, value ->> 'chapter_id' desc
  loop
    if pooled > 0 and pooled < floor_value then
      pooled := pooled + (item ->> 'enrolled')::integer;
    else
      shown_ids := shown_ids || (item ->> 'chapter_id');
    end if;
  end loop;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'chapterId', value ->> 'chapter_id',
      'name', value ->> 'chapter_name',
      'enrolled', (value ->> 'enrolled')::integer,
      'notStarted', (value ->> 'not_started')::integer,
      'inProgress', (value ->> 'in_progress')::integer,
      'completed', (value ->> 'completed')::integer,
      'stalled', case when p_stalled_enabled then (value ->> 'stalled')::integer end
    ) order by (value ->> 'enrolled')::integer desc, value ->> 'chapter_id'), '[]'::jsonb)
    into shown
  from pg_catalog.jsonb_array_elements(groups) value
  where value ->> 'chapter_id' = any(shown_ids);

  select
    case when pg_catalog.count(*) = 0 or pg_catalog.sum((value ->> 'enrolled')::integer) < floor_value then null
    else pg_catalog.jsonb_build_object(
      'enrolled', pg_catalog.sum((value ->> 'enrolled')::integer)::integer,
      'notStarted', pg_catalog.sum((value ->> 'not_started')::integer)::integer,
      'inProgress', pg_catalog.sum((value ->> 'in_progress')::integer)::integer,
      'completed', pg_catalog.sum((value ->> 'completed')::integer)::integer,
      'stalled', case when p_stalled_enabled then pg_catalog.sum((value ->> 'stalled')::integer)::integer end
    ) end,
    (pg_catalog.count(*) filter (where value ->> 'chapter_id' is not null))::integer
    into pool, withheld_chapters
  from pg_catalog.jsonb_array_elements(groups) value
  where not (coalesce(value ->> 'chapter_id', '') = any(shown_ids));

  return pg_catalog.jsonb_build_object(
    'floor', floor_value,
    'withheld', total > 0 and pg_catalog.jsonb_array_length(shown) = 0 and pool is null,
    'chapters', shown,
    'otherChapters', pool,
    'withheldChapters', withheld_chapters
  );
end;
$function$;

revoke all on function private.member_onboarding_chapter_summary(uuid, integer, boolean, integer, integer, integer) from public, anon, authenticated, service_role;

comment on function private.member_onboarding_chapter_summary(uuid, integer, boolean, integer, integer, integer) is
  'REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: onboarding plans by profile chapter for one organization. A chapter''s counts appear only at or above the floor (never below 25); the rest are pooled, and a pool under the floor absorbs the smallest shown chapters so no withheld count is recoverable by subtraction.';

-- ---------------------------------------------------------------------------
-- 3. Member progress: chapter summary, skip reasons, reminder state
-- ---------------------------------------------------------------------------

create or replace function public.get_member_onboarding_oversight()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.member_support_selected_organization();
  stalled_enabled boolean;
  stalled_days integer;
  stalled_percent integer;
  total_steps integer;
  chapter_floor integer;
begin
  if not private.member_support_is_staff(org) then
    raise exception 'staff role and MFA required' using errcode = '42501';
  end if;
  stalled_enabled := private.organization_feature_enabled(org, 'features.guidance_onboarding.stalled_flag');
  stalled_days := private.organization_limit(org, 'limits.guidance_onboarding.stalled_after_days');
  stalled_percent := private.organization_limit(org, 'limits.guidance_onboarding.stalled_below_percent');
  chapter_floor := greatest(25, coalesce(private.organization_limit(org, 'limits.analytics.anonymity_floor'), 25));
  select pg_catalog.count(*)::integer into total_steps
  from public.organization_onboarding_steps s
  where s.organization_id = org and s.active;

  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'stalledFlagEnabled', stalled_enabled,
    'stalledAfterDays', stalled_days,
    'stalledBelowPercent', stalled_percent,
    'staffOverridesEnabled', private.organization_feature_enabled(org, 'features.guidance_onboarding.staff_step_overrides'),
    'autoEnrollEnabled', private.organization_feature_enabled(org, 'features.guidance_onboarding.auto_enroll_onboarding'),
    'totalSteps', total_steps,
    'steps', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', s.id, 'title', s.title, 'position', s.position) order by s.position, s.id)
      from public.organization_onboarding_steps s
      where s.organization_id = org and s.active
    ), '[]'::jsonb),
    'members', coalesce((
      select pg_catalog.jsonb_agg(row_json order by stalled desc, updated_at desc)
      from (
        select
          pg_catalog.jsonb_build_object(
            'planId', p.id,
            'memberUserId', p.member_user_id,
            'memberLabel', private.member_support_member_label(p.member_user_id),
            'status', p.status,
            'completedStepIds', coalesce((
              select pg_catalog.jsonb_agg(s.id order by s.position, s.id)
              from public.organization_onboarding_steps s
              where s.organization_id = org and s.active and s.id = any(p.completed_step_ids)
            ), '[]'::jsonb),
            'completedSteps', done.completed,
            'percentComplete', done.percent,
            'assignedAt', p.created_at,
            'autoEnrolled', p.assigned_by is null,
            'stalled', flagged.stalled,
            'skippedSteps', coalesce((
              select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('stepId', k.step_id, 'reason', k.reason, 'skippedAt', k.skipped_at) order by s.position, s.id)
              from private.member_onboarding_skip_reasons k
              join public.organization_onboarding_steps s on s.id = k.step_id and s.organization_id = org and s.active
              where k.plan_id = p.id and k.step_id = any(p.completed_step_ids)
            ), '[]'::jsonb),
            'reminderSentAt', reminded.sent_at,
            'reminderOptedOut', coalesce((
              select pr.notification_prefs -> 'onboarding' = 'false'::jsonb
              from public.member_profiles pr where pr.id = p.member_user_id
            ), false)
          ) row_json,
          flagged.stalled,
          p.updated_at
        from public.member_onboarding_plans p
        cross join lateral (
          select
            pg_catalog.count(*)::integer completed,
            case when total_steps = 0 then 100
              else (pg_catalog.count(*) * 100 / total_steps)::integer end percent
          from public.organization_onboarding_steps s
          where s.organization_id = org and s.active and s.id = any(p.completed_step_ids)
        ) done
        cross join lateral (
          select private.member_onboarding_plan_stalled(
            stalled_enabled, stalled_days, stalled_percent, total_steps, done.percent, p.status, p.created_at
          ) stalled
        ) flagged
        -- The last reminder inside the 24-hour window, if any.
        cross join lateral (
          select pg_catalog.max(l.occurred_at) sent_at
          from public.organization_audit_ledger l
          where l.organization_id = org
            and l.occurred_at > pg_catalog.now() - interval '24 hours'
            and l.event_type = 'onboarding_reminder_sent'
            and l.entity_type = 'member'
            and l.entity_id = p.member_user_id::text
        ) reminded
        where p.organization_id = org
        order by flagged.stalled desc, p.updated_at desc
        limit 500
      ) roster
    ), '[]'::jsonb),
    'memberCount', (select pg_catalog.count(*) from public.member_onboarding_plans p where p.organization_id = org),
    'chapterSummary', private.member_onboarding_chapter_summary(org, chapter_floor, stalled_enabled, stalled_days, stalled_percent, total_steps)
  );
end;
$function$;

revoke all on function public.get_member_onboarding_oversight() from public, anon, authenticated, service_role;
grant execute on function public.get_member_onboarding_oversight() to authenticated;

comment on function public.get_member_onboarding_oversight() is
  'REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001; REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: staff onboarding roster for the session organization with the configurable stalled flag, each row''s skip reasons and reminder state, and plans by chapter behind the privacy floor of at least 25.';

-- ---------------------------------------------------------------------------
-- 4. Staff complete / skip / reset: a skip needs a reason
-- ---------------------------------------------------------------------------

drop function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid);

create function public.staff_update_member_onboarding_plan(
  p_plan_id uuid,
  p_action text,
  p_step_id uuid,
  p_idempotency_key uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  declare
    org uuid := private.member_support_selected_organization();
    plan record;
    step_ok boolean;
    completed uuid[];
    remaining integer;
    next_status text;
    -- Every whitespace character, not only spaces, is trimmed at both ends.
    skip_reason text := nullif(pg_catalog.regexp_replace(coalesce(p_reason, ''), '^[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\n\r\f\v\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g'), '');
    request_payload jsonb;
    cached jsonb;
    result jsonb;
  begin
    if not private.member_support_is_staff(org) then
      raise exception 'staff role and MFA required' using errcode = '42501';
    end if;
    if not private.organization_feature_enabled(org, 'features.guidance_onboarding.staff_step_overrides') then
      raise exception 'staff onboarding changes are turned off for this organization' using errcode = '42501';
    end if;
    if p_action is null or p_action not in ('complete', 'skip', 'reset') or p_idempotency_key is null then
      raise exception 'invalid onboarding change' using errcode = '22023';
    end if;
    if p_action = 'skip' and (skip_reason is null or pg_catalog.char_length(skip_reason) > 500) then
      raise exception 'a skipped step needs a reason of 1 to 500 characters' using errcode = '22023';
    end if;
    select * into plan from public.member_onboarding_plans
    where id = p_plan_id and organization_id = org
    for update;
    if plan.id is null then
      raise exception 'onboarding plan not found' using errcode = '22023';
    end if;
    perform private.lock_case_graph(array[plan.member_user_id], array[]::uuid[]);

    -- Claim the key before anything changes: an identical replay returns the
    -- original result without mutating; any other reuse raises 22023.
    request_payload := private.idempotent_request_payload(plan.id::text, pg_catalog.jsonb_build_object(
      'planId', plan.id, 'action', p_action,
      'stepId', case when p_action = 'reset' then null else p_step_id end,
      'reason', case when p_action = 'skip' then skip_reason end
    ));
    cached := private.member_operations_replay(org, 'staff_update_member_onboarding_plan', p_idempotency_key, request_payload);
    if cached is not null then
      return cached;
    end if;

    if p_action = 'reset' then
      update public.member_onboarding_plans set
        completed_step_ids = '{}',
        status = 'not_started',
        started_at = null,
        completed_at = null,
        updated_at = pg_catalog.now()
      where id = plan.id;
      delete from private.member_onboarding_skip_reasons k where k.plan_id = plan.id;
      perform private.member_support_record_event(extensions.gen_random_uuid(), org, plan.member_user_id, 'onboarding_plan', plan.id, 'progress_reset');
      result := pg_catalog.jsonb_build_object('id', plan.id, 'status', 'not_started', 'completedStepIds', '[]'::jsonb);
      perform private.member_operations_store_receipt(org, 'staff_update_member_onboarding_plan', p_idempotency_key, request_payload, result);
      return result;
    end if;

    select exists (
      select 1 from public.organization_onboarding_steps s
      where s.id = p_step_id and s.organization_id = org and s.active
    ) into step_ok;
    if not step_ok then
      raise exception 'onboarding step not found' using errcode = '22023';
    end if;
    completed := array(select distinct value from pg_catalog.unnest(plan.completed_step_ids || p_step_id) value);
    select pg_catalog.count(*) into remaining from public.organization_onboarding_steps s
    where s.organization_id = org and s.active and not (s.id = any(completed));
    next_status := case when remaining = 0 then 'completed' else 'in_progress' end;
    update public.member_onboarding_plans set
      completed_step_ids = completed,
      status = next_status,
      started_at = coalesce(started_at, pg_catalog.now()),
      completed_at = case when remaining = 0 then coalesce(completed_at, pg_catalog.now()) else null end,
      updated_at = pg_catalog.now()
    where id = plan.id;
    if p_action = 'skip' then
      insert into private.member_onboarding_skip_reasons (plan_id, step_id, reason, skipped_at)
      values (plan.id, p_step_id, skip_reason, pg_catalog.now())
      on conflict (plan_id, step_id) do update set reason = excluded.reason, skipped_at = excluded.skipped_at;
    end if;
    -- The event id is fresh: the receipt carries idempotency, so a second
    -- staff member's own key can never silently drop this audit row.
    perform private.member_support_record_event(
      extensions.gen_random_uuid(), org, plan.member_user_id, 'onboarding_plan', plan.id,
      case when p_action = 'skip' then 'step_skipped' else 'step_completed' end
    );
    result := pg_catalog.jsonb_build_object('id', plan.id, 'status', next_status, 'completedStepIds', pg_catalog.to_jsonb(completed));
    perform private.member_operations_store_receipt(org, 'staff_update_member_onboarding_plan', p_idempotency_key, request_payload, result);
    return result;
  end;
end;
$function$;

revoke all on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid, text) to authenticated;

comment on function public.staff_update_member_onboarding_plan(uuid, text, uuid, uuid, text) is
  'REQ-UG-ONBOARDING-AUTO-ASSIGN-AND-STEWARD-OVERSIGHT-20261001; REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: audited staff complete / skip / reset of a member''s onboarding steps, behind features.guidance_onboarding.staff_step_overrides. A skip needs a reason (1 to 500 characters), kept in private.member_onboarding_skip_reasons until a reset.';

-- ---------------------------------------------------------------------------
-- 5. Send one reminder to a stalled member
-- ---------------------------------------------------------------------------

create function public.send_member_onboarding_reminder(
  p_plan_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  declare
    org uuid := private.member_support_selected_organization();
    caller uuid := auth.uid();
    sent_at timestamptz := pg_catalog.now();
    plan record;
    total_steps integer;
    done_steps integer;
    remaining integer;
    request_payload jsonb;
    cached jsonb;
    result jsonb;
  begin
    if not private.member_support_is_staff(org) then
      raise exception 'staff role and MFA required' using errcode = '42501';
    end if;
    if p_plan_id is null or p_idempotency_key is null then
      raise exception 'invalid onboarding reminder' using errcode = '22023';
    end if;
    -- The plan row lock serializes reminders for one member, so two staff
    -- members pressing at once cannot both pass the daily check.
    select * into plan from public.member_onboarding_plans
    where id = p_plan_id and organization_id = org
    for update;
    if plan.id is null then
      raise exception 'onboarding plan not found' using errcode = '22023';
    end if;
    perform private.lock_case_graph(array[plan.member_user_id], array[]::uuid[]);

    request_payload := private.idempotent_request_payload(plan.id::text, pg_catalog.jsonb_build_object('planId', plan.id, 'action', 'remind'));
    cached := private.member_operations_replay(org, 'send_member_onboarding_reminder', p_idempotency_key, request_payload);
    if cached is not null then
      return cached;
    end if;

    if not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = org and m.user_id = plan.member_user_id and m.status = 'active'
    ) then
      raise exception 'onboarding plan not found' using errcode = '22023';
    end if;
    select pg_catalog.count(*)::integer, (pg_catalog.count(*) filter (where s.id = any(plan.completed_step_ids)))::integer
      into total_steps, done_steps
    from public.organization_onboarding_steps s
    where s.organization_id = org and s.active;
    remaining := total_steps - done_steps;
    if not private.member_onboarding_plan_stalled(
      private.organization_feature_enabled(org, 'features.guidance_onboarding.stalled_flag'),
      private.organization_limit(org, 'limits.guidance_onboarding.stalled_after_days'),
      private.organization_limit(org, 'limits.guidance_onboarding.stalled_below_percent'),
      total_steps,
      case when total_steps = 0 then 100 else (done_steps * 100 / total_steps)::integer end,
      plan.status,
      plan.created_at
    ) then
      raise exception 'only a stalled member can be reminded' using errcode = '22023';
    end if;
    if exists (
      select 1 from public.member_profiles pr
      where pr.id = plan.member_user_id and pr.notification_prefs -> 'onboarding' = 'false'::jsonb
    ) then
      raise exception 'this member turned off onboarding reminders' using errcode = '55000';
    end if;
    if exists (
      select 1 from public.organization_audit_ledger l
      where l.organization_id = org
        and l.occurred_at > sent_at - interval '24 hours'
        and l.event_type = 'onboarding_reminder_sent'
        and l.entity_type = 'member'
        and l.entity_id = plan.member_user_id::text
    ) then
      raise exception 'onboarding reminder limit reached: 1 per member per day' using errcode = '54000';
    end if;

    -- Fixed copy in the member's language. It names no organization, staff
    -- member or step, so a lock screen discloses nothing.
    insert into public.member_notifications (user_id, title, body, kind, organization_id)
    select plan.member_user_id,
      case when pr.language = 'es' then 'Tu lista de bienvenida te espera' else 'Your onboarding checklist is waiting' end,
      case when pr.language = 'es'
        then case when remaining = 1 then 'Te queda 1 paso de bienvenida.' else 'Te quedan ' || remaining || ' pasos de bienvenida.' end
          || ' Abre Union Ground para seguir donde lo dejaste.'
        else case when remaining = 1 then 'You have 1 onboarding step left.' else 'You have ' || remaining || ' onboarding steps left.' end
          || ' Open Union Ground to pick up where you left off.' end,
      'general', org
    from (select plan.member_user_id id) target
    left join public.member_profiles pr on pr.id = target.id;

    insert into public.organization_audit_ledger (
      organization_id, domain, event_type, action, actor_user_id,
      entity_type, entity_id, occurred_at, idempotency_key, metadata
    ) values (
      org, 'communications', 'onboarding_reminder_sent', 'send', caller,
      'member', plan.member_user_id::text, sent_at, extensions.gen_random_uuid(),
      pg_catalog.jsonb_build_object('userId', plan.member_user_id, 'entityId', plan.id, 'count', remaining)
    );

    result := pg_catalog.jsonb_build_object(
      'planId', plan.id,
      'memberUserId', plan.member_user_id,
      'sentAt', sent_at,
      'nextReminderAt', sent_at + interval '24 hours'
    );
    perform private.member_operations_store_receipt(org, 'send_member_onboarding_reminder', p_idempotency_key, request_payload, result);
    return result;
  end;
end;
$function$;

revoke all on function public.send_member_onboarding_reminder(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.send_member_onboarding_reminder(uuid, uuid) to authenticated;

comment on function public.send_member_onboarding_reminder(uuid, uuid) is
  'REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: onboarding staff send one fixed reminder to a stalled, active member of the session organization through member_notifications. At most one per member per organization in 24 hours (54000), refused when the member turned onboarding reminders off (55000), recorded in organization_audit_ledger, idempotent by key.';

-- ---------------------------------------------------------------------------
-- 6. Keep a stored onboarding reminder choice
-- ---------------------------------------------------------------------------

create or replace function private.preserve_engagement_email_preferences()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.notification_prefs := coalesce((
    select pg_catalog.jsonb_object_agg(stored.key, stored.value)
      from pg_catalog.jsonb_each(old.notification_prefs) stored
     where stored.key in ('announcements', 'surveys', 'welcome', 'onboarding')
       and not (new.notification_prefs ? stored.key)
  ), '{}'::jsonb) || new.notification_prefs;
  return new;
end;
$function$;

revoke all on function private.preserve_engagement_email_preferences() from public, anon, authenticated, service_role;

comment on function private.preserve_engagement_email_preferences() is
  'Keeps a stored announcements, surveys or welcome email choice, or the onboarding reminder choice (20261104090000), when an older writer replaces notification_prefs without that key, so an unsubscribe or opt-out is never silently reversed. Only an explicit true re-enables.';

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.schema_name = 'private' and s.table_name = 'member_onboarding_skip_reasons')
   or (s.kind = 'function' and s.schema_name = 'private' and s.object_name = 'preserve_engagement_email_preferences()')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_onboarding_admin_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the onboarding admin server gaps';
  end if;
end;
$assert_onboarding_admin_trigger_review$;

notify pgrst, 'reload schema';

commit;
