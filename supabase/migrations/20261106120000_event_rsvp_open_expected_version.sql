-- REQ-UG-LEARNING-PERIOD-EVENTS-20261103 (#6944), gate finding r4s1
-- on #7029. Fix forward after 20261104110000.
--
-- The edit form saves the fields first and switches RSVP collection second,
-- as two requests. The switch took no expected version, so a switch that was
-- already on its way when an undo landed (in another tab, say) still
-- committed and put back the value the undo had just taken away.
-- set_member_event_rsvp_open now takes p_expected_version with the agenda
-- setter's semantics: a version that is not the event's current one is
-- refused with 40001 / event_changed, and the version the switch leaves comes
-- back. The client sends the version its own update returned. The trailing
-- default keeps two-argument SQL callers working; the two-argument form is
-- dropped so PostgREST sees one function.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.set_member_event_rsvp_open(p_id text, p_open boolean, p_expected_version integer default null)
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
  learning_before jsonb;
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

  -- A stale switch, for example one that waited behind an undo, is refused
  -- instead of reapplying what the undo took back.
  if p_expected_version is not null and ev.version is distinct from p_expected_version then
    raise exception 'this event changed; reload it before saving'
      using errcode = '40001', detail = 'event_changed';
  end if;

  if ev.rsvp_open is distinct from p_open then
    learning_before := private.learning_event_state(p_id);
    update public.member_events set rsvp_open = p_open, version = version + 1
    where id = p_id and chapter_id = caller_chapter;
    perform private.learning_event_journal('event_edit', p_id, learning_before);

    insert into public.member_admin_audit (actor, action, detail)
    values (caller, 'update_event', pg_catalog.jsonb_build_object(
      'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
      'fields', pg_catalog.jsonb_build_array('rsvp_open'),
      'rsvpOpen', p_open,
      'isPublic', ev.is_public,
      'isPublicAcrossAgencies', ev.is_public_across_agencies));
  end if;

  return pg_catalog.jsonb_build_object('updated', ev.rsvp_open is distinct from p_open, 'rsvpOpen', p_open,
    'version', (select e.version from public.member_events e where e.id = p_id));
end;
end;
$function$;

revoke all on function public.set_member_event_rsvp_open(text, boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.set_member_event_rsvp_open(text, boolean, integer) to authenticated;
drop function public.set_member_event_rsvp_open(text, boolean);

comment on function public.set_member_event_rsvp_open(text, boolean, integer) is
  'Staff switch for RSVP collection on an event of the caller''s chapter. Refuses a stale p_expected_version (40001 event_changed), journals the edit during a learning period and is audited as update_event with fields ["rsvp_open"].';

notify pgrst, 'reload schema';
commit;
