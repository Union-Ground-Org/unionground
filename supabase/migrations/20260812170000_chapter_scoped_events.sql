-- UB-EVT-01: restore chapter ownership and the pre-rebuild event visibility
-- contract.  Every event belongs to one chapter.  Chapter-only is the safe
-- default; is_public widens to chapters in the publishing chapter's agency
-- (chapters.region); is_public_across_agencies widens to every authenticated
-- member who has a real chapter.  Missing chapter identity fails closed.

set local lock_timeout = '5s';

alter table public.member_events
  add column chapter_id text references public.chapters(id) on update cascade on delete restrict,
  add column is_public boolean not null default false,
  add column is_public_across_agencies boolean not null default false;

do $$
declare
  default_chapter text;
begin
  select pg_catalog.min(id) into default_chapter
  from public.chapters
  where is_default;

  if default_chapter is null
     or (select pg_catalog.count(*) from public.chapters where is_default) <> 1 then
    raise exception 'exactly one default chapter is required to backfill events';
  end if;

  -- Legacy rows were deliberately org-wide.  Preserve that visibility while
  -- assigning the only defensible publisher chapter available at migration
  -- time.  New rows default chapter-only through the server RPC below.
  update public.member_events
  set chapter_id = default_chapter, is_public_across_agencies = true
  where chapter_id is null;
end
$$;

alter table public.member_events
  alter column chapter_id set not null,
  drop constraint member_events_order_index_key,
  add constraint member_events_chapter_order_key unique (chapter_id, order_index);

create index member_events_chapter_starts_idx
  on public.member_events(chapter_id, starts_at);
create index member_events_cross_agency_starts_idx
  on public.member_events(starts_at)
  where is_public_across_agencies = true;

comment on column public.member_events.chapter_id is
  'Immutable publishing chapter. Set from the authenticated staff profile, never client input.';
comment on column public.member_events.is_public is
  'When true, authenticated members in chapters sharing the publisher chapter region (agency) may read the event.';
comment on column public.member_events.is_public_across_agencies is
  'When true, authenticated members with a chapter may read the event across agency boundaries.';

-- The parent policy is the canonical member visibility predicate.  Child
-- reads repeat it through the parent so an RSVP/check-in cannot disclose an
-- event that was later narrowed.
drop policy member_events_select_all on public.member_events;
create policy member_events_select_scoped on public.member_events
  for select to authenticated
  using (
    private.current_member_chapter() is not null
    and (
      chapter_id = private.current_member_chapter()
      or is_public_across_agencies = true
      or (
        is_public = true
        and exists (
          select 1
          from public.chapters event_chapter
          join public.chapters member_chapter
            on member_chapter.id = private.current_member_chapter()
          where event_chapter.id = member_events.chapter_id
            and event_chapter.region is not null
            and event_chapter.region = member_chapter.region
        )
      )
    )
  );

drop policy member_event_rsvps_select_own on public.member_event_rsvps;
create policy member_event_rsvps_select_own on public.member_event_rsvps
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.member_events e
      where e.id = member_event_rsvps.event_id
        and private.current_member_chapter() is not null
        and (
          e.chapter_id = private.current_member_chapter()
          or e.is_public_across_agencies
          or (e.is_public and exists (
            select 1 from public.chapters event_chapter
            join public.chapters member_chapter
              on member_chapter.id = private.current_member_chapter()
            where event_chapter.id = e.chapter_id
              and event_chapter.region is not null
              and event_chapter.region = member_chapter.region
          ))
        )
    )
  );

drop policy member_event_checkins_select_own on public.member_event_checkins;
create policy member_event_checkins_select_own on public.member_event_checkins
  for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.member_events e
      where e.id = member_event_checkins.event_id
        and private.current_member_chapter() is not null
        and (
          e.chapter_id = private.current_member_chapter()
          or e.is_public_across_agencies
          or (e.is_public and exists (
            select 1 from public.chapters event_chapter
            join public.chapters member_chapter
              on member_chapter.id = private.current_member_chapter()
            where event_chapter.id = e.chapter_id
              and event_chapter.region is not null
              and event_chapter.region = member_chapter.region
          ))
        )
    )
  );

