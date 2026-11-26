-- Support six remaining auth.users ON DELETE SET NULL attribution lookups.
-- The window lane's October 14 live catalog (E/diag-idx/unindexed-fks.json)
-- and local catalog confirm these nullable, validated FKs and no existing
-- partial or composite index leading with their attribution column.
-- No FK, preservation trigger, row or 100-account cleanup guard changes.
--
-- LIVE APPLY: use index-fix-2-20261014/APPLY.sql from the reviewed evidence.
-- Each CREATE INDEX CONCURRENTLY IF NOT EXISTS is its own direct-connection
-- call, never a transaction or combined SQL call. Use scoped read-only catalog
-- checks between builds; run the full VERIFY.sql after all six complete.
-- VERIFY requires exact definitions, indisvalid AND indisready, and unchanged
-- SET NULL FKs. A present invalid or differently defined index is a STOP for
-- controller review; IF NOT EXISTS alone never proves success.
-- Production is pre-built CONCURRENTLY before merge, making hosted apply a
-- bounded no-op there; SAMPLE receives a bounded plain build. The plain builds
-- below follow the repository's single-transaction convention and take SHARE
-- locks. CONCURRENTLY cannot run inside a transaction block. A failed plain
-- build rolls back with this transaction; no invalid index remnant survives.
-- No migration-history row is inserted during the live residue window (605).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create index if not exists member_event_checkins_scanned_by_idx on public.member_event_checkins (scanned_by);
create index if not exists member_forms_artifact_approved_by_idx on public.member_forms (artifact_approved_by);
create index if not exists member_steward_requests_handled_by_idx on public.member_steward_requests (handled_by);
create index if not exists member_roles_granted_by_idx on public.member_roles (granted_by);
create index if not exists member_role_chapters_granted_by_idx on public.member_role_chapters (granted_by);
create index if not exists member_invitation_audit_actor_idx on public.member_invitation_audit (actor);

commit;
