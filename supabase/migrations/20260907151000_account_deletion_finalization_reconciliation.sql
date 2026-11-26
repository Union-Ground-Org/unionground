begin;

-- Round 7B: this unapplied migration is amended in place; migration tail identity
-- remains 20260907151000. The closing source-pinned case-writer installation
-- acquires the shared advisory gate before original declaration initializers.
-- Outbox SKIP LOCKED and immutable key-snapshot behavior remain independent.
-- BUG-UG-ACCOUNT-DELETION-FINALIZATION-20260831: the durable request row
-- private.member_account_deletions carries only a subject_hash and a
-- SHA-256'd token, by design (see 20260812180000). That is also the bug: the
-- plaintext deletionToken lives only in one Vercel invocation's memory, so
-- once that invocation returns, nothing -- not even a trusted service-role
-- job -- can ever call finalize_member_account_deletion again to recover
-- from a failed finalize RPC. A successful, irreversible Auth deletion can
-- therefore complete with no durable terminal audit event and no way to
-- reconcile it, ever.
--
-- The fix adds one token-INDEPENDENT durability marker, settable only for a
-- request this exact service-role caller already legitimately claimed
-- (status = 'processing'), plus a reconciliation function that can finalize
-- such a row without ever needing the ephemeral plaintext token again.

alter table private.member_account_deletions
  add column auth_deleted_at timestamptz;

-- The pseudonymous subject depends on one database-local 256-bit HMAC key.
-- Carry a non-secret SHA-256 fingerprint of that key on every new request so a
-- later key replacement cannot make a live Auth identity look absent. A legacy
-- row is stamped only when its subject_hash verifies against a live Auth user
-- under the installed key. Unverifiable active rows remain visibly parked;
-- terminal legacy history may retain a null fingerprint because reconciliation
-- never evaluates it.
alter table private.member_account_deletions
  add column subject_hash_key_fingerprint text;

do $$
declare
  secret_count integer;
  installed_source_md5 text;
  installed_contract_valid boolean;
begin
  perform 1 from private.member_account_lifecycle_secret where id for share;
  select count(*)::integer
    into secret_count
    from private.member_account_lifecycle_secret secret
   where secret.id
     and pg_catalog.length(secret.secret) = 32;
  if secret_count <> 1 then
    raise exception 'account lifecycle subject-hash secret unavailable or invalid';
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
    raise exception 'account lifecycle subject-hash contract unavailable or changed';
  end if;
end;
$$;

update private.member_account_deletions request
   set subject_hash_key_fingerprint = installed.key_fingerprint
  from (
    select secret.secret as key_snapshot,
           pg_catalog.encode(extensions.digest(secret.secret, 'sha256'), 'hex') as key_fingerprint
      from private.member_account_lifecycle_secret secret
     where secret.id
  ) installed
 where request.subject_hash_key_fingerprint is null
   and exists (
     select 1
       from auth.users u
      where pg_catalog.encode(
        extensions.hmac(
          pg_catalog.convert_to(u.id::text, 'UTF8'),
          installed.key_snapshot,
          'sha256'),
        'hex') = request.subject_hash
   );

-- An unverifiable active legacy request may have been hashed under an older
-- key. Never stamp it by assumption: park it in the same state the reconciler
-- uses for an explicit key mismatch. The operator can restore the original key
-- and re-run this migration before release, or investigate and retire the row.
update private.member_account_deletions request
   set failure_code = 'subject-key-rotated'
 where request.subject_hash_key_fingerprint is null
   and request.status in ('authorized', 'processing');

alter table private.member_account_deletions
  add constraint member_account_deletions_subject_hash_key_fingerprint_format
  check (subject_hash_key_fingerprint is null
      or subject_hash_key_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint member_account_deletions_active_subject_hash_key_fingerprint
  check (status in ('completed', 'failed')
      or subject_hash_key_fingerprint is not null
      or failure_code is not distinct from 'subject-key-rotated');

alter table private.member_account_deletions
  add constraint member_account_deletions_auth_deleted_after_claim
  check (auth_deleted_at is null or claimed_at is not null);

comment on column private.member_account_deletions.auth_deleted_at is
  'Set the instant the GoTrue Admin API confirms the irreversible delete, independently of whether the subsequent finalize RPC succeeds. Durable proof a reconciliation job can act on without the ephemeral plaintext deletion token.';

comment on column private.member_account_deletions.subject_hash_key_fingerprint is
  'Non-secret SHA-256 fingerprint of the database-local HMAC key used for subject_hash. New and verifiable active requests carry it; unverifiable legacy active rows remain null and parked as subject-key-rotated.';

-- The 10-minute stale-processing sweep must never relabel a request as
-- "failed" once we know the irreversible Auth deletion already happened;
-- that would record a false deletion_failed audit event. Such a row is
-- reconciled instead (see below), never swept.
create or replace function public.authorize_member_account_deletion(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
  if (select auth.jwt() ->> 'aal') is distinct from 'aal2' then
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
  ) then
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
$$;

-- Token-independent durability marker. Callable only by service_role, and
-- only advances a request this same trust boundary already claimed
-- (status = 'processing'): it grants no capability beyond what claiming
-- already established, so it needs no plaintext token.
create function public.mark_member_account_deletion_auth_completed(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null then
    return pg_catalog.jsonb_build_object('marked', false);
  end if;
  update private.member_account_deletions
     set auth_deleted_at = now()
   where id = p_request_id
     and status = 'processing'
     and auth_deleted_at is null;
  get diagnostics updated_count = row_count;
  return pg_catalog.jsonb_build_object('marked', updated_count > 0);
end;
$$;

revoke all on function public.mark_member_account_deletion_auth_completed(uuid) from public, anon, authenticated;
grant execute on function public.mark_member_account_deletion_auth_completed(uuid) to service_role;

-- The independent reconciliation path: finalizes any request whose
-- irreversible Auth deletion is durably proven but whose finalize RPC never
-- completed, without ever needing the ephemeral plaintext token again. The
-- proof is either the fast-path marker above OR absence of any auth.users row
-- whose HMAC matches the durable subject hash. That second predicate is what
-- makes two simultaneous post-delete RPC failures recoverable: the claimed
-- processing row survives, while auth.users is the authoritative account
-- registry and can be checked after connectivity returns.
-- Callable only by service_role (a scheduled job), never by a member session.
-- Lives in public (like claim/finalize/mark above) so a service-role-only
-- scheduled job can reach it through PostgREST; private is not exposed there
-- and service_role has no direct USAGE grant on the private schema.
create function public.reconcile_pending_account_deletions(p_limit integer default 25)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  reconciled integer := 0;
  current_key_fingerprint text;
  key_snapshot bytea;
  installed_source_md5 text;
  installed_contract_valid boolean;
  request private.member_account_deletions%rowtype;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  -- The absence arm is safe only while both inputs to the pseudonym are the
  -- same ones that produced each durable request. A missing key or a changed
  -- helper is global: no request in the database can be evaluated, so the run
  -- fails closed. A per-request key-fingerprint mismatch is NOT global -- it
  -- strands only that one request -- so it must never abort the run for every
  -- other request (see the per-row parking step below).
  -- One immutable snapshot supplies EVERY hash and fingerprint in this call.
  select secret.secret, pg_catalog.encode(extensions.digest(secret.secret, 'sha256'), 'hex')
    into key_snapshot, current_key_fingerprint
    from private.member_account_lifecycle_secret secret
   where secret.id
     and pg_catalog.length(secret.secret) = 32;
  select pg_catalog.md5(p.prosrc),
         p.prosecdef
           and p.provolatile = 's'
           and p.proconfig @> array['search_path=""']::text[]
    into installed_source_md5, installed_contract_valid
    from pg_catalog.pg_proc p
   where p.oid = pg_catalog.to_regprocedure('private.member_lifecycle_subject_hash(uuid)');
  if key_snapshot is null
     or installed_source_md5 is distinct from '331e256ef56ee61c13fd1b4e82ae0b1b'
     or installed_contract_valid is distinct from true then
    raise exception 'account lifecycle subject-hash contract unavailable or changed' using errcode = '55000';
  end if;

  -- Per-row fail-closed, not whole-table. A request whose durable key
  -- fingerprint no longer matches the installed key cannot have its absence
  -- arm evaluated honestly, so it is parked: it stays visibly `processing`,
  -- keeps its null finalized_at, gains no audit event, and is never completed.
  -- The visible `subject-key-rotated` failure_code is what an operator reads
  -- . Parking one
  -- stranded request must not disable reconciliation for every other request,
  -- including requests that already carry an auth_deleted_at marker and never
  -- need the subject hash at all.
  update private.member_account_deletions parked
     set failure_code = 'subject-key-rotated'
   where parked.id in (
     select stranded.id
       from private.member_account_deletions stranded
      where stranded.status in ('authorized', 'processing')
        and stranded.auth_deleted_at is null
        and stranded.subject_hash_key_fingerprint is distinct from current_key_fingerprint
        and stranded.failure_code is distinct from 'subject-key-rotated'
      limit 100
      for update skip locked
   );

  -- If the original key is restored, the park marker is stale evidence and is
  -- withdrawn before the candidate scan runs.
  update private.member_account_deletions restored
     set failure_code = null
   where restored.id in (
     select recovered.id
       from private.member_account_deletions recovered
      where recovered.status in ('authorized', 'processing')
        and recovered.failure_code = 'subject-key-rotated'
        and recovered.subject_hash_key_fingerprint = current_key_fingerprint
      limit 100
      for update skip locked
   );

  for request in
    select candidate.*
    from private.member_account_deletions candidate
    where candidate.status = 'processing'
      and (
        candidate.auth_deleted_at is not null
        or (
          candidate.subject_hash_key_fingerprint = current_key_fingerprint
          and not exists (
            select 1
            from auth.users u
            where pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(u.id::text, 'UTF8'), key_snapshot, 'sha256'), 'hex') = candidate.subject_hash
          )
        )
      )
    order by coalesce(candidate.auth_deleted_at, candidate.claimed_at)
    limit least(greatest(coalesce(p_limit, 25), 0), 25)
    for update skip locked
  loop
    update private.member_account_deletions
       set status = 'completed',
           auth_deleted_at = coalesce(request.auth_deleted_at, now()),
           finalized_at = now(),
           failure_code = null
     where id = request.id;
    insert into private.member_account_lifecycle_audit (subject_hash, event_type)
    values (request.subject_hash, 'deletion_completed');
    reconciled := reconciled + 1;
  end loop;
  return reconciled;
end;
$$;

revoke all on function public.reconcile_pending_account_deletions(integer) from public, anon, authenticated;
grant execute on function public.reconcile_pending_account_deletions(integer) to service_role;

-- The endpoint reports `audited` only after this request-specific proof finds
-- the terminal event written in the same transaction as the terminal request
-- state. PostgreSQL now() is transaction-stable, so finalized_at and the audit
-- row's default created_at form an exact durable linkage without exposing the
-- pseudonymous subject or granting table access to service_role.
create function public.member_account_deletion_has_terminal_audit(p_request_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  audited boolean;
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_request_id is null then
    return pg_catalog.jsonb_build_object('audited', false);
  end if;

  select exists (
    select 1
      from private.member_account_deletions request
      join private.member_account_lifecycle_audit audit
        on audit.subject_hash = request.subject_hash
       and audit.created_at = request.finalized_at
       and audit.event_type = case request.status
         when 'completed' then 'deletion_completed'
         when 'failed' then 'deletion_failed'
         else null
       end
     where request.id = p_request_id
       and request.status in ('completed', 'failed')
       and request.finalized_at is not null
  ) into audited;

  return pg_catalog.jsonb_build_object('audited', audited);
end;
$$;

revoke all on function public.member_account_deletion_has_terminal_audit(uuid) from public, anon, authenticated;
grant execute on function public.member_account_deletion_has_terminal_audit(uuid) to service_role;

-- Account-deletion reconciliation is a platform job: no tenant or member
-- identity is recorded. The route supplies only an opaque bounded run ID,
-- lifecycle state, and one closed failure class.
alter table public.organization_job_runs
  drop constraint if exists organization_job_runs_job_name_check;

alter table public.organization_job_runs
  add constraint organization_job_runs_job_name_check check (job_name in (
    'integration-webhooks-dispatch-tick', 'notifications-dispatch-tick',
    'dues-reminders-dispatch-tick', 'dues-stripe-reconcile-tick',
    'notifications-expiry-sweep', 'deadline-notices-tick',
    'ballot-notices-tick', 'event-notices-tick', 'appointment-reminders-tick',
    'member-messaging-dispatch', 'workload-reminders-tick',
    'ballot-choices-mix', 'ballot-choices-mix-recent',
    'task-files-reconcile-tick', 'task-maintenance-daily',
    'account-deletion-reconcile-tick'
  ));

create function public.record_account_deletion_reconcile_job_run(p_run_id text, p_status text, p_failure_class text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (select auth.role()) <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_run_id is null
     or p_run_id !~ '^account-deletion-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_status is null
     or p_status not in ('in_progress', 'completed', 'failed')
     or (p_failure_class is not null
       and p_failure_class not in ('reconcile_unavailable', 'contract_drift'))
     or (p_status = 'failed' and p_failure_class is null)
     or (p_status <> 'failed' and p_failure_class is not null) then
    raise exception 'invalid account deletion reconciliation run' using errcode = '22023';
  end if;

  insert into public.organization_job_runs (
    organization_id, job_name, run_id, status, started_at, finished_at,
    failure_code, redacted_summary
  ) values (
    null, 'account-deletion-reconcile-tick', p_run_id, p_status,
    pg_catalog.now(),
    case when p_status = 'in_progress' then null else pg_catalog.now() end,
    case when p_status = 'failed' then p_failure_class else null end,
    case when p_status = 'failed'
      then 'Account deletion reconciliation failed.'
      else 'Account deletion reconciliation recorded.'
    end
  )
  on conflict (job_name, run_id, organization_id) do update
    set status = case
          when organization_job_runs.status = 'in_progress' then excluded.status
          else organization_job_runs.status
        end,
        finished_at = case
          when organization_job_runs.status = 'in_progress' then excluded.finished_at
          else organization_job_runs.finished_at
        end,
        failure_code = case
          when organization_job_runs.status = 'in_progress' then excluded.failure_code
          else organization_job_runs.failure_code
        end,
        redacted_summary = case
          when organization_job_runs.status = 'in_progress' then excluded.redacted_summary
          else organization_job_runs.redacted_summary
        end;
end;
$function$;

revoke all on function public.record_account_deletion_reconcile_job_run(text, text, text) from public, anon, authenticated;
grant execute on function public.record_account_deletion_reconcile_job_run(text, text, text) to service_role;

-- Keep the authenticated operator projection in sync with the complete
-- product registry, including both platform reconciliation jobs.
create or replace function public.list_organization_job_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare org uuid := private.mi1_require_selected_organization();
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if not private.has_organization_role(org, array['admin']) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'jobName', catalog.job_name, 'organizationId', org,
      'lastRunId', r.run_id, 'lastStatus', r.status,
      'lastStartedAt', r.started_at, 'lastFinishedAt', r.finished_at,
      'durationMs', case when r.finished_at is null then null else
        pg_catalog.floor(pg_catalog.date_part('epoch', r.finished_at - r.started_at) * 1000)::bigint end,
      'failureCode', r.failure_code, 'redactedSummary', r.redacted_summary,
      'acknowledged', a.run_id is not null, 'remediation', a.remediation
    ) order by catalog.job_name)
    from (select pg_catalog.unnest(array[
      'integration-webhooks-dispatch-tick',
      'notifications-dispatch-tick', 'dues-reminders-dispatch-tick',
      'dues-stripe-reconcile-tick', 'notifications-expiry-sweep',
      'deadline-notices-tick', 'ballot-notices-tick', 'event-notices-tick',
      'appointment-reminders-tick', 'member-messaging-dispatch',
      'workload-reminders-tick', 'ballot-choices-mix',
      'ballot-choices-mix-recent', 'task-files-reconcile-tick',
      'task-maintenance-daily', 'account-deletion-reconcile-tick'
    ]) as job_name) catalog
    left join lateral (
      select * from public.organization_job_runs run
      where run.job_name = catalog.job_name
        and (run.organization_id is null or run.organization_id = org)
      order by run.started_at desc limit 1
    ) r on true
    left join public.organization_job_acknowledgements a
      on a.organization_id = org and a.job_name = catalog.job_name and a.run_id = r.run_id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.list_organization_job_health()
  from public, anon, authenticated, service_role;
grant execute on function public.list_organization_job_health() to authenticated;

