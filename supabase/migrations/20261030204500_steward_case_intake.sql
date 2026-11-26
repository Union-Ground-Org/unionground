-- REQ-UG-STEWARD-CASEWORK-GAPS-20261030 (Oct 29-30 role-play run,
-- findings 22 and 23). Stewards could not open a case for a member, could not
-- put themselves on a case, never saw a member-started case until a
-- coordinator assigned it, and a case had nowhere to keep what happened, the
-- incident date, the remedy sought, or whether it is informal or filed.
--
-- 1. Four nullable case details on public.member_cases. No client grant: they
--    are written only by public.open_member_case below, and read through the
--    table's existing SELECT grant under the unchanged member_cases policies.
-- 2. public.open_member_case: the member's own intake (delegating to
--    public.create_member_case, then storing the details) or, for a steward,
--    coordinator or admin, a case opened for a member in their scope. A
--    steward who opens one is its steward, so it lands on their caseload.
-- 3. public.claim_member_case: a steward puts themselves on an active,
--    unassigned, unrestricted case of a member in their steward scope.
-- 4. public.list_unassigned_chapter_cases: the steward caseload's list of
--    those claimable cases (reference, title, type, step, deadline, member).
-- 5. public.list_case_member_candidates: the member picker for (2), members
--    of the caller's organization inside their staff scope, by name.
--
-- Writers take private.lock_case_graph first and declare no initializers
-- (scripts/account-case-graph-inventory.mjs); the member_cases row-key
-- triggers lock the case and member keys on insert and update.

begin;

alter table public.member_cases
  add column description text,
  add column incident_date date,
  add column remedy_sought text,
  add column filing_status text;

alter table public.member_cases
  add constraint member_cases_description_bounded
    check (description is null or pg_catalog.char_length(description) between 1 and 10000),
  add constraint member_cases_remedy_sought_bounded
    check (remedy_sought is null or pg_catalog.char_length(remedy_sought) between 1 and 2000),
  add constraint member_cases_filing_status_known
    check (filing_status is null or filing_status in ('informal', 'filed'));

comment on column public.member_cases.description is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: what happened, in full (the title stays the short line). Written only by public.open_member_case.';
comment on column public.member_cases.incident_date is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: the date the incident happened. Written only by public.open_member_case.';
comment on column public.member_cases.remedy_sought is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: what the member asks for. Written only by public.open_member_case.';
comment on column public.member_cases.filing_status is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: informal (not filed with the employer) or filed; null when nobody said. Written only by public.open_member_case.';

