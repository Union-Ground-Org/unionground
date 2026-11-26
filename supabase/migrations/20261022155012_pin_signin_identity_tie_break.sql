-- BUG-UG-PIN-FAILURE-IDENTITY-TIMESTAMP-TIE-20261021
-- PIN verification picks the live account for an email by created_at alone;
-- PIN failure attribution (private.lock_lifecycle_telemetry, 20261021020656)
-- picks by created_at, id. Two live accounts sharing an email with identical
-- creation times could therefore be verified as one person and logged against
-- another person's organization. This
-- replaces only public.verify_member_pin_signin, adding the same id tie-break.
-- The signature, the function settings, the grants and every other statement
-- are unchanged from 20261003040000.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.verify_member_pin_signin(p_email text, p_pin text, p_network text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
set lock_timeout = '3s'
as $function$
declare
  normalized_email text;
  subject uuid;
  canonical_email text;
  stored_hash text;
  open_attempt boolean;
  reason text;
  matched boolean;
  max_attempts integer;
  lock_minutes integer;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  normalized_email := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  if pg_catalog.char_length(normalized_email) not between 3 and 254
    or coalesce(pg_catalog.char_length(p_pin), 0) not between 1 and 64 then
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', false);
  end if;

  -- Throttles first, before any account lookup, so they apply identically to
  -- real and unknown addresses. private.auth_attempt_check (#3747) stores only
  -- an HMAC of scope and key, so no raw address or email is kept. The network
  -- bucket is charged first, as in public.consume_password_signin_attempt: a
  -- network already over its budget does not also spend the address's budget.
  if not private.auth_attempt_check('member-pin-network',
      coalesce(nullif(p_network, ''), 'unknown'), 20, interval '1 hour')
    or not private.auth_attempt_check('member-pin-email',
      normalized_email, 10, interval '1 hour') then
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', false);
  end if;

  select u.id, pg_catalog.lower(u.email) into subject, canonical_email
  from auth.users u
  where pg_catalog.lower(u.email) = normalized_email and u.deleted_at is null
  -- Same deterministic choice as PIN failure attribution
  -- (private.lock_lifecycle_telemetry orders by created_at, id), so tied
  -- creation times cannot verify one account and log another.
  order by u.created_at, u.id
  limit 1;
  if subject is not null then
    select c.pin_hash into stored_hash from private.member_pin_credentials c where c.user_id = subject;
  end if;
  if stored_hash is null then
    perform extensions.crypt(p_pin, extensions.gen_salt('bf', 12));
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', true);
  end if;

  open_attempt := private.member_pin_attempt_open(subject);
  reason := private.member_pin_ineligibility(subject);
  if not open_attempt or reason is not null then
    perform extensions.crypt(p_pin, extensions.gen_salt('bf', 12));
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', true);
  end if;

  matched := extensions.crypt(p_pin, stored_hash) = stored_hash;
  select policy.attempts, policy.minutes into max_attempts, lock_minutes
  from private.member_pin_lockout_policy(subject) policy;
  perform private.member_pin_attempt_close(subject, matched, max_attempts, lock_minutes);
  if not matched then
    return pg_catalog.jsonb_build_object('ok', false, 'recordFailure', true);
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'userId', subject, 'email', canonical_email);
end;
$function$;

commit;
