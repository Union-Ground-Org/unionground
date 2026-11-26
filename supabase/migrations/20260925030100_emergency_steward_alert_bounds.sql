-- SEC-UG-EMERGENCY-STEWARD-ALERT-BOUNDS-20260921
--
-- public.alert_member_emergency_steward already upserts the emergency
-- checklist on (organization_id, member_user_id, scenario). A fresh
-- idempotency key still minted a new member_steward_requests row and a new
-- 'alerted' support event, so repeated unresolved intents each produced
-- another urgent notification.
--
-- This re-declaration keeps the validation block, the checklist upsert, the
-- return shape, and the installed case-graph wrapper. After the upsert it
-- coalesces an unresolved organization/member/scenario alert: the first
-- urgent request and 'alerted' event stay in place, and later calls return
-- the original alertedAt. A documented per-member bound of 5 first-alert
-- notifications per rolling hour per organization refuses further request
-- and event writes with errcode 22023. The bound is counted from
-- member_support_events so it is organization-scoped; coalesced repeats of
-- an unresolved alert do not consume it.
--
-- An idempotency key that already names a different support event (for
-- example one minted by save_member_emergency_checklist) is refused with
-- errcode 22023, so every new steward request is paired with the 'alerted'
-- event the bound counts. A key that already names a member_steward_requests
-- row (for example one returned by requestSteward) is refused the same way
-- unless this checklist's own 'alerted' event carries it, which is an
-- idempotent replay; otherwise the request insert would silently conflict and
-- the checklist would read alerted with no steward notified. A partial index
-- keys that rolling-hour lookup.
--
-- The organization resolves through
-- private.member_support_selected_organization(), as 20260924200000 made it
-- for every member-support RPC, so a chapterless single-organization caller
-- keeps reaching this RPC.
--
-- Grants are restated exactly as 20260829030000 issued them.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create index if not exists member_support_events_emergency_alert_idx
  on public.member_support_events (organization_id, member_user_id, occurred_at)
  where entity_type = 'emergency_checklist' and event_type = 'alerted';

create or replace function public.alert_member_emergency_steward(
  p_scenario text,
  p_completed_steps integer[],
  p_notes text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  org uuid := private.member_support_selected_organization();
  row_out record;
  prior_status text;
  recent_alerts integer;
  -- Five first-alert notifications per rolling hour per member per
  -- organization. Three documented scenarios can each open once, plus a
  -- small allowance for a genuine re-alert after resolution, while a burst
  -- of new urgent pings is refused. Coalesced repeats of an unresolved
  -- (organization, member, scenario) alert do not consume this budget.
  emergency_alert_hour_limit constant integer := 5;
begin
  if p_scenario not in ('disciplinary_meeting', 'pre_discipline_response', 'unsafe_work')
    or coalesce(pg_catalog.cardinality(p_completed_steps), 0) > 16
    or exists (select 1 from pg_catalog.unnest(coalesce(p_completed_steps, '{}')) step where step not between 0 and 3)
    or pg_catalog.char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid emergency alert' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'emergency-steward-alert:' || org::text || ':' || caller::text || ':' || p_scenario,
      509
    )
  );

  select checklist.status
    into prior_status
  from public.member_emergency_checklists checklist
  where checklist.organization_id = org
    and checklist.member_user_id = caller
    and checklist.scenario = p_scenario
  for update;

  insert into public.member_emergency_checklists (
    organization_id, member_user_id, scenario, status, completed_steps, notes, alerted_at
  ) values (org, caller, p_scenario, 'alerted', coalesce(p_completed_steps, '{}')::smallint[], coalesce(p_notes, ''), pg_catalog.now())
  on conflict (organization_id, member_user_id, scenario) do update set
    status = 'alerted', completed_steps = excluded.completed_steps, notes = excluded.notes,
    alerted_at = coalesce(public.member_emergency_checklists.alerted_at, pg_catalog.now()),
    resolved_at = null, updated_at = pg_catalog.now()
  returning id, alerted_at into row_out;

  if prior_status is distinct from 'alerted' then
    select count(*)::integer
      into recent_alerts
    from public.member_support_events events
    where events.organization_id = org
      and events.member_user_id = caller
      and events.entity_type = 'emergency_checklist'
      and events.event_type = 'alerted'
      and events.occurred_at > pg_catalog.now() - interval '1 hour';
    if recent_alerts >= emergency_alert_hour_limit then
      raise exception 'emergency steward alert rate limited' using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.member_support_events used
      where used.id = p_idempotency_key
        and (used.organization_id, used.member_user_id, used.entity_type, used.entity_id, used.event_type)
          is distinct from (org, caller, 'emergency_checklist', row_out.id, 'alerted')
    ) then
      raise exception 'emergency steward alert key already used' using errcode = '22023';
    end if;

    if exists (
      select 1
      from public.member_steward_requests request
      where request.id = p_idempotency_key
    ) and not exists (
      select 1
      from public.member_support_events own
      where own.id = p_idempotency_key
    ) then
      raise exception 'emergency steward alert key already used' using errcode = '22023';
    end if;

    insert into public.member_steward_requests (id, user_id, lesson_id)
    values (p_idempotency_key, caller, null)
    on conflict (id) do nothing;
    perform private.member_support_record_event(p_idempotency_key, org, caller, 'emergency_checklist', row_out.id, 'alerted');
  end if;

  return pg_catalog.jsonb_build_object('id', row_out.id, 'status', 'alerted', 'alertedAt', row_out.alerted_at);
end;
end;
$function$;

revoke all on function public.alert_member_emergency_steward(text, integer[], text, uuid) from public, anon;
grant execute on function public.alert_member_emergency_steward(text, integer[], text, uuid) to authenticated;

comment on function public.alert_member_emergency_steward(text, integer[], text, uuid) is
  'Alerts the chapter steward for one emergency scenario. An unresolved organization/member/scenario checklist is coalesced so the first urgent request and notification remain; a member may mint at most five first-alert notifications per rolling hour per organization.';

notify pgrst, 'reload schema';

commit;
