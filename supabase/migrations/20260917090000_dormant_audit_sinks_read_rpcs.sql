-- REQ-UG-DORMANT-68-AUDIT-SINKS-SURFACED-20260917
--
-- Five audit sinks are written by SQL and read by nothing. Two of them
-- (member_invitation_audit, organization_automation_definition_reviews) are
-- deny-by-default with no SELECT policy at all, so even an organization admin
-- could not see the evidence its own RPCs append. The other three carry a
-- SELECT policy but no reader: no RPC, no view, no client grant.
--
-- This migration adds one paged read RPC per sink. Each is SECURITY DEFINER
-- with an empty search_path, so it re-states the authorization its table's RLS
-- policy expresses instead of inheriting it:
--
--   * the caller's organization comes from private.mi1_require_selected_organization()
--     (authentication + MFA + active organization), never from an argument;
--   * case-scoped rows re-use the predicate each table's own SELECT policy
--     uses and nothing wider: public.staff_can_see_user(user_id, 'coordinator')
--     for coordinator_case_audit and member_case_assignment_audit, and the
--     organization-role-or-private.casework_staff_can_access pair for
--     casework_audit_events;
--   * the two policy-less sinks get an explicit role gate matching their
--     writers (organization admin for invitations, the automation approver
--     helper for definition reviews).
--
-- Every projection is a link, not content. Row images (before_value,
-- after_value, before_assignment, after_assignment), free text (reason,
-- actor_name, note) and unbounded jsonb (detail, metadata) are deliberately
-- NOT returned: the organization audit surface carries authorized record
-- references only. Paging is a (created_at, id) keyset so a page boundary
-- cannot duplicate or skip a row when new evidence lands mid-read.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function private.audit_sink_read_bounds(
  p_limit integer,
  p_before timestamptz,
  p_has_before_id boolean,
  p_since timestamptz,
  p_until timestamptz
)
returns integer
language plpgsql
immutable
security definer
set search_path = ''
as $function$
begin
  if p_since is not null and p_until is not null and p_since > p_until then
    raise exception 'audit date range ends before it starts' using errcode = '22023';
  end if;
  -- A half cursor silently re-reads the newest page instead of continuing, so
  -- it is refused rather than coerced.
  if (p_before is not null) <> coalesce(p_has_before_id, false) then
    raise exception 'audit cursor requires both the timestamp and the id' using errcode = '22023';
  end if;
  return greatest(1, least(coalesce(p_limit, 50), 200));
end;
$function$;

comment on function private.audit_sink_read_bounds(integer, timestamptz, boolean, timestamptz, timestamptz) is
  'Shared bound, keyset-cursor and date-range validation for the dormant audit sink readers; the third argument states whether the id half of the cursor is present.';

