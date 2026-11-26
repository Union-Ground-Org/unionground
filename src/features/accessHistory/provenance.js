export const ACCESS_DONOR_BASELINE = "donor-baseline-20260721";

export const ACCESS_DONOR_UNITS = Object.freeze([
  {
    auditId: "CR-086",
    disposition: "port_adapt",
    donorPath: "app/dashboard/my-activity-log/page.tsx",
    destination: "src/features/accessHistory/presenters.js",
    adapted: "Member-facing labels for staff view/update of profile and cases, with range windows and empty/loading/retry states.",
    rejected: [
      "Next.js server components and searchParams",
      "date-fns clocked cutoffs in the domain engine",
      "joined actor email or full member rows",
    ],
  },
  {
    auditId: "CR-086",
    disposition: "spec_only",
    donorPath: "lib/union-ground/activity-log.ts",
    destination: "src/features/accessHistory/event.js",
    adapted: "Bounded event envelope. The donor feed mixed the member's own votes and RSVPs; this surface is staff-access transparency only.",
    rejected: [
      "member-own grievance/survey/rsvp/vote/question buckets as access history",
      "server-only createClient merge across unrelated tables",
    ],
  },
  {
    auditId: "CR-086",
    disposition: "discard",
    donorPath: "app/m/activity-log/ActivityLogClient.tsx",
    destination: null,
    adapted: null,
    rejected: ["Next.js mobile client", "demo-fallback sanitizers as live copy"],
  },
]);
