-- Support the three auth.users ON DELETE SET NULL attribution lookups.
-- Live catalog-only.json (cleanup-perf-investigation-20261014, October 14)
-- confirms member_messages_sender_id_fkey, member_messages_redacted_by_fkey
-- and member_cases_restricted_by_fkey still reference auth.users(id) with
-- ON DELETE SET NULL. sender_id is nullable in 20260907140000;
-- restricted_by's current nullable/SET NULL rule is 20260907150000:324.
-- No FK, attribution, preservation trigger or cleanup guard is changed.
--
-- LIVE APPLY: use index-fix-20261014/APPLY.sql from the reviewed evidence
-- package. Each CREATE INDEX CONCURRENTLY IF NOT EXISTS statement is its own
-- direct-connection call, never inside a transaction or a combined SQL call.
-- Run VERIFY.sql and require all three exact definitions valid and ready;
-- IF NOT EXISTS alone cannot validate an existing same-name index.
-- Concurrent builds leave writers running. The plain migration below follows
-- 20260917102000's one-transaction convention: ordinary CREATE INDEX takes a
-- SHARE lock and blocks writers during a build. CONCURRENTLY cannot run inside
-- a transaction block. Production is pre-built concurrently before this merge;
-- a later hosted migration is then a no-op. Do not add a migration-history row
-- during the residue window, whose inventory remains pinned at 605.
-- Production's concurrent pre-build makes hosted apply a bounded no-op;
-- SAMPLE receives a bounded plain build. Timeouts bound lock waits and builds.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create index if not exists member_messages_sender_id_idx on public.member_messages (sender_id);
create index if not exists member_messages_redacted_by_idx on public.member_messages (redacted_by);
create index if not exists member_cases_restricted_by_idx on public.member_cases (restricted_by);

commit;
