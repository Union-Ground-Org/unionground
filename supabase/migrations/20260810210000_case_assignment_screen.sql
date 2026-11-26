-- UB-CASE-03: a real coordinator assignment screen needs a bounded candidate
-- read and an assignment boundary that cannot cross chapter scope.

create table public.member_case_assignment_audit (
  id bigint generated always as identity primary key,
  case_id uuid not null references public.member_cases(id),
  actor_id uuid not null,
  actor_name text not null,
  before_assignment jsonb not null,
  after_assignment jsonb not null,
  created_at timestamptz not null default now()
);

create index member_case_assignment_audit_case_created_idx
  on public.member_case_assignment_audit (case_id, created_at desc, id desc);
create index member_case_assignment_audit_actor_created_idx
  on public.member_case_assignment_audit (actor_id, created_at desc);

alter table public.member_case_assignment_audit enable row level security;
create policy member_case_assignment_audit_select_coordinator
  on public.member_case_assignment_audit for select to authenticated
  using (exists (
    select 1 from public.member_cases c
    where c.id = member_case_assignment_audit.case_id
      and public.staff_can_see_user(c.user_id, 'coordinator')
  ));
create policy mfa_assurance on public.member_case_assignment_audit
  as restrictive for all to authenticated using (private.mfa_satisfied())
  with check (private.mfa_satisfied());

revoke all on table public.member_case_assignment_audit from public, anon, authenticated;
grant select on table public.member_case_assignment_audit to authenticated;

create function private.prevent_case_assignment_audit_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'case assignment audit is immutable' using errcode = '42501';
end;
$$;
revoke all on function private.prevent_case_assignment_audit_mutation() from public, anon, authenticated;
create trigger member_case_assignment_audit_immutable
before update or delete on public.member_case_assignment_audit
for each row execute function private.prevent_case_assignment_audit_mutation();

create or replace function public.list_member_case_assignment_candidates(p_case_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  case_owner uuid;
  case_chapter text;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role and MFA required' using errcode = '42501';
  end if;

  select c.user_id, p.chapter_id into case_owner, case_chapter
  from public.member_cases c
  join public.member_profiles p on p.id = c.user_id
  where c.id = p_case_id;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not public.staff_can_see_user(case_owner, 'coordinator') then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', eligible.user_id,
      'fullName', eligible.full_name,
      'roles', eligible.roles
    ) order by eligible.full_name, eligible.user_id)
    from (
      select r.user_id, p.full_name,
             pg_catalog.jsonb_agg(r.role order by r.role) as roles
      from public.member_roles r
      join public.member_profiles p on p.id = r.user_id
      where r.role in ('steward', 'coordinator')
        and (r.chapter_id is null or r.chapter_id = case_chapter)
      group by r.user_id, p.full_name
      order by p.full_name, r.user_id
      limit 200
    ) eligible
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_member_case_assignment_candidates(uuid) from public, anon;
grant execute on function public.list_member_case_assignment_candidates(uuid) to authenticated;

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
  case_row public.member_cases%rowtype;
  case_chapter text;
  steward_label text;
  coordinator_label text;
  actor_label text;
  before_value jsonb;
  after_value jsonb;
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['coordinator', 'admin']) then
    raise exception 'coordinator role and MFA required' using errcode = '42501';
  end if;

  select c.* into case_row from public.member_cases c where c.id = p_case_id for update;
  if not found then raise exception 'case not found' using errcode = 'P0002'; end if;
  if not public.staff_can_see_user(case_row.user_id, 'coordinator') then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;
  select p.chapter_id into case_chapter from public.member_profiles p where p.id = case_row.user_id;

  if p_steward is not null then
    select p.full_name into steward_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_steward and r.role = 'steward'
      and (r.chapter_id is null or r.chapter_id = case_chapter);
    if not found then raise exception 'steward is outside case scope or lacks role' using errcode = '23514'; end if;
  end if;
  if p_coordinator is not null then
    select p.full_name into coordinator_label
    from public.member_roles r join public.member_profiles p on p.id = r.user_id
    where r.user_id = p_coordinator and r.role = 'coordinator'
      and (r.chapter_id is null or r.chapter_id = case_chapter);
    if not found then raise exception 'coordinator is outside case scope or lacks role' using errcode = '23514'; end if;
  end if;

  before_value := pg_catalog.jsonb_build_object(
    'stewardUserId', case_row.steward_user_id, 'stewardName', case_row.steward_name,
    'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name
  );
  after_value := pg_catalog.jsonb_build_object(
    'stewardUserId', p_steward, 'stewardName', steward_label,
    'coordinatorUserId', p_coordinator, 'coordinatorName', coordinator_label
  );
  if before_value = after_value then return; end if;

  update public.member_cases set
    steward_user_id = p_steward, steward_name = steward_label,
    coordinator_user_id = p_coordinator, coordinator_name = coordinator_label,
    assigned_at = case when p_steward is null and p_coordinator is null then null else now() end
  where id = p_case_id;

  actor_label := coalesce(
    (select p.full_name from public.member_profiles p where p.id = caller),
    'Staff member'
  );
  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (p_case_id, caller, actor_label, before_value, after_value);
end;
$$;

revoke all on function public.assign_member_case(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_member_case(uuid, uuid, uuid) to authenticated;
