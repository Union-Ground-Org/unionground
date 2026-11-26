-- REQ-UG-FULL-DEPTH-20260723 (PR3, part B): personal calendar subscribe
-- feed. A calendar app polling an ICS URL has no Supabase session, so the
-- feed credential is a long-lived, revocable, high-entropy opaque token
-- embedded in the URL (48 hex chars = 24 random bytes) — never the member's
-- JWT and never the short 7-char check-in code (different threat model: this
-- one must survive being pasted into a third-party calendar app). Only the
-- sha256 hash is stored; the plaintext is returned exactly once at mint time.

create table public.member_calendar_feed_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

alter table public.member_calendar_feed_tokens enable row level security;

create policy member_calendar_feed_tokens_select_own on public.member_calendar_feed_tokens
  for select to authenticated using ((select auth.uid()) = user_id);

revoke all on public.member_calendar_feed_tokens from anon, authenticated;
-- token_hash is never granted: a member can see THAT they have a link and
-- when it was last rotated, never the hash itself. All writes go through the
-- definer RPCs below.
grant select (user_id, created_at, rotated_at) on public.member_calendar_feed_tokens to authenticated;

create function private.calendar_feed_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

revoke all on function private.calendar_feed_token_hash(text) from public, anon, authenticated;

-- Member-facing: mint or rotate my own feed link. Rotating invalidates the
-- previous link immediately (the old hash is overwritten).
create function public.rotate_calendar_feed_token()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  plain text;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  plain := pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.member_calendar_feed_tokens (user_id, token_hash, rotated_at)
  values (caller, private.calendar_feed_token_hash(plain), now())
  on conflict (user_id) do update set token_hash = excluded.token_hash, rotated_at = now();
  return pg_catalog.jsonb_build_object('token', plain);
end;
$$;

-- Member-facing: kill my feed link without minting a new one (lost device,
-- accidentally shared URL).
create function public.revoke_calendar_feed_token()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  delete from public.member_calendar_feed_tokens where user_id = caller;
  return pg_catalog.jsonb_build_object('revoked', true);
end;
$$;

-- Service-role-only entry point for api/calendar.js. This is the one function
-- in the events surface that is deliberately NOT self-guarded by auth.uid():
-- the caller is a third-party calendar app hitting a bare URL, so the guard is
-- (a) the opaque token's secrecy and length bounds, (b) EXECUTE granted only
-- to service_role (the trusted serverless function's key), and (c) the
-- in-body auth.role() check, which keeps this closed even if someone later
-- "fixes" the missing grant by widening it to authenticated — without that
-- check such a grant would turn a member's own session into a token-guessing
-- oracle that bypasses URL secrecy entirely. Do not remove any of the three.
-- Feed scope: only events the member RSVP'd 'going' to — a personal calendar
-- carries what the member opted into, not the whole org catalog.
create function public.get_calendar_feed_events(p_token text)
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
        'id', e.id,
        'title', e.title,
        'startsAt', e.starts_at,
        'location', e.location,
        'summary', e.summary
      ) order by e.starts_at)
      from public.member_events e
      join public.member_event_rsvps r on r.event_id = e.id
      where r.user_id = target and r.status = 'going'
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.rotate_calendar_feed_token() from public, anon;
revoke all on function public.revoke_calendar_feed_token() from public, anon;
revoke all on function public.get_calendar_feed_events(text) from public, anon, authenticated;
grant execute on function public.rotate_calendar_feed_token() to authenticated;
grant execute on function public.revoke_calendar_feed_token() to authenticated;
grant execute on function public.get_calendar_feed_events(text) to service_role;
