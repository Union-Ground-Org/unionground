-- REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030
--
-- Two event-desk gaps the October 29-30 role-play run found (findings 55 and
-- 102): an event could not be kept staff-only before publishing, and RSVP
-- collection could not be switched off or on.
--
-- 1. public.member_events.rsvp_open, default true so every existing event
--    keeps collecting RSVPs. A trigger on public.member_event_rsvps refuses a
--    new "going" answer while it is off (detail token rsvp_closed), so every
--    writer is covered, not only rsvp_to_event. Withdrawing ("not_going")
--    stays allowed, so a member who already said yes can still change it, and
--    replaying a "going" that is already recorded is not refused.
--    public.set_member_event_rsvp_open is the staff switch, audited as an
--    update_event with fields ["rsvp_open"], like the agenda.
--    public.create_member_event_with_rsvp creates an event with collection off
--    in the same transaction (gate round 1 on #6610): no other transaction
--    ever sees the new event open for RSVPs.
-- 2. public.get_admin_events() carries rsvpOpen. Its body is otherwise the
--    20261009002000_event_model generation, unchanged.
-- 3. private.member_event_drafts: a staff-only draft is not a member_events
--    row at all, so no member read, calendar feed, notification sweep, export
--    or public page can ever see it. Drafts belong to a chapter, are read and
--    written only through three staff functions with the same role and
--    chapter gate as the event writers, and carry no person reference.
--    Publishing a draft is the ordinary create_member_event(_model) call
--    (which validates every field and fans out the notice), then a delete of
--    the draft.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ------------------------------------------------------------ 1. RSVP switch
alter table public.member_events
  add column if not exists rsvp_open boolean not null default true;

-- The existing tenant-first member_events_select_scoped policy covers it.
grant select (rsvp_open) on public.member_events to authenticated;

comment on column public.member_events.rsvp_open is
  'REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030: whether the event collects RSVPs. Off refuses a new going answer (detail rsvp_closed); a member can still withdraw.';

create function private.member_event_rsvp_open_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- INSERT ... ON CONFLICT runs the INSERT trigger even when the row exists,
  -- so a replayed "going" that is already recorded passes.
  if new.status = 'going'
     and (tg_op = 'INSERT' or old.status is distinct from 'going')
     and not (tg_op = 'INSERT' and exists (
       select 1 from public.member_event_rsvps r
       where r.event_id = new.event_id and r.user_id = new.user_id and r.status = 'going'))
     and exists (select 1 from public.member_events e where e.id = new.event_id and not e.rsvp_open) then
    raise exception 'this event is not collecting RSVPs'
      using errcode = '22023', detail = 'rsvp_closed';
  end if;
  return new;
end;
$function$;

revoke all on function private.member_event_rsvp_open_guard() from public, anon, authenticated, service_role;

create trigger m50_rsvp_open_guard
before insert or update of status on public.member_event_rsvps
for each row execute function private.member_event_rsvp_open_guard();

create function public.set_member_event_rsvp_open(p_id text, p_open boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  caller uuid := (select auth.uid());
  caller_chapter text;
  ev public.member_events%rowtype;
begin
  if caller is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  if p_open is null then
    raise exception 'rsvp switch is required' using errcode = '22023';
  end if;

  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;

  if ev.rsvp_open is distinct from p_open then
    update public.member_events set rsvp_open = p_open
    where id = p_id and chapter_id = caller_chapter;

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('rsvp_open'),
      'rsvpOpen', p_open,
      'isPublic', ev.is_public,
      'isPublicAcrossAgencies', ev.is_public_across_agencies));
  end if;

  return pg_catalog.jsonb_build_object('updated', ev.rsvp_open is distinct from p_open, 'rsvpOpen', p_open);
end;
end;
$function$;

