begin;
set local lock_timeout = '5s';

-- BUG-UG-STEWARD-DESK-RPC-LATENCY-AT-SCALE-20260908.
--
-- 20260909080000 removed the per-row broadcast predicate and 20260910164000
-- stopped re-deriving the selected-organization role once per chapter. Two
-- independent profiles of the seeded SAMPLE shape (30,006 members across 20
-- chapters, 39,566 conversations, 356,762 messages, 11,920 requests) agree that
-- what is left is two access-path defects, not two authorization defects:
--
--   1. private.staff_visible_member_ids re-reads member_profiles once per
--      visible chapter. The materialized visible_chapters CTE estimates one
--      row against twenty actual rows, so the profile join runs as a twenty-
--      iteration nested loop whose inner Bitmap Heap Scan touches 13,640 heap
--      blocks -- 19.3x the whole 707-page table -- for ONE helper invocation,
--      because the round-robin chapter assignment interleaves every chapter
--      across every page. That single node is 99.3% of the helper and 96-99%
--      of every non-KPI desk statement, and the helper is evaluated three to
--      five times per RPC (one hashed SubPlan per policy-bearing scan).
--
--   2. get_steward_desk_kpis' awaiting-reply tile descends
--      member_messages_convo_created_id_idx once per RLS-visible conversation
--      (38,566 correlated latest-message probes) and heap-fetches each match,
--      because neither the projected sender_kind nor the user_id that
--      member_messages_select_steward tests is in that index: 168,060 of the
--      statement's 182,384 buffer touches, 92.1% of the slowest RPC and the
--      one that was cancelled at 8,309 ms (SQLSTATE 57014) on 2026-09-10.
--
-- This migration repairs both as access paths and leaves every authorization
-- decision exactly where it is. It adds two indexes and rewrites one line of
-- one SECURITY DEFINER helper's final projection. It creates, drops and alters
-- no policy; it changes no SECURITY INVOKER boundary; get_steward_desk_kpis and
-- all six steward SELECT policies are untouched and still decide visibility;
-- it changes no grant, role setting or statement_timeout -- authenticated keeps
-- its 8 s ceiling. No role can read a row it could not read before this file.
--
-- Measured at the seeded SAMPLE shape (warm single-call p50 / worst per-RPC
-- call inside eight simultaneous five-connection waves, in ms):
--
--                            requests    conversations   KPI          forms
--   before (this Main head)  59.5/144.7   83.7/165.0     105.3/228.5  48.8/147.4
--   after  (this migration)  37.4/102.3   50.4/120.7      76.0/160.6  30.7/ 96.4
--
-- The same fixture measured 188.9 / 294.0 / 232.3 / 175.0 ms before
-- 20260910164000, which is the configuration the last SAMPLE benchmark
-- (2,084 / 2,458 / 2,433 / 2,056 ms) matches; applying 20260910164000 to SAMPLE
-- is therefore a prerequisite for these numbers, not a substitute for them.

-- 1. The visibility helper's profile lookup becomes index-only.
--
-- The helper projects member_profiles.id filtered by chapter_id and nothing
-- else, so (chapter_id, id) covers it completely: the twenty inner scans stop
-- visiting the heap at all. Helper SubPlan buffers fall 13,822 -> 428 (-96.9%),
-- the requests page statement 27,896 -> 932, the forms page 27,691 -> 727, the
-- conversations page 56,189 -> 1,766. Index size at SAMPLE scale: ~2 MB.
--
-- This is purely additive. member_profiles_chapter_idx (chapter_id) is now a
-- prefix of this index and is deliberately LEFT IN PLACE: it is pinned in
-- scripts/db-contract.json #indexes, and retiring a contract-pinned index is a
-- separate decision with its own evidence, not a rider on a latency repair.
--
-- CONCURRENTLY cannot run inside a transaction block and this repository
-- applies migrations through the single-transaction path that
-- scripts/verify-repository-conventions.mjs enforces, so this is a plain
-- CREATE INDEX, following the 20260724193000 precedent. It holds SHARE on
-- member_profiles (readers proceed, writers wait) for the ~20 ms the build
-- takes at this scale, and lock_timeout above fails the whole migration closed
-- rather than queueing behind a long writer.
-- Plain CREATE INDEX, not IF NOT EXISTS: a target that already carries an
-- index of this name with a different definition must fail this migration
-- closed rather than skip the repair silently.
create index member_profiles_chapter_id_idx
  on public.member_profiles (chapter_id, id);

-- 2. The latest-message probe becomes index-only.
--
-- (conversation_id, created_at desc, id desc) is the probe's own ORDER BY, so
-- the descent reaches the newest message without a sort; INCLUDE carries the
-- two columns the probe still needs off-index -- sender_kind, which the KPI
-- projects and compares to 'member', and user_id, which is the only column
-- member_messages_select_steward and the user_id half of
-- member_messages_select_own test. Both policies keep evaluating unchanged;
-- they simply evaluate against the index tuple instead of a heap tuple, so
-- Heap Fetches drops to 0 and the awaiting-reply tile falls from 182,384 to
-- 116,855 buffer touches. The same index serves list_steward_conversations'
-- LATERAL last-message subquery and its per-thread message count.
--
-- INCLUDE columns are payload, never a filter and never part of uniqueness, so
-- this index cannot admit a message row that the policies exclude.
--
-- Cost: ~29 MB at SAMPLE scale and one more index to maintain on
-- member_messages writes -- the only real price in this file. Retiring the now
-- strictly redundant member_messages_conversation_created_idx (a prefix of
-- member_messages_convo_created_id_idx since 20260809040000, independently of
-- this change) would repay part of it and is likewise left to its own decision.
create index member_messages_convo_latest_idx
  on public.member_messages (conversation_id, created_at desc, id desc)
  include (sender_kind, user_id);

