-- BUG-UG-WHAT-TO-DO-NEXT-DEADLINE-ITEM-DROPS-NO-EVIDENCE-20261124,
--
-- Since   Steward and Coordinator "What to do next"
-- (public.get_case_queue_next_actions) lists each deadline once: a case due
-- inside the deadline lookahead raises its deadline_risk item only, and no
-- missing_evidence item. So a case due in 2 days with nothing attached no
-- longer said anywhere that it has no evidence.
--
-- The deadline_risk item now carries one more key, noEvidence: true when the
-- case is due inside the evidence window (limits.casework.evidence_deadline_days)
-- and has no confirmed evidence, the same test the missing_evidence item
-- uses; false otherwise, and false when the evidence window setting is null.
-- The website shows one line for it. Nothing else changes: the signature,
-- access, grants, limits, which items are raised, their scores and order,
-- and the summary counts.
--
-- The body is the one Main holds (20261124175900_next_actions_list_a_deadline_once.sql)
-- with that one key; the predecessor guard refuses a database whose
-- definition has changed since.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public.get_case_queue_next_actions(text,integer)')
  )) is distinct from '6ce332830a1f0c2bc92639bb2483069f' then
    raise exception 'unreviewed predecessor: public.get_case_queue_next_actions(text,integer)' using errcode = '55000';
  end if;
end;
$predecessor$;

CREATE OR REPLACE FUNCTION public.get_case_queue_next_actions(p_selected_hat text, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  org uuid := private.case_signals_staff_organization(p_selected_hat);
  hat text := pg_catalog.btrim(p_selected_hat);
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
    select c.id, c.user_id, c.reference, c.step, c.steward_user_id, c.deadline as case_deadline, c.time_zone,
      nd.due_on as next_due, nd.days as next_days, nd.kind as next_kind, nd.label as next_label
    from (select access_row.* from public.member_cases access_row where (private.chapter_case_staff_readable(access_row) or (access_row.organization_id is null and private.current_member_organization() is null))) c
    left join lateral private.case_next_deadline(c.id, c.deadline, c.time_zone) nd on true
    where c.organization_id = org
      and c.status = 'active'
      and c.user_id <> caller
      and (hat <> 'steward' or c.steward_user_id = caller)
      and private.casework_staff_can_read(c.id)
  ),
  enriched as (
    select cs.*,
      -- Which deadline next_due is, and its days left on its own zone:
      -- private.case_next_deadline. The member's My cases card and Home
      -- pick the same one (src/lib/caseNextDeadline.js).
      cs.next_days as due_days,
      cs.next_kind as due_kind,
      cs.next_label as due_label,
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
      (pg_catalog.array_agg(e.time_zone order by e.due_days nulls last, e.reference))[1] as top_time_zone,
      greatest(
        (select pg_catalog.max(n.created_at) from public.member_contact_notes n
          join public.chapters ch on ch.id = n.chapter_id and ch.organization_id = org
          where n.member_user_id = e.user_id),
        (select pg_catalog.max(m.created_at) from public.member_messages m
          join public.member_conversations conversation
            on conversation.id = m.conversation_id and conversation.organization_id = org
          where m.user_id = e.user_id and m.sender_kind = 'steward' and m.learning_removal_held_at is null)
      ) as last_contact
    from enriched e
    group by e.user_id
  ),
  raw_items as (
    -- Deadline risk (workflow-queues.ts:322-361): due within the lookahead,
    -- overdue always included.
    --  (ledger 870): the deadline item stands for the missing-evidence
    -- item the case no longer raises inside the lookahead, so it says
    -- whether evidence is missing, with the same test as that item below.
    select pg_catalog.jsonb_build_object(
        'id', 'deadline_risk:' || e.id, 'kind', 'deadline_risk',
        'severity', case when e.due_days <= critical_days then 'critical' when e.due_days <= high_days then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days,
        'noEvidence', coalesce(e.due_days <= evidence_days and not e.has_evidence, false)) as item,
      case when e.due_days <= 0 then 500 + pg_catalog.abs(e.due_days) else 360 - e.due_days end::numeric as score
    from enriched e
    where e.due_days is not null and e.due_days <= lookahead
    union all
    -- Owner gap (unassigned case), for queue owners only.
    select pg_catalog.jsonb_build_object(
        'id', 'missing_owner:' || e.id, 'kind', 'missing_owner', 'severity', 'high',
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days),
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
          else private.local_day(mb.top_time_zone, pg_catalog.now()) - private.local_day(mb.top_time_zone, mb.last_contact) end),
      210 + coalesce(private.local_day(mb.top_time_zone, pg_catalog.now()) - private.local_day(mb.top_time_zone, mb.last_contact), stale_days + 1)::numeric / 100
    from members mb
    where mb.last_contact is null
       or private.local_day(mb.top_time_zone, pg_catalog.now()) - private.local_day(mb.top_time_zone, mb.last_contact) > stale_days
    union all
    -- Missing evidence before a deadline (workflow-queues.ts:543-590).
    select pg_catalog.jsonb_build_object(
        'id', 'missing_evidence:' || e.id, 'kind', 'missing_evidence',
        'severity', case when e.due_days <= 0 then 'critical' else 'high' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days),
      case when e.due_days <= 0 then 440 + least(pg_catalog.abs(e.due_days), 9) else 348 - e.due_days end::numeric
    from enriched e
    where e.due_days is not null and e.due_days <= evidence_days and not e.has_evidence
      --: a case whose deadline already raises a deadline item above is
      -- not listed a second time, as missing evidence, for the same deadline.
      -- With no lookahead setting there is no deadline item, so the evidence
      -- item stays.
      and (lookahead is null or e.due_days > lookahead)
    union all
    -- Weak case strength (workflow-queues.ts:603-645): scored cases only.
    select pg_catalog.jsonb_build_object(
        'id', 'weak_strength:' || e.id, 'kind', 'weak_strength',
        'severity', case when e.strength < weak_below / 2.0 then 'high' else 'medium' end,
        'caseId', e.id, 'reference', e.reference, 'step', e.step, 'memberId', e.user_id,
        'memberName', private.member_support_member_label(e.user_id),
        'dueDate', e.next_due, 'dueKind', e.due_kind, 'dueLabel', e.due_label, 'days', e.due_days, 'strength', e.strength),
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

commit;
