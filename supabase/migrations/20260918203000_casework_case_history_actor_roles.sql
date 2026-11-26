-- UX-UG-CASE-HISTORY-ORG-STAFF-UNNAMED-ACTORS-20260917 — repair of
-- 20260917143000 (PR #2103).
--
-- public.casework_case_history is SECURITY INVOKER on purpose: the merged
-- timeline inherits each source table's own RLS, MFA and column grants, and
-- actor NAMES are resolved only from reads the caller already performs. That
-- design is unchanged here and is not up for renegotiation.
--
-- What was wrong is that the ROLE label rode on the same invoker read. The
-- `subject` CTE selects public.member_cases, and an organization advisor, admin
-- or vp is admitted to the case by private.casework_staff_can_access through
-- private.has_organization_role, while member_cases_select_coordinator still
-- demands public.staff_can_see_user(user_id, 'coordinator'), which that caller
-- may not hold. Measured on a disposable stack: six history rows, zero
-- member_cases rows, every event labelled 'staff' or null — including the case
-- member's own note. That is a false statement about who acted on the one
-- surface whose whole purpose is to say who acted, so the label moves to a
-- definer helper and the names do not.
--
-- private.casework_case_actor_roles is that helper. It is deliberately narrow:
--   * it reads public.member_cases as DEFINER — that read is the point, and the
--     record's own acceptance bullet 1 asks for exactly it — but it projects a
--     three-position LABEL and nothing else: never a name, never the case's
--     assignee ids, never a row or column of public.member_cases;
--   * it answers only for actor ids the CALLER supplies. The array is
--     caller-chosen, not page-derived, so the function cannot be described as
--     page-bounded: an authorized reader may ask about an id that does not
--     appear in its own feed and learn which of the three positions that id
--     holds. That is bounded by private.casework_can_read to one case the
--     caller already reads, it returns no id it was not given, and it returns
--     no name; it is still strictly more than the feed itself discloses, and
--     it is the one deliberate disclosure this repair makes;
--   * it refuses a null element and refuses more than 100 ids in one
--     statement, matching the reader's own page cap, so the assignee surface
--     cannot be swept in a single call;
--   * it is gated on private.casework_can_read, the same definer boundary the
--     page itself is gated on, so a caller with no read on the case gets
--     nothing from it either.
-- THE NAME RESOLUTION below is byte-identical to 20260917143000: it adds no
-- definer read of public.member_cases or public.member_profiles, and an actor
-- the caller may not name still carries actor_name null. That is the property
-- the record's acceptance bullet 2 protects, and it is the one this migration
-- claims; the labels-only helper above is a definer read and is not covered by
-- that sentence.
begin;
set local lock_timeout = '5s';

create function private.casework_case_actor_roles(
  p_case_id uuid, p_actor_user_ids uuid[]
)
returns table (actor_user_id uuid, actor_role text)
language plpgsql stable security definer set search_path = '' as $function$
begin
  -- The caller chooses this array, so it is bounded here rather than trusted.
  -- 100 is the reader's own page cap (public.casework_case_history clamps
  -- p_limit to 1..100), so a legitimate page can never trip this, and the
  -- assignee surface of a readable case cannot be swept in one statement.
  -- A null element is refused rather than silently skipped: it is always a
  -- caller error and skipping it would make the answer shorter than the
  -- question without saying so.
  if pg_catalog.array_length(p_actor_user_ids, 1) > 100 then
    raise exception 'too many case actor ids' using errcode = '22023';
  end if;
  if p_actor_user_ids is not null and pg_catalog.array_position(p_actor_user_ids, null) is not null then
    raise exception 'case actor ids must not contain null' using errcode = '22023';
  end if;
  return query
  select a.id,
    case
      when c.steward_user_id = a.id then 'steward'
      when c.coordinator_user_id = a.id then 'coordinator'
      when c.user_id = a.id then 'member'
      else 'staff'
    end
  from pg_catalog.unnest(coalesce(p_actor_user_ids, array[]::uuid[])) a(id)
  cross join public.member_cases c
  where c.id = p_case_id
    and private.casework_can_read(p_case_id);
