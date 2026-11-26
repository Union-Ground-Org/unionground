-- Support retained account-lifecycle case-scope actor lookups during Auth deletion.
-- The October 14 read-only production diagnosis found only the case_id PK.
-- No function, trigger, row, grants or cleanup guard changes.
--
-- LIVE APPLY: use index-fix-3-20261014/APPLY.sql from the reviewed evidence.
-- Each CREATE INDEX CONCURRENTLY IF NOT EXISTS is its own direct-connection
-- call, never a transaction or combined SQL call. Use read-only pg_index checks
-- between builds, then run VERIFY.sql requiring exact valid/ready definitions.
-- A present invalid or differently defined index is a STOP for controller
-- review; IF NOT EXISTS alone never proves success.
-- Production is pre-built CONCURRENTLY before merge, making hosted apply a
-- bounded no-op there; SAMPLE receives a bounded plain build. Plain builds take
-- SHARE locks. CONCURRENTLY cannot run inside a transaction block. A failed
-- plain build rolls back with this transaction; no invalid remnant survives.
-- No migration-history row is inserted during the live residue window.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create index if not exists account_lifecycle_case_scope_owner_id_idx on private.account_lifecycle_case_scope (owner_id);
create index if not exists account_lifecycle_case_scope_steward_user_id_idx on private.account_lifecycle_case_scope (steward_user_id);
create index if not exists account_lifecycle_case_scope_coordinator_user_id_idx on private.account_lifecycle_case_scope (coordinator_user_id);

commit;