-- Definer functions do not inherit the table RLS boundary, so each member
-- action repeats the same scope predicate before touching state or secrets.
create or replace function public.rsvp_to_event(p_event_id text, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  awarded integer := 0;
  rule_points integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_status not in ('going', 'not_going') then
    raise exception 'invalid rsvp status' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.member_events e
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
  ) then
    raise exception 'event not found' using errcode = '22023';
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

  select e.id, e.check_in_code, e.starts_at into ev
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
    );
  if not found then
    raise exception 'event not found' using errcode = '22023';
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

create or replace function public.request_event_checkin_token(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev_starts timestamptz;
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  bytes bytea;
  plain text := '';
  valid_until timestamptz;
  i integer;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select e.starts_at into ev_starts
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
    );
  if not found then
    raise exception 'event not found' using errcode = '22023';
  end if;
  if now() < ev_starts - interval '2 hours' or now() > ev_starts + interval '4 hours' then
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
$$;

create or replace function public.scan_event_checkin(p_event_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  clean_token text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_token, '')));
  tok record;
  new_checkin integer := 0;
  member_logged integer := 0;
  scanner_logged integer := 0;
  member_points integer := 0;
  scanner_points integer := 0;
begin
  if caller is null or not public.member_has_role(array['steward']) then
    raise exception 'steward role required' using errcode = '42501';
  end if;
  if clean_token = '' then
    raise exception 'enter the member''s check-in code' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.member_events e
    where e.id = p_event_id
      and e.chapter_id = private.current_member_chapter()
  ) then
    raise exception 'event not found' using errcode = '22023';
  end if;

  select id, user_id, expires_at, consumed_at into tok
  from private.member_event_checkin_tokens
  where event_id = p_event_id
    and token_hash = pg_catalog.encode(extensions.digest(clean_token, 'sha256'), 'hex')
  for update;
  if not found then
    raise exception 'invalid or expired check-in code' using errcode = '22023';
  end if;
  if tok.consumed_at is not null then
    raise exception 'this code has already been used' using errcode = '22023';
  end if;
  if tok.expires_at < now() then
    raise exception 'this code has expired — ask the member to refresh it' using errcode = '22023';
  end if;
  if tok.user_id = caller then
    raise exception 'you cannot scan your own check-in code' using errcode = '22023';
  end if;

  update private.member_event_checkin_tokens
  set consumed_at = now(), consumed_by = caller where id = tok.id;
  insert into public.member_event_checkins (event_id, user_id, scanned_by)
  values (p_event_id, tok.user_id, caller)
  on conflict (event_id, user_id) do nothing;
  get diagnostics new_checkin = row_count;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (tok.user_id, 'checkin-' || p_event_id, 'checkin')
  on conflict (user_id, action_key) do nothing;
  get diagnostics member_logged = row_count;
  insert into public.member_action_log (user_id, action_key, action_kind)
  values (caller, 'scan-' || tok.user_id::text || '-' || p_event_id, 'scan')
  on conflict (user_id, action_key) do nothing;
  get diagnostics scanner_logged = row_count;

  if member_logged = 1 then
    select coalesce(pg_catalog.max(points), 0) into member_points
    from public.member_point_events
    where user_id = tok.user_id and action_key = 'checkin-' || p_event_id;
  end if;
  if scanner_logged = 1 then
    select coalesce(pg_catalog.max(points), 0) into scanner_points
    from public.member_point_events
    where user_id = caller and action_key = 'scan-' || tok.user_id::text || '-' || p_event_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'memberUserId', tok.user_id,
    'checkedIn', true,
    'alreadyCheckedIn', new_checkin = 0,
    'memberAwardedPoints', member_points,
    'scannerAwardedPoints', scanner_points
  );
end;
$$;

-- Calendar tokens remain opaque and service-only, but an RSVP made before an
-- event was narrowed is no longer enough to keep it in the feed.
create or replace function public.get_calendar_feed_events(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
      join public.member_profiles target_profile on target_profile.id = target
      where r.user_id = target and r.status = 'going'
        and target_profile.chapter_id is not null
        and (
          e.chapter_id = target_profile.chapter_id
          or e.is_public_across_agencies
          or (e.is_public and exists (
            select 1 from public.chapters event_chapter
            join public.chapters member_chapter on member_chapter.id = target_profile.chapter_id
            where event_chapter.id = e.chapter_id
              and event_chapter.region is not null
              and event_chapter.region = member_chapter.region
          ))
        )
    ), '[]'::jsonb)
  );
