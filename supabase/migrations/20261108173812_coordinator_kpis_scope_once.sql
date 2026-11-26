-- BUG-UG-COORDINATOR-DESK-INITIAL-READ-LATENCY-20261108 (#7593).
-- Resolve repeated organization, chapter, grant and coordinator-member
-- authority once per KPI statement. Per-case scope/identity (including
-- learning-period undo), restrictions, assignments and the scoped coordinator
-- and stewardship fallbacks retain the existing rules.
--
-- This is the composition of casework_staff_can_read, casework_staff_can_access
-- and member_case_row_visible over the tenant-bound candidates. The preflight
-- pins those predecessors and the two equivalent coordinator-member predicates.
-- The grant branch's read check is absorbed into the identical final read
-- check: (own OR grant AND visible AND readable) AND readable equals
-- (own OR grant AND visible) AND readable. The additional stewardship branch
-- requires NOT is_restricted, so member_case_row_visible there reduces to the
-- same scope-and-identity conjunct used by casework_staff_can_access.
-- Existing functions, RLS policies and caller/tenant/platform guards stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
set local search_path=pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_coordinator_kpis()'::regprocedure)
    is distinct from '8a507ee6871c69fcae302e60f82c0495' then
    raise exception 'unreviewed predecessor: public.get_coordinator_kpis' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_staff_can_read(uuid)'::regprocedure)
    is distinct from 'fcdafd53ae591a78f66d1bfc0120101e' then
    raise exception 'unreviewed predecessor: private.casework_staff_can_read' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_staff_can_access(uuid)'::regprocedure)
    is distinct from '587b0540a6db913793d2348c8d410b2e' then
    raise exception 'unreviewed predecessor: private.casework_staff_can_access' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.member_case_row_visible(public.member_cases)'::regprocedure)
    is distinct from 'f4c1961b0585c1769556eb5551795bf9' then
    raise exception 'unreviewed predecessor: private.member_case_row_visible' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.casework_actor_has_active_grant(uuid)'::regprocedure)
    is distinct from 'ffe34f00062b367710dc2f4965f67967' then
    raise exception 'unreviewed predecessor: private.casework_actor_has_active_grant' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='private.staff_visible_member_ids(text)'::regprocedure)
    is distinct from '1217899a53807f4f20aaf8926cccc8fc' then
    raise exception 'unreviewed predecessor: private.staff_visible_member_ids' using errcode='55000';
  end if;
  if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.staff_can_see_user(uuid,text)'::regprocedure)
    is distinct from '8c035c28fa8f7f64dee7bf8bf1c32b00' then
    raise exception 'unreviewed predecessor: public.staff_can_see_user' using errcode='55000';
  end if;
end;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_coordinator_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  caller uuid := (select auth.uid());
  open_cases integer;
  due_week integer;
  in_arb integer;
  resolved_cases integer;
  by_step jsonb;
  by_article jsonb;