revoke all on function public.set_member_event_rsvp_open(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_member_event_rsvp_open(text, boolean) to authenticated;

comment on function public.set_member_event_rsvp_open(text, boolean) is
  'Staff switch for RSVP collection on an event of the caller''s chapter. Audited as update_event with fields ["rsvp_open"].';

-- An event created with RSVP collection off: the ordinary model create, then
-- the switch, in one transaction, so the open state never commits.
create function public.create_member_event_with_rsvp(
  p_id text,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_summary text,
  p_check_in_code text,
  p_is_public boolean,
  p_is_public_across_agencies boolean,
  p_kind text,
  p_event_date date,
  p_ends_at timestamptz,
  p_occurrences integer,
  p_timezone text,
  p_rsvp_open boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  created jsonb;
  caller_chapter text;
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  if p_rsvp_open is null then
    raise exception 'rsvp switch is required' using errcode = '22023';
  end if;
  created := public.create_member_event_model(
    p_id, p_title, p_starts_at, p_location, p_summary, p_check_in_code,
    p_is_public, p_is_public_across_agencies, p_kind, p_event_date, p_ends_at,
    p_occurrences, p_timezone);
  if not p_rsvp_open then
    caller_chapter := private.current_member_chapter();
    update public.member_events set rsvp_open = false
    where chapter_id = caller_chapter
      and id in (select pg_catalog.jsonb_array_elements_text(created -> 'occurrenceIds'));
    insert into public.member_admin_audit (actor, action, detail)
    values ((select auth.uid()), 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', pg_catalog.btrim(p_title), 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('rsvp_open'),
      'rsvpOpen', false,
      'isPublic', p_is_public,
      'isPublicAcrossAgencies', p_is_public_across_agencies));
  end if;
  return created || pg_catalog.jsonb_build_object('rsvpOpen', p_rsvp_open);
end;
$function$;

revoke all on function public.create_member_event_with_rsvp(text, text, timestamptz, text, text, text, boolean, boolean, text, date, timestamptz, integer, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.create_member_event_with_rsvp(text, text, timestamptz, text, text, text, boolean, boolean, text, date, timestamptz, integer, text, boolean) to authenticated;

comment on function public.create_member_event_with_rsvp(text, text, timestamptz, text, text, text, boolean, boolean, text, date, timestamptz, integer, text, boolean) is
  'create_member_event_model plus the RSVP switch in one transaction, so an event created with collection off is never visible with it on.';

-- ------------------------------------------------- 2. staff event list
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
      'rsvpOpen', e.rsvp_open,
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

-- ------------------------------------------------------ 3. staff-only drafts
create table private.member_event_drafts (
  id uuid primary key default extensions.gen_random_uuid(),
  -- Always the writer's private.current_member_chapter(), set only by
  -- save_member_event_draft; no foreign key, so the account case-graph FK
  -- catalogue is unchanged.
  chapter_id text not null,
  fields jsonb not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint member_event_drafts_fields_shape check (
    pg_catalog.jsonb_typeof(fields) = 'object' and pg_catalog.octet_length(fields::text) <= 8192
  )
);

revoke all on table private.member_event_drafts from public, anon, authenticated, service_role;

create index member_event_drafts_chapter_idx on private.member_event_drafts (chapter_id, updated_at desc);

comment on table private.member_event_drafts is
  'REQ-UG-EVENTS-RSVP-CHECK-IN-AND-VISIBILITY-20261030: staff-only event drafts of a chapter, kept apart from member_events so no member path can read one. Read and written only through the member event draft functions; publishing is an ordinary event create.';

-- The staff caller's chapter, or an error: the same gate as the event writers.
create function private.member_event_draft_chapter()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_chapter text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() or not private.member_can_manage_events() then
    raise exception 'staff role required' using errcode = '42501';
  end if;
  caller_chapter := private.current_member_chapter();
  if caller_chapter is null then
    raise exception 'staff chapter required' using errcode = '42501';
  end if;
  return caller_chapter;
end;
$function$;

revoke all on function private.member_event_draft_chapter() from public, anon, authenticated, service_role;

create function public.list_member_event_drafts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  caller_chapter text := private.member_event_draft_chapter();
begin
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'id', d.id, 'fields', d.fields, 'createdAt', d.created_at, 'updatedAt', d.updated_at
    ) order by d.updated_at desc, d.id)
    from private.member_event_drafts d
    where d.chapter_id = caller_chapter
  ), '[]'::jsonb);
end;
$function$;

