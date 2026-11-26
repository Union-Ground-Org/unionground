-- REQ-UG-TECH-DEBT-20260724: covering indexes for hot unindexed FK/filter
-- columns, plus removal of three functions that no live caller reaches.
--
-- Part 1 — indexes. Postgres indexes a composite primary key left-to-right
-- only, so a table keyed (parent_id, user_id) has NO usable index for a
-- predicate on user_id alone. Every member-facing RLS policy on these tables
-- filters exactly that column (`user_id = auth.uid()`), which means the
-- self-read path degrades to a sequential scan that grows with the whole
-- membership, not with one member's rows. member_ballot_votes and
-- member_survey_responses are both in that shape. The remainder are plain FK
-- columns with no index at all: member_broadcasts.created_by is counted on
-- every steward publish (the 5-per-24h rate limit), member_case_updates.user_id
-- and member_guide_messages.user_id back per-member reads, and both
-- member_admin_audit FKs are `on delete set null` — an unindexed referencing
-- column forces a full scan of the audit table on every auth.users deletion.
--
-- All seven are additive and idempotent (`if not exists`). Written as ordinary
-- CREATE INDEX rather than CONCURRENTLY on purpose: this file is applied inside
-- the normal single-transaction migration path, which CONCURRENTLY cannot join,
-- and these tables are small enough that the brief ShareLock is not a
-- production concern. No policy, grant, RPC, or row is touched, so behaviour is
-- identical before and after — only the plans change.
--
-- Part 2 — dead function cleanup. Three private helpers were superseded by
-- newer overloads and left behind. Each is verified orphaned by repo-wide grep
-- (no SQL body, client module, script, or API route reaches them):
--
--   * private.save_member_guide_exchange(uuid, text, text) — its ONLY caller was
--     the 3-arg public.save_member_guide_exchange, dropped in
--     20260722143000_member_compass_kb_retrieval.sql when the sources-carrying
--     4-arg public.save_member_guide_exchange(uuid, text, text, jsonb) replaced
--     it. That 4-arg function is LIVE (memberApi.js persists every Compass
--     answer through it) and is fully self-contained — it inlines the whole
--     body and never delegates to the private helper. It must survive this
--     migration untouched, which is why the drop below is schema-qualified to
--     `private` and pins the exact 3-argument signature. A bare
--     `drop function save_member_guide_exchange` or a 4-arg signature here
--     would take out the live Compass write path.
--
--   * private.form_required_keys(text) and private.form_template_label(text) —
--     superseded when 20260723112000_member_forms_template_registry_fk.sql moved
--     submit_form to the version-pinned form_required_keys(text, integer) and
--     moved every steward notification to form_template_label_localized. The
--     surviving overloads do NOT delegate to the 1-arg forms (each re-queries
--     public.form_templates directly), so dropping the 1-arg forms cannot
--     regress them. Signatures are pinned so the overloads are unambiguous.
--
-- private.form_points(text) is deliberately NOT dropped: it has no versioned
-- replacement and submit_form still awards points through it.
--
-- Grants are revoked before each drop. DROP removes dependent privileges
-- anyway, but the explicit revoke keeps the "no client reachability" statement
-- true even if a drop is ever commented out during a rollback.

-- 1. Composite-PK tables whose RLS self-select filters the trailing column.
create index if not exists member_ballot_votes_user_id_idx
  on public.member_ballot_votes(user_id);
create index if not exists member_survey_responses_user_id_idx
  on public.member_survey_responses(user_id);

-- 2. Plain FK columns with no covering index.
create index if not exists member_broadcasts_created_by_idx
  on public.member_broadcasts(created_by);
create index if not exists member_case_updates_user_id_idx
  on public.member_case_updates(user_id);
create index if not exists member_guide_messages_user_id_idx
  on public.member_guide_messages(user_id);

-- 3. `on delete set null` FKs into auth.users: unindexed here means a full
--    audit-table scan on every user deletion.
create index if not exists member_admin_audit_actor_idx
  on public.member_admin_audit(actor);
create index if not exists member_admin_audit_target_user_idx
  on public.member_admin_audit(target_user);

-- 4. Orphaned guide-persistence helper. Exact 3-arg signature only; the live
--    4-arg public.save_member_guide_exchange(uuid, text, text, jsonb) is not
--    referenced here and is not affected.
revoke all on function private.save_member_guide_exchange(uuid, text, text)
  from public, anon, authenticated;
drop function if exists private.save_member_guide_exchange(uuid, text, text);

-- 5. Orphaned unversioned form helpers. The versioned overloads
--    private.form_required_keys(text, integer),
--    private.form_template_label_localized(text, text) and
--    private.form_template_label_localized(text, integer, text) remain.
revoke all on function private.form_required_keys(text)
  from public, anon, authenticated;
drop function if exists private.form_required_keys(text);

revoke all on function private.form_template_label(text)
  from public, anon, authenticated;
drop function if exists private.form_template_label(text);
