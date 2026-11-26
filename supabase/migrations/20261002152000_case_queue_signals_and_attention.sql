-- REQ-UG-CASE-QUEUE-SIGNALS-AND-NEXT-ACTION-20261001
-- REQ-UG-STEWARD-ATTENTION-TREND-20261001
--
-- 1. Case queue signals and the ranked "what next" panel (read side only).
--    Restores de7df4b57c^:lib/crm/workflow-queues.ts and next-action-digest.ts
--    for the current casework model: deadline risk, missing owner, stale member
--    contact, missing evidence before a deadline and weak case strength, ranked
--    with the old sort bands. The stale-contact AUTOMATION trigger is lane L7a's
--    (REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001); nothing here writes.
--    Defaults: the old CRM queue had no switch (default on); stale contact 14
--    days (old lib/crm/load-command-center.ts:202 crm_stale_contact_days),
--    evidence window 14 days and weak strength below 40 (old
--    0611_automation_recipes_evidence_strength.sql:75-77). Deadline lookahead
--    and risk bands reuse the casework limits of
--    REQ-UG-CONFIGURABLE-THRESHOLDS-20261001.
--
-- 2. Steward attention queue (old lib/attention/rules.ts, member-queue.ts,
--    components/home/lib/load-steward-home.ts:206-350,
--    app/dashboard/attention/page.tsx). Per-member rollup of the caller's own
--    active cases: deadline risk within 3 days (rules.ts:14) or an open case,
--    the most urgent case, and the main reason. "Up N since your last visit"
--    is computed on the device from the previous visit's count: the old app
--    derived it from a per-member page-view log, which the product no longer
--    keeps, and no new identity log is added for it.
--    Switches default OFF exactly as old 0254_attention_guided_portal_flags.sql:2-5.
--
-- The SAMPLE demo seed turns the four attention switches ON (the old demo
-- ran them on); production keeps the old OFF default.
--
-- Both reads are SECURITY DEFINER with explicit authorization: the caller must
-- hold the staff hat in the selected organization, and every case passes the
-- existing casework staff access predicate (restricted cases included).

begin;

set local lock_timeout = '5s';

