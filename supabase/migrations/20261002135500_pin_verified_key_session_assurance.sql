-- Owner decisions, October 1, 2026, 10:49:08 PM ET and about 11:04 PM ET:
-- a PIN-verified security key satisfies MFA for all accounts, staff included.
-- Owner scope decision, October 2, 2026, about 1:34 AM ET: non-backup only.
-- UP+UV and BE=0/BS=0; includes device-bound phone keys, not proof of PIN.
-- Source only. Hosted hook configuration is a separate owner-approved rollout.
begin;

create table private.verified_key_sessions (
  -- Deliberately no session FK: GoTrue session cleanup holds the shared Auth
  -- bookkeeping lock. A cascade into this graph-gated table would invert
  -- graph-before-Auth ordering. Every use independently joins the live session.
  session_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_sha256 text not null unique check (challenge_sha256 ~ '^[0-9a-f]{64}$'),
  assertion_sha256 text not null unique check (assertion_sha256 ~ '^[0-9a-f]{64}$'),
  backup_eligible boolean not null,
  backed_up boolean not null,
  check (not backed_up or backup_eligible),
  verified_at timestamptz not null default pg_catalog.now()
);
create trigger a00_case_graph_lock before insert or update or delete on private.verified_key_sessions
for each statement execute function private.lock_case_graph_statement();
create trigger z99_case_graph_keys before insert or update or delete on private.verified_key_sessions
for each row execute function private.lock_case_graph_row_keys('{user_id}', '');
insert into private.account_lifecycle_manifest
  (schema_name, table_name, user_column, delete_disposition, export_disposition,
   export_inventory_basis, exclusion_reason, note)
values ('private','verified_key_sessions','user_id','cascade','excluded_with_reason','auth_user_fk',
  'Digest-only assertion replay and assurance registry is security bookkeeping, not member-authored content.',
  'Account deletion cascades through auth.users; ordinary session removal leaves an inert row denied by every live-session join.');
