-- SEC-UG-CONSTANT-CONTACT-SYNC-REQUEST-BOUNDS-20260921
--
-- public.enqueue_constant_contact_sync (live body 20260830233000 under the
-- 20260907151000 case-graph wrapper) queued a new provider job on every call.
-- Its scheduled sibling, enqueue_due_constant_contact_sync, already skips an
-- organization with a queued or running sync job. The user-triggered path now:
--
-- 1. Returns the organization's existing queued or running
--    constant_contact_sync job (deduplicated: true) instead of queueing
--    another. It writes no request row and no tenant audit event, so
--    api/constant-contact-sync.js resumes that job rather than starting new
--    provider work.
-- 2. Enforces an explicit request-rate policy: 6 user-requested syncs per
--    organization per rolling hour, counted from constant_contact_sync_requests
--    rows with a requester (cron rows carry none). A request over the bound is
--    refused with errcode 54000 before any write, so the endpoint returns
--    before processing provider work.
--
-- A per-organization transaction advisory lock serializes both checks.
-- Authorization, MFA, the limit bounds, the connection check and the audit
-- event are unchanged. Grants are preserved by CREATE OR REPLACE.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create index if not exists constant_contact_sync_requests_org_requested_idx
  on public.constant_contact_sync_requests (organization_id, created_at)
  where requested_by is not null;

create or replace function public.enqueue_constant_contact_sync(p_limit_count integer default 25)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);

declare
  org uuid := private.mi1_require_integration_admin();
  job_id uuid := extensions.gen_random_uuid();
  pending public.integration_jobs%rowtype;
  recent_requests integer;
begin
  if not private.mfa_satisfied() then
    raise exception 'mfa required' using errcode = '42501';
  end if;
  if p_limit_count not between 1 and 25 then
    raise exception 'invalid sync limit' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.constant_contact_oauth_tokens token
    join public.organization_integrations integration
      on integration.organization_id = token.organization_id and integration.provider = 'constant_contact'
    where token.organization_id = org and token.status = 'connected' and integration.status = 'connected'
  ) then
    raise exception 'provider not connected' using errcode = 'P0002';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('constant-contact-sync:' || org::text, 509)
  );
  select * into pending from public.integration_jobs job
  where job.organization_id = org
    and job.provider = 'constant_contact'
    and job.job_kind = 'constant_contact_sync'
    and job.status in ('queued', 'running')
  order by job.created_at, job.id
  limit 1;
  if pending.id is not null then
    return pg_catalog.jsonb_build_object('ok', true, 'jobId', pending.id, 'status', pending.status, 'deduplicated', true);
  end if;
  select pg_catalog.count(*)::integer into recent_requests
  from public.constant_contact_sync_requests request
  where request.organization_id = org
    and request.requested_by is not null
    and request.created_at > pg_catalog.now() - interval '1 hour';
  -- 6 user-requested syncs per organization per rolling hour.
  if recent_requests >= 6 then
    raise exception 'sync request limit reached: 6 per hour' using errcode = '54000';
  end if;
  insert into public.integration_jobs (
    id, organization_id, provider, job_kind, status, idempotency_key
  ) values (
    job_id, org, 'constant_contact', 'constant_contact_sync', 'queued',
    'constant-contact:' || job_id::text
  );
  insert into public.constant_contact_sync_requests (
    job_id, organization_id, requested_by, limit_count
  ) values (job_id, org, (select auth.uid()), p_limit_count);
  perform private.mi1_write_tenant_audit(org, 'integration_provider_changed', pg_catalog.jsonb_build_object(
    'organizationId', org, 'provider', 'constant_contact', 'status', 'sync_queued',
    'action', 'sync'
  ));
  return pg_catalog.jsonb_build_object('ok', true, 'jobId', job_id, 'status', 'queued');
end;
end;
$function$;

notify pgrst, 'reload schema';

commit;
