// @vitest-environment node
//
// Two halves, because the registry has two failure surfaces.
//
// The migration pins are a tripwire, not a proof: they assert what the FILE
// says, and a later create-or-replace can supersede any of them while this
// stays green. Current-state truth lives in scripts/db-contract.json, checked
// by `npm run verify:db`.
//
// The loader pins ARE proofs — transformRow and violations are pure, so what
// runs here is what runs against production.
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";
import { COLUMNS, summarise, transformRow, violations } from "../scripts/load-union-orgs.mjs";

const sql = loadMigrationSql("union_orgs_registry");
const executable = stripComments(sql);

describe("union_orgs migration invariants", () => {
  it("is readable by both client roles and writable by neither", () => {
    expect(executable).toContain("grant select on public.union_orgs to anon, authenticated");
    expect(executable).toContain("revoke insert, update, delete on public.union_orgs from anon, authenticated");
    // The revoke set is INSERT/UPDATE/DELETE and deliberately NOT the four-bit
    // TRUNCATE/REFERENCES/TRIGGER/MAINTAIN revoke older migrations perform:
    // 20260726010000 fixed the stock default ACL at the source, so tables
    // created after it are born `arwd`. A four-bit revoke here would be a
    // no-op that reads like protection.
    expect(executable, "no client write grant may be issued").not.toMatch(
      /grant [^;]*(insert|update|delete)[^;]*on public\.union_orgs[^;]*to (anon|authenticated)/i,
    );
  });

  it("carries the MFA restrictive policy the DO-loop sweep could not reach", () => {
    // policyCoverage.restrictiveOnEveryRlsTable requires this on EVERY
    // RLS-enabled public table, but it was stamped by a DO loop at its own
    // migration time — a table created later silently lacks it, and only the
    // live catalog sweep can see that. This pin is the offline half.
    expect(executable).toContain("create policy mfa_assurance");
    expect(executable).toContain("as restrictive");
    expect(executable).toContain("private.mfa_satisfied()");
  });

  it("keeps the public read policy select-only and anon-inclusive", () => {
    const start = executable.indexOf("create policy union_orgs_public_read");
    expect(start).toBeGreaterThan(-1);
    const policy = executable.slice(start, executable.indexOf(";", start));
    expect(policy).toContain("for select to anon, authenticated");
    expect(policy, "a write command here would bypass the revoke above").not.toMatch(/for (all|insert|update|delete)/);
  });

  it("does not make parent_olms_file_number a foreign key", () => {
    // 194 rows have no parent and some parents are not themselves directory
    // rows. An FK would reject them at load — and would do it 20,000 rows in.
    expect(executable).not.toMatch(/parent_olms_file_number[^,]*references/i);
    expect(executable).not.toMatch(/foreign key\s*\(\s*parent_olms_file_number/i);
  });

  it("pins the four observed level values and nothing wider", () => {
    expect(executable).toContain("check (level in ('local', 'intermediate', 'unknown', 'national'))");
  });

  it("pairs the coordinate and membership columns", () => {
    expect(executable).toContain("check ((latitude is null) = (longitude is null))");
    expect(executable).toContain("check ((members_latest is null) = (members_latest_year is null))");
  });

  it("takes no structural dependency on chapters — union_orgs is the external axis", () => {
    // chapter_agency_roster's "agency" is a Massachusetts EMPLOYER carried in
    // chapters.region. A union_org is an EXTERNAL labor organization. Wiring
    // the two together would be a category error.
    //
    // The assertion is deliberately structural rather than a word search: the
    // table's COMMENT names chapters on purpose, to warn the next reader off
    // exactly that join, and stripComments preserves quoted literals (as it
    // must — a naive stripper that ate them would turn every negative pin in
    // this suite into a false negative). So drop the comment statements first,
    // then look for a real dependency.
    const ddl = executable.replace(/comment on [\s\S]*?';/g, "");
    expect(ddl, "the warning in the table comment is not itself a dependency").toContain("union_orgs");
    expect(ddl).not.toMatch(/references\s+public\.chapters/i);
    expect(ddl).not.toMatch(/\bjoin\s+public\.chapters/i);
    expect(ddl).not.toMatch(/chapter_agency_roster/);
    expect(ddl).not.toMatch(/chapter_id/);
  });

  it("creates the trigram index the picker's fragment search needs", () => {
    expect(executable).toContain("create extension if not exists pg_trgm with schema extensions");
    expect(executable).toContain("using gin (name extensions.gin_trgm_ops)");
  });
});

// A directory record shaped exactly like the source: parent, membership and
// sector are OBJECTS, and the column names are camelCase.
const record = (over = {}) => ({
  id: "olms-1",
  olmsFileNumber: 1,
  name: "TEST LOCAL",
  affiliation: "AFT",
  designation: "LU",
  localNumber: "509",
  level: "local",
  parent: { olmsFileNumber: 12, affiliation: "AFT", name: "TEACHERS AFL-CIO" },
  sector: { publicPrivate: "public", tags: ["education"] },
  city: "BOSTON",
  state: "MA",
  zip: "02111",
  latitude: 42.35,
  longitude: -71.05,
  geocodePrecision: "address",
  geocodeMatchType: "Exact",
  website: null,
  membership: { latest: { count: 100, year: 2025 }, history: [{ year: 2025, count: 100 }] },
  finances: { form: "LM-2" },
  publicRecordCoverage: { sources: 2 },
  sources: [{ url: "https://olmsapps.dol.gov/olpdr/", retrievedAt: "2026-07-19T06:35:53+00:00" }],
  enrichmentStatus: "enriched",
  updatedAt: "2026-07-19T15:08:48+00:00",
  ...over,
});

describe("transformRow", () => {
  it("flattens the nested parent, membership and sector objects", () => {
    const row = transformRow(record(), "sha");
    expect(row.parent_olms_file_number).toBe(12);
    expect(row.parent_affiliation).toBe("AFT");
    expect(row.parent_name).toBe("TEACHERS AFL-CIO");
    expect(row.members_latest).toBe(100);
    expect(row.members_latest_year).toBe(2025);
    expect(row.sector_public_private).toBe("public");
    expect(row.sector_tags).toEqual(["education"]);
    expect(row.source_updated_at).toBe("2026-07-19T15:08:48+00:00");
    expect(row.atlas_manifest_sha).toBe("sha");
  });

  it("collapses a missing parent to nulls rather than throwing (194 real rows)", () => {
    const row = transformRow(record({ parent: null }), "sha");
    expect(row.parent_olms_file_number).toBeNull();
    expect(row.parent_affiliation).toBeNull();
    expect(row.parent_name).toBeNull();
    expect(violations(row)).toEqual([]);
  });

  it("collapses a missing membership to paired nulls (1,145 real rows)", () => {
    const row = transformRow(record({ membership: null }), "sha");
    expect(row.members_latest).toBeNull();
    expect(row.members_latest_year).toBeNull();
    // Empty array, not null: the column is NOT NULL with a '[]' default and a
    // null would be rejected by the insert rather than defaulted, because the
    // loader names the column explicitly.
    expect(row.membership_history).toEqual([]);
    expect(violations(row)).toEqual([]);
  });

  it("defaults a missing sector to an empty tag array", () => {
    const row = transformRow(record({ sector: null }), "sha");
    expect(row.sector_public_private).toBeNull();
    expect(row.sector_tags).toEqual([]);
  });

  it("emits exactly the columns the loader inserts, in no other shape", () => {
    const row = transformRow(record(), "sha");
    expect(Object.keys(row).sort()).toEqual([...COLUMNS].sort());
  });
});

describe("violations", () => {
  it("passes a well-formed row", () => {
    expect(violations(transformRow(record(), "sha"))).toEqual([]);
  });

  it("catches an unknown level before 20,699 rows hit the database", () => {
    // Without this the constraint fires inside a 500-row batch and names no id.
    const problems = violations(transformRow(record({ level: "regional" }), "sha"));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^level "regional" is not one of/);
  });

  it("catches a half-geocoded row", () => {
    expect(violations(transformRow(record({ longitude: null }), "sha")))
      .toContain("latitude/longitude are not paired");
  });

  it("catches a membership count with no year", () => {
    const row = transformRow(record(), "sha");
    row.members_latest_year = null;
    expect(violations(row)).toContain("members_latest/year are not paired");
  });

  it("accepts a null geocode_precision but rejects an unknown one", () => {
    expect(violations(transformRow(record({ geocodePrecision: null }), "sha"))).toEqual([]);
    expect(violations(transformRow(record({ geocodePrecision: "county" }), "sha")))
      .toContain('geocode_precision "county" is unknown');
  });

  it("rejects an unknown enrichment_status", () => {
    expect(violations(transformRow(record({ enrichmentStatus: "pending" }), "sha")))
      .toContain('enrichment_status "pending" is unknown');
  });
});

// `verify` compares these numbers against the same aggregates read back from
// the live table, so anything summarise cannot see is something a wrong load
// can hide behind. Both cases below are from the 2026-07-26 adversarial review.
describe("summarise", () => {
  const row = (over = {}) => ({
    state: "MA",
    affiliation: "SEIU",
    latitude: 42,
    members_latest: 10,
    membership_history: [{ year: 2024, count: 10 }],
    finances: { receipts: 1 },
    public_record_coverage: { lm2: true },
    sources: [{ kind: "olms" }],
    ...over,
  });

  it("counts the nested payload, so a scalar-only load cannot pass verify", () => {
    // The defect this closes: membership_history and sources DEFAULT to '[]'
    // and the other two to NULL, so 20,699 rows written with every jsonb value
    // dropped matched on every scalar dimension and reported PASS.
    const full = summarise([row(), row()]);
    expect(full).toMatchObject({ withHistory: 2, historyPoints: 2, withSources: 2, sourceRefs: 2, withFinances: 2, withCoverage: 2 });

    const gutted = summarise([
      row({ membership_history: [], finances: null, public_record_coverage: null, sources: [] }),
      row({ membership_history: [], finances: null, public_record_coverage: null, sources: [] }),
    ]);
    expect(gutted.rows, "the scalar dimensions still agree — that is the trap").toBe(full.rows);
    expect(gutted.states).toBe(full.states);
    expect(gutted.geocoded).toBe(full.geocoded);
    expect(gutted.withHistory).toBe(0);
    expect(gutted.sourceRefs).toBe(0);
  });

  it("counts entries as well as rows, catching a truncated history", () => {
    // A load that kept one history point per union would match withHistory
    // exactly; only the cardinality separates it from a complete one.
    const truncated = summarise([row({ membership_history: [{ year: 2024, count: 10 }] })]);
    const complete = summarise([row({ membership_history: [{ year: 2023, count: 9 }, { year: 2024, count: 10 }] })]);
    expect(truncated.withHistory).toBe(complete.withHistory);
    expect(truncated.historyPoints).not.toBe(complete.historyPoints);
  });

  it("excludes nulls from the distinct counts, as SQL's count(distinct) does", () => {
    // A JS Set counts null as a value; count(distinct state) does not. The
    // divergence would have failed verify on a correct load the first time an
    // Atlas build shipped a union with no state.
    const stats = summarise([row(), row({ state: null, affiliation: null })]);
    expect(stats.states, "MA only — the null is not a state").toBe(1);
    expect(stats.affiliations).toBe(1);
  });
});