-- A draft holds what the event form holds, partly filled. Field values are
-- checked for shape only; create_member_event(_model) checks them in full when
-- the draft is published.
create function public.save_member_event_draft(p_draft_id uuid, p_fields jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_chapter text := private.member_event_draft_chapter();
  saved private.member_event_drafts%rowtype;
begin
  if p_fields is null or pg_catalog.jsonb_typeof(p_fields) <> 'object'
     or pg_catalog.octet_length(p_fields::text) > 8192
     or exists (
       select 1 from pg_catalog.jsonb_each(p_fields) f
       where f.key <> all (array['id', 'title', 'eventKind', 'startsAt', 'endsAt', 'eventDate', 'occurrences',
                                 'timezone', 'location', 'summary', 'checkInCode', 'isPublic',
                                 'isPublicAcrossAgencies', 'rsvpOpen'])
          or pg_catalog.jsonb_typeof(f.value) not in ('string', 'number', 'boolean', 'null')
          or (pg_catalog.jsonb_typeof(f.value) = 'string' and pg_catalog.char_length(f.value #>> '{}') > 500)
          -- Dates and times are ISO strings, so a reopened draft can be read.
          or (f.key in ('startsAt', 'endsAt', 'eventDate') and pg_catalog.jsonb_typeof(f.value) = 'string'
              and (f.value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}:?[0-9]{2})?)?$')
     ) then
    raise exception 'invalid event draft' using errcode = '22023';
  end if;
  if pg_catalog.btrim(coalesce(p_fields ->> 'title', '')) = '' then
    raise exception 'an event draft needs a title' using errcode = '22023';
  end if;

  if p_draft_id is null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('member_event_drafts:' || caller_chapter, 509));
    if (select pg_catalog.count(*) from private.member_event_drafts where chapter_id = caller_chapter) >= 100 then
      raise exception 'too many event drafts' using errcode = '22023';
    end if;
    insert into private.member_event_drafts (chapter_id, fields)
    values (caller_chapter, p_fields)
    returning * into saved;
  else
    update private.member_event_drafts
       set fields = p_fields, updated_at = pg_catalog.now()
     where id = p_draft_id and chapter_id = caller_chapter
    returning * into saved;
    if not found then
      raise exception 'unknown event draft' using errcode = '22023';
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', saved.id, 'fields', saved.fields, 'createdAt', saved.created_at, 'updatedAt', saved.updated_at);
end;
$function$;

create function public.delete_member_event_draft(p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  caller_chapter text := private.member_event_draft_chapter();
  removed integer;
begin
  delete from private.member_event_drafts where id = p_draft_id and chapter_id = caller_chapter;
  get diagnostics removed = row_count;
  return pg_catalog.jsonb_build_object('id', p_draft_id, 'deleted', removed = 1);
end;
$function$;

revoke all on function public.list_member_event_drafts() from public, anon, authenticated, service_role;
revoke all on function public.save_member_event_draft(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.delete_member_event_draft(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_member_event_drafts() to authenticated;
grant execute on function public.save_member_event_draft(uuid, jsonb) to authenticated;
grant execute on function public.delete_member_event_draft(uuid) to authenticated;

comment on function public.list_member_event_drafts() is
  'Staff-only event drafts of the caller''s chapter, newest first. Same role and chapter gate as the event writers.';
comment on function public.save_member_event_draft(uuid, jsonb) is
  'Creates (null id) or replaces a staff-only event draft of the caller''s chapter. Fields are the event form''s keys, shape-checked; the full checks run when the draft is published as an event.';
comment on function public.delete_member_event_draft(uuid) is
  'Deletes a staff-only event draft of the caller''s chapter, after it is published or when it is discarded.';

-- ------------------------------------------ account lifecycle trigger review
-- The guard is a new trigger on an identity-linked table; record it (and the
-- function it reaches) in the reviewed trigger inventory.
insert into private.account_lifecycle_trigger_review(kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'public' and table_name = 'member_event_rsvps'
       and object_name = 'm50_rsvp_open_guard')
   or (kind = 'function' and schema_name = 'private'
       and object_name = 'member_event_rsvp_open_guard()')
on conflict (kind, schema_name, table_name, object_name) do update set definition_hash = excluded.definition_hash;

do $$ begin
  if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then
    raise exception 'account lifecycle trigger review is incomplete after the event RSVP switch';
  end if;
end; $$;

notify pgrst, 'reload schema';

commit;
