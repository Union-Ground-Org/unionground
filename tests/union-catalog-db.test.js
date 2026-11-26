// @vitest-environment node
//
// REQ-UG-UNION-CATALOG-REFERENCE-FOUNDATION-20260924 (spec
// docs/superpowers/specs/2026-09-24-union-catalog-prefilled-organizations-design.md
// §6.6): the private catalog tables are RPC-only, the three anonymous read
// RPCs are bounded and hide retired and duplicate rows everywhere, a load
// changes nothing for readers until activation, exactly one release is active
// and activation flips atomically, a superseded or unverified release cannot
// be activated, a retired release must pass verify again before a rollback
// re-applies its retained staging rows, staged rows changed after verify are
// refused, a staged value is never quoted in an activation error, planted
// contact patterns never surface, and neither a load nor an activation
// touches public.organizations.
//
// The live half runs in one transaction that is rolled back. Every fixture is
// fictional: "Example ..." bodies, .example domains, 555-01xx numbers, catalog
// file numbers 900000001 and up, public.union_orgs file numbers 990000601 and
// up. The one offline case below counts toward the floor.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  STAGING_DIGEST_SQL,
  activateRelease,
  formatVerify,
  loadRelease,
  readRelease,
  verifyRelease,
} from "../scripts/load-union-catalog.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { COLUMNS as REGISTRY_COLUMNS } from "../scripts/load-union-orgs.mjs";
import { exportRelease } from "../scripts/union-catalog/export-release.mjs";
import { DIRECTORY_BODIES_SCHEMA, directoryBodyKey } from "../scripts/union-catalog/privacy-filter.mjs";
import { LOCAL_ID, STATE_BODY_ID, TEST_SALT, baseFixture, emptyRecord, exclusionList } from "./helpers/union-catalog-fixture.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const TABLES = [
  "catalog_releases",
  "catalog_organizations",
  "catalog_edges",
  "catalog_subunits",
  "catalog_seat_outlines",
  "catalog_contacts",
  "catalog_documents",
  "catalog_document_subunits",
  "catalog_coverage",
  "catalog_staging",
];
const RPCS = [
  "public.get_union_catalog_status()",
  "public.search_union_catalog(text,text,text,text,integer)",
  "public.get_union_catalog_profile(text)",
];
const ROLES = ["anon", "authenticated", "service_role"];
const DIFF_KEYS = [
  "organizationsAdded", "organizationsChanged", "organizationsRetired", "subunitsAdded", "subunitsRetired",
  "tenantOrganizationsAfter", "tenantOrganizationsBefore",
];

const LABEL = "20260924-01";
const NEXT_LABEL = "20260925-01";
const THIRD_LABEL = "20260926-01";
const ADDED_LABEL = "20260927-01";
const LOCAL_KEY = "olms-990000601";
const NATIONAL_KEY = "olms-900000002";
const DUPLICATE_KEY = "olms-900000004";
const RETIRED_KEY = "olms-900000011";
const PLANTED_KEY = "olms-900000021";
const WITHDRAWN_KEY = "olms-990000603";
const REGISTRY_MATCH_ID = "fixture-registry-990000601";
const REGISTRY_ONLY_ID = "fixture-registry-990000602";
const REGISTRY_WITHDRAWN_ID = "fixture-registry-990000603";
const PLANTED_EMAIL = "planted.fixtureperson@freemail.example";
const PLANTED_PHONE = "802-555-0177";
const REGISTRY_PARENT_NAME = "EXAMPLE WORKERS INTERNATIONAL UNION";
const SCRUBBED_LABEL_KEY = "ug-scrubkid00";
const CAP_ROWS = 600;
const chainKey = (i) => `ug-chain${String(i).padStart(5, "0")}`;

describe("union catalog migration (offline)", () => {
  it("is one transaction that forces RLS on, and revokes all four roles from, every catalog table and grants exactly the RPC callers", () => {
    const code = stripComments(loadMigrationSql("union_catalog_reference_foundation")).trim();
    expect(code.startsWith("begin;")).toBe(true);
    expect(code.endsWith("commit;")).toBe(true);
    for (const table of TABLES) {
      expect(code).toContain(`alter table private.${table} force row level security;`);
      expect(code).toContain(`revoke all on table private.${table} from public, anon, authenticated, service_role;`);
    }
    for (const rpc of ["get_union_catalog_status()", "search_union_catalog(text, text, text, text, integer)", "get_union_catalog_profile(text)"]) {
      expect(code).toContain(`grant execute on function public.${rpc} to anon, authenticated, service_role;`);
    }
    // Activation is owner-only: no Data API role holds EXECUTE on it.
    expect(code).not.toMatch(/grant execute on function private\.catalog_activate_release/);
    expect(code.match(/grant /g)).toHaveLength(3);
  });
});

const live = process.env.RUN_UNION_CATALOG_DB_TESTS === "1" ? describe : describe.skip;

