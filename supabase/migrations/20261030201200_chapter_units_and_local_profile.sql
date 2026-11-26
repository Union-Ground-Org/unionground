-- REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030 (#6562)
--
-- The Oct 29-30 role-play run (findings 11, 20, 24, 27): locals could not
-- model garages, crews or departments inside a chapter, invite people into a
-- chapter other than their own or into a unit, rename "chapter" and
-- "worksite" everywhere, or record the local's office and contract details.
--
-- 1. private.chapter_units: a unit or worksite that belongs to one chapter
--    (never a sibling chapter), with an optional headcount. Organization data
--    with no user column, read and written only through the functions below.
-- 2. private.organization_local_profiles: one row per organization with the
--    local's office address, phone, office hours, employer, contract dates,
--    board meeting schedule and time zone.
-- 3. private.member_invitation_units: the unit an invitation places its
--    member in. When the invitation (or the resend that replaced it) is
--    accepted, the unit's name becomes the member's profile worksite if they
--    have none yet; nothing else about the member changes.
-- 4. Who may invite where is unchanged: every unit write and
--    set_member_invitation_unit go through
--    private.member_invitation_chapter_administrable as 20261004010000 defined
--    it (an admin of a chapter they belong to in the selected organization).
--    Wider invitation rights belong to the scoped-roles record.
-- 5. The org-start guide's worksite check also counts these units.
-- 6. The organization label list gains term.chapter, term.chapters,
--    term.worksite and term.worksites: the words every label, menu and message
--    uses, renamed through the existing label mechanism (finding 27).
--
-- Every public function is SECURITY DEFINER with an empty search_path and
-- checks two-step sign-in itself (private.mfa_satisfied, directly or through
-- private.has_organization_role). Readers answer only for the caller's
-- selected organization; writers need the organization admin role, or for a
-- unit, the admin role of that unit's chapter.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.chapter_units (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on update cascade on delete cascade,
  chapter_id text not null references public.chapters(id) on update cascade on delete cascade,
  name text not null,
  kind text not null default 'unit',
  headcount integer,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint chapter_units_name_bounded
    check (pg_catalog.char_length(name) between 1 and 120 and name !~ '[[:cntrl:]<>]'),
  constraint chapter_units_kind check (kind in ('unit', 'worksite')),
  constraint chapter_units_headcount_bounded check (headcount is null or headcount between 0 and 1000000)
);
create unique index chapter_units_chapter_name_key on private.chapter_units (chapter_id, pg_catalog.lower(name));
create index chapter_units_organization_idx on private.chapter_units (organization_id, chapter_id);
alter table private.chapter_units enable row level security;
alter table private.chapter_units force row level security;
revoke all on table private.chapter_units from public, anon, authenticated, service_role;
create policy mfa_assurance on private.chapter_units as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.chapter_units is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC checks the caller''s organization and role.';
-- Organization and chapter children join the account case graph.
create trigger a00_case_graph_lock before insert or update or delete on private.chapter_units
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.chapter_units
for each row execute function private.lock_case_graph_row_keys('', '');
comment on table private.chapter_units is
  'REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: units and worksites inside a chapter, with headcounts. Read and written only through list_chapter_units, save_chapter_unit and delete_chapter_unit.';

