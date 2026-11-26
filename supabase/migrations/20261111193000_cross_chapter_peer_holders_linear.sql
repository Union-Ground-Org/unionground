-- BUG-UG-CROSS-CHAPTER-PEER-LIST-AND-STORAGE-GRANT-PROOFS-TIME-OUT-20261111 (#8353).
--
-- private.cross_chapter_peer_holders applied its per-person access checks
-- (chapter_role_scope_expired, has_second_factor, staff_mfa_required and the
-- verified-key session) at the same query level as its five joins. When the
-- planner chose a nested loop, which depends on table statistics, the checks
-- ran once per pair of candidates instead of once per candidate: with 203
-- chapter leads one page of public.list_cross_chapter_peers made 164,024 calls
-- of each check in 3.5 s on a test machine, against 808 calls in 33 ms on the
-- usual plan, and a slower CI runner passed the proof's 15-second limit
-- (run 43072779679).
--
-- The joins now run first in a materialized step, and the checks filter its
-- rows, so each check runs once per candidate whatever the join order. The
-- organization-wide checks (the enabled level and whether the organization
-- requires staff two-step) are read once per call. The holders, the access
-- rules and the result are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local search_path = pg_catalog;

do $preflight$
begin
  if pg_catalog.md5(pg_catalog.pg_get_functiondef('private.cross_chapter_peer_holders(uuid,text)'::regprocedure)) <> '11c914688dad336272f5334565aa627c' then
    raise exception 'unreviewed predecessor: private.cross_chapter_peer_holders(uuid,text)' using errcode = '55000';
  end if;
end;
$preflight$;

create or replace function private.cross_chapter_peer_holders(p_org uuid, p_role text)
returns table(user_id uuid, chapter_id text, chapter_name text)
language sql
stable
security definer
set search_path = ''
as $function$
  -- The joins first, materialized, so the per-person access checks below run
  -- once per candidate whatever join order the planner picks; under a nested
  -- loop they otherwise ran once per pair of candidates.
  with candidate as materialized (
    select rc.user_id, rc.role, chapter.id as chapter_id, chapter.name as chapter_name
    from public.member_role_chapters rc
    join public.chapters chapter on chapter.id = rc.chapter_id and chapter.organization_id = p_org
    join public.organizations organization on organization.id = p_org and organization.status = 'active'
    join public.organization_memberships om
      on om.user_id = rc.user_id and om.organization_id = p_org and om.status = 'active'
    join public.member_chapter_memberships cm
      on cm.user_id = rc.user_id and cm.chapter_id = chapter.id and cm.status = 'active'
    join auth.users account on account.id = rc.user_id
    where rc.role = p_role
      and (select p_role = any(private.cross_chapter_peer_levels(p_org)))
      and account.deleted_at is null
      and coalesce(account.banned_until, '-infinity'::timestamptz) <= pg_catalog.now()
  )
  select rc.user_id, rc.chapter_id, rc.chapter_name
  from candidate rc
  where not private.chapter_role_scope_expired(rc.user_id, rc.chapter_id, rc.role)
    and not exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = rc.user_id)
    and (not (select private.staff_mfa_required(p_org)) or private.has_second_factor(rc.user_id)
      -- As in private.member_peer_staff_eligible: the caller's key assurance
      -- must belong to the current JWT (has_second_factor checks that), and
      -- anyone else may count only their own live verified-key session.
      or (rc.user_id is distinct from (select auth.uid())
        and exists (select 1 from private.verified_key_sessions key_session
          where key_session.user_id = rc.user_id
            and private.verified_key_session(rc.user_id, key_session.session_id))))
$function$;
revoke all on function private.cross_chapter_peer_holders(uuid, text) from public, anon, authenticated, service_role;
comment on function private.cross_chapter_peer_holders(uuid, text) is
  'Live holders of an enabled cross-chapter contact level on the organization''s chapters (REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109). #8353: the joins run first in a materialized step so each per-person check runs once per candidate under any join order.';

commit;
