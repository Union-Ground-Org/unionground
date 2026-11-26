-- Name the three organizing lifecycle tables that are declared but not yet
-- reachable, so the next reader does not re-file them as dead code.
--
-- Reconciled on 2026-10-14 (this file ran at 20260725102000): comments only;
-- no earlier migration has tables under these names.
--
-- public.organizing_workers, public.organizing_contact_events and
-- public.organizing_resistance_evidence were created, indexed, triggered,
-- RLS-enabled and revoked from every role by
-- 20261014001000_unionground_union_lifecycle.sql, but no writer exists in
-- any migration and no reader exists in any projection RPC, so by
-- construction they cannot hold a row today.
--
-- They are kept, not dropped. The contact-logging and evidence-custody
-- writers are acceptance criteria of REQ-UG-UNION-LIFECYCLE-20260723
-- that have not landed yet, the RLS/revoke posture is already correct for
-- when they do, and the table names are pinned as required-present by
-- tests/unionground-lifecycle-security.test.js and
-- scripts/verify-unionground-db.mjs — so dropping them would trade a
-- documentation gap for a broken invariant check.
--
-- A comment, not a migration comment block, because the ambiguity is read
-- from the live catalogue as often as from this file.

comment on table public.organizing_workers is
  'Declared, not yet reachable: no writer exists in any migration and no '
  'projection reads it, so this table holds no rows by construction. The '
  'contact-logging writers land under REQ-UG-UNION-LIFECYCLE-20260723; '
  'the ungranted, RLS-enabled posture here is the intended end state.';

comment on table public.organizing_contact_events is
  'Declared, not yet reachable: written only by the contact-logging writers '
  'pending under REQ-UG-UNION-LIFECYCLE-20260723. Holds no rows '
  'by construction until they land.';

comment on table public.organizing_resistance_evidence is
  'Declared, not yet reachable: evidence custody (storage object lifecycle, '
  'chain-of-custody audit) is unbuilt, so no writer references this table. '
  'Holds no rows by construction until REQ-UG-UNION-LIFECYCLE-20260723 '
  'lands the evidence writers.';
