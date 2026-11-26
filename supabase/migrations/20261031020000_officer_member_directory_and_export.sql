begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- REQ-UG-OFFICER-MEMBER-ROSTER-AND-EXPORT-20261030 (#6563), under
-- a project decision item 4 (roster export fields and non-admin
-- presidents' access):
--
--   * private.member_directory_officer(org, chapter): the caller holds an
--     office that reads the member directory of their own chapter. A chapter
--     President is the chapter's vp role (private.member_has_chapter_role,
--     which carries the MFA term); a Secretary-Treasurer is the explicit
--     budget office secretary_treasurer on an active membership
--     (20261009003000), behind the same MFA and staff second-factor terms.
--     Display titles still grant nothing.
--   * public.get_admin_member_directory admits those officers. Their scope is
--     already the chapter: only an organization admin reads the organization.
--     Rows and fields are unchanged; displayTitleEditable stays the chapter
--     admin rule, so officers cannot edit titles.
--   * public.export_member_directory_csv(org, chapter, locale): the server
--     builds, for the directory context the page displayed, a CSV of
--     exactly the directory's fields for every row the caller may see: full
--     name, member-since year, chapter, officer title and staff roles, plus
--     pronouns, job title, worksite, shift, job classification and phone only
--     where the member shared them with administrators. Full session only,
--     at most 5,000 rows, cells that a spreadsheet would read as a formula are
--     prefixed with an apostrophe, and every export writes one
--     organization_audit_ledger row (who, when, scope, row count).
--   * public.get_member_directory_access(): a mount-time probe that tells an
--     officer page whether to offer the directory; it reveals no member data.
--   * Privacy 1.3.2 (nonmaterial): the recipients section states that
--     officers may export the member list they can already see, without
--     unshared contact details. Accepted history stays untouched.
--
-- The maintainers sequence hosted application in migration stamp order.

do $predecessors$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('public.get_admin_member_directory(text,text,uuid,integer)')
      and pg_catalog.md5(p.prosrc) = 'deb9eafe32245334c7924c5346f387b7'
  ) then
    raise exception 'officer directory access requires the reviewed member directory (20261008232000)' using errcode = '55000';
  end if;
end;
$predecessors$;

create or replace function private.member_directory_officer(p_organization_id uuid, p_chapter_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select auth.uid()) is not null
    -- A restricted PIN session reads neither shared profile details nor the
    -- budget; it holds no office read either.
    and not private.member_pin_session_restricted()
    and p_organization_id is not null
    and p_chapter_id is not null
    and exists (
      select 1 from public.chapters c
      where c.id = p_chapter_id and c.organization_id = p_organization_id
    )
    and (
      private.member_has_chapter_role(p_chapter_id, array['vp'])
      or (
        (select private.mfa_satisfied())
        and (
          not private.staff_mfa_required(p_organization_id)
          or private.has_second_factor((select auth.uid()))
        )
        and exists (
          select 1 from public.organization_memberships om
          where om.user_id = (select auth.uid())
            and om.organization_id = p_organization_id
            and om.status = 'active'
        )
        and exists (
          select 1 from public.member_chapter_memberships m
          where m.user_id = (select auth.uid())
            and m.chapter_id = p_chapter_id
            and m.status = 'active'
            and m.budget_office = 'secretary_treasurer'
        )
      )
    );
$function$;

revoke all on function private.member_directory_officer(uuid, text)
  from public, anon, authenticated, service_role;

comment on function private.member_directory_officer(uuid, text) is
  'True when the caller is the chapter President (vp role) or the assigned Secretary-Treasurer (budget_office) of this chapter of the selected organization. Reads no display title.';

