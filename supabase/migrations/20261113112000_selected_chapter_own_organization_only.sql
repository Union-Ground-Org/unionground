-- SEC-UG-SUPPORT-WORKSPACE-AND-INTELLIGENCE-SNAPSHOT-SHOW-OTHER-ORGANIZATION-CHAPTER-IDS-20261111 (#8368).
--
-- public.get_member_support_workspace (mentorshipDirectory[].chapterId) and
-- public.get_organization_intelligence_snapshot (relationshipNodes[].chapterId)
-- gave staff each organization member's selected chapter id from
-- member_profiles.chapter_id. For a member of two organizations with the other
-- organization's chapter selected, staff received that other organization's
-- chapter id (leak audit of Nov 11, 2026, suspect 3.5; reproduced by
-- tests/selected-chapter-other-organization-db.test.js before this change).
--
-- The snapshot is re-emitted from its current definition
-- (20261112062000_neuro_map_organization_switch.sql), so the Neuro Map switch
-- is kept; only the selected-chapter join changes.
--
-- Both now join the selected chapter on the caller's organization and return
-- its id only when it belongs there, null otherwise. Every other field, the
-- rows, their order and the access checks are unchanged.
--
-- The product keeps an account to one active organization
-- (create_my_organization, accept_former_member_invitation and SCIM each refuse
-- an account active elsewhere) and switch_my_chapter refuses another
-- organization's chapter, so only a direct insert or a later feature can make
-- the two-organization member; the same proof fails if those rules go.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_member_support_workspace()'::regprocedure)) <> 'c8961faadba6f664035698ec4d416488' then
    raise exception 'unreviewed predecessor: public.get_member_support_workspace()' using errcode = '55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid = 'public.get_organization_intelligence_snapshot(text)'::regprocedure) <> '57ec7c1970b431db08ca6eff2eee1f72' then
    raise exception 'unreviewed predecessor: public.get_organization_intelligence_snapshot(text)' using errcode = '55000';
  end if;
end;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_member_support_workspace()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.member_pin_require_full_session();

declare
  caller uuid := (select auth.uid());
  org uuid := private.member_support_selected_organization();
  staff boolean := private.member_support_is_staff(org);
begin
  return pg_catalog.jsonb_build_object(
    'state', 'ready',
    'organizationId', org,
    'staff', staff,
    'emergencyChecklists', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', c.id, 'memberUserId', c.member_user_id,
        'memberLabel', private.member_support_member_label(c.member_user_id),
        'scenario', c.scenario, 'status', c.status,
        'completedSteps', c.completed_steps, 'notes', c.notes,
        'alertedAt', c.alerted_at, 'resolvedAt', c.resolved_at, 'updatedAt', c.updated_at
      ) order by c.updated_at desc)
      from public.member_emergency_checklists c
      where c.organization_id = org
        and (c.member_user_id = caller or (staff and c.status = 'alerted'))
    ), '[]'::jsonb),
    'accommodations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'memberUserId', a.member_user_id,
        'memberLabel', private.member_support_member_label(a.member_user_id),
        'requestType', a.request_type, 'description', a.description,
        'status', a.status, 'staffNote', a.staff_note,
        'submittedAt', a.submitted_at, 'resolvedAt', a.resolved_at, 'updatedAt', a.updated_at
      ) order by a.submitted_at desc)
      from public.member_accommodation_requests a
      where a.organization_id = org and (a.member_user_id = caller or staff)
    ), '[]'::jsonb),
    'accommodationSummary', pg_catalog.jsonb_build_object(
      'total', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff)),
      'open', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status in ('submitted', 'under_review')),
      'approved', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'approved'),
      'denied', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'denied'),
      'withdrawn', (select pg_catalog.count(*) from public.member_accommodation_requests a where a.organization_id = org and (a.member_user_id = caller or staff) and a.status = 'withdrawn')
    ),
    'hrDirectory', (
      select pg_catalog.jsonb_build_object(
        'id', d.organization_id, 'name', d.name, 'title', d.title,
        'department', d.department, 'email', d.email, 'phone', d.phone,
        'hours', d.hours, 'notes', d.notes, 'enabled', d.enabled
      ) from public.organization_hr_directory d
      where d.organization_id = org and d.enabled
    ),
    'hrContacts', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', h.id, 'memberUserId', h.member_user_id,
        'memberLabel', private.member_support_member_label(h.member_user_id),
        'channel', h.channel, 'purpose', h.purpose, 'disposition', h.disposition,
        'note', h.note, 'occurredAt', h.occurred_at,
        'followUpOn', h.follow_up_on, 'createdAt', h.created_at
      ) order by h.occurred_at desc)
      from public.member_hr_contacts h
      where h.organization_id = org and (h.member_user_id = caller or staff)
    ), '[]'::jsonb),
    'onboardingProgram', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', s.id, 'title', s.title, 'description', s.description,
        'position', s.position, 'active', s.active
      ) order by s.position, s.id)
      from public.organization_onboarding_steps s
      where s.organization_id = org and (s.active or staff)
    ), '[]'::jsonb),
    'onboardingPlan', (
      select pg_catalog.jsonb_build_object(
        'id', p.id, 'memberUserId', p.member_user_id, 'status', p.status,
        'completedStepIds', p.completed_step_ids, 'startedAt', p.started_at,
        'completedAt', p.completed_at,
        'assignedByLabel', private.member_support_member_label(p.assigned_by)
      ) from public.member_onboarding_plans p
      where p.organization_id = org and p.member_user_id = caller
    ),
    'onboardingRoster', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'memberUserId', p.member_user_id,
        'memberLabel', private.member_support_member_label(p.member_user_id),
        'status', p.status, 'completedStepIds', p.completed_step_ids,
        'startedAt', p.started_at, 'completedAt', p.completed_at
      ) order by p.updated_at desc)
      from public.member_onboarding_plans p where p.organization_id = org
    ), '[]'::jsonb) else '[]'::jsonb end,
    'mentorshipPairs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', p.id, 'mentorUserId', p.mentor_user_id, 'menteeUserId', p.mentee_user_id,
        'mentorLabel', private.member_support_member_label(p.mentor_user_id),
        'menteeLabel', private.member_support_member_label(p.mentee_user_id),
        'status', p.status, 'startedOn', p.started_on, 'endedOn', p.ended_on,
        'outcome', p.outcome,
        'goals', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', g.id, 'title', g.title, 'completed', g.completed,
          'completedAt', g.completed_at
        ) order by g.created_at) from public.member_mentorship_goals g where g.pair_id = p.id), '[]'::jsonb),
        'notes', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', n.id, 'authorLabel', private.member_support_member_label(n.author_user_id),
          'body', n.body, 'createdAt', n.created_at
        ) order by n.created_at desc) from public.member_mentorship_notes n where n.pair_id = p.id), '[]'::jsonb)
      ) order by p.updated_at desc)
      from public.member_mentorship_pairs p
      where p.organization_id = org
        and (p.mentor_user_id = caller or p.mentee_user_id = caller or staff)
    ), '[]'::jsonb),
    'mentorshipDirectory', case when staff then coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', m.user_id, 'label', private.member_support_member_label(m.user_id),
        'chapterId', own_chapter.id
      ) order by private.member_support_member_label(m.user_id), m.user_id)
      from public.organization_memberships m
      join public.member_profiles p on p.id = m.user_id
      -- #8368: the selected chapter only when it belongs to this organization.
      left join public.chapters own_chapter
        on own_chapter.id = p.chapter_id and own_chapter.organization_id = org
      where m.organization_id = org and m.status = 'active'
    ), '[]'::jsonb) else '[]'::jsonb end
  );