create or replace function public.open_member_case(
  p_member_id uuid,
  p_title text,
  p_case_type text,
  p_articles text,
  p_deadline date,
  p_description text,
  p_incident_date date,
  p_remedy_sought text,
  p_filing_status text,
  p_assign_self boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid;
  clean_title text;
  clean_articles text;
  clean_description text;
  clean_remedy text;
  steward_scope boolean;
  assign boolean;
  steward_label text;
  actor_label text;
  created jsonb;
  ref text;
  new_case uuid;
  attempts integer;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  clean_description := nullif(pg_catalog.btrim(coalesce(p_description, '')), '');
  clean_remedy := nullif(pg_catalog.btrim(coalesce(p_remedy_sought, '')), '');
  -- Bounds are raised, never clipped, as in public.create_member_case.
  if pg_catalog.char_length(clean_description) > 10000 then
    raise exception 'case description too long (10000 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_remedy) > 2000 then
    raise exception 'remedy sought too long (2000 characters max)' using errcode = '22023';
  end if;
  if p_filing_status is not null and p_filing_status not in ('informal', 'filed') then
    raise exception 'invalid filing status' using errcode = '22023';
  end if;
  if p_incident_date is not null
     and (p_incident_date < current_date - 3650 or p_incident_date > current_date + 1) then
    raise exception 'incident date out of range' using errcode = '22023';
  end if;

  -- The member's own intake keeps every rule, reference and award of
  -- public.create_member_case and adds the details to that same row.
  if p_member_id is null or p_member_id = caller then
    created := public.create_member_case(p_title, p_deadline, p_case_type, p_articles);
    update public.member_cases set
      description = clean_description,
      incident_date = p_incident_date,
      remedy_sought = clean_remedy,
      filing_status = p_filing_status
    where id = (created->>'caseId')::uuid and user_id = caller;
    return created || pg_catalog.jsonb_build_object('assigned', false);
  end if;

  -- A case opened for another member: staff in the member's scope only.
  if not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'steward, coordinator or admin role required' using errcode = '42501';
  end if;
  steward_scope := public.staff_can_see_user(p_member_id, 'steward');
  if not (steward_scope
          or public.staff_can_see_user(p_member_id, 'coordinator')
          or public.staff_can_see_user(p_member_id, 'admin')) then
    raise exception 'member outside your scope' using errcode = '42501';
  end if;

  clean_title := pg_catalog.btrim(coalesce(p_title, ''));
  clean_articles := pg_catalog.btrim(coalesce(p_articles, ''));
  if pg_catalog.char_length(clean_title) < 1 then
    raise exception 'case title is required' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_title) > 200 then
    raise exception 'case title too long (200 characters max)' using errcode = '22023';
  end if;
  if pg_catalog.char_length(clean_articles) > 500 then
    raise exception 'contract articles too long (500 characters max)' using errcode = '22023';
  end if;
  if p_case_type is null
     or p_case_type not in ('Discipline', 'Scheduling', 'Telework', 'Safety', 'Pay', 'Other') then
    raise exception 'invalid case type' using errcode = '22023';
  end if;
  if p_deadline is not null
     and (p_deadline < current_date - 3650 or p_deadline > current_date + 3650) then
    raise exception 'deadline out of range' using errcode = '22023';
  end if;

  -- A steward who opens the case is its steward, so it is on their caseload.
  assign := coalesce(p_assign_self, true) and steward_scope;
  if assign then
    select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  end if;

  attempts := 0;
  loop
    attempts := attempts + 1;
    ref := 'GR-' || pg_catalog.to_char(pg_catalog.now(), 'YYYY') || '-' || private.member_case_suffix();
    begin
      insert into public.member_cases (
        user_id, reference, title, deadline, case_type, articles, step,
        description, incident_date, remedy_sought, filing_status,
        steward_user_id, steward_name, assigned_at)
      values (
        p_member_id, ref, clean_title, p_deadline, p_case_type, clean_articles, 'Intake',
        clean_description, p_incident_date, clean_remedy, p_filing_status,
        case when assign then caller end,
        case when assign then coalesce(steward_label, 'Steward') end,
        case when assign then pg_catalog.now() end)
      returning id into new_case;
      exit;
    exception when unique_violation then
      if attempts >= 5 then
        raise exception 'could not allocate a case reference' using errcode = '23505';
      end if;
    end;
  end loop;

  if assign then
    actor_label := coalesce(steward_label, 'Staff member');
    insert into public.member_case_assignment_audit
      (case_id, actor_id, actor_name, before_assignment, after_assignment)
    values (new_case, caller, actor_label,
      pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
        'coordinatorUserId', null, 'coordinatorName', null),
      pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', coalesce(steward_label, 'Steward'),
        'coordinatorUserId', null, 'coordinatorName', null));
  end if;

  return pg_catalog.jsonb_build_object('caseId', new_case, 'reference', ref, 'assigned', assign);