create table private.organization_local_profiles (
  organization_id uuid primary key references public.organizations(id) on update cascade on delete cascade,
  office_address text,
  phone text,
  office_hours text,
  employer text,
  contract_starts_on date,
  contract_ends_on date,
  board_schedule text,
  time_zone text,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint organization_local_profiles_address_bounded
    check (office_address is null or (pg_catalog.char_length(office_address) between 1 and 300 and office_address !~ '[<>]')),
  constraint organization_local_profiles_phone_bounded
    check (phone is null or (pg_catalog.char_length(phone) between 7 and 40 and phone ~ '^[0-9+().\- ]+$')),
  constraint organization_local_profiles_hours_bounded
    check (office_hours is null or (pg_catalog.char_length(office_hours) between 1 and 200 and office_hours !~ '[[:cntrl:]<>]')),
  constraint organization_local_profiles_employer_bounded
    check (employer is null or (pg_catalog.char_length(employer) between 1 and 200 and employer !~ '[[:cntrl:]<>]')),
  constraint organization_local_profiles_schedule_bounded
    check (board_schedule is null or (pg_catalog.char_length(board_schedule) between 1 and 300 and board_schedule !~ '[<>]')),
  constraint organization_local_profiles_time_zone_bounded
    check (time_zone is null or pg_catalog.char_length(time_zone) between 1 and 64),
  constraint organization_local_profiles_contract_order
    check (contract_starts_on is null or contract_ends_on is null or contract_ends_on >= contract_starts_on)
);
alter table private.organization_local_profiles enable row level security;
alter table private.organization_local_profiles force row level security;
revoke all on table private.organization_local_profiles from public, anon, authenticated, service_role;
create policy mfa_assurance on private.organization_local_profiles as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.organization_local_profiles is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC checks the caller''s organization and role.';
-- Organization and chapter children join the account case graph.
create trigger a00_case_graph_lock before insert or update or delete on private.organization_local_profiles
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.organization_local_profiles
for each row execute function private.lock_case_graph_row_keys('', '');
comment on table private.organization_local_profiles is
  'REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: the local''s office, employer, contract and meeting details, one row per organization. Read and written only through get_organization_local_profile and save_organization_local_profile.';

create table private.member_invitation_units (
  invitation_id uuid primary key references public.member_invitations(id) on delete cascade,
  unit_id uuid not null references private.chapter_units(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.now()
);
create index member_invitation_units_unit_idx on private.member_invitation_units (unit_id);
alter table private.member_invitation_units enable row level security;
alter table private.member_invitation_units force row level security;
revoke all on table private.member_invitation_units from public, anon, authenticated, service_role;
create policy mfa_assurance on private.member_invitation_units as restrictive for all to authenticated using (private.mfa_satisfied()) with check (private.mfa_satisfied());
comment on policy mfa_assurance on private.member_invitation_units is 'Restrictive session MFA defense for RPC-only storage. No client table grants or permissive policy; every definer RPC checks the caller''s organization and role.';
-- Organization and chapter children join the account case graph.
create trigger a00_case_graph_lock before insert or update or delete on private.member_invitation_units
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.member_invitation_units
for each row execute function private.lock_case_graph_row_keys('', '');
comment on table private.member_invitation_units is
  'REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: the unit an invitation places its member in. Written only by set_member_invitation_unit; read by the acceptance trigger.';

-- The caller's selected organization, or null without a session, two-step
-- sign-in or an active membership.
create function private.chapter_units_context()
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when (select auth.uid()) is null or not private.mfa_satisfied() then null
    else private.current_member_organization()
  end;
$function$;
revoke all on function private.chapter_units_context() from public, anon, authenticated, service_role;

-- An organization admin manages units in every chapter of the selected
-- organization; a chapter admin manages the units of that chapter.
create function private.chapter_unit_manageable(p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.chapters c
    where c.id = p_chapter_id
      and c.organization_id = private.chapter_units_context()
  ) and (
    private.has_organization_role(private.chapter_units_context(), array['admin'])
    or private.member_has_chapter_role(p_chapter_id, array['admin'])
  );
$function$;
revoke all on function private.chapter_unit_manageable(text) from public, anon, authenticated, service_role;

create function private.chapter_unit_rows(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', u.id,
      'chapterId', u.chapter_id,
      'chapterName', c.name,
      'name', u.name,
      'kind', u.kind,
      'headcount', u.headcount)
    order by c.order_index, c.name, u.kind, pg_catalog.lower(u.name), u.id), '[]'::jsonb)
  from private.chapter_units u
  join public.chapters c on c.id = u.chapter_id
  where u.organization_id = p_organization_id;
$function$;
revoke all on function private.chapter_unit_rows(uuid) from public, anon, authenticated, service_role;

create function public.list_chapter_units()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.chapter_units_context();
  if org is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  return private.chapter_unit_rows(org);
end;
$function$;
revoke all on function public.list_chapter_units() from public, anon, authenticated, service_role;
grant execute on function public.list_chapter_units() to authenticated;

