-- BUG-UG-ROLE-SCOPE-EDGES-IN-ROSTER-AWARDS-GLOW-AND-ADVISOR-COUNTS-20261117 (#9043)
--
-- One class of finding: four places that decide which role or scope sees or
-- changes something. Two still differ from the rule Main applies elsewhere,
-- and each is restated here from its latest definition (md5-pinned below)
-- with only the named check changed. Security mode, search_path, refusal
-- text, result shape and grants (kept by CREATE OR REPLACE) do not change.
--
-- Ledger 115. private.workload_rebalancing (20261113144500) lets a steward
-- limited to some units see the chapter-wide and organization-wide staff in
-- the workload roster, but read "chapter-wide" only from organization grants.
-- A steward who holds a chapter-wide grant of this chapter (a
-- public.member_role_chapters row with no private.chapter_role_scopes row for
-- that role, the same test private.member_has_chapter_role uses) and also
-- keeps a unit steward scope was hidden from other units' rosters. It is now
-- listed, as an organization-wide grant holder already was.
--
-- Ledger 205. public.set_chapter_notice_glow and the canChange answer of
-- public.get_chapter_notice_glow (20261113120000) admitted
-- member_has_chapter_role(chapter, steward/admin/vp), which a steward with
-- the #7663 carry-over mark and an organization steward grant both satisfy.
-- Since #7664 (20261113121000) such stewards send notices only to their unit,
-- and Main's other chapter-wide callers (20261113147500) use
-- chapter_notice_scope_allowed(chapter, null, null) or
-- chapter_officer_can(chapter, 'notices'). The colour setter and canChange
-- now use the same test, so those stewards are refused.
--
-- Ledger 3 (a retained bid's award) already holds on Main: #8054
-- (20261111184200) lets chapter and organization staff clear the award of a
-- subject who left the chapter, with its DB
-- proof in tests/unit-stewards-member-data-gates-db.test.js.
--
-- Ledger 38 (an advisor's legacy cases with no chapter) also holds on Main:
-- #8851 (20261113142500, record #8784) refuses a case without a chapter and
-- validates member_cases_chapter_present; SAMPLE and Production held no such
-- case in its read-only count of Nov 15, 2026.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
-- The hosted runner applies under an empty search_path; replay the same way.
set local search_path = pg_catalog;

do $predecessor$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('private.workload_rebalancing(text)'))) is distinct from 'fa7f124e87d2a28f71cb892b62679387' then
    raise exception 'unreviewed predecessor: private.workload_rebalancing' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'private'
      and pg_catalog.split_part(object_name, '(', 1) = 'workload_rebalancing' and definition_hash <> 'fa7f124e87d2a28f71cb892b62679387') then
    raise exception 'stale trigger receipt: private.workload_rebalancing' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.set_chapter_notice_glow(text, text)'))) is distinct from '793b3f63f4584ce6ae96ccd34d86fb41' then
    raise exception 'unreviewed predecessor: public.set_chapter_notice_glow' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'public'
      and pg_catalog.split_part(object_name, '(', 1) = 'set_chapter_notice_glow' and definition_hash <> '793b3f63f4584ce6ae96ccd34d86fb41') then
    raise exception 'stale trigger receipt: public.set_chapter_notice_glow' using errcode = '55000';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('public.get_chapter_notice_glow(text)'))) is distinct from 'c1796cf80807527fcf8daea436495821' then
    raise exception 'unreviewed predecessor: public.get_chapter_notice_glow' using errcode = '55000';
  end if;
  if exists (select 1 from private.account_lifecycle_trigger_review where kind = 'function' and schema_name = 'public'
      and pg_catalog.split_part(object_name, '(', 1) = 'get_chapter_notice_glow' and definition_hash <> 'c1796cf80807527fcf8daea436495821') then
    raise exception 'stale trigger receipt: public.get_chapter_notice_glow' using errcode = '55000';
  end if;
end;
$predecessor$;