end;
$function$;
revoke all on function private.casework_case_actor_roles(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function private.casework_case_actor_roles(uuid, uuid[]) to authenticated;

create or replace function public.casework_case_history(
  p_case_id uuid, p_limit integer default 50, p_before timestamptz default null
)
returns table (
  event_id text, kind text, at timestamptz,
  actor_user_id uuid, actor_name text, actor_role text, details jsonb
)
language sql stable security invoker set search_path = '' as $function$
  with events as (
    -- The note author is readable by anyone the row's own RLS already admits.
    select 'note:' || n.id event_id, 'note'::text kind, n.created_at at, n.user_id actor_user_id,
      pg_catalog.jsonb_build_object('body', n.body) details
    from public.member_case_updates n where n.case_id = p_case_id
    union all
    select 'transition:' || s.id, 'transition', s.created_at, s.transitioned_by,
      pg_catalog.jsonb_build_object('from_step', s.from_step, 'to_step', s.to_step, 'outcome', s.outcome)
    from public.casework_step_transitions s where s.case_id = p_case_id
    union all
    select 'assignment:' || a.id, 'assignment', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('before', a.before_assignment, 'after', a.after_assignment)
    from public.member_case_assignment_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'coordinator:' || a.id, 'coordinator', a.created_at, a.actor_id,
      pg_catalog.jsonb_build_object('action', a.action, 'before', a.before_value, 'after', a.after_value, 'reason', a.reason)
    from public.coordinator_case_audit a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select 'audit:' || a.id, 'audit', a.created_at, a.actor_user_id,
      pg_catalog.jsonb_build_object('action', a.event_type, 'metadata', a.metadata)
    from public.casework_audit_events a where a.case_id = p_case_id
      and private.casework_staff_can_access(p_case_id)
    union all
    select * from private.casework_history_versions(p_case_id)
  ), page as (
    select * from events where private.casework_can_read(p_case_id)
      and (p_before is null or events.at < p_before)
    order by events.at desc
    fetch first (greatest(1, least(coalesce(p_limit, 50), 100))) rows with ties
  -- Attribution is resolved under the CALLER's own visibility and nothing
  -- wider. public.member_profiles answers only for the accounts
  -- private.staff_visible_member_ids (the set-wise public.staff_can_see_user)
  -- already exposes, plus the caller's own row; the assignee labels stamped on
  -- public.member_cases are exactly the two staff names a member may already
  -- read on their own case, which is where the case detail's assignee line
  -- comes from. A member therefore names their own steward, their own
  -- coordinator and themselves, and no other staff account. An actor the
  -- caller may not name carries a role label instead: the uuid is never a
  -- display value.
  ), subject as (
    select c.user_id member_user_id, c.steward_user_id, c.steward_name,
      c.coordinator_user_id, c.coordinator_name
    from public.member_cases c where c.id = p_case_id
  -- A ROLE IS NOT ATTRIBUTION. The subject CTE above stays INVOKER because it
  -- carries the two assignee NAMES; a caller who cannot read the case row gets
  -- no names from it, which is the design. The role label is different: it says
  -- only which of three positions an actor the caller is ALREADY looking at
  -- occupies on this case. Deriving it from the same empty INVOKER read made an
  -- organization advisor see every event as 'staff', including the member's own
  -- note. private.casework_case_actor_roles is the definer helper that answers
  -- it, from the case row the existing definer read boundary already consults,
  -- for exactly the actor ids on this caller's own page and nothing else.
  ), roles as (
    select r.actor_user_id role_user_id, r.actor_role role_label
    from private.casework_case_actor_roles(
      p_case_id,
      -- `fetch first N rows with ties` can return more than the clamped page
      -- size, so the distinct actor list is capped here too. The helper's own
      -- guard is the authority; this keeps the reader provably inside it, and
      -- an id beyond the cap degrades to the historical 'staff' fallback below
      -- instead of raising in the feed.
      (select pg_catalog.array_agg(candidate.actor_user_id) from (
        select distinct page.actor_user_id from page
        where page.actor_user_id is not null limit 100
      ) candidate)
    ) r
  )
  select page.event_id, page.kind, page.at, page.actor_user_id,
    nullif(pg_catalog.btrim(coalesce(
      (select p.full_name from public.member_profiles p where p.id = page.actor_user_id),
      (select s.steward_name from subject s where s.steward_user_id = page.actor_user_id),
      (select s.coordinator_name from subject s where s.coordinator_user_id = page.actor_user_id),
      '')), ''),
    case
      when page.actor_user_id is null then null
      else coalesce((select r.role_label from roles r where r.role_user_id = page.actor_user_id), 'staff')
    end,
    page.details
  from page order by page.at desc, page.event_id desc;
$function$;
revoke all on function public.casework_case_history(uuid, integer, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.casework_case_history(uuid, integer, timestamptz) to authenticated;

commit;
