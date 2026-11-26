// @vitest-environment node
// BUG-UG-CATALOG-VISITOR-TIMEZONE-BLANKED-BY-PUBLIC-TEXT-RULE-20261114 (#8742).
// A visitor with no account must read the same locale values a member reads:
// the visitor text rule (private.catalog_public_json) used to drop a timezone
// with an underscore or a second slash. Every row is fictional, and every
// write rolls back on the runner-owned database.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activateRelease, loadRelease, readRelease, verifyRelease } from "../scripts/load-union-catalog.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { exclusionList } from "./helpers/union-catalog-fixture.mjs";
import { writeBaseRelease } from "./helpers/union-catalog-research-fixture.mjs";
import { AMERICAS_COUNTRIES, addAmericasSnapshot, exportKey, exportLedgerId } from "./helpers/union-catalog-americas-fixture.mjs";

const ZONES = JSON.parse(readFileSync(new URL("../config/catalog-iana-zones.json", import.meta.url), "utf8")).zones;
const LOCALE_KEYS = ["country", "subdivision", "postalCode", "language", "timezone", "localeUnknowns"];
// Zones the fixture bodies carry, chosen to include an underscore and a second slash.
const BODY_ZONES = Object.freeze({ BR: "America/Sao_Paulo", MX: "America/Mexico_City", AR: "America/Argentina/Buenos_Aires",
  CA: "America/Toronto", CL: "America/Santiago", PE: "America/Lima", GL: "America/Nuuk", VE: "America/Caracas" });

function withZones(fixture) {
  addAmericasSnapshot(fixture);
  for (const [country, zone] of Object.entries(BODY_ZONES)) {
    const record = fixture.enriched[exportLedgerId(country)];
    record.timezone = zone;
    for (const office of record.offices) office.timezone = zone;
    // Sub-units state no locale of their own, so they inherit the body's.
    const doc = fixture.documents.find((entry) => entry.orgId === exportLedgerId(country));
    doc.timezone = zone;
  }
}

/** Every locale value of an answer, keyed by its JSON path. */
function localeValues(value, path = "$", out = {}) {
  if (Array.isArray(value)) value.forEach((item, i) => localeValues(item, `${path}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (LOCALE_KEYS.includes(key)) out[`${path}.${key}`] = item;
      else localeValues(item, `${path}.${key}`, out);
    }
  }
  return out;
}

const live = process.env.RUN_UNION_CATALOG_DB_TESTS === "1" ? describe : describe.skip;
live("catalog visitor locale values (#8742)", () => {
  let client, dir, release;
  const exclusions = exclusionList();
  async function as(role, query, values = []) {
    await client.query("savepoint visitor_locale");
    try {
      const claims = role === "anon" ? { role } : { role, sub: "87420000-0000-4000-8000-000000000001" };
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(claims)]);
      await client.query(`set local role ${role}`);
      return (await client.query(query, values)).rows[0]?.value;
    } finally {
      await client.query("rollback to savepoint visitor_locale");
      await client.query("release savepoint visitor_locale");
    }
  }
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    dir = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), "catalog-visitor-locale-db-"));
    release = readRelease(writeBaseRelease(dir, { label: "20261114-80", mutate: withZones }).dir);
    await loadRelease({ client, ...release, exclusions });
    expect((await verifyRelease({ client, ...release, exclusions })).problems).toEqual([]);
    await activateRelease({ client, label: release.manifest.label });
  });
  afterAll(async () => {
    if (client) {
      await client.query("rollback");
      await client.end();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Ledger 497: all 598 zones are validated at both depths. This takes about
  // 9 s on the Spark; use CI's written budget, without dropping any coverage.
  it("returns every IANA zone the catalog accepts, and every valid locale code, unchanged through the visitor rule", async () => {
    const { rows } = await client.query(
      `select z.zone, private.catalog_public_json(pg_catalog.jsonb_build_object('timezone', z.zone,
                'rows', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('timezone', z.zone))), '{}'::text[]) as value
         from pg_catalog.unnest($1::text[]) as z(zone)
        where exists (select 1 from pg_catalog.pg_timezone_names as tz where tz.name = z.zone)`,
      [ZONES],
    );
    expect(rows.length).toBeGreaterThan(400);
    const changed = rows.filter((row) => row.value.timezone !== row.zone || row.value.rows[0].timezone !== row.zone).map((row) => row.zone);
    expect(changed).toEqual([]);
    const codes = (await client.query(`select private.catalog_public_json(pg_catalog.jsonb_build_object(
        'country', 'BR', 'subdivision', 'BR-SP', 'postalCode', '01000-000', 'language', 'pt-BR', 'timezone', 'America/Sao_Paulo'), '{}'::text[]) as value`)).rows[0].value;
    expect(codes).toEqual({ country: "BR", subdivision: "BR-SP", postalCode: "01000-000", language: "pt-BR", timezone: "America/Sao_Paulo" });
  }, runnerTimeout(30_000));

  it("keeps the visitor rule on every other string, and on a locale key whose value is not a valid code", async () => {
    const answer = (await client.query(`select private.catalog_public_json(pg_catalog.jsonb_build_object(
        'name', 'see files.example/forms/secret.pdf', 'timezone', 'files.example/forms/secret.pdf',
        'language', 'files.example/forms/secret.pdf', 'country', 'https://files.example/forms/secret.pdf'), '{}'::text[]) as value`)).rows[0].value;
    for (const key of ["name", "timezone", "language", "country"]) expect(String(answer[key]), key).not.toContain("secret.pdf");
  });

  it("gives a visitor the same locale values as a member in search and profile, for every body", async () => {
    for (const country of AMERICAS_COUNTRIES) {
      const query = "select public.search_union_catalog_by_country(null,null,null,null,1,$1,null) as value";
      const visitor = (await as("anon", query, [country])).rows.find((row) => row.key === exportKey(country));
      const member = (await as("authenticated", query, [country])).rows.find((row) => row.key === exportKey(country));
      expect(localeValues(visitor), `search ${country}`).toEqual(localeValues(member));
      const profile = "select public.get_union_catalog_profile($1) as value";
      const visitorProfile = await as("anon", profile, [exportKey(country)]);
      const memberProfile = await as("authenticated", profile, [exportKey(country)]);
      expect(visitorProfile.found, country).toBe(true);
      expect(localeValues(visitorProfile), `profile ${country}`).toEqual(localeValues(memberProfile));
    }
    const br = await as("anon", "select public.get_union_catalog_profile_by_country($1,'BR','BR-SP') as value", [exportKey("BR")]);
    expect(br.organization.timezone).toBe("America/Sao_Paulo");
    expect(br.subunits[0].timezone).toBe("America/Sao_Paulo");
    expect(br.contacts.every((row) => row.timezone === "America/Sao_Paulo")).toBe(true);
    expect(br.documents[0].timezone).toBe("America/Sao_Paulo");
    expect(br.documents[0].url).toBeNull();
    const ar = await as("anon", "select public.search_union_catalog_by_country(null,null,null,null,1,'AR',null) as value");
    expect(ar.rows.find((row) => row.key === exportKey("AR")).timezone).toBe("America/Argentina/Buenos_Aires");
  });
});