create or replace function public.get_admin_member_directory(
  p_query text default null,
  p_after_name text default null,
  p_after_id uuid default null,
  p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  org_admin boolean := private.has_organization_role(caller_org, array['admin']);
  needle text := pg_catalog.btrim(coalesce(p_query, ''));
  cap integer := coalesce(p_limit, 25);
  result jsonb;
begin
  if caller is null or caller_org is null or caller_chapter is null
     or not (org_admin or private.member_has_chapter_role(caller_chapter, array['admin'])
       or private.member_directory_officer(caller_org, caller_chapter)) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if cap < 1 or cap > 50 then
    raise exception 'limit out of range' using errcode = '22023';
  end if;
  if (p_after_name is null and p_after_id is not null)
     or (p_after_name is not null and p_after_id is null) then
    raise exception 'incomplete cursor' using errcode = '22023';
  end if;
  if needle <> '' and pg_catalog.char_length(needle) < 2 then
    raise exception 'query too short' using errcode = '22023';
  end if;
  needle := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
    needle, '\', '\\'), '%', '\%'), '_', '\_');

  with candidates as materialized (
    select p.id, p.full_name, p.initials,
      p.member_since::integer as member_since_year,
      located.chapter_id, located.chapter_name, located.display_title,
      private.organization_member_roles(
        p.id, caller_org, case when org_admin then null else caller_chapter end
      ) as roles,
      -- Only the fields the member shared with administrators leave this row.
      case when d.details_visibility = 'admins' then d.pronouns end as shared_pronouns,
      case when d.details_visibility = 'admins' then d.job_title end as shared_job_title,
      case when d.details_visibility = 'admins' then d.worksite end as shared_worksite,
      case when d.details_visibility = 'admins' then d.shift end as shared_shift,
      case when d.details_visibility = 'admins' then d.classification end as shared_classification,
      case when d.phone_visibility = 'admins' then d.phone end as shared_phone
    from public.member_profiles p
    join public.organization_memberships om
      on om.user_id = p.id
     and om.organization_id = caller_org
     and om.status = 'active'
    join lateral (
      select c.id as chapter_id, c.name as chapter_name, cm.display_title
      from public.member_chapter_memberships cm
      join public.chapters c
        on c.id = cm.chapter_id
       and c.organization_id = caller_org
      where cm.user_id = p.id
        and cm.status = 'active'
        and (org_admin or c.id = caller_chapter)
      order by (c.id = p.chapter_id) desc, c.order_index, c.id
      limit 1
    ) located on true
    left join public.member_profile_details d on d.user_id = p.id
    where (needle = '' or p.full_name ilike '%' || needle || '%' escape '\')
      and (p_after_name is null or (p.full_name, p.id) > (p_after_name, p_after_id))
    order by p.full_name, p.id
    limit cap + 1
  ), page as (
    select * from candidates order by full_name, id limit cap
  )
  select pg_catalog.jsonb_build_object(
    -- The context these rows were read under; the export binds to it.
    'context', pg_catalog.jsonb_build_object('organizationId', caller_org, 'chapterId', caller_chapter),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'userId', s.id,
        'fullName', s.full_name,
        'initials', s.initials,
        'memberSince', s.member_since_year,
        'chapterId', s.chapter_id,
        'chapterName', s.chapter_name,
        'displayTitle', s.display_title,
        'displayTitleEditable', private.member_invitation_chapter_administrable(s.chapter_id),
        'roles', s.roles,
        'profileDetails', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
          'pronouns', s.shared_pronouns,
          'jobTitle', s.shared_job_title,
          'worksite', s.shared_worksite,
          'shift', s.shared_shift, 'classification', s.shared_classification,
          'phone', s.shared_phone
        ))
      ) order by s.full_name, s.id)
      from page s
    ), '[]'::jsonb),
    'nextCursor', case when (select pg_catalog.count(*) from candidates) > cap then (
      select pg_catalog.jsonb_build_object('name', s.full_name, 'id', s.id)
      from page s order by s.full_name desc, s.id desc limit 1
    ) else null end
  ) into result;
  return result;
end;
$function$;

