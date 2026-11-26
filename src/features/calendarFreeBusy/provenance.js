export const CALENDAR_FREEBUSY_DONOR_BASELINE = "donor-baseline-20260721";

export const CALENDAR_FREEBUSY_DONOR_UNITS = Object.freeze([
  {
    auditId: "CR-091",
    disposition: "discard",
    donorPath: "lib/google/calendar.ts",
    destination: null,
    adapted: null,
    rejected: [
      "Next.js server-only Google Calendar event insert/delete/list",
      "@googleapis/calendar service-account org calendar writes",
      "grievance case numbers copied into Google Calendar summaries",
    ],
  },
  {
    auditId: "CR-091",
    disposition: "discard",
    donorPath: "app/dashboard/events/calendar-sync-buttons.tsx",
    destination: null,
    adapted: null,
    rejected: [
      "Next.js dashboard calendar sync buttons",
      "live org-calendar write from the browser session",
    ],
  },
  {
    auditId: "CR-091",
    disposition: "spec_only",
    donorPath: "test/unit/google-calendar.test.ts",
    destination: "src/features/calendarFreeBusy/freebusy.js",
    adapted: "Opaque busy-window parsing and mocked provider tests. No event create/delete path.",
    rejected: ["Google event insert requestBody fixtures", "calendarId: primary writes"],
  },
  {
    auditId: "CR-091",
    disposition: "no_donor",
    donorPath: null,
    destination: "src/features/calendarFreeBusy/oauth.js",
    adapted: "Steward OAuth for free/busy only, fail-closed when the organization has not registered a provider app.",
    rejected: [
      "legacy Supabase project identifiers",
      "fabricated OAuth client secrets",
      "Microsoft Graph donor implementation — none existed",
    ],
  },
]);
