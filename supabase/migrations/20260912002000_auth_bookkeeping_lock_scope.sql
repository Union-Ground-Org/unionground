-- BUG-UG-AUTH-BOOKKEEPING-CASE-GRAPH-LOCK-20260908
--
-- Advisory key (509, 701) is the "auth bookkeeping" lock. Every exempt GoTrue
-- bookkeeping statement takes it shared before the executor can lock an Auth
-- tuple. Every gated Auth transaction takes the case-graph gate and then this
-- lock exclusively before its first Auth tuple: auth.users uses its a00
-- statement trigger, while reviewed session lockers/writers use their wrapper
-- preamble. auth.oauth_clients deletion is not itself a graph write, but its
-- ON DELETE CASCADE reaches auth.oauth_authorizations and auth.oauth_consents,
-- which keep a00_case_graph_lock, as well as auth.sessions. It therefore takes
-- the graph gate in its own a00_case_graph_lock statement trigger and only then
-- the exclusive lock in a01, in the same order as every other gated Auth
-- transaction. The reverse order would let a deleter own (509, 701) while
-- waiting for the gate a covered auth.users statement already holds, which is
-- exactly the cycle this migration removes elsewhere.
--
-- An exempt transaction waiting on gated Auth work is still at its shared-lock
-- request and owns no Auth tuple. Gated Auth work waiting on exempt work is
-- still at its exclusive-lock request and owns no Auth tuple. Later shared
-- requests queue behind a waiting exclusive request, so gated Auth work is not
-- starved. Gate-only work never takes (509, 701), removing the sign-in stall;
-- the existing gate retains G-vs-G ordering.
--
-- Residuals: exempt-vs-exempt tuple cycles remain stock Supabase behavior and
-- deadlock detection aborts one request. Exempt work followed by covered
-- auth.users work upgrades shared to exclusive; two upgraders can deadlock and
-- one gets 40P01, but reviewed sign-in, magic-link, refresh, and sign-out do not
-- have that shape. During ON DELETE CASCADE the backend already owns exclusive
-- (509, 701), so child statement triggers reacquire shared immediately.
--
-- public.revoke_my_session(text) is source-pinned by the wrapper registry. Its
-- current installed wrapper is reproduced with exactly one acquisition line
-- added after the gate preamble, then re-enrolled from the installed catalogue.
-- The other two reviewed session lockers receive the same preserved change.
-- The catalogue also truthfully refreshes the already wrapped
-- validate_public_chapter_page_attachment() source, whose pre-wrapper review
-- hash would otherwise keep the full referential-action check nonzero.

begin;

create function private.lock_auth_bookkeeping_shared()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(509, 701);
  return null;
end;
$function$;
revoke all on function private.lock_auth_bookkeeping_shared() from public, anon, authenticated, service_role;

create function private.lock_auth_bookkeeping_exclusive()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  return null;
end;
$function$;
revoke all on function private.lock_auth_bookkeeping_exclusive() from public, anon, authenticated, service_role;

create function private.lock_case_graph_statement_auth()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  return null;
end;
$function$;
revoke all on function private.lock_case_graph_statement_auth() from public, anon, authenticated, service_role;

drop trigger if exists a00_case_graph_lock on auth.users;
create trigger a00_case_graph_lock
before insert or delete or update of
  id, instance_id, aud, role, email, phone, deleted_at, banned_until,
  is_sso_user, is_anonymous, raw_user_meta_data, email_change, phone_change
on auth.users
for each statement execute function private.lock_case_graph_statement_auth();

drop trigger if exists z99_case_graph_keys on auth.users;
create trigger z99_case_graph_keys
before insert or delete or update of
  id, instance_id, aud, role, email, phone, deleted_at, banned_until,
  is_sso_user, is_anonymous, raw_user_meta_data, email_change, phone_change
on auth.users
for each row execute function private.lock_case_graph_row_keys('id', '');

drop trigger if exists message_lifecycle_statement on auth.users;
create trigger message_lifecycle_statement
before insert or delete or update of
  id, instance_id, aud, role, email, phone, deleted_at, banned_until,
  is_sso_user, is_anonymous, raw_user_meta_data, email_change, phone_change
on auth.users
for each statement execute function private.lock_message_lifecycle_statement();

