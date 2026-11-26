-- Column-scope the member INSERT on member_steward_requests
-- (REQ-UG-STEWARD-REQUEST-INSERT-SCOPE-20260726).
--
-- VECTOR
-- 20260720191847 ~:376 granted `select, insert` TABLE-WIDE, and the insert
-- policy (~:353) constrains exactly ONE column:
--   member_steward_requests_insert_own ... with check ((select auth.uid()) = user_id)
-- 20260722001108 then bolted the triage state onto the same table
-- (acknowledged_at, closed_at, handled_by at ~:21-23) and column-scoped SELECT
-- at ~:293 so handled_by is never member-readable -- but left INSERT alone.
-- A member can therefore POST a row that arrives already status='closed', with
-- acknowledged_at/closed_at stamped to any instant and handled_by attributed
-- to any auth.users uuid they can name. RLS never sees it: the policy checks
-- user_id and nothing else.
--
-- SEVERITY: MEDIUM, not HIGH -- it does NOT mint points.
-- private.award_steward_interaction (20260725230000) is an AFTER UPDATE
-- trigger, so an INSERT cannot fire it however the row is shaped, and the same
-- migration removed the 'steward' branch from private.award_member_points, so
-- a member-minted 'steward-' action-log key is no longer backed either. What
-- the forgery buys is (a) audit-trail forgery on a representation-duty
-- artefact -- the row IS the durable record that a member asked for a steward
-- and what a steward did about it -- and (b) self-suppression: triage is a
-- forward-only conditional update (triage_steward_request refuses a row
-- already past the step it is being moved to), so a request born 'closed' is
-- invisible to the triage queue and can never be worked.
--
-- FIX -- the canonical pattern from 20260725120000 ~:58: Supabase's platform
-- default privileges grant `authenticated` table-wide INSERT (every column) at
-- CREATE TABLE time, so the table-level bit must be REVOKED before a column
-- grant means anything -- a bare `grant insert (col)` leaves the wider bit
-- standing underneath it and the whole statement is decorative.
--
-- COLUMN LIST -- verified against the only client caller, not assumed:
-- src/lib/memberApi.js requestSteward() ~:685 posts exactly
--   .insert({ user_id: userId, lesson_id: lessonId }).select("id").single()
-- and nothing else in src/, api/ or scripts/ writes this table. The `.select("id")`
-- read-back is served by the existing column-scoped SELECT grant, which
-- already lists id. id / status / created_at all carry defaults, so an INSERT
-- that names neither still succeeds -- and status now can only ever be born
-- 'requested', which is what the triage queue reads.
--
-- ROLLBACK (only if a bundle ever starts writing a further column -- widen the
-- column list instead if you can; the table bit is the thing to avoid):
--   grant insert on public.member_steward_requests to authenticated;
--   notify pgrst, 'reload schema';
--
-- CONTRACT COORDINATION (scripts/db-contract.json): applying this shrinks the
-- knownGaps.surplusClientTableGrants string for this table from
-- INSERT,UPDATE,DELETE to UPDATE,DELETE and adds an INSERT columnGrants entry.
-- The verifier matches gap strings exactly, so the shrunk string reads as a
-- NEW gap until the contract is updated -- land the contract update in the
-- same operational step as this apply, before any CI run.

set local lock_timeout = '5s';

revoke insert on public.member_steward_requests from authenticated;
grant  insert (user_id, lesson_id) on public.member_steward_requests to authenticated;

notify pgrst, 'reload schema';
