-- PERF-UG-MESSAGE-LEGAL-HOLDS-ORG-INDEX-MISSING-20260921
--
-- public.member_message_legal_holds (20260907121000_member_message_body_lifecycle.sql
-- :158-173) is keyed on conversation_id and carries organization_id as a NOT
-- NULL foreign key to public.organizations declared ON UPDATE CASCADE ON DELETE
-- RESTRICT. No migration in the tree ever indexed that column, so the primary
-- key on conversation_id is the table's only index and organization_id is an
-- unindexed foreign key.
--
-- Two readers pay for that. public.list_member_message_legal_holds()
-- (20260917120000_admin_mfa_reset_notice_and_legal_hold_surface.sql:279) filters
-- `where h.organization_id = org and h.released_at is null`, which can only be a
-- sequential scan; and every referential-integrity check behind the foreign key
-- -- the ON UPDATE CASCADE walk, and the ON DELETE RESTRICT probe that runs
-- whenever an organization row is deleted -- has no index to descend either.
--
-- Preservation orders are rare by design (the table comment at 20260907121000
-- :175-176 says so), so the cost today is a handful of pages and the admin list
-- is capped at 100 rows. This is the unindexed-foreign-key nit the production
-- advisor lints, of the same shape 20260820210000:85-95 already covered
-- elsewhere in this subsystem, and it is fixed here before the table grows.
--
-- The index is NOT partial on `released_at is null`. A partial index would be
-- the tighter fit for the admin list alone, but PostgreSQL's referential
-- integrity checks cannot use a partial index, so the partial form would leave
-- the foreign key exactly as uncovered as it is today. A plain btree on
-- organization_id serves the foreign key and leads the admin list's predicate;
-- released_at is then a filter over a handful of tenant rows.
--
-- CONCURRENTLY cannot run inside a transaction block and this repository applies
-- migrations through the single-transaction path, so this is a plain CREATE
-- INDEX, following the 20260726 forms foreign-key index precedent. Additive
-- only: no grant, policy, constraint, function, trigger or row is touched.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists member_message_legal_holds_organization_idx
  on public.member_message_legal_holds (organization_id);

comment on index public.member_message_legal_holds_organization_idx is
  'Covers organization_id for the organizations link and leads the organization predicate in public.list_member_message_legal_holds(); carries no message content.';

commit;
