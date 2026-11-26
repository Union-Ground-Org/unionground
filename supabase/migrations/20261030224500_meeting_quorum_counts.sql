-- REQ-UG-MEETING-QUORUM-COUNTS-20261030 (#6629)
--
-- Finding 95 of the Oct 29-30 role-play run: a meeting asked people to check
-- in at the door but showed no quorum figure and no count toward it;
-- public.member_events had no quorum at all.
--
-- 1. public.member_events.quorum_count: an optional whole number (1 to
--    100,000) a meeting needs present. Not granted to any client role; it is
--    read only through the function below.
-- 2. public.set_member_event_quorum(p_id, p_quorum): staff who may manage
--    events set or clear it on a meeting of their own chapter, audited as an
--    update_event row (member_admin_audit) with the before and after values.
-- 3. public.get_member_event_quorum(p_event_ids): for the given events the
--    caller can see (the member_events_select_scoped predicate, restated
--    below), each meeting's quorum and how many members have checked in. Only
--    the two numbers: no names, ids or anything else about who checked in.
--
-- Both functions are SECURITY DEFINER with an empty search_path and check
-- two-step sign-in (private.mfa_satisfied); the writer takes the case-graph
-- lock first, as every event writer does.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.member_events
  add column quorum_count integer,
  add constraint member_events_quorum_count_bounded
    check (quorum_count is null or quorum_count between 1 and 100000);

comment on column public.member_events.quorum_count is
  'REQ-UG-MEETING-QUORUM-COUNTS-20261030: members a meeting needs present, set by staff (set_member_event_quorum). Read through get_member_event_quorum only; no client column grant.';

create function public.set_member_event_quorum(p_id text, p_quorum integer)
returns jsonb
language plpgsql
volatile
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
  if p_quorum is not null and p_quorum not between 1 and 100000 then
    raise exception 'quorum must be a whole number from 1 to 100000' using errcode = '22023';
  end if;
  select * into ev from public.member_events
  where id = p_id and chapter_id = caller_chapter
  for update;
  if not found then
    raise exception 'unknown event' using errcode = '22023';
  end if;
  if coalesce(ev.event_kind, 'meeting') <> 'meeting' then
    raise exception 'only a meeting takes a quorum' using errcode = '22023';
  end if;
  if ev.quorum_count is not distinct from p_quorum then
    return pg_catalog.jsonb_build_object('id', p_id, 'quorum', p_quorum, 'changed', false);
  end if;
  update public.member_events set quorum_count = p_quorum
  where id = p_id and chapter_id = caller_chapter;
  insert into public.member_admin_audit (actor, action, detail)
  values (caller, 'update_event', pg_catalog.jsonb_build_object(
    'eventId', p_id, 'title', ev.title, 'chapterId', caller_chapter,
    'field', 'quorum', 'from', ev.quorum_count, 'to', p_quorum));
  return pg_catalog.jsonb_build_object('id', p_id, 'quorum', p_quorum, 'changed', true);
end;
end;
$function$;
revoke all on function public.set_member_event_quorum(text, integer) from public, anon, authenticated, service_role;
grant execute on function public.set_member_event_quorum(text, integer) to authenticated;

-- Visibility restates policy member_events_select_scoped
-- (20260901200000_deployed_dues_event_assurance_repair.sql) term for term:
-- the caller's organization, then their chapter, an across-agencies event,
-- or a public event of a chapter in the caller's region.
create function public.get_member_event_quorum(p_event_ids text[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  org uuid;
  member_chapter text;
  member_region text;
begin
  if (select auth.uid()) is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_event_ids is null or pg_catalog.cardinality(p_event_ids) > 200 then
    raise exception 'between 0 and 200 events' using errcode = '22023';
  end if;
  org := private.current_member_organization();
  if org is null then
    return '[]'::jsonb;
  end if;
  member_chapter := private.current_member_chapter();
  select c.region into member_region from public.chapters c
  where c.id = member_chapter and c.organization_id = org;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'eventId', e.id,
        'quorum', e.quorum_count,
        'checkedIn', (select pg_catalog.count(*)::integer from public.member_event_checkins k where k.event_id = e.id))
      order by e.id)
    from public.member_events e
    join public.chapters event_chapter on event_chapter.id = e.chapter_id
    where e.id = any(p_event_ids)
      and e.quorum_count is not null
      and coalesce(e.event_kind, 'meeting') = 'meeting'
      and event_chapter.organization_id = org
      and (
        event_chapter.id = member_chapter
        or coalesce(e.is_public_across_agencies, false)
        or (coalesce(e.is_public, false) and event_chapter.region is not null and event_chapter.region = member_region)
      )
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.get_member_event_quorum(text[]) from public, anon, authenticated, service_role;
grant execute on function public.get_member_event_quorum(text[]) to authenticated;

commit;
