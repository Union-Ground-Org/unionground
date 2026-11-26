-- REQ-UG-MEMBER-SINCE-2023-ON-EARLIER-ACCOUNTS-DATA-DECISION-20261006
-- Owner Q10=A, confirmed October 8, 2026: clear the old 2023 default only
-- for accounts created after its introduction. Main selected this inclusive,
-- conservative cutoff: July 21, 2026, 1:04:15 AM ET. The introducing migration,
-- 20260720191847_fresh_member_workflows.sql, first reached Main in commit
-- de7df4b57cd8c0e6b85011a3d3d279fa6b150b7e at that instant. This is not a time
-- inferred from its migration ID or a claim about hosted application time.
-- Earlier accounts, unknown creation times and every non-2023 value stay as is.
-- The account's creation time is authoritative even if its profile is newer.
-- Hosted execution and before/after counts belong to the separate hosted stage.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

update public.member_profiles p
set member_since = null
from auth.users u
where u.id = p.id
  and p.member_since = 2023
  and u.created_at >= timestamptz '2026-07-21 01:04:15-04';

commit;
