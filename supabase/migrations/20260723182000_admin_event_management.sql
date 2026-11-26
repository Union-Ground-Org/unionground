-- REQ-UG-FULL-DEPTH-20260723 PR4b: admin event management.
-- member_events had NO write path (seed-only). These are the first writes:
-- admin-gated definer RPCs with the same validation posture as the table
-- CHECKs plus control-character rejection, all audited. get_admin_events is
-- deliberately the ONLY authenticated-reachable path that returns
-- check_in_code — the column stays excluded from the member_events client
-- SELECT grant because the static SG- code self-check-in awards points
-- (check_in_to_event), so off-site exposure makes attendance forgeable.

-- 1. Create an event. The advisory lock serializes order_index allocation
--    (the column is UNIQUE; two concurrent creates would otherwise race
--    max()+1 into a unique violation).
create function public.create_member_event(
  p_id text,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_summary text,
  p_check_in_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;
  if p_id is null or p_id !~ '^[a-z0-9][a-z0-9-]{2,63}$' then
    raise exception 'invalid event id' using errcode = '22023';
  end if;
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120
     or p_title ~ '[[:cntrl:]]' then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_starts_at is null then
    raise exception 'invalid start time' using errcode = '22023';
  end if;
  if p_location is null or pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120
     or p_location ~ '[[:cntrl:]]' then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is null or pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500
     or p_summary ~ '[[:cntrl:]]' then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is null or p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('member_events:order_index'));
  if exists (select 1 from public.member_events where id = p_id) then
    raise exception 'event id already exists' using errcode = '22023';
  end if;

  insert into public.member_events (id, title, starts_at, location, summary, check_in_code, order_index)
  values (p_id, pg_catalog.btrim(p_title), p_starts_at, pg_catalog.btrim(p_location),
          pg_catalog.btrim(p_summary), p_check_in_code,
          coalesce((select pg_catalog.max(order_index) + 1 from public.member_events), 1));

  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'create_event',
          pg_catalog.jsonb_build_object('eventId', p_id, 'title', pg_catalog.btrim(p_title)));

  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
$$;

revoke all on function public.create_member_event(text, text, timestamptz, text, text, text) from public, anon;
grant execute on function public.create_member_event(text, text, timestamptz, text, text, text) to authenticated;

-- 2. Partial update: NULL parameters keep the existing value; every supplied
--    field is re-validated with the same rules as create.
create function public.update_member_event(
  p_id text,
  p_title text default null,
  p_starts_at timestamptz default null,
  p_location text default null,
  p_summary text default null,
  p_check_in_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ev public.member_events%rowtype;
  changed text[];
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  select * into ev from public.member_events where id = p_id for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  if p_title is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 3 and 120
          or p_title ~ '[[:cntrl:]]') then
    raise exception 'invalid title' using errcode = '22023';
  end if;
  if p_location is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_location)) not between 1 and 120
          or p_location ~ '[[:cntrl:]]') then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if p_summary is not null
     and (pg_catalog.char_length(pg_catalog.btrim(p_summary)) not between 1 and 500
          or p_summary ~ '[[:cntrl:]]') then
    raise exception 'invalid summary' using errcode = '22023';
  end if;
  if p_check_in_code is not null and p_check_in_code !~ '^SG-[0-9A-Z]{3,12}$' then
    raise exception 'invalid check-in code' using errcode = '22023';
  end if;

  -- Diff against the row we hold FOR UPDATE: the client edit form pre-fills
  -- every text field, so parameter presence alone would record supplied-but-
  -- identical values as changes. Only real differences reach the audit trail.
  changed := pg_catalog.array_remove(array[
    case when p_title is not null and pg_catalog.btrim(p_title) is distinct from ev.title then 'title' end,
    case when p_starts_at is not null and p_starts_at is distinct from ev.starts_at then 'starts_at' end,
    case when p_location is not null and pg_catalog.btrim(p_location) is distinct from ev.location then 'location' end,
    case when p_summary is not null and pg_catalog.btrim(p_summary) is distinct from ev.summary then 'summary' end,
    case when p_check_in_code is not null and p_check_in_code is distinct from ev.check_in_code then 'check_in_code' end
  ], null);

  if pg_catalog.cardinality(changed) > 0 then
    update public.member_events set
      title = coalesce(pg_catalog.btrim(p_title), title),
      starts_at = coalesce(p_starts_at, starts_at),
      location = coalesce(pg_catalog.btrim(p_location), location),
      summary = coalesce(pg_catalog.btrim(p_summary), summary),
      check_in_code = coalesce(p_check_in_code, check_in_code)
    where id = p_id;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event',
            pg_catalog.jsonb_build_object('eventId', p_id, 'title', ev.title,
              'fields', pg_catalog.to_jsonb(changed)));
  end if;

  return pg_catalog.jsonb_build_object('id', p_id, 'updated', pg_catalog.cardinality(changed) > 0);
end;
$$;

revoke all on function public.update_member_event(text, text, timestamptz, text, text, text) from public, anon;
grant execute on function public.update_member_event(text, text, timestamptz, text, text, text) to authenticated;

-- 3. Admin event listing WITH the check-in code plus live RSVP/check-in
--    counts (the tables are tiny: rows only exist for real RSVPs/check-ins).
create function public.get_admin_events()
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not public.member_has_role(array['admin']) then
    raise exception 'admin role required' using errcode = '42501';
  end if;

  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'startsAt', e.starts_at,
      'location', e.location,
      'summary', e.summary,
      'checkInCode', e.check_in_code,
      'orderIndex', e.order_index,
      'rsvpCount', coalesce(r.n, 0),
      'checkinCount', coalesce(k.n, 0)) order by e.order_index)
    from public.member_events e
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_rsvps where status = 'going' group by event_id
    ) r on r.event_id = e.id
    left join (
      select event_id, pg_catalog.count(*) as n
      from public.member_event_checkins group by event_id
    ) k on k.event_id = e.id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_admin_events() from public, anon;
grant execute on function public.get_admin_events() to authenticated;