live("union catalog read boundary, loader and activation", () => {
  let client;
  const workdirs = [];
  let fixtureRelease;
  let nextRelease;
  let thirdRelease;
  let addedRelease;
  let organizationsBefore;
  let loadSummary;
  let verifyReport;
  const exclusions = exclusionList();

  // One statement as `role` (or as the owner when role is null), inside a
  // savepoint so an expected failure never aborts the outer transaction.
  // `claims` adds JWT claims, such as the `sub` of a signed-in account.
  async function callAs(role, text, params = [], claims = {}) {
    await client.query("savepoint union_catalog_probe");
    try {
      if (role) {
        await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ ...claims, role })]);
        await client.query(`set local role ${role}`);
      }
      const result = await client.query(text, params);
      await client.query("reset role");
      await client.query("release savepoint union_catalog_probe");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint union_catalog_probe");
      await client.query("release savepoint union_catalog_probe");
      await client.query("reset role");
      return { ok: false, code: error.code, message: error.message };
    }
  }

  async function value(role, text, params, claims) {
    const result = await callAs(role, text, params, claims);
    expect(result, result.message).toMatchObject({ ok: true });
    return result.rows[0].value;
  }

  const status = (role = "anon") => value(role, "select public.get_union_catalog_status() as value");
  const search = (args, role = "anon", claims) => value(role, "select public.search_union_catalog($1, $2, $3, $4, $5) as value", args, claims);
  const profile = (key, role = "anon", claims) => value(role, "select public.get_union_catalog_profile($1) as value", [key], claims);
  const releases = async () => (await client.query("select label, status from private.catalog_releases order by label")).rows;
  const stamp = async (label) => (await client.query(
    "select status, verified_at is not null as verified, verified_sha256 is not null as digest from private.catalog_releases where label = $1",
    [label],
  )).rows[0];
  const releaseId = async (label) => (await client.query("select id from private.catalog_releases where label = $1", [label])).rows[0].id;
  const activateAsOwner = (label) => callAs(null, "select private.catalog_activate_release($1)", [label]);
  const stagedCount = async (label) => (await client.query(
    "select count(*)::integer as n from private.catalog_staging s join private.catalog_releases r on r.id = s.release_id where r.label = $1",
    [label],
  )).rows[0].n;
  const bookkeeping = async (table, key) => (await client.query(
    `select r1.label as first_label, r2.label as last_label, r3.label as retired_label, t.content_sha256
       from private.catalog_${table} as t
       join private.catalog_releases as r1 on r1.id = t.first_release_id
       join private.catalog_releases as r2 on r2.id = t.last_release_id
       left join private.catalog_releases as r3 on r3.id = t.retired_release_id
      where t.${table === "subunits" ? "subunit_key" : "catalog_key"} = $1`,
    [key],
  )).rows[0];

  function buildFixtureRelease(label, mutate = () => {}) {
    // Shared workstations may have another session's .git marker in /tmp.
    // Keep the runner's TMPDIR while placing only these guarded fixtures in
    // an explicitly supplied directory outside every repository.
    const workdir = mkdtempSync(join(process.env.UNION_CATALOG_PROOF_TMP_ROOT || process.env.CI_DB_TEMP_ROOT || tmpdir(), "union-catalog-db-"));
    workdirs.push(workdir);
    const fixture = baseFixture();
    // The local's file number sits in the public.union_orgs fixture range so a
    // seeded registry row can match it (§2.1 soft link).
    fixture.ledger[LOCAL_ID].file = 990000601;
    mutate(fixture);
    const snapshot = join(workdir, "snapshot");
    mkdirSync(join(snapshot, "build"), { recursive: true });
    mkdirSync(join(snapshot, "documents"), { recursive: true });
    writeFileSync(join(snapshot, "build", "enriched.json"), JSON.stringify(fixture.enriched));
    writeFileSync(join(snapshot, "build", "source-data.json"), JSON.stringify({ "index-data.json": { records: fixture.ledger } }));
    writeFileSync(join(snapshot, "documents", "index.json"), JSON.stringify({ generated: null, documents: fixture.documents }));
    const exclusionsFile = join(workdir, "catalog-exclusions.json");
    writeFileSync(exclusionsFile, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: [] }));
    const out = join(workdir, "release");
    exportRelease({ sourceDir: snapshot, outDir: out, label, env: { CATALOG_EXCLUSIONS_FILE: exclusionsFile } });
    return readRelease(out);
  }

  // Shapes the fictional release does not carry, written as the owner after
  // the first activation: retired and withdrawn organizations, an 11-body
  // parent chain, a parent with 501 children, a small parent with hidden
  // children, a child whose only visible parent is a label, 600 more locals
  // in one state so a search runs past the 1,000 cap, and an organization
  // whose free text carries planted contact patterns that the exporter would
  // have refused.
  async function insertExtraShapes(releaseId) {
    const bookkeepingCols = "$1::uuid, $1::uuid";
    const hash = "repeat('0', 64)";
    await client.query(
      `insert into private.catalog_organizations
         (catalog_key, olms_file_number, name, tier, confidence, state, city, search_text, structure_note,
          first_release_id, last_release_id, retired_release_id, duplicate_of, content_sha256)
       values
         ('${RETIRED_KEY}', 900000011, 'Example Retired Workers Local 11', 'local', 'unreviewed', 'VT', 'Exampleville',
          'example retired workers local 11', null, ${bookkeepingCols}, $1::uuid, null, ${hash}),
         ('${WITHDRAWN_KEY}', 990000603, 'Example Withdrawn Workers Local 3', 'local', 'unreviewed', 'VT', 'Exampleville',
          'example withdrawn workers local 3', null, ${bookkeepingCols}, $1::uuid, null, ${hash}),
         ('${PLANTED_KEY}', 900000021, 'Example Planted Workers Local 21', 'local', 'unreviewed', 'VT', 'Exampleville',
          'example planted workers local 21', 'Office line ' || $2 || ' or write ' || $3, ${bookkeepingCols}, null, null, ${hash}),
         ('ug-kidsparent', null, 'Example Parent Council', 'regional', 'unreviewed', 'NH', null,
          'example parent council', null, ${bookkeepingCols}, null, null, ${hash}),
         ('ug-smallparen', null, 'Example Small Parent Council', 'regional', 'unreviewed', 'NH', null,
          'example small parent council', null, ${bookkeepingCols}, null, null, ${hash}),
         ('ug-dupkid0001', null, 'Example Aaa Retired Kid', 'local', 'unreviewed', 'NH', null,
          'example aaa retired kid', null, ${bookkeepingCols}, $1::uuid, null, ${hash}),
         ('ug-dupkid0002', null, 'Example Aab Duplicate Kid', 'local', 'unreviewed', 'NH', null,
          'example aab duplicate kid', null, ${bookkeepingCols}, null, '${LOCAL_KEY}', ${hash}),
         ('ug-dupkid0003', null, 'Example Aac Live Kid', 'local', 'unreviewed', 'NH', null,
          'example aac live kid', null, ${bookkeepingCols}, null, null, ${hash}),
         ('ug-hiddenkid0', null, 'Example Hidden Parents Local', 'local', 'unreviewed', 'VT', 'Exampleville',
          'example hidden parents local', null, ${bookkeepingCols}, null, null, ${hash}),
         ('${SCRUBBED_LABEL_KEY}', null, 'Example Scrubbed Label Local', 'local', 'unreviewed', 'VT', null,
          'example scrubbed label local', null, ${bookkeepingCols}, null, null, ${hash})`,
      [releaseId, PLANTED_PHONE, PLANTED_EMAIL],
    );
    await client.query(
      `insert into private.catalog_organizations
         (catalog_key, name, tier, confidence, state, search_text, first_release_id, last_release_id, content_sha256)
       select 'ug-chain' || lpad(i::text, 5, '0'), 'Example Chain Body ' || i, 'regional', 'unreviewed', 'NH',
              'example chain body ' || i, $1::uuid, $1::uuid, ${hash}
         from generate_series(0, 10) as i
       union all
       select 'ug-kid' || lpad(i::text, 7, '0'), 'Example Child Local ' || i, 'local', 'unreviewed', 'NH',
              'example child local ' || i, $1::uuid, $1::uuid, ${hash}
         from generate_series(1, 501) as i
       union all
       select 'ug-cap' || lpad(i::text, 7, '0'), 'Example Cap Filler ' || i, 'local', 'unreviewed', 'NH',
              'example cap filler ' || i, $1::uuid, $1::uuid, ${hash}
         from generate_series(1, ${CAP_ROWS}) as i`,
      [releaseId],
    );
    await client.query(
      `insert into private.catalog_edges
         (edge_key, child_key, parent_key, parent_label, edge_kind, certainty, first_release_id, last_release_id, retired_release_id, content_sha256)
       select 'fixture-chain-' || i, 'ug-chain' || lpad(i::text, 5, '0'), 'ug-chain' || lpad((i + 1)::text, 5, '0'), null,
              'parent_body', 'inferred', $1::uuid, $1::uuid, null::uuid, ${hash}
         from generate_series(0, 9) as i
       union all
       select 'fixture-kid-' || i, 'ug-kid' || lpad(i::text, 7, '0'), 'ug-kidsparent', null,
              'olms_parent', 'filed', $1::uuid, $1::uuid, null::uuid, ${hash}
         from generate_series(1, 501) as i
       union all
       select 'fixture-dupkid-' || i, 'ug-dupkid' || lpad(i::text, 4, '0'), 'ug-smallparen', null,
              'olms_parent', 'filed', $1::uuid, $1::uuid, null::uuid, ${hash}
         from generate_series(1, 3) as i
       union all
       select 'fixture-planted-edge', '${PLANTED_KEY}', null, 'Council, write ' || $2, 'parent_body', 'inferred',
              $1::uuid, $1::uuid, null::uuid, ${hash}
       union all
       select 'fixture-hidden-duplicate', 'ug-hiddenkid0', '${DUPLICATE_KEY}', null, 'olms_parent', 'filed',
              $1::uuid, $1::uuid, null::uuid, ${hash}
       union all
       select 'fixture-hidden-retired', 'ug-hiddenkid0', '${RETIRED_KEY}', null, 'olms_parent', 'filed',
              $1::uuid, $1::uuid, null::uuid, ${hash}
       union all
       select 'fixture-hidden-retired-edge', 'ug-hiddenkid0', 'ug-kidsparent', null, 'parent_body', 'inferred',
              $1::uuid, $1::uuid, $1::uuid, ${hash}
       union all
       select 'fixture-hidden-label', 'ug-hiddenkid0', null, 'Example Label Council', 'parent_body', 'inferred',
              $1::uuid, $1::uuid, null::uuid, ${hash}
       union all
       select 'fixture-retired-up', '${RETIRED_KEY}', '${chainKey(0)}', null, 'parent_body', 'inferred',
              $1::uuid, $1::uuid, null::uuid, ${hash}
       union all
       select 'fixture-scrubbed-label', '${SCRUBBED_LABEL_KEY}', null, 'Council, write ' || $2, 'olms_parent', 'filed',
              $1::uuid, $1::uuid, null::uuid, ${hash}
       union all
       select 'fixture-scrubbed-parent', '${SCRUBBED_LABEL_KEY}', '${chainKey(10)}', null, 'parent_body', 'inferred',
              $1::uuid, $1::uuid, null::uuid, ${hash}`,
      [releaseId, PLANTED_EMAIL],
    );
    await client.query(
      `insert into private.catalog_subunits
         (subunit_key, catalog_key, kind, kind_label, name, location, confidence, source_url,
          first_release_id, last_release_id, content_sha256)
       values ('${PLANTED_KEY}~chapter-0123456789ab', '${PLANTED_KEY}', 'chapter', 'Chapter', 'Example Planted Chapter',
               'Call ' || $2, 'unreviewed', 'https://planted.example/chapters', ${bookkeepingCols}, ${hash})`,
      [releaseId, PLANTED_PHONE],
    );
    await client.query(
      `insert into private.catalog_seat_outlines
         (outline_key, catalog_key, seat_class, title, listed, source_url, first_release_id, last_release_id, content_sha256)
       values ('${PLANTED_KEY}~officer-0123456789ab', '${PLANTED_KEY}', 'officer', 'Officer at ' || $2, 1,
               'https://planted.example/officers', ${bookkeepingCols}, ${hash})`,
      [releaseId, PLANTED_PHONE],
    );
    await client.query(
      `insert into private.catalog_contacts
         (contact_key, catalog_key, contact_kind, value, label, basis, source_url, first_release_id, last_release_id, content_sha256)
       values ('${PLANTED_KEY}~website-0123456789ab', '${PLANTED_KEY}', 'website', 'https://planted.example/',
               'Write ' || $2, 'own_site', 'https://planted.example/', ${bookkeepingCols}, ${hash})`,
      [releaseId, PLANTED_EMAIL],
    );
    await client.query(
      `insert into private.catalog_documents
         (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
       values ('${PLANTED_KEY}~0123456789abcdef', '${PLANTED_KEY}', 'other', 'Minutes, call ' || $2,
               'https://planted.example/minutes.pdf', 'planted.example', ${bookkeepingCols}, ${hash})`,
      [releaseId, PLANTED_PHONE],
    );
  }

  beforeAll(async () => {
    fixtureRelease = buildFixtureRelease(LABEL);
    // The next release amends the local's structure note and drops its
    // second sub-unit: one changed organization, one retired sub-unit.
    nextRelease = buildFixtureRelease(NEXT_LABEL, (fixture) => {
      fixture.enriched[LOCAL_ID].structureNote += " Amended in the next release.";
      fixture.enriched[LOCAL_ID].subunits.pop();
    });
    thirdRelease = buildFixtureRelease(THIRD_LABEL);
    // A release that adds one organization and one sub-unit to the first.
    addedRelease = buildFixtureRelease(ADDED_LABEL, (fixture) => {
      fixture.enriched["9005"] = emptyRecord(9005, "Example Added Workers Local 5", "local");
      fixture.ledger["9005"] = { ...fixture.ledger[STATE_BODY_ID], id: 9005, file: 900000005 };
      const added = structuredClone(fixture.enriched[LOCAL_ID].subunits[1]);
      added.name = "Example Added Chapter";
      added.source = "https://exampleworkers1.example/added";
      fixture.enriched[LOCAL_ID].subunits.push(added);
    });
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "union-catalog-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    const { rows: [installed] } = await client.query(
      `select to_regprocedure('public.search_union_catalog(text,text,text,text,integer)') is not null
          and to_regprocedure('private.catalog_activate_release(text)') is not null
          and to_regclass('private.catalog_staging') is not null as ok`,
    );
    if (!installed.ok) throw new Error("the disposable stack must have 20260925950000_union_catalog_reference_foundation applied");
    const { rows: [loaded] } = await client.query("select count(*)::integer as releases from private.catalog_releases");
    if (loaded.releases !== 0) throw new Error("the union catalog proof needs a stack with no catalog release loaded");

    await client.query(
      `insert into public.union_orgs
         (id, olms_file_number, name, affiliation, designation, local_number, level, city, state, enrichment_status, atlas_manifest_sha, parent_name)
       values ($1, 990000601, 'EXAMPLE WORKERS LOCAL 1', 'TESTFAM', 'LU', '1', 'local', 'EXAMPLEVILLE', 'VT', 'no_web_presence', 'fixture', null),
              ($2, 990000602, 'EXAMPLE REGISTRY WORKERS', 'TESTFAM', 'LU', '7', 'local', 'EXAMPLEVILLE', 'VT', 'no_web_presence', 'fixture', $4),
              ($3, 990000603, 'EXAMPLE WITHDRAWN WORKERS LOCAL 3', 'TESTFAM', 'LU', '3', 'local', 'EXAMPLEVILLE', 'VT', 'no_web_presence', 'fixture', 'EXAMPLE COUNCIL, CALL ' || $5)`,
      [REGISTRY_MATCH_ID, REGISTRY_ONLY_ID, REGISTRY_WITHDRAWN_ID, REGISTRY_PARENT_NAME, PLANTED_PHONE],
    );
    organizationsBefore = (await client.query("select count(*)::integer as n from public.organizations")).rows[0].n;
    loadSummary = await loadRelease({ client, ...fixtureRelease, exclusions });
    verifyReport = await verifyRelease({ client, ...fixtureRelease, exclusions });
  }, 120000);

  // Keep successful release transitions for the next case, but recover the
  // outer transaction even when a statement or assertion fails in this case.
  beforeEach(async () => { await client.query("savepoint catalog_case"); });
  afterEach(async ({ task }) => {
    if (task.result?.state === "fail") await client.query("rollback to savepoint catalog_case");
    await client.query("release savepoint catalog_case");
  }, 30_000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
    for (const workdir of workdirs) rmSync(workdir, { recursive: true, force: true });
  });

  it("denies anon, authenticated and service_role every private.catalog_* table (42501), by table ACL and not only by schema", async () => {
    for (const table of TABLES) {
      for (const role of ROLES) {
        const denied = await callAs(role, `select 1 from private.${table} limit 1`);
        expect(denied, `${role} on ${table}`).toMatchObject({ ok: false, code: "42501" });
        // authenticated holds USAGE on schema private, so its refusal comes
        // from the table ACL itself.
        if (role === "authenticated") expect(denied.message).toMatch(/permission denied for table/);
      }
    }
    const { rows: privileges } = await client.query(
      `select t, r, has_table_privilege(r, 'private.' || t, 'select,insert,update,delete,truncate,references,trigger') as any_privilege
         from unnest($1::text[]) as t cross join unnest($2::text[]) as r`,
      [TABLES, ROLES],
    );
    expect(privileges).toHaveLength(TABLES.length * ROLES.length);
    for (const row of privileges) expect(row, `${row.r} ${row.t}`).toMatchObject({ any_privilege: false });
    const { rows: schema } = await client.query(
      "select r, has_schema_privilege(r, 'private', 'usage') as usage from unnest($1::text[]) as r order by r",
      [ROLES],
    );
    expect(schema).toEqual([{ r: "anon", usage: false }, { r: "authenticated", usage: true }, { r: "service_role", usage: false }]);
    const { rows } = await client.query(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*)::integer from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'private' and c.relname = any($1::text[])`,
      [TABLES],
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const row of rows) expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, policies: 0 });
  });

  it("shows anon nothing from a staged load; activation makes the release available with public counts only", async () => {
    expect(await status()).toEqual({ available: false, releaseLabel: null, releasedOn: null, dataAsOf: null, counts: null });
    expect(await profile(LOCAL_KEY)).toEqual({ found: false });
    // The staged rows are not live: search falls back to the registry alone.
    const staged = await search(["Exampleville", null, null, null, 1]);
    expect(staged.rows.map((row) => row.key)).not.toContain(LOCAL_KEY);
    expect(staged.rows.map((row) => row.key)).toContain(REGISTRY_MATCH_ID);
    expect(await stagedCount(LABEL)).toBe(Object.values(loadSummary.staged).reduce((a, b) => a + b, 0));
    const { rows: [empty] } = await client.query("select count(*)::integer as n from private.catalog_organizations");
    expect(empty.n).toBe(0);

    const diff = await activateRelease({ client, label: LABEL });
    expect(Object.keys(diff).sort()).toEqual(DIFF_KEYS);
    expect(diff).toMatchObject({
      organizationsAdded: fixtureRelease.release.organizations.length,
      organizationsRetired: 0,
      organizationsChanged: 0,
      tenantOrganizationsBefore: organizationsBefore,
      tenantOrganizationsAfter: organizationsBefore,
    });
    const after = await status();
    expect(after).toMatchObject({ available: true, releaseLabel: LABEL });
    expect(after.releasedOn).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    expect(after.dataAsOf).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    // The loader's bookkeeping stays in the database.
    expect(after.counts).toEqual(fixtureRelease.manifest.counts);
    for (const key of ["organizationsBefore", "organizationsAfter", "allowRetire"]) expect(after.counts).not.toHaveProperty(key);
    const { rows: [stored] } = await client.query(
      "select counts ? 'organizationsBefore' as before_kept, counts ? 'organizationsAfter' as after_kept, activation_diff from private.catalog_releases where label = $1",
      [LABEL],
    );
    expect(stored).toMatchObject({ before_kept: true, after_kept: true, activation_diff: diff });

    await insertExtraShapes(loadSummary.releaseId);
  });

  it("lets anon search: live catalog rows first with a parentName, then registry rows with no live catalog row flagged registryOnly", async () => {
    const result = await search(["Exampleville", null, null, null, 1]);
    expect(result).toMatchObject({ page: 1, pageSize: 25, totalCapped: false, hasNext: false });
    const keys = result.rows.map((row) => row.key);
    expect(keys).toContain(LOCAL_KEY);
    expect(keys).toContain(REGISTRY_ONLY_ID);
    expect(keys).not.toContain(REGISTRY_MATCH_ID);
    const national = fixtureRelease.release.organizations.find((o) => o.catalog_key === NATIONAL_KEY);
    const local = result.rows.find((row) => row.key === LOCAL_KEY);
    expect(local).toMatchObject({
      registryOnly: false, localNumber: "1", tier: "local", level: "local", registryId: REGISTRY_MATCH_ID, parentName: national.name,
    });
    // A registry row carries the registry's own parent name, scrubbed.
    expect(result.rows.find((row) => row.key === REGISTRY_ONLY_ID)).toMatchObject({ registryOnly: true, localNumber: "7", family: "TESTFAM", parentName: REGISTRY_PARENT_NAME });
    for (const row of result.rows) expect(row, row.key).toHaveProperty("parentName");
    const lastCatalog = result.rows.map((row) => row.registryOnly).lastIndexOf(false);
    const firstRegistry = result.rows.map((row) => row.registryOnly).indexOf(true);
    expect(lastCatalog).toBeLessThan(firstRegistry);
    expect(result.total).toBe(result.rows.length);

    const byNumber = await search(["Local 7", "VT", "TESTFAM", "local", 1]);
    expect(byNumber.rows.map((row) => row.key)).toEqual([REGISTRY_ONLY_ID]);
    const byCatalogNumber = await search(["lu 1", null, null, null, 1]);
    expect(byCatalogNumber.rows.map((row) => row.key)).toContain(LOCAL_KEY);
    const stateOnly = await search([null, "NH", null, "regional", 1]);
    expect(stateOnly.total).toBe(13);
    expect(stateOnly.rows).toHaveLength(13);
    // A child's parentName is its primary parent; the label-only child falls
    // back to the scrubbed label because its keyed parents are hidden.
    expect((await search(["Child Local 1", "NH", null, "local", 1])).rows.find((row) => row.key === "ug-kid0000001")).toMatchObject({ parentName: "Example Parent Council" });
    expect((await search(["Hidden Parents", null, null, null, 1])).rows.find((row) => row.key === "ug-hiddenkid0")).toMatchObject({ parentName: "Example Label Council" });
    expect((await search(["Chain Body 10", null, null, null, 1])).rows.find((row) => row.key === chainKey(10))).toMatchObject({ parentName: null });
    // The primary (olms_parent) edge is label-only and its label is
    // scrubbed, so the lower-ranked parent_body edge's visible parent wins.
    expect((await search(["Scrubbed Label", null, null, null, 1])).rows.find((row) => row.key === SCRUBBED_LABEL_KEY)).toMatchObject({ parentName: "Example Chain Body 10" });

    // Paging flags and the 1,000 cap (spec §6.2): 501 children plus 600 cap
    // fillers are NH locals, so the state search runs past the cap.
    const capped = await search([null, "NH", null, "local", 1]);
    expect(capped).toMatchObject({ total: 1000, totalCapped: true, hasNext: true });
    expect(capped.rows).toHaveLength(25);
    const lastPage = await search([null, "NH", null, "local", 40]);
    expect(lastPage).toMatchObject({ page: 40, hasNext: false });
    expect(lastPage.rows).toHaveLength(25);
    const kids = await search(["Child Local", "NH", null, "local", 1]);
    expect(kids).toMatchObject({ total: 501, totalCapped: false, hasNext: true });
    expect(kids.rows).toHaveLength(25);
    const kidsTail = await search(["Child Local", "NH", null, "local", 21]);
    expect(kidsTail).toMatchObject({ total: 501, hasNext: false });
    expect(kidsTail.rows).toHaveLength(1);
  });

  it("grants EXECUTE on the three read RPCs to anon, authenticated and service_role, and never to PUBLIC", async () => {
    const { rows } = await client.query(
      `select r.rpc, g.role, has_function_privilege(g.role, r.rpc::regprocedure, 'execute') as allowed,
              exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                       where p.oid = r.rpc::regprocedure and a.grantee = 0) as public_execute
         from unnest($1::text[]) as r(rpc) cross join unnest($2::text[]) as g(role)`,
      [RPCS, ROLES],
    );
    expect(rows).toHaveLength(RPCS.length * ROLES.length);
    for (const row of rows) expect(row, `${row.role} ${row.rpc}`).toMatchObject({ allowed: true, public_execute: false });
    for (const role of ["authenticated", "service_role"]) {
      expect((await status(role)).available).toBe(true);
      expect((await search(["Exampleville", null, null, null, 1], role)).rows.length).toBeGreaterThan(0);
      expect((await profile(LOCAL_KEY, role)).found).toBe(true);
    }
  });

  // REQ-UG-CATALOG-DOCUMENTS-MEMBERS-ONLY-20261110: document links
  // are for members. A caller with no account (anon, or any role without a
  // `sub`) sees each document's kind, title and date but no link anywhere in
  // the answer; a signed-in account sees every link exactly as stored.
  it("gives document links only to a signed-in account and reduces document citations to their site for everyone else", async () => {
    const PAGE_DOCUMENT = "https://exampleworkers1.example/contract-page";
    const BYLAWS = "https://exampleworkers1.example/files/bylaws.pdf";
    const SITE = "https://exampleworkers1.example/";
    const sources = [
      "https://exampleworkers1.example/about",
      "https://exampleworkers1.example/files/agreement.pdf",
      PAGE_DOCUMENT,
      "https://drive.google.com/file/d/fixture/view",
      "https://web.archive.org/web/20240101000000/https://exampleworkers1.example/files/old.PDF",
      SITE,
    ];
    await client.query("savepoint members_only_links");
    try {
      // Plant one citation of each document-link kind beside the fixture's
      // own documents; a document whose link is an ordinary page is withheld
      // too, and so is any citation of it.
      await client.query("update private.catalog_organizations set bylaws_url = $2, source_urls = $3 where catalog_key = $1", [LOCAL_KEY, BYLAWS, sources]);
      await client.query(
        `update private.catalog_documents set url = $2
          where document_key = (select min(document_key) from private.catalog_documents where catalog_key = $1 and retired_release_id is null)`,
        [LOCAL_KEY, PAGE_DOCUMENT],
      );
      await client.query("update private.catalog_subunits set source_url = 'https://exampleworkers1.example/files/roster.pdf' where catalog_key = $1", [LOCAL_KEY]);
      await client.query("update private.catalog_seat_outlines set source_url = 'https://exampleworkers1.example/download_file/7' where catalog_key = $1", [LOCAL_KEY]);
      await client.query("update private.catalog_contacts set source_url = 'https://city.example/DocumentCenter/View/7' where catalog_key = $1", [LOCAL_KEY]);
      await client.query("update private.catalog_edges set source_url = 'https://drive.google.com/file/d/edge/view' where child_key = $1", [LOCAL_KEY]);
      const stored = (await client.query(
        "select document_key, url, url_host from private.catalog_documents where catalog_key = $1 and retired_release_id is null order by doc_kind, document_key",
        [LOCAL_KEY],
      )).rows;
      expect(stored.length).toBeGreaterThan(0);

      const member = await profile(LOCAL_KEY, "authenticated", { sub: "99999999-9999-4999-8999-999999999993" });
      expect(member.documentLinks).toBe("included");
      expect(member.organization.bylawsUrl).toBe(BYLAWS);
      expect(member.organization.sourceUrls).toEqual(sources);
      expect(member.documents.map(({ key, url, urlHost }) => ({ key, url, urlHost }))).toEqual(
        stored.map((row) => ({ key: row.document_key, url: row.url, urlHost: row.url_host })),
      );
      expect(member.subunits.length).toBeGreaterThan(0);
      for (const subunit of member.subunits) expect(subunit.sourceUrl).toBe("https://exampleworkers1.example/files/roster.pdf");
      expect(member.parents.filter((edge) => edge.childKey === LOCAL_KEY).map((edge) => edge.sourceUrl))
        .toEqual(expect.arrayContaining(["https://drive.google.com/file/d/edge/view"]));

      for (const [role, claims] of [["anon", undefined], ["authenticated", undefined], ["service_role", undefined]]) {
        const visitor = await profile(LOCAL_KEY, role, claims);
        expect(visitor.documentLinks, role).toBe("members");
        expect(visitor.organization.bylawsUrl, role).toBeNull();
        expect(visitor.organization.sourceUrls, role).toEqual([sources[0], SITE, "https://drive.google.com/"]);
        // Each document still says what it is.
        expect(visitor.documents.map(({ key, kind, title, asOf }) => ({ key, kind, title, asOf })), role)
          .toEqual(member.documents.map(({ key, kind, title, asOf }) => ({ key, kind, title, asOf })));
        for (const document of visitor.documents) expect(document, role).toMatchObject({ url: null, urlHost: null });
        for (const subunit of visitor.subunits) expect(subunit.sourceUrl, role).toBe(SITE);
        for (const seat of visitor.seatOutlines) expect(seat.sourceUrl, role).toBe(SITE);
        for (const contact of visitor.contacts) expect(contact.sourceUrl, role).toBe("https://city.example/");
        for (const edge of visitor.parents.filter((item) => item.childKey === LOCAL_KEY)) expect(edge.sourceUrl, role).toBe("https://drive.google.com/");
        // No link to any document survives anywhere in the answer.
        const text = JSON.stringify(visitor);
        for (const link of [...stored.map((row) => row.url), BYLAWS, PAGE_DOCUMENT]) expect(text, `${role} ${link}`).not.toContain(link);
        expect(text, role).not.toMatch(/\.pdf|drive\.google\.com\/file|DocumentCenter|download_file/i);
        // Nothing but the links differs from what a member sees.
        const strip = (answer) => JSON.parse(JSON.stringify(answer, (key, item) => (
          ["documentLinks", "url", "urlHost", "bylawsUrl", "sourceUrl", "sourceUrls"].includes(key) ? undefined : item
        )));
        expect(strip(visitor), role).toEqual(strip(member));
      }
    } finally {
      await client.query("rollback to savepoint members_only_links");
      await client.query("release savepoint members_only_links");
    }
  });

  // The directory's final rule: more
  // document shapes, title words in the path, a map short link kept, a
  // withheld address matched under any spelling, a listed website exempt only
  // while it reads as a home page, and every link field (websites, contact
  // values) judged.
  it("withholds viewer, download, title-word and respelled document links from a caller with no account, keeps a listed home page and a map link, and judges websites and contact values", async () => {
    const AGREEMENT = "https://exampleworkers1.example/contract/master-agreement";
    const CHAPTER_SITE = "https://exampleworkers1.example/chapter-7";
    const FORM_SITE = "https://www.jotform.com/form/123";
    const MAP = "https://maps.app.goo.gl/4eD9u2T77M7V1DtS7";
    const sources = [
      "https://nysut.docsend.com/view/gj4e3vtq5f3z92dj",
      "https://www.mass.gov/doc/frazer-v-bay-state-gas/download",
      "https://www.csueu.org/bylaws",
      "http://www.exampleworkers1.example/contract/master-agreement/?utm_source=directory",
      "https://www.exampleworkers1.example/chapter-7?utm_source=x",
      "https://exampleworkers1.example/contract/Master-Agreement",
      "https://exampleworkers1.example/news/bylaw-vote",
      MAP,
      // Encoded forms of a SharePoint sharing path and a download flag.
      "https://tenant.sharepoint.com/%3Ab%3A/r/sites/union/opaque",
      "https://exampleworkers1.example/resource?%64ownload=1",
      // A final DNS dot names the same host, by shape and as a destination.
      "https://docs.google.com./document/d/x/edit",
      "https://exampleworkers1.example./contract/master-agreement?utm_source=x",
    ];
    const contacts = [
      ["website", `${AGREEMENT}#article-2`, "https://exampleworkers1.example/"],
      ["social", "https://bit.ly/3abcDEF", "https://bit.ly/"],
      ["website", "exampleworkers1.example/files/cba.pdf", "https://exampleworkers1.example/"],
      ["website", CHAPTER_SITE, CHAPTER_SITE],
      ["email", "info@exampleworkers1.example", "info@exampleworkers1.example"],
      ["office_address", "12 Main Street, Example City", "12 Main Street, Example City"],
      // A host written the way a browser still resolves it is judged as that
      // host, with or without a scheme, by shape and as a destination.
      ["social", "https://www.%73cribd.com/doc/49926829/x", "https://www.scribd.com/"],
      ["social", "www.%73cribd.com/doc/x", "https://www.scribd.com/"],
      ["website", "docs.google.com./document/d/x/edit", "https://docs.google.com/"],
      ["website", "https://exampleworkers1.%65xample/contract/master-agreement", "https://exampleworkers1.example/"],
      ["website", "%65xampleworkers1.example/contract/master-agreement", "https://exampleworkers1.example/"],
      // A host that is not a plain hostname once decoded is never returned.
      ["website", "https://ex%C3%A4mple.example/page", null],
      ["website", "https://bad%40host.example/page", null],
      // A backslash in the authority is a slash to a browser; an escaped dot
      // is a dot; with no scheme the value is read decoded.
      ["social", "https://www.scribd.com\\@directory.example/../doc/49926829/x", "https://www.scribd.com/"],
      ["social", "https://www.scribd.com%2e/doc/49926829/x", "https://www.scribd.com/"],
      ["social", "https://%77%77%77%2escribd%2ecom/doc/49926829/x", "https://www.scribd.com/"],
      ["social", "www%2escribd%2ecom/doc/49926829/x", "https://www.scribd.com/"],
      // With no scheme: an encoded space in the path, and backslashes for slashes.
      ["website", "exampleworkers1.example/files/Master%20Agreement.pdf", "https://exampleworkers1.example/"],
      ["website", "docs.google.com\\document\\d\\x", "https://docs.google.com/"],
      // Dot segments, written or escaped, name the destination they resolve to.
      ["website", "https://exampleworkers1.example/contract/../contract/master-agreement", "https://exampleworkers1.example/"],
      ["website", "https://exampleworkers1.example/contract/%2e%2e/contract/./master-agreement", "https://exampleworkers1.example/"],
      // A scheme-free host of four dotted numbers is a link.
      ["website", "10.0.0.12/files/contract.pdf", "https://10.0.0.12/"],
      // Values with no slash form stay as they are.
      ["email", "info@example.org", "info@example.org"],
      ["email", "mailto:info@example.org", "mailto:info@example.org"],
      ["phone", "tel:+16173760220", "tel:+16173760220"],
      ["phone", "617.376.0220", "617.376.0220"],
      ["office_address", "10.11.2026", "10.11.2026"],
      // A word with a slash that is neither plainly harmless nor a link is
      // dropped for a visitor (the prose rule; the member keeps it).
      ["office_address", "10.11.2026/contract", ""],
      ["office_address", "10.11.2026/newsletter", ""],
      ["email", "support.123/newsletter@example.org", ""],
    ];
    await client.query("savepoint members_only_rule");
    try {
      await client.query("update private.catalog_organizations set website = $2, bylaws_url = null, source_urls = $3 where catalog_key = $1", [LOCAL_KEY, FORM_SITE, sources]);
      // A contract published as an ordinary page, and a newsletter entry that
      // points at a chapter's home page.
      await client.query(
        `update private.catalog_documents set url = $2
          where document_key = (select min(document_key) from private.catalog_documents where catalog_key = $1 and retired_release_id is null)`,
        [LOCAL_KEY, AGREEMENT],
      );
      await client.query(
        `insert into private.catalog_documents
           (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
         select $1 || '~00000000000000a1', $1, 'newsletter', 'Chapter 7 newsletter', $2, 'exampleworkers1.example',
                o.first_release_id, o.last_release_id, pg_catalog.repeat('a', 64)
           from private.catalog_organizations as o where o.catalog_key = $1`,
        [LOCAL_KEY, CHAPTER_SITE],
      );
      // One sub-unit's website is the chapter's home page; another's is the
      // contract page, which is not a home page and stays a destination.
      await client.query(
        `update private.catalog_subunits set website = $2
          where subunit_key = (select subunit_key from private.catalog_subunits where catalog_key = $1 and retired_release_id is null
                                order by kind, name, subunit_key limit 1)`,
        [LOCAL_KEY, CHAPTER_SITE],
      );
      await client.query(
        `insert into private.catalog_subunits
           (subunit_key, catalog_key, kind, kind_label, name, confidence, website, source_url, first_release_id, last_release_id, content_sha256)
         select $1 || '~chapter-0000000000b1', $1, 'chapter', 'Chapter', 'Probe bargaining unit', 'unreviewed', $2,
                'https://exampleworkers1.example/units', o.first_release_id, o.last_release_id, pg_catalog.repeat('c', 64)
           from private.catalog_organizations as o where o.catalog_key = $1`,
        [LOCAL_KEY, AGREEMENT],
      );
      await client.query("update private.catalog_contacts set retired_release_id = last_release_id where catalog_key = $1", [LOCAL_KEY]);
      for (const [index, [kind, stored]] of contacts.entries()) {
        await client.query(
          `insert into private.catalog_contacts
             (contact_key, catalog_key, contact_kind, value, label, basis, source_url, first_release_id, last_release_id, content_sha256)
           select $1 || '~' || $2 || '-00000000000' || $3, $1, $2, $4, 'Probe ' || $3, 'own_site', 'https://exampleworkers1.example/contact',
                  o.first_release_id, o.last_release_id, pg_catalog.repeat('b', 64)
             from private.catalog_organizations as o where o.catalog_key = $1`,
          [LOCAL_KEY, kind, String(index), stored],
        );
      }
      const valueOf = (answer) => Object.fromEntries(answer.contacts.map((contact) => [contact.label, contact.value]));
      const websiteOf = (answer, name) => answer.subunits.find((subunit) => subunit.name === name)?.website;

      const member = await profile(LOCAL_KEY, "authenticated", { sub: "99999999-9999-4999-8999-999999999993" });
      expect(member.organization.website).toBe(FORM_SITE);
      expect(member.organization.sourceUrls).toEqual(sources);
      expect(member.subunits.map((subunit) => subunit.website)).toContain(CHAPTER_SITE);
      expect(websiteOf(member, "Probe bargaining unit")).toBe(AGREEMENT);
      expect(valueOf(member)).toEqual(Object.fromEntries(contacts.map(([, stored], index) => [`Probe ${index}`, stored])));
      expect(member.documents.map((document) => document.url)).toEqual(expect.arrayContaining([AGREEMENT, CHAPTER_SITE]));

      for (const role of ["anon", "authenticated"]) {
        const visitor = await profile(LOCAL_KEY, role);
        expect(visitor.documentLinks, role).toBe("members");
        // A form is a document by shape, even as the organization's website.
        expect(visitor.organization.website, role).toBe("https://www.jotform.com/");
        expect(visitor.organization.sourceUrls, role).toEqual([
          "https://nysut.docsend.com/",
          "https://www.mass.gov/",
          // A page named as the bylaws is that document, whether or not an entry names it.
          "https://www.csueu.org/",
          "http://www.exampleworkers1.example/",
          // The chapter's home page is a listed website, so a document entry
          // that names it does not withhold it; another path case is another
          // page; "bylaw" alone is not a title word; a map link is a place.
          "https://www.exampleworkers1.example/chapter-7?utm_source=x",
          "https://exampleworkers1.example/contract/Master-Agreement",
          "https://exampleworkers1.example/news/bylaw-vote",
          MAP,
          "https://tenant.sharepoint.com/",
          "https://exampleworkers1.example/",
          "https://docs.google.com/",
          // The dotted destination reduces to the site already listed above
          // (sourceUrls are de-duplicated); its path is checked below.
        ]);
        expect(visitor.subunits.map((subunit) => subunit.website), role).toContain(CHAPTER_SITE);
        // A contract page listed as a website is not a home page.
        expect(websiteOf(visitor, "Probe bargaining unit"), role).toBe("https://exampleworkers1.example/");
        expect(valueOf(visitor), role).toEqual(Object.fromEntries(contacts.map(([, , shown], index) => [`Probe ${index}`, shown])));
        for (const document of visitor.documents) expect(document, role).toMatchObject({ url: null, urlHost: null });
        const text = JSON.stringify(visitor);
        for (const link of ["docsend.com/view", "/download", "csueu.org/bylaws", "contract/master-agreement", "jotform.com/form", "bit.ly/3", "cba.pdf", "%3Ab%3A", "%64ownload", "%73cribd", "%C3%A4", "%40host", "%2escribd", "directory.example", "Master%20Agreement"]) {
          expect(text, `${role} ${link}`).not.toContain(link);
        }
      }

      // Search answers with the same website rule: a form is reduced by
      // shape, and a website that is one of the organization's document
      // destinations (not a home page) is reduced too; a member's row is as stored.
      const searchArgs = [member.organization.name, member.organization.state, null, null, 1];
      const searchedWebsite = async (role, claims) => (await search(searchArgs, role, claims)).rows.find((row) => row.key === LOCAL_KEY)?.website;
      expect(await searchedWebsite("authenticated", { sub: "99999999-9999-4999-8999-999999999993" })).toBe(FORM_SITE);
      for (const role of ["anon", "authenticated"]) expect(await searchedWebsite(role), role).toBe("https://www.jotform.com/");
      await client.query("update private.catalog_organizations set website = $2 where catalog_key = $1", [LOCAL_KEY, AGREEMENT]);
      expect(await searchedWebsite("authenticated", { sub: "99999999-9999-4999-8999-999999999993" })).toBe(AGREEMENT);
      for (const role of ["anon", "authenticated"]) expect(await searchedWebsite(role), role).toBe("https://exampleworkers1.example/");
    } finally {
      await client.query("rollback to savepoint members_only_rule");
      await client.query("release savepoint members_only_rule");
    }
  });

  // The federal filer registry (public.union_orgs) is readable by anon over
  // REST, so its links are made safe at rest: the stored website goes through
  // the shape rule on every insert and update, and anon may not read sources.
  // The select strings shipped clients send keep working.
  it("stores a registry website through the rule on the loader's upsert, refuses sources to anon, and keeps every shipped select string working", async () => {
    const shipped = (path, name) => {
      const text = readFileSync(path, "utf8");
      const start = text.indexOf(`const ${name} =`);
      const body = text.slice(start, text.indexOf(";", start));
      return [...body.matchAll(/"([^"]*)"/g)].map((match) => match[1]).join("");
    };
    const selects = [
      shipped("src/features/unionCatalog/registryQuery.js", "REGISTRY_SELECT"),
      // The structure and network pages that read the national and filed
      // selects are not part of this edition (no public union catalog pages).
      // The registry picker and the embeds shipped web and native builds use.
      "id,name,city,state,affiliation",
      "name",
    ];
    for (const select of selects) expect(select, select).toMatch(/^[a-z_]+(,[a-z_]+)*$/);
    const ID = "olms-990000777";
    const PDF = "https://registry.example/files/agreement.pdf";
    const sources = [
      { retrievedAt: "2026-07-01T00:00:00Z", url: "https://registry.example/contracts/cba.pdf" },
      { retrievedAt: "2026-07-01T00:00:00Z", url: "https://registry.example/about" },
    ];
    // The loader's own statement shape (scripts/load-union-orgs.mjs upsertSql).
    const row = (website) => ({
      id: ID, olms_file_number: 990000777, name: "EXAMPLE REGISTRY COUNCIL", affiliation: "TESTFAM", designation: "DC",
      local_number: null, level: "intermediate", parent_olms_file_number: null, parent_affiliation: null, parent_name: null,
      sector_public_private: null, sector_tags: [], city: "EXAMPLEVILLE", state: "VT", zip: null, latitude: null, longitude: null,
      geocode_precision: null, geocode_match_type: null, website, members_latest: null, members_latest_year: null,
      membership_history: [], finances: null, public_record_coverage: null, sources, enrichment_status: "enriched",
      source_updated_at: null, atlas_manifest_sha: "fixture",
    });
    const upsert = async (website) => {
      const values = REGISTRY_COLUMNS.map((column) => {
        const value = row(website)[column];
        return ["membership_history", "finances", "public_record_coverage", "sources"].includes(column) && value != null ? JSON.stringify(value) : value;
      });
      await client.query(
        `insert into public.union_orgs (${REGISTRY_COLUMNS.join(", ")}) values (${REGISTRY_COLUMNS.map((_, index) => `$${index + 1}`).join(", ")})
         on conflict (id) do update set ${REGISTRY_COLUMNS.filter((column) => column !== "id").map((column) => `${column} = excluded.${column}`).join(", ")}`,
        values,
      );
    };
    const stored = async () => (await client.query("select website, sources from public.union_orgs where id = $1", [ID])).rows[0];
    await client.query("savepoint registry_links");
    try {
      await upsert(PDF);
      expect((await stored()).website).toBe("https://registry.example/");
      // The citations are kept as loaded: members and the loader's verify count them.
      expect((await stored()).sources).toEqual(sources);
      await upsert("https://forms.gle/abc");
      expect((await stored()).website).toBe("https://forms.gle/");
      await upsert("https://registry.example/council");
      expect((await stored()).website).toBe("https://registry.example/council");
      // Escaped and dotted hosts, with and without a scheme, and a host that is not a plain hostname.
      await upsert("https://www.%73cribd.com/doc/49926829/x");
      expect((await stored()).website).toBe("https://www.scribd.com/");
      await upsert("docs.google.com./document/d/x/edit");
      expect((await stored()).website).toBe("https://docs.google.com/");
      await upsert("https://ex%C3%A4mple.example/page");
      expect((await stored()).website).toBeNull();
      await upsert("https://www.scribd.com\\@directory.example/../doc/1");
      expect((await stored()).website).toBe("https://www.scribd.com/");
      await client.query("update public.union_orgs set website = $2 where id = $1", [ID, PDF]);
      expect((await stored()).website).toBe("https://registry.example/");
      // No stored registry website differs from the rule's output.
      expect((await client.query(
        "select count(*)::int as n from public.union_orgs where website is distinct from private.catalog_public_citation(website, '{}'::text[])",
      )).rows[0].n).toBe(0);

      for (const role of ["anon", "authenticated"]) {
        for (const select of selects) {
          const result = await callAs(role, `select ${select} from public.union_orgs where id = $1`, [ID]);
          expect(result, `${role} ${select}: ${result.message}`).toMatchObject({ ok: true });
          if (select.includes("website") && role === "anon") expect(result.rows[0]?.website, select).toBe("https://registry.example/");
        }
      }
      // The registry search a level filter sends, as a visitor.
      const levelSearch = await callAs("anon", `select ${selects[0]} from public.union_orgs where level = 'intermediate' and state = 'VT' order by name`);
      expect(levelSearch).toMatchObject({ ok: true });
      for (const found of levelSearch.rows) expect(found.website ?? "", found.id).not.toMatch(/\.pdf|forms\.gle\/./i);
      // anon may not read the citations, by name or through *.
      for (const text of ["select sources from public.union_orgs limit 1", "select * from public.union_orgs limit 1"]) {
        const refused = await callAs("anon", text);
        expect(refused, text).toMatchObject({ ok: false, code: "42501" });
      }
      const member = await callAs("authenticated", "select sources from public.union_orgs where id = $1", [ID], { sub: "99999999-9999-4999-8999-999999999993" });
      expect(member, member.message).toMatchObject({ ok: true });
    } finally {
      await client.query("rollback to savepoint registry_links");
      await client.query("release savepoint registry_links");
    }
  });

  // Every string the two functions return to a caller with no account passes
  // the rule: a document address planted in every text column they read (or
  // inside prose in it) never comes back to a visitor, while a member still
  // gets it wherever the function returns that column.
  it("returns no planted document address to a caller with no account from any text column the profile and the search read", async () => {
    const PLANTED = "planted-docs.example/files/contract-2024.pdf";
    const prose = `Read https://${PLANTED} first, or ${PLANTED} if no scheme.`;
    // Identity and link columns stay as they are, so the rows stay visible and joined.
    const KEEP = /(^|_)(key|id)$|^(duplicate_of|state|zip5|content_sha256|search_text)$|_release_id$/;
    const targets = [
      ["private.catalog_organizations", "catalog_key = $1", LOCAL_KEY],
      ["private.catalog_edges", "child_key = $1", LOCAL_KEY],
      ["private.catalog_subunits", "catalog_key = $1", LOCAL_KEY],
      ["private.catalog_seat_outlines", "catalog_key = $1", LOCAL_KEY],
      ["private.catalog_contacts", "catalog_key = $1", LOCAL_KEY],
      ["private.catalog_documents", "catalog_key = $1", LOCAL_KEY],
      ["public.union_orgs", "id = $1", REGISTRY_ONLY_ID],
    ];
    const planted = [];
    const refused = [];
    await client.query("savepoint plant_every_column");
    try {
      for (const [table, where, key] of targets) {
        const [schema, name] = table.split(".");
        const { rows: columns } = await client.query(
          `select column_name, data_type, udt_name from information_schema.columns
            where table_schema = $1 and table_name = $2 and (data_type in ('text', 'character varying') or udt_name = '_text')
            order by ordinal_position`, [schema, name]);
        for (const { column_name: column, udt_name: type } of columns) {
          if (KEEP.test(column)) continue;
          await client.query("savepoint plant_one");
          try {
            const value = type === "_text" ? [prose] : prose;
            await client.query(`update ${table} set ${column} = $2 where ${where}`, [key, value]);
            await client.query("release savepoint plant_one");
            planted.push(`${table}.${column}`);
          } catch (error) {
            await client.query("rollback to savepoint plant_one");
            await client.query("release savepoint plant_one");
            refused.push(`${table}.${column} (${error.code})`);
          }
        }
      }
      // The profile and the search read these columns; the plant must reach a member somewhere, or the test proves nothing.
      expect(planted.length).toBeGreaterThan(30);
      const member = JSON.stringify(await profile(LOCAL_KEY, "authenticated", { sub: "99999999-9999-4999-8999-999999999993" }));
      expect(member.split(PLANTED).length - 1).toBeGreaterThan(20);
      const searchFor = async (role, claims) => JSON.stringify(await search([null, "VT", null, null, 1], role, claims));
      expect(await searchFor("authenticated", { sub: "99999999-9999-4999-8999-999999999993" })).toContain(PLANTED);
      for (const role of ["anon", "authenticated"]) {
        const visitor = JSON.stringify(await profile(LOCAL_KEY, role));
        expect(visitor, `${role} profile`).not.toContain(PLANTED);
        expect(visitor, `${role} profile keeps the prose`).toContain("first, or");
        expect(await searchFor(role), `${role} search`).not.toContain(PLANTED);
      }
    } finally {
      await client.query("rollback to savepoint plant_every_column");
      await client.query("release savepoint plant_every_column");
    }
    // A record of what was planted and what the table's own checks refused.
    expect(planted).toEqual(expect.arrayContaining(["private.catalog_subunits.members_source", "private.catalog_organizations.structure_note"]));
    expect(refused.filter((entry) => !/\((23514|22P02|23503|22001|23505)\)$/.test(entry))).toEqual([]);
  });

  // A registry website is judged against the withheld destinations of the
  // catalog organizations linked to the registry row (same file number, or
  // union_org_id), on a registry write and when a release goes live; a
  // catalog home page stays.
  it("reduces a registry website that names a linked catalog organization's document, keeps its home page, and re-judges after a catalog change", async () => {
    const AGREEMENT = "https://exampleworkers1.example/contract/master-agreement";
    const HOME = "https://exampleworkers1.example/chapter-7";
    const registryWebsite = async () => (await client.query("select website from public.union_orgs where id = $1", [REGISTRY_MATCH_ID])).rows[0].website;
    const addDocument = (suffix, url) => client.query(
      `insert into private.catalog_documents
         (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
       select $1 || '~00000000000000' || $2, $1, 'contract', 'Probe agreement', $3, 'exampleworkers1.example',
              o.first_release_id, o.last_release_id, pg_catalog.repeat('d', 64)
         from private.catalog_organizations as o where o.catalog_key = $1`, [LOCAL_KEY, suffix, url]);
    await client.query("savepoint registry_destinations");
    try {
      // The fixture links the two: same file number and union_org_id.
      expect((await client.query("select union_org_id, olms_file_number from private.catalog_organizations where catalog_key = $1", [LOCAL_KEY])).rows[0])
        .toEqual({ union_org_id: REGISTRY_MATCH_ID, olms_file_number: 990000601 });
      await addDocument("b1", AGREEMENT);
      // A registry write: the document address, under another spelling, is reduced; the catalog home page stays.
      await client.query("update public.union_orgs set website = $2 where id = $1", [REGISTRY_MATCH_ID, "http://www.exampleworkers1.example/contract/../contract/master-agreement/?utm_source=x"]);
      expect(await registryWebsite()).toBe("http://www.exampleworkers1.example/");
      await client.query("update private.catalog_organizations set website = $2 where catalog_key = $1", [LOCAL_KEY, HOME]);
      await addDocument("b2", HOME);
      await client.query("update public.union_orgs set website = $2 where id = $1", [REGISTRY_MATCH_ID, HOME]);
      expect(await registryWebsite()).toBe(HOME);
      // A document added after the registry row was written: a direct catalog
      // write leaves the stored website until the refresh a release activation runs.
      const LATER = "https://exampleworkers1.example/contract/side-letter";
      await client.query("update public.union_orgs set website = $2 where id = $1", [REGISTRY_MATCH_ID, LATER]);
      expect(await registryWebsite()).toBe(LATER);
      await addDocument("b3", LATER);
      expect(await registryWebsite()).toBe(LATER);
      const judged = (await client.query("select private.catalog_refresh_registry_websites() as n")).rows[0].n;
      expect(judged).toBeGreaterThanOrEqual(1);
      expect(await registryWebsite()).toBe("https://exampleworkers1.example/");
      // A visitor reading the registry table directly gets the reduced value.
      const direct = await callAs("anon", "select website from public.union_orgs where id = $1", [REGISTRY_MATCH_ID]);
      expect(direct).toMatchObject({ ok: true, rows: [{ website: "https://exampleworkers1.example/" }] });
      // Linked by union_org_id alone (no shared file number) counts too.
      await client.query("update private.catalog_organizations set olms_file_number = null where catalog_key = $1", [LOCAL_KEY]);
      await client.query("update public.union_orgs set website = $2 where id = $1", [REGISTRY_MATCH_ID, AGREEMENT]);
      expect(await registryWebsite()).toBe("https://exampleworkers1.example/");
      // Activation runs the refresh once its rows are final.
      expect((await client.query("select pg_catalog.pg_get_functiondef('private.catalog_activate_release(text)'::regprocedure) as body")).rows[0].body)
        .toContain("perform private.catalog_refresh_registry_websites();");
      // At rest, no registry website differs from the rule with its linked destinations.
      expect((await client.query(
        "select count(*)::int as n from public.union_orgs where website is distinct from private.catalog_public_citation(website, private.registry_withheld_destinations(id, olms_file_number))",
      )).rows[0].n).toBe(0);
    } finally {
      await client.query("rollback to savepoint registry_destinations");
      await client.query("release savepoint registry_destinations");
    }
  });

  // These two matrix cases make many sequential RPCs. Allow four times the
  // usual 30 s case budget under shared Spark load; the 60 s per-statement
  // database limit still catches a stuck query. No privacy assertion changes.
  // Every address inside a text is judged on its own, whatever surrounds it,
  // and a value that is a link as a whole is judged whole with the rule's own
  // normalization. The destination has no extension, so the shape rule cannot
  // hide a boundary error.
  it("withholds an extensionless destination wherever it sits in a text, through the profile and the search, and leaves ordinary text alone", async () => {
    const AGREEMENT = "https://exampleworkers1.example/contract/master-agreement";
    const inputs = [
      `<${AGREEMENT}>`,
      `<a href="${AGREEMENT}">agreement</a>`,
      `https://example.org/home,${AGREEMENT}`,
      "See:exampleworkers1.example/contract/master-agreement",
      "HTTPS://EXAMPLEWORKERS1.EXAMPLE/contract/master-agreement",
      `'${AGREEMENT}'`,
      `https://a.example/x,${AGREEMENT},https://b.example/y`,
      `(read ${AGREEMENT}* first)`,
      "[text](exampleworkers1.example/contract/master-agreement)",
      "Source:exampleworkers1.example/contract/master-agreement",
      "exampleworkers1.example/contract/master-agreement//extra",
      "https%3A%2F%2Fexampleworkers1.example%2Fcontract%2Fmaster-agreement",
      // An address wrapped by a line break, with an uppercase host or a port.
      "Read https://EXAMPLEWORKERS1.EXAMPLE/contract/mas\nter-agreement first.",
      "Read https://exampleworkers1.example:443/contract/mas\nter-agreement first.",
      "Read https://exampleworkers1.exam\nple/contract/master-agreement first.",
      "Read https://example.org/home,EXAMPLEWORKERS1.EXAMPLE/contract/master-agreement first.",
      "Read https://exampleworkers1.example\\contract\\mas\nter-agreement first.",
      // A "//" inside an address stays part of it.
      "See https://exampleworkers1.example/contract//master-agreement today.",
      "See exampleworkers1.example/contract/master-agreement//extra today.",
    ];
    const ORDINARY = "Meets 24/7 and/or c/o the hall on 10.11.2026; see https://example.org/home for news.";
    // In prose a visitor gets every address as its site address, withheld or not.
    const ORDINARY_FOR_A_VISITOR = "Meets 24/7 and/or c/o the hall on 10.11.2026; see https://example.org/ for news.";
    const NOTE = "Stewards meet monthly.\nElections in May.";
    const MEMBER = { sub: "99999999-9999-4999-8999-999999999993" };
    const leaks = (json) => {
      let text = json.replace(/\\n/g, "");
      try { text = decodeURIComponent(text); } catch { /* not every escape is valid; the plain text is still checked */ }
      return text.toLowerCase().includes("contract/master-agreement");
    };
    await client.query("savepoint address_boundaries");
    try {
      await client.query(
        `insert into private.catalog_documents
           (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
         select $1 || '~00000000000000c1', $1, 'contract', 'Master agreement', $2, 'exampleworkers1.example',
                o.first_release_id, o.last_release_id, pg_catalog.repeat('f', 64)
           from private.catalog_organizations as o where o.catalog_key = $1`, [LOCAL_KEY, AGREEMENT]);
      for (const input of inputs) {
        await client.query("update private.catalog_organizations set structure_note = $2, name = $3 where catalog_key = $1",
          // The name column refuses a line break; joined, the address is one address again.
          [LOCAL_KEY, input, `Example Workers ${input.replace(/\n/g, "")}`]);
        await client.query(
          `update private.catalog_subunits set members_source = $2, density_note = $3, election_note = $4
            where subunit_key = (select min(subunit_key) from private.catalog_subunits where catalog_key = $1 and retired_release_id is null)`,
          [LOCAL_KEY, input, ORDINARY, NOTE]);
        const member = await profile(LOCAL_KEY, "authenticated", MEMBER);
        expect(leaks(JSON.stringify(member)), `member gets ${input}`).toBe(true);
        for (const role of ["anon", "authenticated"]) {
          const visitor = await profile(LOCAL_KEY, role);
          expect(leaks(JSON.stringify(visitor)), `${role} profile: ${input}`).toBe(false);
          expect(visitor.subunits.map((unit) => unit.densityNote), role)
            .toEqual(member.subunits.map((unit) => (unit.densityNote === ORDINARY ? ORDINARY_FOR_A_VISITOR : unit.densityNote)));
          expect(visitor.subunits.map((unit) => unit.electionNote), role).toEqual(member.subunits.map((unit) => unit.electionNote));
          expect(visitor.organization.name, role).toEqual(expect.any(String));
          expect(visitor.organization.structureNote, role).toEqual(expect.any(String));
          const searched = JSON.stringify(await search([null, "VT", null, null, 1], role));
          expect(searched.includes("Example Workers"), `${role} search finds the organization`).toBe(true);
          expect(leaks(searched), `${role} search: ${input}`).toBe(false);
        }
      }
      // A longer page that only starts with the destination, alone and in a
      // sentence, and a name that mentions it: never null, the row stays.
      await client.query("update private.catalog_organizations set structure_note = $2, name = $3 where catalog_key = $1",
        [LOCAL_KEY, "Visit https://exampleworkers1.example/contract/master-agreement-summary for meeting dates.",
         "Example Workers https://exampleworkers1.example/contract/master-agreement"]);
      await client.query(
        `update private.catalog_subunits set members_source = $2
          where subunit_key = (select min(subunit_key) from private.catalog_subunits where catalog_key = $1 and retired_release_id is null)`,
        [LOCAL_KEY, "https://exampleworkers1.example/contract/master-agreement-summary"]);
      for (const role of ["anon", "authenticated"]) {
        const visitor = await profile(LOCAL_KEY, role);
        expect(visitor.organization.structureNote, role).toBe("Visit https://exampleworkers1.example/ for meeting dates.");
        expect(visitor.organization.name, role).toBe("Example Workers https://exampleworkers1.example/");
        expect(visitor.subunits.map((unit) => unit.membersSource), role).toContain("https://exampleworkers1.example/contract/master-agreement-summary");
        const row = (await search([null, "VT", null, null, 1], role)).rows.find((item) => item.key === LOCAL_KEY);
        expect(row?.name, role).toBe("Example Workers https://exampleworkers1.example/");
      }
      // A website with a line break inside is judged whole, as the rule normalizes it.
      await client.query("update private.catalog_organizations set website = $2 where catalog_key = $1",
        [LOCAL_KEY, "https://exampleworkers1.example/contract/mas\nter-agreement"]);
      for (const role of ["anon", "authenticated"]) {
        expect((await profile(LOCAL_KEY, role)).organization.website, role).toBe("https://exampleworkers1.example/");
        const row = (await search([null, "VT", null, null, 1], role)).rows.find((item) => item.key === LOCAL_KEY);
        expect(row?.website, role).toBe("https://exampleworkers1.example/");
      }
    } finally {
      await client.query("rollback to savepoint address_boundaries");
      await client.query("release savepoint address_boundaries");
    }
  }, 120_000);

  // A whole value with no scheme and a line break or tab inside is judged
  // without them; an ordinary whole value is returned as stored.
  it("withholds a scheme-free whole value with a line break or tab inside, and returns an ordinary one as stored", async () => {
    const MEMBER = { sub: "99999999-9999-4999-8999-999999999993" };
    const values = [
      ["exampleworkers1.example/contract/mas\nter-agreement", "https://exampleworkers1.example/"],
      ["example.org/files/con\ttract.pdf", "https://example.org/"],
      ["https://example.org/about\n", "https://example.org/about\n"],
    ];
    await client.query("savepoint whole_value_breaks");
    try {
      await client.query(
        `insert into private.catalog_documents (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
         select $1 || '~00000000000000e1', $1, 'contract', 'Master agreement', 'https://exampleworkers1.example/contract/master-agreement',
                'exampleworkers1.example', o.first_release_id, o.last_release_id, pg_catalog.repeat('f', 64)
           from private.catalog_organizations as o where o.catalog_key = $1`, [LOCAL_KEY]);
      const subunit = (await client.query("select min(subunit_key) as k from private.catalog_subunits where catalog_key = $1 and retired_release_id is null", [LOCAL_KEY])).rows[0].k;
      const contact = (await client.query("select min(contact_key) as k from private.catalog_contacts where catalog_key = $1 and retired_release_id is null", [LOCAL_KEY])).rows[0].k;
      for (const [stored, shown] of values) {
        await client.query("update private.catalog_subunits set members_source = $2 where subunit_key = $1", [subunit, stored]);
        await client.query("update private.catalog_contacts set contact_kind = 'website', value = $2 where contact_key = $1", [contact, stored]);
        const member = await profile(LOCAL_KEY, "authenticated", MEMBER);
        expect(member.subunits.find((unit) => unit.key === subunit).membersSource).toBe(stored);
        expect(member.contacts.map((item) => item.value)).toContain(stored);
        for (const role of ["anon", "authenticated"]) {
          const visitor = await profile(LOCAL_KEY, role);
          expect(visitor.subunits.find((unit) => unit.key === subunit).membersSource, `${role} ${stored}`).toBe(shown);
          expect(visitor.contacts.map((item) => item.value), `${role} ${stored}`).toContain(shown);
        }
      }
    } finally {
      await client.query("rollback to savepoint whole_value_breaks");
      await client.query("release savepoint whole_value_breaks");
    }
  });

  // A whole value the rule keeps may still hold a second address: after a
  // comma, in a redirect's query, behind an archive address. A visitor gets
  // the outer site address; an ordinary page, a dotted name after a single
  // slash and an archived copy of one page are returned as stored.
  it("shows a visitor the outer site address of a kept whole value that holds a second address", async () => {
    const MEMBER = { sub: "99999999-9999-4999-8999-999999999993" };
    const values = [
      ["https://example.org/home,exampleworkers1.example/contract/master-agreement", "https://example.org/"],
      ["example.org/home,exampleworkers1.example/contract/master-agreement", "https://example.org/"],
      ["https://web.archive.org/web/2024/https://example.org/home,exampleworkers1.example/contract/master-agreement", "https://web.archive.org/"],
      ["https://www.google.com/url?q=https%3A%2F%2Fexampleworkers1.example%2Fcontract%2Fmaster-agreement", "https://www.google.com/"],
      ["https://www.google.com/url?q=https://www.nlrb.gov/about-nlrb", "https://www.google.com/"],
      ["https%253A%252F%252Fexampleworkers1.example%252Fcontract%252Fmaster-agreement", "https://exampleworkers1.example/"],
      ["https://x.example/index.php/about", "https://x.example/index.php/about"],
      ["https://web.archive.org/web/2024/https://example.org/about", "https://web.archive.org/web/2024/https://example.org/about"],
      ["https://www.atulcwa.org/index.cfm?zone=%2Funionactive%2Foffice_locations.cfm", "https://www.atulcwa.org/index.cfm?zone=%2Funionactive%2Foffice_locations.cfm"],
      ["https://example.org/news/2026/election-results", "https://example.org/news/2026/election-results"],
    ];
    await client.query("savepoint whole_value_second_address");
    try {
      await client.query(
        `insert into private.catalog_documents (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
         select $1 || '~00000000000000e2', $1, 'contract', 'Master agreement', 'https://exampleworkers1.example/contract/master-agreement',
                'exampleworkers1.example', o.first_release_id, o.last_release_id, pg_catalog.repeat('f', 64)
           from private.catalog_organizations as o where o.catalog_key = $1`, [LOCAL_KEY]);
      const subunit = (await client.query("select min(subunit_key) as k from private.catalog_subunits where catalog_key = $1 and retired_release_id is null", [LOCAL_KEY])).rows[0].k;
      for (const [stored, shown] of values) {
        await client.query("update private.catalog_subunits set members_source = $2 where subunit_key = $1", [subunit, stored]);
        const member = await profile(LOCAL_KEY, "authenticated", MEMBER);
        expect(member.subunits.find((unit) => unit.key === subunit).membersSource, stored).toBe(stored);
        for (const role of ["anon", "authenticated"]) {
          const visitor = await profile(LOCAL_KEY, role);
          expect(visitor.subunits.find((unit) => unit.key === subunit).membersSource, `${role} ${stored}`).toBe(shown);
        }
      }
    } finally {
      await client.query("rollback to savepoint whole_value_second_address");
      await client.query("release savepoint whole_value_second_address");
    }
  }, 120_000);

  // Prose is judged word by word, with no search for an address inside a
  // word: a word with a slash form is its site address when it is a link and
  // is dropped otherwise, unless it is plainly harmless ("24/7", a date).
  it("judges prose word by word, so no spelling of an address inside it reaches a visitor", async () => {
    const MEMBER = { sub: "99999999-9999-4999-8999-999999999993" };
    const hidden = [
      "See https%253A%252F%252Fexampleworkers1.example%252Fcontract%252Fmaster-agreement now.",
      "See https%3A%2F%2Fexampleworkers1%2Eexample%2Fcontract%2Fmaster-agreement now.",
      "Read exampleworkers1.example /contract/master-agreement first.",
      "Posted 10.11.2026/\nhttps://exampleworkers1.example/contract/master-agreement",
      "Read https://EXAMPLEWORKERS1.EXAMPLE/contract/mas\nter-agreement first.",
    ];
    const exact = [
      ["See https://example.org/news\nElections in May.", "See https://example.org/\nElections in May."],
      ["Open 24/7 and/or by appointment, c/o the hall, 11/10/2026, Local A/B.", "Open 24/7 and/or by appointment, c/o the hall, 11/10/2026, Local A/B."],
      ["<https://exampleworkers1.example/contract/master-agreement>", "<https://exampleworkers1.example/>"],
      ["See https%3A%2F%2Fexampleworkers1%2Eexample%2Fcontract%2Fmaster-agreement now.", "See https://exampleworkers1.example/ now."],
      ["Read exampleworkers1.example /contract/master-agreement first.", "Read exampleworkers1.example  first."],
    ];
    await client.query("savepoint prose_words");
    try {
      await client.query(
        `insert into private.catalog_documents (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
         select $1 || '~00000000000000e3', $1, 'contract', 'Master agreement', 'https://exampleworkers1.example/contract/master-agreement',
                'exampleworkers1.example', o.first_release_id, o.last_release_id, pg_catalog.repeat('f', 64)
           from private.catalog_organizations as o where o.catalog_key = $1`, [LOCAL_KEY]);
      const subunit = (await client.query("select min(subunit_key) as k from private.catalog_subunits where catalog_key = $1 and retired_release_id is null", [LOCAL_KEY])).rows[0].k;
      const shownFor = async (stored) => {
        await client.query("update private.catalog_organizations set structure_note = $2 where catalog_key = $1", [LOCAL_KEY, stored]);
        await client.query("update private.catalog_subunits set members_source = $2 where subunit_key = $1", [subunit, stored]);
        const member = await profile(LOCAL_KEY, "authenticated", MEMBER);
        expect(member.organization.structureNote, stored).toBe(stored);
        expect(member.subunits.find((unit) => unit.key === subunit).membersSource, stored).toBe(stored);
        const shown = [];
        for (const role of ["anon", "authenticated"]) {
          const visitor = await profile(LOCAL_KEY, role);
          shown.push(visitor.organization.structureNote, visitor.subunits.find((unit) => unit.key === subunit).membersSource);
        }
        return shown;
      };
      for (const stored of hidden) {
        for (const text of await shownFor(stored)) {
          expect(text, stored).toEqual(expect.any(String));
          expect(text.toLowerCase(), stored).not.toMatch(/\/contract|%2fcontract|%252fcontract/);
        }
      }
      for (const [stored, expected] of exact) {
        for (const text of await shownFor(stored)) {
          expect(text, stored).toBe(expected);
        }
      }
    } finally {
      await client.query("rollback to savepoint prose_words");
      await client.query("release savepoint prose_words");
    }
  });

  // The registry trigger judges the incoming row: a brand-new row, and a row
  // whose file number changes, are linked by their new file number even when
  // the catalog organization has no union_org_id.
  it("judges a new registry row and a changed file number by the incoming row's own file number", async () => {
    const stamp = "pg_catalog.repeat('a', 64)";
    const addOrganization = (key, file) => client.query(
      `insert into private.catalog_organizations (catalog_key, olms_file_number, union_org_id, name, tier, confidence, search_text,
                                                  first_release_id, last_release_id, content_sha256)
       select $1, $2::integer, null, 'Example Linked Local ' || $2::text, 'local', 'unreviewed', 'example linked local', o.first_release_id, o.last_release_id, ${stamp}
         from private.catalog_organizations as o where o.catalog_key = $3`, [key, file, LOCAL_KEY]);
    const addDocument = (key, url) => client.query(
      `insert into private.catalog_documents (document_key, catalog_key, doc_kind, title, url, url_host, first_release_id, last_release_id, content_sha256)
       select $1 || '~00000000000000d1', $1, 'contract', 'Agreement', $2, 'linked.example', o.first_release_id, o.last_release_id, ${stamp}
         from private.catalog_organizations as o where o.catalog_key = $1`, [key, url]);
    const anonWebsite = async (id) => (await callAs("anon", "select website from public.union_orgs where id = $1", [id])).rows[0]?.website;
    await client.query("savepoint registry_incoming_row");
    try {
      await addOrganization("olms-990000777", 990000777);
      await addDocument("olms-990000777", "https://linked.example/contract/unit-agreement");
      await addOrganization("olms-990000778", 990000778);
      await addDocument("olms-990000778", "https://linked.example/contract/side-letter");
      // A fresh INSERT of a registry row with that file number.
      await client.query(
        `insert into public.union_orgs (id, olms_file_number, name, level, enrichment_status, atlas_manifest_sha, website)
         values ('olms-990000777', 990000777, 'EXAMPLE LINKED LOCAL', 'local', 'enriched', 'fixture', 'https://linked.example/contract/unit-agreement')`);
      expect(await anonWebsite("olms-990000777")).toBe("https://linked.example/");
      // An UPDATE that moves a row onto a linked file number.
      await client.query(
        `insert into public.union_orgs (id, olms_file_number, name, level, enrichment_status, atlas_manifest_sha, website)
         values ('olms-990000779', 990000779, 'EXAMPLE MOVING LOCAL', 'local', 'enriched', 'fixture', 'https://linked.example/contract/side-letter')`);
      expect(await anonWebsite("olms-990000779")).toBe("https://linked.example/contract/side-letter");
      await client.query("update public.union_orgs set olms_file_number = 990000778 where id = 'olms-990000779'");
      expect(await anonWebsite("olms-990000779")).toBe("https://linked.example/");
    } finally {
      await client.query("rollback to savepoint registry_incoming_row");
      await client.query("release savepoint registry_incoming_row");
    }
  });

  it("hides retired and duplicate rows from search, children and the parent walk, answers hidden and unknown keys alike, and keeps the registry fallback for a retired catalog row", async () => {
    const retired = await search(["Retired Workers", null, null, null, 1]);
    expect(retired.rows.map((row) => row.key)).not.toContain(RETIRED_KEY);
    const duplicate = await search(["legacy filer", null, null, null, 1]);
    expect(duplicate.rows.map((row) => row.key)).not.toContain(DUPLICATE_KEY);
    // A query the duplicate row would match by name still never returns it.
    const byName = (await search(["Workers Local 1", null, null, null, 1])).rows.map((row) => row.key);
    expect(byName).toContain(LOCAL_KEY);
    expect(byName).not.toContain(DUPLICATE_KEY);
    const everything = (await search([null, "VT", null, null, 1])).rows.map((row) => row.key);
    expect(everything).toContain(LOCAL_KEY);
    expect(everything).not.toContain(RETIRED_KEY);
    for (const key of [RETIRED_KEY, DUPLICATE_KEY, WITHDRAWN_KEY, "olms-999999999", "ug-zzzzzzzzzz"]) {
      expect(await profile(key), key).toEqual({ found: false });
    }
    // A registry row whose only catalog row is retired comes back as registryOnly.
    const withdrawn = await search(["Withdrawn Workers", null, null, null, 1]);
    expect(withdrawn.rows.map((row) => row.key)).toEqual([REGISTRY_WITHDRAWN_ID]);
    expect(withdrawn.rows[0]).toMatchObject({ registryOnly: true, parentName: null });
    expect(everything).toContain(REGISTRY_WITHDRAWN_ID);

    // Children: a retired child and a duplicate child under a small parent
    // are left out, and childrenTotal counts only the visible child.
    const smallParent = await profile("ug-smallparen");
    expect(smallParent.children.map((child) => child.key)).toEqual(["ug-dupkid0003"]);
    expect(smallParent.childrenTotal).toBe(1);
    // Parents: edges to a retired or duplicate organization and retired edges
    // are left out; the walk does not continue through the retired parent;
    // the label-only edge stays.
    const hidden = await profile("ug-hiddenkid0");
    expect(hidden.found).toBe(true);
    expect(hidden.parents).toEqual([expect.objectContaining({ depth: 1, parentKey: null, parentName: null, parentLabel: "Example Label Council", edgeKind: "parent_body" })]);

    const local = await profile(LOCAL_KEY);
    expect(local.found).toBe(true);
    expect(local.organization).toMatchObject({ key: LOCAL_KEY, registryId: REGISTRY_MATCH_ID });
    expect(local.parents.find((edge) => edge.edgeKind === "olms_parent")).toMatchObject({ parentKey: NATIONAL_KEY, depth: 1 });
    expect(local.coverage).toMatchObject({ band: expect.stringMatching(/^(basic|structured|deep)$/) });
    expect(Object.keys(local.coverage.checklist).sort()).toEqual(
      ["contract", "electionCadence", "governingDocument", "hierarchy", "publicContact", "seats", "structure", "website"],
    );
  });

  it("raises 22023 for every out-of-bounds argument", async () => {
    const bad = [
      ["a", null, null, null, 1],
      ["x".repeat(81), null, null, null, 1],
      ["ab\ncd", null, null, null, 1],
      ["ab\u0007", "VT", null, null, 1],
      [null, "vt", null, null, 1],
      [null, "VTX", null, null, 1],
      [null, null, null, null, 1],
      ["   ", "", null, null, 1],
      ["Example", null, "F".repeat(41), null, 1],
      ["Example", null, "F\u0007", null, 1],
      ["Example", null, null, "county", 1],
      ["Example", null, null, null, 0],
      ["Example", null, null, null, 41],
      ["Example", null, null, null, null],
    ];
    for (const args of bad) {
      const result = await callAs("anon", "select public.search_union_catalog($1, $2, $3, $4, $5)", args);
      expect(result, JSON.stringify(args)).toMatchObject({ ok: false, code: "22023" });
    }
    for (const key of ["", "OLMS-1", "olms-", "test-900000001", "olms-1234567890", "ug-short", null]) {
      const result = await callAs("anon", "select public.get_union_catalog_profile($1)", [key]);
      expect(result, String(key)).toMatchObject({ ok: false, code: "22023" });
    }
    expect((await search(["x".repeat(80), null, null, null, 40])).rows).toEqual([]);
  });

  it("walks at most 8 parent levels and returns at most 500 children with the full childrenTotal", async () => {
    const chain = await profile(chainKey(0));
    expect(chain.found).toBe(true);
    const depths = chain.parents.map((edge) => edge.depth);
    expect(Math.max(...depths)).toBe(8);
    expect(chain.parents.map((edge) => edge.parentKey)).toContain(chainKey(8));
    expect(chain.parents.map((edge) => edge.parentKey)).not.toContain(chainKey(9));
    expect(chain.parents.find((edge) => edge.depth === 1)).toMatchObject({ childKey: chainKey(0), parentKey: chainKey(1), parentName: "Example Chain Body 1" });
    const parent = await profile("ug-kidsparent");
    expect(parent.children).toHaveLength(500);
    expect(parent.childrenTotal).toBe(501);
    expect((await profile(chainKey(10))).parents).toEqual([]);
  });

  it("never lets a planted email or phone reach any RPC output", async () => {
    const planted = await profile(PLANTED_KEY);
    expect(planted.found).toBe(true);
    expect(planted.organization.structureNote).toBeNull();
    expect(planted.subunits).toHaveLength(1);
    expect(planted.subunits[0]).toMatchObject({ name: "Example Planted Chapter", location: null });
    expect(planted.seatOutlines[0].title).toBeNull();
    expect(planted.contacts[0].label).toBeNull();
    expect(planted.documents[0].title).toBeNull();
    expect(planted.parents).toEqual([expect.objectContaining({ parentKey: null, parentLabel: null })]);
    const outputs = [
      planted,
      await search(["Planted", null, null, null, 1]),
      await search([null, "VT", null, null, 1]),
      await status(),
    ];
    for (const output of outputs) {
      const text = JSON.stringify(output);
      expect(text).not.toContain(PLANTED_EMAIL);
      expect(text).not.toContain("freemail.example");
      expect(text).not.toContain(PLANTED_PHONE);
    }
  });

  it("loads the next release without changing anything readers see, flips atomically, applies changes and retirements, and rolls back from the retained staging rows", async () => {
    const before = { status: await status(), search: await search(["Exampleville", null, null, null, 1]), profile: await profile(LOCAL_KEY) };
    const liveBefore = async (table) => (await client.query(`select count(*)::integer as n from private.catalog_${table} where retired_release_id is null`)).rows[0].n;
    const liveOrganizations = await liveBefore("organizations");
    const liveSubunits = await liveBefore("subunits");

    // The owner-planted shapes are not in the next release, so activating it
    // would retire far more than 3% of live organizations: the ceiling is
    // recorded at load and enforced by the activation.
    const nextSummary = await loadRelease({ client, ...nextRelease, allowRetire: 2000, exclusions });
    expect(nextSummary.restaged).toBeNull();
    expect(nextSummary.withdrawal.overLimit).toBe(true);
    const nextVerify = await verifyRelease({ client, ...nextRelease, exclusions });
    expect(nextVerify.problems).toEqual([]);
    expect(nextVerify.notes).toContain(`release ${LABEL} is active; ${NEXT_LABEL} is staged`);
    expect(nextVerify.verifiedAt).not.toBeNull();
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
    // Nothing moved for readers.
    expect(await status()).toEqual(before.status);
    expect(await search(["Exampleville", null, null, null, 1])).toEqual(before.search);
    expect(await profile(LOCAL_KEY)).toEqual(before.profile);
    expect(await liveBefore("organizations")).toBe(liveOrganizations);
    expect(await liveBefore("subunits")).toBe(liveSubunits);

    const second = await callAs(null, "update private.catalog_releases set status = 'active' where label = $1", [NEXT_LABEL]);
    expect(second).toMatchObject({ ok: false, code: "23505" });

    // A coverage insert that cannot succeed makes the activation fail after it
    // has already applied rows and retired the active release inside the same
    // statement: nothing of it remains.
    await client.query("savepoint forced_activation_failure");
    await client.query("alter table private.catalog_coverage add constraint catalog_coverage_proof_failure check (band = 'never') not valid");
    await expect(client.query("select private.catalog_activate_release($1)", [NEXT_LABEL])).rejects.toMatchObject({ code: "23514" });
    await client.query("rollback to savepoint forced_activation_failure");
    await client.query("release savepoint forced_activation_failure");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
    expect(await profile(LOCAL_KEY)).toEqual(before.profile);

    // The flip itself: one statement, one active release afterwards, and the
    // second-load semantics against Postgres.
    const droppedSubunit = fixtureRelease.release.subunits.find((s) => !nextRelease.release.subunits.some((n) => n.subunit_key === s.subunit_key));
    const keptSubunit = nextRelease.release.subunits[0];
    const localHashBefore = (await bookkeeping("organizations", LOCAL_KEY)).content_sha256;
    const nationalHashBefore = (await bookkeeping("organizations", NATIONAL_KEY)).content_sha256;
    await client.query("savepoint activation_flip");
    const diff = await activateRelease({ client, label: NEXT_LABEL });
    expect(diff).toMatchObject({
      organizationsAdded: 0,
      organizationsChanged: 1,
      organizationsRetired: liveOrganizations - nextRelease.release.organizations.length,
      subunitsAdded: 0,
      subunitsRetired: liveSubunits - nextRelease.release.subunits.length,
      tenantOrganizationsBefore: organizationsBefore,
      tenantOrganizationsAfter: organizationsBefore,
    });
    expect(await releases()).toEqual([{ label: LABEL, status: "retired" }, { label: NEXT_LABEL, status: "active" }]);
    expect((await status()).releaseLabel).toBe(NEXT_LABEL);
    const { rows: [coverage] } = await client.query("select count(distinct release_id)::integer as releases from private.catalog_coverage");
    expect(coverage.releases).toBe(1);
    // Changed row: last_release_id and the hash moved, first_release_id did not.
    const changedLocal = await bookkeeping("organizations", LOCAL_KEY);
    expect(changedLocal).toMatchObject({ first_label: LABEL, last_label: NEXT_LABEL, retired_label: null });
    expect(changedLocal.content_sha256).not.toBe(localHashBefore);
    // Unchanged row: skipped entirely.
    expect(await bookkeeping("organizations", NATIONAL_KEY)).toMatchObject({ first_label: LABEL, last_label: LABEL, retired_label: null, content_sha256: nationalHashBefore });
    // Absent row: retired, never deleted; the retired planted row stays as it was.
    expect(await bookkeeping("subunits", droppedSubunit.subunit_key)).toMatchObject({ first_label: LABEL, last_label: LABEL, retired_label: NEXT_LABEL });
    expect(await bookkeeping("subunits", keptSubunit.subunit_key)).toMatchObject({ first_label: LABEL, last_label: LABEL, retired_label: null });
    expect(await bookkeeping("organizations", "ug-kidsparent")).toMatchObject({ retired_label: NEXT_LABEL });
    expect(await bookkeeping("organizations", RETIRED_KEY)).toMatchObject({ retired_label: LABEL });
    const changed = await profile(LOCAL_KEY);
    expect(changed.organization.structureNote).not.toBe(before.profile.organization.structureNote);
    expect(changed.subunits.map((s) => s.key)).toEqual([keptSubunit.subunit_key]);
    expect(await profile("ug-kidsparent")).toEqual({ found: false });
    // Both releases keep their staging rows: the retired one for a rollback,
    // but its verify stamp is gone, so the rollback is verify, then activate.
    expect(await stagedCount(LABEL)).toBeGreaterThan(0);
    expect(await stagedCount(NEXT_LABEL)).toBeGreaterThan(0);
    expect(await stamp(LABEL)).toEqual({ status: "retired", verified: false, digest: false });
    expect(await activateAsOwner(LABEL)).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/not verified/) });
    expect((await verifyRelease({ client, ...fixtureRelease, exclusions })).problems).toEqual([]);

    // Rollback: activate the previous label from its retained staging rows.
    const back = await activateRelease({ client, label: LABEL });
    // The diff counts by bookkeeping, not by what this call rewrote:
    // organizationsAdded is every live row whose first_release_id is this
    // release (all of them, including the local the rollback just rewrote),
    // organizationsChanged only live rows this release last wrote that a
    // different release introduced (none), and organizationsRetired every
    // row retired under this release's id (the three owner-planted rows
    // inserted as retired under it).
    expect(back).toMatchObject({ organizationsAdded: fixtureRelease.release.organizations.length, organizationsChanged: 0, organizationsRetired: 3, subunitsRetired: 0 });
    expect(await stamp(NEXT_LABEL)).toEqual({ status: "retired", verified: false, digest: false });
    expect(await bookkeeping("organizations", LOCAL_KEY)).toMatchObject({ content_sha256: localHashBefore });
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "retired" }]);
    expect(await bookkeeping("organizations", LOCAL_KEY)).toMatchObject({ first_label: LABEL, last_label: LABEL, retired_label: null });
    expect(await bookkeeping("subunits", droppedSubunit.subunit_key)).toMatchObject({ first_label: LABEL, last_label: LABEL, retired_label: null });
    expect((await profile(LOCAL_KEY)).organization.structureNote).toBe(before.profile.organization.structureNote);
    expect((await profile(LOCAL_KEY)).subunits).toHaveLength(fixtureRelease.release.subunits.length);
    // The owner-planted rows were never staged, so they stay retired.
    expect(await profile("ug-kidsparent")).toEqual({ found: false });
    expect(await stagedCount(NEXT_LABEL)).toBeGreaterThan(0);
    await client.query("rollback to savepoint activation_flip");
    await client.query("release savepoint activation_flip");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
    expect(await profile(LOCAL_KEY)).toEqual(before.profile);
  });

  it("refuses activation to every Data API role (42501) and to any label that is active, unknown, unverified, superseded or over the withdrawal guard (22023)", async () => {
    for (const role of ROLES) {
      const denied = await callAs(role, "select private.catalog_activate_release($1)", [NEXT_LABEL]);
      expect(denied, role).toMatchObject({ ok: false, code: "42501" });
    }
    const { rows } = await client.query(
      `select g.role, has_function_privilege(g.role, 'private.catalog_activate_release(text)', 'execute') as allowed
         from unnest($1::text[]) as g(role) order by g.role`,
      [ROLES],
    );
    expect(rows).toEqual(ROLES.map((role) => ({ role, allowed: false })));
    const { rows: [acl] } = await client.query(
      `select exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                       where p.oid = 'private.catalog_activate_release(text)'::regprocedure and a.grantee = 0) as public_execute`,
    );
    expect(acl.public_execute).toBe(false);
    for (const label of [LABEL, "20991231-99", "not-a-label", null]) {
      const refused = await callAs(null, "select private.catalog_activate_release($1)", [label]);
      expect(refused, String(label)).toMatchObject({ ok: false, code: "22023" });
    }

    // Unverified: a staged row nobody verified, then one verified but without staging rows.
    await client.query("savepoint activation_refusals");
    await client.query(
      `insert into private.catalog_releases
         (label, status, schema_version, filter_version, source_sha256, artifact_sha256, source_built_at, counts)
       values ($1, 'staged', 'union-catalog-release/1', 'privacy-filter/1', repeat('a', 64), repeat('b', 64), now(), '{}'::jsonb)`,
      [THIRD_LABEL],
    );
    expect(await callAs(null, "select private.catalog_activate_release($1)", [THIRD_LABEL])).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/not verified/) });
    await client.query("update private.catalog_releases set verified_at = now() where label = $1", [THIRD_LABEL]);
    expect(await callAs(null, "select private.catalog_activate_release($1)", [THIRD_LABEL])).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/no staged rows/) });
    // Over the guard: the next release would retire the planted rows and its ceiling is too small.
    await client.query("update private.catalog_releases set counts = counts || '{\"allowRetire\": 1}'::jsonb where label = $1", [NEXT_LABEL]);
    expect(await callAs(null, "select private.catalog_activate_release($1)", [NEXT_LABEL])).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/withdrawal guard/) });
    await client.query("update private.catalog_releases set counts = counts - 'allowRetire' where label = $1", [NEXT_LABEL]);
    expect(await callAs(null, "select private.catalog_activate_release($1)", [NEXT_LABEL])).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/withdrawal guard/) });
    await expect(activateRelease({ client, label: NEXT_LABEL, allowRetire: 1 })).rejects.toMatchObject({ code: "22023" });
    await client.query("rollback to savepoint activation_refusals");
    await client.query("release savepoint activation_refusals");

    // Superseded: activating a later load deletes the earlier staged release's
    // rows, so it can no longer be activated over the newer live rows.
    await client.query("savepoint superseded");
    await loadRelease({ client, ...thirdRelease, allowRetire: 2000, exclusions });
    expect((await verifyRelease({ client, ...thirdRelease, exclusions })).problems).toEqual([]);
    expect(await stagedCount(NEXT_LABEL)).toBeGreaterThan(0);
    await activateRelease({ client, label: THIRD_LABEL });
    expect(await releases()).toEqual([{ label: LABEL, status: "retired" }, { label: NEXT_LABEL, status: "staged" }, { label: THIRD_LABEL, status: "active" }]);
    expect(await stagedCount(NEXT_LABEL)).toBe(0);
    expect(await stagedCount(LABEL)).toBeGreaterThan(0);
    expect(await callAs(null, "select private.catalog_activate_release($1)", [NEXT_LABEL])).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/no staged rows/) });
    await client.query("rollback to savepoint superseded");
    await client.query("release savepoint superseded");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
  });

  it("stages the fixture release without touching public.organizations, links union_org_id by file number, refuses an exclusion match before writing, and fails verify closed on a tampered staged row", async () => {
    const { rows: [now] } = await client.query("select count(*)::integer as n from public.organizations");
    expect(now.n).toBe(organizationsBefore);
    expect(loadSummary).toMatchObject({ organizationsBefore, organizationsAfter: organizationsBefore, restaged: null });
    for (const [table, rows] of Object.entries(loadSummary.rows)) {
      expect(rows, table).toBe(fixtureRelease.release[table].length);
      expect(loadSummary.staged[table], table).toBe(rows);
    }
    const { rows: links } = await client.query(
      "select catalog_key, union_org_id from private.catalog_organizations where catalog_key = any($1::text[]) order by catalog_key",
      [[LOCAL_KEY, NATIONAL_KEY]],
    );
    expect(links).toEqual([
      { catalog_key: NATIONAL_KEY, union_org_id: null },
      { catalog_key: LOCAL_KEY, union_org_id: REGISTRY_MATCH_ID },
    ]);
    const { rows: [release] } = await client.query(
      "select counts ->> 'organizationsBefore' as before, counts ->> 'organizationsAfter' as after, verified_at is not null as verified from private.catalog_releases where label = $1",
      [LABEL],
    );
    expect(release).toEqual({ before: String(organizationsBefore), after: String(organizationsBefore), verified: true });
    expect(verifyReport.problems).toEqual([]);
    expect(verifyReport.notes).toEqual([`no release is active yet; ${LABEL} is staged`]);
    expect(verifyReport.verifiedAt).not.toBeNull();
    await expect(loadRelease({ client, ...fixtureRelease, exclusions })).rejects.toThrow(/already active/);

    // The exclusion sweep runs before any write.
    const national = fixtureRelease.release.organizations.find((o) => o.catalog_key === NATIONAL_KEY);
    await expect(loadRelease({ client, ...thirdRelease, exclusions: exclusionList([national.name]) })).rejects.toThrow(/match the exclusion list/);
    expect((await client.query("select count(*)::integer as n from private.catalog_releases where label = $1", [THIRD_LABEL])).rows[0].n).toBe(0);

    // A staged row that no longer matches the artifact fails verify, which
    // marks the release failed; activation refuses it until it is re-loaded
    // and verified again.
    await client.query("savepoint tampered");
    await client.query(
      `update private.catalog_staging set content = content || '{"structure_note": "Example tampered note"}'::jsonb
        where release_id = (select id from private.catalog_releases where label = $1) and table_name = 'organizations' and row_key = $2`,
      [NEXT_LABEL, LOCAL_KEY],
    );
    const tampered = await verifyRelease({ client, ...nextRelease, exclusions });
    expect(tampered.problems).toEqual([expect.stringMatching(/organizations: 1 staged row\(s\) differ from the release/)]);
    expect(tampered.notes).toContain(`release ${NEXT_LABEL} is marked failed; load it again after fixing the artifact, or verify it again once the check that failed passes`);
    expect(await stamp(NEXT_LABEL)).toEqual({ status: "failed", verified: false, digest: false });
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "failed" }]);
    expect(await callAs(null, "select private.catalog_activate_release($1)", [NEXT_LABEL])).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/not staged/) });
    const reloaded = await loadRelease({ client, ...nextRelease, allowRetire: 2000, exclusions });
    expect(reloaded.restaged).toBe("failed");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
    expect(await callAs(null, "select private.catalog_activate_release($1)", [NEXT_LABEL])).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/not verified/) });
    expect((await verifyRelease({ client, ...nextRelease, exclusions })).problems).toEqual([]);
    await client.query("rollback to savepoint tampered");
    await client.query("release savepoint tampered");
  });

  it("expires a retired release's verify stamp, so a rollback is verify then activate, and a verify that fails the current exclusion list refuses the rollback (22023)", async () => {
    await client.query("savepoint stale_rollback");
    await activateRelease({ client, label: NEXT_LABEL });
    // Retiring the first release kept its staging rows but cleared its stamp.
    expect(await stamp(LABEL)).toEqual({ status: "retired", verified: false, digest: false });
    expect(await stagedCount(LABEL)).toBeGreaterThan(0);
    expect(await activateAsOwner(LABEL)).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/not verified/) });

    const passed = await verifyRelease({ client, ...fixtureRelease, exclusions });
    expect(passed).toMatchObject({ problems: [], previousStatus: "retired", status: "retired" });
    expect(formatVerify(passed).at(-1)).toMatch(/The retired release is verified again; activate it to roll back\.$/);
    expect(await stamp(LABEL)).toEqual({ status: "retired", verified: true, digest: true });

    // The owner then excludes a value the retired release still stages: the
    // verify fails and withdraws the stamp, and the rollback is refused.
    const national = fixtureRelease.release.organizations.find((o) => o.catalog_key === NATIONAL_KEY);
    const failed = await verifyRelease({ client, ...fixtureRelease, exclusions: exclusionList([national.name]) });
    expect(failed.problems).toEqual([expect.stringMatching(/^privacy sweep: [0-9]+ staged value\(s\) match the exclusion list$/)]);
    expect(failed).toMatchObject({ previousStatus: "retired", status: "retired", verifiedAt: null });
    expect(failed.notes).toContain(`release ${LABEL} stays retired and is no longer verified; it cannot be activated until a verify passes`);
    expect(await stamp(LABEL)).toEqual({ status: "retired", verified: false, digest: false });
    expect(await activateAsOwner(LABEL)).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/not verified/) });
    await expect(activateRelease({ client, label: LABEL })).rejects.toMatchObject({ code: "22023", message: expect.stringMatching(/not verified/) });
    expect((await status()).releaseLabel).toBe(NEXT_LABEL);

    // With the value no longer excluded, verify then activate rolls back.
    expect((await verifyRelease({ client, ...fixtureRelease, exclusions })).problems).toEqual([]);
    await activateRelease({ client, label: LABEL });
    expect((await status()).releaseLabel).toBe(LABEL);
    expect(await stamp(NEXT_LABEL)).toEqual({ status: "retired", verified: false, digest: false });
    await client.query("rollback to savepoint stale_rollback");
    await client.query("release savepoint stale_rollback");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
  });

  it("refuses staged rows changed after verify (22023): changed content, changed content and hash, or a stamp without a digest", async () => {
    const nextId = await releaseId(NEXT_LABEL);
    const { rows: [stored] } = await client.query("select verified_sha256 from private.catalog_releases where id = $1", [nextId]);
    // The loader's digest expression and the function's agree on untouched rows.
    const { rows: [recomputed] } = await client.query(STAGING_DIGEST_SQL, [nextId]);
    expect(recomputed.digest).toBe(stored.verified_sha256);
    expect(stored.verified_sha256).toMatch(/^[0-9a-f]{64}$/);

    const tampers = [
      [`update private.catalog_staging set content = content || '{"structure_note": "Example note changed after verify"}'::jsonb
         where release_id = $1 and table_name = 'organizations' and row_key = $2`, [nextId, LOCAL_KEY]],
      [`update private.catalog_staging set content = content || '{"structure_note": "Example note changed after verify"}'::jsonb,
              content_sha256 = repeat('c', 64)
         where release_id = $1 and table_name = 'organizations' and row_key = $2`, [nextId, LOCAL_KEY]],
      ["delete from private.catalog_staging where release_id = $1 and table_name = 'subunits'", [nextId]],
      ["update private.catalog_releases set verified_sha256 = null where id = $1", [nextId]],
    ];
    for (const [sql, params] of tampers) {
      await client.query("savepoint staged_tamper");
      await client.query(sql, params);
      expect(await activateAsOwner(NEXT_LABEL), sql).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/staged rows changed after catalog:verify/) });
      await expect(activateRelease({ client, label: NEXT_LABEL })).rejects.toMatchObject({ code: "22023", message: expect.stringMatching(/changed after catalog:verify/) });
      await client.query("rollback to savepoint staged_tamper");
      await client.query("release savepoint staged_tamper");
    }
    expect((await status()).releaseLabel).toBe(LABEL);
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
  });

  it("re-stamps a failed release whose staged rows pass again (staged, verified), keeps failing one whose staged rows are gone, and stamps nothing on the active release", async () => {
    const onActive = await verifyRelease({ client, ...fixtureRelease, exclusions });
    expect(onActive).toMatchObject({ problems: [], status: "active", verifiedAt: null });
    expect(formatVerify(onActive).at(-1)).toMatch(/It is the active release; nothing was stamped\.$/);

    await client.query("savepoint failed_restamp");
    const national = nextRelease.release.organizations.find((o) => o.catalog_key === NATIONAL_KEY);
    const failed = await verifyRelease({ client, ...nextRelease, exclusions: exclusionList([national.name]) });
    expect(failed).toMatchObject({ previousStatus: "staged", status: "failed", verifiedAt: null });
    expect(formatVerify(failed)).toContain(`FAIL: the staged rows disagree with release ${NEXT_LABEL}:`);
    expect(await stamp(NEXT_LABEL)).toEqual({ status: "failed", verified: false, digest: false });

    const again = await verifyRelease({ client, ...nextRelease, exclusions });
    expect(again).toMatchObject({ problems: [], previousStatus: "failed", status: "staged" });
    expect(again.verifiedAt).not.toBeNull();
    expect(again.notes).toContain(`release ${NEXT_LABEL} was marked failed and now passes; it is staged again and verified`);
    expect(formatVerify(again).at(-1)).toMatch(/It was marked failed and is now staged again and verified; activate it next\.$/);
    expect(await stamp(NEXT_LABEL)).toEqual({ status: "staged", verified: true, digest: true });
    await activateRelease({ client, label: NEXT_LABEL });
    expect((await status()).releaseLabel).toBe(NEXT_LABEL);
    await client.query("rollback to savepoint failed_restamp");

    // A failed release whose staging rows are gone cannot pass.
    await verifyRelease({ client, ...nextRelease, exclusions: exclusionList([national.name]) });
    await client.query("delete from private.catalog_staging where release_id = $1", [await releaseId(NEXT_LABEL)]);
    const empty = await verifyRelease({ client, ...nextRelease, exclusions });
    expect(empty.problems.length).toBeGreaterThan(0);
    expect(empty.problems[0]).toMatch(/release row\(s\) are not staged/);
    expect(empty).toMatchObject({ previousStatus: "failed", status: "failed", verifiedAt: null });
    expect(formatVerify(empty).join("\n")).not.toMatch(/PASS/);
    await client.query("rollback to savepoint failed_restamp");
    await client.query("release savepoint failed_restamp");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
  });

  it("reports a staged value that does not fit its live column by SQLSTATE, constraint, table and staged row key only, never by value", async () => {
    const nextId = await releaseId(NEXT_LABEL);
    // A gap in the offline checks, simulated as the owner: a staged row that
    // cannot be applied, stamped with a matching digest.
    const unfit = [
      ["members_reported", `Example text ${PLANTED_PHONE}`, "22P02", null],
      ["name", `Example\u0007 ${PLANTED_PHONE}`, "23514", "catalog_organizations_name_check"],
    ];
    for (const [column, planted, code, constraint] of unfit) {
      await client.query("savepoint unfit_row");
      await client.query(
        `update private.catalog_staging set content = content || pg_catalog.jsonb_build_object($3::text, $4::text)
          where release_id = $1 and table_name = 'organizations' and row_key = $2`,
        [nextId, LOCAL_KEY, column, planted],
      );
      await client.query(`update private.catalog_releases set verified_sha256 = (${STAGING_DIGEST_SQL}) where id = $1`, [nextId]);
      const error = await activateRelease({ client, label: NEXT_LABEL }).then(() => null, (caught) => caught);
      expect(error, column).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.message).toMatch(/^activation refused by the database \(SQLSTATE /);
      expect(error.message).toContain(`staged row organizations ${LOCAL_KEY}`);
      if (constraint) expect(error.message).toContain(`constraint ${constraint}, table private.catalog_organizations`);
      expect(error.message).not.toContain(PLANTED_PHONE);
      expect(error.message).not.toContain("Example");
      expect(error).not.toHaveProperty("detail");
      expect(error.cause).toBeUndefined();
      expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
      await client.query("rollback to savepoint unfit_row");
      await client.query("release savepoint unfit_row");
    }
    expect((await status()).releaseLabel).toBe(LABEL);
  });

  it("fails verify when a staged union_org_id disagrees with public.union_orgs, and holds union_org_id to a bounded, control-free registry id (23514)", async () => {
    const nextId = await releaseId(NEXT_LABEL);
    const mismatch = `organizations: 1 staged union_org_id value(s) disagree with public.union_orgs for their file number (first: ${LOCAL_KEY})`;
    await client.query("savepoint registry_link");
    await client.query(
      `update private.catalog_staging set content = content || pg_catalog.jsonb_build_object('union_org_id', $3::text)
        where release_id = $1 and table_name = 'organizations' and row_key = $2`,
      [nextId, LOCAL_KEY, REGISTRY_ONLY_ID],
    );
    const tampered = await verifyRelease({ client, ...nextRelease, exclusions });
    expect(tampered.problems).toContain(mismatch);
    expect(tampered.status).toBe("failed");
    await client.query("rollback to savepoint registry_link");
    // The registry moved after the load: the staged link is stale.
    await client.query("update public.union_orgs set olms_file_number = 990000699 where id = $1", [REGISTRY_MATCH_ID]);
    expect((await verifyRelease({ client, ...nextRelease, exclusions })).problems).toContain(mismatch);
    await client.query("rollback to savepoint registry_link");
    for (const bad of ["", "x".repeat(201), "fixture-registry\u0007"]) {
      const refused = await callAs(null, "update private.catalog_organizations set union_org_id = $1 where catalog_key = $2", [bad, LOCAL_KEY]);
      expect(refused, JSON.stringify(bad)).toMatchObject({ ok: false, code: "23514", message: expect.stringMatching(/catalog_organizations_union_org_id_check/) });
    }
    expect(await callAs(null, "update private.catalog_organizations set union_org_id = $1 where catalog_key = $2", [REGISTRY_MATCH_ID, LOCAL_KEY])).toMatchObject({ ok: true });
    await client.query("release savepoint registry_link");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
  });

  it("rolls back past a release that added rows: the guard counts the additions, the rollback retires them, rolling forward un-retires them, and a release staged but never activated loses its staging rows", async () => {
    await client.query("savepoint added_rows");
    const addedOrganization = addedRelease.release.organizations
      .find((o) => !fixtureRelease.release.organizations.some((f) => f.catalog_key === o.catalog_key)).catalog_key;
    const addedSubunit = addedRelease.release.subunits
      .find((s) => !fixtureRelease.release.subunits.some((f) => f.subunit_key === s.subunit_key)).subunit_key;
    await loadRelease({ client, ...addedRelease, allowRetire: 2000, exclusions });
    expect((await verifyRelease({ client, ...addedRelease, exclusions })).problems).toEqual([]);
    const forward = await activateRelease({ client, label: ADDED_LABEL });
    expect(forward).toMatchObject({ organizationsAdded: 1, subunitsAdded: 1 });
    expect(await bookkeeping("organizations", addedOrganization)).toMatchObject({ first_label: ADDED_LABEL, last_label: ADDED_LABEL, retired_label: null });
    // Loaded and verified while the added release is active, never activated.
    await loadRelease({ client, ...thirdRelease, allowRetire: 2000, exclusions });
    expect((await verifyRelease({ client, ...thirdRelease, exclusions })).problems).toEqual([]);
    expect(await stagedCount(THIRD_LABEL)).toBeGreaterThan(0);

    // Rollback to the first release: verify, then activate. Retiring the
    // added rows trips the guard until the operator names a ceiling.
    expect((await verifyRelease({ client, ...fixtureRelease, exclusions })).problems).toEqual([]);
    expect(await activateAsOwner(LABEL)).toMatchObject({
      ok: false, code: "22023", message: expect.stringMatching(/^withdrawal guard: 1 of [0-9]+ live organizations and 1 of [0-9]+ live sub-units would retire/),
    });
    const back = await activateRelease({ client, label: LABEL, allowRetire: 2 });
    // Retired under the first release's id: the added organization plus the
    // three owner-planted rows inserted as retired under it; the added sub-unit.
    expect(back).toMatchObject({ organizationsRetired: 4, subunitsRetired: 1, organizationsChanged: 0 });
    expect(await bookkeeping("organizations", addedOrganization)).toMatchObject({ first_label: ADDED_LABEL, last_label: ADDED_LABEL, retired_label: LABEL });
    expect(await bookkeeping("subunits", addedSubunit)).toMatchObject({ first_label: ADDED_LABEL, last_label: ADDED_LABEL, retired_label: LABEL });
    expect(await profile(addedOrganization)).toEqual({ found: false });
    // Staging cleanup: the never-activated release lost its rows, the release
    // the rollback retired kept them.
    expect(await stagedCount(THIRD_LABEL)).toBe(0);
    expect(await stagedCount(ADDED_LABEL)).toBeGreaterThan(0);
    expect(await activateAsOwner(THIRD_LABEL)).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/no staged rows/) });

    // Roll forward: verify again, then activate; the added rows come back
    // with their first release kept.
    expect(await activateAsOwner(ADDED_LABEL)).toMatchObject({ ok: false, code: "22023", message: expect.stringMatching(/not verified/) });
    expect((await verifyRelease({ client, ...addedRelease, exclusions })).problems).toEqual([]);
    const again = await activateRelease({ client, label: ADDED_LABEL });
    expect(again).toMatchObject({ organizationsAdded: 1, subunitsAdded: 1 });
    expect(await bookkeeping("organizations", addedOrganization)).toMatchObject({ first_label: ADDED_LABEL, last_label: ADDED_LABEL, retired_label: null });
    expect(await bookkeeping("subunits", addedSubunit)).toMatchObject({ first_label: ADDED_LABEL, last_label: ADDED_LABEL, retired_label: null });
    expect((await profile(addedOrganization)).found).toBe(true);
    await client.query("rollback to savepoint added_rows");
    await client.query("release savepoint added_rows");
    expect(await releases()).toEqual([{ label: LABEL, status: "active" }, { label: NEXT_LABEL, status: "staged" }]);
  });

  it("keeps an uncommitted activation invisible to a second connection, whose own activation waits on the activation lock", async () => {
    const peer = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "union-catalog-proof-peer",
    });
    await peer.connect();
    try {
      await peer.query("begin");
      await peer.query("set local lock_timeout = '1s'");
      await peer.query("set local statement_timeout = '20s'");
      await peer.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
      await peer.query("set local role anon");
      // This connection activated the first release in a transaction it has
      // not committed: the peer still sees no release at all.
      const { rows: [peerStatus] } = await peer.query("select public.get_union_catalog_status() as value");
      expect(peerStatus.value).toEqual({ available: false, releaseLabel: null, releasedOn: null, dataAsOf: null, counts: null });
      const { rows: [peerSearch] } = await peer.query("select public.search_union_catalog('Exampleville', null, null, null, 1) as value");
      expect(peerSearch.value.rows.map((row) => row.key)).not.toContain(LOCAL_KEY);
      await peer.query("reset role");
      // The advisory lock that activation holds to commit makes a concurrent
      // activation wait; with a lock timeout it gives up (55P03).
      await expect(peer.query("select private.catalog_activate_release($1)", [NEXT_LABEL])).rejects.toMatchObject({ code: "55P03" });
      await peer.query("rollback");
    } finally {
      await peer.end();
    }
    expect((await status()).releaseLabel).toBe(LABEL);
  });
});

