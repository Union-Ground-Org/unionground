// @vitest-environment node
// REQ-UG-RIGHTS-LAW-LIBRARY-20261012: the reference library under
// data/reference/labor-rights/ carries a complete provenance record on every
// row, binds every deadline to its source, and agrees with the migration that
// seeds the casework ULP window.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex, validateDocument } from "../scripts/lib/provenance.mjs";
import { findMigrationName, fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const read = (name) => JSON.parse(readFileSync(new URL(`../data/reference/labor-rights/${name}`, import.meta.url), "utf8"));
const agencies = read("agencies.json");
const documents = read("documents.json");
const UNITS = new Set(["day", "business_day", "week", "month", "year"]);

describe("rights and law library data", () => {
  it("validates every record and resolves every input in the same file", () => {
    for (const doc of [agencies, documents]) {
      const result = validateDocument(doc);
      expect(result.errors).toEqual([]);
      expect(doc.schema).toBe("union-ground/rights-law-library/v1");
    }
  });

  it("puts a record on every agency, deadline, scenario, concept and document", () => {
    const rows = [
      ...agencies.agencies,
      ...agencies.agencies.flatMap((agency) => agency.deadlines),
      ...agencies.scenarios,
      ...agencies.concepts,
      ...agencies.ulp_limitation_periods,
      ...documents.documents,
    ];
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) expect(row.provenance?.provenance_id).toMatch(/^prov-[0-9a-f]{64}$/);
  });

  it("binds each deadline to an exact quote on the page it cites", () => {
    const deadlines = agencies.agencies.flatMap((agency) => agency.deadlines);
    expect(deadlines.length).toBeGreaterThanOrEqual(20);
    for (const deadline of deadlines) {
      expect(deadline.quote.length).toBeGreaterThanOrEqual(20);
      expect(deadline.provenance.extraction.quote_binding).toBe("exact-substring");
      expect(deadline.evidence_url).toBe(deadline.provenance.source.url);
      if (deadline.period) {
        expect(Number.isInteger(deadline.period.value)).toBe(true);
        expect(UNITS.has(deadline.period.unit)).toBe(true);
      }
    }
  });

  it("states months as months, never as day counts", () => {
    const dlr = agencies.agencies.find((agency) => agency.id === "ma-dlr");
    const charge = dlr.deadlines.find((deadline) => deadline.id === "dlr-ulp-charge");
    expect(charge.period).toEqual({ value: 6, unit: "month" });
    expect(charge.statute).toMatch(/456 CMR 15\.04/);
  });

  it("hashes each document body exactly", () => {
    for (const doc of documents.documents) {
      expect(doc.provenance.content_sha256, doc.id).toBe(sha256Hex(doc.body_md));
    }
  });

  it("refuses a tampered or unsourced row", () => {
    const tampered = structuredClone(agencies);
    tampered.agencies[0].provenance.source.publisher = "";
    expect(validateDocument(tampered).ok).toBe(false);
    const orphan = structuredClone(agencies);
    orphan.source_records = [];
    expect(validateDocument(orphan).ok).toBe(false);
  });

  it("keeps the guides neutral about any one union", () => {
    for (const doc of documents.documents.filter((row) => !row.agency_id)) {
      expect(doc.body_md).not.toMatch(/SEIU|Local 509|\b509\b|MassAbility/i);
      expect(doc.body_md).toMatch(/steward/i);
    }
  });

  // CONTENT-UG-RIGHTS-LIBRARY-OSHA-SAFETY-ENTRIES-20261022: the three
  // verified safety corrections, each bound to a primary source.
  describe("OSHA and Massachusetts safety corrections", () => {
    const agency = (id) => agencies.agencies.find((row) => row.id === id);
    const deadline = (id) => agencies.agencies.flatMap((row) => row.deadlines).find((row) => row.id === id);

    it("names the Massachusetts public-sector safety law and the State Plan that enforces it", () => {
      const dls = agency("ma-dls");
      expect(dls.primary_statute).toContain("M.G.L. c.149, s.6 1/2");
      expect(dls.primary_statute).toContain("454 CMR 25.00");
      expect(dls.primary_statute).not.toMatch(/State Plan/);
      expect(dls.additional_statutes.join(" ")).toMatch(/29 CFR 1952\.29.*August 18, 2022/);
      const values = dls.contact.map((row) => `${row.field} ${row.value}`);
      expect(values).toEqual(expect.arrayContaining([
        "phone (508) 616-0461 ext. 1",
        "phone (508) 616-0461 ext. 9488",
        "filingPortal https://www.mass.gov/forms/online-public-sector-workplace-safety-and-health-complaint-form",
        "whistleblowerPortal https://www.mass.gov/forms/online-whistleblower-complaint-form",
      ]));
      const accident = documents.documents.find((row) => row.id === "04-dls-report-public-worksite-accident");
      expect(accident.url).toBe("https://www.mass.gov/info-details/report-an-accident-file-a-complaint-or-request-assistance");
      expect(accident.title).toMatch(/Report an accident/);
      expect(accident.body_md).toMatch(/report an accident involving a public employee/i);
    });

    it("gives safety retaliation its 30-day window and labels the six months as OSHA's citation limit", () => {
      const osha = deadline("osha-whistleblower");
      expect(osha.period).toEqual({ value: 30, unit: "day" });
      expect(osha.statute).toBe("29 U.S.C. 660(c)(2); 29 CFR 1977.15(d)");
      expect(osha.extension).toMatch(/grievance or arbitration.*does not pause/);
      expect(osha.period_text).not.toMatch(/30-180/);
      const citation = deadline("osha-safety-complaint");
      expect(citation.statute).toBe("29 U.S.C. 658(c)");
      expect(citation.claim).toBe("Limit on OSHA citations: six months after the violation");
      expect(osha.trigger).toMatch(/told of the retaliatory action/);
      expect(deadline("dls-whistleblower")).toMatchObject({ period: { value: 30, unit: "day" }, statute: "454 CMR 25.07; 29 CFR 1977.15(d)" });
      expect(deadline("dlr-ulp-charge").period).toEqual({ value: 6, unit: "month" });
      expect(deadline("ma-public-whistleblower-suit")).toMatchObject({ period: { value: 2, unit: "year" }, statute: "M.G.L. c.149, s.185(d), (f)" });
      expect(deadline("ma-public-whistleblower-suit").extension).toMatch(/waives the employee's rights and remedies for the same acts under any other contract, collective bargaining agreement, state law, rule or regulation, or the common law/);
    });

    it("scopes the unsafe-workplace scenario to every state and links the retaliation deadlines", () => {
      const scenario = agencies.scenarios.find((row) => row.id === "unsafe-workplace");
      expect(scenario.summary).toMatch(/depends on your state and on whether you work for a public or private employer/);
      for (const text of ["22 states and territories", "Connecticut, Illinois, Maine, Massachusetts, New Jersey, New York and the Virgin Islands", "Ohio and Wisconsin"]) {
        expect(scenario.summary).toContain(text);
      }
      // No absolute "no filing deadline" claim, and the Massachusetts-only
      // routes (including the DLR charge) are labelled as such.
      expect(scenario.urgency_text).not.toMatch(/no filing deadline/);
      expect(scenario.urgency_text).toMatch(/For Massachusetts public employees: 30 days for a DLS complaint, six months for a DLR prohibited-practice charge/);
      expect(scenario.also_see).toEqual(expect.arrayContaining(["osha", "ma-dlr"]));
      expect(scenario.deadline_ids).toEqual(expect.arrayContaining(["osha-whistleblower", "dls-whistleblower", "dlr-ulp-charge", "ma-public-whistleblower-suit"]));
      const published = new Set(agencies.agencies.flatMap((row) => row.deadlines).map((row) => row.id));
      for (const id of scenario.deadline_ids) expect(published.has(id)).toBe(true);
      const sources = scenario.provenance.derived_from.map((id) => agencies.source_records.find((row) => row.provenance.provenance_id === id)?.provenance.source.url).filter(Boolean);
      expect(sources).toEqual(expect.arrayContaining([
        "https://www.osha.gov/stateplans",
        "https://www.law.cornell.edu/cfr/text/29/1977.15",
        "https://www.osha.gov/sites/default/files/publications/OSHA3812.pdf",
        "https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXI/Chapter149/Section185",
      ]));
    });
  });

});

// No database runs in this suite, so the casework half is pinned in the
// migration text: the trigger fires on insert only and adds the period by the
// calendar, the read routines keep every earlier field, and the day window
// stays the default.
describe("casework ULP jurisdiction migration", () => {
  const sql = loadMigrationSql("rights_law_ulp_jurisdiction_windows");
  const code = stripComments(sql);
  const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

  // PostgreSQL's date + interval 'n months': same day of month, clamped to the
  // last day of a shorter month.
  function plusMonths(iso, months) {
    const [y, m, d] = iso.split("-").map(Number);
    const target = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, last));
    return target.toISOString().slice(0, 10);
  }
  const days = (from, to) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

  it("registers the switch off by default and the jurisdiction setting at none", () => {
    expect(code).toMatch(/\('features\.rights\.law_library', 'boolean',[\s\S]*?'false', null, null, null, 2400, 'guidance_onboarding', true\)/);
    expect(code).toMatch(/\('limits\.casework\.ulp_jurisdiction', 'text',[\s\S]*?'"none"', null, null, array\['none', 'MA'\], 1405, 'casework', false\)/);
    expect(code).toContain("on conflict (key) do nothing;");
    expect(code).not.toMatch(/limits\.casework\.ulp_window_days'[^)]*'\d+'/);
  });

  it("stamps new flags only, by calendar months, and keeps the organization window for none", () => {
    expect(code).toMatch(/create trigger m10_ulp_jurisdiction_window before insert on public\.casework_retaliation_flags\s+for each row execute function private\.casework_ulp_apply_jurisdiction\(\);/);
    expect(code).not.toMatch(/before (insert or )?update[^;]*m10_ulp_jurisdiction_window|m10_ulp_jurisdiction_window before[^;]*update/);
    expect(code).not.toMatch(/update\s+public\.casework_retaliation_flags/);
    const body = fnBody(sql, "private.casework_ulp_apply_jurisdiction");
    expect(body).toContain("((new.incident_on + pg_catalog.make_interval(months => v_row.period_value))::date - new.incident_on)");
    expect(body).toMatch(/if v_code is null or v_code = 'none' then\s+new\.ulp_window_basis := 'organization_limit';\s+return new;/);
    expect(body).toContain("raise exception 'no sourced ULP period for jurisdiction %'");
    expect(code).toContain("add column ulp_window_basis text not null default 'organization_limit'");
  });

  it("lands six months on the calendar date six months later, inside the flag table's bounds", () => {
    for (const [incident, deadline] of [["2026-08-31", "2027-02-28"], ["2026-03-14", "2026-09-14"], ["2027-08-31", "2028-02-29"]]) {
      expect(plusMonths(incident, 6)).toBe(deadline);
      expect(days(incident, deadline)).toBeGreaterThanOrEqual(30);
      expect(days(incident, deadline)).toBeLessThanOrEqual(365);
    }
    expect(code).toMatch(/period_unit = 'month' and period_value between 2 and 11/);
    expect(code).toMatch(/period_unit = 'day' and period_value between 30 and 365/);
  });

  it("keeps every earlier field of the three read routines and adds the source", () => {
    const flagJson = fnBody(sql, "private.casework_retaliation_flag_json");
    for (const key of ["id", "caseId", "source", "incidentOn", "ulpDeadline", "daysLeft", "windowDays", "status", "note", "reviewedAt", "warningSentAt", "urgentSentAt", "createdAt", "adverseKind", "protectedActivityOn", "daysBetween", "confidence", "priorDisciplineCount", "staffNotifiedAt", "windowBasis", "windowSource"]) {
      expect(flagJson).toContain(`'${key}', `);
    }
    const list = fnBody(sql, "public.casework_list_case_retaliation_flags");
    expect(list).toContain("'windowDays', private.organization_limit(v_case.organization_id, 'limits.casework.ulp_window_days')");
    expect(list).toContain("'jurisdiction', v_jurisdiction");
    expect(list).toContain("private.casework_staff_can_access(p_case_id)");
    const summary = latestFnBody("public.get_my_case_ulp_summary");
    expect(summary).toMatch(/as \$function\$\s*begin\s+perform private\.member_pin_require_full_session\(\);/i);
    for (const key of ["caseId", "ulpDeadline", "retaliationFlagged", "stewardNotified", "ulpWarningDays", "ulpCriticalDays", "ulpSource"]) {
      expect(summary).toContain(`'${key}', `);
    }
    expect(summary).toContain("'ulpSource', case when s.enabled then");
    expect(summary).toContain("and d.ulp_deadline = s.ulp_deadline");
  });

  it("is pinned in the database contract", () => {
    expect(contract.triggers).toContainEqual(expect.objectContaining({
      table: "casework_retaliation_flags", name: "m10_ulp_jurisdiction_window", function: "private.casework_ulp_apply_jurisdiction", timing: "BEFORE", events: "INSERT",
    }));
    expect(contract.functions).toContainEqual(expect.objectContaining({ sig: "private.casework_ulp_apply_jurisdiction()", secdef: true, exec: "" }));
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(contract.tableGrants).toContainEqual({ table: "private.reference_ulp_limitation_periods", role, privileges: "" });
    }
    expect(contract.constraints.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      "reference_ulp_limitation_periods_provenance_complete", "casework_retaliation_flags_ulp_window_basis_check",
    ]));
  });
});