end;
end;
end;
$function$;
revoke all on function public.open_member_case(uuid, text, text, text, date, text, date, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.open_member_case(uuid, text, text, text, date, text, date, text, text, boolean)
  to authenticated;
comment on function public.open_member_case(uuid, text, text, text, date, text, date, text, text, boolean) is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: a member''s own intake with case details (delegates to create_member_case), or a case a steward, coordinator or admin opens for a member in their staff scope; a steward opener becomes the case steward (audited).';

create or replace function public.claim_member_case(p_case_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
begin
  perform private.lock_message_lifecycle();
declare
  caller uuid;
  case_row public.member_cases%rowtype;
  steward_label text;
begin
  caller := (select auth.uid());
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;

  select c.* into case_row from public.member_cases c where c.id = p_case_id for update;
  -- Not found, out of scope and restricted collapse to one refusal, so a
  -- guessed id is no existence oracle. Scope is the case's own organization
  -- and chapter, not only the member's current profile: a member who moved
  -- to another organization must not carry an old case into its stewards'
  -- reach (gate round 1, r1s1).
  if not found
     or case_row.organization_id is distinct from (select private.current_member_organization())
     or not (private.has_organization_role(case_row.organization_id, array['steward'])
             or private.member_has_chapter_role(case_row.chapter_id, array['steward']))
     or not public.staff_can_see_user(case_row.user_id, 'steward')
     or case_row.is_restricted then
    raise exception 'case not found or outside your scope' using errcode = '42501';
  end if;
  if case_row.user_id = caller then
    raise exception 'a steward cannot take their own case' using errcode = '22023';
  end if;
  if case_row.status <> 'active' then
    raise exception 'only an active case can be taken' using errcode = '22023';
  end if;
  if case_row.steward_user_id = caller then
    return pg_catalog.jsonb_build_object('caseId', case_row.id, 'reference', case_row.reference, 'assigned', true);
  end if;
  if case_row.steward_user_id is not null then
    raise exception 'this case already has a steward' using errcode = '23505';
  end if;

  select p.full_name into steward_label from public.member_profiles p where p.id = caller;
  steward_label := coalesce(steward_label, 'Steward');
  update public.member_cases set
    steward_user_id = caller, steward_name = steward_label, assigned_at = pg_catalog.now()
  where id = case_row.id;

  insert into public.member_case_assignment_audit
    (case_id, actor_id, actor_name, before_assignment, after_assignment)
  values (case_row.id, caller, steward_label,
    pg_catalog.jsonb_build_object('stewardUserId', null, 'stewardName', null,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name),
    pg_catalog.jsonb_build_object('stewardUserId', caller, 'stewardName', steward_label,
      'coordinatorUserId', case_row.coordinator_user_id, 'coordinatorName', case_row.coordinator_name));

  return pg_catalog.jsonb_build_object('caseId', case_row.id, 'reference', case_row.reference, 'assigned', true);
end;
end;
end;
$function$;
revoke all on function public.claim_member_case(uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_member_case(uuid) to authenticated;
comment on function public.claim_member_case(uuid) is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: a steward puts themselves on an active, unassigned, unrestricted case of a member in their steward scope (never their own); audited like assign_member_case.';

create or replace function public.list_unassigned_chapter_cases()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward']) then
    raise exception 'steward role and MFA required' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', open_case.id,
      'reference', open_case.reference,
      'title', open_case.title,
      'caseType', open_case.case_type,
      'step', open_case.step,
      'deadline', open_case.deadline,
      'filingStatus', open_case.filing_status,
      'createdAt', open_case.created_at,
      'memberName', open_case.full_name
    ) order by open_case.deadline nulls last, open_case.created_at, open_case.id)
    from (
      select c.id, c.reference, c.title, c.case_type, c.step, c.deadline,
             c.filing_status, c.created_at, p.full_name
      from public.member_cases c
      join public.member_profiles p on p.id = c.user_id
      where c.status = 'active'
        and c.steward_user_id is null
        and not c.is_restricted
        and c.user_id <> caller
        and c.organization_id = (select private.current_member_organization())
        and (private.has_organization_role(c.organization_id, array['steward'])
             or private.member_has_chapter_role(c.chapter_id, array['steward']))
        and public.staff_can_see_user(c.user_id, 'steward')
      order by c.deadline nulls last, c.created_at, c.id
      limit 50
    ) open_case
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.list_unassigned_chapter_cases() from public, anon, authenticated, service_role;
grant execute on function public.list_unassigned_chapter_cases() to authenticated;
comment on function public.list_unassigned_chapter_cases() is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: the steward caseload''s claimable cases: active, unassigned, unrestricted cases of members in the caller''s steward scope (never their own), soonest deadline first, at most 50.';

create or replace function public.list_case_member_candidates(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
begin
  if caller is null or not private.mfa_satisfied()
     or not public.member_has_role(array['steward', 'coordinator', 'admin']) then
    raise exception 'steward, coordinator or admin role required' using errcode = '42501';
  end if;
  if pg_catalog.char_length(needle) < 2 or pg_catalog.char_length(needle) > 100 then
    raise exception 'query must be 2 to 100 characters' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    needle, '\', '\\'), '%', '\%'), '_', '\_');
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', found.id, 'fullName', found.full_name, 'chapterName', found.chapter_name
    ) order by found.full_name, found.id)
    from (
      select p.id, p.full_name, ch.name as chapter_name
      from public.member_profiles p
      join public.chapters ch
        on ch.id = p.chapter_id
       and ch.organization_id = (select private.current_member_organization())
      join public.organization_memberships om
        on om.user_id = p.id
       and om.organization_id = ch.organization_id
       and om.status = 'active'
      where p.id <> caller
        and p.full_name ilike '%' || needle || '%' escape '\'
        and (public.staff_can_see_user(p.id, 'steward')
             or public.staff_can_see_user(p.id, 'coordinator')
             or public.staff_can_see_user(p.id, 'admin'))
      order by p.full_name, p.id
      limit 20
    ) found
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.list_case_member_candidates(text) from public, anon, authenticated, service_role;
grant execute on function public.list_case_member_candidates(text) to authenticated;
comment on function public.list_case_member_candidates(text) is
  'REQ-UG-STEWARD-CASEWORK-GAPS-20261030: the member picker for opening a case for a member: active members of the caller''s organization inside their steward, coordinator or admin scope, by name (2-100 characters), at most 20, never the caller.';

notify pgrst, 'reload schema';

commit;
