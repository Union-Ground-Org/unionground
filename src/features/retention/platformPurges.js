// Data classes whose rows a global platform cron already deletes at the class's
// fixed 90-day window, whatever an organization's retention policy says
// (DOCS-UG-RETENTION-PLATFORM-PURGES-BYPASS-POLICY-AUDIT-20260921). The
// engine can neither lengthen nor suspend those purges, and they write no
// organization audit-ledger entry, so the Admin card shows these classes as
// read-only platform-enforced cards instead of offering an execution toggle
// that controls nothing. Each entry names the cron job and the purge function
// that do the work; tests/mi1-retention-engine-migration.test.js checks this
// list against the migrations and scripts/db-contract.json.
export const PLATFORM_ENFORCED_RETENTION_CLASSES = Object.freeze({
  public_event_rsvps: Object.freeze({
    cronJob: "mi1-public-rsvp-retention",
    purgeFunction: "private.purge_expired_public_event_rsvps",
  }),
  deleted_chapter_tasks: Object.freeze({
    cronJob: "task-maintenance-daily",
    purgeFunction: "private.purge_deleted_chapter_tasks",
  }),
});
