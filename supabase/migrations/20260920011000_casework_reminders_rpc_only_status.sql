-- SEC-UG-CASEWORK-REMINDERS-UNAUDITED-MUTATION-20260919
--
-- Creation and reads remain direct client operations. Status transitions run
-- only through casework_set_reminder_status, whose SECURITY DEFINER body
-- validates the transition, maintains timestamps and appends reminder_changed
-- to casework_audit_events. Remove the direct authenticated UPDATE/DELETE path
-- and narrow the former FOR ALL policy to SELECT plus INSERT.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke update, delete on public.casework_reminders from authenticated;

drop policy if exists casework_reminders_owner on public.casework_reminders;

create policy casework_reminders_owner_read on public.casework_reminders
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and private.casework_can_read(case_id)
  );

comment on policy casework_reminders_owner_read on public.casework_reminders is
  'Reminder owners may read only reminders for cases they are currently authorized to read; ownership alone never widens case visibility.';

create policy casework_reminders_owner_create on public.casework_reminders
  for insert to authenticated
  with check (
    owner_user_id = (select auth.uid())
    and private.casework_can_read(case_id)
    and private.casework_scope_matches(case_id, organization_id, chapter_id)
    and status = 'scheduled'
    and completed_at is null
    and last_fired_at is null
  );

comment on policy casework_reminders_owner_create on public.casework_reminders is
  'Reminder owners may create only scheduled reminders with null lifecycle timestamps for cases they can read in the matching case scope; post-creation lifecycle state must come from the audited status RPC.';

notify pgrst, 'reload schema';

commit;
