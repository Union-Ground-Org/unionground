-- BUG-UG-CALENDAR-FEED-CANCELLED-EVENTS-20261020
-- Cancellation preserves RSVPs so restoring a meeting keeps its audience.
-- Exclude cancelled meetings from the subscription rather than serializing
-- them as ordinary active VEVENT entries. Preserve the resolver's signature,
-- service-only grants, token validation and tenant visibility predicate.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

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
        and e.cancelled_at is null
        and private.member_can_access_event_scope_for_user(
          target, e.chapter_id, e.is_public, e.is_public_across_agencies
        )
    ), '[]'::jsonb)
  );
end;
$function$;

commit;
