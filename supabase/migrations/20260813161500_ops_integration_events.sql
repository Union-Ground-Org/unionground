-- Sanitized operational event ledger for the provider-to-Linear router.
-- Raw webhook payloads, credentials, recipient addresses, member identifiers,
-- and arbitrary provider metadata are intentionally absent from this schema.

create table public.ops_integration_incidents (
  id uuid primary key,
  provider text not null check (provider in ('vercel', 'resend', 'cloudflare', 'supabase', 'browserbase')),
  project_key text not null check (char_length(project_key) between 1 and 80),
  environment text not null check (char_length(environment) between 1 and 32),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  lifecycle text not null check (lifecycle in ('failure', 'recovery')),
  severity smallint not null check (severity between 1 and 4),
  title text not null check (char_length(title) between 1 and 140),
  summary text not null check (char_length(summary) between 1 and 280),
  source_url text,
  linear_issue_identifier text,
  linear_issue_url text,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null,
  recovered_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (provider, project_key, environment, fingerprint)
);

create table public.ops_integration_deliveries (
  id uuid primary key,
  -- Deterministic incident IDs may be recorded before the Linear call and
  -- incident upsert complete, so this intentionally is not a foreign key.
  incident_id uuid not null,
  provider text not null check (provider in ('vercel', 'resend', 'cloudflare', 'supabase', 'browserbase')),
  source_event_id text not null check (source_event_id ~ '^[a-f0-9]{64}$'),
  lifecycle text not null check (lifecycle in ('failure', 'recovery')),
  action text not null check (action in ('create', 'recover', 'reopen', 'repeat', 'ignore_stale', 'ignore_orphan')),
  status text not null check (status in ('processing', 'processed', 'failed')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 64),
  unique (provider, source_event_id)
);

create index ops_integration_incidents_open_idx
  on public.ops_integration_incidents (provider, environment, last_seen_at desc)
  where lifecycle = 'failure';

create index ops_integration_deliveries_status_idx
  on public.ops_integration_deliveries (status, received_at)
  where status <> 'processed';

alter table public.ops_integration_incidents enable row level security;
alter table public.ops_integration_deliveries enable row level security;

-- These restrictive policies preserve the repository-wide MFA invariant if a
-- client grant is ever added accidentally. There is deliberately no
-- permissive client policy; only the service role receives table privileges.
create policy mfa_assurance on public.ops_integration_incidents
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

create policy mfa_assurance on public.ops_integration_deliveries
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied()))
  with check ((select private.mfa_satisfied()));

revoke all on table public.ops_integration_incidents from public, anon, authenticated;
revoke all on table public.ops_integration_deliveries from public, anon, authenticated;
grant select, insert, update on table public.ops_integration_incidents to service_role;
grant select, insert, update on table public.ops_integration_deliveries to service_role;

comment on table public.ops_integration_incidents is
  'Sanitized incident lifecycle state for the signed provider-to-Linear router; never stores raw webhook payloads.';
comment on table public.ops_integration_deliveries is
  'Hashed event-delivery audit and retry state for idempotent provider processing.';