-- 3. The helper materializes its member set in one pass instead of one per
--    chapter.
--
-- Only the final projection changes. Every MFA, tenant, organization-
-- membership, organization-role, chapter-role, active-membership and legacy
-- unscoped-chapter branch above it is byte-for-byte the 20260910164000 body,
-- and the function keeps LANGUAGE plpgsql with RETURN QUERY, STABLE, SECURITY
-- DEFINER and SET search_path = '' so the same prepared visibility statement is
-- still reused across the RLS scans of one backend.
--
-- Equality of the returned set, not similarity: chapters.id is the primary key,
-- so visible_chapters holds at most one row per chapter and
--   profile.chapter_id = any (array(select visible_chapters.id ...))
-- admits exactly the profiles the join admitted and multiplies no row. A NULL
-- chapter_id yields NULL, which is not true, exactly as the inner join dropped
-- it; an empty visible_chapters yields an empty array, which matches nothing,
-- exactly as the join returned nothing. Compared row by row against the
-- canonical 20260826150000 body over org-steward at aal2 for role steward,
-- coordinator and null, the same steward at aal1, a non-staff member, an orphan
-- JWT subject, a chapter-only grant after the organization grant is deleted, a
-- revoked chapter membership, and the legacy unscoped-chapter branch: zero
-- differences and identical counts in all nine cases (30,006 / 0 / 0 / 0 / 0 /
-- 0 / 1,501 / 0 / 1,501). tests/steward-desk-scale-latency-db.test.js re-proves
-- that same comparison against that same canonical body on every run.
--
-- Why this and not only the index: the array form forces one bitmap pass over
-- member_profiles (Heap Blocks exact 13,640 -> 682) whatever the planner
-- believes about the materialized CTE's cardinality, so the repair does not
-- depend on a fresh ANALYZE or on the new index being chosen. The index makes
-- that one pass index-only; the rewrite makes it one pass.
create or replace function private.staff_visible_member_ids(p_role text)
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  return query
  with caller as materialized (
    select
      (select auth.uid()) as uid,
      (select private.current_member_organization()) as organization_id
  ),
  organization_role as materialized (
    select case when caller.uid is not null and p_role is not null
      and caller.organization_id is not null and (select private.mfa_satisfied())
      then private.has_organization_role(caller.organization_id, array[p_role])
      else false end as allowed
    from caller
  ),
  visible_chapters as materialized (
    select chapter.id
    from public.chapters chapter
    cross join caller
    cross join organization_role
    where caller.uid is not null
      and p_role is not null
      and (select private.mfa_satisfied())
      and (
        (
          chapter.organization_id is not null
          and chapter.organization_id = caller.organization_id
          and (
            organization_role.allowed
            or private.member_has_chapter_role(
              chapter.id,
              array[p_role]
            )
          )
        )
        or (
          chapter.organization_id is null
          and caller.organization_id is null
          and exists (
            select 1
            from public.member_profiles caller_profile
            left join public.chapters caller_chapter
              on caller_chapter.id = caller_profile.chapter_id
            where caller_profile.id = caller.uid
              and (
                caller_chapter.id is null
                or caller_chapter.organization_id is null
              )
          )
          and (
            not (select private.staff_mfa_required())
            or (select private.has_second_factor(caller.uid))
          )
          and exists (
            select 1
            from public.member_roles role_grant
            where role_grant.user_id = caller.uid
              and role_grant.role = p_role
              and (
                role_grant.chapter_id is null
                or exists (
                  select 1
                  from public.member_role_chapters role_chapter
                  join public.member_chapter_memberships membership
                    on membership.user_id = role_chapter.user_id
                   and membership.chapter_id = role_chapter.chapter_id
                  join public.chapters mapped_chapter
                    on mapped_chapter.id = role_chapter.chapter_id
                  where role_chapter.user_id = role_grant.user_id
                    and role_chapter.role = role_grant.role
                    and role_chapter.chapter_id = chapter.id
                    and mapped_chapter.organization_id is null
                    and membership.status = 'active'
                )
              )
          )
        )
      )
  )
  select profile.id
  from public.member_profiles profile
  where profile.chapter_id = any (array(select visible_chapters.id from visible_chapters));
end;
$function$;

-- CREATE OR REPLACE preserves the existing ACL; these re-assert it unchanged so
-- the helper stays private, stays outside PostgREST's exposed RPC schema, and
-- gains no schema grant. Identical to 20260910164000.
revoke all on function private.staff_visible_member_ids(text)
  from public, anon, authenticated, service_role;
grant execute on function private.staff_visible_member_ids(text)
  to authenticated, service_role;

comment on function private.staff_visible_member_ids(text) is
  'Set-wise mirror of staff_can_see_user for stored RLS policy evaluation; '
  'not a client RPC and does not grant private schema usage. The final '
  'projection matches the materialized visible-chapter set in one pass over '
  'member_profiles; the admitted set is unchanged.';

notify pgrst, 'reload schema';
commit;
