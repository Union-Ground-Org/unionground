-- PERF-UG-CASEWORK-CASE-GRAPH-UNINDEXED-FOREIGN-KEYS-20260920
--
-- Eight casework child tables carry the composite (case_id, organization_id,
-- chapter_id) link into public.member_cases with no index that leads on the
-- case column. Their only indexes are organization- or owner-scoped
-- (casework_audit_events_scope_idx, casework_deadlines_due_idx,
-- casework_alerts_queue_idx, casework_reminders_due_idx, ...), so:
--
--   * the macro replay guard (20260917144000:581-589) runs a case_id-scoped
--     existence check over casework_audit_events once per (case, action)
--     while the case-graph advisory locks are held;
--   * public.list_casework_audit_events(p_case_id) (20260919010000) and
--     public.casework_case_history (20260918203000:113-116) page the same
--     table by case_id, newest first;
--   * the case detail (src/lib/caseworkApi.js) loads deadlines by due_at,
--     alerts by created_at desc, management entries by occurred_at desc and
--     reminders by remind_at, each filtered by case_id;
--   * every member_cases delete must find (cascade) or null out (set null)
--     the matching child rows, and every auth.users delete must null
--     private.casework_record_versions.actor, with no index to locate them.
--
-- Each index below leads on the link's first column and carries the ordering
-- column its reader asks for. Nullable link columns get a partial index
-- (where <column> is not null): an equality on the column implies it, so the
-- readers and the referential checks can still use it.
--
-- Index creation only: no grant, policy, constraint, function, column or row
-- change. Build lock: CREATE INDEX inside the migration transaction holds a
-- SHARE lock on each table for its build, so writes to that table wait for
-- the build (reads continue); lock_timeout bounds the wait to acquire it.
-- Added write cost: one extra btree entry per inserted row on each table,
-- plus one when an update changes an indexed column (the case column, or
-- the ordering column on deadlines, reminders and management entries).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Macro replay guard, the per-case audit reader and the case history page.
create index if not exists casework_audit_events_case_created_idx
  on public.casework_audit_events (case_id, created_at desc, id desc)
  where case_id is not null;

create index if not exists casework_deadlines_case_due_idx
  on public.casework_deadlines (case_id, due_at);

create index if not exists casework_alerts_case_created_idx
  on public.casework_alerts (case_id, created_at desc);

create index if not exists casework_reminders_case_remind_idx
  on public.casework_reminders (case_id, remind_at);

create index if not exists casework_management_entries_case_occurred_idx
  on public.casework_management_entries (case_id, occurred_at desc)
  where case_id is not null;

create index if not exists casework_retaliation_reports_case_idx
  on public.casework_retaliation_reports (case_id)
  where case_id is not null;

create index if not exists casework_intake_drafts_case_idx
  on public.casework_intake_drafts (case_id)
  where case_id is not null;

-- The source side is already covered by casework_entity_links_source_idx.
create index if not exists casework_entity_links_target_idx
  on public.casework_entity_links (target_case_id, created_at)
  where target_case_id is not null;

-- Account deletion nulls the actor on every version row that names it.
create index if not exists casework_record_versions_actor_idx
  on private.casework_record_versions (actor)
  where actor is not null;

commit;
