// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20260925070000_appointment_history_reason_privacy";
const sql = loadMigrationSql(NAME);
const history = fnBody(sql, "public.get_appointment_history");
const compact = stripComments(history).replace(/\s+/g, " ");
const compactLower = compact.toLowerCase();
const previous = fnBody(
  loadMigrationSql("20260901201000_g3_native_member_journey_boundaries"),
  "public.get_appointment_history",
);

describe("appointment history reason-category privacy", () => {
  it("keeps the superseded projection emitting reasonCategory to every admitted caller", () => {
    expect(previous).toContain("'reasonCategory', appointment.reason_category");
    expect(previous).not.toContain("reason_visible");
  });

  it("emits reasonCategory only for the booking member and the assigned steward", () => {
    expect(compactLower).toMatch(/reason_visible\s*:=\s*caller\s*=\s*appointment\.user_id/);
    expect(compactLower).toContain("caller = appointment.steward_id");
    expect(compactLower).toContain(
      "private.member_has_chapter_role(appointment.chapter_id, array['steward'])",
    );
    expect(compactLower).toMatch(/case\s+when\s+reason_visible\s+then/);
    expect(compactLower).not.toMatch(
      /'appointmenttype',\s*appointment\.appointment_type,\s*'reasoncategory',\s*appointment\.reason_category/,
    );
  });

  it("still admits chapter supervisors to history without widening execute grants", () => {
    expect(compactLower).toContain(
      "private.member_has_chapter_role(appointment.chapter_id, array['coordinator','advisor','admin'])",
    );
    expect(sql.toLowerCase()).toContain(
      "revoke all on function public.get_appointment_history(uuid, timestamptz, uuid, integer) from public, anon;",
    );
    expect(sql.toLowerCase()).toContain(
      "grant execute on function public.get_appointment_history(uuid, timestamptz, uuid, integer) to authenticated, service_role;",
    );
  });

  it("leaves the event-detail scrub and paging contract in place", () => {
    expect(compactLower).toContain("e.detail - 'calendarreason' - 'busyreason'");
    expect(compactLower).toContain("p_limit not between 1 and 50");
    expect(compactLower).toContain("(history.created_at, history.id) < (p_before, p_before_id)");
    expect(compactLower).toContain("'nextbefore', case when history_count = p_limit then next_before else null end");
    expect(compactLower).toContain("'nextbeforeid', case when history_count = p_limit then next_before_id else null end");
  });

  it("is the live definition unless a later reviewed redefinition is pinned here", () => {
    const definers = migrationFiles()
      .filter(({ sql: text }) => /create\s+(or\s+replace\s+)?function\s+public\.get_appointment_history\s*\(/i.test(stripComments(text)))
      .map(({ name }) => name);
    const reviewed = "20261111184200_unit_stewards_member_data_per_member.sql";
    expect(definers.at(-1)).toBe(reviewed);
    const live = stripComments(fnBody(migrationFiles().find(({ name }) => name === reviewed).sql,
      "public.get_appointment_history")).replace(/\s+/g, " ").toLowerCase();
    expect(live).toContain("caller = appointment.user_id");
    expect(live).toContain("caller = appointment.steward_id");
    expect(live).toContain("when reason_visible then");
  });
});
