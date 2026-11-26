// @vitest-environment node
// Record #8511 part 2: the disposable-database rehearsal through the exporter.
// catalog:export builds both releases from snapshots: the accepted base
// (fictional U.S. filers) and the same base combined with the 55-jurisdiction
// Americas sample in the research build's own input shape. The base is
// loaded, verified and activated; then the combined release is planned,
// loaded, verified and activated, and searched by every country. Every row
// is fictional and every write rolls back on the runner-owned database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateRelease, loadRelease, planRelease, readRelease, verifyRelease } from "../scripts/load-union-catalog.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { PEOPLE, PERSON_EMAILS, PERSON_PHONES, exclusionList } from "./helpers/union-catalog-fixture.mjs";
import { writeBaseRelease } from "./helpers/union-catalog-research-fixture.mjs";
import { AMERICAS_COUNTRIES, addAmericasSnapshot, exportKey, exportLedgerId } from "./helpers/union-catalog-americas-fixture.mjs";

// A person listed on the Mexican sample body; none of it may reach a shared table.
const ROSA = Object.freeze({ name: "Rosa Fixtureperson", email: "rosa.fixtureperson@union-mx.example", phone: "+52 33 5555 0161" });
const SENTINELS = [...Object.values(PEOPLE), ...PERSON_EMAILS, ...PERSON_PHONES, ...Object.values(ROSA), "+523355550161"];
const TABLES = ["organizations", "edges", "subunits", "seat_outlines", "contacts", "documents", "document_subunits"];

function withAmericas(fixture) {
  addAmericasSnapshot(fixture);
  const mx = fixture.enriched[exportLedgerId("MX")];
  mx.leaders = [{ name: ROSA.name, title: "Secretaria General", email: ROSA.email, phone: ROSA.phone }];
  mx.offices.push({ name: "Annex", source: "https://www.union-mx.example/contact", email: ROSA.email, phone: ROSA.phone, country: "MX" });
}

const live = process.env.RUN_UNION_CATALOG_DB_TESTS === "1" ? describe : describe.skip;
live("country-aware catalog: exporter rehearsal over the accepted base", () => {
  let client, dir, base, next, baseline;
  const exclusions = exclusionList();
  async function snapshot() {
    const out = {};
    for (const table of TABLES) {
      out[table] = (await client.query(`select pg_catalog.to_jsonb(t) as row from private.catalog_${table} as t
        where t.retired_release_id is null order by pg_catalog.to_jsonb(t)::text`)).rows.map((row) => row.row);
    }
    return out;
  }
  async function anon(query, values = [], role = "anon") {
    await client.query("savepoint export_anon");
    try {
      const claims = role === "anon" ? { role } : { role, sub: "85110000-0000-4000-8000-000000000002" };
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      await client.query(`set local role ${role}`);
      return (await client.query(query, values)).rows[0]?.value;
    } finally {
      await client.query("rollback to savepoint export_anon");
      await client.query("release savepoint export_anon");
    }
  }
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    dir = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), "catalog-country-export-db-"));
    base = readRelease(writeBaseRelease(dir, { label: "20261114-60" }).dir);
    next = readRelease(writeBaseRelease(dir, { label: "20261114-61", mutate: withAmericas }).dir);
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads, verifies and activates the exported base unchanged", async () => {
    await loadRelease({ client, ...base, exclusions });
    expect((await verifyRelease({ client, ...base, exclusions })).problems).toEqual([]);
    await activateRelease({ client, label: base.manifest.label });
    baseline = await snapshot();
    expect(baseline.organizations.every((row) => row.country === "US")).toBe(true);
  });

  it("plans, loads, verifies and activates the combined export with every base row unchanged and nothing retired", async () => {
    const plan = planRelease(next, { previous: base });
    expect(plan.label).toBe("20261114-61");
    await loadRelease({ client, ...next, exclusions });
    expect(await anon("select public.get_union_catalog_profile($1) as value", [exportKey("CA")])).toEqual({ found: false });
    expect((await verifyRelease({ client, ...next, exclusions })).problems).toEqual([]);
    const organizationsBefore = (await client.query("select count(*)::integer as n from public.organizations")).rows[0].n;
    const diff = await activateRelease({ client, label: next.manifest.label });
    expect(diff).toMatchObject({ organizationsAdded: AMERICAS_COUNTRIES.length, organizationsRetired: 0, subunitsRetired: 0 });
    expect((await client.query("select count(*)::integer as n from public.organizations")).rows[0].n).toBe(organizationsBefore);
    const after = await snapshot();
    for (const table of TABLES) for (const row of baseline[table]) expect(after[table], table).toContainEqual(row);
    const counts = (await client.query(`select
        (select count(*)::integer from private.catalog_identifiers where retired_release_id is null) as identifiers,
        (select count(*)::integer from private.catalog_organizations where catalog_key like 'ug-ex%' and olms_file_number is null and union_org_id is null) as bodies`)).rows[0];
    expect(counts).toEqual({ identifiers: AMERICAS_COUNTRIES.length, bodies: AMERICAS_COUNTRIES.length });
  });

  it("finds every country's body by country, with its locale, contacts and identifiers kept out of reach", async () => {
    for (const country of AMERICAS_COUNTRIES) {
      const result = await anon("select public.search_union_catalog_by_country(null,null,null,null,1,$1,null) as value", [country]);
      expect(result.rows.map((row) => row.key), country).toContain(exportKey(country));
      expect(result.rows.every((row) => row.country === country), country).toBe(true);
    }
    // A signed-in member reads the full locale bundle and the organization's
    // own mailbox through the profile.
    const profile = await anon("select public.get_union_catalog_profile_by_country($1,'BR','BR-SP') as value", [exportKey("BR")], "authenticated");
    expect(profile).toMatchObject({ found: true, organization: { country: "BR", subdivision: "BR-SP", postalCode: "01000-000", language: "pt-BR", timezone: "America/Sao_Paulo" } });
    expect(profile.contacts.map((row) => row.value)).toContain("contato@fixture-sindicato.org.br");
    expect(profile.identifiers).toBeUndefined();
    const visitor = await anon("select public.get_union_catalog_profile_by_country($1,'BR','BR-SP') as value", [exportKey("BR")]);
    expect(visitor).toMatchObject({ found: true, organization: { country: "BR", subdivision: "BR-SP", language: "pt-BR" } });
    const ca = await anon("select public.get_union_catalog_profile_by_country($1,'CA','CA-ON') as value", [exportKey("CA")]);
    expect(ca.contacts.map((row) => row.value)).toContain("+16135550142");
    await expect(anon("select count(*) from private.catalog_identifiers")).rejects.toMatchObject({ code: "42501" });
  });

  it("carries no listed person's name, email or phone in any staged or live catalog table", async () => {
    const liveRows = [];
    for (const table of [...TABLES, "identifiers", "coverage"]) {
      const { rows } = await client.query(`select pg_catalog.to_jsonb(t)::text as row from private.catalog_${table} as t`);
      liveRows.push(...rows.map((row) => row.row));
    }
    const { rows } = await client.query(
      "select s.content::text as content from private.catalog_staging s join private.catalog_releases r on r.id = s.release_id where r.label = any($1)",
      [[base.manifest.label, next.manifest.label]],
    );
    const text = [...liveRows, ...rows.map((row) => row.content)].join("\n");
    expect(text).toContain(exportKey("MX"));
    for (const value of SENTINELS) expect(text, value).not.toContain(value);
  });
});
