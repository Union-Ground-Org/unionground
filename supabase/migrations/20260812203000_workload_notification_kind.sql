-- UB-WKL-03: reserve the member_notifications metadata lock on its own.
--
-- The populated notification feed is latency-sensitive. Dropping and replacing
-- its kind CHECK takes ACCESS EXCLUSIVE, so this file intentionally contains no
-- function/table work and commits the new workload topic as quickly as possible.
-- NOT VALID skips the historical-row scan while enforcing the widened list on
-- every new write. The following migration validates it under the lighter lock.

set local lock_timeout = '5s';

alter table public.member_notifications
  drop constraint if exists member_notifications_kind_check;

alter table public.member_notifications
  add constraint member_notifications_kind_check
  check (kind in (
    'general', 'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks',
    'appointments', 'workload'
  )) not valid;

notify pgrst, 'reload schema';
