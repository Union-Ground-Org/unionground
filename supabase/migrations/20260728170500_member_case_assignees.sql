-- Case assignees: the design's "steward Sam Okafor · coordinator Jordan
-- Patel" line on a member's case, honestly backed.
--
-- Storage + a definer assignment RPC. NO new RLS policy and NO new member
-- column grant: member_cases stays the sole-writer table 20260725120000 made
-- it (members may update status/step/deadline only). Assignment flows
-- through assign_member_case(), gated on the coordinator/admin roles (cases
-- are coordinator-scoped for staff — the contract explicitly forbids a
-- steward read of member_cases), and the assignee NAMES are stamped
-- server-side the way
-- chapter_tasks stamps assignee_name (20260727010153) — a member cannot read
-- other members' profiles, so the display name must ride on the row.
--
-- ON DELETE SET NULL mirrors chapter_tasks.assignee_id: a departed staff
-- account clears the assignment rather than deleting the member's case.
--
-- LIVE APPLY NOTE (owner): member_cases holds ~200k rows in production. The
-- two partial indexes below build fine inside the migration for fresh
-- databases; on the live database prefer building them CONCURRENTLY as
-- separate statements before recording this migration, then let the
-- `if not exists` guards make these lines no-ops.

alter table public.member_cases
  add column if not exists steward_user_id uuid references auth.users(id) on delete set null,
  add column if not exists coordinator_user_id uuid references auth.users(id) on delete set null,
  add column if not exists steward_name text,
  add column if not exists coordinator_name text,
  add column if not exists assigned_at timestamptz;

create index if not exists member_cases_steward_idx
  on public.member_cases (steward_user_id)
  where steward_user_id is not null;

create index if not exists member_cases_coordinator_idx
  on public.member_cases (coordinator_user_id)
  where coordinator_user_id is not null;

create or replace function public.assign_member_case(
  p_case_id uuid,
  p_steward uuid default null,
  p_coordinator uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  case_owner uuid;
  steward_label text;
  coordinator_label text;
begin
  -- Cases are COORDINATOR-scoped for staff: the contract forbids any
  -- member_cases steward read ("a steward read here would widen the caseload
  -- plane"), so assignment is gated the same way. A steward can BE assigned;
  -- only a coordinator or admin assigns.
  if caller is null or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;

  select user_id into case_owner from public.member_cases where id = p_case_id;
  if case_owner is null then
    raise exception 'case not found' using errcode = 'P0002';
  end if;

  -- The caller must already be allowed to act for this member; reuse the
  -- visibility primitive the coordinator read policy uses, with the same
  -- role argument, instead of inventing a second scope rule.
  if not public.staff_can_see_user(case_owner, 'coordinator') then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  if p_steward is not null then
    if not exists (select 1 from public.member_roles where user_id = p_steward and role = 'steward') then
      raise exception 'assignee does not hold the steward role' using errcode = '23514';
    end if;
    select full_name into steward_label from public.member_profiles where id = p_steward;
  end if;

  if p_coordinator is not null then
    if not exists (select 1 from public.member_roles where user_id = p_coordinator and role = 'coordinator') then
      raise exception 'assignee does not hold the coordinator role' using errcode = '23514';
    end if;
    select full_name into coordinator_label from public.member_profiles where id = p_coordinator;
  end if;

  update public.member_cases
  set steward_user_id = p_steward,
      steward_name = steward_label,
      coordinator_user_id = p_coordinator,
      coordinator_name = coordinator_label,
      assigned_at = case when p_steward is null and p_coordinator is null then null else now() end
  where id = p_case_id;
end;
$$;

revoke all on function public.assign_member_case(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_member_case(uuid, uuid, uuid) to authenticated;
