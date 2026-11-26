-- REFERENCES/TRIGGER/MAINTAIN revoke across every client-granted table plus the
-- default-privilege source that mints them (REQ-UG-REFTRIGGER-SWEEP-20260725;
-- the second and final half of the stock-default-ACL cleanup begun by
-- 20260725220000).
--
-- VECTOR
-- Supabase's stock default privileges for schema public still read
-- `anon=arwdxtm` / `authenticated=arwdxtm` (pg_default_acl, grantor postgres,
-- live 2026-07-26). 20260725220000 removed the `D`; `x` (REFERENCES), `t`
-- (TRIGGER) and `m` (MAINTAIN) remain. None of the three is a row operation, so
-- RLS never filters any of them -- the same property that made TRUNCATE worth
-- revoking. They are unreachable today only by accident of configuration: the
-- client roles cannot log in, hold CREATE on no schema (checked: every
-- non-system schema), and PostgREST exposes no DDL verb. This migration stops
-- depending on that accident, exactly as its predecessor did.
--
-- The PostgreSQL 17.6 default ACL includes REFERENCES, TRIGGER and
-- MAINTAIN (VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH MATVIEW), which
-- did not exist before PG17. Evidence that it is a real blind spot rather than a
-- theoretical one: 20260723200500 deliberately revoked
-- `insert, delete, truncate, references, trigger` on member_notifications and
-- still left MAINTAIN behind, because the author's list predated the privilege.
-- That table now holds SELECT,MAINTAIN and is invisible to BOTH verifier sweeps.
-- Scoping this migration to x/t would have closed the item while leaving the one
-- bit that already escaped a careful hand-audit.
--
-- FIX
-- 1. Revoke references, trigger, maintain from the client roles on all 31
--    (table, role) pairs holding any of the three. Enumerated live from
--    pg_class / has_table_privilege -- NOT from information_schema, which
--    CANNOT report MAINTAIN (it is a Postgres extension to the SQL standard;
--    information_schema.role_table_grants returns REFERENCES 30 / TRIGGER 30
--    and no MAINTAIN row at all). That is precisely why the predecessor's
--    enumeration method could not have found the 31st pair.
-- 2. Fix the source: alter the postgres default ACL so tables created by this
--    repo's migrations are born `arwd` for the client roles and nothing else.
--    supabase_admin also carries a stock default ACL for schema public, but
--    postgres is not a member of that role and cannot alter it; repo migrations
--    run as postgres, so the postgres entry governs every table this repo
--    creates. A table created by supabase_admin would surface as a NEW surplus
--    key and fail the verifier's sweep -- which is the intended behaviour.
--
-- SCOPE -- strictly references/trigger/maintain. The RLS-masked DML surplus
-- stays recorded in scripts/db-contract.json#knownGaps.surplusClientTableGrants
-- (ratcheted: shrink-only). demo_* DML is untouched pending its own write-path
-- audit -- the same surgical discipline that kept 20260725120000 and
-- 20260725220000 narrow.
--
-- CONTRACT COORDINATION: none required, and that is the argument for revoking
-- rather than recording. The verifier's privilege arrays are widened to all
-- eight privileges in the SAME commit; because this migration removes the three
-- new ones, every recorded string in db-contract.json is byte-identical before
-- and after -- all 28 knownGaps entries, both member_kb_articles tableGrants
-- rows, and member_notifications. Recording the bits instead would have grown 31
-- strings now and shrunk the same 31 again the day they were revoked.
--
-- SYNTAX PROOF (prod, 2026-07-26, probe table rolled back by a P0509 sentinel):
--   born_with    = DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,UPDATE
--   after_revoke = DELETE,INSERT,SELECT,UPDATE
--   service_role = DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- The absent TRUNCATE in born_with is 20260725220000's default-ACL half still
-- holding; service_role deliberately keeps its full set.
--
-- ROLLBACK (restore-previous-state recipe only -- none of the three has a
-- legitimate client caller, so this is not an expected path):
--   grant references, trigger, maintain on public.demo_broadcasts,
--     public.demo_cases, public.demo_conversations, public.demo_members,
--     public.demo_metrics, public.demo_plan_items, public.demo_rights_lessons,
--     public.demo_week_days, public.demo_weekly_summaries,
--     public.member_action_log, public.member_ballot_options,
--     public.member_ballot_votes, public.member_ballots,
--     public.member_broadcast_receipts, public.member_broadcasts,
--     public.member_case_updates, public.member_cases,
--     public.member_conversations, public.member_guide_messages,
--     public.member_guide_threads, public.member_kb_articles,
--     public.member_messages, public.member_notifications,
--     public.member_profiles, public.member_rights_lessons,
--     public.member_rights_progress, public.member_steward_requests,
--     public.member_survey_options, public.member_survey_responses,
--     public.member_surveys to authenticated;
--   grant references, trigger, maintain on public.member_kb_articles to anon;
--   alter default privileges for role postgres in schema public
--     grant references, trigger, maintain on tables to anon, authenticated;
--   notify pgrst, 'reload schema';

set local lock_timeout = '5s';

revoke references, trigger, maintain on public.demo_broadcasts from authenticated;
revoke references, trigger, maintain on public.demo_cases from authenticated;
revoke references, trigger, maintain on public.demo_conversations from authenticated;
revoke references, trigger, maintain on public.demo_members from authenticated;
revoke references, trigger, maintain on public.demo_metrics from authenticated;
revoke references, trigger, maintain on public.demo_plan_items from authenticated;
revoke references, trigger, maintain on public.demo_rights_lessons from authenticated;
revoke references, trigger, maintain on public.demo_week_days from authenticated;
revoke references, trigger, maintain on public.demo_weekly_summaries from authenticated;
revoke references, trigger, maintain on public.member_action_log from authenticated;
revoke references, trigger, maintain on public.member_ballot_options from authenticated;
revoke references, trigger, maintain on public.member_ballot_votes from authenticated;
revoke references, trigger, maintain on public.member_ballots from authenticated;
revoke references, trigger, maintain on public.member_broadcast_receipts from authenticated;
revoke references, trigger, maintain on public.member_broadcasts from authenticated;
revoke references, trigger, maintain on public.member_case_updates from authenticated;
revoke references, trigger, maintain on public.member_cases from authenticated;
revoke references, trigger, maintain on public.member_conversations from authenticated;
revoke references, trigger, maintain on public.member_guide_messages from authenticated;
revoke references, trigger, maintain on public.member_guide_threads from authenticated;
revoke references, trigger, maintain on public.member_kb_articles from authenticated;
revoke references, trigger, maintain on public.member_kb_articles from anon;
revoke references, trigger, maintain on public.member_messages from authenticated;
revoke references, trigger, maintain on public.member_notifications from authenticated;
revoke references, trigger, maintain on public.member_profiles from authenticated;
revoke references, trigger, maintain on public.member_rights_lessons from authenticated;
revoke references, trigger, maintain on public.member_rights_progress from authenticated;
revoke references, trigger, maintain on public.member_steward_requests from authenticated;
revoke references, trigger, maintain on public.member_survey_options from authenticated;
revoke references, trigger, maintain on public.member_survey_responses from authenticated;
revoke references, trigger, maintain on public.member_surveys from authenticated;

-- The durable half: stop minting the gap. Tables created by postgres -- every
-- table this repo's migrations create -- are now born `arwd` for the client
-- roles, exactly the DML set knownGaps documents and nothing more.
-- service_role deliberately keeps its full default set.
alter default privileges for role postgres in schema public
  revoke references, trigger, maintain on tables from anon, authenticated;

notify pgrst, 'reload schema';
