-- SEC-UG-LIVE-POLL-CHECKIN-CHAPTER-ELIGIBILITY-20260921
--
-- rsvp_organization_live_poll and cast_organization_live_poll_vote refuse a
-- chapter-bound poll outside the caller's chapter
-- (p.chapter_id is null or p.chapter_id = private.current_member_chapter()).
-- check_in_organization_live_poll matched on organization and state only, so
-- a member (or staff checking a member in) could record attendance, and on a
-- roster poll the staff-granted eligibility that check-in confers, for a
-- chapter poll the member is not eligible for.
--
-- Re-emit the check-in RPC from its installed 20260924020500 body. The only
-- change is the chapter clause on the poll lookup, resolved from the member
-- being checked in (private.current_member_chapter() is exactly the caller's
-- profile chapter, so self check-in gets the RSVP/vote boundary verbatim and
-- a staff-assisted check-in is bounded by the target member's chapter). An
-- out-of-chapter poll returns the same 'not found' (P0002) refusal as a poll
-- outside the tenant, and nothing is written. The case-graph lock stays
-- first; the staff-only eligibility grant, return shape and grants are
-- unchanged.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.check_in_organization_live_poll(
  p_poll_id uuid,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.engagement_selected_organization();
  actor uuid := (select auth.uid());
  target uuid := coalesce(p_user_id, actor);
begin
  if not private.mfa_satisfied() or not private.is_organization_member(org) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if target <> actor then perform private.engagement_require_staff(org); end if;
  if not private.engagement_user_in_organization(org, target) then
    raise exception 'not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.organization_live_polls p
    where p.id = p_poll_id and p.organization_id = org and p.state in ('scheduled', 'open')
      and (
        p.chapter_id is null
        or p.chapter_id = (
          select profile.chapter_id from public.member_profiles profile where profile.id = target
        )
      )
  ) then raise exception 'not found' using errcode = 'P0002'; end if;
  if target <> actor then
    insert into public.organization_live_poll_attendance (
      organization_id, poll_id, user_id, eligible, rsvp, checked_in_at, check_in_actor
    ) values (org, p_poll_id, target, true, 'yes', pg_catalog.now(), actor)
    on conflict (poll_id, user_id) do update
      set eligible = true,
          checked_in_at = pg_catalog.now(), check_in_actor = actor,
          rsvp = case when public.organization_live_poll_attendance.rsvp = 'no' then 'yes' else public.organization_live_poll_attendance.rsvp end,
          updated_at = pg_catalog.now();
  else
    -- self-service: never insert; require a pre-existing eligible row
    update public.organization_live_poll_attendance
      set checked_in_at = pg_catalog.now(), check_in_actor = actor,
          rsvp = case when rsvp = 'no' then 'yes' else rsvp end,
          updated_at = pg_catalog.now()
    where poll_id = p_poll_id and user_id = actor and eligible;
    if not found then
      raise exception 'check-in required' using errcode = '42501';
    end if;
  end if;
  return pg_catalog.jsonb_build_object('pollId', p_poll_id, 'userId', target, 'checkedIn', true);
end;
end;
$function$;

comment on function public.check_in_organization_live_poll(uuid, uuid) is
  'Live-poll check-in. Only an organization-wide poll or a poll bound to the checked-in member''s own chapter is admitted. A staff-executed check-in of another member grants eligible. A member self check-in requires a pre-existing eligible row and never inserts or raises eligible. The case-graph lock is the first statement of the body.';

notify pgrst, 'reload schema';

commit;
