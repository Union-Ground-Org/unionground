-- SEC-UG-EVENT-NOTIFICATION-FAN-OUT-IS-NOT-CONSTRAINED-TO-THE-EVENT-ORGANIZATION-20260921
--
-- Re-emit public.create_member_event with the same signature, gate, insert,
-- audit row, exception-fenced warning, and leading case-graph lock (the
-- installed wrapper order). The recipient SELECT gains a
-- chapter-to-organization equality conjunct and an active
-- organization_memberships join so chapter, regional, and across-agency
-- visibility stay inside the publishing organization's current members.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.create_member_event(
  p_id text,
  p_title text,
  p_starts_at timestamptz,
  p_location text,
  p_summary text,
  p_check_in_code text,
  p_is_public boolean default false,
  p_is_public_across_agencies boolean default false
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
      perform private.notify_member(m.id, 'event.created', '{}'::jsonb, 'events');
    end loop;
  exception
    when others then
      raise warning 'event.created notify failed for %: % (%)', p_id, sqlerrm, sqlstate;
  end;

  return pg_catalog.jsonb_build_object('id', p_id, 'created', true);
end;
end;
$$;

revoke all on function public.create_member_event(text, text, timestamptz, text, text, text, boolean, boolean)
  from public, anon;
grant execute on function public.create_member_event(text, text, timestamptz, text, text, text, boolean, boolean)
  to authenticated;

comment on function public.create_member_event(text, text, timestamptz, text, text, text, boolean, boolean) is
  'Staff event creator. Notification fan-out stays inside the publishing organization''s active members; public and across-agency flags widen only among that tenant''s chapters.';

notify pgrst, 'reload schema';

commit;
