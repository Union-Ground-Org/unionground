-- SEC-UG-SHARED-ROWS-SHOW-REQUESTER-AND-CONTRIBUTOR-IDS-TO-OTHER-ORGANIZATIONS-20261111 (#8322).
--
-- Three tables are shared between organizations on purpose, and their rows
-- carried the ids of the people and chapters that contributed them:
--   * public.chapter_union_org_bindings: chapter staff of every onboarded
--     organization read each verified binding, with requested_by and
--     verified_by (the requesting member and the verifying operator).
--   * public.civic_local_jurisdictions: an exact-place entry marked shared is
--     readable by every signed-in member, with org_id (the contributing
--     chapter) and created_by (the officer who entered it).
--   * public.civic_local_officials: the officials of such an entry, with
--     created_by.
--
-- Project decision of November 11, 2026: keep the rows shared and stop showing
-- those id columns to other organizations. The members' PostgREST role
-- (authenticated) loses SELECT on the table and gets SELECT back on every
-- column except the id columns. The rows, their row-level security and the
-- write grants are unchanged.
--
-- A column grant is checked against the reading role wherever the column is
-- named under that role, not only in a client's select list. Three places
-- named civic_local_jurisdictions.org_id as the invoking member and move to
-- definer helpers that answer a yes or no about one jurisdiction and never
-- return its chapter (the view's helper lives in public, so a service-role
-- read of the view still works):
--   * the read and officer write policies of public.civic_local_officials
--     (their sub-select of the parent jurisdiction);
--   * the security-invoker view public.civic_member_officials_keyed (its
--     own-chapter-first ordering).
-- The policies of civic_local_jurisdictions itself are evaluated on the row
-- and need no column grant, so they stay as they are.
--
-- The caller's own organization still sees its ids, through functions that
-- return rows only for it:
--   * public.civic_local_jurisdictions_for_org(p_org) and
--     public.civic_local_officials_for_org(p_org): the chapter's own entries,
--     for its members and officers. The officer screens read through them
--     (src/lib/civicApi.js), and PostgREST still embeds the related rows.
--   * public.list_own_organization_chapter_union_org_bindings(): the bindings
--     of chapters in the caller's own organization that the table's read
--     policy admits, with requested_by and verified_by. No screen reads those
--     two columns today.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

-- Refuse a stale re-emission if another migration changed what this one
-- rewrites (the view below).
do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_viewdef('public.civic_member_officials_keyed'::regclass)) <> '723138d8a6e7b095c56abed62f34220a' then
    raise exception 'unreviewed predecessor: public.civic_member_officials_keyed' using errcode = '55000';
  end if;
end;
$preflight$;

-- 1. Union office bindings ------------------------------------------------

revoke select on public.chapter_union_org_bindings from authenticated;
grant select (chapter_id, union_org_id, status, requested_at, verified_at, public_note)
  on public.chapter_union_org_bindings to authenticated;

create function public.list_own_organization_chapter_union_org_bindings()
returns table (
  chapter_id text,
  union_org_id text,
  status text,
  requested_by uuid,
  requested_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  public_note text
)
language sql
stable
security definer
set search_path = ''
as $function$
  select b.chapter_id, b.union_org_id, b.status, b.requested_by, b.requested_at,
         b.verified_by, b.verified_at, b.public_note
    from public.chapter_union_org_bindings b
    join public.chapters c on c.id = b.chapter_id
   where (select auth.uid()) is not null
     and (select private.mfa_satisfied())
     and c.organization_id = (select private.current_member_organization())
     and not private.chapter_belongs_to_platform(b.chapter_id)
     and (b.chapter_id = (select private.current_member_chapter())
          or (b.status = 'verified'
              and private.member_has_chapter_staff_grant(
                    (select private.current_member_chapter()), array['steward','coordinator','advisor','admin','vp'])
              and private.organization_clears_signup_boundary((select private.current_member_organization()))))
   order by b.chapter_id;
$function$;

revoke all on function public.list_own_organization_chapter_union_org_bindings() from public, anon, authenticated, service_role;
grant execute on function public.list_own_organization_chapter_union_org_bindings() to authenticated, service_role;

comment on function public.list_own_organization_chapter_union_org_bindings() is
  'The union office bindings of chapters in the caller''s own organization that the table''s read policy admits, with requested_by and verified_by. Other organizations read the shared rows without those columns (column grants). #8322.';

-- 2. Hand-entered local jurisdictions and officials -----------------------

revoke select on public.civic_local_jurisdictions, public.civic_local_officials from authenticated;
grant select (id, name, kind, state, match_zips, match_cities, updated_at, place_geoid, shared, reviewed_at)
  on public.civic_local_jurisdictions to authenticated;