-- ---------------------------------------------------------------------------
-- 1. public.coordinator_case_audit (20260810200000)
-- ---------------------------------------------------------------------------
create or replace function public.list_coordinator_case_audit(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id bigint default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_case_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (array['case_updated', 'note_added', 'contact_logged', 'outcome_recorded']) then
    raise exception 'unknown coordinator case audit kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'coordinator_case_audit',
          'organizationId', c.organization_id,
          'chapterId', c.chapter_id,
          'kind', a.action,
          'caseId', a.case_id,
          'entityId', a.case_id,
          'memberUserId', a.user_id,
          'actorUserId', a.actor_id,
          'createdAt', a.created_at
        ) as item
      from public.coordinator_case_audit a
      join public.member_cases c on c.id = a.case_id
      where c.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or a.action = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        -- Exactly the table's SELECT policy (coordinator_case_audit_select_coordinator).
        and public.staff_can_see_user(a.user_id, 'coordinator')
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. public.member_invitation_audit (20260812105000)
-- ---------------------------------------------------------------------------
create or replace function public.list_member_invitation_audit(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_chapter_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (array[
       'invite_requested', 'invite_sent', 'invite_delivery_failed', 'invite_resent',
       'invite_revoked', 'invite_claimed', 'invite_accepted', 'invite_expired'
     ]) then
    raise exception 'unknown member invitation audit kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);
  -- This table has no SELECT policy: invitation evidence is admin-only, which
  -- is the same gate its create/resend/revoke RPCs enforce.
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'organization admin role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'member_invitation_audit',
          'organizationId', ch.organization_id,
          'chapterId', a.chapter_id,
          'kind', a.action,
          'entityId', a.invitation_id,
          'actorUserId', a.actor,
          'createdAt', a.created_at
        ) as item
      from public.member_invitation_audit a
      join public.chapters ch on ch.id = a.chapter_id
      where ch.organization_id = org
        and (p_chapter_id is null or a.chapter_id = p_chapter_id)
        and (p_kind is null or a.action = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. public.organization_automation_definition_reviews (20260911070000)
-- ---------------------------------------------------------------------------
create or replace function public.list_organization_automation_definition_reviews(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id uuid default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_definition_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (array['submitted', 'approved', 'changes_requested']) then
    raise exception 'unknown automation definition review kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);
  -- This table has no SELECT policy either. Reviews are approver evidence, so
  -- the reader gate is the same helper the review RPC requires of its writer.
  if not private.automation_v3_actor_is_approver((select auth.uid()), org) then
    raise exception 'automation approver role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'organization_automation_definition_reviews',
          'organizationId', a.organization_id,
          'kind', a.action,
          'entityId', a.definition_id,
          'definitionVersion', a.definition_version,
          'actorUserId', a.actor_id,
          'createdAt', a.created_at
        ) as item
      from public.organization_automation_definition_reviews a
      where a.organization_id = org
        and (p_definition_id is null or a.definition_id = p_definition_id)
        and (p_kind is null or a.action = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. public.member_case_assignment_audit (20260810210000)
-- ---------------------------------------------------------------------------
create or replace function public.list_member_case_assignment_audit(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id bigint default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_case_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  -- The table stores two assignment images and no kind column. The kind is
  -- derived from whether the case gained, changed, or lost its staff, so the
  -- filter never needs the images themselves to reach the caller.
  if p_kind is not null
     and p_kind <> all (array['assigned', 'reassigned', 'unassigned']) then
    raise exception 'unknown case assignment audit kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'member_case_assignment_audit',
          'organizationId', c.organization_id,
          'chapterId', c.chapter_id,
          'kind', derived.kind,
          'caseId', a.case_id,
          'entityId', a.case_id,
          'memberUserId', c.user_id,
          'actorUserId', a.actor_id,
          'createdAt', a.created_at
        ) as item
      from public.member_case_assignment_audit a
      join public.member_cases c on c.id = a.case_id
      cross join lateral (values (
        case
          when a.after_assignment->>'stewardUserId' is null
               and a.after_assignment->>'coordinatorUserId' is null then 'unassigned'
          when a.before_assignment->>'stewardUserId' is null
               and a.before_assignment->>'coordinatorUserId' is null then 'assigned'
          else 'reassigned'
        end
      )) as derived(kind)
      where c.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or derived.kind = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        -- Exactly the table's SELECT policy (member_case_assignment_audit_select_coordinator)
        -- for rows that have a case; the retained-case clause covers only case-less rows,
        -- which the member_cases join already excludes.
        and public.staff_can_see_user(c.user_id, 'coordinator')
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. public.casework_audit_events (20260828210000)
-- ---------------------------------------------------------------------------
create or replace function public.list_casework_audit_events(
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_id bigint default null,
  p_kind text default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_case_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  clamped integer;
begin
  if p_kind is not null
     and p_kind <> all (array[
       'strength_scored', 'deadline_requested', 'deadline_decided', 'checklist_created',
       'checklist_item_changed', 'step_advanced', 'restriction_changed', 'access_granted',
       'access_revoked', 'alert_created', 'alert_acknowledged', 'alert_escalated',
       'behavior_logged', 'retaliation_submitted', 'retaliation_withdrawn', 'pattern_detected',
       'draft_saved', 'bulk_updated', 'entity_linked', 'reminder_changed', 'bargaining_changed',
       'behavior_addendum_added', 'pattern_reviewed'
     ]) then
    raise exception 'unknown casework audit event kind' using errcode = '22023';
  end if;
  clamped := private.audit_sink_read_bounds(p_limit, p_before, p_before_id is not null, p_since, p_until);

  return coalesce((
    select pg_catalog.jsonb_agg(page.item order by page.created_at desc, page.id desc)
    from (
      select
        a.created_at,
        a.id,
        pg_catalog.jsonb_build_object(
          'id', a.id,
          'source', 'casework_audit_events',
          'organizationId', a.organization_id,
          'chapterId', a.chapter_id,
          'kind', a.event_type,
          'caseId', a.case_id,
          'entityId', a.entity_id,
          'actorUserId', a.actor_user_id,
          'createdAt', a.created_at
        ) as item
      from public.casework_audit_events a
      where a.organization_id = org
        and (p_case_id is null or a.case_id = p_case_id)
        and (p_kind is null or a.event_type = p_kind)
        and (p_since is null or a.created_at >= p_since)
        and (p_until is null or a.created_at <= p_until)
        and (p_before is null or (a.created_at, a.id) < (p_before, p_before_id))
        and (
          private.has_organization_role(a.organization_id, array['coordinator', 'advisor', 'admin', 'vp'])
          or (a.case_id is not null and private.casework_staff_can_access(a.case_id))
        )
      order by a.created_at desc, a.id desc
      limit clamped
    ) page
  ), '[]'::jsonb);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Execute privileges. PUBLIC, anon and service_role are revoked; only the
-- authenticated role that the definer bodies re-authorize may call them.
-- ---------------------------------------------------------------------------
revoke all on function private.audit_sink_read_bounds(integer, timestamptz, boolean, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.list_coordinator_case_audit(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_member_invitation_audit(integer, timestamptz, uuid, text, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
revoke all on function public.list_organization_automation_definition_reviews(integer, timestamptz, uuid, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_member_case_assignment_audit(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.list_coordinator_case_audit(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  to authenticated;
grant execute on function public.list_member_invitation_audit(integer, timestamptz, uuid, text, timestamptz, timestamptz, text)
  to authenticated;
grant execute on function public.list_organization_automation_definition_reviews(integer, timestamptz, uuid, text, timestamptz, timestamptz, uuid)
  to authenticated;
grant execute on function public.list_member_case_assignment_audit(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  to authenticated;
grant execute on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid)
  to authenticated;

comment on function public.list_coordinator_case_audit(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid) is
  'Paged organization-scoped read of the coordinator case audit sink; authorized record links only, never the before/after row images or the reason text.';
comment on function public.list_member_invitation_audit(integer, timestamptz, uuid, text, timestamptz, timestamptz, text) is
  'Paged organization-scoped read of the member invitation audit sink; organization admin only, and the bounded detail payload is never returned.';
comment on function public.list_organization_automation_definition_reviews(integer, timestamptz, uuid, text, timestamptz, timestamptz, uuid) is
  'Paged organization-scoped read of the automation definition review ledger; approver only, and the reviewer note is never returned.';
comment on function public.list_member_case_assignment_audit(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid) is
  'Paged organization-scoped read of the case assignment audit sink; the kind is derived from the two assignment images, which are never returned.';
comment on function public.list_casework_audit_events(integer, timestamptz, bigint, text, timestamptz, timestamptz, uuid) is
  'Paged organization-scoped read of the casework audit event sink; mirrors the table policy and never returns the bounded metadata payload.';

notify pgrst, 'reload schema';

commit;