end;
$$;

-- Replace the old six-argument overloads.  The two trailing defaults preserve
-- older callers while ensuring absent visibility input means chapter-only.
drop function if exists public.create_member_event(text, text, timestamp with time zone, text, text, text);
create function public.create_member_event(p_id text, p_title text, p_starts_at timestamptz, p_location text, p_summary text, p_check_in_code text, p_is_public boolean default false, p_is_public_across_agencies boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_is_public is null or p_is_public_across_agencies is null then
    raise exception 'event visibility is required' using errcode = '22023';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'invalid start time' using errcode = '22023';
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is null or p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_events:order_index:' || caller_chapter, 509));
  if exists (select 1 from public.member_events where id = p_id) then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  insert into public.member_events (
    id, title, starts_at, location, summary, check_in_code, order_index,
    chapter_id, is_public, is_public_across_agencies)
  values (
    p_id, pg_catalog.btrim(p_title), p_starts_at, pg_catalog.btrim(p_location),
    pg_catalog.btrim(p_summary), p_check_in_code,
    coalesce((select pg_catalog.max(order_index) + 1 from public.member_events where chapter_id = caller_chapter), 1),
    caller_chapter, p_is_public, p_is_public_across_agencies);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', pg_catalog.btrim(p_title),
    'chapterId', caller_chapter,
    'isPublic', p_is_public,
    'isPublicAcrossAgencies', p_is_public_across_agencies));

  begin
    for m in
      select recipient.id
      from public.member_profiles recipient
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = caller_chapter
      where recipient.id <> caller
        and (
          recipient.chapter_id = caller_chapter
          or p_is_public_across_agencies
          or (p_is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member(m.id, 'event.created', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
$$;

drop function if exists public.update_member_event(text, text, timestamp with time zone, text, text, text);
create function public.update_member_event(p_id text, p_title text default null, p_starts_at timestamptz default null, p_location text default null, p_summary text default null, p_check_in_code text default null, p_is_public boolean default null, p_is_public_across_agencies boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  if p_title is not null and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120 or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and p_check_in_code is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = coalesce(p_check_in_code, check_in_code),
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies)
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if 'starts_at' = any(changed) then
      update public.member_events set reminder_notice_sent_at = null
      where id = p_id and chapter_id = caller_chapter;
      begin
        for m in
          select rv.user_id
          from public.member_event_rsvps rv
          join public.member_profiles recipient on recipient.id = rv.user_id
          join public.member_events current_event on current_event.id = rv.event_id
          join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
          join public.chapters publisher_chapter on publisher_chapter.id = current_event.chapter_id
          where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
            and (
              recipient.chapter_id = current_event.chapter_id
              or current_event.is_public_across_agencies
              or (current_event.is_public and publisher_chapter.region is not null
                  and recipient_chapter.region = publisher_chapter.region)
            )
        loop
          perform private.notify_member(m.user_id, 'event.rescheduled', '{}'::jsonb, 'events');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0);
end;
$$;

-- Event removal verbs were introduced by UB-EVT-06 before events had chapter
-- ownership. Re-emit them here: SECURITY DEFINER bypasses table RLS, so each
-- guessed-id mutation must bind the event to the caller's current chapter.
create or replace function public.cancel_member_event(p_id text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  clean_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if clean_reason is not null
     and (pg_catalog.char_length(clean_reason) > 300 or clean_reason ~ '[[:cntrl:]]') then
    raise exception 'invalid cancellation reason' using errcode = '22023';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is not null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', false);
  end if;

  update public.member_events
  set cancelled_at = now(), cancelled_reason = clean_reason
  where id = p_id and chapter_id = caller_chapter;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'cancel_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
    'reason', coalesce(clean_reason, '')));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member(m.user_id, 'event.cancelled', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.cancelled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', true);
end;
$$;

create or replace function public.restore_member_event(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  m record;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if ev.cancelled_at is null then
    return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', false);
  end if;

  update public.member_events
  set cancelled_at = null, cancelled_reason = null
  where id = p_id and chapter_id = caller_chapter;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'restore_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter));

  begin
    for m in
      select rv.user_id from public.member_event_rsvps rv
      where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller
    loop
      perform private.notify_member(m.user_id, 'event.restored', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.restored notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', true);
end;
$$;

create or replace function public.delete_member_event(p_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  attended integer;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  select pg_catalog.count(*) into attended
  from public.member_event_checkins where event_id = p_id;
  if attended > 0 then
    raise exception 'this event has % check-in(s) and cannot be deleted', attended
      using errcode = '22023', detail = 'event_has_attendance';
  end if;

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'delete_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
    'startsAt', ev.starts_at));

  delete from public.member_events
  where id = p_id and chapter_id = caller_chapter;

  return pg_catalog.jsonb_build_object('id', p_id, 'deleted', true);
end;
$$;

create or replace function public.get_admin_events()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_chapter text;
begin
  if caller is null or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id, 'title', e.title, 'startsAt', e.starts_at,
      'location', e.location, 'summary', e.summary,
      'checkInCode', e.check_in_code, 'orderIndex', e.order_index,
      'chapterId', e.chapter_id, 'chapterName', c.name,
      'isPublic', e.is_public,
      'isPublicAcrossAgencies', e.is_public_across_agencies,
      'cancelledAt', e.cancelled_at,
      'cancelledReason', e.cancelled_reason,
      'rsvpCount', coalesce(r.n, 0), 'checkinCount', coalesce(k.n, 0)
    ) order by e.order_index)
    from public.member_events e
    join public.chapters c on c.id = e.chapter_id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_rsvps where status = 'going' group by event_id
    ) r on r.event_id = e.id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_checkins group by event_id
    ) k on k.event_id = e.id
    where e.chapter_id = caller_chapter
  ), '[]'::jsonb);