-- Item 115 (ledger 115): the workload roster.
CREATE OR REPLACE FUNCTION private.workload_rebalancing(p_chapter text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with chapter_scope as materialized (
    select c.organization_id, private.caller_unit_limited_in_chapter(p_chapter) as unit_limited
    from public.chapters c
    where c.id = p_chapter
  ), steward_roster as materialized (
    select distinct p.id as steward_id, p.full_name
    from public.member_profiles p
    cross join chapter_scope
    where p.chapter_id = p_chapter
      -- A steward limited to some units sees itself, the chapter-wide and
      -- organization-wide stewards and the stewards whose unit or committee
      -- scope overlaps its own. An
      -- organization-wide staff grant wins over a unit scope left from before
      -- it was granted.
      and (not chapter_scope.unit_limited
        or p.id = (select auth.uid())
        or exists (
          select 1 from public.organization_role_grants broad
          join public.organization_memberships membership
            on membership.user_id = broad.user_id and membership.organization_id = broad.organization_id
           and membership.status = 'active'
          where broad.user_id = p.id and broad.organization_id = chapter_scope.organization_id
            and broad.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp']))
        -- #9043: a chapter-wide staff grant in this chapter (a role row with no
        -- unit or committee scope for that role, as
        -- private.member_has_chapter_role reads it) wins over a unit steward
        -- scope too.
        or exists (
          select 1 from public.member_role_chapters chapter_grant
          join public.member_chapter_memberships chapter_membership
            on chapter_membership.user_id = chapter_grant.user_id
           and chapter_membership.chapter_id = chapter_grant.chapter_id
           and chapter_membership.status = 'active'
          where chapter_grant.user_id = p.id and chapter_grant.chapter_id = p_chapter
            and chapter_grant.role = any(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])
            and not exists (
              select 1 from private.chapter_role_scopes grant_scope
              where grant_scope.user_id = chapter_grant.user_id
                and grant_scope.chapter_id = chapter_grant.chapter_id
                and grant_scope.role = chapter_grant.role))
        or not exists (
          select 1 from private.chapter_role_scopes steward_scope
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward')
        or exists (
          select 1 from private.chapter_role_scopes steward_scope
          join private.chapter_role_scopes caller_scope
            on caller_scope.user_id = (select auth.uid()) and caller_scope.chapter_id = p_chapter
           and (steward_scope.unit_id = caller_scope.unit_id or steward_scope.committee_id = caller_scope.committee_id)
          where steward_scope.user_id = p.id and steward_scope.chapter_id = p_chapter
            and steward_scope.role = 'steward'))
      and (
        (
          chapter_scope.organization_id is not null
          and private.organization_member_roles(
            p.id,
            chapter_scope.organization_id,
            p_chapter
          ) ? 'steward'
        )
        or (
          chapter_scope.organization_id is null
          and exists (
            select 1
            from public.member_roles legacy_role
            where legacy_role.user_id = p.id
              and legacy_role.role = 'steward'
              and (legacy_role.chapter_id is null or legacy_role.chapter_id = p_chapter)
          )
        )
      )
    order by p.full_name, p.id
    limit 50
  ), counts as (
    select s.steward_id, s.full_name,
      pg_catalog.count(c.id)::integer as active,
      pg_catalog.count(c.id) filter (
        where c.deadline between (select private.eastern_day()) and (select private.eastern_day()) + 6)::integer as due_soon,
      pg_catalog.count(c.id) filter (where c.deadline < (select private.eastern_day()))::integer as overdue
    from steward_roster s
    left join public.member_cases c on c.steward_user_id = s.steward_id
      and c.status = 'active' and c.learning_undone_at is null
      and not private.organization_is_platform(c.organization_id)
      and exists (
        select 1 from public.member_profiles owner
        where owner.id = c.user_id and owner.chapter_id = p_chapter)
      -- and counts only the cases of members it may see.
      and (not (select scope.unit_limited from chapter_scope scope) or private.caller_may_see_member(c.user_id))
    group by s.steward_id, s.full_name
  ), mean as (
    select coalesce(pg_catalog.avg(active), 0) as avg_active from counts
  ), ranked_high as (
    select c.*, pg_catalog.row_number() over (order by active desc, overdue desc, steward_id) as rn
    from counts c, mean m where c.active >= pg_catalog.ceil(m.avg_active)::integer + 2
  ), ranked_low as (
    select c.*, pg_catalog.row_number() over (order by active asc, overdue asc, steward_id) as rn
    from counts c, mean m where c.active <= greatest(pg_catalog.floor(m.avg_active)::integer - 1, 0)
  ), suggestions as (
    select h.steward_id as from_id, h.full_name as from_name,
      l.steward_id as to_id, l.full_name as to_name,
      least(greatest((h.active - l.active) / 2, 1), 10)::integer as review_count,
      h.active as from_active, l.active as to_active
    from ranked_high h join ranked_low l using (rn)
    where h.steward_id <> l.steward_id
    order by h.active desc, l.active asc, h.steward_id, l.steward_id
    limit 10
  )
  select pg_catalog.jsonb_build_object(
    'stewards', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'userId', c.steward_id, 'name', c.full_name, 'activeCases', c.active,
      'dueSoon', c.due_soon, 'overdue', c.overdue) order by c.full_name, c.steward_id) from counts c), '[]'::jsonb),
    'suggestions', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'fromUserId', s.from_id, 'fromName', s.from_name,
      'toUserId', s.to_id, 'toName', s.to_name,
      'reviewCount', s.review_count, 'fromActiveCases', s.from_active,
      'toActiveCases', s.to_active) order by s.from_active desc, s.from_id) from suggestions s), '[]'::jsonb)
  );