create function public.save_chapter_unit(
  p_unit_id uuid,
  p_chapter_id text,
  p_name text,
  p_kind text,
  p_headcount integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  org uuid;
  clean_name text := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g');
  clean_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_kind, 'unit')));
  existing private.chapter_units%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.chapter_units_context();
  if org is null or not private.chapter_unit_manageable(p_chapter_id) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(clean_name) not between 1 and 120 or clean_name ~ '[[:cntrl:]<>]'
     or clean_kind not in ('unit', 'worksite')
     or (p_headcount is not null and p_headcount not between 0 and 1000000) then
    raise exception 'invalid unit' using errcode = '22023';
  end if;
  if p_unit_id is null then
    insert into private.chapter_units (organization_id, chapter_id, name, kind, headcount)
    values (org, p_chapter_id, clean_name, clean_kind, p_headcount);
  else
    select * into existing from private.chapter_units u
    where u.id = p_unit_id and u.organization_id = org
    for update;
    -- A unit moves only between chapters the caller manages.
    if existing.id is null or not private.chapter_unit_manageable(existing.chapter_id) then
      raise exception 'unit not found' using errcode = 'P0002';
    end if;
    update private.chapter_units
    set chapter_id = p_chapter_id, name = clean_name, kind = clean_kind,
        headcount = p_headcount, updated_at = pg_catalog.now()
    where id = existing.id;
  end if;
  return private.chapter_unit_rows(org);
exception
  when unique_violation then
    raise exception 'unit name already used in this chapter' using errcode = '23505';
