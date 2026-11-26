-- BUG-UG-PAST-EVENT-RSVP-POINTS-MINT-20260921
--
-- public.rsvp_to_event only checked MFA, status, tenant scope, and
-- cancelled_at. A member could still RSVP 'going' to every historical event
-- in scope and mint 40 uncapped rsvp points per row. Refuse once starts_at
-- has passed, for both 'going' and 'not_going', before any RSVP or action_log
-- write. member_events has no ends_at column, so the bound is starts_at.
--
-- The installed definition carries the case-graph wrapper preamble that
-- 20260907151000's $case_graph_writers$ block added:
-- `perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);`
-- ahead of the original declare block. Reproducing that wrapper keeps the
-- transaction entry scripts/account-case-graph-inventory.mjs requires of
-- every graph writer. The 20260907151000 review ledger is not edited: it
-- pins this function's pre-wrapper source bytes from 20260901153739, that
-- file is untouched, and the ledger's DO block runs before this migration
-- on a fresh apply. Scope predicate, FOR SHARE lock, and the 'rsvp-' ||
-- p_event_id action_log key stay byte-identical so already-minted RSVP
-- points are unaffected.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.rsvp_to_event(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  ev record;
  awarded integer := 0;
  rule_points integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_status not in ('going', 'not_going') then
    raise exception 'invalid rsvp status' using errcode = '22023';
  end if;

  select e.cancelled_at, e.starts_at into ev
  from public.member_events e
  where e.id = p_event_id
    and private.member_can_access_event_scope(
      e.chapter_id, e.is_public, e.is_public_across_agencies
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;
  if ev.starts_at < now() then
    raise exception 'this event is in the past'
      using errcode = '22023', detail = 'event_past';
  end if;

  insert into public.member_event_rsvps (event_id, user_id, status, updated_at)
  values (p_event_id, caller, p_status, now())
  on conflict (event_id, user_id) do update
    set status = excluded.status, updated_at = now();

  if p_status = 'going' then
    insert into public.member_action_log (user_id, action_key, action_kind)
    values (caller, 'rsvp-' || p_event_id, 'rsvp')
    on conflict (user_id, action_key) do nothing;
    get diagnostics awarded = row_count;
  end if;

  select points into rule_points
  from public.member_point_rules where action_kind = 'rsvp';
  return pg_catalog.jsonb_build_object(
    'status', p_status,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
end;
$function$;

revoke all on function public.rsvp_to_event(text, text) from public, anon;
grant execute on function public.rsvp_to_event(text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
