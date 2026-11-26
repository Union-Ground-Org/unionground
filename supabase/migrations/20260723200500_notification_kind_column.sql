-- REQ-UG-FULL-DEPTH-20260723 PR5: `kind` on the notification feed.
--
-- THIS FILE EXISTS TO BOUND A LOCK, and must stay small for that reason alone.
--
-- Every statement here takes ACCESS EXCLUSIVE on public.member_notifications,
-- and PostgreSQL holds a lock until the transaction commits — not until the
-- statement finishes. The Supabase management API applies one file as one
-- transaction, so folding this into the 700-line migration that follows would
-- pin ACCESS EXCLUSIVE on the members' feed for the whole batch: nine function
-- replacements plus a 100k-row profile scan. Every member's notification read
-- and every notification INSERT (form approvals, case movement) would queue
-- behind it. Alone, this file is metadata-only and commits in milliseconds.
--
-- Two things keep it that way:
--   * `add column ... not null default 'general'` is a constant (non-volatile)
--     default, so PostgreSQL 11+ records it in the catalog and does NOT rewrite
--     the table. The live table has ~300k rows and is not touched.
--   * The CHECK is added NOT VALID, which skips the scan of those 300k rows.
--     20260723205000 validates it afterwards under SHARE UPDATE EXCLUSIVE,
--     which does not block reads or writes.
-- NOT VALID still enforces the constraint on every new and updated row, so
-- nothing can write an unlisted kind between this migration and the validation.

alter table public.member_notifications
  add column if not exists kind text not null default 'general';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_notifications'::regclass
      and conname = 'member_notifications_kind_check'
  ) then
    alter table public.member_notifications
      add constraint member_notifications_kind_check
      check (kind in ('deadlines', 'cases', 'forms', 'votes', 'events', 'general'))
      not valid;
  end if;
end
$$;

-- member_notifications carries a table-wide authenticated UPDATE grant (the
-- feed's mark-as-read path). Left alone, that grant would now cover `kind`,
-- letting a member re-topic their own queued notification and pull it through
-- a toggle they had switched off. Narrow the grant to the one column the
-- client actually writes.
revoke update on public.member_notifications from authenticated;
grant update (read_at) on public.member_notifications to authenticated;

-- The live table also carries the stock Supabase `grant all` for INSERT,
-- DELETE and TRUNCATE. RLS has no INSERT or DELETE policy, so those two are
-- already default-denied, but TRUNCATE bypasses RLS entirely and every row in
-- this table is written by a security-definer body — the client provably needs
-- only SELECT and UPDATE(read_at). Drop the rest rather than rely on a policy
-- gap holding.
revoke insert, delete, truncate, references, trigger on public.member_notifications from authenticated;
revoke insert, delete, truncate, references, trigger on public.member_notifications from anon;

notify pgrst, 'reload schema';
