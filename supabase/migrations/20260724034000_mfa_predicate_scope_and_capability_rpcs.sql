-- Two corrections to the assurance boundary, both found by the adversarial pass.
--
-- 1. THE PREDICATE COUNTED FACTORS THE APP CANNOT CHALLENGE.
--    private.mfa_satisfied() asked "has any verified factor", but this client
--    only knows how to challenge TOTP. A member with a verified phone or
--    WebAuthn factor — enrollable straight through /auth/v1/factors, and Supabase
--    will happily create one — would have RLS demanding aal2 while the UI showed
--    "no authenticator" and offered no way to elevate. The boundary would have
--    turned into a permanent lockout for exactly the member who took security
--    most seriously. Count only what we can actually ask for.
--
-- 2. TWO MEMBER RPCs LEAKED DATA AT aal1.
--    SECURITY DEFINER functions bypass RLS, so the table policies do nothing for
--    them. 20260724031000 covered the 27 staff RPCs through member_has_role, and
--    the rest were written off as "write/action only, no disclosure". That was
--    wrong for these two, and disclosure is the whole point of the boundary:
--
--      rotate_calendar_feed_token  mints a bearer URL that streams the member's
--                                  events to anyone holding it, forever, with no
--                                  session and no assurance level at all. A thief
--                                  with the password calls this once at aal1 and
--                                  keeps reading after the password is changed.
--      upsert_push_subscription    points the member's push notifications at an
--                                  endpoint the caller controls, turning the
--                                  notification stream into an exfiltration
--                                  channel — case updates delivered to the
--                                  attacker's device.
--
--    Both are capability-granting, and a capability outlives the session that
--    created it, which is what makes them worse than an ordinary write.
--
-- Bodies below are otherwise verbatim from 20260723141000 and 20260723200000;
-- the only change is the assurance term in the existing guard.

-- Session-scoped, not SET LOCAL: the CLI applies each migration file outside an
-- explicit transaction, where SET LOCAL raises WARNING 25P01 and silently does
-- nothing. As written this guard never bounded a single lock wait.
set lock_timeout = '5s';

create or replace function private.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.jwt() ->> 'aal') = 'aal2' then true
    else not exists (
      select 1
      from auth.mfa_factors f
      where f.user_id = (select auth.uid())
        and f.status = 'verified'
        -- TOTP only: see note 1. Counting a factor type the challenge screen
        -- cannot satisfy converts this boundary into a lockout.
        and f.factor_type = 'totp'
    )
  end;
$$;

comment on function private.mfa_satisfied() is
  'RLS predicate: caller is aal2, or has no verified TOTP factor to prove. '
  'security definer because authenticated cannot read auth.mfa_factors. '
  'Scoped to TOTP because that is the only factor type this client can challenge.';

create or replace function public.rotate_calendar_feed_token()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  plain text;
begin
  -- Assurance term added: this mints a long-lived bearer capability, so it must
  -- not be reachable by a session that has not cleared MFA.
  if caller is null or not private.mfa_satisfied() then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  plain := pg_catalog.encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.member_calendar_feed_tokens (user_id, token_hash, rotated_at)
  values (caller, private.calendar_feed_token_hash(plain), now())
  on conflict (user_id) do update set token_hash = excluded.token_hash, rotated_at = now();
  return pg_catalog.jsonb_build_object('token', plain);
end;
$$;

create or replace function public.upsert_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  -- Assurance term added: redirecting a member's notification stream to a
  -- caller-controlled endpoint is disclosure, not a write.
  if caller is null or not private.mfa_satisfied() then
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
