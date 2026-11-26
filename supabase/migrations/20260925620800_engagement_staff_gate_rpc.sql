-- PERF-UG-ENGAGEMENT-STAFF-GATE-RUNS-THE-WHOLE-SNAPSHOT-20260920
--
-- api/guide.js (poll_draft, message_briefing) and api/engagement-delivery.js
-- (status) called public.get_staff_engagement_snapshot only to learn whether
-- the caller holds a staff role, and discarded the value. That projection
-- aggregates every survey with its deliveries, tasks, reviews and questions,
-- the live polls, the workspace actions and the saved briefings, so each of
-- those three gate checks paid for the whole staff dashboard before the first
-- byte of real work. The authorization answer itself is
-- private.engagement_require_staff: MFA assurance plus a staff role in the
-- selected organization, touching no engagement row.
--
-- Publish that predicate as its own RPC so a gate check costs the predicate
-- and nothing else. public.get_staff_engagement_snapshot is unchanged and
-- keeps serving src/features/engagement/api.js#loadStaff, which needs the
-- projection.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.authorize_engagement_staff()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform private.engagement_require_staff(private.engagement_selected_organization());
  return true;
end;
$function$;

comment on function public.authorize_engagement_staff() is
  'Answers the engagement staff gate and nothing else: raises 42501 unless the caller satisfies MFA and holds steward, coordinator, advisor, admin or vp in the selected organization, and otherwise returns true. Reads no engagement row, so a server-side authorization check never builds the staff snapshot.';

revoke all on function public.authorize_engagement_staff() from public, anon, authenticated, service_role;
grant execute on function public.authorize_engagement_staff() to authenticated;

notify pgrst, 'reload schema';

commit;
