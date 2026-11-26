-- BUG-UG-RECOVERY-CLAIM-LEASED-MATCH-BUSY-OUTCOME-20261022
-- A recovery-code claim that matches a code under a live claim lease answers
-- busy instead of counting a failed attempt. A claim
-- can time out while its transaction is still in flight; an immediate retry of
-- the same, correct code then found it leased, excluded it, and counted a wrong
-- code toward the recovery lockout. The function now checks for a live lease
-- on the submitted code's prefix inside its existing locked transaction,
-- without a second hash under those locks, and returns accepted false,
-- busy true and retryAfterSeconds (the seconds left on the lease). A caller
-- that does not read `busy` still sees accepted false, so the API may deploy
-- before or after this migration.
-- Every other statement, the signature and the grants are unchanged from
-- 20261003058000.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.claim_mfa_recovery_code(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);

declare
  caller uuid := (select auth.uid());
  current_session uuid;
  current_handle text;
  clean text := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  prefix text;
  set_row public.mfa_recovery_code_sets%rowtype;
  code_row public.mfa_recovery_codes%rowtype;
  claim_token text;
  recovery_limit integer;
  recovery_lock_minutes integer;
  lease_seconds integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();
  -- Pin the proven Auth row through claim commit. If external revocation won
  -- the race after JWT verification, this lookup observes no row and refuses.
  perform 1
  from auth.sessions s
  where s.id = current_session
    and s.user_id = caller
  for key share;
  if not found then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  current_handle := private.member_session_handle(current_session);
  recovery_limit := private.organization_limit(private.current_member_organization(), 'limits.security.mfa_recovery_failures');
  recovery_lock_minutes := private.organization_limit(private.current_member_organization(), 'limits.security.mfa_recovery_lock_minutes');

  if clean !~ '^UG[A-F0-9]{16}$' then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;
  select * into set_row
  from public.mfa_recovery_code_sets
  where user_id = caller
  for update;
  if not found
     or (set_row.locked_until is not null and set_row.locked_until > pg_catalog.now()) then
    raise exception 'recovery code not accepted' using errcode = '22023';
  end if;

  prefix := pg_catalog.substr(clean, 3, 8);
  select * into code_row
  from public.mfa_recovery_codes
  where user_id = caller
    and generation = set_row.generation
    and code_prefix = prefix
    and used_at is null
    and (claim_expires_at is null or claim_expires_at <= pg_catalog.now())
  for update;
  if not found or extensions.crypt(clean, code_row.code_hash) <> code_row.code_hash then
    -- The submitted code may be correct but under a live claim lease: a retry
    -- whose earlier claim committed after the retry's lease read. That is busy,
    -- not a wrong code: no failed attempt, no new lease, a retryable answer.
    -- The match is on the code's prefix only. A bcrypt here would hold the
    -- exclusive (509, 700) and (509, 701) locks through a hash on a path that
    -- counts nothing; a wrong suffix on a leased prefix
    -- only waits out the lease, accepts nothing and learns nothing, and the
    -- hashed comparison above still counts every attempt once the lease ends.
    select greatest(1, pg_catalog.ceil(extract(epoch from leased.claim_expires_at - pg_catalog.now())))::integer
    into lease_seconds
    from public.mfa_recovery_codes leased
    where leased.user_id = caller
      and leased.generation = set_row.generation
      and leased.code_prefix = prefix
      and leased.used_at is null
      and leased.claim_expires_at > pg_catalog.now()
    limit 1;
    if lease_seconds is not null then
      return pg_catalog.jsonb_build_object('accepted', false, 'busy', true, 'retryAfterSeconds', lease_seconds);
    end if;
    update public.mfa_recovery_code_sets
    set failed_attempts = case when failed_attempts >= recovery_limit - 1 then 0 else failed_attempts + 1 end,
        locked_until = case
          when failed_attempts >= recovery_limit - 1 then pg_catalog.now() + pg_catalog.make_interval(mins => recovery_lock_minutes)
          else null
        end
    where user_id = caller;
    return pg_catalog.jsonb_build_object('accepted', false);
  end if;

  claim_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  update public.mfa_recovery_codes
  set claimed_at = pg_catalog.now(),
      claim_expires_at = pg_catalog.now() + interval '2 minutes',
      claim_token_hash = pg_catalog.encode(
        extensions.digest(claim_token, 'sha256'), 'hex'),
      claim_session_handle = current_handle
  where id = code_row.id;
  update public.mfa_recovery_code_sets
  set failed_attempts = 0,
      locked_until = null
  where user_id = caller;

  return pg_catalog.jsonb_build_object(
    'claimToken', claim_token,
    'userId', caller,
    'sessionHandle', current_handle,
    'expiresIn', 120);
end;
end;
$function$;

commit;
