-- The chapter visibility flags widen only inside the event's owning tenant.
-- Public, unauthenticated event detail remains the separate bounded projection
-- in get_public_event_detail; it never turns member_events into a global table.
begin;

set local lock_timeout = '5s';

create function private.member_can_access_event_scope_for_user(
  p_user_id uuid,
  p_chapter_id text,
  p_is_public boolean,
  p_is_public_across_agencies boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when p_user_id is null or p_chapter_id is null then false
    else exists (
      select 1
      from public.member_profiles profile
      join public.chapters member_chapter
        on member_chapter.id = profile.chapter_id
      join public.chapters event_chapter
        on event_chapter.id = p_chapter_id
      join public.organizations organization
        on organization.id = member_chapter.organization_id
       and organization.status = 'active'
      join public.member_chapter_memberships chapter_membership
        on chapter_membership.user_id = profile.id
       and chapter_membership.chapter_id = member_chapter.id
       and chapter_membership.status = 'active'
      join public.organization_memberships organization_membership
        on organization_membership.user_id = profile.id
       and organization_membership.organization_id = member_chapter.organization_id
       and organization_membership.status = 'active'
      where profile.id = p_user_id
        -- Tenant equality is deliberately outside and before every visibility
        -- widening branch. Neither public flag is a cross-tenant capability.
        and member_chapter.organization_id is not null
        and event_chapter.organization_id = member_chapter.organization_id
        and (
          event_chapter.id = member_chapter.id
          or coalesce(p_is_public_across_agencies, false)
          or (
            coalesce(p_is_public, false)
            and event_chapter.region is not null
            and event_chapter.region = member_chapter.region
          )
        )
    )
  end;
$function$;

create function private.member_can_access_event_scope(
  p_chapter_id text,
  p_is_public boolean,
  p_is_public_across_agencies boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select private.member_can_access_event_scope_for_user(
    (select auth.uid()),
    p_chapter_id,
    p_is_public,
    p_is_public_across_agencies
  );
$function$;

revoke all on function private.member_can_access_event_scope_for_user(uuid, text, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.member_can_access_event_scope(text, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function private.member_can_access_event_scope(text, boolean, boolean)
  to authenticated;

comment on function private.member_can_access_event_scope_for_user(uuid, text, boolean, boolean) is
  'Tenant-first event scope for a named token owner. Requires active chapter and organization membership before any chapter, agency, or cross-agency widening.';
comment on function private.member_can_access_event_scope(text, boolean, boolean) is
  'Caller-bound wrapper for authenticated event RLS and member actions.';

drop policy if exists member_events_select_scoped on public.member_events;
create policy member_events_select_scoped on public.member_events
  for select to authenticated
  using ((select private.member_can_access_event_scope(
    chapter_id,
    is_public,
    is_public_across_agencies
  )));

drop policy if exists member_event_rsvps_select_own on public.member_event_rsvps;
create policy member_event_rsvps_select_own on public.member_event_rsvps
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.member_events event
      where event.id = member_event_rsvps.event_id
        and (select private.member_can_access_event_scope(
          event.chapter_id,
          event.is_public,
          event.is_public_across_agencies
        ))
    )
  );

drop policy if exists member_event_checkins_select_own on public.member_event_checkins;
create policy member_event_checkins_select_own on public.member_event_checkins
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1
      from public.member_events event
      where event.id = member_event_checkins.event_id
        and (select private.member_can_access_event_scope(
          event.chapter_id,
          event.is_public,
          event.is_public_across_agencies
        ))
    )
  );

create or replace function public.rsvp_to_event(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
$function$;

create or replace function public.check_in_to_event(p_event_id text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
$function$;

create or replace function public.request_event_checkin_token(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller uuid := (select auth.uid());
  ev record;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  plain text := '';
  valid_until timestamptz;
  i integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.starts_at, e.cancelled_at into ev
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
  if now() < ev.starts_at - interval '2 hours' or now() > ev.starts_at + interval '4 hours' then
    raise exception 'check-in codes are only available around the event start time' using errcode = '22023';
  end if;

  delete from private.member_event_checkin_tokens
  where event_id = p_event_id and user_id = caller and consumed_at is null;

  bytes := extensions.gen_random_bytes(7);
  for i in 0..6 loop
    plain := plain || pg_catalog.substr(alphabet, (pg_catalog.get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  valid_until := now() + interval '90 seconds';

  insert into private.member_event_checkin_tokens (event_id, user_id, token_hash, expires_at)
  values (p_event_id, caller, pg_catalog.encode(extensions.digest(plain, 'sha256'), 'hex'), valid_until);

  return pg_catalog.jsonb_build_object('token', plain, 'expiresAt', valid_until, 'ttlSeconds', 90);
end;
$function$;

create or replace function public.get_calendar_feed_events(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  target uuid;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'calendar feed RPC requires service_role' using errcode = '42501';
  end if;
  if p_token is null or pg_catalog.length(p_token) < 32 or pg_catalog.length(p_token) > 128 then
    return pg_catalog.jsonb_build_object('valid', false);
  end if;
  select user_id into target from public.member_calendar_feed_tokens
  where token_hash = private.calendar_feed_token_hash(p_token);
  if not found then
    return pg_catalog.jsonb_build_object('valid', false);
  end if;
  return pg_catalog.jsonb_build_object(
    'valid', true,
    'events', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'title', e.title, 'startsAt', e.starts_at,
        'location', e.location, 'summary', e.summary
      ) order by e.starts_at)
      from public.member_events e
      join public.member_event_rsvps r on r.event_id = e.id
      where r.user_id = target and r.status = 'going'
        and private.member_can_access_event_scope_for_user(
          target, e.chapter_id, e.is_public, e.is_public_across_agencies
        )
    ), '[]'::jsonb)
  );
end;
$function$;

notify pgrst, 'reload schema';

commit;