-- Reviewed case-graph entry wrappers. These are installation-time edits of
-- literal source-pinned routines, not catalog-driven runtime enrollment.
-- An outer block takes the gate before declaration initializers, authorization
-- reads, row locks or DML in the original body. Nested calls are reentrant.
do $case_graph_writers$
declare r record; source text; definition text; wrapped text; original_source text; directive text;
begin
  for r in select * from (values
    ('private.case_deadline_notice_sweep()', '1bb5b9b957e9b1270285767423485db3bda759c26f5aacdf32f6f5ae02ee3fb0'),
    ('private.casework_escalate_due_alerts(integer)', 'eaf551d5465ff06dc7c9ca7f8be78465f5405805949c79680ea90410893f2c1c'),
    ('private.coordinator_case_for_update(uuid)', '01eaaa25ebceaa9e22f7d5d4b2439460e78b540a0dfcf441570b9954f2bf19d4'),
    ('private.demo_seed_apply_casework(text, uuid)', 'fc286572bb86afe641b7a2d013236e234ca2e357d33c6d80ad0d49a1058c5d8b'),
    ('private.demo_seed_apply_function_parity(text, uuid, text, text)', '2063d5b093e900896d07f3a816e7a81339aa2ee69661a644342f5da6320526fe'),
    ('private.demo_seed_remove_casework(text, uuid)', 'e297cbc1e598454926a6e020350868e03b9d775b5ffab240eda97d257ef097c4'),
    ('private.demo_seed_sync_casework_evidence()', '14c928c6bdc46027d971c649a6f76226ac7a54881783d910dd9e7d9615290cb4'),
    ('public.advance_case_step(uuid, text)', '7d424a587615bb3c419769dfb711b25d9cecde23345361d123e32e1cc5c9c569'),
    ('public.approve_and_open_case(uuid, text)', 'bbffa894fc769485ed5848517824ec34cca697ab1b7f4106fb88d970c19fe867'),
    ('public.assign_member_case(uuid, uuid, uuid)', 'cfb35880cf6ef42e532e6d6416284df74642464d76687fa0161664ee1858b3b4'),
    ('public.begin_member_case_file_upload(uuid, uuid, text, text, bigint)', '0cb6305f733193f1f57c76abb4ad114afdbd9e4d79e7a2617e9c3b9f5f2916aa'),
    ('public.begin_member_signin_recovery(uuid, text, text)', '07433b8b96836c50a486f6e358f6f031adbd044b9e645242f87d18a11acf97e5'),
    ('public.bootstrap_first_organization(text, text, uuid, text, text, text, uuid)', '9c4ac4c86a6e165958c09a902229d3c7fa3d5bc8aab79b7812db1e9b9329f20b'),
    ('public.casework_acknowledge_alert(uuid, text)', '936e9ea55cb1006d7a35a7510a9b5ede6c5667138a73882bf5924c8486ea0242'),
    ('public.casework_add_bargaining_event(uuid, text, text, text)', 'e78de526f7db0fee081d16b727323e74583ea4e3bcda3a6f8b7b018b7ce3aec9'),
    ('public.casework_add_bargaining_proposal(uuid, text, text, text, timestamp with time zone)', 'a03a2f9bc5b35de11bc3965e19b5d5c190b13fb2871557342f33e0284664005e'),
    ('public.casework_advance_step(uuid, text, text, text, uuid)', '601a307c3639708090c443a2aef63f453d205894ea1a14f6055e627cc4c97252'),
    ('public.casework_bulk_update_cases(uuid[], text, text, text, uuid)', '18a52b98b3ea09210e0c82cc4c0e4a7fe3699d0c484081bcd8aff24aa4b249f0'),
    ('public.casework_create_bargaining_workspace(text, text, timestamp with time zone)', 'e6227bcb3ef72f6c0573682819669f3290802b300db6da5a07bd3ef49a2a8ca9'),
    ('public.casework_create_checklist_template(text, text, text, text, jsonb)', '9173b0d883b2a185cd95d6d24837be101cb6dcb466cea103d86c09f7e15962bc'),
    ('public.casework_decide_deadline_extension(uuid, text, text)', '0e739bea73b85d93b5e652e3b605e63d79dc8a6d0e54c0abaec942d85afb344b'),
    ('public.casework_grant_access(uuid, uuid)', '2363956e207455ef0917bd06a92e19e11d710686a57ace400a6e2c8c2b8da9c4'),
    ('public.casework_link_cases(uuid, uuid, text, text)', '7837894f31af8bf07a81efd49d5c9fe34d2075084d383bece73b3b30a88933eb'),
    ('public.casework_log_management_behavior(uuid, text, text, text, timestamp with time zone, text, text)', '45dac3c50c812ada3080f52ed32553d268f42f58fa12c412188ebcda59f572f0'),
    ('public.casework_request_deadline_extension(uuid, timestamp with time zone, text, uuid)', 'd5c4d06b7bfef5282b917764e7378ae52d8a44a1b67c696cb30ff18961698163'),
    ('public.casework_review_retaliation_pattern(uuid, text, text, text)', '4a43a3b568127cd103e4424e03199536c1dc971ac85185413138b4a0afe401eb'),
    ('public.casework_save_intake_draft(uuid, text, uuid, uuid, jsonb, integer)', '45bacc310d5fe148347cc59a8273097cab85137e80791856ccdf2246aa27a2b4'),
    ('public.casework_score_case(uuid, jsonb, uuid)', 'e3ed39f7e13d89529f4a659182d983634a5eff620ec26534744ee74143446c4d'),
    ('public.casework_set_bargaining_status(uuid, text, text)', '22d90a18bb24c8b00e8a6d01f7970d17fda28307131eea0b2c87d5d533a2c972'),
    ('public.casework_set_checklist_item(uuid, boolean)', 'c2592cb7e1af6410f60139bba2f8f3953f908e31b306490d5009f9322882fef0'),
    ('public.casework_set_reminder_status(uuid, text, timestamp with time zone)', '938568739c6407bb05dbca4bbe29299c4c8e865df2e00fbf1246d0016cbe605a'),
    ('public.casework_set_restriction(uuid, boolean, text)', '8b4781a063bd6c4e6d86c2fe97e30e35f6bbfbadea5b0aa2db183c4cae7376de'),
    ('public.casework_submit_retaliation_report(uuid, timestamp with time zone, text, text, text, text, uuid)', '8e016f5a5ca1cc63802bd36121bf6326460cc8247fa5943b38aca2f80d48d212'),
    ('public.casework_transition_bargaining_proposal(uuid, text, text, timestamp with time zone)', '77234e0c5355d3a656ecdcb91ae4c8284a312fe72fc7cd66aee8ef466224ffd9'),
    ('public.commit_member_operations_import(uuid, uuid)', 'ea35dc9fc754cb2eaa0ea05933d758b979734057f80434a31d2e2b6c6f21abe8'),
    ('public.complete_member_invitation_activation(uuid, uuid)', '788ecaee7fb105a919458e03b217f364907147cb4ad4c3c5550d07854666f5dc'),
    ('public.confirm_member_case_file_upload(uuid)', '0fedbce4a8b1a812db72d5d0871b20ccc638ab1aab3b6a47c18fe34ccd090464'),
    ('public.convert_member_intake_report(uuid, text, uuid)', '323b17e7aa3931d28bdb36fbbd11ba907fef113e019e2083eccf53fe4d9a7852'),
    ('public.coordinator_add_case_note(uuid, text)', '0216bb872cd4f679be19544c19baf02db9297fca5c98a041440b121ed7b08fac'),
    ('public.coordinator_log_case_contact(uuid, text, text, text, timestamp with time zone)', '35ae94bc59798c2f72adf73413a0f4434df041b0fb47f9d8b7fc999d5a37d8c5'),
    ('public.coordinator_record_case_outcome(uuid, text, text)', '1bdab21b7e81e0300a484aacae7f9966ff44a5987aed2534189b45b188162524'),
    ('public.coordinator_update_case(uuid, text, text, date, text)', 'c547660999850fbe96859878aa8790c371db835295d00f8f1b84413a07df5ae3'),
    ('public.create_chapter_task_from_source(text, text)', 'fbe8d79ff9551b64907bd65c6ad266d027ddb4e3f64b299f954915816c6141f4'),
    ('public.create_member_case(text, date, text, text)', '28bad7d4aee560cf6d7fe0f1d5737d27d63b435b3e273314c4c3d7c5edc7b489'),
    ('public.create_member_invitation(text, text, text, text, text, text)', 'd0e14d7c95d80e0f058a7a205127612c81b95aebbbd75d45f00f08fccdab7d13'),
    ('public.decide_compass_workspace_action(uuid, text)', '1863fa94b78a248f042be889f23ea00e7623ef7a18a46b667e1dc288e17bb1d8'),
    ('public.execute_administrative_object_action(text, uuid, text, text)', '03cf484b91c7e266cb387bb89b9adb4f867f83dfbf86ccf33be309f08a4b7856'),
    ('public.finalize_member_invitation(uuid, uuid)', '80422f2a00d55f551cd09d5124ccc77b45bd86fb7ce6d385832c13a66a072ebc'),
    ('public.finalize_member_password_reissue(uuid)', 'b604e0d63ed8323b70363527ede6f96bdcbb53bba7a513ae6e788c4951a71711'),
    ('public.finalize_member_signin_recovery(uuid, boolean)', 'cb27255ee23adc8708ca3a43a5d354a55ada1b36c735f4d234cc275ca0c9cb78'),
    ('public.invite_cosigner(uuid, text)', '8a4bd7d657dc825ddad77933d7efa5deb754d7090b33d4d96f0ab7f0e7a1ead2'),
    ('public.member_stress_apply_batch(uuid, integer, integer, text, text, text)', '84be3b79248b2ad61c38193b9ed90569666266b87b174733bf611a375a87b237'),
    ('public.member_stress_begin_remove(uuid, text, text)', 'a54c180db4d363ddb14f64f21ab205ae17f7750e7d691aa29b993bb725ad6162'),
    ('public.member_stress_enrich_batch(uuid, text, integer, integer, text, text)', '2a0633c351d0ce9d748937d213fc8be960baa412ba3bde0f7030d435f5587963'),
    ('public.member_stress_remove_batch(uuid, integer, text, text)', 'd636585ed04f6d6f6f983feeb3d435b5dc7856e60b55347edfa22f6add9ca5de'),
    ('public.member_stress_verify(uuid, text)', 'aa373904075ad9078e73a83313ce5f259ef58163b0ebe8524fbd33dc902ef636'),
    ('public.open_form_as_case(uuid)', 'ad433988a23b62ab500eb70d9609249b87ab7083f677c7e1b699f877713ca488'),
    ('public.patch_case_checklist(uuid, jsonb)', '732ed0b57d0c4aafdaea168ed8df55043a8013783ce1e97a688f2c6ab9948c17'),
    ('public.presg_demo_apply_batch(uuid, integer, integer, text, text, text)', '6db04edc11431efe3e414b0c58212bccaa1c2452b5998e6dbb972e7eb06652a2'),
    ('public.presg_demo_begin_remove(uuid, text, text)', 'a46a4b6c06e4d3d40db32cded66c9572473612b75727c8c4c003aa784b854499'),
    ('public.presg_demo_enrich_batch(uuid, text, integer, integer, text, text)', '58ac5050745e6ece8a97e4be7e2bce7d1d475d1be354a46a5beb36542b81428a'),
    ('public.presg_demo_prepare_reapply(uuid, text, text, text)', '3e7a0aa8596a03404171e328f186a59ddea0eee503fdeb1c49eaeb27a5bba89f'),
    ('public.presg_demo_remove_batch(uuid, integer, text, text)', '7b62a42ba69a39245c9228baf58596e07564e8d3da5aac6ffb7a21aff6bc4227'),
    ('public.presg_demo_seed_function_parity(uuid, text, text)', 'f6808e2a4952ff04601c11b03eff94ced39044c7474c8a1f70d020bc6ec8bbee'),
    ('public.presg_demo_verify(uuid, text)', '86e8a70666494cf0121f9ef5ce9b52757645be2b28c107ba51ac73b1f3c92822'),
    ('public.register_member_case_file(uuid, text, text, bigint)', 'e933a83a8afabffb42914477b6e476fc05d44c263db6f1c88cb05d495c3c43c5'),
    ('public.request_case_deadline_change(uuid, text, date, text)', 'a9d6c4d0142c29e5c76f71da70ff48a6cafd150a80d8b68da0f48f1811a820a9'),
    ('public.review_case_deadline_change(uuid, text)', 'b6280a7d001e5fda2ddd279cda4e6a756303d0a050271079930b331bdcbfcbd2'),
    ('public.set_case_restriction(uuid, boolean, text, uuid[], uuid)', 'ee712158005bae845ce8185b2c817d4510e0c87679cb21ec95076866e52043df'),
    ('public.uniondemo_apply_batch(uuid, integer, integer, text, text, text)', 'cd5de134b99ac8befb9a9ee8c09fc35fb17037946de1ac54c7efe408610cddb1'),
    ('public.uniondemo_begin_remove(uuid, text, text)', '1eac1cda76a6f59d7a2a54190470863d7dea072b516e0e5516c0fdee682615d4'),
    ('public.uniondemo_enrich_batch(uuid, text, integer, integer, text, text)', '28a9b6df110f14a408b5d7920f9d190acd0f1e8ea143f58bb8e803052e10b9fd'),
    ('public.uniondemo_prepare_reapply(uuid, text, text, text)', 'f85a5b0fa6a26dfd27324abda53b969db7d96a7f6d188cc9fdde89c16466f8ec'),
    ('public.uniondemo_remove_batch(uuid, integer, text, text)', 'e99d27f5988f5e4aaeb96f8c48ac1e3c01e8ed6686d2dc051e639659c7d86e36'),
    ('public.uniondemo_seed_function_parity(uuid, text, text)', '4e44eb657daa7ab8b6b31efa1fcde370e30e2f172d435b21c96ecebf1bd29426'),
    ('public.uniondemo_verify(uuid, text)', '106b2449da33361b9d883114854dd10d5e5ea8d74232e9287a3cf0f868acc902'),
    ('public.validate_member_operations_import(uuid, uuid)', '486eeab67b70f85a11e4d238f25adeecd216ac4743c20a26c3e4e8fa8892ee19'),
    ('public.submit_workload_log(integer, integer, integer, integer, integer, integer, integer, integer, integer, text, integer, boolean, boolean, integer, text, text, boolean, boolean, text, jsonb)', '043535c0276c03867e5e58879d02ac7a81cb9796af79cb6e1ddf6aa42945acd2'),
    ('public.steward_start_review(uuid)', '445eefd5d72febf72653d408e16c39498a9a813e82b5667fdc3f90386039c9d7'),
    ('public.book_appointment_without_place_legacy(text, integer, timestamp with time zone, uuid, text)', 'ac622c286093374f1d162d09496704fc22743d19b64a34029f5913ae7edbe87c'),
    ('private.notify_cosigners_on_approve()', '9df406f3d09ba31fc95bf9a65316e590902d1b9d9cd79aeb0fb877883e82ccd8'),
    ('public.triage_steward_request(uuid, text)', '5baafddba985cac6a632563e4ad90318902c718a06a1ebee3331e82411749e50'),
    ('public.return_form(uuid, text)', 'fe6f51ad015a2a46d6bf2f0ba8a0f9dfaa198af2944c15c7759f2b699ad2a460'),
    ('public.grant_member_role(uuid, text, text)', '4395e486f8251b4c5b7a19c27d0ec9707f00df68f1a2fdf53fb9d0c50132b926'),
    ('public.revoke_member_role(uuid, text)', '458ceca4d7a346fe06f3bbce5512138d9ecd6fca02c2e78982478b722ac167f3'),
    ('public.approve_form(uuid, text)', '92073bac2fe6fda69bcedc4cf8ffd04b8bdb1d4d0865f55bcff8c031f9a48657'),
    ('public.record_notification_delivery_results(jsonb)', '5a30e2d2e4a950c7d8950a1fed700c94db22637c04b2a094cba6a0e1aaeecd12'),
    ('public.send_member_message(uuid, text)', '815ae602faabd6b9de22bf7569156252c4c5bb37b7985c83535fc185a7ce923c'),
    ('private.notify_mfa_enrolment()', 'b2c4720994c57f012329ea4624f2afa9d2332706f4f0dc52d1a56632832a112d'),
    ('private.prepare_chapter_task_dependency()', '063f61e7f174f2eb1e51c63eda455d53d461570fb31263e33e9e734038545f21'),
    ('private.bump_chapter_thread_on_post()', 'fcd0a5b0f9ba9e8599337af3f758d77a652a5f4415cb9858bbe0920eb4237239'),
    ('private.notify_member(uuid, text, jsonb, text)', '975f0e8753c93fb3cc7fd259a20877af263d9b58ee62e7c96687c839c1e98425'),
    ('public.send_chapter_task_message(uuid, text)', '7a8f109446387b2b534b8ce9d35ddf85afbb3cec7235c2fefb313560e484ed20'),
    ('public.rename_chapter_workstream(uuid, text)', 'e14d9f1dd77130419f76b90e8a398b7743ad388eae030aed2f7133783bd6a5c1'),
    ('public.merge_chapter_workstreams(uuid, uuid, integer)', '4d4c821123a7d5ba32e6ca0f735740e65f1fb922fe93852396ee84ab516181b2'),
    ('private.notify_member_at(uuid, text, timestamp with time zone, jsonb, text)', '8ee2bafaf81c5fa111fccf2f82e0462f1e6ee156f649b43a2c73db94cf137919'),
    ('public.soft_delete_chapter_task(uuid)', '1fb4dd1773887391155764ab86554f1f5607f1e75aae69a27ac06d3deebe6f3c'),
    ('public.restore_chapter_task(uuid)', '9b8ded7c6fbebd3a9aa73b66cd9472e25bb03154448e2768bb98e85227592e36'),
    ('private.handle_new_member()', '7bdf54cfa2f56a22c234f5f57e0da89fda0a71640c2fa20a64b2e3b5a89dbacc'),
    ('public.cancel_appointment(uuid)', 'b9a5ff9b55a9349210075a203a61f28f1a97ac832e621b93924177203fd79c3c'),
    ('public.reschedule_appointment(uuid, timestamp with time zone)', '8e4d72e31b59108190828cc448ad4eb37da7e5ebbe9eb997b5200fde234267ab'),
    ('private.enqueue_notification_deliveries()', 'a91b6af48ab806fb72eb509b89733caa6dc36bbd11b16063f198f6f638c837d2'),
    ('private.appointment_reminder_sweep()', '563092e30f058af5d1d717ec87f88cfdaabcf8444a14ec83fd43b86635acb4bc'),
    ('private.prepare_chapter_task_subtask()', '215e1eaff894c595010f3f0927863113fd28bee37ee9a123df6903a6b9cb307a'),
    ('private.notify_stewards_of_request()', '0164460a4c08a8b74a31bcfa3be0e15d51dc2f0b5d9f0af64218618f72962203'),
    ('public.add_chapter_task_attachment(uuid, text, text)', '8c0f0be66f35156c55588b6dad384e6318c04ef484d0b593695ea9bb8ddaf449'),
    ('public.remove_chapter_task_attachment(uuid)', '7c5d1475867922a6b16f7c9541f633c981ce8851075fa0c617ae8e3bd32fed53'),
    ('private.prepare_chapter_task()', '131a4b8b12a7323d3e3330e0681fafbca601a56d9f158bbfeb105f80d4183b67'),
    ('public.update_chapter_task_content(uuid, timestamp with time zone, text, text)', '48221209c10983079f5346b7a4df4223fc76cd15d97a878684a4909f77537aa9'),
    ('public.move_chapter_task(uuid, text, text, uuid, timestamp with time zone)', 'bd6b3bd013c7bf54e313656253d05d297098eb6094861a43a224413d57b23376'),
    ('public.set_chapter_task_assignees(uuid, uuid[])', 'daa9817d532a91ef1686daeaf5d3c1566b2199a605ba261a8160c212e2fec36c'),
    ('public.remove_chapter_task_file(uuid)', 'fc9d3df4e1b7e1869485dc5621f90958bd11ec395ad62a84481de1aac6b3a447'),
    ('private.ballot_notice_sweep()', 'b03fa4ced37922a99eaa8720245c4cb02e5c47336e129d19de52ced68189fee9'),
    ('private.notify_chapter_task_watchers()', 'cb8359f545dc1aa96701c7ddc5175f98d48e79c4ce639b50a8555862f316a110'),
    ('public.add_chapter_task_comment(uuid, text, uuid[])', '33c0f6fe37717108fd2806be854984a3ed967540611e86791e83068b70ecbffc'),
    ('public.book_appointment(text, integer, timestamp with time zone, text, uuid, text)', 'cbb1bec356d9989dd39ababf201e9bf75b485cbff6603b02486b862f5df5a422'),
    ('public.cancel_member_event(text, text)', 'c18bb1f9f69e23d95a52e2980cc0e48fd053c6ac1a040a2993b95884ad050cc1'),
    ('public.mark_vp_case_reviewed(uuid)', '903a017b68cf1881fd2aa170650e6dab43c144a9e9793bc5ae08e74db6bff92b'),
    ('public.update_chapter_record_content(uuid, text, text, text, timestamp with time zone, boolean)', '87a068332c5f466e86168565891f2e7be65782e216181922f647ace413f429b8'),
    ('public.remove_member_case_file(uuid)', '65a513383a747d1f732851ce761ac349b9b29eb7ae4d91c257bdb0d4531970c2'),
    ('public.start_member_conversation(text)', '69f6177520de475d37ca15a7bc9c47981154923e8ba1f2f95013a15cc7fc30b7'),
    ('public.triage_member_intake_report(uuid, text, uuid)', '0f32d45735aec3b7b4f917af0dc0d1e801ae0d22ebb89187e42d9ab390332eeb'),
    ('private.invalidate_member_form_signatures(uuid)', '6c7ac9b6ecb6923a4491cf1c328267286a097fd7f1493a81048351eca0a06b44'),
    ('public.revoke_member_invitation(uuid)', '4408021f663a149767ea08f7f4a51a450b3e17ddd4a07112f9dac28e48354e4f'),
    ('public.record_member_invitation_delivery(uuid, integer, text)', '4b013042e4fbe1fd6434336b7fe7f9e7ef6486be20b098dd8fe3cd3825538672'),
    ('public.reserve_compass_ai_request(uuid, text, text, boolean, boolean)', 'b49b5a2ffddbf0afaef0c284f78455137739e6527dcb31a23c2a28085b473922'),
    ('private.uniondemo_sweep_trigger_rows(uuid)', 'b78486b006e56044087f42d10932e12fe1e7208aae44b221a5c4875b7ecf6414'),
    ('public.uniondemo_seed_channels(uuid, integer, text, text)', '0020861e594ac97caf10b64d398d55496448f3cf27f629a536fad1b719143337'),
    ('public.save_reward_tier(smallint, text, integer)', '4f5523fb296d86a497bc6d3b9f733fc43044b39fc0bc28f21d565f9be65d6911'),
    ('public.restore_member_event(text)', 'eba2038bb17939b1243e204c7a9304b879e745f3f5137bebd4d49017d762132a'),
    ('private.event_notice_sweep()', 'e58c2dc0851f62610e7c33da9f479cf421f809049d2a281182d6f512a3636a56'),
    ('public.scan_event_checkin(text, text)', '0cf28635f134b82adf1da434766f9b36ef230739016b320e0643bda1e5af5cdd'),
    ('public.create_member_event(text, text, timestamp with time zone, text, text, text, boolean, boolean)', '43a9408574b100195492200b439d7d578aeb006efc5bc05adf2c5e0261c20eac'),
    ('public.update_member_event(text, text, timestamp with time zone, text, text, text, boolean, boolean)', 'a7c6bc4abf30ba7f7b3936ab555db1d8e6d3e7de40c97a51f801dcaf325635c0'),
    ('public.save_form_draft(text, jsonb, integer)', 'b50fbc92c7bfe85c4bdddb278e5ef86ba5adc5adea47c18e972aacb39c8e6f3d'),
    ('public.create_event_from_member_message(uuid, text, text, timestamp with time zone, text, text, text)', 'c4a52695d77b1a4a0c2d64e3aaed28ee8329bc893fc1d4f5d97543292944f996'),
    ('private.dispatch_due_member_messaging(integer)', '845643ffc6986d14f37fb2556bd29fca8db381e89ffe8571459edbeda0166221'),
    ('public.toggle_member_saved_message(text, uuid)', '919ff6f1b0d5350d0d7bbf396f3f11b70c0acd20797d8b4da11c28da6775aa7e'),
    ('public.toggle_member_message_reaction(text, uuid, text)', 'aef1dca81438da9b082811c429ccd57aa6f17d605d9b8edb7e6d6c2019d478ca'),
    ('public.create_member_message_reminder(text, uuid, timestamp with time zone, text)', '59f7ec149d8c91cdb98c138aeec7270d17082eebbba4c9f8dd124e50bf6751c3'),
    ('public.cancel_member_message_reminder(uuid)', 'f300fa55c783864307cad4c94c3bcb6273bca6c8aba3321cc4280dd14a600918'),
    ('public.send_member_resource(uuid, uuid, text)', '7cbbe45a9c7e68911429e49577b0b42ec606fc169fe6867046b2898f937a3412'),
    ('public.create_chapter_task_from_template(text, text, text, jsonb)', '7f5d2e58adea2001b11ef1ff5b7f1f74bb3bbd7ba22c313c2912b5522fbc15c3'),
    ('public.update_chapter_task_template_details(uuid, jsonb, text, boolean)', '6db2414feb3c9bf232ee1adc00e1ae2ba2210010cb6701a6aba3ef8f1c457946'),
    ('private.notify_workload_event(uuid, text, text)', 'e7b951314962393723ce2aeb96f2916ff2c10d48f0e22e30149da8a7005bd9a4'),
    ('private.workload_reminder_sweep()', '8567fe5e91f6432b1ae23bdfc59fb9cad69f1af1d7b8defa4969458b0554dc6f'),
    ('public.claim_notification_deliveries(text, integer)', 'cf0a8a9038dcd2109407731c1a16d659fb3b4961546b5824f598d95ee5d31b14'),
    ('private.notify_chapter_task_template_change(uuid, uuid, text)', 'b15c06418e6bac44308c2fb7de43f30bf62ee28cdf7134aaa06f6f958a9ca4a4'),
    ('public.reassign_chapter_appointment(uuid, uuid)', '4a637333bb8f116c17adcf454b708c178621ec19e1f5124db20acc22ecf05508'),
    ('public.respond_to_cosign(uuid, boolean, jsonb, boolean)', '069871d5d5db925902eabaa957c82c9579853e3da4ae8efc7d8fdc4f3a79e748'),
    ('public.withdraw_cosign(uuid)', '5e8f5a2ef2c89ab80770cf17b96b7f050d0c4af6834f5e22142f88418e266ee7'),
    ('public.sign_member_form(uuid, jsonb, boolean)', '8d3fef3c9958ee1d92c0a0748a5efc2d30c84807d74c5c3ae56dd83446ed458e'),
    ('public.confirm_member_form_file(uuid)', '5e34bbfba3cfd59c08c2083e69ba51cc7f72eafecaf4bb8e73d53637d1328555'),
    ('public.request_member_form_file_removal(uuid)', '5913b4366576e9aa5f599b769228ae7eb8b1c18dca9e02ca3cab48ecebad307e'),
    ('public.finalize_member_form_file_removal(uuid)', '4e21f05a67ad8ad5ba3a06e81ed9a1ef57174c344ef38bc325e5bb70e26e87ae'),
    ('public.respond_reward_peer_contact(uuid, boolean)', '22f3342d19e8cb28b4fa3be623abab6311837f5c00b04335fe23f7a4f2912d28'),
    ('public.request_reward_peer_contact(text)', 'a5f82568da028b74540647a19886e4ba282d00370e97cfaa6425134e41871cb1'),
    ('public.cast_channel_poll_vote(uuid, uuid)', 'a7c72326aeed858e7b814d7dbcaa34fe8d5f66ee4b0fdc1f247e3c6922915ef0'),
    ('public.switch_my_chapter(text)', '726e4c46080a5a3fdb4590e6ffdc9b21ba5ae299fc14453e9918eb6a8edc1127'),
    ('public.revoke_member_chapter_membership(uuid, text)', 'd6792b7e2002a6dc16875d3e13b566f098936e48b6089abd8c66dec3d30029b3'),
    ('public.grant_member_chapter_membership(uuid, text)', '6d11e1da7a272ddb8785fe965263c2891d498e6506fbbeab01afb0767341fcd4'),
    ('public.request_chapter_handshake(text, text, text, text, uuid)', 'f1b8c0ae1a9cec4e71d258c5f8f76054c75a387250b059d9b0d865b7df472e08'),
    ('public.respond_chapter_handshake(uuid, text, uuid)', 'b6edc7b8d36cb743bc4e2d46ad9ed6dc5c40888517e2faa2171596b82ca38380'),
    ('public.countersign_chapter_handshake(uuid, uuid)', '1d84e11bf734188c94be8a44d7505879f2e06cf5b003ae8d422331a9894e165d'),
    ('public.close_chapter_handshake(uuid, uuid)', '261d8a415c666ecf360d284de93674047b4a0e366f178ea5c278a4c4f1cd3bea'),
    ('private.require_member_invitation_admin_chapter()', '21bfe151e89d54f8c9b8df0ee6bbe7e4dcb1af9f105f36e75d4d0ca75c1c818c'),
    ('public.resend_member_invitation(uuid, text)', '32db47df4559954ada038d9c05df3c461045f1aa4a3633d0b22a2cd77204f563'),
    ('public.get_member_invitations(integer)', 'e01706903b109695f153e9ca836b70bcd014ed8d83d106888f6cafda98739c1e'),
    ('private.mi1_w2_generate_case_work(uuid, member_cases, text)', '4e58c8fdca3083fdedf3dae2ad964bab51e0354c37736770b546e5d3274ebde7'),
    ('public.acknowledge_case_alert(uuid)', '1d32a71db5e8b4890d7411b3229760c4dfd21f0498c5a2ab2f3d70afd1dd200b'),
    ('public.escalate_unacknowledged_case_alerts()', '3571db7e71540c2420136cf2f98549f74c586ac95413208d3dccb9d40b7d3088'),
    ('public.upsert_case_reminder(jsonb)', '075fd6780217695c15449ae039cbc20a22090bba2b150f85acbba838c232e343'),
    ('public.dispose_case_reminder(uuid, text)', '203c81a0e390ad1fcb3dc03d523811a0b7f6d6790fbb7c9487045dadb5d78a7f'),
    ('private.presg_demo_sweep_trigger_rows(uuid)', '28339ae69de12ccb95118f48566a4c8da0a82596e0c6609242b6f355389844a6'),
    ('public.presg_demo_remove_function_parity(uuid, text, text)', '53bc94948b2c02f65cd0d7bc795fe28dbb369ed7d70bf5fbd588020cd77ce25e'),
    ('public.presg_demo_seed_channels(uuid, text, text)', '182bcd828cee65f6d57c4911974db879489a646ac7e0ca3a826cee2957d4b476'),
    ('public.prepare_organization_survey_distribution(uuid, uuid[])', '6e24f79c012dbfa7566419c5ec41a304d6914848d088e54b046e382f14629283'),
    ('private.demo_seed_analytics_after_page_evidence_insert()', 'ea65c1e63d643e2a63159f647953dfb1780d3e2aaa22b122a6fce25a2d913983'),
    ('private.demo_seed_analytics_after_evidence_delete()', 'dceb2827c6c9413bd24de28e1604b76587f3dda7a61aef23f9a382b708819348'),
    ('public.save_institutional_record(uuid, text, text, text, timestamp with time zone, text, text, boolean, text, integer, jsonb)', 'eda6a91599fd4ab4e02465276d6528f09bfdb70e20bd4c2b32fc65b071748104'),
    ('public.save_chapter_contact_log(uuid, text, text, text, text, text, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid, boolean)', 'd68dc327973f28d524b1e414286840bbd899abc64b0d76dc70c851e09d3a3280'),
    ('private.demo_seed_remove_institutional_records(text, uuid)', '74e129c45233c2f5c8b59d9ffe3dc0d6edc929e32723b7be66be14dcd23d4e8c'),
    ('private.demo_seed_institutional_records_from_evidence()', '5d50519cd2579d76259906bd871f0d3b0301f2d985fe1ca1a9dd612b2ee1f324'),
    ('private.demo_seed_apply_analytics(text, uuid)', '15e99eefbe16fe6da20952a11ebb61ba5ed41a89a52122e2c3d22a78c8f92c4d'),
    ('private.demo_seed_remove_analytics(text, uuid)', '5a2ac6ca269b4118e4c6c87472dc34aa1671e3095fe9168b569d5e3f59a63b41'),
    ('public.queue_due_welcome_messages(uuid)', 'da011b73bf3212e205f7e719cdee5cdd88f31edbc33ce34edb45a47acd26492c'),
    ('public.uniondemo_remove_function_parity(uuid, text, text)', 'f71f82c9b00be4ea11700281d9ecda016066ea2ae1a4a2875becab6e4d880458'),
    ('public.dispatch_dues_reminder_attempt(uuid, integer, integer, text, text)', '23f105bd46fd59795c2d6bc6b59e3a25588e5d91e50691ecce6d3eaa6c33f9b3'),
    ('public.expire_notification_deliveries()', '5380997d947a51e67c2bc80d9667d6c2ce6c1f70aba80c2e792117f07270222f'),
    ('public.begin_mfa_reset(uuid)', '47367693d880b9c5e30c8eef2f0cd9b589b2b6ef78e0f69fbb07dca2645011ab'),
    ('public.register_chapter_task_file(uuid, text, text, bigint)', 'd5ccd6dc38e07efad6ea852ac21012db483abd66b765d651531433f85e0201d5'),
    ('public.abort_member_case_file_upload(uuid)', 'a9583d4c998c4e98bdd0b0cf0fca5b410b6a50211fe4d6cbc517c1abcc201ac4'),
    ('public.request_member_case_file_removal(uuid, uuid)', '1d97abc8cdef48553ce8793a9f40d9d5875ef009d591eaff57ed420876838462'),
    ('public.begin_chapter_task_file_upload(uuid, uuid, text, text, bigint)', '0a33e693c1d55945d34d1d0ac8b2920e8e708f6d4f0ef126149324f26973c8e7'),
    ('public.finalize_member_case_file_removal(uuid, uuid)', '0e1d7716377a182f7e208c18154ba9375796eb8335961055664e075d871733b8'),
    ('public.request_chapter_task_file_removal(uuid, uuid)', '734e873b37c6349fc25617aabc75cc375cbc55d06f58d223431ad272b6b00962'),
    ('public.reconcile_chapter_task_files(integer, jsonb)', '27cb0ef22e70d989b20c4ab186e9c554de3bc39befc86ee1576a20e34ca37ef0'),
    ('public.authorize_private_upload_inspection(text, uuid)', '3f545fe802bfdc85eeeed73cb8b9bc789973f0b99ac3ac4e81f632d7ed85d4a2'),
    ('public.confirm_chapter_task_file_upload(uuid)', 'a8a22f93b8e937209d38e24834c830372fa1fd91492978a4fba84cefbd5bccda'),
    ('public.submit_form(uuid)', 'cf667907568df0427c8b9187bba218acf0f816b3f7463e2809ef5bd6da5a07ae'),
    ('public.register_member_form_file(uuid, text, text, bigint)', '7f8c14350deee2d6133c5f0e305ac11e2cefed4bd6f71343adc4f8d77a74be96'),
    ('private.demo_seed_refresh_administrative_page_evidence()', '2681de48fea43f24491beee2d1be6ba8f73cbc49cd739b73a0bbc744b6c98786'),
    ('private.purge_deleted_chapter_tasks()', 'f36b61d965f77382228b0f62fc2697f25ce857f397be548767f0e7d97abd631b'),
    ('private.run_task_maintenance()', 'acccca011dd55b02bc48b3fcc10cb2915d3538a76a4190e3536574ff418f366d'),
    ('private.refresh_task_assignee_names()', '7a64a3578c4cd5e424ffef5f43c3d5d23736a0bafc55c4916bc3e7051a03ac96'),
    ('private.audit_chapter_task_change()', 'd5b9098f32c83d20f5fa68030e4028306ce2e9ec75a15d055c6450decfae0303'),
    ('private.demo_seed_apply_voice_parity(text, uuid)', '743f000291d0c0de5a2be31fcb18b83c391c8b9d91c90ba02422e803b9e93443'),
    ('public.execute_organization_retention_run(uuid)', 'cfdd741754f71749e4bb44a4fe0a2ba32e2e6ce1ba29b95a68ea4dfc2aab5af1'),
    ('private.demo_seed_remove_function_parity(text, uuid)', '612ccda91d420c90db23042e04c399fc296191983dc5d3b9eb3ec4a6aa33a2da'),
    ('private.demo_seed_apply_dues(text, uuid)', '8fe456bd99e2a3417300c5ccfca833401d490d28d6518d478ffeb2464cdddc90'),
    ('private.demo_seed_coordination_page_evidence()', '5e489216fe80f995ad8ea3edb10923ebc93d22257c32cb19eb833152110f0aff'),
    ('public.rollback_organization_automation_run(uuid, text)', '26375df1e1b79c7f6f7da995dfa6a6a5769106d457781afcec74e096061358ca'),
    ('private.cr108_execute_run(uuid)', '41030b182d45a45c3d7046888d5478c376227f8abe585917c3115c1325cdccad'),
    ('private.run_due_organization_automations(integer)', '198cd9aabfecd3a739b58e2b7dc91604390714bed725fff0d607a155b17cc28a'),
    ('public.execute_organization_automation_run(uuid, text)', 'b6fcf8b21e04a5407ad16f6d48c506135c583cd8e2b56ca349c206adbb38aaa7'),
    ('private.demo_seed_apply_knowledge_library(text, uuid)', '2173e57f8fb0f247b91026b442bc11fa6c6566b6406fdff513cc349791ec431c'),
    ('public.alert_member_emergency_steward(text, integer[], text, uuid)', '16daac5fd39b1e701474f60b09a25b1b97ccedd83a58e96d66c8777056a56552'),
    ('private.demo_seed_remove_knowledge_library(text, uuid)', '309cf56ed578a6aa699c008af7be017ee4c4d2a3b0e191d48b02fa6b7394f100'),
    ('public.activate_mi1_knowledge_sample(text, uuid, text, text)', 'cd390e586897b0a30f7c64cc13330e4ec93bf4965dbfe1a4e4e6bb3031be6d0d'),
    ('public.remove_mi1_knowledge_sample(text, uuid, text, text)', '248c522946a82263ac5def54118f90fcd1fc156350e010e32d564ea704c75463'),
    ('private.demo_seed_refresh_voice_quarterly_windows()', '764a8de1c6e14f5e37e760cbedc38c9765bdc606a0714b77a0cafeada9ff5d11'),
    ('private.demo_seed_ensure_voice_operations_refresh()', '01c9f2b3ef87e022cb93823fb59260bdc34d1714768e57198897164b442535f5'),
    ('private.demo_seed_refresh_voice_page_evidence()', 'c24e07cfd5fe5b47703e50211d476d6f2adda68b2479884bf209881850405bd3'),
    ('private.demo_seed_record_page_evidence(text, uuid, uuid, uuid, uuid, uuid)', '3e48520375a13977a79f1d842ce072981c9a141449ea2caff550bbd4027ef7de'),
    ('private.demo_seed_member_operations_from_evidence()', 'fed19e64451cc47b93f6464aeb6c6f8a8844445b30ad492a1ed2025a254b1f30'),
    ('private.perform_organization_retention_run(uuid)', 'd07bfe8d25f657845a81daf48610d84df5aab2369429d6b82668816fd229cc1e'),
    ('private.run_due_organization_retention_jobs(integer)', 'b6ba956f1277de9950853bd4a84ffbbea2fa7ce2dc58516a8050e129070bdc2b'),
    ('private.demo_seed_remove_dues(text, uuid)', '0eb7ed2f24496eff7701a206ebc3623fd79aab18655d250a20efc2a206c74970'),
    ('public.authorize_dues_sample_seed(text, text, text, uuid, text)', '65ccf3ba70a03eef158a4490da9514b57986e56c749c08a1217112ba8f2868b3'),
    ('public.finalize_chapter_task_file_removal(uuid, uuid)', 'a2e12c45f5411e8804a08e62687d2d3f6c5b2b5a1af8f0e7682758e9ea296188'),
    ('public.retract_member_broadcast(text)', 'c28b3b6603e83a90cc841c158b165541ab84b7bf0a1b9c2ec06e85ea5c4b6249'),
    ('public.save_member_guide_exchange(uuid,text,text,jsonb)', '468a47c1e496ed14e268d18e5768d27bdab1e1c761dd3ce1fbfce3392937d50b'),
    ('public.deactivate_form_template(text)', '0e24f176e95df59465115fb6b8b1ac0ef81bcd5610d375ad74f445c4677bf8ea'),
    ('public.reactivate_form_template(text)', '22c12e7088fbfcb6b1af28b8759aec1ca93cdba152c21e04f525fb4e79f5de24'),
    ('public.release_member_ai_request(uuid)', '5d5a156840bef75fab500affe72ff6bbc642dfba44f1358666a580984a986d4f'),
    ('public.reserve_member_ai_request(uuid)', '0eda210d5966610157cfeddb612755aa81f2bd82977364a638451d4b71f54ecb'),
    ('public.mark_appointment_outcome(uuid,text)', '3af45d283e4593e9a39a8ac02f0d2d66bb31b4958f1dde56657dbda0b03cd1e7'),
    ('public.rotate_calendar_feed_token()', '856e9ef8552e568af1297fd0703875dabf5a8a7606e336ab2285852c23cf341c'),
    ('public.record_mfa_reset(uuid,integer)', '10880e34d935ed03aa0cc6a43aa8bcf4268f7a1358f8ffea1459ce477db5cf13'),
    ('public.revoke_calendar_feed_token()', '69855073de527f5426858a12c2cb6e0c06a7c4f24a90a3739810fae4832a8995'),
    ('private.award_steward_interaction()', '9a4232e4e7927776570070b6b5ce2c897253388cfcbba5596a01b7b06f7faa48'),
    ('private.demo_seed_sync_administrative_evidence()', '841bed4ab11d76b572f15529d75cf8c3b7f0d7e75db5de6052429e6c3e63bc2d'),
    ('public.send_steward_reply(uuid,text)', '46923ea6683467511d8f0ec01fe7b03ae5f014185a78fa2a7fe96c581213bb1a'),
    ('public.upsert_form_template(text,text,text,text,text,text,integer,smallint,boolean,jsonb)', '8c4caedb66f33b8799e5790d5047a352c2376904a352d5bef255dedfde8df707'),
    ('private.enforce_push_subscription_cap()', 'cf1dab88469966c76a17c9b4b4cefd10401a716e7d0940a73609b7bbaf0b5a26'),
    ('private.award_member_points()', 'cccc442fa30b7914d353538fe33910307aede67413ef8c178c301c13413e7777'),
    ('public.save_vote_campaign_draft(text,text,text,text,text,timestamp with time zone,integer,text,text,jsonb)', '65a5a1e69f71aeddba5dedcb24023ab34174d6f4a75d27d67456f3c346acec42'),
    ('private.mix_member_ballot_choices()', '9b1b663a2537976f8397fcfdc289dc37c3ff0393bd0c155b41dbad7f79d2eb83'),
    ('private.mix_recent_ballot_choices()', '492f89b6a06e183e60850a03d2991cf9a5e483816d370045505a30b78f090342'),
    ('public.reserve_member_ai_request_v2(uuid)', 'dd028fdc17efdf1619fd3ad35cd0825b01945981e9ee8b6865bdad0e56b262fd'),
    ('public.grant_reward(uuid,text,text)', 'a1d4b8fe48ead8d1c6634fc18b93ddfbf38d8ee79140053284d72d299c04717e'),
    ('public.revoke_reward(uuid,text)', '16174aa7042f8cc13fd917c795e100c18141b2806f507e249d318835327d266b'),
    ('public.request_calendar_connection(text)', 'd1371774c909164548ccd54a22611b8e36ed9ce433769a4ba956a988245cdada'),
    ('public.request_dues_stripe_connection(text)', '1c29507409a3bb76ebd43011ceba1c8330ec057222d415e507291b6c33f4c610'),
    ('public.set_appointment_schedule(text,integer,integer,integer,integer,boolean)', '278078c8ead3ae1d212541c7b2bb8d0df7bcfe3c4e183298befa757b2ab7fa98'),
    ('public.set_appointment_windows(jsonb)', '27ce8a447e22083d458bfa4e99135fe6d4d71114063b7e8f092444fb254824f9'),
    ('public.add_appointment_blackout(date,date)', '7a535d7611284459cdeae8d24c62f93b5e0a40a1edc48b1c76f92394a2591b53'),
    ('public.remove_appointment_blackout(uuid)', '6752fce1f56186d498c2c752fa855d3d6d89c5003c71bbe0d332f31142667bff'),
    ('public.set_calendar_busy(uuid,text,jsonb)', 'c77acf230eb66ba83d6b1952cb13258891e0be3305019ab46a343fed27c006ee'),
    ('private.sync_chapter_task_primary_assignment()', '7478300f3cbee6b8dd419ad1b292481be6e25b2cf6bb23b1728c52dae9da5a16'),
    ('public.set_chapter_space_member(uuid,uuid,boolean)', 'c82f833d6759f9d48bec3bc8c56dc730646f1ba8633bb0c27e0022e727ac3ecc'),
    ('private.issue_ballot_receipt(text,uuid)', 'b2cfc250ed3b93a3a8a97a57583b5e871454373225514952e332d2dec6df9552'),
    ('public.submit_ballot_vote(text,text)', 'adc02b5826169d5b390fb9a4658992ba82b4ea7ecde44b7ec794c50eff42632d'),
    ('private.preserve_member_reward_tier()', '18c7ac7d6437951b8582ca6077787f3eecb3ff822470e38e62532c3ce6bb1a51'),
    ('public.set_reward_shipping_address(uuid,text)', 'da7f58e9b50e6161a0a73cdada5dfced4a4355c1d6baa064de996fcbe54aec7d'),
    ('public.delete_member_event(text)', '53991a286c25ebf5cc73844bd50f9c940969ff081d5d3ac9c37f1daf1644df16'),
    ('public.claim_reward(text,text,text)', '6585e804d5abf466aaa528c3bdddce06d3fb5e8b12c014b7fdf829c9502435db'),
    ('public.fulfill_reward(uuid,text,text)', '4446414ad776430a0e7b3a20cb5bc25cda5f73f687d834d0388bc41e0aa6825d'),
    ('public.close_admin_governance_request(uuid,text,text)', '4f72f0053626b0cc2e501c927b4aff617b2be7f1804a14817b44e927173d973d'),
    ('public.save_my_report_preferences(jsonb)', 'f1c0b179f7b622af0bb0425ae5fcd03bcd4cdf4450a6f60aa2ffd9ec675a17ef'),
    ('public.update_chapter_space_content(uuid,text,text,text,boolean)', '821cfdd47add39f78300e664fc5bd7dd4a5cb98c9cf438272337cdef61bc00e5'),
    ('public.set_staff_mfa_policy(boolean)', '2395547e676888d51af7a0e7cf12c1fbe895ec8f8f1a02460bb89d443f9afb13'),
    ('private.audit_member_invitation(uuid,text,uuid,text,jsonb)', 'ccbd9930ce33a84727b0bd32e83f68aa2f69f707937afd076093c942be368c35'),
    ('public.create_integration_api_key(text,text,text)', 'c6e1b40caf42e929cdf4cfffc97059778565302836cc0485bf2a908abec40661'),
    ('public.revoke_integration_api_key(uuid)', 'c1d8f3cdaa946d071e4baadb42265cb4908e3b69eee1754d4c10776c28f63cd4'),
    ('public.record_organization_audit_event(uuid,text,text,text,text,text,uuid,jsonb)', '916c5594b3986d510c8e05ab1dc03fd91281f290d4fc561b0351e9b955d35e9f'),
    ('public.claim_member_invitation(text)', 'b2bfecd975423c3f1e676430fee00a2be6aef39a4fbc45e56e1c02497d1e126f'),
    ('public.set_compass_ai_enabled(boolean)', '5467eb937c06d97dcf73db92eb7b71fb5ebdf7c5824b3611b8c805c193882f6f'),
    ('public.set_compass_ai_role_limit(text,integer)', 'c968784aac293d912b6de431ecea278bf77d37c2c34d1d6378eaae143dc93cc7'),
    ('public.attest_compass_ai_provider(text,timestamp with time zone,boolean,boolean,text)', '94b112aecc94972371c409b8e167989fdfad93e65fb3c03669d5e8771e991c8e'),
    ('public.fail_member_signin_recovery(uuid,text)', '5c44b4744f7ae952b2757126b0a150ea7e527f5830800952e17c4fd077e311f2'),
    ('public.upsert_push_subscription(text,text,text)', 'd02b9b72e5f6214b20d4502f277dfaef2c5cffe9799947f5295da93d8973d365'),
    ('public.uniondemo_seed_org(uuid,integer,text,text)', 'f0d8bfb0d1611b8ebc97b9ac11e9c72941a024aae4c0c42fcf1685a6c13a75e1'),
    ('public.revoke_my_session(text)', '0680e48846b1ced1dcc4ed503caf9557a3493aa98094e6eca8d86ee4ac6cb2fe'),
    ('public.submit_survey_response(text,text)', '0e7ba02e60ca0e3b1e087fd50cd1bd89e1ab94461d168a16f727c2d15ea782ba'),
    ('public.publish_vote_campaign(text,text)', '32cb8de807d10b6987e1ee6f7048526cd0c29c0b58815fe664788b9e389febf6'),
    ('public.close_vote_campaign(text,text)', 'a1e01842dc077edbe3faf97f586173952964a83dadac1713edede5a42a91c53e'),
    ('public.submit_weekly_question(text)', '892a6ce22f1f32e787ba377c938a9856b9399e8e2566d0f437dd20f3de7e19fb'),
    ('public.save_reward_point_rule(text,integer,integer)', 'e53ea6792b78c82d7446e50831030854bdf23d1b3fed67e6784f24c26bb6a131'),
    ('public.save_reward_item(text,text,text,text,text,smallint,text,integer,boolean,text,jsonb)', '17f9c6262bebb4023b6b7ca4a9b817ca9aa38f59e8ebf5e95a33c03e83482f77'),
    ('public.authorize_compass_ai_dispatch(uuid,uuid,text,text,boolean,boolean)', 'd7ef2f177515e87d83f7f8a780b9eaa506592b999d60e10c834fec830c8c4413'),
    ('public.cancel_scheduled_member_message(uuid)', '4431572f8a7f9265a57806db5a7a4da8ec0cd9f36fc2675d166dfd46cc9d70eb'),
    ('public.request_event_checkin_token(text)', '2b7f3afe35fd14f7108358f805ff1533df585fdce350acdeffe1f876230b0f79'),
    ('public.schedule_member_message(uuid,text,timestamp with time zone)', '203989e0677a366b3f48caeaf8179fb21dcc3294e3990856e04d6c2c86523261'),
    ('public.send_steward_resource(uuid,uuid,text)', '59f505a2743ade8c96ab7bc6376f3cec441f573ea18659111b7892f5395608b9'),
    ('public.create_member_contact_note(uuid,text,uuid)', '5eb1a5fc0909c044f7d75dc9d158ffc24e9f14a40d59f6b3ff8f98a3ef081ec1'),
    ('public.consume_dues_stripe_oauth_state(text,text)', 'e105d54ed75f0ba2363c72f5607dcd0c8f7c333a1ef6be7f05c042cee9592458'),
    ('public.record_dues_stripe_oauth_exchange(text,text,text)', '1460a264458f682bbf9ea0bdd4a5683b180b50511b4d0d8b3c3ddd740701a00e'),
    ('public.finalize_dues_stripe_oauth_state(text,text,text,boolean,boolean)', '99fdf2ecb027dc2670f4fd44662958b33c9d9e3d1ce93a69925861e05815f479'),
    ('public.ingest_steward_email(text,text,text,text,text,timestamp with time zone)', '04a2265e983f6923fc3deecc1779337f44168f761a7db555e3dedcf11eb1b483'),
    ('public.review_steward_email_intake(uuid,text)', 'a69ac871eba345451d8e572255270dd26fb508105e73f1ca8f621e5c60e3ba20'),
    ('public.set_workload_reminder_preferences(boolean,text,integer,integer,text)', '788426603e84cbe9a7991a27bc6ddb1aee62b29d8c2f1c0edc444801009dbdd3'),
    ('public.save_compass_workspace_preferences(jsonb,jsonb)', 'dbcffd0705ba08841823deed22bd20680c52dcba4cf913985ed659d6281becf6'),
    ('public.transition_organization_live_poll(uuid,text)', 'bdea7893e5e51b733d229a3fc624b0c80d86e2f83bde72eb8b0b8b8e1d9e5371'),
    ('private.capture_assurance_synthetic_account()', '3c2bb2b20d210f568c9a7cb342b277a9632ac01a831da102f48cc455da49c3ab'),
    ('public.create_admin_chapter(text,text,text,integer)', '3f6a4b5a8416a9ef8316c4a28c19d5935bacb282d41d6dd4f8e13d05dbf7bb10'),
    ('private.sync_member_peer_contact_key()', 'd3915d200989c647d84bfa25e38a8453bd686e6e960808ed7be63515275c4e3f'),
    ('public.send_reward_peer_message(uuid,text)', '6b94a9117e5db9fec2d44756341125818374b4075c510f28f1ace06399f16e6e'),
    ('public.update_chapter_document_content(uuid,text,text,text,text,text,text)', 'a2736b50551fa2b317e46dcd955d98b0703ccb60f2d709700a5450384e714211'),
    ('private.audit_member_native_push_installation()', '1f69d4706268550bd0da20cac314fc9fc85ca0cb453fcfa59817d49fe8c833ed'),
    ('public.prune_native_push_installation(uuid,text,text,text)', 'f85899fe08fad5bb29909bc621438579364af66bc2e23bcd293f562060daf5fb'),
    ('public.prune_stale_native_push_installations(timestamp with time zone,integer)', '3e9e7dd473aae8060bf9d0f50ce67fedb272e35b8dc81019e5b877a0af8132f4'),
    ('public.mark_chapter_space_read(uuid)', 'b246a20a37f75fc3c76d0956b55ed09c62479f48fd5924f26201abe72df60f8f'),
    ('public.set_my_chapter_pin(text,boolean)', '393420353fb5069f6b7a000762dd5f764df315e445a34530ceb5fe83896feffe'),
    ('public.delete_steward_calendar_oauth_token(uuid,text)', '3f888de31accf471273e09d35260e599ae1f40ba14fa117590d19ace07369caa'),
    ('public.update_contract_clause(uuid,uuid,text,text,text,text,text,text,text[],integer)', '4bc833b4d3a65a7104e46fb0ff91dcd1a9764d458a534894b27f814d3922c033'),
    ('public.set_contract_clause_status(uuid,uuid,text)', 'a78214ccf2c7440a48c9342076179de3dbbd3c27bb3a14f32b9573e336c42ea3'),
    ('public.record_member_access_event(uuid,uuid,text,text,text)', '5a530dac27eaab57bc5f118cd61ec9bf61faff7b18f33b67424cfaccd1f67fc1'),
    ('public.set_member_chapter_role(uuid,text,text,boolean)', '43674c24836888c59aa19df68dfa7087d3513df2c18317b825dd744d4ac707a9'),
    ('public.fail_member_invitation_accept(uuid,text)', 'e538b9a9807349587d650a62a57c1c0d64161111f36071b8879260f26e53f59e'),
    ('public.request_chapter_union_org_binding(text)', '996592ed4530c3c17d3087209726b0ee9c5eb178a4a97af4662943b53044ecba'),
    ('public.share_chapter_handshake_document(uuid,uuid,uuid)', 'a550175075998d1ec6b79dfe4795ceab844c2df1bb20824c34bee7778f4f88d4'),
    ('public.record_chapter_health_snapshot(text,date,integer,integer,integer,integer,integer,integer)', 'a5634905d3bf0f5692487aaa24a8f0ff1a3d43853e229534a55d1a7a41f03f06'),
    ('public.add_chapter_health_coaching(text,text,text,text)', '8790d40a58b24d8f617f9199d4250a992066a2c78049fa692e1ba1a745680e72'),
    ('public.request_chapter_connection_setup(text,text)', '8efd77c3198156828e690c88dad38ef2603b86cc636a610978b6c0e56c1e81cb'),
    ('public.verify_chapter_union_org_binding(text,text,boolean,text)', '39eefe262df93f61894285e1f850036c1761c16769f14f2c7f9136edaf9aa3da'),
    ('public.set_my_sms_consent(text,boolean)', '98b8684976aeb3d9057f236159c201fc956b01b3bf51055c37ba7af18da66f6f'),
    ('public.verify_chapter_connection_setup(text,text,text,text)', 'ecb58aa126350cec9ce5fe588d6c5d235a9b390faf5d4558cd0130e17a802317'),
    ('private.mi1_write_tenant_audit(uuid,text,jsonb)', '86775f11ee04e7233900c5a10af3b80e50e14332ec67b45b8465bd8ce9a1e58e'),
    ('public.fail_member_password_reissue(uuid,text)', '1d57f2984f31f57d705de95eba075dc6a51b35e6fb65233e0befec4a77023417'),
    ('private.revoke_organization_role_grants_on_membership_revoke()', '401005603e6d23259a27d26380e3632879c60f3fdac66d2c2a84e820d571dd05'),
    ('public.set_member_organization_role(uuid,text,boolean)', '329b9f39d4cdcbb195f0d94632c6829757659c4e72c2ca0f735264e758d752fa'),
    ('public.update_admin_chapter(text,text,text,integer)', '5096fe1dc8790c869e6c4dc43d8caf1dd13128f48738e1c13979d5c7a6c48a50'),
    ('public.publish_member_broadcast(text,text,text,text)', '62097e6ae53662d6ed1452dad3e30222470d38705f937bc22aa2ac4244526daf'),
    ('public.claim_reward_without_shipping_legacy(text,text)', 'b86655ad5da6ec796daaa26118f5568926f2e72ec33a758279605a0bc9cfd525'),
    ('public.fulfill_reward_without_evidence_legacy(uuid)', '413a99c211e9883de7b4dc90d8950c40f6b8090cc5c7addb95c66f26d76adadc'),
    ('public.reply_member_qa_official(uuid,text,uuid)', '09cbfb0500c781b4013b9464ad19c9b79b89816e48b569e3d56a77d32d9a1acc'),
    ('public.ask_member_qa_question(text,text,uuid)', 'ff1d8922d869584756b66a72d6d55febd9acb66030b6efffcb06586f5d30e433'),
    ('public.edit_member_qa_question(uuid,text,text)', '8cf01f0ba608d1b7b71e86d1c521f7debe8a95b855971a06383f8ff2a7adb5e1'),
    ('public.delete_member_qa_question(uuid)', '23f43106960359b24eda662cff99d97dd690e84ed259a61b563d83b783904e93'),
    ('public.edit_member_qa_reply(uuid,text)', 'e581b38d481e7999ef9cead0a9e0f5a27db1a35f53eaf4ee5e271a02a44f536b'),
    ('public.set_integration_webhook_active(uuid,boolean)', '28a3f4cace87c2237dea2ee391075c08f457477c3607562de61a6df09b69fea0'),
    ('public.upsert_pay_scale_grade(uuid,text,text,text,integer,text)', 'cd69dcc0a4b717628eb240177131b8ef5578299f9c41207c216407a51b3ed59b'),
    ('public.upsert_pay_scale_step(uuid,text,date,integer,integer)', '81af68476cc05bf957ea80a1d8b4bdea23717bf3ce8711680e990fb0c5068ab9'),
    ('public.rotate_integration_api_key(uuid,text,text)', '27d254bea178c620bf1af57b1d454680233603bffd24a53a24c76d3fb570c347'),
    ('private.mi1_w2_replace_survey_questions(uuid,uuid,jsonb)', '3c78c9e6970f5e9069b78724679cb1ef019f9dd4a18c7654c614e72098cdf7a7'),
    ('private.mi1_w2_upsert_survey_session(uuid,jsonb,boolean)', '9e3ac4b88f117d95da689fd42debb2c65ef76e2715d029d5962f24b52d49a073'),
    ('public.authenticate_integration_api_key(text)', '7afb9827b8ad2e1868c6c888f6b3510f60983ac1b48093ec3b2896c190d06d02'),
    ('public.download_steward_library_file(uuid)', '76609026c54a889b1c23aff5b9e6924c491e44aa3ebd11363e91fad73c433511'),
    ('private.mi1_w2_write_audit(uuid,text,jsonb)', '49946b3481ccb6f03189712f737ae0ee72069ffa1e1486561fad6b7efc0b4492'),
    ('private.mi1_w2_download_knowledge_file(uuid,boolean)', '9b610a7f776612c0f8bb771b2d29a1702a7a8d7ac9668ffc5576291ea40509bc'),
    ('private.mi1_w2_resolve_handoff(uuid,text)', '3e19f54ce4be12e33661b952c6da0e792cecfc952a288fa43a2e80c1efe3ded3'),
    ('public.download_resource_catalog_item(uuid)', '0e384f40a5a5ae7ea49657cbce6629840208074abb00901164889104cf8b43c6'),
    ('public.publish_organization_survey(jsonb)', '56245489e19adfeaacedff869658bd2f3df83d6a56b0a05bcf4960c46e98a6ed'),
    ('public.save_organization_survey_draft(jsonb)', 'aba6798c9e1a74047b09efb6382c18f8a1d55e401d87bbb581cdfe0ddd8fcddf'),
    ('public.close_organization_survey(uuid)', '8c10bc16a3c5e3faea83fd8c81fc7e07bebc09be0889da6c2499a7f01d699346'),
    ('public.reopen_organization_survey(uuid)', '633650b927086b4a35dbbc83fd5ffcf9e05babf2af8e685bba396ca33031bef7'),
    ('public.save_organization_survey_session(uuid,jsonb)', '551053413b8d3289dfdb871697a2c2e7339991a90300c3a01fe9020d4a259875'),
    ('public.submit_organization_survey_session(uuid,jsonb)', '686a11c46d65af11f18d31c5acaf8b253d763cf6211abfe4caeec0a2fa4ea5c6'),
    ('public.clear_knowledge_ingest_source_chunks(uuid,uuid)', 'da451c691295773b9f92efd2069ff8a81767d1072690d5a304e7b950949b4cea'),
    ('public.publish_steward_file_to_catalog(uuid,text,uuid)', '709936d3d619b307243ad1a53afdc326017b0a49ba8986530cc95d656634f991'),
    ('public.acknowledge_member_handoff(uuid)', '5c355cd8202c0a55e39bf8c4756fddd41f4c2956a330396dc056673d8c954034'),
    ('public.decline_member_handoff(uuid)', '572afaaefe143ed0caf48137366cd9cd3f571a5ffe5a22bfb1c32d297684ffa5'),
    ('public.cancel_member_handoff(uuid)', 'd1d46e7bd2f04c8071b9b31566cfc2edbf2aa3e7966dc9694ecdce8423e9d64e'),
    ('public.delete_integration_webhook(uuid)', '25e3445817f1b4f7978f679bd7f04f1eec541403064bb0aadaf79364328a9b18'),
    ('public.upsert_chapter_integration_override(text,text,text,jsonb,text)', '5a7a101f0a56c59548616fa62fc567c194a6d9af97eb1548850371d61c0c44d2'),
    ('public.enqueue_integration_job(text,text,text)', '8e66363bfdd0dbccf9e1c820c93efb3df17c54e8c37a9ef095dea184d510b1fc'),
    ('public.run_next_integration_job()', '26d34219813694a3be9b03c8701d005715167ee8080fb902151edaf6b8312064'),
    ('public.retry_integration_job(uuid)', '1ee08d08dfedb515c2dea515c3fd49c32ff9dc37fb6e6e504b9518f891894f2e'),
    ('public.enqueue_integration_webhook_test(uuid,text,text)', 'ac024b2c32b0a0aa52572d7727de44f02017f8c6b83aef9bbbdc01f77ab76c60'),
    ('public.record_integration_webhook_delivery(uuid,integer,text,text,text)', '2bf6a2a0e67b690515aa4eda62ec1317226b852623801f1a754fd656ad2e4c71'),
    ('private.mi1_reap_expired_webhook_final_attempts()', '1f47a51b9256add3a27756b40b9999eb3f03d7cb410b2e2775b68cf43d5700b4'),
    ('public.claim_integration_webhook_deliveries(integer)', 'fcd514d498cfcc25f8de05f5d03f446be8b20c261d7423a73d5d86514e092000'),
    ('public.claim_integration_webhook_delivery(uuid)', '2fab89fd930bc557e466816abf8012a223e1cf464e94687d0c0e0d5882353862'),
    ('public.set_integration_chapter_controls(text,boolean,text[])', '7193df1b430fcaec3d0816ef7136c9d02ae50066540e097e233c577dfd8e3ff3'),
    ('public.initiate_member_handoff(uuid,uuid,text,uuid)', '6ca511ca6cab4f3b4a217ba380ab69d64c4aeecc986d88e1c1a6f9e373aaefc8'),
    ('public.upsert_organization_integration(text,text,text,boolean,boolean,text[],jsonb,text)', '6c8dbec1b8ec1378309054c23414687d2df42f476cbe5021d6bdf0840d08390b'),
    ('public.delete_member_qa_reply(uuid)', 'af812ed28b5e3f41453277a103a064c3117970ce6a76160b44c3175cc16a111d'),
    ('public.acknowledge_organization_job_run(text,text)', '1a790255e3480b8e8cd54566c06512c53e9da1748931929d2b2ce19f657a1a1b'),
    ('public.request_organization_job_retry(text,text)', '0186cdb594f185ed2a9d6afd3600063b4aecdd9ee4e2e39c53eb74afd1c3453c'),
    ('private.purge_expired_public_event_rsvps()', '85298a03c36986cd7ebd932174255a1c1ddf3add0dbbe186b8dc2941eb76d903'),
    ('public.get_organization_analytics_snapshot()', 'c7d65335be5bfca45d910893c146bc6aa2e011b59b9abcb56c9eb38f423dff63'),
    ('public.request_organization_analytics_export(text,integer,integer)', '69c6647428370b9a037b9bdcc66857b455ebf5ee740d13ced042d2054a857d96'),
    ('public.retry_knowledge_ingest_source(uuid,uuid)', '8fa325f9e3e10ed276ee9a77621b019d5462a283023827158ada189653617e4e'),
    ('public.create_integration_webhook(text,text[])', '9bc9aab961922053ca673b21dd4f7977efd5e2dc41e59fa02af4feb96fb80f3c'),
    ('private.mi1_w2_bind_operation_receipt()', 'd2fff944a3288e631c0a4f557fba20a4eb1786935ea0126c6f1d705a007283df'),
    ('public.toggle_member_qa_vote(text,uuid,boolean)', '8d25f341752722b6fcbb8803b95769809bfc3ab1d789118a41e884ca8626f516'),
    ('public.submit_public_event_rsvp(text,text,text,text,text,text,text,text)', '8405d8a28e947cf7f37df8fcf1539535fc08adf51cee9b23ab7180fe7358a96d'),
    ('public.rotate_integration_webhook_secret(uuid)', '9ed14eb735b3343d606da9410a446a664b777dbb49ba913782d9573f84ff5f94'),
    ('public.accept_member_qa_answer(uuid,uuid,boolean,timestamp with time zone)', 'd9a46b0378635c3a0e9064718dcf2f0b2ea210dae4cdf79bec9545e60c32f04d'),
    ('private.sync_organization_job_runs_from_cron_history()', '822d3b6fb90f26acfbec706853f22ebdecd7d65397a4148546c2646453864cab'),
    ('private.demo_seed_retention_engine(text,uuid,text,text)', '0c491f1ae68872184a65af241677dadf67c6009b8d94c2cea6ed72c18804d62c'),
    ('private.demo_seed_remove_retention_engine(text,uuid)', '42bce8f533080c4a80183c062d88d3b409518fcd662da01bd6a61a6177557c75'),
    ('public.reply_member_qa_follow_up(uuid,text,uuid)', 'c5be50196e8a2ed4c123ebce06628e0b9d266de2a460a2cfd6e0fe1edbe60225'),
    ('public.presg_demo_seed_org(uuid,text,text)', 'd133aba9ca57a2be2a239436ba0ec8f19c5a293490e97e7674061b9f85f92ec0'),
    ('public.claim_dues_stripe_disconnect_reconciliations(integer,uuid)', '2b9a34ddf2058907d455715abfd6c8c03c25be7c6074cbf241e0fb2df99fb91e'),
    ('public.claim_dues_stripe_disconnect_accounts(integer,uuid)', 'a26a339342a4b033f8efd566a1a65dc9204ffe347fcbf95abe0f53a27a6eb8e3'),
    ('public.complete_dues_stripe_disconnect(text,integer,uuid,text,text)', '4b60625058b9b67a4a9ac9f36e7b0c81d5feff295d46e30a28bc63a7b8d42bf9'),
    ('public.create_contract_clause(uuid,text,text,text,text,text,text,text[],integer)', 'd870d9173df27fc27a6f664d59dd96f17ca1464fa66454f7995223b56152bbec'),
    ('private.on_organization_survey_submitted()', '6d667785aae44744689cfc2c442497e87e8aaaec9fbb30b3b8d14de9b3353562'),
    ('private.on_organization_live_poll_vote()', '096d90343799f0473bee0d9bd2b9b4895f705b554beae38950c1c61e7ce01979'),
    ('private.recalculate_organization_live_poll(uuid)', 'c0ded1a1f56f864819fc2b499ba9143f5bac3007acf8c85ccb175cab85c8e112'),
    ('private.dues_sample_remove_subjects_on_lane_removal()', '7a1e0c19ccb30e5805a4c01fccb6f573418c036a7d768cf1ba95fb7193945407'),
    ('private.queue_member_broadcast_delivery()', '19fb84c8b6e5907ea6be55efee5a7a43e93b3f70e1bb09bee8feddad7fdcd549'),
    ('public.claim_engagement_delivery_batch(uuid,integer,integer)', '649ac21a54005a2bc2203ff646f7b1095dbdd0e8bead8306388119be39196620'),
    ('public.complete_engagement_delivery(uuid,uuid,boolean,text,integer)', '95e84f2a32e2e00e69c3ecaddf82f9984822a2d3c48aa081a98169ccb7822a95'),
    ('public.configure_organization_survey_operations(uuid,jsonb)', '7173e849751d568da5d41709edf9d1aa9bdba1cd5d735cc7ac861adfbb15c96d'),
    ('public.queue_organization_survey_reminders(uuid)', '7f4b64065bfefd0d356cd6612c26cf5e4bd327063485f913ee1da385e03fb9f7'),
    ('public.respond_contextual_pulse(uuid,jsonb,boolean)', '67ffec4d61c28abc45d31a47510e9c321969093c9530f0cdf3148d7d8be6c6e7'),
    ('public.save_calendar_oauth_state(text,uuid,text,text,text,text,timestamp with time zone)', 'db7d6f2ad5c9d5d9f3feffd0c20ef28c6cb88a94e410858a3fd9fff92b32c245'),
    ('public.consume_calendar_oauth_state(text,text)', 'af03944154a0c93237d8619d4147a5bc3d3f4ab1f7e5e1ccb40273106bed57c2'),
    ('public.upsert_steward_calendar_oauth_token(uuid,text,text,text)', '0fd8e74878199d783c68e81c5ffa22120ff6b7a8abe1c049d445b1ad005d2ed6'),
    ('public.update_organization_survey_task(uuid,text,uuid,timestamp with time zone)', '5216ea808ef3a436acece6b56616a2779b9fa9720d80c9dbdcf9db687cbadb52'),
    ('public.update_organization_survey_review(uuid,text,uuid,text,timestamp with time zone)', 'b19a47d3a6d942512bad600d1e5e04cb3e390d62af9d5adf4662e64ac252e2d6'),
    ('public.save_organization_pulse_prompt(jsonb)', '4f454ed8b537e4e32cfe8d9848a42cdcaad0cb3ac537da4f9a0be8e3952c31f8'),
    ('public.save_organization_live_poll(jsonb)', '8d1935e39ad2d7b6c8370c7550378f3a48e8071b4c541cbb74a61b2d77252077'),
    ('public.set_organization_live_poll_roster(uuid,uuid[])', '6c6bcf4a8adefa60068b74f0f91a3c90fc57e1feb69616f2a58e31c9b5ea15cc'),
    ('public.rsvp_organization_live_poll(uuid,text)', '31958862b915f324397ce11a54045955c326a56bf34ea1a378cdbe58cc14a6a9'),
    ('public.check_in_organization_live_poll(uuid,uuid)', '63512c96a2bd1d1e6eff94e488d99517e31dfbfa711a07fb0477a1f05e31afe1'),
    ('public.cast_organization_live_poll_vote(uuid,uuid)', '63c4a038bde24395acb52870240966d1b61c1b652b7b14275bd70c352a254f7f'),
    ('public.set_chapter_space_controls(uuid,text,integer,boolean)', '37ca94136f63824745f6df104e34c2845372e422d54ddcf1254b9906a4cdbb3d'),
    ('public.propose_compass_workspace_action(text,text,text)', '6bfc9e1825dc0e1a748d92500a2730724ee9e53dc22d0d3e6ea10b9dbfeacecb'),
    ('public.set_organization_survey_privacy_floor(uuid,integer)', 'f46e6016d7346da0a9d3c23ecf80d85ef672b94ff71407325c90aa451078ca90'),
    ('public.submit_weekly_poll_question(text,jsonb)', '2937d26791e28635ef71192a8112c32d952031175197f38f8fac1f7310752690'),
    ('public.boost_weekly_question(uuid)', '535348cee11a612dea3b83bafd6922db53cbcbc893c84af1ab922c5b27971a92'),
    ('public.review_weekly_poll_question(uuid,text,text)', 'fe5fa43e47981af1c3728402e3d28910fdf8e371992eb8260da6d395a088e35b'),
    ('private.award_organization_mission_badges()', 'd264f7d3d5a21fed5f552c21ef5c80e380a9271f9d53dc47bfc499e81545edd9'),
    ('public.publish_weekly_poll_question(uuid,integer)', '5528fc0e08045349342ccfd3749e05cfa3fbb4a7ddbb9da49015c5c6ced01533'),
    ('public.get_organization_analytics_workspace()', 'ab07cc0134535699b4e9750a3e2048275de2bf6cf00a0b37e75c49f4ed1f2237'),
    ('public.save_organization_analytics_layout(uuid,text,text,text,jsonb,uuid)', '1331a7f355510c5a8d68afefb1b1f10b50a5667cafa0e03e34f429f852b45833'),
    ('public.delete_organization_analytics_layout(uuid,uuid)', 'a9f46c35ddb5adc3a21ff3978e795d2abe2e4cfef540a362e46d671a1e888ccd'),
    ('public.create_organization_coordination_record(text,text,text,text,uuid,uuid,text,jsonb,uuid)', '7060cc8f7f972d8c0baf2ea5c9693603c633d2d138f36d4adc3f903d5ec9a381'),
    ('public.join_organization_coordination_record(uuid,text,jsonb,uuid)', '9bea7e38334bfe330242d8882dec93503102fa2f12a0fe9a5c8350e255000194'),
    ('public.respond_organization_coordination_invitation(uuid,boolean,uuid)', '454c20c4721d6acc85cb44906a9b639e576e05972be17024e3d7e966a526d4ab'),
    ('public.share_organization_coordination_resource(uuid,text,text,uuid,uuid)', 'd47dac2cdbe894f3ed68f39001cf547939e1b7613fa0525ed04b1ec3d987932f'),
    ('public.record_organization_coordination_outreach(uuid,uuid,text,text,uuid)', '886f315956e3d3d858c127ddd33847bcad643183080f5675d8f713e01b32f98c'),
    ('public.set_organization_network_permission(uuid,uuid,text,boolean)', '80e81a332f0d95364c378f8f0c1c8e78bc7325c6ca0d2cbeabd07493595a9e13'),
    ('public.get_organization_coordination_extensions()', 'c812bef840835bcc4b13780e1f6be85bae1509a763b14f7f520b27e31db84144'),
    ('public.upsert_organization_network_profile(text,text,text,text,uuid)', '29dae92cf210a168ed73df5f90e87115e480848d41c82696b382cf639de1fefc'),
    ('private.engagement_heartbeat_member_presence_scoped(text)', '050fe5aa8fa66546db7ad2bef1b24759ef1e0440725512f93bed3453cfe3a5de'),
    ('public.invite_organization_coordination_participant(uuid,uuid,text,uuid)', 'ccde0a8fd264aa8b184ff60fb3865b8b942884b725e73230e07cb1c02ca4cb17'),
    ('public.respond_organization_coordination_participant(uuid,boolean,uuid)', 'f6b8b9e7a2f992654c76a9920ee6e14454e9d0d0fd4bb2408c73bbe1f06895ba'),
    ('public.respond_organization_coordination_resource(uuid,boolean,uuid)', 'cb015333f11b6734af8f79aeb8b47d4e08b6cb0e959c29bb7f39eed0f564da28'),
    ('public.take_over_organization_coordination_page(uuid,text,uuid)', '2478ea0df0a159ffc464a7b70019ee995ef141dae12da58f6385f0c6f89e4522'),
    ('public.assign_organization_coordination_participant(uuid,uuid,text,boolean,uuid)', '2480d10b1c36a5df3b844a0c977d3404fea1ff4eac458ef0b1629b6ba680ec2f'),
    ('public.review_organization_merge_match(uuid,uuid,uuid,text)', '94d33f6ba72cdb9da0b2d0fe50799b900868882540cfa1abe0de1a4e9e94ecbf'),
    ('public.execute_organization_merge_plan(uuid,uuid,uuid,uuid)', '1942d0aac8f55f834d75eb631e1d4c5aa55c6206ea85d74b2ab5381bf6c52315'),
    ('public.attach_organization_coordination_page_document(uuid,uuid,text)', '1c97665fb0aa27808686d57e5b89359ca3f0dd6d7a70a8938fcd82e411a3c2b7'),
    ('private.demo_seed_coordination_after_evidence_insert()', '493f569f64840f7d6cbb9fb7f61c66504147abba957de64b230181a19c077e77'),
    ('public.run_due_organization_coordination_exports(timestamp with time zone,integer)', 'e3ef04dfc075de85f740a93f05a81357e11600ae46b140d4a660440893473735'),
    ('private.inherit_organization_coordination_participants()', 'd5644b9510281139b6da4fd51c57e0fb502abeb2aefacaeb36e98ec60efd4bd8'),
    ('public.propose_organization_coalition_decision(uuid,uuid,text,text,text,integer,uuid)', 'fe6cfd0cb993eb80d35855478e1b55bf259bb02f2b2c027f1d32e0da22ada77c'),
    ('public.vote_organization_coalition_decision(uuid,text,text,uuid)', '70d1b73e071031c290230f52a5f8ee20094f74ceefa248bfcb63b5028fd7c917'),
    ('public.upsert_public_chapter_microsite_section(text,text,text,text,text,text,integer,boolean)', 'e0b188c8e49d514103c8f5a159e01bae5cf101a4a3010f33eba75e089776d16b'),
    ('public.upsert_public_chapter_microsite_page(text,text,text,text,text,text,text,integer,boolean)', '1e5300a919f4eb1a5c33316ccd2714317f035a18bd40718601ba65c50b9331c4'),
    ('public.attach_public_chapter_page_document(text,text,text,uuid,text)', '4f80fa8e35eb94ca39b19101af8bda9d4891f4f7998a3bfa62dff41a8f594fe7'),
    ('public.take_over_public_chapter_page(text,text,text,text,uuid)', '2deaec975543f796f051fb6bd0b7bd8af29b21010cbcde5556a37c353e03163e'),
    ('private.demo_seed_remove_organization_coordination(text,uuid)', '65a07fc1b84169cbcb2bfd6d7da7675598b4cac6b0329fb3a6606b59468e90d7'),
    ('private.demo_seed_apply_organization_coordination(text,uuid)', '7121c662f2ea656cef804af88fd8ded4e1cb8109fa7b556df4f959c80f70e247'),
    ('private.demo_seed_coordination_after_evidence_delete()', 'a8260d2cf8b3fc43407eab6cae057668149e53ccff7839720b889486ffacbd81'),
    ('public.transition_organization_coordination_record(uuid,text,jsonb,integer,uuid)', '562ddbe4ec63375ec8d0bb343568ed6937bcdf6cfc219a6a9d9a52ace3120152'),
    ('public.send_organization_coordination_message(uuid,text,uuid)', '31046d20f37245b016bcc2d473e24e2cc96a65ca69b8f5a7729a869092d05d6a'),
    ('public.run_organization_coordination_export(uuid,text,uuid)', '481031ee641a679aaa63da05f5acb8b40b642eb9bf1b9f15b970be6703c9d388'),
    ('public.update_organization_setting(text,jsonb)', 'eb678e0cfcf6edbe4aa9a58e9f1714bb4db8d10f657807063f69da872533f8a3'),
    ('public.update_organization_label(text,text)', '2c2dcc6a308ace34d5d54252d77de4f814a4678fbbe70d36af3e5bff6a5bf0ca'),
    ('public.generate_mfa_recovery_codes()', 'bd31ab5e6b93ce34e289c5dc39c45165fb00bc97361a9e82bc08d694ab143d95'),
    ('public.disposition_failed_login_attempt(uuid,text,text)', '506637d328d55f93b7da67051860d9334936e66c14e22d92f8c3bef51405b9ae'),
    ('public.record_failed_login_attempt(text,text,text,text)', 'de7cd2d74bac661a51f78a95a20a3b228a3058283d2f7ed241f6ca9af3ee4c0c'),
    ('private.demo_seed_apply_auth_operations(text,uuid,text,text)', 'f8b01a348415cbebf09337cace6e2b603a75d801c71901c5b0b103a80f7b44b0'),
    ('private.demo_seed_remove_auth_operations(text,uuid)', '3e56b7d3ecf88349c12f963c3e744bfafd3cb9d9d78dec2a55b441fe7c60d85b'),
    ('private.demo_seed_remove_voice_parity(text,uuid)', 'c7869dadccdf4795851be2b5facc53b508bc60d94babafaff293ec740d0fa626'),
    ('private.write_organization_intelligence_audit(uuid,text,text,text,jsonb)', 'd7639ebff26b4d286ac0de6594544b7931d62add0980f9e630dea3f15f05e66f'),
    ('public.save_organization_topic_progress(text,uuid,text,text,text,integer)', '2dc71b8986e6b7a7462e201e7b56e41db447e3bd899ac60fb64127150159b312'),
    ('public.toggle_digital_action_participation(uuid,text,boolean)', '57f88f3bf2da930ed8fd3f0a11a32c573d810dfc253291940d60505d8deedaf8'),
    ('public.save_organization_chart_node(text,uuid,text,text,uuid,text,text,text,integer,integer,integer)', '4a985ce0be417347fc7ae1077a6a2e352934e992ede7e669e6222ccfea9a6e3c'),
    ('public.save_organization_relationship(text,uuid,uuid,uuid,text,integer)', '232696dcf21fe4665fae5968978145b80b1e0a53d8b2b7fb3785af987b5c9311'),
    ('public.save_organization_timeline_event(text,uuid,text,text,text,text,date,date,bigint,text,text,date)', 'dc6473b14ad0e8048b97da6639ce2274aa08a78989bc788f2378c5f31c5deeb6'),
    ('public.save_digital_action(text,uuid,text,text,text,text,text,integer,timestamp with time zone,timestamp with time zone)', '20c11239370ef41cee1c665660d76958a51eab58ce23565d4db8144f37ca04f1'),
    ('public.request_digital_action_participant_export(text,uuid,text)', '8d9936e606f073ebfc585fa909f6c45f678204137ee97c9b1393980028603b5a'),
    ('private.demo_seed_apply_organization_intelligence_unwindowed_20260829(text,uuid)', '02ed465bd129821e0c6ba93dff7a98ce18aaf7d38cceb00862e40d37f2b3affb'),
    ('private.demo_seed_remove_organization_intelligence(text,uuid)', 'b0882864a86dd8a553e85b577ef9cbf908ab3f453929aadc463f1dec779902e0'),
    ('private.demo_seed_sync_organization_intelligence_evidence()', 'bb4d9aa9a0f30a0301f977812dd2671d9f546c8e90a4139985a8b70884edaff5'),
    ('private.engagement_evaluate_contextual_pulse_scoped(text,text)', '438f5a58e976128663eff8fb562e5a0250e911cf1c8595a112234491432040f3'),
    ('public.evaluate_contextual_pulse(text,text)', '599ee6aaed3ad047ff6e5e05663228187e545fbb3e4af3d8993a2b155d2647eb'),
    ('public.heartbeat_member_presence(text)', '985ffa0cedd3367a834c2148c637850e3c7f7086d8db2f27b940020ccf11a16d'),
    ('private.cr108_record_audit(uuid,text,text,text,text,uuid,jsonb,uuid)', '76795f9364823808663ccfd33635c7c418037588e2de8029dbba1f92b0fee480'),
    ('public.save_organization_automation_definition(uuid,text,text,integer,text,text,integer)', '16516f8f53867d49e45d8bfa53da14229c2916c43dfab203fbe60d711824a226'),
    ('public.set_organization_automation_definition_status(uuid,text,integer)', 'ff1141b9cde7b71cec0f2cc1e6c7c556d2cdd011e4a88f4dd6f5f5dfecb2ff1c'),
    ('public.set_organization_automation_enabled(boolean,text)', '987df551a61a5a8562b8a4c01c60983f3041eef478359d65b8d07866c5a2367a'),
    ('public.set_organization_automation_safety_cap(integer)', '59e56cd947cc9de2c67e526957dfdbaa6eb62559f55ec6432c84a8d08d23dfcf'),
    ('public.preview_organization_automation_run(uuid)', '2bf8e9f03446052c6b5c62023d2e25b1f4ca37641b5a537bb6d85377b5f78450'),
    ('private.member_support_record_event(uuid,uuid,uuid,text,uuid,text)', 'e0deb6dab8a3d739da81992e6eae22cbc02cafe55e753627ede66dee5e6a5ebe'),
    ('public.save_member_emergency_checklist(text,integer[],text,uuid)', '783f5e22f8b73e3122497176f06b62173d0ad4e2e72b7cbd51d0ba1121a4c357'),
    ('public.resolve_member_emergency_checklist(uuid,uuid)', '506e07f5d0070720a616d06cbba1f0299e0d82c3faad3fa47c8f8f9a67c51ba2'),
    ('private.demo_seed_remove_member_support(text,uuid)', 'cebd6a033bca252b78a23cc539af4d674f6b29f3b58a88f797fad05cdfc513b5'),
    ('private.demo_seed_apply_member_support(text,uuid)', 'b9281e2f58a74c6b91c5e74340f2c8e4ad883ae9116254231d83323a7a163558'),
    ('private.demo_seed_sync_member_support_evidence()', 'a86d594c9327a21f85c2de7b2d6283b386cb7392a67d1b3d06132a2852fee2af'),
    ('public.save_member_mentorship_goal(uuid,uuid,text,boolean,uuid)', '8cebdbd967efca75ee5c88428184bdaf8268951adedb65929f16b814a32d228e'),
    ('private.demo_seed_apply_organization_intelligence(text,uuid)', 'f47c80d3aec3eb66b9b723880791ac2c0c77065e1861da9ae63b02adcad39c57'),
    ('public.complete_steward_library_upload(uuid,uuid)', '16b2148c6e1cbd7ab73339b670a3fb12af7db193df9f2b63baf3527de40d644f'),
    ('public.get_knowledge_file_storage_target(uuid,uuid,text)', 'c915c075908fa41ef146b2c4ae648174ded43a9b11de3ab133f9c63d22c2e219'),
    ('public.begin_google_drive_oauth(text,text,text,timestamp with time zone)', 'f5f9fcd96e0f2e1a4c8df65ee8bd3479725c6fb1268e27ba5a471c83e88b1148'),
    ('public.cancel_steward_library_upload(uuid,uuid)', 'a4c250eab59d021f17fed09d1dcaf3d9025366c38d772b2559d4852a0fce8343'),
    ('public.authorize_google_drive_operation(text)', '17209f5dc1b5b4e2935bac337bc6a41ba4e874510a449342603b928e74cff974'),
    ('public.disconnect_google_drive()', '37764d61af302e368031acbced384168c8bad5c0e0ba8955915bef6bf99874c1'),
    ('public.claim_google_drive_oauth_state(text)', '2fd1302b8bbfdc695ea9a2085f07048abb16b2d74214d92175f9aff78cf01b26'),
    ('public.complete_google_drive_oauth(uuid,uuid,text,text,text,text)', '1e0b4d68fd895a5c46b4771234b6273e199f27f128133ab99aec8b50cac3a998'),
    ('public.create_member_accommodation_request(text,text,uuid)', '8ac04d965d692c9fb6743d775ae71e6e298c4a6ab39f176a2665e2bd58167c11'),
    ('public.transition_member_accommodation_request(uuid,text,text,uuid)', '4018b19acf15d431af5591754ddae0ab6325468cb24f9543ec575e342e0ed0cd'),
    ('public.record_member_hr_contact(uuid,text,text,text,text,timestamp with time zone,date,uuid)', '5f86529af842d734f1a0d31c4d608830d56c6ddb711d466b260aa1b883b0f242'),
    ('public.save_organization_hr_directory(text,text,text,text,text,text,text,boolean,uuid)', '415a38197dd83e715c2502b807c9134b78a79a4c05fba6e451310a66e949407c'),
    ('public.save_organization_onboarding_step(uuid,text,text,integer,boolean,uuid)', '00b6470f50bcb33b7bd093f8aa28736e5c57620f235bd7c1ec672915d3eac7fc'),
    ('private.demo_seed_archive_organization_on_remove()', '28d1e73a839e16e4db4f6968a37c82032cf1e29112253aba8955f88c5c0e7ea2'),
    ('public.start_member_onboarding_plan(uuid,uuid)', 'e2226457a6a3673b1862c2cc20ba65012a02c16c8390b47417ac49e41775101f'),
    ('public.complete_member_onboarding_step(uuid,uuid)', '57873c463a78674d61b0e394c1630011410826f55deb48932813567e0ed1f428'),
    ('public.create_member_mentorship_pair(uuid,uuid,date,uuid)', '83a7a2cd5febc2d9a5f327c859cd53eafc2e123a302e048b2210ce33313f00c9'),
    ('public.transition_member_mentorship_pair(uuid,text,text,uuid)', '8f635bdc235c6f140f64b429fb258b023021322e2df7c5aa64617e053e377e9c'),
    ('public.add_member_mentorship_note(uuid,text,uuid)', '5a56e53c44a1d26adcc409e4c43255358183568f4af56073496b7a89128b9059'),
    ('private.demo_seed_apply_voice_operations(text,uuid)', '48618018b928b8d85fd0672e3198c23532dc38c3c51762102ab9e79abc4d119c'),
    ('private.demo_seed_remove_voice_operations(text,uuid)', '9629538d1d262fefec742785d9363d41af3dff9a71a6306c0d85545e5323ba4f'),
    ('public.promote_weekly_question(uuid)', 'c66ae3539d43372dcff582298d20d563679b1c3f6df8e31fafcf4a8aad560a39'),
    ('public.request_filtered_organization_export(text[],text,timestamp with time zone,timestamp with time zone)', 'f9b79f908d64f060b62c04dfa1308e636bf553888e5850794fb9c8e0fbd7cb0e'),
    ('private.demo_seed_refresh_analytics_health(text,uuid)', '44eb187e20029f66da9f2db4ad5943dc486f7fd1025d2db7e89efee6838d3178'),
    ('private.demo_seed_rotate_analytics_health()', 'fee50fe519d5b9ac1729f5983e6eed5279962414a43b09e814bd0562c4e0f394'),
    ('private.demo_seed_ensure_analytics_health_rotation()', 'ef4bd1e1363b5afad9ca56fea96db1ca351a36f5028e8f212de3080f0bd70a0f'),
    ('private.run_due_weekly_question_selections(integer)', '889bd24fbd4f1740c3fc19f13637f82d1bfb28d7b59c0961fe833728a89fd678'),
    ('public.save_weekly_question_selection_policy(boolean,integer,integer,integer,text,timestamp with time zone)', 'f42113b4f75589627358f8aa5ff5f00e48608a0e760e0b7de2e19d56ee004134'),
    ('public.run_weekly_question_selection(uuid)', 'de3e17991dafc47efc82b482da077f0bedcad7ee248299d3bdcfc5bff6af28d3'),
    ('public.save_member_operational_profile(uuid,integer,jsonb,uuid)', '6b2bfe698b305c693fd631567502fbb2e18c11e6768ee1ecc3e77bc8010cf0ce'),
    ('public.bulk_update_member_operational_profiles(uuid[],text,text,uuid)', 'afc0914deb881034cfe79c832343aec82716d6b40ad6f98d982047cc7e77f858'),
    ('public.save_welcome_campaign(uuid,text,text,uuid)', 'fbb648d7f8b0f943a4bd7637cd3bcdbb76c93e1a130927187038bab6415576ca'),
    ('public.save_welcome_campaign_step(uuid,uuid,integer,integer,text,text,text,boolean,uuid)', '67416ddae3daba7f068b5ae64174517b23f525ac9f12449c7b5f36907ba1c72e'),
    ('public.enroll_member_in_welcome_campaign(uuid,uuid,uuid)', 'b13e06e9776180449c36882da46b1ead439826f188e3e6d9551485f0afe4dd56'),
    ('public.transition_member_welcome_enrollment(uuid,text,uuid)', 'a494e0e32e4d71e580d346348299d680f64b49896d2b7a4ac2470e8313e3d9ab'),
    ('public.stage_member_operations_import(text,text,jsonb,jsonb,uuid)', 'e062ce1e2df728255c8192e789e93271a4d65e363525ba3c41ba55a286feb044'),
    ('public.discard_member_operations_import(uuid,uuid)', 'caa634cb36e6cf1ce9af205cc855b87e5defe4d8d844d4a48cb7040f4578c669'),
    ('private.demo_seed_remove_member_operations(text,uuid)', '6c9c5d8db00b467bcc52bf75082c4b80f4df267711c7a3977bb07f38a684235f'),
    ('private.demo_seed_remove_administrative_evidence(text,uuid)', 'b58f5222c153667cce9605339a960e9c07896d5c0c92baf4849d3f18e00e65ab'),
    ('private.demo_seed_apply_administrative_evidence(text,uuid)', '6f758ed8904827a7899c9fd75954dcbd81b709940a3f2716fe227e1c63e27e46'),
    ('public.complete_poms_ingestion(uuid,uuid,uuid,timestamp with time zone,text,text,text,jsonb,text)', 'ef4c44f53c11c3cca41c1cfb20b05bc905857b1863a0bd7ab1d2b84d675dabcb'),
    ('public.save_poms_source(text,text,text,text)', '8d87250306b1c93835bf4700b5bdccf1d2999d46b15b6f5903857cbd6f3ed2b6'),
    ('public.update_poms_source(uuid,timestamp with time zone,text,text,text,text)', '0709243f1ec88d86c9800593aa1513f6935de7befd133ab11ba4547aac2fe28b'),
    ('public.authorize_poms_ingestion(uuid,text)', '3d77d0c53b7cbc41a01775d9867d3e191745496cc66bee18d1e37eb0a3fa9f22'),
    ('public.add_poms_evidence(uuid,timestamp with time zone,text,text,text)', 'cedcea4ed023402e3b7927ee9029e1447be0873a92fa7973da454955cfb1e9aa'),
    ('public.add_field_note_evidence(text,text,text,text,text,text)', '53e4815e03b3809d982102c000609ffd29f4ad7b78acd3accf03d1803eaa7d2e'),
    ('public.draft_field_note_packet(text,text)', '35243f7549317a32a980697e3a1b3c8c690babc8fb5e96f6a9c98da86a2fad8a'),
    ('public.upsert_organization_retention_policy(text,integer,boolean,text)', '967a7fbd09a069def5c26f6b5694c87fa71a12004fed3d05218be81fbd02b20a'),
    ('public.preview_organization_retention_run(text)', '24b47dcdc974163c3b6e96dd1687715246db42f6923b21a56ee03692d1835290'),
    ('public.authorize_organization_retention_run(uuid,text)', '7c4d9c5d6cb2f04275d62fa00291f443b88b34ecb0c02139e97c173ba0e5797d'),
    ('public.begin_constant_contact_oauth(text,text,text,text,timestamp with time zone)', 'f7954652bdd58d6e416b3a86d1a5599b8a99ca33ddce9f3472d8695c1093220b'),
    ('public.disconnect_constant_contact()', 'b3c94d97361ccdaa30a1beb6eb0fe3d0514dd405f6131bbe9208a46dd9c1c51e'),
    ('public.enqueue_constant_contact_sync(integer)', '4f8ada5519e748813d23e74594efb6ce92a8dee6145a01e3bda0b9687ae8700a'),
    ('public.claim_constant_contact_oauth_state(text,text)', 'e6c6480bd7d088d6d40089b5fc88a5909038c494ba97fdf1dc57fb88ea43fd1d'),
    ('public.complete_constant_contact_oauth(uuid,uuid,text,text,text)', '6c3ad90c81c2d17b648e562e572698373851585bb2aee8cc57f3b64bddc1c976'),
    ('public.enqueue_due_constant_contact_sync()', 'a25fa8e1c08078ed74841041d2756411f477885b3c5d8e04511d0c13e7eae3f9'),
    ('public.claim_constant_contact_sync_job(uuid)', '9796be4363ca94c7f9a521e8786f40d8f16f0d483814f2c62d530d240cfb0eb2'),
    ('public.rotate_constant_contact_refresh_token(uuid,text,text)', '60ba3c6bc8a63534022cf296b14f55b80e5051c0ea77d3ad26fd2801cd85d9b9'),
    ('public.record_constant_contact_sync_result(uuid,uuid,text,text,integer,integer,integer,integer,integer,integer,integer,integer,timestamp with time zone)', 'e0c9803ccfe53ab20535c7182e69dc568cdee04535173c2dbc5b479c3868f153'),
    ('public.complete_constant_contact_sync_job(uuid,integer,integer,integer,integer,text)', 'd168a5abc74a9bba6ab74c4a8b0fcf1eb9e5cc17a713d9500b596455b6408bb1'),
    ('public.prepare_twilio_sms_send(uuid,text,text,uuid)', '55aee5f9663765f78ba774b447ac01005c7794992c95ad12299ed641c558f217'),
    ('public.claim_twilio_sms_send(uuid)', '6c638b8b3e01f3c0a0d1dd124a240e7475e8e8294f29eefd43136b3e8bbf99d0'),
    ('public.record_twilio_sms_send_result(uuid,boolean,text,text,text)', '554c569c9e8739edbb8d96b9a5a56eee107f8c4c9acddfcbf3af358f7f3a70d3'),
    ('public.record_twilio_status_callback(uuid,text,text,text)', '7983e77f34e4b94412b4dfbbade33c5068bafe4185d6be49f37b2ae84356b785'),
    ('public.record_twilio_inbound_consent(uuid,text,text,text,text,text)', '108dbcafc90d0454ec124da23949dc34f3aaa3db1fabf422dac46999282e9190'),
    ('private.demo_seed_twilio_operation_history(text,uuid)', '828c13e491a27eadb542350d5f2e37bdfbc408d99a9e0e5aa17d1895c81bb896'),
    ('private.demo_seed_twilio_operation_history_from_evidence()', '33f571de4a0a651bb22864a4ccdaa2bb5e01017ecc25d831d8323ffabb854222'),
    ('private.provision_dues_member_subject_from_membership()', '557901faaf46d6773ba5a3fb6545c4d517b049b465c9856ce6a660238367fd00'),
    ('private.provision_dues_member_subjects()', 'fae9412529f56cecd4785666e0631b4ef7436c293b3e24e80753bea7dae52476'),
    ('private.dues_receipt_number(uuid,date)', '02d5b28a68d20429d1dc7a98a70b2f09373808f36c289daf1af5b4884e1bd18a'),
    ('public.issue_dues_assessment_batch(text,text,text,text,integer,date,text,text,text)', '70d520d903e7c757d281f6c9abb73b80be07dd06ddf0d14bdffaec3f52ccbabc'),
    ('public.plan_dues_reminder_attempts(integer,date)', '55de174ada6e83c5e6c7382008742695b13db6c0daf5310c0086189c0ec55145'),
    ('public.claim_dues_reminder_attempts(integer)', '38077d109243afc2ffee08c3da648fa41cf3c82fb6ec6b6a9271ad7f0d3557fb'),
    ('public.get_mobile_dues_context()', '30b52da3c31338f5c45d8128c20e47010f6e2fdad1e32a4784102c2d362acba8'),
    ('public.resolve_dues_stripe_oauth_recovery(text,text)', '8cdf52c87e07d0ed061bdb9fa9c025c729706059d3d0a06019853a398b361280'),
    ('public.begin_member_password_reissue(uuid)', '2364bee3aff7fbc22f128631365730c2e6fd0e6edb9336526090c3b00234bef1'),
    ('public.prepare_dues_checkout_reservation(uuid,text)', '3aebd515a5c967004d6b1a39207b39ea3bc8552db97104f72fb5f8a0515fe858'),
    ('public.claim_dues_checkout_reconciliations(integer,uuid)', '7f88fb818173eb96f3f95facbbcd10f5ccdd33dbb582ba17cce2ebe5295ab904'),
    ('public.cancel_dues_checkout_reservation(uuid)', '3231b1d3d727a288a6a3abadc8c893724fe31aebcfacc2f96a73b582068f8d5d'),
    ('public.fail_dues_checkout_reservation(uuid,text,integer,uuid,text)', '50d387de9bdc3d2bdd9937995e21554399e375ab2b502e4b3d058820a9b46022'),
    ('public.record_dues_reconcile_job_run(text,text,text)', '9e0b3afd8aed9113cb6f20750543523325dc5d9458c90ec66b3a21c0fa59442c'),
    ('public.get_pending_dues_stripe_oauth_exchange(uuid,uuid,text)', '748ebf5fc1caf686571c046a86ea0539a961d44e1472a3acacc7f4dd771befe3'),
    ('public.resume_dues_stripe_oauth_exchange(uuid,uuid,text,text,text,boolean,boolean)', 'c42776d2018e544279ab2ce89f1ebe1a39d0219fdb672c52e40d9f8a7636481e'),
    ('public.reconcile_dues_checkout_reservation(uuid,integer,uuid,text,text,text,text,text,text,integer,text,uuid,uuid,timestamp with time zone)', '8ee1783b2326f966f2c362d896166e626f3da7379d9596608721a472fcec4129'),
    ('private.refresh_dues_financial_identity_from_role_grant()', 'c3059d1a8eafca73fc75ff562940b2cc2d485b9a04425d54bea189ea49dbb3cd'),
    ('private.refresh_dues_financial_identity_from_membership()', '76a32ab214618d9dba3cf48e8a9d07e70a3fafcb0d4c3bad3883d9644d360d3e'),
    ('public.finalize_dues_checkout_reservation(uuid,text,text,timestamp with time zone,integer,uuid,text)', 'ea8fad405b830dbcfc7b326ea8f7ab9106456b0084b9e2ec238f7563caa9172e'),
    ('private.refresh_dues_financial_identity_for_context(uuid,uuid,text)', '3f045d0da5ef9277b8b86a2f7fb54d9682a041ab21005d2dc5d9dba294f9cb41'),
    ('private.dues_settle_stripe_checkout(uuid,text,text,text,integer,text,text,uuid,uuid)', 'a0152c428c8899276158a26d458a060ff5cbcd552cb5638064404c4daeda1906'),
    ('private.dues_claim_checkout_reconciliations(integer,uuid,boolean)', 'c211e25d6c1d5d1c4c4d321063a9e95c5aa0960b0e036f290cd44ad74dd4f5a3'),
    ('public.set_dues_financial_identity_for_context(uuid,uuid,text,text)', 'f78573e2a27218f0c2c7d6bd11ae1b5e4ac0d8b61956199ca04582287da959ee'),
    ('public.provision_dues_financial_identity_for_active_context(uuid,uuid)', '73a149278bbea4091626a5a90a7ca4b747ec0dbffbc67651b39354f75d709d0b'),
    ('public.save_dues_stripe_oauth_state(text,uuid,uuid,text,text,text,timestamp with time zone)', '3535783b32e0693f7c26c4b3dff4d5dc3031dca455aaf912849480d468730fc9'),
    ('public.claim_dues_stripe_oauth_callback(text,text,uuid)', '9574e08b2be5227c65eb552071eb631aff14ac833c56d8517c35497ed395d1ed'),
    ('public.record_dues_stripe_oauth_exchange(text,integer,uuid,text,text,boolean)', 'e3a45c56e7028ba77ae98d13fff94e2a39822213841532df5f95ef815f587b92'),
    ('public.complete_dues_stripe_oauth_callback(text,integer,uuid,uuid,uuid,text,text,boolean,boolean)', '862a05384bd58760ac97692336e53b634479a8d4bd742e9b5e77219e72dcc0b1'),
    ('public.claim_dues_stripe_oauth_reconciliations(integer,uuid)', '9a0cfdd7a3014b6622c700ae56ad39fb33b2f3c1d90f1975c37c3d9db112fa19'),
    ('public.settle_dues_stripe_event(text,uuid,text,text,text,integer,text,uuid,uuid,text,text)', 'f0169cf11f076979176f9cfc6934a3cd51a62b05365f1bf394d9addcd08d08a7'),
    ('public.resolve_dues_checkout_attention(uuid,uuid,text,text,text,text,timestamp with time zone,text,text,integer,text,text,uuid,uuid)', 'a3a8703311a6b35a6285c4ee530919b5fda40822ff13b7b2ac86fcdc4c541515'),
    ('public.defer_dues_stripe_oauth_callback(text,integer,uuid,text)', '794bc5c6e112c1297baec9e40bb6f1f5a23e98369bf85ad8e6def3682688d56c'),
    ('public.fail_dues_stripe_oauth_callback(text,integer,uuid,text,text)', '873ec232cf12eb514c94e161cc8461ed02bd483588f95b3bd05f760caf10e390'),
    ('public.record_dues_stripe_oauth_recovery_account(text,integer,uuid,text)', '6b857057f0e863f67616c3d7ebbc1e67b4ffadc58e8dbc7a7e75532da509c345'),
    ('public.mark_calendar_import_error(uuid,text)', '88f81ca66901eb24c217cd05e2433b51f71f0be0881a21fe11eba33eccea9a3f'),
    ('public.rsvp_to_event(text,text)', 'e5f27936496b8164147436f26b72a05603ee98c112f8821152021c0d39a656b0'),
    ('public.check_in_to_event(text,text)', 'ef911d266401385813f4d2db0d79fd4eee108b05d8accbc4f55f26cdf5ba7c56'),
    ('public.apply_dues_credit_event(uuid,text,integer,text,text,text)', '7bcf3cfaad73ddf94d720937e7e965c4525bf25b3d258ef1b2c83a8c2a3b14f5'),
    ('public.create_dues_checkout_reservation(uuid,text)', '1f7223924888e17b0fa0f61f471d7a559f121bfdbf413874f5a23420fa7dbe73'),
    ('public.disconnect_dues_stripe_account(text)', 'f793b871f6fc6754ecb98d1253a7b1d88af3cee9ed9b1d57801761e7e135201f'),
    ('public.queue_dues_reminder(uuid,text,text,text)', '49a55e98b01c525e43425e0fd3c84e3788082bc2055bfdf03e16f62fe4583b84'),
    ('public.record_dues_manual_payment(uuid,integer,date,text,text,text,text,text)', '98abb32ce6a748ef6ebb691794d71b2c31d1552e2d08758fb0b717efa2627207'),
    ('public.restore_chapter_kb_revision(uuid,bigint,boolean,uuid,text)', '72c2e66e3eb23d1488a896c58e63208dbf5ef70db53cf0f08ced68c84efb58c1'),
    ('public.prepare_steward_library_upload(text,bigint,text,text,text,text,uuid,text)', 'e72d57f54beedf13c89a343fc52f73f53f1ecb43086d4128c5a6089dbc59d45d'),
    ('public.authorize_knowledge_ingest(uuid)', 'cd48d0900587101b8527ba58d8fc1b14cf0b374a919c1d1a7fd131840828ba32'),
    ('public.replace_cba_knowledge_drafts(uuid,uuid,uuid,text,jsonb)', '76e5afb81e6ff33080341334970f4ae60f5c9235de0cd33d38c24e27907022a5'),
    ('public.mark_calendar_connection_error(uuid,text)', '57168203a3c9f13ea9c52fce5fe17e29fb4d8789601baefbe1b8f95f55d7d573'),
    ('public.remove_calendar_connection(text)', 'eb3db36dba276081df9cb7d5018dedabb8d218df0b25dd68d6c2a3727c54ea52'),
    ('public.replace_calendar_import_events(uuid,text,timestamp with time zone,timestamp with time zone,jsonb)', '9338121210f0a6c71da7beb135287f306769af1879e7b279c386595fc23bcc5b'),
    ('public.clear_calendar_import_events(uuid,text)', '650252196aaa10a9f9a0c1a692a2e964d42a69fd78d0d3431b902a39c8d6f345'),
    ('public.mark_steward_calendar_sync_attempt(uuid,text)', 'fc1c71e1b62266d195e0bee4b108ee4a917974e19324a941a2e2c7b942982d60'),
    ('public.save_knowledge_collection(uuid,text,text,text,text,text)', 'a7161af34f21e05dea4673920c94fbe4a8cbe94e23bc0b9dda91cfccd135682c'),
    ('public.delete_knowledge_collection(uuid,text)', '77d33fb5e47efa8d74ab7ea05bb95a142fd889a9331581e78474ee34a55c1245'),
    ('public.abort_chapter_task_file_upload(uuid)', '97d1c51f820d9924f85488a815e13cdda8ed1d35606268db4d347cb9724dc5f9'),
    ('public.claim_mfa_recovery_code(text)', 'bd268b99660ac322d5318fcefcb370c15ca8e8ec168a86cf7aaefa3ab3197756'),
    ('public.register_my_native_push_installation(uuid,text,text,text,uuid,text)', '9f208a9891416be2771fb6f17cdf98a6f966a20ee9e28a2dd7a5b4542c38ec05'),
    ('public.delete_my_native_push_installation(uuid,uuid,text)', '52846e770f8ff0678aa01bed3e148213915609f2ee8f0e775cb5104ef4326f56'),
    ('public.prepare_mfa_recovery_signout(uuid,text,text)', '2ea9c8ea57d7de9ef3a5206a91e84ba38e6fba3053e6335f83a70a1220837fc3'),
    ('public.finalize_mfa_recovery_code(uuid,text)', 'df20c3ada308086048f961841cf1e73a9490fcb1d6cec201428185b2dc6ef235'),
    ('public.prepare_my_signout(text,uuid)', '7fc4e905ea5eccbf1d39e90702d8c5fa64619ccdd20d957ab562a5145fd12365'),
    ('public.finish_private_upload_inspection(uuid,text,text,text,bigint,timestamp with time zone,timestamp with time zone)', 'd596ad951199b87a1298feee8f525d9c28e20bc873bc32e451e81407c622b2dc'),
    ('public.replace_knowledge_source_chunks(uuid,uuid,uuid,jsonb,text)', 'a157cd0cda0e9a6de46f08340407c88eac300499b76b429b22852a8036671149'),
    ('public.review_steward_library_file(uuid,text)', 'bb84fb5091daa1128b2ddef827030e4110f257fb1379e0324fe3621b7036e0c4'),
    ('public.save_chapter_kb_article(uuid,text,text,text,text,text[],text,boolean,text)', '9ee72124f10008666ad08883b4d3c246a865d37a36995fb434864aea47964e31'),
    ('public.retire_chapter_kb_article(uuid,text)', '9bba1e9bf2b69554a97c2988582b6132641c12a4e6c5cff63c88714bad95f395'),
    ('public.set_knowledge_collection_item(uuid,text,uuid,boolean,integer,text)', '16f317bad33c5c39352037ec4b8b2bb457cd6d3d768df0a555c8777a8f151ae3'),
    ('public.record_account_deletion_reconcile_job_run(text,text,text)', '9ea66b68745d75fceae50b446e415a420d7dd157d1f60c691a57394fd1059d16'),
    ('public.uniondemo_begin(uuid,text,integer,integer,integer,text,text,text)', '73adf8af906a0e91a3bc1b9bb930c611ff0342aec2a9fb1f3305dbfa6a734908'),
    ('private.assert_member_account_deletion_allowed(uuid)', '57892252308e61df71009131fdd3074ab98098bbec406965133835dd62094e2b'),
    ('private.assert_retention_admin(uuid)', '52ad629f88f8a83566e165c33290f6eecfb74619c94da1bb335891ce2d82b36b'),
    ('public.presg_demo_begin(uuid,text,integer,integer,integer,text,text,text)', '5e6bea85ee45a21c7ebe4b98fc1991e68a8c2434345d25faefa012a3a3ae263e'),
    ('private.member_operations_replay(uuid,text,uuid,jsonb)', 'bb8af8c465e97689ef2d909c7ff897b80d4c5fc47d1f3181a09c312374503186'),
    ('private.knowledge_source_object_verdict_locked(uuid,uuid)', '0f87687d691c53a4985611f49b092d6d2248418c22d2c6924479bf9c47ed90cb'),
    ('private.guard_auth_user_deletion()', '9b5c88e18f910897c57ea7f1722cda5178d27e16c3c38d6429c50a4e54896781'),
    ('private.guard_member_account_deletion_request()', '9b690638791dbd3d5fa2a004372c2f399ac79a69f33cc864e7eebf687fb1f04c'),
    ('public.get_organization_retention_engine()', '14dd0094bce76f4311a0795f182a0e1c6d8617668fa10546b56de0e60dd148ea'),
    ('public.authorize_member_account_deletion(text)', 'e54ad71be843edfcbf99048e4c34f5be7d14493d8be414a231745e85e28d7f7e'),
    ('public.claim_member_account_deletion(uuid, uuid, text)', 'f5e817f28f0ca46cb70d28bddc761a03d84b7226dd40e6553e6fa1835344b7cf'),
    ('public.finalize_member_account_deletion(uuid, text, boolean, text)', 'd2e4de8dafc21d2505699960c8292d14a8a11dcffa573b6bce977a56dd3ada8e'),
    ('public.mark_member_account_deletion_auth_completed(uuid)', '252b26b290505692c5601cee1221f1b5be09839d1b01be532ea4fba36f8a1935'),
    ('public.reconcile_pending_account_deletions(integer)', 'c5c4e532cfe04a4eba04c2f524ca755c9f6ddd57d24a7b9b901c62107451a4d3'),
    ('private.message_action_audit(text, uuid, text)', '1c5d3637306f6aafbccb9337669ea9fde4c7f225f02e2fd53ab55d3e84dec067'),
    ('public.edit_member_message(uuid, text)', 'd3cd77556f76bd0cf3fc4559832159b491a3815d123cf7c358a991eb75c6fdc6'),
    ('public.act_on_member_message(text, uuid, text, text)', '83c3829de4cffd74d701249fceb10255d99fa38faa656cedff59fa051f69b48b'),
    ('public.reply_to_member_message(text, uuid, text)', 'e74d7c5455b521d02f1ed6226cf916e679cf2f2ac1cbefb2e36a3e1fae713de2')
    ,('private.demo_seed_record_page_evidence_pre_casework_20260830(text,uuid,uuid,uuid,uuid,uuid)', 'c0f7140658868a409b47ab298d41da1eb0e5738a661ab801a82bf744cae7228f')
    ,('private.presg_demo_verify_pre_function_parity(uuid,text)', 'f1cd944f5c3fbbceae19bb9cbad0078765f276d0981b8b0a2cf07986f6fcd3a7')
    ,('private.uniondemo_verify_pre_function_parity(uuid,text)', '962269533ffde775d334ea50b9f93fd9dc762f8f1ec7d51599ec7dc838492e77')
  ) reviewed(signature, source_sha256) loop
    select p.prosrc, pg_catalog.pg_get_functiondef(p.oid) into strict source, definition
      from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure(r.signature);
    if pg_catalog.encode(extensions.digest(pg_catalog.convert_to(source, 'UTF8'), 'sha256'), 'hex') is distinct from r.source_sha256 then
      raise exception 'case graph writer source changed: %', r.signature using errcode = '55000';
    end if;
    original_source := source;
    directive := coalesce(pg_catalog.substring(source, $directive$^\s*#[^\n]+\n$directive$), '');
    source := pg_catalog.substr(source, pg_catalog.length(directive) + 1);
    wrapped := directive || $wrapper$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
$wrapper$
      || pg_catalog.rtrim(source, chr(10) || chr(13) || chr(9) || ' ')
      || case when pg_catalog.right(pg_catalog.rtrim(source, chr(10) || chr(13) || chr(9) || ' '), 1) = ';' then '' else ';' end
      || $wrapper$
end;
$wrapper$;
    definition := pg_catalog.replace(definition, original_source, wrapped);
    execute definition;
  end loop;
end;
$case_graph_writers$;

-- The case-linked notification writer uses the same transaction entry.
CREATE OR REPLACE FUNCTION private.notify_handshake_staff(p_chapter_id text, p_title text, p_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);
insert into public.member_notifications (user_id, title, body, kind)
  select distinct recipients.user_id, p_title, p_body, 'general'
  from (
    select role_chapter.user_id
    from public.member_role_chapters role_chapter
    join public.chapters role_chapter_scope
      on role_chapter_scope.id = role_chapter.chapter_id
    left join public.organizations role_organization
      on role_organization.id = role_chapter_scope.organization_id
    join public.member_chapter_memberships membership
      on membership.user_id = role_chapter.user_id
     and membership.chapter_id = role_chapter.chapter_id
     and membership.status = 'active'
    where role_chapter.chapter_id = p_chapter_id
      and role_chapter.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
      and (
        role_chapter_scope.organization_id is null
        or role_organization.status = 'active'
      )
    union
    select role_grant.user_id
    from public.chapters chapter
    join public.organizations organization
      on organization.id = chapter.organization_id
     and organization.status = 'active'
    join public.organization_role_grants role_grant
      on role_grant.organization_id = chapter.organization_id
     and role_grant.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp')
    join public.organization_memberships organization_membership
      on organization_membership.organization_id = role_grant.organization_id
     and organization_membership.user_id = role_grant.user_id
     and organization_membership.status = 'active'
    where chapter.id = p_chapter_id
  ) recipients;
end;
$function$
;

-- The SQL receipt writer enters before its view insert and its Auth references.
CREATE OR REPLACE FUNCTION private.member_operations_store_receipt(p_organization_id uuid, p_operation text, p_idempotency_key uuid, p_request_payload jsonb, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

  insert into private.mi1_w2_operation_receipts (
    organization_id, operation, idempotency_key, request_payload, result
  ) values (
    p_organization_id, p_operation, p_idempotency_key, p_request_payload, p_result
  );

end;
$function$
;

-- The retention projection now participates in transaction coordination and
-- re-reads its permission inputs after waiting; its planner contract is volatile.
alter function public.get_organization_retention_engine() volatile;

commit;