drop trigger if exists a00_case_graph_lock on auth.sessions;
drop trigger if exists z99_case_graph_keys on auth.sessions;
drop trigger if exists z98_auth_root_identity_key_share on auth.sessions;
drop trigger if exists a00_case_graph_lock on auth.refresh_tokens;
drop trigger if exists z99_case_graph_keys on auth.refresh_tokens;
drop trigger if exists z98_auth_root_identity_key_share on auth.refresh_tokens;
drop trigger if exists a00_case_graph_lock on auth.one_time_tokens;
drop trigger if exists z99_case_graph_keys on auth.one_time_tokens;
drop trigger if exists z98_auth_root_identity_key_share on auth.one_time_tokens;
drop trigger if exists a00_case_graph_lock on auth.mfa_amr_claims;
drop trigger if exists z99_case_graph_keys on auth.mfa_amr_claims;
drop trigger if exists z98_auth_root_identity_key_share on auth.mfa_amr_claims;
drop trigger if exists a00_case_graph_lock on auth.mfa_challenges;
drop trigger if exists z99_case_graph_keys on auth.mfa_challenges;
drop trigger if exists a00_case_graph_lock on auth.identities;
drop trigger if exists z99_case_graph_keys on auth.identities;
drop function if exists private.lock_auth_root_identity();

create trigger a01_auth_bookkeeping_shared before insert or update or delete on auth.users
for each statement execute function private.lock_auth_bookkeeping_shared();
create trigger a01_auth_bookkeeping_shared before insert or update or delete on auth.sessions
for each statement execute function private.lock_auth_bookkeeping_shared();
create trigger a01_auth_bookkeeping_shared before insert or update or delete on auth.refresh_tokens
for each statement execute function private.lock_auth_bookkeeping_shared();
create trigger a01_auth_bookkeeping_shared before insert or update or delete on auth.one_time_tokens
for each statement execute function private.lock_auth_bookkeeping_shared();
create trigger a01_auth_bookkeeping_shared before insert or update or delete on auth.mfa_amr_claims
for each statement execute function private.lock_auth_bookkeeping_shared();
create trigger a01_auth_bookkeeping_shared before insert or update or delete on auth.mfa_challenges
for each statement execute function private.lock_auth_bookkeeping_shared();
create trigger a01_auth_bookkeeping_shared before insert or update or delete on auth.identities
for each statement execute function private.lock_auth_bookkeeping_shared();

-- a00 sorts before a01, so the graph gate is always acquired before the
-- exclusive bookkeeping lock on this relation too. Only DELETE is covered:
-- inserts and updates of an OAuth client cascade nowhere and take neither lock.
drop trigger if exists a00_case_graph_lock on auth.oauth_clients;
create trigger a00_case_graph_lock before delete on auth.oauth_clients
for each statement execute function private.lock_case_graph_statement();

create trigger a01_auth_bookkeeping_exclusive before delete on auth.oauth_clients
for each statement execute function private.lock_auth_bookkeeping_exclusive();

create or replace function public.claim_mfa_recovery_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
    update public.mfa_recovery_code_sets
    set failed_attempts = case when failed_attempts >= 4 then 0 else failed_attempts + 1 end,
        locked_until = case
          when failed_attempts >= 4 then pg_catalog.now() + interval '15 minutes'
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
revoke all on function public.claim_mfa_recovery_code(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_mfa_recovery_code(text)
  to authenticated;

create or replace function public.prepare_mfa_recovery_signout(p_user_id uuid, p_session_handle text, p_claim_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);

declare
  clean_session_handle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_session_handle, '')));
  clean_claim_token text := pg_catalog.btrim(coalesce(p_claim_token, ''));
  recovery_code_id uuid;
  web_push_removed integer := 0;
  native_push_removed integer := 0;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_user_id is null
     or clean_session_handle !~ '^[0-9a-f]{64}$'
     or clean_claim_token !~ '^[0-9a-f]{64}$' then
    raise exception 'recovery claim unavailable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || p_user_id::text));

  select c.id into recovery_code_id
  from public.mfa_recovery_codes c
  where c.user_id = p_user_id
    and c.used_at is null
    and c.claim_expires_at > pg_catalog.now()
    and c.claim_session_handle = clean_session_handle
    and c.claim_token_hash = pg_catalog.encode(
      extensions.digest(clean_claim_token, 'sha256'), 'hex')
  for update;
  if recovery_code_id is null then
    raise exception 'recovery claim unavailable' using errcode = '42501';
  end if;

  -- Re-prove and pin the exact Auth session that claimed the code. A JWT may
  -- remain cryptographically valid after its session row is revoked; no
  -- service-role factor or push mutation may begin from that stale bearer.
  perform 1
  from auth.sessions s
  where s.user_id = p_user_id
    and private.member_session_handle(s.id) = clean_session_handle
  for key share;
  if not found then
    raise exception 'recovery claim unavailable' using errcode = '42501';
  end if;

  insert into private.member_mfa_recovery_locks
    (user_id, claim_token_hash, locked_at)
  values (
    p_user_id,
    pg_catalog.encode(extensions.digest(clean_claim_token, 'sha256'), 'hex'),
    pg_catalog.clock_timestamp()
  )
  on conflict (user_id) do update
    set claim_token_hash = excluded.claim_token_hash,
        locked_at = excluded.locked_at;

  -- One live global barrier makes registration fail closed for every current
  -- or newly created session until GoTrue removes the source sessions. A later
  -- clean sign-in lazily retires barriers whose Auth sessions are gone.
  insert into private.member_session_closing_barriers
    (user_id, session_handle, scope)
  select p_user_id, private.member_session_handle(s.id), 'global'
  from auth.sessions s
  where s.user_id = p_user_id
  on conflict (user_id, session_handle) do update
    set scope = 'global',
        closed_at = pg_catalog.now();

  delete from public.member_push_subscriptions
  where user_id = p_user_id;
  get diagnostics web_push_removed = row_count;
  delete from public.member_native_push_installations
  where user_id = p_user_id;
  get diagnostics native_push_removed = row_count;

  return pg_catalog.jsonb_build_object(
    'scope', 'global',
    'pushSubscriptionsRemoved', web_push_removed + native_push_removed,
    'nativePushInstallationsRemoved', native_push_removed,
    'serverCleanupComplete', true);
