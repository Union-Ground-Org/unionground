-- PERF-UG-CLAUSE-GRIEVANCE-COUNT-CROSS-JOIN-20260921
--
-- public.list_contract_clause_grievance_counts (last written by
-- 20260925110500) joined public.contract_clauses to public.member_cases on a
-- LIKE over a per-row regexp_replace of cs.articles. Nothing in that predicate
-- can use an index or a hash, so the planner ran a nested loop that re-evaluated
-- the regexp for every (clause, case) pair of the organization: cost grew with
-- clauses x cases (measured 4,990 ms for 400 clauses x 20k cases), and the
-- clause reference falls back to showing zero counts once that read times out.
--
-- This re-emits the installed 20260925110500 body with one change: each
-- visible case's articles are normalized with the same regexp ONCE, split on
-- the normalized separator into article tokens, counted per token in a
-- MATERIALIZED CTE, and joined to the caller-visible clause articles on
-- equality. The clause join therefore sees only distinct tokens, however thin
-- the statistics are. Everything else is
-- kept byte for byte: the mfa and membership gates, the session-derived
-- organization, the clause visibility of public.list_contract_clauses, the
-- member_cases SELECT-policy mirror with its once-per-statement hoists, and
-- count(distinct case) per article. The result is identical for every clause
-- article that contains no separator (',', ';', '/') and no LIKE wildcard ('%',
-- '_'); for those the old LIKE matched across tokens or by pattern, and the
-- equality join now counts only an exact article token.
--
-- No index, table or grant change. ACL is preserved by CREATE OR REPLACE
-- (authenticated only, no service_role, per 20260828163209).

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

  -- Each visible case's articles are normalized and split into tokens ONCE,
  -- then joined to the caller-visible clause articles on equality. The
  -- 20260925110500 body re-ran the regexp_replace for every (clause, case)
  -- pair as a LIKE join filter, so its cost grew with clauses x cases.
  return coalesce((
    with visible_cases as (
      select cs.id,
             ',' || pg_catalog.regexp_replace(
               pg_catalog.lower(pg_catalog.btrim(cs.articles)),
               '[[:space:]]*[,;/]+[[:space:]]*',
               ',',
               'g'
             ) || ',' as line
      from public.member_cases cs
      left join public.member_profiles case_owner
        on coordinator_chapters <> '{}'::text[]
       and case_owner.id = cs.user_id
      where cs.organization_id = org
        and cs.articles is not null
        and pg_catalog.btrim(cs.articles) <> ''
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
    ),
    case_articles as (
      select v.id as case_id, token.article
      from visible_cases v
      cross join lateral pg_catalog.unnest(
        pg_catalog.string_to_array(pg_catalog.btrim(v.line, ','), ',')
      ) as token(article)
      where token.article <> ''
    ),
    -- Counted per token before the clause join and materialized, so the join
    -- only ever sees distinct tokens: the planner cannot rescan member_cases
    -- (or re-run the regexp) once per clause article when statistics are thin.
    token_counts as materialized (
      select ca.article, pg_catalog.count(distinct ca.case_id)::integer as n
      from case_articles ca
      group by ca.article
    ),
    visible_articles as (
      select distinct pg_catalog.lower(pg_catalog.btrim(c.article)) as article
      from public.contract_clauses c
      where c.organization_id = org
        and (staff or c.status = 'published')
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'article', counts.article,
      'count', counts.n
    ) order by counts.article)
    from (
      select a.article, t.n
      from visible_articles a
      join token_counts t on t.article = a.article
    ) counts
  ), '[]'::jsonb);
end;
$function$;

comment on function public.list_contract_clause_grievance_counts() is
  'Per-article grievance counts for the selected organization, over only the cases the caller could select from public.member_cases (the own / steward / coordinator SELECT policies under mfa_assurance, hoisted as in public.search_member_cases) and only the clauses public.list_contract_clauses returns to the caller. Each visible case''s articles are tokenized once and joined to the clause articles on equality. Each case counts once per article.';

commit;
