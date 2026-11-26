-- SEC-UG-MEMBER-ACCESS-EVENT-ACTOR-PROJECTION-20260921
--
-- public.list_my_access_history deliberately withholds the actor's identity
-- from the subject: it projects only a first-name label and the coarse
-- actor_role, and never selects actor_user_id. The birth migration
-- (20260828021500) then handed the same subject a table-wide SELECT privilege,
-- and member_access_events_select_subject admits the subject for the WHOLE row,
-- so a direct read returned the actor_user_id the RPC exists to hide.
--
-- Narrow the privilege to the columns the history feed already shows. The
-- policy is unchanged: it still filters to the subject's own rows inside their
-- selected organization, and MFA is still required by the restrictive policy.
-- Both RPCs are SECURITY DEFINER and are unaffected by this revoke.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

revoke select on public.member_access_events from authenticated;

grant select (
  id,
  organization_id,
  subject_user_id,
  actor_role,
  action,
  entity_type,
  entity_id,
  occurred_at
) on public.member_access_events to authenticated;

notify pgrst, 'reload schema';

commit;