// REQ-UG-CATALOG-DIRECTORY-LISTED-BODIES-WITHOUT-FEDERAL-FILE-20261111:
// a release that adds a fictional directory-listed body (no federal file
// number) on top of the fixture release loads, verifies and activates with
// public.organizations unchanged and nothing retired; the body is found by
// name and by profile with no file number, no registry link, its dated
// source and its parent filer; none of the staff, officer or person contact
// fields it carried reaches a staged row, a live row or an RPC answer. Its own
// transaction, rolled back like the one above.
live("union catalog directory-listed bodies on a disposable database", () => {
  const BODY_NAME = "Example Directory Listed Council 31";
  const BODY_KEY = directoryBodyKey(900000002, BODY_NAME);
  const BODY_SOURCE = "https://testfamily.example/directory/councils";
  const SENTINELS = ["SENTINEL-DIRECTORY-STAFF", "SENTINEL-DIRECTORY-ADDRESS", "Finley Fixtureperson", "finley@exampleworkers1.example", "802-555-0111"];
  const exclusions = exclusionList();
  const workdirs = [];
  let client;
  let base;
  let withBody;
  let organizationsBefore;
  let diff;

  function build(label, bodies) {
    const workdir = mkdtempSync(join(process.env.UNION_CATALOG_PROOF_TMP_ROOT || process.env.CI_DB_TEMP_ROOT || tmpdir(), "union-catalog-directory-db-"));
    workdirs.push(workdir);
    const fixture = baseFixture();
    const snapshot = join(workdir, "snapshot");
    mkdirSync(join(snapshot, "build"), { recursive: true });
    mkdirSync(join(snapshot, "documents"), { recursive: true });
    writeFileSync(join(snapshot, "build", "enriched.json"), JSON.stringify(fixture.enriched));
    writeFileSync(join(snapshot, "build", "source-data.json"), JSON.stringify({ "index-data.json": { records: fixture.ledger } }));
    writeFileSync(join(snapshot, "documents", "index.json"), JSON.stringify({ generated: null, documents: fixture.documents }));
    if (bodies) {
      mkdirSync(join(snapshot, "directory"), { recursive: true });
      writeFileSync(join(snapshot, "directory", "listed-bodies.json"), JSON.stringify({ schema: DIRECTORY_BODIES_SCHEMA, held: { registry_match: 1 }, bodies }));
    }
    const exclusionsFile = join(workdir, "catalog-exclusions.json");
    writeFileSync(exclusionsFile, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: [] }));
    const out = join(workdir, "release");
    exportRelease({ sourceDir: snapshot, outDir: out, label, env: { CATALOG_EXCLUSIONS_FILE: exclusionsFile } });
    return readRelease(out);
  }

  const anon = async (sql, params) => {
    await client.query("savepoint directory_probe");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await client.query("set local role anon");
    const { rows: [row] } = await client.query(sql, params);
    await client.query("reset role");
    await client.query("release savepoint directory_probe");
    return row.value;
  };

  beforeAll(async () => {
    base = build("20261111-01", null);
    withBody = build("20261112-01", [{
      id: "directory-31",
      name: BODY_NAME,
      family: "TESTFAM",
      tier: "regional",
      parentFileNumber: 900000002,
      city: "Exampleville",
      state: "VT",
      country: "US",
      website: null,
      sources: [{ url: BODY_SOURCE, asOf: "2026-09-24" }],
      staff: [{ name: SENTINELS[2], email: SENTINELS[3], phone: SENTINELS[4], title: SENTINELS[0] }],
      address: SENTINELS[1],
    }]);
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "union-catalog-directory-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    const { rows: [loaded] } = await client.query("select count(*)::integer as releases from private.catalog_releases");
    if (loaded.releases !== 0) throw new Error("the directory-listed body proof needs a stack with no catalog release loaded");
    organizationsBefore = (await client.query("select count(*)::integer as n from public.organizations")).rows[0].n;
    await loadRelease({ client, ...base, exclusions });
    expect((await verifyRelease({ client, ...base, exclusions })).problems).toEqual([]);
    await activateRelease({ client, label: "20261111-01" });
  }, 120000);

  afterAll(async () => {
    if (client) {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
    for (const workdir of workdirs) rmSync(workdir, { recursive: true, force: true });
  });

  it("stages the release with the body, verifies it, and keeps every staged row free of the body's person fields", async () => {
    const summary = await loadRelease({ client, ...withBody, exclusions });
    expect(summary.staged.organizations).toBe(base.release.organizations.length + 1);
    const report = await verifyRelease({ client, ...withBody, exclusions });
    expect(report.problems, formatVerify(report).join("\n")).toEqual([]);
    const { rows } = await client.query(
      "select s.row_key || ' ' || s.content::text as content from private.catalog_staging s join private.catalog_releases r on r.id = s.release_id where r.label = $1",
      ["20261112-01"],
    );
    const staged = rows.map((row) => row.content).join("\n");
    expect(staged).toContain(BODY_KEY);
    for (const value of SENTINELS) expect(staged).not.toContain(value);
  });

  it("activates with public.organizations unchanged and nothing retired; search and profile return the body as a directory listing", async () => {
    diff = await activateRelease({ client, label: "20261112-01" });
    expect(diff).toMatchObject({
      organizationsAdded: 1,
      organizationsRetired: 0,
      subunitsRetired: 0,
      tenantOrganizationsBefore: organizationsBefore,
      tenantOrganizationsAfter: organizationsBefore,
    });
    expect((await client.query("select count(*)::integer as n from public.organizations")).rows[0].n).toBe(organizationsBefore);
    const { rows: [retired] } = await client.query(
      "select count(*)::integer as n from private.catalog_organizations where retired_release_id is not null",
    );
    expect(retired.n).toBe(0);

    const found = await anon("select public.search_union_catalog($1, null, null, null, 1) as value", ["Directory Listed Council"]);
    expect(found.rows.map((row) => row.key)).toContain(BODY_KEY);
    expect(found.rows.find((row) => row.key === BODY_KEY)).toMatchObject({ registryOnly: false, registryId: null });

    const answer = await anon("select public.get_union_catalog_profile($1) as value", [BODY_KEY]);
    expect(answer).toMatchObject({
      found: true,
      organization: { key: BODY_KEY, name: BODY_NAME, olmsFileNumber: null, registryId: null, confidence: "unreviewed", researchedOn: "2026-09-24", state: "VT" },
    });
    expect(answer.parents).toEqual([expect.objectContaining({ childKey: BODY_KEY, parentKey: "olms-900000002", edgeKind: "parent_body", certainty: "confirmed" })]);
    const text = JSON.stringify([found, answer]);
    for (const value of SENTINELS) expect(text).not.toContain(value);
  });
});