insert into private.account_lifecycle_trigger_review (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind='trigger' and schema_name='private' and table_name='verified_key_sessions'
  and object_name in ('a00_case_graph_lock','z99_case_graph_keys');

create index verified_key_sessions_user_id_idx on private.verified_key_sessions(user_id);
alter table private.verified_key_sessions enable row level security;
revoke all on private.verified_key_sessions from public, anon, authenticated, service_role;

create table private.verified_key_policy (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  allow_staff boolean not null default true,
  credential_eligibility text not null default 'non_backup'
    check (credential_eligibility in ('pending_owner_decision','non_backup','attested_hardware'))
);
insert into private.verified_key_policy(singleton, enabled, allow_staff) values(true, false, true);
alter table private.verified_key_policy enable row level security;
revoke all on private.verified_key_policy from public, anon, authenticated, service_role;
-- Only operators holding the service credential can enable/disable or restrict
-- staff eligibility. Client-supplied metadata never sets this policy.
grant select, update on private.verified_key_policy to service_role;

create function private.verified_key_session(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (
    select 1 from private.verified_key_sessions key
    join auth.sessions session on session.id = key.session_id and session.user_id = key.user_id
    join auth.users member on member.id = key.user_id
    join private.verified_key_policy policy on policy.singleton and policy.enabled
      and policy.credential_eligibility = 'non_backup' and not key.backup_eligible and not key.backed_up
    -- attested_hardware stays fail-closed: current registration metadata has
    -- no reviewed cryptographically trusted hardware attestation ledger.
    -- Never substitute unsigned attachment/transports or an unverified AAGUID.
    left join private.member_mfa_reset_boundaries boundary on boundary.user_id = key.user_id
    where key.user_id = p_user and key.session_id = p_session
      and (session.not_after is null or session.not_after > pg_catalog.now())
      and member.deleted_at is null and coalesce(member.banned_until, '-infinity'::timestamptz) < pg_catalog.now()
      and session.created_at > coalesce(boundary.invalid_before, '-infinity'::timestamptz)
      and not exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = key.user_id)
      and exists (select 1 from auth.mfa_amr_claims amr where amr.session_id = key.session_id and amr.authentication_method = 'passkey')
      and (policy.allow_staff or not exists (select 1 from public.member_roles role where role.user_id = key.user_id and role.role::text <> 'member'))
  );
$function$;
revoke all on function private.verified_key_session(uuid,uuid) from public, anon, authenticated, service_role;

-- The deletion step-up keeps its existing ten-minute verification window.
create function private.recent_verified_key_session(p_user uuid, p_session uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select private.verified_key_session(p_user,p_session) and exists (
    select 1 from private.verified_key_sessions key
      where key.user_id = p_user and key.session_id = p_session
        and key.verified_at >= pg_catalog.now() - interval '10 minutes'
  );
$function$;
revoke all on function private.recent_verified_key_session(uuid,uuid) from public, anon, authenticated, service_role;

create function public.register_verified_key_session(p_user_id uuid, p_session_id uuid, p_challenge_sha256 text, p_assertion_sha256 text, p_backup_eligible boolean, p_backed_up boolean)
returns boolean language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Auth's committed session must itself carry the passkey AMR. The proxy calls
  -- this only after Auth verifies the exact signed UP+UV assertion.
  perform 1 from auth.sessions session
    join auth.mfa_amr_claims amr on amr.session_id = session.id
    where session.id = p_session_id and session.user_id = p_user_id
      and amr.authentication_method = 'passkey' for update of session;
  if not found then raise exception 'not authorized' using errcode = '42501'; end if;
  insert into private.verified_key_sessions(session_id,user_id,challenge_sha256,assertion_sha256,backup_eligible,backed_up)
    values(p_session_id,p_user_id,p_challenge_sha256,p_assertion_sha256,p_backup_eligible,p_backed_up);
  if not private.verified_key_session(p_user_id,p_session_id) then
    delete from private.verified_key_sessions where session_id = p_session_id and user_id = p_user_id;
    return false; -- Valid passkey sign-in still uses the ordinary AAL1/code path.
  end if;
  return true;
end;
$function$;
revoke all on function public.register_verified_key_session(uuid,uuid,text,text,boolean,boolean) from public, anon, authenticated;
grant execute on function public.register_verified_key_session(uuid,uuid,text,text,boolean,boolean) to service_role;

create function public.revoke_verified_key_session(p_user_id uuid, p_session_id uuid)
returns void language plpgsql security definer set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
  perform pg_catalog.pg_advisory_xact_lock(509, 701);
  if (select auth.role()) is distinct from 'service_role' then raise exception 'not authorized' using errcode = '42501'; end if;
  -- Revoke the exact Auth-issued session even if registration timed out before
  -- its row became visible. The ordered graph/Auth locks serialize an in-flight insert;
  -- a later registration cannot resurrect a deleted Auth session.
  delete from auth.sessions where id = p_session_id and user_id = p_user_id;
  delete from private.verified_key_sessions where session_id = p_session_id and user_id = p_user_id;
end;
$function$;
revoke all on function public.revoke_verified_key_session(uuid,uuid) from public, anon, authenticated;
grant execute on function public.revoke_verified_key_session(uuid,uuid) to service_role;

create function public.verified_key_access_token_hook(p_event jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $function$
declare
  event jsonb := p_event;
  claims jsonb := event->'claims';
  subject uuid;
  session uuid;
begin
  -- Authoritative hook input, not user metadata. Reject malformed identifiers;
  -- preserve all native claims, including independently earned TOTP AAL2.
  subject := (event->>'user_id')::uuid;
  session := (claims->>'session_id')::uuid;
  if subject is null or session is null or jsonb_typeof(claims) is distinct from 'object'
     or claims->>'sub' is distinct from subject::text then raise exception 'invalid hook subject'; end if;
  -- Never carry custom AAL2 across revocation; preserve native MFA AMR.
  if claims->'ug_key_uv' = 'true'::jsonb and not exists (
    select 1 from jsonb_array_elements(coalesce(claims->'amr','[]'::jsonb)) amr
      where amr->>'method' in ('totp','webauthn')
  ) then claims := jsonb_set(claims,'{aal}','"aal1"'::jsonb); end if;
  claims := claims - 'ug_key_uv';
  if private.verified_key_session(subject,session)
     and exists (select 1 from jsonb_array_elements(coalesce(claims->'amr','[]'::jsonb)) amr where amr->>'method' = 'passkey') then
    claims := jsonb_set(claims,'{aal}','"aal2"'::jsonb);
    claims := jsonb_set(claims,'{ug_key_uv}','true'::jsonb);
  end if;
  return jsonb_build_object('claims',claims);
end;
$function$;
revoke all on function public.verified_key_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.verified_key_access_token_hook(jsonb) to supabase_auth_admin;

-- Retain live-session/reset/recovery denial BEFORE accepting custom AAL2.
create or replace function private.mfa_satisfied()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select case
    when claims.user_id is null then false
    when coalesce(claims.session_id, '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then false
    when exists (select 1 from private.member_mfa_recovery_locks recovery where recovery.user_id = claims.user_id) then false
    when not exists (
      select 1 from auth.sessions session
      left join private.member_mfa_reset_boundaries boundary on boundary.user_id = session.user_id
      where session.id = claims.session_id::uuid and session.user_id = claims.user_id
        and session.created_at > coalesce(boundary.invalid_before,'-infinity'::timestamptz)
    ) then false
    when claims.key_uv then claims.aal = 'aal2' and private.verified_key_session(claims.user_id,claims.session_id::uuid)
    when claims.aal = 'aal2' then true
    else not exists (select 1 from auth.mfa_factors factor where factor.user_id = claims.user_id and factor.status = 'verified' and factor.factor_type = 'totp')
  end from (
    select (select auth.uid()) as user_id, (select auth.jwt()->>'session_id') as session_id,
      (select auth.jwt()->>'aal') as aal, coalesce((select auth.jwt()->'ug_key_uv') = 'true'::jsonb,false) as key_uv
  ) claims;
$function$;

-- A valid current UV-key session also satisfies the staff factor requirement;
-- key enrollment alone does not. Preserve enrollment-based TOTP behavior.
create or replace function private.has_second_factor(p_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $function$
  select exists (select 1 from auth.mfa_factors factor where factor.user_id = p_user
    and factor.status = 'verified' and factor.factor_type = any(private.challengeable_factor_types()))
  or case when p_user = (select auth.uid())
    and (select auth.jwt()->>'aal') = 'aal2'
    and (select auth.jwt()->'ug_key_uv') = 'true'::jsonb
    and coalesce((select auth.jwt()->>'session_id'),'') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then private.verified_key_session(p_user,(select auth.jwt()->>'session_id')::uuid)
    else false end;
$function$;

-- Compass authority remains an independent explicit grant. Hook-issued key
-- AAL2 does not rewrite Auth's native session.aal column.
create or replace function private.compass_platform_operator()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce(
    private.mfa_satisfied() and private.has_second_factor((select auth.uid()))
    and exists (
      select 1 from private.compass_platform_operators o
      join auth.users u on u.id = o.user_id
      join auth.sessions s on s.user_id = u.id
      left join private.member_mfa_reset_boundaries b on b.user_id = u.id
      where o.user_id = (select auth.uid()) and o.revoked_at is null
        and u.deleted_at is null and (u.banned_until is null or u.banned_until <= pg_catalog.now())
        and s.id::text = (select auth.jwt() ->> 'session_id')
        and (s.aal = 'aal2' or private.verified_key_session(u.id,s.id))
        and (s.not_after is null or s.not_after > pg_catalog.now())
        and s.created_at > coalesce(b.invalid_before, '-infinity'::timestamptz)
        and not exists (select 1 from private.member_mfa_recovery_locks l where l.user_id = u.id)
    ), false)
$function$;

-- Preserve privileged capability, recency and recovery enrollment boundaries.
create or replace function private.organization_claim_require_operator(p_operator_user_id uuid, p_operator_session_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_operator_user_id is null or p_operator_session_id is null
     or exists (
       select 1 from private.member_mfa_recovery_locks as recovery
        where recovery.user_id = p_operator_user_id)
     or not exists (
       select 1 from auth.sessions as session
       left join private.member_mfa_reset_boundaries as boundary
         on boundary.user_id = session.user_id
        where session.id = p_operator_session_id
          and session.user_id = p_operator_user_id
          and (session.aal = 'aal2' or private.verified_key_session(p_operator_user_id,p_operator_session_id))
          and (session.not_after is null or session.not_after > pg_catalog.now())
          and session.created_at > coalesce(boundary.invalid_before, '-infinity'::timestamptz))
     or (not exists (
       select 1 from auth.mfa_factors as factor
        where factor.user_id = p_operator_user_id and factor.status = 'verified')
       and not private.verified_key_session(p_operator_user_id,p_operator_session_id))
     or not exists (
       select 1 from auth.users as u
        where u.id = p_operator_user_id
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= pg_catalog.now()))
     or not exists (
       select 1 from private.platform_operators as operator
        where operator.user_id = p_operator_user_id
          and operator.revoked_at is null
          and 'claim_verification' = any (operator.capabilities)) then
    raise exception 'claim verifier required' using errcode = '42501';
  end if;
end;
$function$;

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
  if (select auth.jwt() ->> 'aal') is distinct from 'aal2' or not private.mfa_satisfied() then
    raise exception 'recent second-factor verification required' using errcode = '42501';
  end if;
  if session_id_text is null or session_id_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
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

create or replace function public.generate_mfa_recovery_codes()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
declare
  caller uuid := (select auth.uid());
  org_id uuid := private.current_member_organization();
  next_generation integer;
  plain text;
  compact text;
  codes text[] := array[]::text[];
  i integer;
begin
  if caller is null or coalesce((select auth.jwt() ->> 'aal'), '') <> 'aal2' or not private.mfa_satisfied() then
    raise exception 'aal2 required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.mfa_factors f
    where f.user_id = caller and f.status = 'verified' and f.factor_type = 'totp'
  ) then raise exception 'verified authenticator required' using errcode = '42501'; end if;
  if org_id is not null and not coalesce((
    select coalesce((v.value #>> '{}')::boolean, (d.default_value #>> '{}')::boolean)
    from public.platform_setting_definitions d
    left join public.organization_setting_values v
      on v.organization_id = org_id and v.setting_key = d.key
    where d.key = 'features.mfa_recovery_code_enrollment'
  ), true) then
    raise exception 'recovery code enrollment disabled' using errcode = '42501';
  end if;

  insert into public.mfa_recovery_code_sets (user_id, organization_id)
  values (caller, org_id)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    generation = public.mfa_recovery_code_sets.generation + 1,
    failed_attempts = 0,
    locked_until = null,
    generated_at = pg_catalog.now();
  select generation into next_generation from public.mfa_recovery_code_sets where user_id = caller;
  delete from public.mfa_recovery_codes where user_id = caller;

  for i in 1..8 loop
    compact := pg_catalog.upper(pg_catalog.encode(extensions.gen_random_bytes(8), 'hex'));
    plain := 'UG-' || pg_catalog.substr(compact, 1, 4) || '-'
      || pg_catalog.substr(compact, 5, 4) || '-'
      || pg_catalog.substr(compact, 9, 4) || '-'
      || pg_catalog.substr(compact, 13, 4);
    insert into public.mfa_recovery_codes
      (user_id, organization_id, generation, code_prefix, code_hash)
    values (
      caller, org_id, next_generation, pg_catalog.substr(compact, 1, 8),
      extensions.crypt('UG' || compact, extensions.gen_salt('bf', 12))
    );
    codes := pg_catalog.array_append(codes, plain);
  end loop;
  return pg_catalog.jsonb_build_object('codes', pg_catalog.to_jsonb(codes), 'generation', next_generation,
    'generatedAt', pg_catalog.now(), 'displayOnce', true);
end;
end;
$function$;

-- These assurance helpers are reachable from the reviewed account-lifecycle
-- trigger graph. Re-enroll only the two definitions replaced here and the new
-- session helper; unrelated review mismatches must remain detectable.
insert into private.account_lifecycle_trigger_review
  (kind, schema_name, table_name, object_name, definition_hash)
select kind, schema_name, table_name, object_name, definition_hash
from private.account_lifecycle_trigger_surface()
where kind = 'function' and schema_name = 'private' and table_name = ''
  and object_name in (
    'has_second_factor(p_user uuid)',
    'mfa_satisfied()',
    'verified_key_session(p_user uuid, p_session uuid)')
on conflict (kind, schema_name, table_name, object_name)
do update set definition_hash = excluded.definition_hash;

commit;