end;
end;
$function$;
revoke all on function public.prepare_mfa_recovery_signout(uuid,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_mfa_recovery_signout(uuid,text,text)
  to service_role;

create or replace function public.revoke_my_session(p_session_handle text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);

declare
  caller uuid := (select auth.uid());
  current_session uuid;
  target_session uuid;
  clean_handle text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_session_handle, '')));
  web_push_removed integer := 0;
  native_push_removed integer := 0;
  push_removed integer := 0;
  session_removed integer := 0;
  prior private.member_session_revocations%rowtype;
begin
  if caller is null or not private.mfa_satisfied() then
    raise exception 'member session required' using errcode = '42501';
  end if;
  if clean_handle = '' or p_session_handle !~ '^[0-9a-f]{64}$' then
    raise exception 'session unavailable' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member-sessions:' || caller::text));
  current_session := private.current_member_session_id();

  select * into prior
  from private.member_session_revocations r
  where r.user_id = caller
    and r.session_handle = clean_handle;
  if prior.user_id is not null then
    return pg_catalog.jsonb_build_object(
      'revoked', true,
      'alreadyRevoked', true,
      'pushSubscriptionsRemoved', prior.push_rows_removed);
  end if;

  select s.id into target_session
  from auth.sessions s
  where s.user_id = caller
    and private.member_session_handle(s.id) = clean_handle
  for update;

  if target_session is null then
    raise exception 'session unavailable' using errcode = '22023';
  end if;
  if target_session::text = current_session::text then
    raise exception 'cannot revoke the current session' using errcode = '22023';
  end if;

  delete from public.member_push_subscriptions
  where user_id = caller
    and (session_handle = clean_handle or session_handle is null);
  get diagnostics web_push_removed = row_count;

  delete from public.member_native_push_installations
  where user_id = caller
    and session_handle = clean_handle;
  get diagnostics native_push_removed = row_count;
  push_removed := web_push_removed + native_push_removed;

  delete from auth.sessions
  where id = target_session
    and user_id = caller;
  get diagnostics session_removed = row_count;
  if session_removed <> 1 then
    raise exception 'session unavailable' using errcode = '22023';
  end if;

  insert into private.member_session_revocations
    (user_id, session_handle, push_rows_removed)
  values
    (caller, clean_handle, push_removed);

  return pg_catalog.jsonb_build_object(
    'revoked', true,
    'alreadyRevoked', false,
    'pushSubscriptionsRemoved', push_removed,
    'nativePushInstallationsRemoved', native_push_removed);
