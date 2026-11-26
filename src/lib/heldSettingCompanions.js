// BUG-UG-HELD-FEATURE-LIMITS-STILL-LISTED-20261112 .
//
// Only a boolean switch can be held for its release day, and the admin
// settings list (public.get_admin_organization_configuration) leaves a held
// switch out (docs/contracts/staged-feature-releases.md). A limit that acts
// only beside a feature switch stays listed and would name the held feature.
//
// Each row below is listed only while every switch it acts beside is listed.
// The definitions carry no parent column, so the relation is written here,
// read from the server code that applies each limit:
//   - the digest recommendations cap is read only when the weekly digest
//     is built (20261002151000_issue_intelligence_weekly_digest);
//   - the topic readiness floor applies only to automatic topic readiness,
//     which needs the Neuro Map switch too (neuro_on and auto_progress in
//     20261112062000_neuro_map_organization_switch);
//   - the two per-member invitation limits count only invitations members
//     send themselves (20261111193500_member_sent_invitations);
//   - the field notes per draft packet limit bounds only a draft packet, which
//     needs the packet switch (20261009230000_field_notes_ai_packet;
//     BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113);
//   - the SCIM request limit is read only by public.scim_authenticate, after
//     the directory sync switch, and by public.get_scim_control
//     (20261003041000_scim_provisioning_service; held with single sign-on,
//     REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117).
// tests/held-setting-companions-walk.test.js walks every definition in the
// migration chain and fails when a row whose every server reader names a held
// switch is missing here, so a new one cannot be listed by omission.
// Only what the page lists changes: the stored value and every server read
// of the limit stay as they are, and a released switch brings its rows back
// with no deploy.
export const SETTING_ACTS_BESIDE = Object.freeze({
  "limits.ai_assistant.packet_notes": Object.freeze(["features.ai_assistant.field_notes_packet"]),
  "limits.intelligence.digest_max_recommendations": Object.freeze(["features.intelligence.weekly_digest"]),
  "limits.intelligence.neuro_map_topic_min_members": Object.freeze(["features.intelligence.neuro_map", "features.intelligence.neuro_map_auto_progress"]),
  "limits.security.invitation_member_daily": Object.freeze(["features.member_invitations.enabled"]),
  "limits.security.invitation_member_monthly": Object.freeze(["features.member_invitations.enabled"]),
  "limits.integrations.scim_requests_per_minute": Object.freeze(["features.integrations.scim"]),
});

// The admin list less every row whose companion switch the server left out.
// A list that is not current (a refresh or retry still in flight shows the
// previous read) cannot say whether a companion has been held since, so it
// lists none of these rows until the new read lands.
export function withoutRowsBesideHeldSwitches(settings, { current = true } = {}) {
  if (!Array.isArray(settings)) return settings;
  const listed = new Set(settings.map((item) => item?.key));
  return settings.filter((item) => !Object.hasOwn(SETTING_ACTS_BESIDE, item?.key)
    || (current && SETTING_ACTS_BESIDE[item.key].every((key) => listed.has(key))));
}

// The configuration the settings page lists: as read while it is current;
// while a refresh or retry is in flight, without the rows above.
export function configurationListedWhile(configuration, current) {
  if (current || !Array.isArray(configuration?.settings)) return configuration;
  return { ...configuration, settings: withoutRowsBesideHeldSwitches(configuration.settings, { current: false }) };
}

// Sunday release sweep, signed-in finding 1: the
// admin Job health list names each background job, and a job that serves only
// a held switch would name the held feature. Every product job is written here
// with the switches it serves, read from the server code each job runs:
//   - the weekly issue digest is built only for organizations with the digest
//     switch (20261002151000_issue_intelligence_weekly_digest);
//   - the learning period end tick closes only learning periods, which need
//     the learning period switch (20261103163000_learning_period_engine);
//   - the single sign-on identity link sweep acts only on single sign-on
//     identities (20261003042000_sso_saml_signin).
// Every other job serves no feature switch. tests/held-job-companions.test.js
// fails when a job in src/features/operations/jobRegistry.js has no row here,
// so a new job cannot be listed by omission. Only what the page lists changes:
// the job still runs, its runs are still recorded in organization_job_runs,
// and a released switch brings its row back with no deploy.
export const JOB_ACTS_BESIDE = Object.freeze({
  "mi1-job-health-sync": Object.freeze([]),
  "integration-webhooks-dispatch-tick": Object.freeze([]),
  "notifications-dispatch-tick": Object.freeze([]),
  "account-deletion-reconcile-tick": Object.freeze([]),
  "notifications-expiry-sweep": Object.freeze([]),
  "deadline-notices-tick": Object.freeze([]),
  "ballot-notices-tick": Object.freeze([]),
  "event-notices-tick": Object.freeze([]),
  "appointment-reminders-tick": Object.freeze([]),
  "member-messaging-dispatch": Object.freeze([]),
  "workload-reminders-tick": Object.freeze([]),
  "ballot-choices-mix": Object.freeze([]),
  "ballot-choices-mix-recent": Object.freeze([]),
  "task-files-reconcile-tick": Object.freeze([]),
  "task-maintenance-daily": Object.freeze([]),
  "casework-alert-escalation-tick": Object.freeze([]),
  "casework-reminder-delivery-tick": Object.freeze([]),
  "weekly-question-selection-tick": Object.freeze([]),
  "live-poll-schedule-tick": Object.freeze([]),
  "survey-operations-sweep": Object.freeze([]),
  "minutes-pre-event-notices-tick": Object.freeze([]),
  "knowledge-source-health-tick": Object.freeze([]),
  "organization-automation-tick": Object.freeze([]),
  "mi1-analytics-receipt-retention": Object.freeze([]),
  "event-checkin-token-retention": Object.freeze([]),
  "union-ground-organization-retention": Object.freeze([]),
  "mesh-agency-usage-aggregate-tick": Object.freeze([]),
  "casework-retaliation-timing-tick": Object.freeze([]),
  "casework-deadline-reminder-tick": Object.freeze([]),
  "issue-intelligence-weekly-digest": Object.freeze(["features.intelligence.weekly_digest"]),
  "analytics-usage-digest": Object.freeze([]),
  "learning-period-end-tick": Object.freeze(["features.guidance_onboarding.learning_period"]),
  "pulse-weekly-snapshots": Object.freeze([]),
  "chapter-leadership-claims-tick": Object.freeze([]),
});

// The Job health list less every job whose switch the admin settings list
// left out. With no current settings list (null: not read, or the read
// failed) it cannot say whether a switch is held, so it lists none of those
// jobs. A Compass AI platform operator sees every job. That role does not set
// the holds (a migration or the release calendar does); it is the one
// platform-wide viewer the admin desk can recognise.
/**
 * @template {{ jobName?: string }} T
 * @param {T[]} jobs
 * @param {{ listedSettingKeys?: Set<string> | string[] | null, platformOperator?: boolean }} [scope]
 * @returns {T[]}
 */
export function withoutJobsBesideHeldSwitches(jobs, { listedSettingKeys = null, platformOperator = false } = {}) {
  if (!Array.isArray(jobs) || platformOperator === true) return jobs;
  const listed = listedSettingKeys instanceof Set ? listedSettingKeys : new Set(Array.isArray(listedSettingKeys) ? listedSettingKeys : []);
  const known = listedSettingKeys != null;
  return jobs.filter((job) => {
    const switches = JOB_ACTS_BESIDE[job?.jobName] ?? [];
    return switches.length === 0 || (known && switches.every((key) => listed.has(key)));
  });
}