end;
$$;

-- Reminder recipients are revalidated at delivery time.  A stale RSVP from
-- before a visibility reduction cannot become a cross-chapter reminder leak.
create or replace function private.event_notice_sweep()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  m record;
begin
  for r in
    select e.id from public.member_events e
    where e.reminder_notice_sent_at is null
      and e.starts_at > now()
      and e.starts_at <= now() + interval '24 hours'
    for update skip locked
  loop
    update public.member_events set reminder_notice_sent_at = now() where id = r.id;
    for m in
      select rv.user_id
      from public.member_event_rsvps rv
      join public.member_profiles recipient on recipient.id = rv.user_id
      join public.member_events e on e.id = rv.event_id
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = e.chapter_id
      where rv.event_id = r.id and rv.status = 'going'
        and (
          recipient.chapter_id = e.chapter_id
          or e.is_public_across_agencies
          or (e.is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member(m.user_id, 'event.reminder', '{}'::jsonb, 'events');
    end loop;
  end loop;
end;
$$;

-- Reassert exact client privileges after the schema change.  Scope metadata is
-- safe to display; the static door code and all table writes remain absent.
revoke all on public.member_events from anon, authenticated;
grant select (id, title, starts_at, location, summary, order_index, created_at, chapter_id, is_public, is_public_across_agencies) on public.member_events to authenticated;

revoke all on function public.rsvp_to_event(text, text) from public, anon;
revoke all on function public.check_in_to_event(text, text) from public, anon;
revoke all on function public.request_event_checkin_token(text) from public, anon;
revoke all on function public.scan_event_checkin(text, text) from public, anon;
revoke all on function public.get_calendar_feed_events(text) from public, anon, authenticated;
revoke all on function public.create_member_event(text, text, timestamptz, text, text, text, boolean, boolean) from public, anon;
revoke all on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean) from public, anon;
revoke all on function public.get_admin_events() from public, anon;
revoke all on function private.event_notice_sweep() from public, anon, authenticated, service_role;

grant execute on function public.rsvp_to_event(text, text) to authenticated;
grant execute on function public.check_in_to_event(text, text) to authenticated;
grant execute on function public.request_event_checkin_token(text) to authenticated;
grant execute on function public.scan_event_checkin(text, text) to authenticated;
grant execute on function public.get_calendar_feed_events(text) to service_role;
grant execute on function public.create_member_event(text, text, timestamptz, text, text, text, boolean, boolean) to authenticated;
grant execute on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean) to authenticated;
grant execute on function public.get_admin_events() to authenticated;
