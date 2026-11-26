-- TRUNCATE revoke across every client-granted table + the default-privilege
-- source (REQ-UG-TRUNCATE-REVOKE-20260725; deferred from #568's contract
-- verifier findings, its own careful cycle as recorded in the worklist).
--
-- VECTOR
-- Supabase's stock default privileges (`postgres=arwdDxtm` for anon and
-- authenticated in schema public) hand every new table the full privilege
-- set. The repo's migrations only ever ADD narrow grants and never `revoke
-- all` first, so 29 tables still grant TRUNCATE to authenticated (and
-- member_kb_articles to anon as well). RLS masks the DML surplus — TRUNCATE
-- is not a row operation and is NEVER filtered by a policy. The only reason
-- this is not exploitable today is an accident of the API surface: PostgREST
-- has no TRUNCATE verb and authenticated has no SQL channel. This migration
-- stops relying on that accident.
--
-- FIX
-- 1. Revoke TRUNCATE from authenticated on all 29 tables that still grant it
--    (enumerated live from information_schema.role_table_grants, not from the
--    migration tree), and from anon on member_kb_articles (the one anon case).
-- 2. Fix the source: alter default privileges for role postgres so tables
--    created by future migrations are not born with TRUNCATE. (supabase_admin
--    also carries a stock default ACL, but postgres is not a member of that
--    role and cannot alter it; repo migrations run as postgres, so the
--    postgres entry is the one that governs every table this repo creates.)
--
-- SCOPE — strictly TRUNCATE. The remaining RLS-masked DML surplus stays
-- recorded in scripts/db-contract.json#knownGaps.surplusClientTableGrants
-- (ratcheted: shrink-only). The REFERENCES/TRIGGER bits of the same stock
-- default ACL are untouched and — unlike the DML — are NOT yet swept by
-- verify:db at all (its privilege arrays are SELECT/INSERT/UPDATE/DELETE/
-- TRUNCATE only); widening the sweep is filed as
-- REQ-UG-REFTRIGGER-SWEEP-20260725. demo_* DML was deliberately not
-- touched: the demo surface is
-- fully client-side (src/data/fallback.js; no repo code queries demo_*
-- tables), but widening this migration beyond TRUNCATE would need its own
-- write-path audit — same reasoning that kept 20260725120000 surgical.
--
-- ROLLBACK (copy-paste; TRUNCATE has no legitimate client caller, so this is
-- strictly a restore-the-previous-state recipe, not an expected path):
--   grant truncate on public.demo_broadcasts, public.demo_cases,
--     public.demo_conversations, public.demo_members, public.demo_metrics,
--     public.demo_plan_items, public.demo_rights_lessons, public.demo_week_days,
--     public.demo_weekly_summaries, public.member_action_log,
--     public.member_ballot_options, public.member_ballot_votes,
--     public.member_ballots, public.member_broadcast_receipts,
--     public.member_broadcasts, public.member_case_updates, public.member_cases,
--     public.member_conversations, public.member_guide_messages,
--     public.member_guide_threads, public.member_kb_articles,
--     public.member_messages, public.member_profiles,
--     public.member_rights_lessons, public.member_rights_progress,
--     public.member_steward_requests, public.member_survey_options,
--     public.member_survey_responses, public.member_surveys to authenticated;
--   grant truncate on public.member_kb_articles to anon;
--   alter default privileges for role postgres in schema public
--     grant truncate on tables to anon, authenticated;
--   notify pgrst, 'reload schema';

set local lock_timeout = '5s';

revoke truncate on public.demo_broadcasts from authenticated;
revoke truncate on public.demo_cases from authenticated;
revoke truncate on public.demo_conversations from authenticated;
revoke truncate on public.demo_members from authenticated;
revoke truncate on public.demo_metrics from authenticated;
revoke truncate on public.demo_plan_items from authenticated;
revoke truncate on public.demo_rights_lessons from authenticated;
revoke truncate on public.demo_week_days from authenticated;
revoke truncate on public.demo_weekly_summaries from authenticated;
revoke truncate on public.member_action_log from authenticated;
revoke truncate on public.member_ballot_options from authenticated;
revoke truncate on public.member_ballot_votes from authenticated;
revoke truncate on public.member_ballots from authenticated;
revoke truncate on public.member_broadcast_receipts from authenticated;
revoke truncate on public.member_broadcasts from authenticated;
revoke truncate on public.member_case_updates from authenticated;
revoke truncate on public.member_cases from authenticated;
revoke truncate on public.member_conversations from authenticated;
revoke truncate on public.member_guide_messages from authenticated;
revoke truncate on public.member_guide_threads from authenticated;
revoke truncate on public.member_kb_articles from authenticated;
revoke truncate on public.member_kb_articles from anon;
revoke truncate on public.member_messages from authenticated;
revoke truncate on public.member_profiles from authenticated;
revoke truncate on public.member_rights_lessons from authenticated;
revoke truncate on public.member_rights_progress from authenticated;
revoke truncate on public.member_steward_requests from authenticated;
revoke truncate on public.member_survey_options from authenticated;
revoke truncate on public.member_survey_responses from authenticated;
revoke truncate on public.member_surveys from authenticated;

-- The durable half: stop minting the gap. Tables created by postgres (every
-- table this repo's migrations create) no longer default-grant TRUNCATE to
-- the client roles. service_role deliberately keeps its full default set.
alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- CONTRACT COORDINATION (scripts/db-contract.json): every
-- knownGaps.surplusClientTableGrants privilege string loses its TRUNCATE
-- token in the same commit — the verifier matches gap strings exactly, so a
-- shrunk live grant reads as a NEW gap until the contract is updated. The two
-- member_kb_articles entries are DELETED from knownGaps: with TRUNCATE gone
-- the rows are SELECT-only and leave the surplus sweep, so the table's
-- privilege truth moves to tableGrants instead — authenticated SELECT by
-- grant (20260722143000), anon SELECT recorded as stock-default-ACL residue
-- that no migration ever granted, masked only by the authenticated-scoped
-- read policy. The knownGaps `why` text records this migration as the
-- closure.

notify pgrst, 'reload schema';
