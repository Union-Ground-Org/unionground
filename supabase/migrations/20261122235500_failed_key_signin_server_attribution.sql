-- SEC-UG-FAILED-KEY-SIGNIN-RECORDS-CAN-BE-FORGED-20261122 (#9558)
--
-- api/auth-passkey-signin.js recorded a refused passkey sign-in against the
-- member its userHandle named (caller data), with no limit. This service-role
-- step now comes first: it charges the caller's network bucket before any key
-- is read, names the member only as the owner of the registered credential id
-- in auth.webauthn_credentials (written only by Supabase Auth; a handle naming
-- anyone else attributes nothing), then charges that member's bucket. It
-- returns {subject, email} for record_failed_login_attempt, or null.
--
-- The buckets limit RECORDING only and are separate from the password route's
-- scopes: the sign-in already went to Auth, and no refused key attempt can
-- keep anyone from signing in. The route's reply is the same flat failure.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function public.resolve_failed_passkey_attempt(
  p_credential_id text,
  p_user_handle uuid,
  p_network text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  network text := coalesce(p_network, '');
  encoded text := coalesce(p_credential_id, '');
  raw_id bytea;
  owner_id uuid;
  owner_email text;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if network !~ '^(ipv4:[0-9]{1,3}(\.[0-9]{1,3}){3}|ipv6:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::/64|unknown)$' then
    raise exception 'invalid key sign-in failure' using errcode = '22023';
  end if;
  -- The network bucket is charged before anything about the key is read.
  if not private.auth_attempt_check('passkey-failure-network', network,
      private.organization_limit(null, 'limits.security.signin_attempts_per_ip_hour'),
      interval '1 hour') then
    return null;
  end if;
  -- A WebAuthn credential id is base64url without padding. A length of 1 mod 4
  -- is not valid base64url, so it is refused here rather than by decode().
  if pg_catalog.char_length(encoded) not between 16 and 1366
     or pg_catalog.char_length(encoded) % 4 = 1
     or encoded !~ '^[A-Za-z0-9_-]+$' then
    return null;
  end if;
  raw_id := pg_catalog.decode(
    pg_catalog.translate(encoded, '-_', '+/')
      || pg_catalog.repeat('=', (4 - pg_catalog.char_length(encoded) % 4) % 4),
    'base64');
  select c.user_id into owner_id
  from auth.webauthn_credentials c
  where c.credential_id = raw_id;
  if owner_id is null then
    return null;
  end if;
  if p_user_handle is not null and p_user_handle <> owner_id then
    return null;
  end if;
  select pg_catalog.lower(pg_catalog.btrim(u.email)) into owner_email
  from auth.users u
  where u.id = owner_id;
  if coalesce(owner_email, '') = '' then
    return null;
  end if;
  if not private.auth_attempt_check('passkey-failure-account', owner_id::text,
      private.organization_limit(null, 'limits.security.signin_attempts_per_email_hour'),
      interval '1 hour') then
    return null;
  end if;
  return pg_catalog.jsonb_build_object('subject', owner_id, 'email', owner_email);
end;
$function$;

revoke all on function public.resolve_failed_passkey_attempt(text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_failed_passkey_attempt(text, uuid, text) to service_role;

comment on function public.resolve_failed_passkey_attempt(text, uuid, text) is
  'SEC-UG-FAILED-KEY-SIGNIN-RECORDS-CAN-BE-FORGED-20261122: service-role step before api/auth-passkey-signin.js records a refused key sign-in. Charges the network bucket (passkey-failure-network), resolves the member only as the owner of the registered credential id in auth.webauthn_credentials (a userHandle naming anyone else attributes nothing), then charges that member''s bucket (passkey-failure-account); returns {subject, email} or null. Limits recording only, never sign-in.';

commit;
