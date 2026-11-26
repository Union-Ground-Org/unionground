-- End time, date-only kinds, and bounded monthly occurrences.
-- Requires the optional-code migration from #4132 before exposing date-only rows.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
do $prerequisite$
begin
  if not exists (select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.member_events'::regclass and attname = 'check_in_offered' and not attisdropped) then
    raise exception 'apply event_checkin_code_optional (#4132) first' using errcode = '55000';
  end if;
end;
$prerequisite$;
do $predecessors$
declare
  -- Exact prosrc hashes: the reviewed predecessor and this migration's body.
  expected constant jsonb := pg_catalog.jsonb_build_object(
    'public.rsvp_to_event(text,text)', pg_catalog.jsonb_build_array('4e32e8c4c6d0dd54a0e1b97c12f94608', '32364738bff2c50b8a0bd8727d215dbf'),
    'public.get_calendar_feed_events(text)', pg_catalog.jsonb_build_array('4797b0f3c435c3948273c7e62f212168', 'd5609747fda9b8acadd51742e0156524'),
    'public.get_admin_events()', pg_catalog.jsonb_build_array('45434eb261caffe8a2e2e27880cbd8da', 'effa37bae9664bf70b45b403ba2cf738')
  );
  fn text;
  actual text;
begin
  for fn in select pg_catalog.jsonb_object_keys(expected) loop
    select pg_catalog.md5(p.prosrc) into strict actual
      from pg_catalog.pg_proc p where p.oid = fn::regprocedure;
    if not ((expected -> fn) ? actual) then
      raise exception 'unreviewed % body: %', fn, actual using errcode = '55000';
    end if;
  end loop;
end;
$predecessors$;
alter table public.member_events alter column starts_at drop not null;
-- A temporary reference lets PostgreSQL compare its own canonical expressions,
-- types and constraint definitions; IF NOT EXISTS alone would accept drift.
create temporary table event_model_expected (
  starts_at timestamptz, check_in_code text,
  ends_at timestamptz,
  event_kind text not null default 'meeting',
  event_date date,
  series_id uuid,
  sort_at timestamptz generated always as
    (coalesce(starts_at, event_date::timestamp at time zone 'UTC')) stored,
  constraint member_events_series_code_key unique (series_id, check_in_code),
  constraint member_events_schedule_check check (
    (event_kind = 'meeting' and starts_at is not null and event_date is null
      and (ends_at is null or ends_at > starts_at))
    or (event_kind in ('deadline', 'date_only') and event_date is not null
      and starts_at is null and ends_at is null and check_in_code is null)
  )
) on commit drop;
alter table public.member_events
  add column if not exists ends_at timestamptz,
  add column if not exists event_kind text not null default 'meeting',
  add column if not exists event_date date,
  add column if not exists series_id uuid,
  add column if not exists sort_at timestamptz generated always as
    (coalesce(starts_at, event_date::timestamp at time zone 'UTC')) stored;
do $schema$
declare
  expected record;
  actual record;
begin
  for expected in
    select a.attname, a.atttypid, a.atttypmod, a.attnotnull, a.attgenerated,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) as expression
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'pg_temp.event_model_expected'::regclass
       and a.attname in ('ends_at', 'event_kind', 'event_date', 'series_id', 'sort_at')
  loop
    select a.atttypid, a.atttypmod, a.attnotnull, a.attgenerated,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) as expression into actual
      from pg_catalog.pg_attribute a
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.member_events'::regclass
       and a.attname = expected.attname and not a.attisdropped;
    if not found or actual.atttypid is distinct from expected.atttypid
       or actual.atttypmod is distinct from expected.atttypmod
       or actual.attnotnull is distinct from expected.attnotnull
       or actual.attgenerated is distinct from expected.attgenerated
       or actual.expression is distinct from expected.expression then
      raise exception 'unreviewed member_events.% definition', expected.attname using errcode = '55000';
    end if;
  end loop;
  for expected in
    select conname, pg_catalog.pg_get_constraintdef(oid) as definition
      from pg_catalog.pg_constraint
     where conrelid = 'pg_temp.event_model_expected'::regclass
  loop
    if not exists (select 1 from pg_catalog.pg_constraint
       where conrelid = 'public.member_events'::regclass and conname = expected.conname) then
      -- Keep the DDL literal so repository policy analysis can inspect it.
      -- The canonical definition check below still rejects schema drift.
      if expected.conname = 'member_events_series_code_key' then
        alter table public.member_events
          add constraint member_events_series_code_key unique (series_id, check_in_code);
      elsif expected.conname = 'member_events_schedule_check' then
        alter table public.member_events
          add constraint member_events_schedule_check check (
            (event_kind = 'meeting' and starts_at is not null and event_date is null
              and (ends_at is null or ends_at > starts_at))
            or (event_kind in ('deadline', 'date_only') and event_date is not null
              and starts_at is null and ends_at is null and check_in_code is null)
          );
      else
        raise exception 'unexpected event-model constraint %', expected.conname using errcode = '55000';
      end if;
    end if;
    if not exists (select 1 from pg_catalog.pg_constraint
       where conrelid = 'public.member_events'::regclass and conname = expected.conname
         and convalidated and pg_catalog.pg_get_constraintdef(oid) = expected.definition) then
      raise exception 'unreviewed % definition', expected.conname using errcode = '55000';
    end if;
  end loop;