$function$;

-- Item 205 (ledger 205): the notice glow colour.
create or replace function public.set_chapter_notice_glow(p_chapter_id text, p_colour text)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid;
  caller_org uuid;
  clean_chapter text;
  clean_colour text;
  stored text;
begin
  -- The case-graph gate comes first, as in every writer of public.chapters
  -- (scripts/account-case-graph-inventory.mjs helperFirst).
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  caller := (select auth.uid());
  clean_chapter := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  clean_colour := pg_catalog.lower(pg_catalog.btrim(coalesce(p_colour, '')));
  if caller is null or not (select private.mfa_satisfied()) then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  caller_org := private.current_member_organization();
  -- One refusal for a chapter that is missing, in another organization or not
  -- the caller's to publish for, so the answer says nothing about the chapter.
  -- #9043: the roles that may send this chapter's chapter-wide notices
  -- (#7664), never a steward limited to its units.
  if caller_org is null
     or not exists (select 1 from public.chapters c where c.id = clean_chapter and c.organization_id = caller_org)
     or not (private.chapter_notice_scope_allowed(clean_chapter, null, null)
       or private.chapter_officer_can(clean_chapter, 'notices')) then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  if clean_colour not in ('green', 'blue', 'gold', 'violet') then
    raise exception 'notice glow must be green, blue, gold or violet' using errcode = '22023';
  end if;
  update public.chapters c
     set notice_glow = clean_colour
   where c.id = clean_chapter and c.organization_id = caller_org
  returning c.notice_glow into stored;
  return stored;
end;
$function$;

create or replace function public.get_chapter_notice_glow(p_chapter_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  caller_org uuid;
  clean_chapter text := pg_catalog.btrim(coalesce(p_chapter_id, ''));
  colour text;
begin
  if caller is null or not (select private.mfa_satisfied()) then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  caller_org := private.current_member_organization();
  select c.notice_glow into colour
    from public.chapters c
   where caller_org is not null and c.id = clean_chapter and c.organization_id = caller_org;
  if colour is null then
    raise exception 'chapter notice role required' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'chapterId', clean_chapter,
    'glow', colour,
    'canChange', private.chapter_notice_scope_allowed(clean_chapter, null, null)
      or private.chapter_officer_can(clean_chapter, 'notices'));
end;
$function$;

-- Reviewed call-graph change (account lifecycle inventory): the restated
-- functions keep their receipts, refreshed to the new definitions.
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name in ('private', 'public')
  and pg_catalog.split_part(object_name, '(', 1) in ('workload_rebalancing', 'set_chapter_notice_glow', 'get_chapter_notice_glow')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

notify pgrst, 'reload schema';

commit;
