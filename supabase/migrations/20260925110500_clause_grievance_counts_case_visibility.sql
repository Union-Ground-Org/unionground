-- SEC-UG-CLAUSE-GRIEVANCE-COUNTS-LEAK-RESTRICTED-CASES-20260920
--
-- public.list_contract_clause_grievance_counts (20260827180000) is SECURITY
-- DEFINER, so the public.member_cases SELECT policies never ran inside it and
-- the per-article "linked to N grievances" figure on the member clause
-- reference (/m/clauses) was computed over every case in the organization,
-- restricted ones included. It also counted clauses a member cannot see
-- (retired rows) and counted a case once per sectioned clause row sharing its
-- article.
--
-- The repair keeps the function's signature, grants and session-derived
-- organization and changes only the counted set:
--   * a case is counted only when the caller could select it from
--     public.member_cases: the three permissive SELECT policies
--     (member_cases_select_own, member_cases_select_steward,
--     member_cases_select_coordinator as last written by 20260829001850) ANDed
--     with the restrictive mfa_assurance policy. The mirror is the one
--     public.search_member_cases (20260917102000) proves equal to RLS, with the
--     same once-per-statement hoists (steward hat, coordinator chapter scope
--     via private.staff_visible_chapter_scope, officer grant on
--     private.current_mobile_staff_organization(), live casework grants), so no
--     visibility function runs per case row;
--   * only clauses the sibling reader public.list_contract_clauses would return
--     to this caller contribute an article (staff, or status = 'published');
--   * each case is counted once per article (count(distinct case id)).
-- ACL is preserved by CREATE OR REPLACE (authenticated only, no service_role,
-- per 20260828163209).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.list_contract_clause_grievance_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid := private.mi1_require_selected_organization();
  v_actor uuid := (select auth.uid());
  staff boolean;
  steward_hat boolean;
  coordinator_chapters text[];
  staff_organization uuid;
  organization_officer boolean;
  granted_cases uuid[];
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.is_organization_member(org) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Same clause visibility as public.list_contract_clauses.
  staff := private.has_organization_role(
    org,
    array['steward', 'coordinator', 'advisor', 'admin', 'vp']
  );

  -- Caller-only inputs of the member_cases SELECT policies, resolved once.
  -- mfa_assurance is already satisfied by the gate above.
  steward_hat := coalesce(public.member_has_role(array['steward']), false);
  coordinator_chapters := array(select private.staff_visible_chapter_scope('coordinator'));
  staff_organization := private.current_mobile_staff_organization();
  organization_officer := coalesce(
    private.has_organization_role(staff_organization, array['advisor', 'admin', 'vp']),
    false
  );
  granted_cases := array(
    select g.case_id
    from public.casework_access_grants g
    where g.grantee_user_id = v_actor
      and g.revoked_at is null
  );

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'article', counts.article,
      'count', counts.n
    ) order by counts.article)
    from (
      select pg_catalog.lower(pg_catalog.btrim(c.article)) as article,
             pg_catalog.count(distinct cs.id)::integer as n
      from public.contract_clauses c
      join public.member_cases cs
        on cs.organization_id = c.organization_id
       and cs.articles is not null
       and pg_catalog.btrim(cs.articles) <> ''
       and (
         ',' || pg_catalog.regexp_replace(
           pg_catalog.lower(pg_catalog.btrim(cs.articles)),
           '[[:space:]]*[,;/]+[[:space:]]*',
           ',',
           'g'
         ) || ','
       ) like '%,' || pg_catalog.lower(pg_catalog.btrim(c.article)) || ',%'
      left join public.member_profiles case_owner
        on coordinator_chapters <> '{}'::text[]
       and case_owner.id = cs.user_id
      where c.organization_id = org
        and (staff or c.status = 'published')
        and (
          -- member_cases_select_own
          cs.user_id = v_actor
          -- member_cases_select_steward
          or (cs.steward_user_id = v_actor and steward_hat)
          -- member_cases_select_coordinator
          or (
            case_owner.chapter_id = any(coordinator_chapters)
            and (
              not cs.is_restricted
              or cs.coordinator_user_id = v_actor
              or (
                cs.organization_id is not null
                and cs.organization_id = staff_organization
                and organization_officer
              )
              or cs.id = any(granted_cases)
            )
          )
        )
      group by pg_catalog.lower(pg_catalog.btrim(c.article))
    ) counts
  ), '[]'::jsonb);
end;
$function$;

comment on function public.list_contract_clause_grievance_counts() is
  'Per-article grievance counts for the selected organization, over only the cases the caller could select from public.member_cases (the own / steward / coordinator SELECT policies under mfa_assurance, hoisted as in public.search_member_cases) and only the clauses public.list_contract_clauses returns to the caller. Each case counts once per article.';

commit;