revoke all on function public.get_admin_member_directory(text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_admin_member_directory(text, text, uuid, integer)
  to authenticated;

-- One CSV cell: quoted, quotes doubled, and a leading = + - @ tab, carriage
-- return or line feed neutralized with an apostrophe so a spreadsheet never
-- runs it.
create or replace function private.member_directory_csv_cell(p_value text)
returns text
language sql
immutable
set search_path = ''
as $function$
  select case
    when p_value is null then ''
    else '"' || pg_catalog.replace(
      case when p_value ~ '^[=+@\t\r\n-]' then '''' || p_value else p_value end,
      '"', '""') || '"'
  end;
$function$;

revoke all on function private.member_directory_csv_cell(text)
  from public, anon, authenticated, service_role;

create or replace function public.export_member_directory_csv(
  p_expected_org uuid,
  p_expected_chapter text,
  p_locale text default 'en'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  caller_org uuid;
  caller_chapter text;
  org_admin boolean;
  chapter_admin boolean;
  officer boolean;
  basis text;
  spanish boolean;
  total integer;
  lines text;
  header text;
  crlf text;
begin
  -- The audit write joins the case graph: take its lock before anything else.
  perform private.lock_case_graph(array[(select auth.uid())], array[]::uuid[]);
  caller := (select auth.uid());
  caller_org := private.current_member_organization();
  caller_chapter := private.current_member_chapter();
  org_admin := false;
  chapter_admin := false;
  officer := false;
  spanish := p_locale = 'es';
  crlf := pg_catalog.chr(13) || pg_catalog.chr(10);
  perform private.member_pin_require_full_session();
  if not private.mfa_satisfied() then
    raise exception 'MFA required' using errcode = '42501';
  end if;
  if p_locale is null or p_locale not in ('en', 'es') then
    raise exception 'locale out of range' using errcode = '22023';
  end if;
  if caller is null or caller_org is null or caller_chapter is null then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  -- The page exports the directory it displayed: a chapter or organization
  -- switched since then (another tab) refuses rather than exporting another
  -- list under the old one.
  if caller_org is distinct from p_expected_org or caller_chapter is distinct from p_expected_chapter then
    raise exception 'directory context changed' using errcode = '40001';
  end if;
  -- The internal platform organization stays outside union exports
  -- (AGENTS.md; private.organization_export_dataset, 20261028080000).
  if not private.organization_is_union(caller_org) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;
  org_admin := private.has_organization_role(caller_org, array['admin']);
  if not org_admin then
    chapter_admin := private.member_has_chapter_role(caller_chapter, array['admin']);
    if not chapter_admin then
      officer := private.member_directory_officer(caller_org, caller_chapter);
    end if;
  end if;
  if not (org_admin or chapter_admin or officer) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  basis := case
    when org_admin then 'organization_admin'
    when chapter_admin then 'chapter_admin'
    when private.member_has_chapter_role(caller_chapter, array['vp']) then 'president'
    else 'secretary_treasurer'
  end;

  -- The same rows and fields as get_admin_member_directory, without paging.
  with visible as materialized (
    select p.id, p.full_name,
      p.member_since::integer as member_since_year,
      located.chapter_name, located.display_title,
      private.organization_member_roles(
        p.id, caller_org, case when org_admin then null else caller_chapter end
      ) as roles,
      -- Only the fields the member shared with administrators leave this row.
      case when d.details_visibility = 'admins' then d.pronouns end as shared_pronouns,
      case when d.details_visibility = 'admins' then d.job_title end as shared_job_title,
      case when d.details_visibility = 'admins' then d.worksite end as shared_worksite,
      case when d.details_visibility = 'admins' then d.shift end as shared_shift,
      case when d.details_visibility = 'admins' then d.classification end as shared_classification,
      case when d.phone_visibility = 'admins' then d.phone end as shared_phone
    from public.member_profiles p
    join public.organization_memberships om
      on om.user_id = p.id
     and om.organization_id = caller_org
     and om.status = 'active'
    join lateral (
      select c.id as chapter_id, c.name as chapter_name, cm.display_title
      from public.member_chapter_memberships cm
      join public.chapters c
        on c.id = cm.chapter_id
       and c.organization_id = caller_org
      where cm.user_id = p.id
        and cm.status = 'active'
        and (org_admin or c.id = caller_chapter)
      order by (c.id = p.chapter_id) desc, c.order_index, c.id
      limit 1
    ) located on true
    left join public.member_profile_details d on d.user_id = p.id
  )
  select pg_catalog.count(*)::integer,
    pg_catalog.string_agg(pg_catalog.concat_ws(',',
      private.member_directory_csv_cell(v.full_name),
      private.member_directory_csv_cell(v.member_since_year::text),
      private.member_directory_csv_cell(v.chapter_name),
      private.member_directory_csv_cell(v.display_title),
      private.member_directory_csv_cell((
        select pg_catalog.string_agg(case r.role
          when 'steward' then case when spanish then 'Delegado' else 'Steward' end
          when 'coordinator' then case when spanish then 'Coordinador' else 'Coordinator' end
          when 'advisor' then case when spanish then 'Asesor' else 'Advisor' end
          when 'admin' then 'Admin'
          when 'vp' then case when spanish then 'Presidente' else 'President' end
          else r.role end, '; ' order by r.role)
        from pg_catalog.jsonb_array_elements_text(v.roles) as r(role)
      )),
      private.member_directory_csv_cell(v.shared_pronouns),
      private.member_directory_csv_cell(v.shared_job_title),
      private.member_directory_csv_cell(v.shared_worksite),
      private.member_directory_csv_cell(v.shared_shift),
      private.member_directory_csv_cell(v.shared_classification),
      private.member_directory_csv_cell(v.shared_phone)
    ), crlf order by v.full_name, v.id)
  into total, lines
  from visible v;

  -- At most 5,000 rows in one file.
  if total > 5000 then
    raise exception 'export too large' using errcode = '54000';
  end if;

  header := case when spanish
    then 'Nombre completo,Miembro desde,Capítulo,Título de cargo,Funciones del personal,Pronombres,Puesto,Lugar de trabajo,Turno,Clasificación del puesto,Teléfono'
    else 'Full name,Member since,Chapter,Officer title,Staff roles,Pronouns,Job title,Worksite,Shift,Job classification,Phone'
  end;

  insert into public.organization_audit_ledger
    (organization_id, domain, event_type, action, actor_user_id, entity_type, entity_id, idempotency_key, metadata)
  values (caller_org, 'exports', 'member_directory_export', 'export', caller,
    case when org_admin then 'organization' else 'chapter' end,
    case when org_admin then caller_org::text else caller_chapter end,
    extensions.gen_random_uuid(),
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'chapterId', case when org_admin then null else caller_chapter end,
      'count', total,
      'exportType', 'member_directory_csv',
      'role', basis)));

  return pg_catalog.jsonb_build_object(
    'csv', header || crlf || coalesce(lines || crlf, ''),
    'rowCount', total,
    'scope', case when org_admin then 'organization' else 'chapter' end,
    'chapterId', case when org_admin then null else caller_chapter end
  );
end;
$function$;

revoke all on function public.export_member_directory_csv(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.export_member_directory_csv(uuid, text, text)
  to authenticated;

-- Metadata only: an ordinary member learns false and nothing else.
create or replace function public.get_member_directory_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_org uuid := private.current_member_organization();
  caller_chapter text := private.current_member_chapter();
  scope text;
begin
  if (select auth.uid()) is null or caller_org is null or caller_chapter is null
     or not private.mfa_satisfied() then
    return pg_catalog.jsonb_build_object('canRead', false);
  end if;
  if private.has_organization_role(caller_org, array['admin']) then
    scope := 'organization';
  elsif private.member_has_chapter_role(caller_chapter, array['admin'])
     or private.member_directory_officer(caller_org, caller_chapter) then
    scope := 'chapter';
  end if;
  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'canRead', scope is not null,
    'scope', scope,
    'chapterId', case when scope = 'chapter' then caller_chapter end));
end;
$function$;

revoke all on function public.get_member_directory_access()
  from public, anon, authenticated;
grant execute on function public.get_member_directory_access()
  to authenticated;

-- Privacy 1.3.2: one recipients sentence for the officer member-list export.
-- Nonmaterial; earlier 1.3.0 and 1.3.1 acceptances stay valid. The predecessor
-- is the privacy 1.3.1 validator (20261031000500); this keeps every other
-- instrument and moves only privacy. Refuse an unexpected predecessor rather
-- than overwrite a newer policy.
do $previous_pack$
begin
  if not exists (
    select 1 from pg_catalog.pg_proc p
    where p.oid = pg_catalog.to_regprocedure('private.legal_acceptance_versions(jsonb)')
      and pg_catalog.md5(p.prosrc) = '4d8b1855d88b0d512dea05152b13528b'
      and not p.prosecdef and p.provolatile = 'i'
  ) then
    raise exception 'privacy 1.3.2 requires the reviewed privacy 1.3.1 validator' using errcode = '55000';
  end if;
end;
$previous_pack$;

create or replace function private.legal_acceptance_versions(p_versions jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  entry record;
begin
  if p_versions is null
    or pg_catalog.jsonb_typeof(p_versions) <> 'object'
    or p_versions = '{}'::jsonb
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_versions)) > 32
  then
    raise exception 'legal versions required' using errcode = '22023';
  end if;
  for entry in select key, value from pg_catalog.jsonb_each_text(p_versions) loop
    if entry.key !~ '^[a-z][a-z0-9-]{1,62}$'
      or entry.value !~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}$'
    then
      raise exception 'legal versions malformed' using errcode = '22023';
    end if;
  end loop;
  if p_versions ->> 'terms-of-use' is null then
    raise exception 'terms version required' using errcode = '22023';
  end if;
  -- published-legal-versions: generated from currentLegalVersions(); the
  -- regression test pins this database authority to the rendered pack.
  if p_versions <> '{"privacy-policy":"1.3.2","terms-of-use":"1.1.0","accessibility-statement":"1.0.0","ai-disclosure":"1.1.0","retention-schedule":"1.1.0"}'::jsonb then
    raise exception 'legal versions not current' using errcode = '22023';
  end if;
  return p_versions;
end;
$function$;

revoke all on function private.legal_acceptance_versions(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
