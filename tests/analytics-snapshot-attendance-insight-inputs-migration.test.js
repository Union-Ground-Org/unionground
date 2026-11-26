// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ENGAGEMENT_EVENT_TAXONOMY } from "../src/features/analytics/contract.js";
import { helperFirst, parseFunctions, sharedReadEntry } from "../scripts/account-case-graph-inventory.mjs";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";

// CR-037 / CR-049: the Insights and Attendance engines need real series and
// attendanceEvents inputs. Resolve the snapshot from whichever migration
// declares it last so a later redefinition cannot silently restore the
// placeholders.
const NAME = "public.get_organization_analytics_snapshot";
const latest = [...migrationFiles()].reverse().find(({ sql }) => (
  stripComments(sql).toLowerCase().includes(`function ${NAME}(`)
));
const body = stripComments(fnBody(latest.sql, NAME));
// CREATE OR REPLACE retains the ACL. Keep the last explicit grant separate
// from the current body rather than requiring every successor to repeat it.
const latestAcl = [...migrationFiles()].reverse().find(({ sql }) =>
  stripComments(sql).includes(`grant execute on function ${NAME}()`));

describe("organization analytics snapshot feeds the insight and attendance engines", () => {
  it("is defined last by the CR-037/CR-049 migration or a successor", () => {
    expect(latest.name >= "20260924070000_analytics_snapshot_attendance_insight_inputs.sql").toBe(true);
  });

  it("keeps the session-derived organization, MFA and staff-role gates and the audit write", () => {
    expect(body).toContain("org uuid := private.mi1_require_selected_organization()");
    expect(body).toContain("if not private.mfa_satisfied() then raise exception 'mfa required'");
    expect(body).toContain(
      "private.has_organization_role(org, array['steward', 'coordinator', 'advisor', 'admin', 'vp'])",
    );
    expect(body).toContain("privacy_threshold integer := private.organization_limit(org, 'limits.analytics.anonymity_floor')");
    expect(body).toContain("'analytics_snapshot_read'");
    expect(latestAcl.sql).toMatch(
      /revoke all on function public\.get_organization_analytics_snapshot\(\)\s+from public, anon, authenticated, service_role;/,
    );
    expect(latestAcl.sql).toContain("grant execute on function public.get_organization_analytics_snapshot() to authenticated;");
  });

  it("keeps the case-graph first gate or its exact reviewed shared-read replacement", () => {
    const entry = parseFunctions(latest.sql, latest.name).find((entry) => entry.name === NAME);
    expect(helperFirst(entry.source) || sharedReadEntry(entry)).toBe(true);
  });

  it("no longer hardcodes the series inputs or attendance events", () => {
    expect(body).not.toMatch(/'attendanceRate', null/);
    expect(body).not.toMatch(/'engagementMean', null/);
    expect(body).not.toMatch(/'usageViews', null/);
    expect(body).not.toContain("'attendanceEvents', '[]'::jsonb");
    expect(body).toContain("from public.meeting_attendance ma");
    expect(body).toContain("join public.meeting_attendance ma on ma.record_id = r.id");
  });

  it("scopes every new aggregate to the caller's organization and gates it on the person floor", () => {
    expect(body).toContain("join public.chapters c on c.id = r.chapter_id and c.organization_id = org");
    expect(body).toContain("where e.organization_id = org and e.chapter_id = c.id");
    expect(body).toContain("where p.organization_id = org and p.last_seen_at >= generated - interval '30 days'");
    expect(body).toContain("attendance_totals.missed_people >= privacy_threshold");
    expect(body).toContain("attendance_totals.present_people >= privacy_threshold");
    expect(body).toContain("engagement_totals.members >= privacy_threshold");
    expect(body).toContain("usage_totals.value >= privacy_threshold");
    expect(body).toMatch(/'checkIns', case when counted\.present_people >= privacy_threshold/);
    // Complement suppression: the roster minus the attendees must also clear
    // the floor, or rsvpGoing - checkIns discloses a small absent cohort.
    expect(body).toMatch(
      /'rsvpGoing', case when counted\.present_people >= privacy_threshold\s+and counted\.roster_people - counted\.present_people >= privacy_threshold/,
    );
    expect(body).toContain("limit 200");
  });

  it("scores engagement with the same caps and weights as the client taxonomy", () => {
    for (const [eventType, spec] of Object.entries(ENGAGEMENT_EVENT_TAXONOMY)) {
      expect(body).toContain(`('${eventType}', ${spec.cap}, ${spec.weight})`);
    }
  });
});
