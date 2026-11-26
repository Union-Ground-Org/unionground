-- Restore the cancelled-event refusal lost when the member action RPCs were
-- re-emitted for chapter scoping. Lock the authorized event row while the
-- action lands so a concurrent cancellation has an unambiguous order.
begin;

create or replace function public.rsvp_to_event(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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

  select e.cancelled_at into ev
  from public.member_events e
  where e.id = p_event_id
    and private.current_member_chapter() is not null
    and (
      e.chapter_id = private.current_member_chapter()
      or e.is_public_across_agencies
      or (e.is_public and exists (
        select 1 from public.chapters event_chapter
        join public.chapters member_chapter on member_chapter.id = private.current_member_chapter()
        where event_chapter.id = e.chapter_id
          and event_chapter.region is not null
          and event_chapter.region = member_chapter.region
      ))
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
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
$$;

create or replace function public.check_in_to_event(p_event_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev record;
  new_checkin integer := 0;
  awarded integer := 0;
  rule_points integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.id, e.check_in_code, e.starts_at, e.cancelled_at into ev
  from public.member_events e
  where e.id = p_event_id
    and private.current_member_chapter() is not null
    and (
      e.chapter_id = private.current_member_chapter()
      or e.is_public_across_agencies
      or (e.is_public and exists (
        select 1 from public.chapters event_chapter
        join public.chapters member_chapter on member_chapter.id = private.current_member_chapter()
        where event_chapter.id = e.chapter_id
          and event_chapter.region is not null
          and event_chapter.region = member_chapter.region
      ))
    )
  for share;
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    raise exception 'this event was cancelled'
      using errcode = '22023', detail = 'event_cancelled';
  end if;

  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in is only open around the event start time' using errcode = '22023';
  end if;
  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, ''))) <> pg_catalog.upper(ev.check_in_code) then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  insert into public.member_event_checkins (event_id, user_id)
  values (p_event_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;

  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics awarded = row_count;

  select points into rule_points
  from public.member_point_rules where action_kind = 'checkin';
  return pg_catalog.jsonb_build_object(
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'awardedPoints', case when awarded = 1 then coalesce(rule_points, 0) else 0 end
  );
end;
$$;

commit;