grant select (id, jurisdiction_id, office, full_name, party, email, phone, contact_form_url, website,
              term_end, is_current, updated_at)
  on public.civic_local_officials to authenticated;

-- Yes or no about one jurisdiction for the caller; never its chapter.
create function private.civic_local_jurisdiction_readable(p_jurisdiction uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.civic_local_jurisdictions j
     where j.id = p_jurisdiction
       and (public.civic_is_org_member(j.org_id) or public.civic_is_org_officer(j.org_id)
            or (j.shared and j.place_geoid is not null)));
$function$;

create function private.civic_local_jurisdiction_officer(p_jurisdiction uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.civic_local_jurisdictions j
     where j.id = p_jurisdiction and public.civic_is_org_officer(j.org_id));
$function$;

-- In public, not private: the security-invoker view below calls it as its
-- reader, and service_role has no USAGE on schema private (a load-bearing pin
-- of the database contract), so a service-role read of the view keeps working.
-- It answers only whether the caller is a member of the jurisdiction's chapter;
-- with no signed-in caller (service_role) it is false, as the
-- civic_is_org_member(j.org_id) call it replaces was. Being a client-reachable
-- definer function, it states the MFA floor itself (REQ-UG-DEFINER-MFA-AUDIT);
-- civic_is_org_member already requires it, so the answer is unchanged.
create function public.civic_local_jurisdiction_own(p_jurisdiction uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select (select private.mfa_satisfied())
    and exists (
      select 1 from public.civic_local_jurisdictions j
       where j.id = p_jurisdiction and public.civic_is_org_member(j.org_id));
$function$;

revoke all on function private.civic_local_jurisdiction_readable(uuid) from public, anon, authenticated, service_role;
revoke all on function private.civic_local_jurisdiction_officer(uuid) from public, anon, authenticated, service_role;
revoke all on function public.civic_local_jurisdiction_own(uuid) from public, anon, authenticated, service_role;
grant execute on function private.civic_local_jurisdiction_readable(uuid) to authenticated;
grant execute on function private.civic_local_jurisdiction_officer(uuid) to authenticated;
grant execute on function public.civic_local_jurisdiction_own(uuid) to authenticated, service_role;

comment on function private.civic_local_jurisdiction_readable(uuid) is
  'True when the caller may read the local jurisdiction: a member or officer of its chapter, or any signed-in member for a shared exact place. Used by the civic_local_officials read policy so the policy names no chapter id under the member''s role. #8322.';
comment on function private.civic_local_jurisdiction_officer(uuid) is
  'True when the caller is an officer of the local jurisdiction''s chapter. Used by the civic_local_officials write policies. #8322.';
comment on function public.civic_local_jurisdiction_own(uuid) is
  'True when the caller is a member of the local jurisdiction''s chapter. Orders the caller''s own chapter first in public.civic_member_officials_keyed; in public so a service-role read of that security-invoker view keeps working. #8322.';

drop policy civic_local_officials_read on public.civic_local_officials;
create policy civic_local_officials_read on public.civic_local_officials
  for select to authenticated
  using (private.civic_local_jurisdiction_readable(jurisdiction_id));
drop policy civic_local_officials_officer_insert on public.civic_local_officials;
create policy civic_local_officials_officer_insert on public.civic_local_officials
  for insert to authenticated
  with check (private.civic_local_jurisdiction_officer(jurisdiction_id));
drop policy civic_local_officials_officer_update on public.civic_local_officials;
create policy civic_local_officials_officer_update on public.civic_local_officials
  for update to authenticated
  using (private.civic_local_jurisdiction_officer(jurisdiction_id))
  with check (private.civic_local_jurisdiction_officer(jurisdiction_id));
drop policy civic_local_officials_officer_delete on public.civic_local_officials;
create policy civic_local_officials_officer_delete on public.civic_local_officials
  for delete to authenticated
  using (private.civic_local_jurisdiction_officer(jurisdiction_id));

comment on policy civic_local_officials_read on public.civic_local_officials is
  'Admits readers of the parent jurisdiction (its chapter''s members and officers, or everyone for a shared exact place) to the local officials who serve it. #8322: decided by private.civic_local_jurisdiction_readable so no chapter id is read under the member''s role.';
comment on policy civic_local_officials_officer_insert on public.civic_local_officials is
  'Only officers of the jurisdiction''s chapter enter its officials. #8322: through private.civic_local_jurisdiction_officer.';
comment on policy civic_local_officials_officer_update on public.civic_local_officials is
  'Only officers of the jurisdiction''s chapter edit its officials. #8322: through private.civic_local_jurisdiction_officer.';
comment on policy civic_local_officials_officer_delete on public.civic_local_officials is
  'Only officers of the jurisdiction''s chapter delete its officials. #8322: through private.civic_local_jurisdiction_officer.';

-- The view is security invoker: its own-chapter-first ordering named
-- civic_local_jurisdictions.org_id under the member's role. Same columns,
-- same rows, same order; the ordering asks public.civic_local_jurisdiction_own.
create or replace view public.civic_member_officials_keyed
with (security_invoker = on) as
select mo.user_id, mo.ocd_id, mo.district_level, mo.state, mo.district_name, mo.district_number, mo.map_version,
       mo.district_valid_to, mo.office, mo.full_name, mo.party, mo.email, mo.phone, mo.contact_form_url, mo.website,
       mo.photo_url, mo.social, mo.external_ids, mo.term_end, mo.official_source, mo.resolved_at, mo.level_rank,
       mo.resolution_stale,
       coalesce('bioguide:' || nullif(mo.external_ids->>'bioguide', ''),
                'openstates:' || nullif(mo.external_ids->>'openstates', '')) as official_key,
       true as match_exact
from public.civic_member_officials mo
union all
select m.user_id, 'local:' || m.jurisdiction_id, 'local', m.state, m.name, null, 'manual',
       null::date, o.office, o.full_name, o.party, o.email, o.phone, o.contact_form_url, o.website,
       null, '{}'::jsonb, jsonb_build_object('local', o.id, 'jurisdiction', m.jurisdiction_id), o.term_end, 'manual',
       o.updated_at, 6,
       false,
       'local:' || o.id,
       m.match_exact
from (
  select distinct on (a.user_id, coalesce(j.place_geoid, j.id::text))
         a.user_id, j.id as jurisdiction_id, j.state, j.name, (j.place_geoid is not null) as match_exact
  from public.civic_member_addresses a
  join public.civic_local_jurisdictions j on j.state = a.state and (
        (j.place_geoid is not null and exists (
          select 1 from public.civic_user_places up where up.user_id = a.user_id and up.geoid = j.place_geoid))
     or (j.place_geoid is null and (left(a.postal_code, 5) = any (j.match_zips)
                                    or lower(regexp_replace(btrim(a.city), '\s+', ' ', 'g')) = any (j.match_cities))))
  order by a.user_id, coalesce(j.place_geoid, j.id::text), public.civic_local_jurisdiction_own(j.id) desc, j.reviewed_at desc
) m
join public.civic_local_officials o on o.jurisdiction_id = m.jurisdiction_id and o.is_current;

-- The chapter's own entries, with org_id and created_by, for its members and
-- officers. setof the table type so PostgREST still embeds the related rows.
create function public.civic_local_jurisdictions_for_org(p_org text)
returns setof public.civic_local_jurisdictions
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied())
     or not (public.civic_is_org_member(p_org) or public.civic_is_org_officer(p_org)) then
    raise exception 'members of this chapter only' using errcode = '42501';
  end if;
  return query
  select j.* from public.civic_local_jurisdictions j where j.org_id = p_org order by j.name;
