// Disposable database fixture only. Every caller rolls its transaction back.
// The launch requirement names the database's recovery-check guard expects
// (private.open_signup_recovery_checks.launch_requirements).
const LAUNCH_REQUIREMENTS = Object.freeze({
  'account-email-delivery': ['gmail_delivery', 'outlook_delivery', 'business_mailbox_delivery', 'spf_dkim_dmarc', 'bounce_failure_alerts', 'sending_capacity', 'signup_failure_alerts'],
  'abuse-protection': ['server_turnstile', 'direct_api_limits', 'login_recovery_limits', 'expensive_action_limits'],
  'uptime-alerting': ['external_probe', 'outage_notification', 'recovery_notification', 'tls_and_job_alerts', 'readiness_refresh_running'],
  'private-error-alerting': ['synthetic_error_received', 'alert_delivered', 'sensitive_data_absent'],
  'upload-malware-protection': ['malicious_file_quarantined', 'scanner_failure_denied', 'clean_file_released'],
  'usage-budget-controls': ['per_account_org_limits', 'provider_spend_alerts', 'limit_behaviour_tested'],
  'admin-recovery': ['infrastructure_mfa', 'recovery_material_secured', 'access_recovery_tested', 'least_privilege'],
  'tenant-isolation': ['cases_messages_files_denied', 'ai_context_denied'],
  'support-incident-response': ['support_inbox_monitored', 'account_recovery_tested', 'signup_shutdown_tested', 'abuse_and_outage_runbook',
    'support_triage_surge_drilled', 'incident_response_drilled', 'coverage_escalation_verified',
    'independent_status_channel_tested', 'evidence_custody_verified', 'sole_admin_recovery_tested', 'operating_policy_adopted',
    'solo_operator_absence_drilled', 'intake_cap_enforced'],
});

export async function insertSignupRecoveryCheck(client) {
  const requirements = Object.fromEntries(Object.entries(LAUNCH_REQUIREMENTS).map(([name, checks]) => [name, {
    result: 'passed', verified_at: new Date(Date.now() - 60_000).toISOString(), evidence_sha256: 'c'.repeat(64),
    checks: Object.fromEntries(checks.map((check) => [check, true])),
  }]));
  await client.query(`insert into private.open_signup_recovery_checks
    (project_ref, system_identifier, verified_at, expires_at, pitr_enabled,
     earliest_recovery_at, latest_recovery_at, restore_verified_at,
     restore_evidence_sha256, storage_verified_at, storage_backup_verified_at, storage_evidence_sha256, verified_by, launch_requirements, launch_evidence_sha256)
    select 'productionprojectref', system_identifier::text, now(), now() + interval '1 hour', true,
      now() - interval '1 day', now() - interval '1 minute', now() - interval '1 hour',
      repeat('a',64), now() - interval '1 hour', now() - interval '1 hour', repeat('b',64), 'disposable-test', $1::jsonb, repeat('d',64)
    from pg_catalog.pg_control_system()`, [JSON.stringify(requirements)]);
}

// A checked-in operator coverage lease around now (20261016053800). The lease
// guard trigger, which enforces the approved Monday-Friday 9 AM-5 PM ET hours,
// is skipped for this one insert so the fixture works at any hour; `set local`
// keeps that inside the caller's rolled-back transaction.
export async function insertSignupCoverageLease(client, columns = {}) {
  const lease = {
    window_starts_at: "now() - interval '1 minute'", window_ends_at: "now() + interval '1 hour'",
    check_in_interval: "interval '30 minutes'", last_check_in_at: 'now()', revoked_at: 'null', ...columns,
  };
  await client.query('set local session_replication_role = replica');
  await client.query(`insert into private.open_signup_operator_coverage
    (window_starts_at, window_ends_at, check_in_interval, last_check_in_at, revoked_at, operator_label, evidence_reference)
    values (${lease.window_starts_at}, ${lease.window_ends_at}, ${lease.check_in_interval}, ${lease.last_check_in_at},
      ${lease.revoked_at}, 'disposable test', 'disposable/coverage')`);
  await client.query('set local session_replication_role = origin');
}
