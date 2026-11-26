-- REQ-UG-FULL-DEPTH-20260723 PR5: switch on the sole enqueue path.
--
-- Separated from 20260723201000 for the same reason 20260723200500 is
-- separated: `create trigger` takes ACCESS EXCLUSIVE on the ~300k-row feed,
-- and a lock is held to the end of its transaction. Creating it inside the
-- large migration would pin the members' feed across nine function
-- replacements and a 100k-row profile scan.
--
-- Ordering it last is also correct on its own terms. Everything it depends on
-- — the queue table, the control plane, the counters, the classified insert
-- sites — is already committed, so there is no moment where a classified
-- insert fires a trigger whose supporting objects do not yet exist.
--
-- This is still inert on arrival: private.notification_controls.outbound_enabled
-- defaults to false and the function returns early while it is, so applying
-- this changes nothing a member can observe and queues nothing.
--
-- This trigger is the ONLY enqueue path. A second trigger on this table that
-- also enqueues would double every send; scripts/verify-notification-schema.sql
-- asserts the exact trigger identity rather than a count, so an added or
-- swapped trigger is caught rather than averaged away.

drop trigger if exists member_notifications_enqueue_deliveries on public.member_notifications;
create trigger member_notifications_enqueue_deliveries
  after insert on public.member_notifications
  for each row execute function private.enqueue_notification_deliveries();

notify pgrst, 'reload schema';