end;
$function$;

create function public.civic_local_officials_for_org(p_org text)
returns setof public.civic_local_officials
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not (select private.mfa_satisfied())
     or not (public.civic_is_org_member(p_org) or public.civic_is_org_officer(p_org)) then
    raise exception 'members of this chapter only' using errcode = '42501';
  end if;
  return query
  select o.* from public.civic_local_officials o
    join public.civic_local_jurisdictions j on j.id = o.jurisdiction_id
   where j.org_id = p_org
   order by o.full_name, o.id;
end;
$function$;

revoke all on function public.civic_local_jurisdictions_for_org(text) from public, anon, authenticated, service_role;
revoke all on function public.civic_local_officials_for_org(text) from public, anon, authenticated, service_role;
grant execute on function public.civic_local_jurisdictions_for_org(text) to authenticated, service_role;
grant execute on function public.civic_local_officials_for_org(text) to authenticated, service_role;

comment on function public.civic_local_jurisdictions_for_org(text) is
  'A chapter''s own hand-entered local jurisdictions, with org_id and created_by, for that chapter''s members and officers only. Other chapters read shared entries without those columns (column grants). #8322.';
comment on function public.civic_local_officials_for_org(text) is
  'The officials of a chapter''s own hand-entered local jurisdictions, with created_by, for that chapter''s members and officers only. #8322.';

notify pgrst, 'reload schema';
commit;