end;
end;
$function$;

create or replace function public.get_organization_intelligence_snapshot(p_selected_hat text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  neuro_on boolean;
begin
  if not private.mfa_satisfied() then raise exception 'mfa required' using errcode = '42501'; end if;
  if p_selected_hat not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
     or not private.has_organization_role(org, array[p_selected_hat]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112: with the Neuro Map
  -- switched off no relationship graph and no topic progress leave the server.
  neuro_on := private.organization_feature_enabled(org, 'features.intelligence.neuro_map') is true;
  return pg_catalog.jsonb_build_object(
    'organizationId', org,
    'generatedAt', pg_catalog.now(),
    'neuroMapEnabled', neuro_on,
    'chartNodes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', n.id, 'chapterId', n.chapter_id, 'chartKind', n.chart_kind,
        'nodeKind', n.node_kind, 'parentId', n.parent_id, 'label', n.label,
        'subtitle', n.subtitle, 'positionX', n.position_x, 'positionY', n.position_y,
        'sortOrder', n.sort_order,
        -- REQ-UG-TENANT-ORG-CHART-BASELINE-20261030: the stored seat
        -- state the editor changes, and the provenance it was judged against.
        'vacant', n.vacant, 'seatStatus', n.seat_status,
        'seatStatusReviewedOn', n.seat_status_reviewed_on,
        'sourceLabel', n.source_label, 'sourceAsOf', n.source_as_of
      ) order by n.chart_kind, n.sort_order, n.label, n.id)
      from (
        select scoped.*
        from public.organization_chart_nodes scoped
        where scoped.organization_id = org
        order by scoped.chart_kind, scoped.sort_order, scoped.label, scoped.id
        limit 5000
      ) n
    ), '[]'::jsonb),
    'relationshipNodes', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', scoped.user_id, 'label', scoped.full_name, 'chapterId', scoped.own_chapter_id,
        'roleLabel', p.role_line
      ) order by scoped.full_name, scoped.user_id)
      from (
        select m.user_id, profile.full_name, own_chapter.id as own_chapter_id
        from public.organization_memberships m
        join public.member_profiles profile on profile.id = m.user_id
        -- #8368: the selected chapter only when it belongs to this organization.
        left join public.chapters own_chapter
          on own_chapter.id = profile.chapter_id and own_chapter.organization_id = org
        where neuro_on and m.organization_id = org and m.status = 'active'
        order by profile.full_name, m.user_id
        limit 5000
      ) scoped
      join public.member_profiles p on p.id = scoped.user_id
    ), '[]'::jsonb),
    'relationships', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', r.id, 'sourceId', r.source_user_id, 'targetId', r.target_user_id,
        'kind', r.relationship_kind, 'strength', r.strength
      ) order by r.updated_at desc, r.id)
      from (
        select scoped.*
        from public.organization_relationships scoped
        where neuro_on and scoped.organization_id = org
        order by scoped.updated_at desc, scoped.id
        limit 5000
      ) r
    ), '[]'::jsonb),
    'topicProgress', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'memberId', t.member_user_id, 'topicKey', t.topic_key,
        'topicLabel', t.topic_label, 'state', t.progress_state,
        'progress', t.progress
      ) order by t.topic_label, t.member_user_id)
      from (
        select scoped.*
        from public.organization_topic_progress scoped
        where neuro_on and scoped.organization_id = org
        order by scoped.topic_label, scoped.member_user_id
        limit 5000
      ) t
    ), '[]'::jsonb),
    'timeline', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'chapterId', e.chapter_id, 'kind', e.event_kind,
        'title', e.title, 'detail', e.detail, 'effectiveOn', e.effective_on,
        'endedOn', e.ended_on, 'amountCents', e.amount_cents,
        'amountBasis', e.amount_basis, 'sourceLabel', e.source_label,
        'sourceAsOf', e.source_as_of
      ) order by e.effective_on desc, e.id desc)
      from (
        select scoped.*
        from public.organization_timeline_events scoped
        where scoped.organization_id = org
        order by scoped.effective_on desc, scoped.id desc
        limit 5000
      ) e
    ), '[]'::jsonb)
  );
end;
$function$;

-- CREATE OR REPLACE keeps both functions' authenticated-only ACLs.
-- Renew an existing reviewed account-lifecycle receipt; never add a receipt.
update private.account_lifecycle_trigger_review reviewed
   set definition_hash = pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid))
  from pg_catalog.pg_proc p
 where reviewed.kind = 'function' and reviewed.table_name = ''
   and p.oid in ('public.get_member_support_workspace()'::regprocedure,
                 'public.get_organization_intelligence_snapshot(text)'::regprocedure)
   and reviewed.schema_name = p.pronamespace::regnamespace::text
   and reviewed.object_name = p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')';
commit;
