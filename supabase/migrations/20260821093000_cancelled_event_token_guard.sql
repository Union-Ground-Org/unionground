-- Complete the cancelled-event member-action invariant by refusing to mint a
-- short-lived check-in token after cancellation. The event row lock orders the
-- request against concurrent cancellation before any existing token is deleted
-- or replacement token is inserted.
begin;

create or replace function public.request_event_checkin_token(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

commit;
