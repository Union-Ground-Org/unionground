begin;

-- BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016.
--
-- On October 16, 2026 a Production member with no two-step sign-in could not
-- delete their account: authorize_member_account_deletion demanded an aal2
-- session with a TOTP or WebAuthn claim under ten minutes old, which such a
-- member can never have, and the route answered "sign out and sign in again",
-- which does not help. App Store guideline 5.1.1(v) expects deletion to be
-- completable in the app.
--
-- This replaces only the step-up block. A member with a verified TOTP factor
-- keeps the aal2 rule unchanged. A member with none (a verified phone or
-- WebAuthn factor counts as none: the app can challenge only TOTP, and
-- private.mfa_satisfied() is TOTP-scoped for the same reason) is served by a password
-- (or provider) sign-in on the calling session under ten minutes old, or by
-- the existing verified-passkey session; api/account-lifecycle.js mints a
-- fresh password session when the member re-enters their password in the
-- deletion dialog. Every other line of the function is the 20261002135500
-- body. Grants are unchanged (create or replace keeps them).

create or replace function public.authorize_member_account_deletion(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  session_id_text text := (select auth.jwt() ->> 'session_id');
  subject text;
  key_fingerprint text;
  key_snapshot bytea;
  installed_source_md5 text;
  installed_contract_valid boolean;
  plain_token text;
  request_id uuid;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_confirmation <> 'DELETE MY ACCOUNT' then
    raise exception 'confirmation required' using errcode = '42501';
  end if;
  if session_id_text is null or session_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'recent second-factor verification required' using errcode = '42501';
  end if;
  if exists (
    select 1 from auth.mfa_factors factor
     where factor.user_id = caller and factor.status = 'verified'
       and factor.factor_type = 'totp'
  ) then
    -- A member with a TOTP factor keeps the existing rule: an aal2 session
    -- whose TOTP or WebAuthn step-up (or verified passkey) is under ten
    -- minutes old.
    if (select auth.jwt() ->> 'aal') is distinct from 'aal2' or not private.mfa_satisfied() then
      raise exception 'recent second-factor verification required' using errcode = '42501';
    end if;
    if not exists (
      select 1
      from auth.sessions s
      join auth.mfa_amr_claims amr on amr.session_id = s.id
      where s.id = session_id_text::uuid
        and s.user_id = caller
        and s.aal = 'aal2'
        and amr.authentication_method in ('totp', 'webauthn')
        and greatest(amr.created_at, amr.updated_at) >= now() - interval '10 minutes'
    ) and not private.recent_verified_key_session(caller,session_id_text::uuid) then
      raise exception 'recent second-factor verification required' using errcode = '42501';
    end if;
  else
    -- BUG-UG-ACCOUNT-DELETION-REQUIRES-TWO-STEP-20261016: a member
    -- with no TOTP factor could never reach aal2 in this app, so deletion was
    -- impossible for them. Their step-up is a password, provider (OAuth or
    -- SAML SSO) or passkey sign-in on this session under ten minutes old;
    -- api/account-lifecycle.js mints a password one when the member re-enters
    -- their password. Everything the factor rule accepts is accepted here
    -- too. PIN and other code sessions (otp/magiclink/sms) stay refused, as
    -- -3 requires.
    if not private.mfa_satisfied() or (not exists (
      select 1
      from auth.sessions s
      join auth.mfa_amr_claims amr on amr.session_id = s.id
      where s.id = session_id_text::uuid
        and s.user_id = caller
        and (amr.authentication_method in ('password', 'oauth', 'passkey', 'sso/saml')
          or (s.aal = 'aal2' and amr.authentication_method in ('totp', 'webauthn')))
        and greatest(amr.created_at, amr.updated_at) >= now() - interval '10 minutes'
    ) and not private.recent_verified_key_session(caller,session_id_text::uuid)) then
      raise exception 'recent sign-in verification required' using errcode = '42501';
    end if;
  end if;

  select secret.secret, pg_catalog.encode(extensions.digest(secret.secret, 'sha256'), 'hex')
    into key_snapshot, key_fingerprint
    from private.member_account_lifecycle_secret secret
   where secret.id
     and pg_catalog.length(secret.secret) = 32;
  if key_fingerprint is null then
    raise exception 'account lifecycle subject-hash secret unavailable or invalid' using errcode = '55000';
  end if;
  select pg_catalog.md5(p.prosrc),
         p.prosecdef
           and p.provolatile = 's'
           and p.proconfig @> array['search_path=""']::text[]
    into installed_source_md5, installed_contract_valid
    from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure('private.member_lifecycle_subject_hash(uuid)');
  if installed_source_md5 is distinct from '331e256ef56ee61c13fd1b4e82ae0b1b'
     or installed_contract_valid is distinct from true then
    raise exception 'account lifecycle subject-hash contract unavailable or changed' using errcode = '55000';
  end if;
  -- Both values use this call's immutable key, even if an operator rotates it.
  subject := pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(caller::text, 'UTF8'), key_snapshot, 'sha256'), 'hex');
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('member-account-delete:' || caller::text, 509));
  update private.member_account_deletions
     set status = 'failed', finalized_at = now(), failure_code = case
       when status = 'authorized' then 'authorization-expired' else 'processing-timeout' end
   where subject_hash = subject
     and auth_deleted_at is null
     and ((status = 'authorized' and expires_at <= now())
       or (status = 'processing' and claimed_at < now() - interval '10 minutes'));
  if exists (select 1 from private.member_account_deletions
             where subject_hash = subject and status in ('authorized', 'processing')) then
    raise exception 'deletion already in progress' using errcode = '55000';
  end if;

  plain_token := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.member_account_deletions (
    subject_hash, subject_hash_key_fingerprint, token_hash, status, expires_at)
  values (subject, key_fingerprint,
          pg_catalog.encode(extensions.digest(plain_token, 'sha256'), 'hex'),
          'authorized', now() + interval '5 minutes')
  returning id into request_id;
  insert into private.member_account_lifecycle_audit (subject_hash, event_type)
  values (subject, 'deletion_authorized');

  return pg_catalog.jsonb_build_object(
    'requestId', request_id,
    'deletionToken', plain_token,
    'userId', caller,
    'expiresInSeconds', 300);
end;
end;
$$;


commit;
