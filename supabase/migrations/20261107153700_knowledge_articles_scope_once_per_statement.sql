-- BUG-UG-KNOWLEDGE-ARTICLES-POLICY-REBUILDS-SCOPE-PER-ROW-20261106 (#7361), option 1.
-- The app's boot read of public.member_kb_articles (src/lib/memberApi.js) is a
-- direct table read, so member_kb_articles_select decides its cost. Its member
-- branch called private.compass_scope_specificity once per candidate article,
-- and that function resolved the caller's active organization and rebuilt the
-- caller's scope paths (private.compass_member_scope_paths, one
-- compass_scope_path_for_chapter per membership) every time: 156 ms of a
-- 166 ms steward read at 147 Tamarack articles, 3.1 s in-app on SAMPLE under
-- the desk's first-load burst.
--
-- The caller's side now resolves once per statement:
--   private.compass_caller_scope() is the caller's active organization and
--   scope paths, exactly the inputs compass_scope_specificity reads (null
--   without a signed-in caller, satisfied MFA and a selected organization);
--   the policy calls it as an uncorrelated scalar subquery, an InitPlan.
--   private.compass_scope_specificity_for(scope, org, path, level) is
--   compass_scope_specificity's arithmetic over those precomputed inputs.
-- All of them are stable within one statement, so the rows each caller sees
-- are unchanged; the staff branch's caller-only calls
-- (current_member_chapter, member_has_role) become InitPlans the same way,
-- and the cheap column predicates come first in each branch.
-- compass_scope_specificity itself, the embeddings policy and the Compass
-- retrieval functions are untouched.
--
-- The preflight refuses to run unless the predecessor policy is exactly the
-- one 20261028210000 installed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- pg_get_expr qualifies every non-catalog name under this path, exactly as
-- under an empty one (pg_catalog is always searched), so the md5 is stable.
set local search_path = pg_catalog;

do $preflight$
begin
  if (select pg_catalog.md5(pg_catalog.pg_get_expr(p.polqual, p.polrelid)) from pg_catalog.pg_policy p
      where p.polrelid = 'public.member_kb_articles'::regclass and p.polname = 'member_kb_articles_select'
        and p.polpermissive and p.polcmd = 'r') is distinct from 'b216861a2a8b90d93acbfe2d01e889d0' then
    raise exception 'unreviewed predecessor: member_kb_articles_select' using errcode = '55000';
  end if;
end;
$preflight$;

create function private.compass_caller_scope()
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when (select auth.uid()) is not null and private.mfa_satisfied() then (
    select pg_catalog.jsonb_build_object(
      'organization_id', q.organization_id,
      'paths', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s.scope_path))
        from private.compass_member_scope_paths() s), '[]'::jsonb))
    from private.compass_quota_organization((select auth.uid())) q
    where q.resolution = 'selected')
  end;
$$;
revoke all on function private.compass_caller_scope() from public, anon, service_role;
grant execute on function private.compass_caller_scope() to authenticated;
comment on function private.compass_caller_scope() is
  '#7361: the caller''s active organization and scope paths (private.compass_member_scope_paths), once per statement; null without a signed-in caller, satisfied MFA and a selected organization.';

create function private.compass_scope_specificity_for(p_scope jsonb, p_organization_id uuid, p_path text[], p_level text)
returns integer language plpgsql immutable set search_path = '' as $$
declare active_org uuid; candidate record; prefix integer; best integer := 0;
  root_depth integer := 1;
begin
  if p_scope is null or p_organization_id is null
    or coalesce(pg_catalog.cardinality(p_path), 0) = 0 then return 0; end if;
  active_org := (p_scope ->> 'organization_id')::uuid;
  if active_org is distinct from p_organization_id then return 0; end if;
  if p_path[1] like 'national:%' then root_depth := 2; end if;
  if p_path[root_depth] is distinct from 'organization:' || active_org::text then return 0; end if;
  if p_level = 'local' then
    return case when pg_catalog.cardinality(p_path) = root_depth then 1 else 0 end;
  end if;
  if p_level is null or p_level not in ('agency', 'unit', 'chapter') then return 0; end if;
  for candidate in
    select case when pg_catalog.jsonb_typeof(e.value) = 'array'
      then array(select pg_catalog.jsonb_array_elements_text(e.value)) end as scope_path
    from pg_catalog.jsonb_array_elements(p_scope -> 'paths') e
  loop
    if p_level in ('chapter', 'unit') and candidate.scope_path is distinct from p_path then continue; end if;
    prefix := 0;
    for i in 1..least(pg_catalog.cardinality(candidate.scope_path), pg_catalog.cardinality(p_path)) loop
      exit when candidate.scope_path[i] is distinct from p_path[i];
      prefix := i;
    end loop;
    if prefix > root_depth then best := greatest(best, prefix - root_depth + 1); end if;
  end loop;
  return best;
end;
$$;
revoke all on function private.compass_scope_specificity_for(jsonb, uuid, text[], text) from public, anon, service_role;
grant execute on function private.compass_scope_specificity_for(jsonb, uuid, text[], text) to authenticated;
comment on function private.compass_scope_specificity_for(jsonb, uuid, text[], text) is
  '#7361: private.compass_scope_specificity over the caller scope private.compass_caller_scope() returned, so a row policy resolves the caller once per statement.';

alter policy member_kb_articles_select on public.member_kb_articles using (
  ((not is_sample) and status = 'published' and verified_by is not null and verified_at is not null
    and private.compass_article_scope_current(member_kb_articles.*)
    and private.compass_scope_specificity_for((select private.compass_caller_scope()),
      compass_organization_id, compass_scope_path, compass_scope_level) > 0
    and private.knowledge_article_content_current(member_kb_articles.*)
    and private.compass_article_classification_current(member_kb_articles.*))
  or ((not is_sample) and chapter_id = (select private.current_member_chapter())
    and (select public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
    and private.knowledge_article_content_current(member_kb_articles.*))
);
comment on policy member_kb_articles_select on public.member_kb_articles is 'Member read: published, verified, not sample, current canonical scope path, the active organization and verified membership scope intersection (private.compass_caller_scope, resolved once per statement), source verdict and ingestion classification. Staff read: the caller''s current chapter for steward, coordinator, advisor, admin or vp, with the same whole-row content gate (private.knowledge_article_content_current). #7361 (20261107153700): the caller''s scope paths, chapter and role resolve once per statement instead of once per article.';

commit;