end;
end;
$function$;
revoke all on function public.save_chapter_unit(uuid, text, text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.save_chapter_unit(uuid, text, text, text, integer) to authenticated;

create function public.delete_chapter_unit(p_unit_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  org uuid;
  target private.chapter_units%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.chapter_units_context();
  if org is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  select * into target from private.chapter_units u
  where u.id = p_unit_id and u.organization_id = org
  for update;
  if target.id is null or not private.chapter_unit_manageable(target.chapter_id) then
    raise exception 'unit not found' using errcode = 'P0002';
  end if;
  -- A member's saved profile worksite is their own text and stays.
  delete from private.chapter_units where id = target.id;
  return private.chapter_unit_rows(org);
end;
end;
$function$;
revoke all on function public.delete_chapter_unit(uuid) from public, anon, authenticated, service_role;
grant execute on function public.delete_chapter_unit(uuid) to authenticated;

create function private.organization_local_profile_row(p_organization_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  select pg_catalog.jsonb_build_object(
    'officeAddress', p.office_address,
    'phone', p.phone,
    'officeHours', p.office_hours,
    'employer', p.employer,
    'contractStartsOn', p.contract_starts_on,
    'contractEndsOn', p.contract_ends_on,
    'boardSchedule', p.board_schedule,
    'timeZone', p.time_zone,
    'updatedAt', p.updated_at,
    'units', private.chapter_unit_rows(p_organization_id),
    'canEdit', private.has_organization_role(p_organization_id, array['admin']))
  from (select 1) one
  left join private.organization_local_profiles p on p.organization_id = p_organization_id;
$function$;
revoke all on function private.organization_local_profile_row(uuid) from public, anon, authenticated, service_role;

create function public.get_organization_local_profile()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.chapter_units_context();
  if org is null then
    raise exception 'organization membership required' using errcode = '42501';
  end if;
  return private.organization_local_profile_row(org);
end;
$function$;
revoke all on function public.get_organization_local_profile() from public, anon, authenticated, service_role;
grant execute on function public.get_organization_local_profile() to authenticated;

-- Blank text clears a field. Every field is replaced on each save.
create function public.save_organization_local_profile(p_profile jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  org uuid;
  field text;
  clean jsonb := '{}'::jsonb;
  starts_on date;
  ends_on date;
  zone text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  org := private.chapter_units_context();
  if org is null or not private.has_organization_role(org, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_profile is null or pg_catalog.jsonb_typeof(p_profile) <> 'object' then
    raise exception 'invalid profile' using errcode = '22023';
  end if;
  foreach field in array array['officeAddress', 'phone', 'officeHours', 'employer', 'boardSchedule', 'timeZone',
                              'contractStartsOn', 'contractEndsOn'] loop
    if p_profile ? field and pg_catalog.jsonb_typeof(p_profile -> field) not in ('string', 'null') then
      raise exception 'invalid profile' using errcode = '22023';
    end if;
    clean := clean || pg_catalog.jsonb_build_object(field,
      nullif(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_profile ->> field, '')), '[ \t]+', ' ', 'g'), ''));
  end loop;
  begin
    starts_on := (clean ->> 'contractStartsOn')::date;
    ends_on := (clean ->> 'contractEndsOn')::date;
  exception when others then
    raise exception 'invalid contract date' using errcode = '22023';
  end;
  zone := clean ->> 'timeZone';
  if zone is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = zone) then
    raise exception 'invalid time zone' using errcode = '22023';
  end if;
  begin
    insert into private.organization_local_profiles as p
      (organization_id, office_address, phone, office_hours, employer,
       contract_starts_on, contract_ends_on, board_schedule, time_zone, updated_at)
    values
      (org, clean ->> 'officeAddress', clean ->> 'phone', clean ->> 'officeHours', clean ->> 'employer',
       starts_on, ends_on, clean ->> 'boardSchedule', zone, pg_catalog.now())
    on conflict (organization_id) do update
      set office_address = excluded.office_address, phone = excluded.phone,
          office_hours = excluded.office_hours, employer = excluded.employer,
          contract_starts_on = excluded.contract_starts_on, contract_ends_on = excluded.contract_ends_on,
          board_schedule = excluded.board_schedule, time_zone = excluded.time_zone,
          updated_at = excluded.updated_at;
  exception when check_violation then
    raise exception 'invalid profile' using errcode = '22023';
  end;
  return private.organization_local_profile_row(org);
end;
end;
$function$;
revoke all on function public.save_organization_local_profile(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.save_organization_local_profile(jsonb) to authenticated;

-- The inviter names the unit right after create_member_invitation answered
-- with the new invitation; only their own pending invitation, only a unit of
-- that invitation's chapter, and only a chapter they may invite into.
create function public.set_member_invitation_unit(p_invitation_id uuid, p_unit_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
declare
  invitation public.member_invitations%rowtype;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into invitation from public.member_invitations i
  where i.id = p_invitation_id and i.invited_by = (select auth.uid()) and i.status = 'pending';
  if invitation.id is null
     or not private.member_invitation_chapter_administrable(invitation.chapter_id)
     or not exists (
       select 1 from private.chapter_units u
       where u.id = p_unit_id and u.chapter_id = invitation.chapter_id
         and u.organization_id = private.chapter_units_context()
     ) then
    raise exception 'invitation unit not permitted' using errcode = '42501';
  end if;
  insert into private.member_invitation_units (invitation_id, unit_id)
  values (invitation.id, p_unit_id)
  on conflict (invitation_id) do update set unit_id = excluded.unit_id, created_at = pg_catalog.now();
  return pg_catalog.jsonb_build_object('invitationId', invitation.id, 'unitId', p_unit_id);
end;
end;
$function$;
revoke all on function public.set_member_invitation_unit(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.set_member_invitation_unit(uuid, uuid) to authenticated;

-- On acceptance, the unit named on the invitation (or on the invitation a
-- resend replaced) becomes the member's profile worksite when they have none.
create function private.apply_member_invitation_unit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[new.auth_user_id], array[]::uuid[]);
declare
  unit_name text;
begin
  if new.auth_user_id is null then
    return null;
  end if;
  with recursive chain(id, replaces_id, depth) as (
    select i.id, i.replaces_id, 0 from public.member_invitations i where i.id = new.id
    union all
    select i.id, i.replaces_id, chain.depth + 1
    from public.member_invitations i
    join chain on i.id = chain.replaces_id
    where chain.depth < 20
  )
  select u.name into unit_name
  from chain
  join private.member_invitation_units link on link.invitation_id = chain.id
  join private.chapter_units u on u.id = link.unit_id and u.chapter_id = new.chapter_id
  order by chain.depth
  limit 1;
  if unit_name is null then
    return null;
  end if;
  insert into public.member_profile_details as d (user_id, worksite)
  values (new.auth_user_id, unit_name)
  on conflict (user_id) do update
    set worksite = excluded.worksite, updated_at = pg_catalog.now()
    where d.worksite is null;
  return null;
end;
end;
$function$;
revoke all on function private.apply_member_invitation_unit() from public, anon, authenticated, service_role;
comment on function private.apply_member_invitation_unit() is
  'Trigger: when an invitation becomes accepted, writes the unit it named (directly or through the invitation a resend replaced) as the new member''s profile worksite, only when the member has no worksite yet.';

create trigger z60_invitation_unit_on_accept
  after update of status on public.member_invitations
  for each row
  when (new.status = 'accepted' and old.status is distinct from 'accepted')
  execute function private.apply_member_invitation_unit();

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select s.kind, s.schema_name, s.table_name, s.object_name, s.definition_hash
from private.account_lifecycle_trigger_surface() s
where (s.kind = 'trigger' and s.schema_name = 'public' and s.table_name = 'member_invitations'
       and s.object_name = 'z60_invitation_unit_on_accept')
   or (s.kind = 'trigger' and s.schema_name = 'private'
       and s.table_name in ('chapter_units', 'organization_local_profiles', 'member_invitation_units')
       and s.object_name in ('a00_case_graph_lock', 'z99_case_graph_keys'))
   or (s.kind = 'function' and s.schema_name = 'private'
       and s.object_name = 'apply_member_invitation_unit()')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $assert_invitation_unit_trigger_review$
begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after invitation units';
  end if;
end;
$assert_invitation_unit_trigger_review$;

-- The org-start guide's structure milestone (20261029150000) also counts
-- units and worksites inside chapters, so setting them up on the Organization
-- page completes it.
create or replace function private.organization_start_milestones(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := p_organization_id;
  state_row private.organization_start_guide_state%rowtype;
  founder uuid;
  chapters_n integer;
  worksites_n integer;
  grants_n integer;
  invitations_n integer;
  steps_n integer;
  announcements_n integer;
  events_n integer;
  knowledge_n integer;
  ballots_n integer;
  support_n integer;
  spokes_n integer;
begin
  select * into state_row from private.organization_start_guide_state s where s.organization_id = org;

  select pg_catalog.count(*)::integer into chapters_n
  from public.chapters c where c.organization_id = org;
  -- Worksites named in the profile suggestion list, plus the units and
  -- worksites set up inside chapters on the Organization page.
  worksites_n := coalesce(pg_catalog.cardinality(
    private.organization_setting_text_list(org, 'lists.organizing.worksites')), 0)
    + (select pg_catalog.count(*)::integer from private.chapter_units u where u.organization_id = org);

  -- The founding administrator is the earliest admin grant; every other
  -- grant (another person, or another role) is someone brought in.
  select g.user_id into founder
  from public.organization_role_grants g
  where g.organization_id = org and g.role = 'admin'
  order by g.granted_at, g.user_id
  limit 1;
  select pg_catalog.count(*)::integer into grants_n
  from public.organization_role_grants g
  where g.organization_id = org and g.user_id is distinct from founder;
  select pg_catalog.count(*)::integer into invitations_n
  from public.member_invitations i
  join public.chapters c on c.id = i.chapter_id
  where c.organization_id = org and i.sent_at is not null;

  select pg_catalog.count(*)::integer into steps_n
  from public.organization_onboarding_steps s
  where s.organization_id = org and s.active;

  select pg_catalog.count(*)::integer into announcements_n
  from public.member_broadcasts b
  where b.organization_id = org and b.retracted_at is null;
  select pg_catalog.count(*)::integer into events_n
  from public.member_events e
  join public.chapters c on c.id = e.chapter_id
  where c.organization_id = org and e.cancelled_at is null;
  select (
    (select pg_catalog.count(*) from public.knowledge_collection_items k where k.organization_id = org)
    + (select pg_catalog.count(*) from public.organization_knowledge_files f where f.organization_id = org and f.review_status = 'approved')
  )::integer into knowledge_n;

  select pg_catalog.count(*)::integer into ballots_n
  from public.member_ballots b where b.organization_id = org and b.ballot_type = 'standard';

  select pg_catalog.count(*)::integer into support_n
  from public.organization_hr_directory d
  where d.organization_id = org and d.enabled and pg_catalog.btrim(d.name) <> '';

  select pg_catalog.count(*)::integer into spokes_n
  from private.organization_start_spokespeople sp
  where sp.organization_id = org;

  return pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('id', 'structure', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'chapters', 'done', chapters_n > 0, 'count', chapters_n, 'adminOnly', true),
      pg_catalog.jsonb_build_object('id', 'worksites', 'done', worksites_n > 0, 'count', worksites_n, 'adminOnly', true))),
    pg_catalog.jsonb_build_object('id', 'people', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'staffGrants', 'done', grants_n > 0, 'count', grants_n, 'adminOnly', true),
      pg_catalog.jsonb_build_object('id', 'invitationsSent', 'done', invitations_n > 0, 'count', invitations_n, 'adminOnly', true))),
    pg_catalog.jsonb_build_object('id', 'onboarding', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'activeSteps', 'done', steps_n > 0, 'count', steps_n, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'switchesReviewed', 'done', state_row.switches_reviewed_at is not null, 'count', 0, 'adminOnly', true))),
    pg_catalog.jsonb_build_object('id', 'content', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'announcements', 'done', announcements_n > 0, 'count', announcements_n, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'events', 'done', events_n > 0, 'count', events_n, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'knowledgeItems', 'done', knowledge_n > 0, 'count', knowledge_n, 'adminOnly', false))),
    pg_catalog.jsonb_build_object('id', 'ballot', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'ballotDraftWithSecrecy', 'done', ballots_n > 0, 'count', ballots_n, 'adminOnly', false))),
    pg_catalog.jsonb_build_object('id', 'support', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'supportPrograms', 'done', support_n > 0, 'count', support_n, 'adminOnly', false))),
    pg_catalog.jsonb_build_object('id', 'backups', 'checks', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('id', 'backupNamed', 'done', state_row.backup_user_id is not null, 'count', 0, 'adminOnly', false),
      pg_catalog.jsonb_build_object('id', 'spokespeople', 'done', spokes_n > 0, 'count', spokes_n, 'adminOnly', false)))
  );
