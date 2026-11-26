-- REQ-UG-FULL-DEPTH-20260723 PR5: web-push subscriptions.
-- Ships BEFORE the delivery queue migration because the enqueue trigger reads
-- this table.
--
-- Two properties drive the shape of this file.
--
-- (1) A push endpoint identifies a BROWSER, not a person. Keying uniqueness on
--     (user_id, endpoint) would let two members each hold a row for the same
--     device: the second member to enable push would appear enabled while
--     every notification still went to the first member's row, and neither
--     could clear the other's. The endpoint is therefore globally unique and
--     enabling push reassigns it — which is what "this device is mine now"
--     actually means.
--
-- (2) Endpoint values are attacker-chosen. Whatever a member stores here, the
--     service-role dispatcher will POST to from Vercel, so a bare `^https://`
--     check would hand any authenticated member a blind server-side request
--     primitive against internal hosts. The host is allow-listed to the real
--     Web Push services in a CHECK, and again in the writer RPC, and the
--     grammar rejects credentials, ports, IP literals, control characters and
--     whitespace.
--
-- Consequence of (1): clients get no INSERT and no UPDATE. Reassignment has to
-- touch a row the caller does not own, which RLS correctly forbids, so writes
-- go through one definer RPC. Members keep SELECT and DELETE on their own rows
-- so "turn push off on this device" needs no RPC at all.

create table if not exists public.member_push_subscriptions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null check (char_length(p256dh) between 1 and 512),
  auth_key text not null check (char_length(auth_key) between 1 and 512),
  -- No user_agent column. Nothing reads a device fingerprint, and a column
  -- that exists is a column something eventually writes.
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.member_push_subscriptions'::regclass
      and conname = 'member_push_subscriptions_endpoint_supported'
  ) then
    alter table public.member_push_subscriptions
      add constraint member_push_subscriptions_endpoint_supported check (
        char_length(endpoint) between 12 and 2048
        -- scheme + hostname + path only: no userinfo (@), no port (:), no IPv6
        -- literal ([]), no control characters, no whitespace.
        and endpoint ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*/[[:graph:]]*$'
        -- ...and the host must belong to a real Web Push service. This is the
        -- SSRF boundary; an IPv4 literal or an internal name fails here.
        and lower(endpoint) ~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)/'
      );
  end if;
end
$$;

create index if not exists member_push_subscriptions_user_idx
  on public.member_push_subscriptions (user_id);

-- A member with unlimited endpoints is a fan-out bomb: one push delivery would
-- aggregate every row and the dispatcher would loop them all inside a single
-- invocation. Cap devices per member and evict the least-recently-seen row so
-- a genuine 11th device still works instead of erroring.
create or replace function private.enforce_push_subscription_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  max_devices constant integer := 10;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member_push_subscriptions:' || new.user_id::text)
  );

  delete from public.member_push_subscriptions s
  where s.user_id = new.user_id
    and s.endpoint is distinct from new.endpoint
    and s.id in (
      select older.id
      from public.member_push_subscriptions older
      where older.user_id = new.user_id
        and older.endpoint is distinct from new.endpoint
      order by older.last_seen_at desc, older.id desc
      offset max_devices - 1
    );

  return new;
end;
$$;

revoke all on function private.enforce_push_subscription_cap() from public, anon, authenticated, service_role;

drop trigger if exists member_push_subscriptions_cap on public.member_push_subscriptions;
create trigger member_push_subscriptions_cap
  before insert on public.member_push_subscriptions
  for each row execute function private.enforce_push_subscription_cap();

-- The only write path. Takes ownership of the endpoint for the caller,
-- displacing whoever held it before, and re-validates the host rather than
-- trusting the CHECK alone.
--
-- There is deliberately no user-agent parameter. It was a device fingerprint
-- that no application path ever read, so it was pure collection: storage of an
-- identifying string about a member's hardware with no use to justify it. The
-- client stopped sending it, and a member-callable RPC that still ACCEPTED it
-- would let any authenticated caller keep writing one.
create or replace function public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text)
returns void
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
  if p_endpoint is null
     or pg_catalog.lower(p_endpoint) !~ '^https://([a-z0-9-]+\.)*(googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)/' then
    raise exception 'unsupported push endpoint' using errcode = '22023';
  end if;
  if p_p256dh is null or p_auth is null
     or pg_catalog.char_length(p_p256dh) not between 1 and 512
     or pg_catalog.char_length(p_auth) not between 1 and 512 then
    raise exception 'invalid push key material' using errcode = '22023';
  end if;

  insert into public.member_push_subscriptions (user_id, endpoint, p256dh, auth_key)
  values (caller, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = caller,
        p256dh = excluded.p256dh,
        auth_key = excluded.auth_key,
        last_seen_at = pg_catalog.now();
end;
$$;

-- Drop the earlier 4-argument shape if a previous apply created it, so the
-- user-agent path cannot survive as a callable overload.
drop function if exists public.upsert_push_subscription(text, text, text, text);

revoke all on function public.upsert_push_subscription(text, text, text) from public, anon;
grant execute on function public.upsert_push_subscription(text, text, text) to authenticated;

alter table public.member_push_subscriptions enable row level security;

drop policy if exists member_push_subscriptions_select_own on public.member_push_subscriptions;
create policy member_push_subscriptions_select_own on public.member_push_subscriptions
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists member_push_subscriptions_delete_own on public.member_push_subscriptions;
create policy member_push_subscriptions_delete_own on public.member_push_subscriptions
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Insert/update policies are deliberately absent: the writer RPC is the only
-- path, and it runs as definer.
drop policy if exists member_push_subscriptions_insert_own on public.member_push_subscriptions;
drop policy if exists member_push_subscriptions_update_own on public.member_push_subscriptions;

revoke all on public.member_push_subscriptions from anon, authenticated;
grant select, delete on public.member_push_subscriptions to authenticated;
-- The dispatcher reads subscriptions and prunes dead endpoints on 404/410.
grant select, delete on public.member_push_subscriptions to service_role;

notify pgrst, 'reload schema';