end;
$schema$;
-- The existing tenant-first member_events_select_scoped policy covers these columns.
grant select (ends_at, event_kind, event_date, series_id, sort_at) on public.member_events to authenticated;
create index if not exists member_events_chapter_sort_idx on public.member_events (chapter_id, sort_at, id);
do $index$
begin
  if not exists (
    select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid = i.indexrelid
    join pg_catalog.pg_am am on am.oid = c.relam
    where i.indexrelid = 'public.member_events_chapter_sort_idx'::regclass
      and i.indrelid = 'public.member_events'::regclass and am.amname = 'btree'
      and i.indisvalid and i.indisready and not i.indisunique
      and i.indnkeyatts = 3 and i.indnatts = 3 and i.indpred is null and i.indexprs is null
      and pg_catalog.pg_get_indexdef(i.indexrelid, 1, false) = 'chapter_id'
      and pg_catalog.pg_get_indexdef(i.indexrelid, 2, false) = 'sort_at'
      and pg_catalog.pg_get_indexdef(i.indexrelid, 3, false) = 'id'
  ) then
    raise exception 'unreviewed member_events_chapter_sort_idx definition' using errcode = '55000';
  end if;
end;
$index$;
create or replace function public.create_member_event_model(
  p_id text,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_summary text,
  p_check_in_code text,
  p_is_public boolean default false,
  p_is_public_across_agencies boolean default false,
  p_kind text default 'meeting', p_event_date date default null, p_ends_at timestamptz default null,
  p_occurrences integer default 1, p_timezone text default 'America/New_York'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Preserve the installed lifecycle -> case-graph -> tenant lock order.
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  m record;
  occurrence_id text;
  occurrence_start timestamptz;
  occurrence_end timestamptz;
  occurrence_code text;
  local_start timestamp;
  series uuid := case when p_occurrences > 1 then extensions.gen_random_uuid() end;
  ids jsonb := '[]'::jsonb;
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
  if p_kind is null or p_kind not in ('meeting', 'deadline', 'date_only')
     or (p_kind = 'meeting' and (p_starts_at is null or p_event_date is not null))
     or (p_kind <> 'meeting' and (p_event_date is null or p_starts_at is not null or p_ends_at is not null or nullif(p_check_in_code, '') is not null))
     or (p_ends_at is not null and p_ends_at <= p_starts_at)
     or p_occurrences is null or p_occurrences not between 1 and 12
     or (p_occurrences > 1 and p_kind <> 'meeting') then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  if p_occurrences > 1 then
    if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
      raise exception 'invalid event timezone' using errcode = '22023';
    end if;
    local_start := p_starts_at at time zone p_timezone;
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120 or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500 or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if nullif(p_check_in_code, '') is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('member_events:order_index:' || caller_chapter, 509));
  if exists (select 1 from public.member_events where id = p_id) then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  -- Finite series: each row owns its RSVP, check-in code, audit and lifecycle.
  -- Add each offset to the original wall time (Jan 31 -> Feb 28 -> Mar 31).
  for occurrence in 0..p_occurrences - 1 loop
    occurrence_id := case when occurrence = 0 then p_id else 'event-' || extensions.gen_random_uuid()::text end;
    occurrence_start := case when occurrence = 0 then p_starts_at
      else (local_start + pg_catalog.make_interval(months => occurrence)) at time zone p_timezone end;
    occurrence_end := case when p_ends_at is null then null
      else occurrence_start + (p_ends_at - p_starts_at) end;
    occurrence_code := case when nullif(p_check_in_code, '') is null then null
      when occurrence = 0 and nullif(p_check_in_code, '') is not null then p_check_in_code
      else 'SG-' || pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(6), 'hex')) end;
  insert into public.member_events (
    id, title, starts_at, location, summary, check_in_code, order_index,
    chapter_id, is_public, is_public_across_agencies, event_kind, event_date, ends_at, series_id)
  values (
    occurrence_id, pg_catalog.btrim(p_title), occurrence_start, pg_catalog.btrim(p_location),
    pg_catalog.btrim(p_summary), occurrence_code,
    coalesce((select pg_catalog.max(order_index) + 1 from public.member_events where chapter_id = caller_chapter), 1),
    caller_chapter, p_is_public, p_is_public_across_agencies, p_kind, p_event_date, occurrence_end, series);

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event', pg_catalog.jsonb_build_object(
    'eventId', occurrence_id, 'title', pg_catalog.btrim(p_title),
    'chapterId', caller_chapter,
    'isPublic', p_is_public,
    'isPublicAcrossAgencies', p_is_public_across_agencies));

  if occurrence = 0 then
  begin
    for m in
      select recipient.id
      from public.member_profiles recipient
      join public.chapters recipient_chapter on recipient_chapter.id = recipient.chapter_id
      join public.chapters publisher_chapter on publisher_chapter.id = caller_chapter
      join public.organization_memberships recipient_membership
        on recipient_membership.user_id = recipient.id
       and recipient_membership.organization_id = publisher_chapter.organization_id
       and recipient_membership.status = 'active'
      where recipient.id <> caller
        and recipient_chapter.organization_id = publisher_chapter.organization_id
        and (
          recipient.chapter_id = caller_chapter
          or p_is_public_across_agencies
          or (p_is_public and publisher_chapter.region is not null
              and recipient_chapter.region = publisher_chapter.region)
        )
    loop
      perform private.notify_member_event(m.id, occurrence_id, 'created');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  end if;

  ids := ids || pg_catalog.jsonb_build_array(occurrence_id);
  end loop;
  return pg_catalog.jsonb_build_object('id', p_id, 'created', true, 'occurrenceIds', ids);