end;
$function$;
revoke all on function private.organization_start_milestones(uuid) from public, anon, authenticated, service_role;

-- The terms every label, menu and message uses, renamed with the existing
-- organization label mechanism.
alter table public.organization_label_overrides
  drop constraint organization_label_overrides_key,
  add constraint organization_label_overrides_key check (label_key in (
    'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
    'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
    'admin.title', 'coordinator.title', 'advisor.title', 'vp.title',
    'term.chapter', 'term.chapters', 'term.worksite', 'term.worksites'
  ));

create or replace function public.update_organization_label(p_key text, p_value text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- The case-graph entry gate the base migrations installed, kept ahead of
  -- the declarations that read the caller's organization.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  org_id uuid := private.current_member_organization();
  caller uuid := (select auth.uid());
  clean text := pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g');
  valid_keys constant text[] := array[
    'nav.home', 'nav.myCases', 'nav.messages', 'nav.inbox', 'nav.knowRights',
    'nav.myChapter', 'nav.settings', 'staff.chapterWork', 'nav.casework',
    'admin.title', 'coordinator.title', 'advisor.title', 'vp.title',
    'term.chapter', 'term.chapters', 'term.worksite', 'term.worksites'
  ]::text[];
begin
  if org_id is null or not private.has_organization_role(org_id, array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if not (p_key = any(valid_keys)) then raise exception 'invalid label key' using errcode = '22023'; end if;
  if clean = '' then
    delete from public.organization_label_overrides where organization_id = org_id and label_key = p_key;
    insert into public.organization_configuration_audit (organization_id, actor_user_id, action, item_key)
    values (org_id, caller, 'label_removed', p_key);
    return pg_catalog.jsonb_build_object('key', p_key, 'value', null, 'removed', true);
  end if;
  -- A term is one or a few words that sit inside sentences.
  if pg_catalog.char_length(clean) > 40 or clean ~ '[<>[:cntrl:]]'
     or (p_key like 'term.%' and (pg_catalog.char_length(clean) > 30 or clean !~ '^[[:alpha:]][[:alpha:] ''&-]*$')) then
    raise exception 'invalid label value' using errcode = '22023';
  end if;
  insert into public.organization_label_overrides (organization_id, label_key, label_value, updated_by)
  values (org_id, p_key, clean, caller)
  on conflict (organization_id, label_key) do update
    set label_value = excluded.label_value, updated_by = excluded.updated_by, updated_at = pg_catalog.now();
  insert into public.organization_configuration_audit (organization_id, actor_user_id, action, item_key)
  values (org_id, caller, 'label_updated', p_key);
  return pg_catalog.jsonb_build_object('key', p_key, 'value', clean, 'updated', true);
end;
end;
$function$;
revoke all on function public.update_organization_label(text, text) from public, anon, authenticated, service_role;
grant execute on function public.update_organization_label(text, text) to authenticated;

commit;
