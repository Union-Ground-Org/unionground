-- REQ-UG-PRODUCTION-SIGNUP-RECOVERY-GATE-20261015
-- Evidence is installed by an attended postgres session, never a client role.
-- Applying this migration supplies no evidence and never opens signup.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table private.open_signup_recovery_checks (
  id bigint generated always as identity primary key,
  project_ref text not null check (project_ref = 'productionprojectref'),
  system_identifier text not null check (system_identifier ~ '^[0-9]+$'),
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  pitr_enabled boolean not null,
  earliest_recovery_at timestamptz not null,
  latest_recovery_at timestamptz not null,
  restore_verified_at timestamptz not null,
  restore_evidence_sha256 text not null check (restore_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  storage_verified_at timestamptz not null,
  storage_backup_verified_at timestamptz not null,
  storage_evidence_sha256 text not null check (storage_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  verified_by text not null check (length(trim(verified_by)) between 1 and 160),
  launch_requirements jsonb not null check (jsonb_typeof(launch_requirements) = 'object'),
  launch_evidence_sha256 text not null check (launch_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  check (expires_at > verified_at and expires_at <= verified_at + interval '1 hour'),
  check (earliest_recovery_at < latest_recovery_at and latest_recovery_at <= verified_at),
  check (restore_verified_at <= verified_at and storage_verified_at <= verified_at
    and storage_backup_verified_at <= verified_at)
);
alter table private.open_signup_recovery_checks enable row level security;
alter table private.open_signup_recovery_checks force row level security;
revoke all on private.open_signup_recovery_checks from public, anon, authenticated, service_role;
revoke all on sequence private.open_signup_recovery_checks_id_seq from public, anon, authenticated, service_role;

comment on table private.open_signup_recovery_checks is
  'Operator recovery evidence for production signup. The latest check wins, expires within one hour, and is bound to the production database system identifier. No client writes.';

create function private.open_signup_launch_evidence_ready(evidence jsonb, as_of timestamptz)
returns boolean language plpgsql stable security definer set search_path = ''
as $function$
declare requirement text; required_checks text[]; check_name text; entry jsonb; checked_at timestamptz;
begin
  if pg_catalog.jsonb_typeof(evidence) is distinct from 'object' then return false; end if;
  if (select count(*) from pg_catalog.jsonb_object_keys(evidence)) <> 9 then return false; end if;
  foreach requirement in array array[
    'account-email-delivery', 'abuse-protection', 'uptime-alerting',
    'private-error-alerting', 'upload-malware-protection', 'usage-budget-controls',
    'admin-recovery', 'tenant-isolation', 'support-incident-response'
  ] loop
    entry := evidence -> requirement;
    if pg_catalog.jsonb_typeof(entry) is distinct from 'object'
      or entry ->> 'result' is distinct from 'passed'
      or coalesce(entry ->> 'evidence_sha256', '') !~ '^[0-9a-f]{64}$'
      or coalesce(entry ->> 'verified_at', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then return false; end if;
    required_checks := case requirement
      when 'account-email-delivery' then array['gmail_delivery','outlook_delivery','business_mailbox_delivery','spf_dkim_dmarc','bounce_failure_alerts','sending_capacity','signup_failure_alerts']
      when 'abuse-protection' then array['server_turnstile','direct_api_limits','login_recovery_limits','expensive_action_limits']
      when 'uptime-alerting' then array['external_probe','outage_notification','recovery_notification','tls_and_job_alerts','readiness_refresh_running']
      when 'private-error-alerting' then array['synthetic_error_received','alert_delivered','sensitive_data_absent']
      when 'upload-malware-protection' then array['malicious_file_quarantined','scanner_failure_denied','clean_file_released']
      when 'usage-budget-controls' then array['per_account_org_limits','provider_spend_alerts','limit_behaviour_tested']
      when 'admin-recovery' then array['infrastructure_mfa','recovery_material_secured','access_recovery_tested','least_privilege']
      when 'tenant-isolation' then array['cases_messages_files_denied','ai_context_denied']
      when 'support-incident-response' then array['support_inbox_monitored','account_recovery_tested','signup_shutdown_tested','abuse_and_outage_runbook',
        'support_triage_surge_drilled','incident_response_drilled','coverage_escalation_verified',
        'independent_status_channel_tested','evidence_custody_verified','sole_admin_recovery_tested','operating_policy_adopted',
        'solo_operator_absence_drilled','intake_cap_enforced']
    end;
    foreach check_name in array required_checks loop
      if entry #> array['checks',check_name] is distinct from 'true'::jsonb then return false; end if;
    end loop;
    checked_at := (entry ->> 'verified_at')::timestamptz;
    if not pg_catalog.isfinite(checked_at) or checked_at > as_of
      or checked_at < as_of - interval '30 days' then return false; end if;
  end loop;
  return true;
exception when invalid_datetime_format or datetime_field_overflow
  or invalid_time_zone_displacement_value or invalid_parameter_value then return false;
end;
$function$;
revoke all on function private.open_signup_launch_evidence_ready(jsonb, timestamptz)
  from public, anon, authenticated, service_role;

create function private.open_signup_recovery_ready()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((
    select r.pitr_enabled
      and r.system_identifier = (select system_identifier::text from pg_catalog.pg_control_system())
      and r.verified_at <= pg_catalog.now()
      and r.expires_at > pg_catalog.now()
      and r.latest_recovery_at >= pg_catalog.now() - interval '24 hours'
      and r.restore_verified_at >= pg_catalog.now() - interval '30 days'
      and r.storage_verified_at >= pg_catalog.now() - interval '30 days'
      and r.storage_backup_verified_at >= pg_catalog.now() - interval '24 hours'
      and private.open_signup_launch_evidence_ready(r.launch_requirements, pg_catalog.now())
    from private.open_signup_recovery_checks r
    order by r.id desc limit 1
  ), false);
$function$;
revoke all on function private.open_signup_recovery_ready() from public, anon, authenticated, service_role;

-- Every database entry point already uses this predicate, including direct
-- authenticated create_my_organization and the service-role signup limiter.
create or replace function private.open_signup_is_open()
returns boolean language sql stable security definer set search_path = ''
as $function$
  select coalesce((select p.opens_at <= pg_catalog.now()
    from private.open_signup_period p where p.singleton), false)
    and private.open_signup_recovery_ready();
$function$;
revoke all on function private.open_signup_is_open() from public, anon, authenticated, service_role;

-- The API explicitly requires this new RPC, so an unapplied migration cannot
-- fall back to the older owner-switch-only behavior.
create function public.open_signup_recovery_ready()
returns boolean language sql stable security definer set search_path = ''
as $function$ select private.open_signup_recovery_ready(); $function$;
revoke all on function public.open_signup_recovery_ready() from public, anon, authenticated;
grant execute on function public.open_signup_recovery_ready() to service_role;

comment on function public.open_signup_recovery_ready() is
  'Production recovery readiness only; never grants permission to open signup. The owner switch is separately required.';
notify pgrst, 'reload schema';
commit;