end;
end;
$function$;
revoke all on function public.revoke_my_session(text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_my_session(text)
  to authenticated;

create or replace function public.presg_demo_prepare_reapply(
  p_run_id uuid,
  p_password text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);

declare
  run private.presg_demo_runs%rowtype;
  password_hash text;
  refreshed_logins bigint;
begin
  perform private.presg_demo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.presg_demo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown presg demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot be prepared in state %', run.state;
  end if;
  if pg_catalog.char_length(coalesce(p_password, '')) < 24 then
    raise exception 'demo password is too short';
  end if;

  password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  update private.presg_demo_runs
  set protected_snapshot = private.presg_demo_protected_snapshot(p_run_id),
      updated_at = pg_catalog.now()
  where id = p_run_id;

  update auth.users users
  set encrypted_password = password_hash,
      updated_at = pg_catalog.now()
  from private.presg_demo_ledger ledger
  where ledger.run_id = p_run_id
    and ledger.login_capable
    and users.id = ledger.user_id
    and users.raw_app_meta_data ->> 'presg_demo_run_id' = p_run_id::text;
  get diagnostics refreshed_logins = row_count;

  return pg_catalog.jsonb_build_object(
    'runId', p_run_id,
    'protectedSnapshotRefreshed', true,
    'loginPasswordsRefreshed', refreshed_logins
  );
end;
end;
$function$;

create or replace function public.uniondemo_prepare_reapply(
  p_run_id uuid,
  p_password text,
  p_target_ref text,
  p_confirm_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '120s'
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);

declare
  run private.uniondemo_runs%rowtype;
  password_hash text;
  refreshed_logins bigint;
begin
  perform private.uniondemo_authorize(p_target_ref, p_confirm_token);
  select * into run from private.uniondemo_runs where id = p_run_id for update;
  if not found then raise exception 'unknown union demo run'; end if;
  if run.state not in ('ledgered', 'applying', 'applied', 'verified') then
    raise exception 'run cannot be prepared in state %', run.state;
  end if;
  if pg_catalog.char_length(coalesce(p_password, '')) < 24 then
    raise exception 'demo password is too short';
  end if;

  password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  update private.uniondemo_runs
  set protected_snapshot = private.uniondemo_protected_snapshot(p_run_id),
      updated_at = pg_catalog.now()
  where id = p_run_id;

  update auth.users users
  set encrypted_password = password_hash,
      updated_at = pg_catalog.now()
  from private.uniondemo_ledger ledger
  where ledger.run_id = p_run_id
    and ledger.login_capable
    and users.id = ledger.user_id
    and users.raw_app_meta_data ->> 'uniondemo_run_id' = p_run_id::text;
  get diagnostics refreshed_logins = row_count;

  return pg_catalog.jsonb_build_object(
    'runId', p_run_id,
    'protectedSnapshotRefreshed', true,
    'loginPasswordsRefreshed', refreshed_logins
  );
end;
end;
$function$;

delete from private.account_lifecycle_trigger_review
where (kind = 'trigger' and schema_name = 'auth' and (
    (table_name in ('sessions','refresh_tokens','one_time_tokens','mfa_amr_claims','mfa_challenges','identities')
      and object_name in ('a00_case_graph_lock','z99_case_graph_keys','z98_auth_root_identity_key_share','a01_auth_bookkeeping_shared'))
    or (table_name = 'users' and object_name in ('a00_case_graph_lock','z99_case_graph_keys','message_lifecycle_statement','a01_auth_bookkeeping_shared'))
    or (table_name = 'oauth_clients' and object_name in ('a00_case_graph_lock','a01_auth_bookkeeping_exclusive'))
  )) or (kind = 'function' and table_name = '' and (
    (schema_name = 'private' and object_name in ('lock_auth_root_identity()','lock_auth_bookkeeping_shared()','lock_auth_bookkeeping_exclusive()','lock_case_graph_statement_auth()'))
    or (schema_name = 'public' and object_name in ('claim_mfa_recovery_code(p_code text)',
      'prepare_mfa_recovery_signout(p_user_id uuid, p_session_handle text, p_claim_token text)',
      'revoke_my_session(p_session_handle text)',
      'presg_demo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text)',
      'uniondemo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text)',
      'validate_public_chapter_page_attachment()'))
  ));

insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where (kind = 'trigger' and schema_name = 'auth' and (
    (table_name in ('sessions','refresh_tokens','one_time_tokens','mfa_amr_claims','mfa_challenges','identities')
      and object_name = 'a01_auth_bookkeeping_shared')
    or (table_name = 'users' and object_name in ('a00_case_graph_lock','z99_case_graph_keys','message_lifecycle_statement','a01_auth_bookkeeping_shared'))
    or (table_name = 'oauth_clients' and object_name in ('a00_case_graph_lock','a01_auth_bookkeeping_exclusive'))
  )) or (kind = 'function' and table_name = '' and (
    (schema_name = 'private' and object_name in ('lock_auth_bookkeeping_shared()','lock_auth_bookkeeping_exclusive()','lock_case_graph_statement_auth()'))
    or (schema_name = 'public' and object_name in ('claim_mfa_recovery_code(p_code text)',
      'prepare_mfa_recovery_signout(p_user_id uuid, p_session_handle text, p_claim_token text)',
      'revoke_my_session(p_session_handle text)',
      'presg_demo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text)',
      'uniondemo_prepare_reapply(p_run_id uuid, p_password text, p_target_ref text, p_confirm_token text)',
      'validate_public_chapter_page_attachment()'))
  ));

commit;