insert into public.platform_setting_definitions
  (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
values
  ('features.casework.next_action_queue', 'boolean', 'Case queue next actions',
   'Show stewards and coordinators a ranked list of what to do next: deadlines, owner gaps, stale contact, missing evidence and weak cases.',
   'true', null, null, null, 110, 'casework', true),
  ('limits.casework.stale_contact_days', 'integer', 'Stale member contact (days)',
   'Members with an active case and no contact for longer than this appear in the next-action queue.',
   '14', 1, 180, null, 120, 'casework', false),
  ('limits.casework.evidence_deadline_days', 'integer', 'Evidence before deadline (days)',
   'Cases due within this many days with no evidence file appear in the next-action queue.',
   '14', 1, 90, null, 130, 'casework', false),
  ('limits.casework.weak_strength_threshold', 'integer', 'Weak case strength below',
   'Scored cases below this strength score (0-100) appear in the next-action queue.',
   '40', 1, 100, null, 140, 'casework', false),
  ('features.attention.guided_portal', 'boolean', 'Attention-guided steward home',
   'Master switch for the steward attention queue, its since-your-last-visit trend, badges and shortcuts.',
   'false', null, null, null, 10, 'home', true),
  ('features.attention.dashboard', 'boolean', 'Attention queue on the steward desk',
   'Show the members who need attention, why, and how the count changed since the last visit.',
   'false', null, null, null, 20, 'home', true),
  ('features.attention.member_surfaces', 'boolean', 'Attention badges in member lists',
   'Mark members who need attention in staff member lists and the caseload.',
   'false', null, null, null, 30, 'home', true),
  ('features.attention.navigation', 'boolean', 'Attention shortcuts in the command palette',
   'Let staff type phrases like "who needs attention" in the command palette to open the attention queue.',
   'false', null, null, null, 40, 'home', true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Shared authorization: a staff hat the caller holds in the selected
-- organization (organization grant or a chapter role in one of its chapters).
-- ---------------------------------------------------------------------------

create function private.case_signals_staff_organization(p_selected_hat text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  hat text := coalesce(nullif(pg_catalog.btrim(coalesce(p_selected_hat, '')), ''), '');
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  org := private.mi1_require_selected_organization();
  if hat not in ('steward', 'coordinator', 'admin') then
    raise exception 'staff hat required' using errcode = '42501';
  end if;
  if not (
    private.has_organization_role(org, array[hat])
    or exists (
      select 1 from public.chapters c
      where c.organization_id = org and private.member_has_chapter_role(c.id, array[hat])
    )
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return org;
end;
$function$;

-- Earliest open deadline of a case: the case deadline or an unresolved casework
-- deadline, as a date. A deadline the minute sweep marked 'missed'
-- (20261002143000) stays here, overdue, until staff record it met or waived,
-- so the queue never drops the most overdue work when the status changes.
create function private.case_signals_next_due(p_case_id uuid, p_case_deadline date)
returns date
language sql
stable
security definer
set search_path = ''
as $function$
  select nullif(least(
    coalesce(p_case_deadline, 'infinity'::date),
    coalesce((
      select pg_catalog.min((d.due_at at time zone 'America/New_York')::date)
      from public.casework_deadlines d
      where d.case_id = p_case_id and d.status in ('active', 'extended', 'missed')
    ), 'infinity'::date)
  ), 'infinity'::date)
$function$;

-- ---------------------------------------------------------------------------
-- 1. Next-action queue
-- ---------------------------------------------------------------------------

create function public.get_case_queue_next_actions(p_selected_hat text, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.case_signals_staff_organization(p_selected_hat);
  hat text := pg_catalog.btrim(p_selected_hat);
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  lookahead integer;
  critical_days integer;
  high_days integer;
  stale_days integer;
  evidence_days integer;
  weak_below integer;
  bounded integer := greatest(1, least(coalesce(p_limit, 25), 100));
  items jsonb;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.organization_feature_enabled(org, 'features.casework.next_action_queue') then
    return pg_catalog.jsonb_build_object('enabled', false, 'items', '[]'::jsonb,
      'summary', pg_catalog.jsonb_build_object('total', 0, 'urgent', 0, 'missingOwner', 0));
  end if;
  lookahead := private.organization_limit(org, 'limits.casework.deadline_lookahead_days');
  critical_days := private.organization_limit(org, 'limits.casework.deadline_risk_critical_days');
  high_days := private.organization_limit(org, 'limits.casework.deadline_risk_high_days');
  stale_days := private.organization_limit(org, 'limits.casework.stale_contact_days');
  evidence_days := private.organization_limit(org, 'limits.casework.evidence_deadline_days');
  weak_below := private.organization_limit(org, 'limits.casework.weak_strength_threshold');

  with cases as (
    select c.id, c.user_id, c.reference, c.step, c.steward_user_id,
      private.case_signals_next_due(c.id, c.deadline) as next_due
    from public.member_cases c
    where c.organization_id = org
      and c.status = 'active'
      and c.user_id <> caller
      and (hat <> 'steward' or c.steward_user_id = caller)
      and private.casework_staff_can_access(c.id)
  ),
  enriched as (
    select cs.*,
      case when cs.next_due is null then null else cs.next_due - today end as due_days,
      exists (
        select 1 from public.member_case_files f
        where f.case_id = cs.id and f.confirmed_at is not null and f.removal_requested_at is null
      ) as has_evidence,
      (
        select a.score from public.casework_strength_analyses a
        where a.case_id = cs.id
        order by a.created_at desc, a.id desc
        limit 1
      ) as strength
    from cases cs
  ),
  members as (
    select e.user_id,
      pg_catalog.count(*) as open_cases,
      (pg_catalog.array_agg(e.id order by e.due_days nulls last, e.reference))[1] as top_case,
      (pg_catalog.array_agg(e.reference order by e.due_days nulls last, e.reference))[1] as top_reference,
      greatest(
        (select pg_catalog.max(n.created_at) from public.member_contact_notes n
          join public.chapters ch on ch.id = n.chapter_id and ch.organization_id = org
          where n.member_user_id = e.user_id),
        (select pg_catalog.max(m.created_at) from public.member_messages m
          join public.member_conversations conversation
            on conversation.id = m.conversation_id and conversation.organization_id = org
          where m.user_id = e.user_id and m.sender_kind = 'steward')
      ) as last_contact
    from enriched e
    group by e.user_id
  ),
  raw_items as (
    -- Deadline risk (workflow-queues.ts:322-361): due within the lookahead,
    -- overdue always included.
    select pg_catalog.jsonb_build_object(
        'id', 'deadline_risk:' || e.id, 'kind', 'deadline_risk',
        'severity', case when e.due_days <= critical_days then 'critical' when e.due_days <= high_days then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days) as item,
      case when e.due_days <= 0 then 500 + pg_catalog.abs(e.due_days) else 360 - e.due_days end::numeric as score
    from enriched e
    where e.due_days is not null and e.due_days <= lookahead
    union all
    -- Owner gap (unassigned case), for queue owners only.
    select pg_catalog.jsonb_build_object(
        'id', 'missing_owner:' || e.id, 'kind', 'missing_owner', 'severity', 'high',
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days),
      330::numeric
    from enriched e
    where hat <> 'steward' and e.steward_user_id is null
    union all
    -- Stale member contact (workflow-queues.ts:468-541), one item per member.
    select pg_catalog.jsonb_build_object(
        'id', 'stale_contact:' || mb.user_id, 'kind', 'stale_contact', 'severity', 'medium',
        'caseId', mb.top_case, 'reference', mb.top_reference, 'memberId', mb.user_id,
        'memberName', private.member_support_member_label(mb.user_id),
        'openCases', mb.open_cases,
        'lastContactDays', case when mb.last_contact is null then null
          else today - (mb.last_contact at time zone 'America/New_York')::date end),
      210 + coalesce(today - (mb.last_contact at time zone 'America/New_York')::date, stale_days + 1)::numeric / 100
    from members mb
    where mb.last_contact is null
       or today - (mb.last_contact at time zone 'America/New_York')::date > stale_days
    union all
    -- Missing evidence before a deadline (workflow-queues.ts:543-590).
    select pg_catalog.jsonb_build_object(
        'id', 'missing_evidence:' || e.id, 'kind', 'missing_evidence',
        'severity', case when e.due_days <= 0 then 'critical' else 'high' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days),
      case when e.due_days <= 0 then 440 + least(pg_catalog.abs(e.due_days), 9) else 348 - e.due_days end::numeric
    from enriched e
    where e.due_days is not null and e.due_days <= evidence_days and not e.has_evidence
    union all
    -- Weak case strength (workflow-queues.ts:603-645): scored cases only.
    select pg_catalog.jsonb_build_object(
        'id', 'weak_strength:' || e.id, 'kind', 'weak_strength',
        'severity', case when e.strength < weak_below / 2.0 then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'days', e.due_days, 'strength', e.strength),
      200 + greatest(0, weak_below - e.strength)::numeric / 100
    from enriched e
    where e.strength is not null and e.strength < weak_below
  ),
  ranked as (
    select r.item, r.score,
      case r.item ->> 'severity' when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end as severity_rank
    from raw_items r
  )
  select pg_catalog.jsonb_build_object(
    'enabled', true,
    'items', coalesce((
      select pg_catalog.jsonb_agg(top.item order by top.score desc, top.severity_rank desc, top.item ->> 'dueDate' nulls last, top.item ->> 'id')
      from (select * from ranked order by score desc, severity_rank desc, item ->> 'dueDate' nulls last, item ->> 'id' limit bounded) top
    ), '[]'::jsonb),
    'summary', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from ranked),
      'urgent', (select pg_catalog.count(*) from ranked where severity_rank >= 3),
      'missingOwner', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_owner'),
      'staleContact', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'stale_contact'),
      'missingEvidence', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'missing_evidence'),
      'weakStrength', (select pg_catalog.count(*) from ranked where item ->> 'kind' = 'weak_strength')
    ),
    'settings', pg_catalog.jsonb_build_object('staleContactDays', stale_days, 'evidenceDays', evidence_days, 'weakStrengthBelow', weak_below)
  ) into items;
  return items;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Steward attention queue
-- ---------------------------------------------------------------------------

create function public.get_steward_attention_queue(p_selected_hat text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.case_signals_staff_organization(p_selected_hat);
  today date := (pg_catalog.now() at time zone 'America/New_York')::date;
  enabled boolean;
  result jsonb;
begin
  if not (select private.mfa_satisfied()) then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  enabled := private.organization_feature_enabled(org, 'features.attention.guided_portal')
    and private.organization_feature_enabled(org, 'features.attention.dashboard');
  if not enabled then
    return pg_catalog.jsonb_build_object('enabled', false, 'members', '[]'::jsonb, 'count', 0,
      'memberSurfaces', false, 'navigation', false);
  end if;

  with cases as (
    select c.id, c.user_id, c.reference, c.step,
      private.case_signals_next_due(c.id, c.deadline) as next_due
    from public.member_cases c
    where c.organization_id = org
      and c.status = 'active'
      and c.user_id <> caller
      and (c.steward_user_id = caller or c.coordinator_user_id = caller)
      and private.casework_staff_can_access(c.id)
  ),
  signals as (
    select cs.*,
      case when cs.next_due is null then null else cs.next_due - today end as due_days,
      cs.next_due is not null and cs.next_due - today <= 3 as deadline_risk
    from cases cs
  ),
  rollup as (
    select s.user_id,
      pg_catalog.count(*) as open_cases,
      pg_catalog.bool_or(s.deadline_risk) as deadline_risk,
      (pg_catalog.array_agg(s.id order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_case,
      (pg_catalog.array_agg(s.reference order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_reference,
      (pg_catalog.array_agg(s.step order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_step,
      (pg_catalog.array_agg(s.due_days order by s.deadline_risk desc, s.due_days nulls last, s.reference))[1] as top_days
    from signals s
    group by s.user_id
  )
  select pg_catalog.jsonb_build_object(
    'enabled', true,
    'memberSurfaces', private.organization_feature_enabled(org, 'features.attention.member_surfaces'),
    'navigation', private.organization_feature_enabled(org, 'features.attention.navigation'),
    'count', (select pg_catalog.count(*) from rollup),
    'breakdown', pg_catalog.jsonb_build_object(
      'dueSoon', (select pg_catalog.count(*) from rollup where deadline_risk),
      'openWithoutDeadlineRisk', (select pg_catalog.count(*) from rollup where not deadline_risk)
    ),
    'dominantReason', case
      when (select pg_catalog.count(*) from rollup) = 0 then null
      when (select pg_catalog.count(*) from rollup where deadline_risk) * 2 >= (select pg_catalog.count(*) from rollup) then 'deadline_risk'
      else 'open_case' end,
    'members', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'memberId', r.user_id,
        'memberName', private.member_support_member_label(r.user_id),
        'openCases', r.open_cases,
        'reasons', case when r.deadline_risk then '["deadline_risk","open_case"]'::jsonb else '["open_case"]'::jsonb end,
        'urgency', case when r.deadline_risk then 90 else 60 end,
        'caseId', r.top_case, 'reference', r.top_reference, 'step', r.top_step, 'days', r.top_days
      ) order by r.deadline_risk desc, r.top_days nulls last, r.open_cases desc, r.top_reference)
      from rollup r
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. SAMPLE seed: attention switches ON, as the old demo ran them
-- ---------------------------------------------------------------------------
-- The SAMPLE auth-operations seeder already writes organization setting
-- values for the seeded demo organization (20260828241000:102-222). It is
-- restated here unchanged except for the four attention rows; it still runs
-- only behind private.presg_demo_authorize / private.uniondemo_authorize, so
-- production never receives these values.

-- The body keeps the case-graph writer gate 20260907151000 installed on this
-- function (its first statement), as every restatement of a gated writer must.
create or replace function private.demo_seed_apply_auth_operations(
  p_lane text,
  p_run_id uuid,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  v_organization_id uuid;
  actor_user_id uuid;
  member_user_id uuid;
  member_email text;
  i integer;
  result jsonb;
begin
  if p_lane = 'presg' then
    perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
    if not exists (
      select 1 from private.presg_demo_runs
      where id = p_run_id and state in ('applied', 'verified')
    ) then
      raise exception 'presg demo run must be applied before auth operations data';
    end if;
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':presg:organization');
  elsif p_lane = 'uniondemo' then
    perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
    if not exists (
      select 1 from private.uniondemo_runs
      where id = p_run_id and state in ('applied', 'verified')
    ) then
      raise exception 'union demo run must be applied before auth operations data';
    end if;
    v_organization_id := private.member_stress_uuid(p_run_id::text || ':ud:organization');
  else
    raise exception 'unknown demo lane';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = v_organization_id and o.status = 'active'
  ) then
    raise exception 'demo organization is missing';
  end if;

  actor_user_id := private.demo_seed_user(p_lane, p_run_id, 1);

  insert into public.organization_setting_values
    (organization_id, setting_key, value, updated_by, updated_at)
  values
    (v_organization_id, 'features.passkey_enrollment', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'features.mfa_recovery_code_enrollment', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'security.failed_login_retention_days', '90'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'security.failed_login_alert_threshold', '3'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    -- REQ-UG-STEWARD-ATTENTION-TREND-20261001: the old demo ran the
    -- attention-guided portal ON while production defaulted it OFF (0254).
    (v_organization_id, 'features.attention.guided_portal', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'features.attention.dashboard', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'features.attention.member_surfaces', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days'),
    (v_organization_id, 'features.attention.navigation', 'true'::jsonb, actor_user_id, pg_catalog.now() - interval '2 days')
  on conflict (organization_id, setting_key) do update
    set value = excluded.value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  insert into public.organization_label_overrides
    (organization_id, label_key, label_value, updated_by, updated_at)
  values
    (v_organization_id, 'nav.myCases', 'Case support', actor_user_id, pg_catalog.now() - interval '36 hours'),
    (v_organization_id, 'staff.chapterWork', 'Chapter work', actor_user_id, pg_catalog.now() - interval '36 hours')
  on conflict (organization_id, label_key) do update
    set label_value = excluded.label_value,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  for i in 1..6 loop
    member_user_id := private.demo_seed_user(p_lane, p_run_id, i + 1);
    select pg_catalog.lower(u.email) into member_email
    from auth.users u where u.id = member_user_id;
    if member_email is null then
      raise exception 'demo auth identity is missing';
    end if;

    insert into public.organization_failed_login_attempts (
      id, organization_id, member_user_id, identity_hash, method, source,
      user_agent, status, disposition_note, reviewed_by, reviewed_at, occurred_at
    ) values (
      private.member_stress_uuid(p_run_id::text || ':auth:failed-login:' || i::text),
      v_organization_id,
      member_user_id,
      pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(member_email, 'UTF8'), 'sha256'),
        'hex'
      ),
      case when i % 3 = 0 then 'passkey' else 'password' end,
      'web-sample',
      case when i % 2 = 0 then 'Mozilla/5.0 Safari/605.1.15' else 'Mozilla/5.0 Chrome/128.0.0.0' end,
      case when i <= 4 then 'open' else 'reviewed' end,
      case when i <= 4 then null else 'Confirmed member retry' end,
      case when i <= 4 then null else actor_user_id end,
      case when i <= 4 then null else pg_catalog.now() - ((i - 1)::text || ' hours')::interval end,
      pg_catalog.now() - (i::text || ' hours')::interval
    )
    on conflict (id) do update set
      organization_id = excluded.organization_id,
      member_user_id = excluded.member_user_id,
      identity_hash = excluded.identity_hash,
      method = excluded.method,
      source = excluded.source,
      user_agent = excluded.user_agent,
      status = excluded.status,
      disposition_note = excluded.disposition_note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      occurred_at = excluded.occurred_at;
  end loop;

  result := private.demo_seed_auth_operations_status(p_lane, p_run_id);
  if not (result ->> 'ok')::boolean then
    raise exception 'auth operations seed contract failed: %', result;
  end if;
  return result;
end;
end;
$function$;


revoke all on function private.demo_seed_apply_auth_operations(text, uuid, text, text) from public, anon, authenticated, service_role;

revoke all on function private.case_signals_staff_organization(text) from public, anon, authenticated, service_role;
revoke all on function private.case_signals_next_due(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.get_case_queue_next_actions(text, integer) from public, anon, authenticated, service_role;
revoke all on function public.get_steward_attention_queue(text) from public, anon, authenticated, service_role;
grant execute on function public.get_case_queue_next_actions(text, integer) to authenticated;
grant execute on function public.get_steward_attention_queue(text) to authenticated;

notify pgrst, 'reload schema';

commit;
