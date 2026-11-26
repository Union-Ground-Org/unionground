-- Versioned migration; the serialized migration slot still owns final ordering
-- against current Main and the catalogue pins.
-- SEC-UG-APPOINTMENT-CHAPTER-NULL-CROSS-ORG-ELIGIBILITY-20260923
-- Preserve legacy steward/chapter selection; an organization-wide role is
-- organization-wide only inside an active membership of the chapter's tenant.
-- Do not add canonical-grant parity or change caller chapter selection here.
-- The chapter predicate lives in exactly one function. The member Home roster
-- (20260924170200_member_steward_roster_and_contact.sql) consumes the same helper and adds
-- its own publication filters; it does not redefine either function.
begin;

create or replace function private.member_stewards_for_chapter(p_chapter text)
returns table (steward_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct r.user_id
  from public.member_roles r
  join public.chapters c on c.id = p_chapter
  join public.organization_memberships membership
    on membership.organization_id = c.organization_id
   and membership.user_id = r.user_id
   and membership.status = 'active'
   and membership.revoked_at is null
  where r.role = 'steward'
    and (r.chapter_id is null or r.chapter_id = p_chapter)
$$;
revoke all on function private.member_stewards_for_chapter(text) from public, anon, authenticated;

create or replace function private.appointment_stewards_for_chapter(p_chapter text)
returns table (steward_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select e.steward_id
  from private.member_stewards_for_chapter(p_chapter) e
  where exists (
    select 1 from public.member_appointment_schedules s
    where s.steward_id = e.steward_id and s.accepting
  )
$$;
revoke all on function private.appointment_stewards_for_chapter(text) from public, anon, authenticated;

commit;
