-- SEC-UG-INVITE-REQUEST-RATE-LIMIT-20261114
--
-- The public "request an invite" form (api/invite-request.js) emails the
-- team's support mailbox and had no rate limit, so anyone could flood that
-- mailbox through the server's own mail provider. This adds a service-role-only
-- limiter on the generic HMAC-keyed fixed-window throttle that the password
-- sign-in and self-service password reset already use
-- (private.auth_attempt_check, 20261002015000):
--
--   network  10 requests per hour per network bucket (IPv4 address or IPv6 /64)
--   email     3 requests per day per normalized requester address
--
-- The throttle stores only an HMAC of scope and key under a database-local
-- key, never the address itself. The function refuses any caller that is not
-- the service role and any key outside the shapes the API sends.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function public.consume_invite_request_attempt(p_scope text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_key text := coalesce(p_key, '');
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_scope = 'network' then
    if v_key !~ '^(ipv4:[0-9]{1,3}(\.[0-9]{1,3}){3}|ipv6:[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::/64|unknown)$' then
      raise exception 'invalid invite request attempt' using errcode = '22023';
    end if;
    return private.auth_attempt_check('invite-request-network', v_key, 10, interval '1 hour');
  elsif p_scope = 'email' then
    v_key := pg_catalog.lower(pg_catalog.btrim(v_key));
    if pg_catalog.char_length(v_key) not between 3 and 254 or v_key !~ '^[^[:space:]@]+@[^[:space:]@]+$' then
      raise exception 'invalid invite request attempt' using errcode = '22023';
    end if;
    return private.auth_attempt_check('invite-request-email', v_key, 3, interval '1 day');
  end if;
  raise exception 'invalid invite request attempt' using errcode = '22023';
end;
$function$;

revoke all on function public.consume_invite_request_attempt(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_invite_request_attempt(text, text) to service_role;

comment on function public.consume_invite_request_attempt(text, text) is
  'Service-role-only limiter for /api/invite-request: 10 per hour per network bucket, 3 per day per requester address, on private.auth_attempt_check.';

notify pgrst, 'reload schema';

commit;
