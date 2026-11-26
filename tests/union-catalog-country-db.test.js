// @vitest-environment node
// Country-aware catalog rehearsal. All rows below are organization-only
// fictional fixtures; all writes roll back on the runner-owned database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateRelease, loadRelease, readRelease, releaseCounts, verifyRelease } from "../scripts/load-union-catalog.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { exclusionList } from "./helpers/union-catalog-fixture.mjs";
import { writeBaseRelease } from "./helpers/union-catalog-research-fixture.mjs";
import { AMERICAS_COUNTRIES, combinedAmericasRelease, fixtureLocale, sampleKey } from "./helpers/union-catalog-americas-fixture.mjs";

const live = process.env.RUN_UNION_CATALOG_DB_TESTS === "1" ? describe : describe.skip;
live("country-aware catalog persistence and readers", () => {
  let client, dir, base, combined, baseline;
  const exclusions = exclusionList();
  const tables = ["organizations", "edges", "subunits", "seat_outlines", "contacts", "documents", "document_subunits"];
  async function snapshot() {
    const out = {};
    for (const table of tables) out[table] = (await client.query(`select pg_catalog.to_jsonb(t) as row from private.catalog_${table} as t
      where t.retired_release_id is null order by pg_catalog.to_jsonb(t)::text`)).rows.map((row) => row.row);
    return out;
  }
  async function apply(bundle) {
    await loadRelease({ client, ...bundle, exclusions });
    expect((await verifyRelease({ client, ...bundle, exclusions })).problems).toEqual([]);
    return activateRelease({ client, label: bundle.manifest.label });
  }
  async function asRole(role, query, values = [], member = false) {
    await client.query("savepoint locale_role");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role, ...(member ? { sub: "85110000-0000-4000-8000-000000000001" } : {}) })]);
      await client.query(`set local role ${role}`);
      return (await client.query(query, values)).rows[0]?.value;
    } finally { await client.query("rollback to savepoint locale_role"); await client.query("release savepoint locale_role"); }
  }
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    dir = mkdtempSync(join(tmpdir(), "catalog-country-db-"));
    base = readRelease(writeBaseRelease(dir).dir);
    combined = combinedAmericasRelease(base);
  });
  afterAll(async () => {
    if (client) { await client.query("rollback"); await client.end(); }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads, verifies and activates an unchanged pre-locale release with US defaults", async () => {
    await apply(base);
    baseline = await snapshot();
    const rows = (await client.query("select country,state,zip5,language,timezone,locale_unknowns from private.catalog_organizations where retired_release_id is null")).rows;
    expect(rows.length).toBe(base.release.organizations.length);
    expect(rows.every((row) => row.country === "US" && row.language === null && row.timezone === null)).toBe(true);
    expect(rows.map((row) => [row.state, row.zip5]).sort()).toEqual(base.release.organizations.map((row) => [row.state, row.zip5]).sort());
    expect(rows[0].locale_unknowns).toMatchObject({ language: "legacy_not_recorded", timezone: "legacy_not_recorded" });
  });

  it("stages a cumulative Americas sample invisibly, activates it, and preserves every accepted US content row", async () => {
    await loadRelease({ client, ...combined, exclusions });
    expect(await asRole("anon", "select public.get_union_catalog_profile($1) as value", [sampleKey("CA")])).toEqual({ found: false });
    expect((await verifyRelease({ client, ...combined, exclusions })).problems).toEqual([]);
    const diff = await activateRelease({ client, label: combined.manifest.label });
    expect(diff).toMatchObject({ organizationsRetired: 0, subunitsRetired: 0, tenantOrganizationsBefore: diff.tenantOrganizationsAfter });
    const after = await snapshot();
    for (const table of tables) for (const row of baseline[table]) expect(after[table], table).toContainEqual(row);
    const ids = (await client.query("select count(*)::integer as n from private.catalog_identifiers where retired_release_id is null")).rows[0].n;
    expect(ids).toBe(AMERICAS_COUNTRIES.length);
    expect((await client.query("select count(*)::integer as n from private.catalog_organizations where catalog_key like 'ug-sample%' and olms_file_number is not null")).rows[0].n).toBe(0);
  });

  it("returns country/subdivision filters and all locale fields for visitors, members and bot readers with the same privacy boundary", async () => {
    for (const country of AMERICAS_COUNTRIES) {
      const result = await asRole("anon", "select public.search_union_catalog_by_country(null,null,null,null,1,$1,null) as value", [country]);
      expect(result.rows.map((row) => row.key), country).toContain(sampleKey(country));
      expect(result.rows.length).toBeLessThanOrEqual(25);
      expect(result.rows.every((row) => row.country === country)).toBe(true);
    }
    for (const [role, member] of [["anon", false], ["authenticated", true], ["service_role", false]]) {
      const rows = await asRole(role, "select public.search_union_catalog_by_country(null,null,null,null,1,'CA','CA-ON') as value", [], member);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ key: sampleKey("CA"), country: "CA", subdivision: "CA-ON", postalCode: "K1A 0B1", language: "fr-CA", timezone: "America/Toronto" });
      const profile = await asRole(role, "select public.get_union_catalog_profile_by_country($1,'CA','CA-ON') as value", [sampleKey("CA")], member);
      expect(profile).toMatchObject({ found: true, documentLinks: member ? "included" : "members", organization: { country: "CA", postalCode: "K1A 0B1" }, coverage: { country: "CA", language: "fr-CA" } });
      for (const field of ["subunits", "seatOutlines", "contacts", "documents", "parents"]) expect(profile[field][0], field).toMatchObject({ country: "CA", timezone: "America/Toronto" });
      expect(profile.documents[0].url).toBe(member ? "https://sampleca.example/bylaws.pdf" : null);
    }
    expect(await asRole("anon", "select public.get_union_catalog_profile_by_country($1,'MX',null) as value", [sampleKey("CA")])).toEqual({ found: false });
    const old = await asRole("anon", "select public.search_union_catalog('Example',null,null,null,1) as value");
    expect(old.rows.length).toBeGreaterThan(0);
  });

  it("updates locale through every upsert, coverage rebuild and both research tables", async () => {
    const update = structuredClone(combined);
    update.manifest.label = update.release.label = "20261112-52";
    const patch = { ...fixtureLocale(), postal_code: "K1A 0B2" };
    for (const table of tables) for (const row of update.release[table]) if (row.country === "CA") Object.assign(row, patch);
    await apply(update);
    const withResearch = structuredClone(update);
    withResearch.manifest.label = withResearch.release.label = "20261112-53";
    withResearch.release.research_facts = [{ ...patch, fact_key: `rf-${"a".repeat(32)}`, catalog_key: sampleKey("CA"), evidence_tier: 2,
      binding: "bound", publisher_candidates: [], fact_kind: "contract", title: null, url: "https://sampleca.example/contract.pdf",
      url_host: "sampleca.example", as_of: "2026-11-12", unresolved: [], source_sha256: "a".repeat(64) }];
    withResearch.release.research_categories = [{ ...patch, category_key: `rc-${"b".repeat(32)}`, catalog_key: sampleKey("CA"), evidence_tier: 3,
      category: "contracts", outcome: "captured_publication", gate_contract: "usability_contract_v5.category_gate", evaluated_on: "2026-11-12" }];
    withResearch.manifest.research = { base: { artifactSha256: update.manifest.artifact.sha256, label: update.manifest.label } };
    withResearch.manifest.counts = releaseCounts(withResearch.release);
    await apply(withResearch);
    withResearch.manifest.label = withResearch.release.label = "20261112-54";
    for (const table of ["research_facts", "research_categories"]) withResearch.release[table][0].language = "en-CA";
    await apply(withResearch);
    for (const table of [...tables.filter((table) => table !== "document_subunits"), "coverage", "research_facts", "research_categories"]) {
      const rows = (await client.query(`select postal_code,language from private.catalog_${table} where country = 'CA'`)).rows;
      expect(rows.length, table).toBeGreaterThan(0);
      expect(rows.every((row) => row.postal_code === "K1A 0B2"), table).toBe(true);
      if (table.startsWith("research_")) expect(rows[0].language).toBe("en-CA");
    }
  });

  it("refuses invalid country, subdivision, timezone, unreasoned nulls and invalid legacy geography in SQL", async () => {
    for (const expression of ["country = 'ZZ'", "subdivision = 'CA-ZZ'", "subdivision = 'MX-JAL'", "timezone = 'America/Invented'", "timezone = 'america/toronto'",
      "timezone = null", "state = 'ON'", "zip5 = '12345'", "country = null, state = 'MA'"]) {
      await client.query("savepoint invalid_locale");
      await expect(client.query(`update private.catalog_organizations set ${expression} where catalog_key = $1`, [sampleKey("CA")])).rejects.toMatchObject({ code: "23514" });
      await client.query("rollback to savepoint invalid_locale"); await client.query("release savepoint invalid_locale");
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      await expect(asRole(role, "select * from private.catalog_identifiers")).rejects.toMatchObject({ code: "42501" });
    }
    expect((await client.query("select private.catalog_language_valid('de-1996-t-de-1996') as valid")).rows[0].valid).toBe(true);
    expect((await client.query("select private.catalog_language_valid('de-1996-1996') as valid")).rows[0].valid).toBe(false);
  });
});
