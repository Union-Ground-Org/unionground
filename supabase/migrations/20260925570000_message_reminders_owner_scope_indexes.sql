-- PERF-UG-MESSAGE-REMINDERS-OWNER-INDEX-MISSING-20260921
--
-- public.member_message_reminders arrived in 20260812200000 with exactly one
-- index -- member_message_reminders_due_idx (remind_at, id) where status =
-- 'pending' -- which serves the dispatch cron and nothing else. Every
-- owner-scoped read filters on owner_id, and none of them had an index to
-- stand on:
--
--   * the RLS SELECT policy member_message_reminders_read (20260812200000:393)
--     is `owner_id = auth.uid()` with no status predicate, so a direct
--     PostgREST select seq-scans the whole table;
--   * list_member_message_activity (:866-868) filters owner_id = caller and
--     status = 'pending', which rides the partial due index and then rechecks
--     owner_id over every globally pending row;
--   * list_steward_thread_messages (:919) runs a CORRELATED scalar subquery on
--     (owner_id, private_message_id, status = 'pending') ONCE PER MESSAGE ROW
--     of the page, multiplying that recheck by the page size.
--
-- The two indexes below cover those three shapes. The three FK indexes cover
-- the source columns, all of which are `on delete cascade` references that the
-- parent deletes walk and that the Supabase advisor lints as uncovered.
--
-- Index creation only; no data, no grants, no policy or routine changes.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The plain owner predicate: the RLS read policy, and the ordering
-- list_member_message_activity asks for within one owner.
create index if not exists member_message_reminders_owner_idx
  on public.member_message_reminders (owner_id, remind_at desc);

-- The per-message correlated lookup in list_steward_thread_messages. Partial
-- on the same status the subquery requires, so it stays small.
create index if not exists member_message_reminders_owner_message_idx
  on public.member_message_reminders (owner_id, private_message_id)
  where status = 'pending';

-- Cover the three cascading source foreign keys.
create index if not exists member_message_reminders_private_message_idx
  on public.member_message_reminders (private_message_id);
create index if not exists member_message_reminders_channel_post_idx
  on public.member_message_reminders (channel_post_id);
create index if not exists member_message_reminders_task_message_idx
  on public.member_message_reminders (task_message_id);

commit;
