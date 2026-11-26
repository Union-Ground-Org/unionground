-- REQ-UG-OFFICER-BUDGET-AND-MEETING-AGENDA-20261006 (partial delivery)
--
-- Owner decision, October 8, 2026 (11:28 AM ET, question 8, option A): build
-- the meeting agenda field now, with minutes attached to it; the officer
-- budget is held until officer roles exist and a permitted-model SAMPLE check
-- passes. Nothing here touches budgets.
--
--   * public.member_events.agenda: nullable text, 1-4000 characters, trimmed,
--     line breaks and tabs allowed, no other control characters. Members have
--     no column grant on it: the agenda is read by staff on the events desk,
--     so a public or cross-agency event never shows it to another chapter.
--   * public.set_member_event_agenda(p_id, p_agenda): the events-desk gate of
--     update_member_event (private.member_can_manage_events(), the caller's
--     own chapter only) sets or clears the agenda, with the existing
--     update_event audit action and fields ['agenda'].
--   * public.chapter_records.event_id: the meeting a minutes record was kept
--     against. No foreign key, so the reviewed case-graph FK catalogue and its
--     lock order are unchanged: attach_minutes_to_meeting checks the event,
--     and every read joins on member_events, so a deleted meeting's id
--     resolves to nothing.
--   * public.attach_minutes_to_meeting(p_record_id, p_event_id): staff of the
--     chapter (private.institutional_context(true)) attach an unarchived
--     minutes record to one of the same chapter's meetings, past or upcoming,
--     or detach it with a null event, audited as update_event with fields
--     ['minutes']. The records workspace already returns event_id through
--     to_jsonb(r).
--   * public.get_admin_events() also returns each event's agenda and the
--     unarchived minutes records attached to it (id and title).
--
-- Hosted application: SAMPLE first, then production, in a later hosted stage.
-- No hosted data is changed.

begin;
set local lock_timeout = '5s';

alter table public.member_events
  add column agenda text;
alter table public.member_events
  add constraint member_events_agenda_check
  check (agenda is null or (
    pg_catalog.char_length(agenda) between 1 and 4000
    and agenda = pg_catalog.btrim(agenda, ' ' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9))
    and pg_catalog.translate(agenda, pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9), '') !~ '[[:cntrl:]]'));

comment on column public.member_events.agenda is
  'Meeting agenda kept by staff on the events desk (set_member_event_agenda). No member column grant; minutes attach through chapter_records.event_id.';

alter table public.chapter_records
  add column event_id text;
create index chapter_records_event_idx on public.chapter_records (event_id) where event_id is not null;

comment on column public.chapter_records.event_id is
  'The meeting (member_events row of the same chapter) a minutes record was kept against, set by attach_minutes_to_meeting.';

create function public.set_member_event_agenda(p_id text, p_agenda text)
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
  clean text := nullif(pg_catalog.btrim(coalesce(p_agenda, ''), ' ' || pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9)), '');
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

  if clean is not null and (pg_catalog.char_length(clean) > 4000
     or pg_catalog.translate(clean, pg_catalog.chr(10) || pg_catalog.chr(13) || pg_catalog.chr(9), '') ~ '[[:cntrl:]]') then
    raise exception 'invalid agenda' using errcode = '22023';
  end if;

  if clean is distinct from ev.agenda then
    update public.member_events set agenda = clean
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('agenda'),
      'isPublic', ev.is_public,
      'isPublicAcrossAgencies', ev.is_public_across_agencies));
  end if;

  return pg_catalog.jsonb_build_object('updated', clean is distinct from ev.agenda, 'agenda', clean);
end;
end;
$$;

revoke all on function public.set_member_event_agenda(text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_member_event_agenda(text, text) to authenticated;

create function public.attach_minutes_to_meeting(p_record_id uuid, p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  ctx record;
  rec public.chapter_records%rowtype;
  target public.member_events%rowtype;
  clean_event text := nullif(pg_catalog.btrim(coalesce(p_event_id, '')), '');
begin
  -- Same assurance gate as save_institutional_record, ahead of the context.
  if not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  select * into ctx from private.institutional_context(true);

  select * into rec from public.chapter_records
  where id = p_record_id and chapter_id = ctx.chapter_id
    and record_type = 'minutes' and archived_at is null
  for update;
  if not found then
    raise exception 'unknown minutes record' using errcode = '22023';
  end if;

  if clean_event is not null then
    select * into target from public.member_events
    where id = clean_event and chapter_id = ctx.chapter_id;
    if not found then
      raise exception 'unknown event' using errcode = '22023';
    end if;
  end if;

  if clean_event is distinct from rec.event_id then
    update public.chapter_records set event_id = clean_event
    where id = rec.id and chapter_id = ctx.chapter_id;

    -- Detaching names the meeting the record leaves.
    if clean_event is null then
      select * into target from public.member_events where id = rec.event_id;
    end if;
    insert into public.member_admin_audit (actor, action, detail)
    values (ctx.caller_id, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', coalesce(clean_event, rec.event_id), 'title', target.title,
      'chapterId', ctx.chapter_id,
      'fields', pg_catalog.jsonb_build_array('minutes'),
      'recordId', rec.id, 'attached', clean_event is not null));
  end if;

  return pg_catalog.jsonb_build_object('updated', clean_event is distinct from rec.event_id, 'eventId', clean_event);
end;
end;
$$;

revoke all on function public.attach_minutes_to_meeting(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.attach_minutes_to_meeting(uuid, text) to authenticated;

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


commit;