begin
  if caller is null or not public.member_has_role(array['coordinator']) then
    raise exception 'coordinator role required' using errcode = '42501';
  end if;
  if private.organization_is_platform(private.current_member_organization()) then
    raise exception 'platform organization is private' using errcode = '42501';
  end if;

  -- Caller-only and chapter/organization authority is projected once.
  with coordinator_members as materialized (
    select private.staff_visible_member_ids('coordinator') as id
  ),
  active_grants as materialized (
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = (select auth.uid())
      and g.revoked_at is null
  ),
  union_organizations as materialized (
    select o.id from public.organizations o
    where private.organization_is_union(o.id)
  ),
  tenant as materialized (
    select c as case_row, c.id, c.user_id, c.organization_id, c.chapter_id,
      c.steward_user_id, c.coordinator_user_id, c.is_restricted,
      c.status, c.step, c.articles, c.deadline
    from public.member_cases c
    where (select private.mfa_satisfied())
      and c.organization_id in (select id from union_organizations)
      and c.chapter_id is not null
      and (
        (c.organization_id = (select private.current_member_organization())
          and c.chapter_id = (select private.current_member_chapter()))
        or (c.id in (select case_id from active_grants)
          and c.user_id in (select id from coordinator_members))
      )
  ),
  chapter_scope as materialized (
    select chapters.chapter_id,
      private.actor_has_chapter_staff_role(caller, chapters.chapter_id) as staff,
      coalesce((select p.steward_grievances from private.chapter_access_policies p
        where p.chapter_id = chapters.chapter_id), true) as steward_grievances
    from (select distinct chapter_id from tenant) chapters
  ),
  organization_scope as materialized (
    select organizations.organization_id,
      private.has_organization_role(organizations.organization_id, array['advisor','admin','vp']) as oversight
    from (select distinct organization_id from tenant) organizations
  ),
  access as materialized (
    select t.*, chapter_scope.steward_grievances,
      (chapter_scope.staff
        and (t.steward_user_id = caller or t.coordinator_user_id = caller
          or t.user_id in (select id from coordinator_members) or organization_scope.oversight)
        and (not t.is_restricted or t.steward_user_id = caller or t.coordinator_user_id = caller
          or organization_scope.oversight or t.id in (select case_id from active_grants))) as direct_access
    from tenant t
    join chapter_scope on chapter_scope.chapter_id = t.chapter_id
    join organization_scope on organization_scope.organization_id = t.organization_id
  ),
  base as materialized (
    select t.id, t.status, t.step, t.articles, t.deadline
    from access t
    where private.case_scope_and_identity_allowed(t.case_row)
      and case when t.direct_access then true else (
        t.organization_id = (select private.current_member_organization())
        and (
          (private.actor_role_covers_member(caller, t.chapter_id, 'coordinator', t.user_id, true)
            and (not t.is_restricted or t.coordinator_user_id = caller
              or t.id in (select case_id from active_grants)))
          or (t.user_id <> caller and not t.is_restricted and t.steward_grievances
            and private.chapter_grievance_steward_scope(t.chapter_id, t.user_id))
        )
      ) end
  )
  select
    pg_catalog.count(*) filter (where b.status = 'active'),
    pg_catalog.count(*) filter (where b.status = 'active'
      and b.deadline is not null
      and b.deadline between current_date and current_date + 6),
    pg_catalog.count(*) filter (where b.status = 'active'
      and (b.step ~* 'arb' or b.step = 'Step 4')),
    pg_catalog.count(*) filter (where b.status = 'resolved'),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('step', s.step, 'count', s.n) order by s.n desc, s.step), '[]'::jsonb)
     from (
       select step, pg_catalog.count(*) as n
       from base
       where status = 'active'
       group by step
     ) s),
    (select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('articles', a.articles, 'count', a.n) order by a.n desc, a.articles), '[]'::jsonb)
     from (
       select articles, pg_catalog.count(*) as n
       from base
       where status = 'active' and articles <> ''
       group by articles
     ) a)
  into open_cases, due_week, in_arb, resolved_cases, by_step, by_article
  from base b;

  return pg_catalog.jsonb_build_object(
    'openCases', open_cases,
    'dueThisWeek', due_week,
    'inArbitration', in_arb,
    'resolved', resolved_cases,
    'resolutionRate', case when open_cases + resolved_cases = 0 then null
      else pg_catalog.round(100.0 * resolved_cases / (open_cases + resolved_cases)) end,
    'byStep', by_step,
    'byArticle', by_article);
end;
$function$;

revoke all on function public.get_coordinator_kpis() from public,anon,authenticated,service_role;
grant execute on function public.get_coordinator_kpis() to authenticated;

update private.account_lifecycle_trigger_review
set definition_hash=pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_coordinator_kpis()'::regprocedure))
where kind='function' and schema_name='public' and table_name='' and object_name='get_coordinator_kpis()';

commit;