end;
end;
$$;

create or replace function public.update_member_event_model(p_id text, p_title text default null, p_starts_at timestamptz default null, p_location text default null, p_summary text default null, p_check_in_code text default null, p_is_public boolean default null, p_is_public_across_agencies boolean default null, p_schedule jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
  changed text[];
  m record;
  next_kind text;
  next_start timestamptz;
  next_date date;
  next_end timestamptz;
  next_code text;
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

  -- NULL schedule preserves exact stored seconds and an omitted end time.
  -- A present schedule is a full replacement; JSON null clears the end.
  if p_schedule is not null and (pg_catalog.jsonb_typeof(p_schedule) <> 'object'
     or not (p_schedule ?& array['kind', 'startsAt', 'eventDate', 'endsAt'])) then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  next_kind := case when p_schedule is null then ev.event_kind else p_schedule ->> 'kind' end;
  next_start := case when p_schedule is null then coalesce(p_starts_at, ev.starts_at) else (p_schedule ->> 'startsAt')::timestamptz end;
  next_date := case when p_schedule is null then ev.event_date else (p_schedule ->> 'eventDate')::date end;
  next_end := case when p_schedule is null then ev.ends_at else (p_schedule ->> 'endsAt')::timestamptz end;
  next_code := case when p_check_in_code is null then ev.check_in_code else nullif(p_check_in_code, '') end;
  if next_kind is null or next_kind not in ('meeting', 'deadline', 'date_only')
     or (next_kind = 'meeting' and (next_start is null or next_date is not null))
     or (next_kind <> 'meeting' and (next_date is null or next_start is not null or next_end is not null or next_code is not null))
     or (next_end is not null and next_end <= next_start) then
    raise exception 'invalid event schedule' using errcode = '22023';
  end if;
  -- Do not turn attendance already recorded for a meeting into a deadline.
  if next_kind <> 'meeting' and ev.event_kind = 'meeting' and (
    exists (select 1 from public.member_event_rsvps where event_id = p_id)
    or exists (select 1 from public.member_event_checkins where event_id = p_id)
  ) then
    raise exception 'event has attendance; keep its meeting type' using errcode = '22023';
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
  if nullif(p_check_in_code, '') is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when next_start is distinct from ev.starts_at then 'starts_at' end,
    case when next_kind is distinct from ev.event_kind then 'event_kind' end,
    case when next_date is distinct from ev.event_date then 'event_date' end,
    case when next_end is distinct from ev.ends_at then 'ends_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when next_code is distinct from ev.check_in_code then 'check_in_code' end,
    case when p_is_public is not null and p_is_public is distinct from ev.is_public then 'is_public' end,
    case when p_is_public_across_agencies is not null and p_is_public_across_agencies is distinct from ev.is_public_across_agencies then 'is_public_across_agencies' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = next_start, event_kind = next_kind, event_date = next_date, ends_at = next_end,
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = next_code,
      is_public = coalesce(p_is_public, is_public),
      is_public_across_agencies = coalesce(p_is_public_across_agencies, is_public_across_agencies)
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.to_jsonb(changed),
      'isPublic', coalesce(p_is_public, ev.is_public),
      'isPublicAcrossAgencies', coalesce(p_is_public_across_agencies, ev.is_public_across_agencies)));

    if changed && array['starts_at', 'ends_at', 'event_date', 'event_kind'] then
      delete from private.member_event_checkin_tokens where event_id = p_id and consumed_at is null;
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
          perform private.notify_member_event(m.user_id, p_id, 'rescheduled');
        end loop;
      exception
        when others then
          raise warning 'event.rescheduled notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
      end;
    end if;
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0);
end;
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
      'endsAt', e.ends_at, 'eventKind', e.event_kind, 'eventDate', e.event_date,
      'seriesId', e.series_id, 'checkInOffered', e.check_in_offered,
      'location', e.location, 'summary', e.summary,
      'checkInCode', e.check_in_code, 'orderIndex', e.order_index,
      'chapterId', e.chapter_id, 'chapterName', c.name,
      'isPublic', e.is_public,
      'isPublicAcrossAgencies', e.is_public_across_agencies,
      'cancelledAt', e.cancelled_at,
      'cancelledReason', e.cancelled_reason,
      'rsvpCount', coalesce(r.n, 0), 'checkinCount', coalesce(k.n, 0),
      'checkinLockouts24h', coalesce(l.n, 0),
      'agenda', e.agenda,
      'minutes', coalesce(mr.items, '[]'::jsonb)
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
    left join (
      select a.detail ->> 'eventId' as event_id, pg_catalog.count(*) as n
      from public.member_admin_audit a
      where a.action = 'event_checkin_lockout'
        and a.created_at >= now() - interval '24 hours'
      group by a.detail ->> 'eventId'
    ) l on l.event_id = e.id
    left join lateral (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', cr.id, 'title', cr.title)
               order by cr.occurred_at desc, cr.id) as items
      from public.chapter_records cr
      where cr.event_id = e.id and cr.chapter_id = caller_chapter
        and cr.record_type = 'minutes' and cr.archived_at is null
    ) mr on true
    where e.chapter_id = caller_chapter
  ), '[]'::jsonb);
end;
$$;

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
        'endsAt', e.ends_at, 'eventKind', e.event_kind, 'eventDate', e.event_date,
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

  select e.cancelled_at, e.starts_at, e.event_kind into ev
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
  if ev.event_kind <> 'meeting' then
    raise exception 'RSVP is not offered for this event' using errcode = '22023';
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
revoke all on function public.create_member_event_model(text,text,timestamptz,text,text,text,boolean,boolean,text,date,timestamptz,integer,text) from public, anon;
revoke all on function public.update_member_event_model(text,text,timestamptz,text,text,text,boolean,boolean,jsonb) from public, anon;
grant execute on function public.create_member_event_model(text,text,timestamptz,text,text,text,boolean,boolean,text,date,timestamptz,integer,text) to authenticated, service_role;
grant execute on function public.update_member_event_model(text,text,timestamptz,text,text,text,boolean,boolean,jsonb) to authenticated, service_role;
notify pgrst, 'reload schema';
commit;
