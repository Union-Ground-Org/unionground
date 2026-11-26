// @vitest-environment node
//
// REQ-UG-UNION-CATALOG-RESEARCH-EXPORT-TRANSLATOR-20261012: the live half
// of the research release tables (20261012090000_union_catalog_research_tables).
// A research release built by translate-research-export.mjs loads, verifies
// and activates through the reviewed loader; its research rows land in
// private.catalog_research_facts and catalog_research_categories with their
// evidence tier, the base's content rows are unchanged, the tables grant
// nothing to any Data API role, the only read path is the operator-only
// draft RPC (each fact carries its tier and whether its subject is bound or a
// candidate), the loader refuses a research release that would retire a row
// it does not withdraw, and a release without research tables retires every
// live research row.
//
// Each case runs in one transaction that is rolled back. Every fixture is
// fictional: "Example ..." bodies, .example hosts, catalog file numbers
// 900000001 and up, and a fixture verifier at 50900700-....
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { activateRelease, loadRelease, readRelease, verifyRelease } from "../scripts/load-union-catalog.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { researchFactKey, translateResearchExport } from "../scripts/union-catalog/translate-research-export.mjs";
import { exclusionList } from "./helpers/union-catalog-fixture.mjs";
import { UR_PARENT, body, candidates, defaultStreams, fact, rid, writeBaseRelease, writeResearchExport } from "./helpers/union-catalog-research-fixture.mjs";

const TABLES = ["catalog_research_facts", "catalog_research_categories"];
const ROLES = ["anon", "authenticated", "service_role"];
const DRAFT = "public.get_union_catalog_research_draft($1, $2, $3, $4)";
const VERIFIER = "50900700-0000-4000-8000-000000000001";
const VERIFIER_SESSION = "50900800-0000-4000-8000-000000000001";
const LOCAL_KEY = "olms-900000001";
const NATIONAL_KEY = "olms-900000002";

const workdirs = [];
afterAll(() => {
  while (workdirs.length > 0) rmSync(workdirs.pop(), { recursive: true, force: true });
});

function workdir() {
  const dir = mkdtempSync(join(process.env.UNION_CATALOG_PROOF_TMP_ROOT || process.env.CI_DB_TEMP_ROOT || tmpdir(), "union-catalog-research-db-"));
  workdirs.push(dir);
  return dir;
}

/** A base release and a research release built on it, both as read by the loader. */
function releases(streams = defaultStreams(), { label = "20261012-01", root = workdir(), base = null, previousDir = null } = {}) {
  const baseRelease = base ?? writeBaseRelease(root);
  const exportDir = writeResearchExport(join(root, `export-${label}`), streams);
  const out = join(root, `out-${label}`);
  translateResearchExport({
    exportDir, baseDir: baseRelease.dir, baseSha256: baseRelease.manifest.artifact.sha256, previousDir, outDir: out, label,
    env: { CATALOG_EXCLUSIONS_FILE: baseRelease.exclusionsFile },
  });
  return { root, baseRelease, out, base: readRelease(baseRelease.dir), research: readRelease(out) };
}

async function withClient(run) {
  const c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await c.connect();
  await c.query("begin");
  try {
    await run(c);
  } finally {
    await c.query("rollback");
    await c.end();
  }
}

// One statement as `role` with matching JWT claims, inside a savepoint so an
// expected refusal leaves the outer transaction usable.
async function as(c, role, sql, params = []) {
  await c.query("savepoint research_probe");
  try {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role })]);
    await c.query(`set local role ${role}`);
    const result = await c.query(sql, params);
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
    await c.query("release savepoint research_probe");
    return { ok: true, rows: result.rows };
  } catch (error) {
    await c.query("rollback to savepoint research_probe");
    await c.query("release savepoint research_probe");
    await c.query("reset role");
    return { ok: false, code: error.code, message: error.message };
  }
}

async function draft(c, catalogKey, page = 1, operator = VERIFIER, session = VERIFIER_SESSION) {
  const result = await as(c, "service_role", `select ${DRAFT} as value`, [operator, catalogKey, page, session]);
  if (!result.ok) return result;
  return { ok: true, value: result.rows[0].value };
}

async function verifier(c) {
  await c.query("insert into auth.users(id,email) values ($1,$2)", [VERIFIER, "verifier.research@fixture-verifier.example"]);
  const granted = await as(c, "service_role", "select public.set_platform_operator($1,$2,$3,$4) as value", [VERIFIER, true, "Fixture research verifier", randomUUID()]);
  expect(granted, granted.message).toMatchObject({ ok: true });
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), VERIFIER]);
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [VERIFIER_SESSION, VERIFIER]);
}

/** load, verify, activate: the loader's three steps, in the caller's transaction. */
async function publish(c, { release, manifest }) {
  await loadRelease({ client: c, release, manifest, exclusions: exclusionList() });
  const report = await verifyRelease({ client: c, release, manifest, exclusions: exclusionList() });
  expect(report.problems).toEqual([]);
  return activateRelease({ client: c, label: manifest.label });
}

const liveCount = async (c, table) => (await c.query(`select count(*)::integer as n from private.${table} where retired_release_id is null`)).rows[0].n;

const live = process.env.RUN_UNION_CATALOG_RESEARCH_DB_TESTS === "1" ? describe : describe.skip;

live("union catalog research release tables", () => {
  it("activates a research release: research rows land with their tier, and the base's content rows are untouched", async () => {
    const { base, research } = releases();
    await withClient(async (c) => {
      await publish(c, base);
      const status = async () => (await c.query("select public.get_union_catalog_status() as value")).rows[0].value;
      const baseStatus = await status();
      const contentBefore = (await c.query("select catalog_key, content_sha256, last_release_id from private.catalog_organizations order by 1")).rows;
      const diff = await publish(c, research);
      // The anonymous status keeps the base's data date and public counts:
      // no research rollup and no research load marker reaches it.
      const researchStatus = await status();
      expect(researchStatus).toMatchObject({ available: true, releaseLabel: "20261012-01", dataAsOf: baseStatus.dataAsOf, counts: baseStatus.counts });
      expect(JSON.stringify(researchStatus)).not.toMatch(/research/i);
      expect(diff).toMatchObject({
        organizationsAdded: 0, organizationsRetired: 0, organizationsChanged: 0, subunitsAdded: 0, subunitsRetired: 0,
        researchFactsAdded: 3, researchFactsRetired: 0, researchCategoriesAdded: 2, researchCategoriesRetired: 0,
      });
      expect((await c.query("select catalog_key, content_sha256, last_release_id from private.catalog_organizations order by 1")).rows).toEqual(contentBefore);
      const facts = (await c.query("select fact_key, evidence_tier, binding, catalog_key, publisher_candidates, unresolved from private.catalog_research_facts order by fact_key")).rows;
      expect(facts).toHaveLength(3);
      expect(facts.find((row) => row.fact_key === researchFactKey(rid("cba"))))
        .toMatchObject({ evidence_tier: 2, binding: "bound", catalog_key: LOCAL_KEY, unresolved: [] });
      expect(facts.filter((row) => row.binding === "unconfirmed").every((row) => row.catalog_key === null && row.publisher_candidates.length > 0)).toBe(true);
      expect((await c.query("select evidence_tier, gate_contract from private.catalog_research_categories")).rows)
        .toEqual(Array(2).fill({ evidence_tier: 3, gate_contract: "usability_contract_v5.category_gate" }));
      const statuses = (await c.query("select label, status from private.catalog_releases order by label")).rows;
      expect(statuses).toEqual([{ label: "20261001-01", status: "retired" }, { label: "20261012-01", status: "active" }]);
    });
  });

  it("grants nothing on the research tables to any Data API role, and keeps the draft RPC to a service-role operator", async () => {
    await withClient(async (c) => {
      for (const table of TABLES) {
        const { rows: [flags] } = await c.query(
          "select c.relrowsecurity as rls, c.relforcerowsecurity as forced, (select count(*)::integer from pg_policies p where p.schemaname = 'private' and p.tablename = c.relname) as policies from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'private' and c.relname = $1",
          [table],
        );
        expect(flags).toEqual({ rls: true, forced: true, policies: 0 });
        for (const role of ROLES) {
          const { rows: [grant] } = await c.query("select has_table_privilege($1, $2, 'select') as s, has_table_privilege($1, $2, 'insert') as i", [role, `private.${table}`]);
          expect(grant, `${role} on ${table}`).toEqual({ s: false, i: false });
        }
      }
      for (const role of ["anon", "authenticated"]) {
        const refused = await as(c, role, `select ${DRAFT} as value`, [VERIFIER, null, 1, VERIFIER_SESSION]);
        expect(refused, role).toMatchObject({ ok: false, code: "42501" });
      }
      // The service role alone, without an active operator, is refused.
      expect(await draft(c, null)).toMatchObject({ ok: false, code: "42501", message: "claim verifier required" });
      const { rows: [anonCatalog] } = await c.query("select has_function_privilege('anon', 'public.get_union_catalog_profile(text)', 'execute') as e");
      expect(anonCatalog.e).toBe(true);
      // The public profile RPC never reads a research table.
      const { rows: [profile] } = await c.query("select pg_get_functiondef('public.get_union_catalog_profile(text)'::regprocedure) as def");
      expect(profile.def).not.toContain("catalog_research");
    });
  });

  it("serves the operator draft view: organizations by tier, and each fact's tier and bound-or-candidate subject", async () => {
    const { base, research } = releases();
    await withClient(async (c) => {
      await publish(c, base);
      await publish(c, research);
      await verifier(c);
      const list = await draft(c, null);
      expect(list.ok, list.message).toBe(true);
      expect(list.value.releaseLabel).toBe("20261012-01");
      const byKey = new Map(list.value.organizations.map((row) => [row.catalogKey, row]));
      expect(byKey.get(LOCAL_KEY)).toMatchObject({ tier1: 0, tier2: 1, unconfirmed: 1, categories: 1 });
      expect(byKey.get(NATIONAL_KEY)).toMatchObject({ tier1: 0, tier2: 0, unconfirmed: 2, categories: 1 });
      expect(byKey.has("olms-900000004")).toBe(false);
      // A bound fact's leftover candidates do not list an organization.
      await c.query("update private.catalog_research_facts set publisher_candidates = array['olms-900000003'] where binding = 'bound'");
      expect((await draft(c, null)).value.organizations.map((row) => row.catalogKey)).not.toContain("olms-900000003");

      const local = await draft(c, LOCAL_KEY);
      expect(local.value.organization).toMatchObject({ catalogKey: LOCAL_KEY, level: "local" });
      expect(local.value.facts.map((fact) => [fact.evidenceTier, fact.subject, fact.kind])).toEqual([
        [2, "bound", "contract"],
        [1, "candidate", "grievance"],
      ]);
      expect(local.value.facts[0]).toMatchObject({ title: null, asOf: "2026-09-30" });
      expect(local.value.facts[1]).toMatchObject({ otherCandidates: 1, unresolved: [UR_PARENT] });
      expect(local.value.categories).toEqual([expect.objectContaining({ evidenceTier: 3, category: "contracts", outcome: "captured_publication", evaluatedOn: "2026-10-12" })]);
      const json = JSON.stringify([list.value, local.value]);
      for (const value of ["loc-fixture01", "irs-fixture02", "source_sha256", rid("cba")]) expect(json).not.toContain(value);

      expect(await draft(c, "loc-fixture01")).toMatchObject({ ok: false, code: "22023" });
      expect(await draft(c, "olms-900000004")).toMatchObject({ ok: false, code: "22023" });
      expect(await draft(c, null, 2001)).toMatchObject({ ok: false, code: "22023" });
      // A session that has not stepped up is refused.
      await c.query("update auth.sessions set aal = 'aal1' where id = $1", [VERIFIER_SESSION]);
      expect(await draft(c, null)).toMatchObject({ ok: false, code: "42501" });
    });
  });

  it("refuses at load a research release that would retire a row it does not withdraw, and accepts the withdrawn one", async () => {
    const first = releases();
    const dropped = defaultStreams();
    const gone = dropped.tier2.shift();
    const silent = releases(dropped, { label: "20261013-01", root: first.root, base: first.baseRelease });
    const declared = defaultStreams();
    declared.tier2.shift();
    declared.withdrawn.push(gone.record_id);
    const withdrawn = releases(declared, { label: "20261014-01", root: first.root, base: first.baseRelease });
    await withClient(async (c) => {
      await publish(c, first.base);
      await publish(c, first.research);
      const refusal = await loadRelease({ client: c, ...silent.research, exclusions: exclusionList() }).then(() => null, (error) => error);
      expect(refusal?.message).toMatch(/must not retire a row it does not withdraw on purpose, but against the live catalog it would retire: research_facts 1/);
    });
    await withClient(async (c) => {
      await publish(c, first.base);
      await publish(c, first.research);
      const diff = await publish(c, withdrawn.research);
      expect(diff).toMatchObject({ researchFactsAdded: 0, researchFactsRetired: 1, organizationsRetired: 0 });
      expect(await liveCount(c, "catalog_research_facts")).toBe(2);
      const { rows: [row] } = await c.query("select retired_release_id is not null as retired from private.catalog_research_facts where fact_key = $1", [researchFactKey(gone.record_id)]);
      expect(row.retired).toBe(true);
    });
  });

  it("loads a release that holds out a fact the active release loaded, retiring only that row, without a base reset", async () => {
    const first = releases();
    const moved = defaultStreams();
    moved.tier2[0] = fact("cba", { body: body("loc-fixture02"), publisher_candidates: candidates("loc-fixture02") });
    const next = releases(moved, { label: "20261013-01", root: first.root, base: first.baseRelease, previousDir: first.out });
    await withClient(async (c) => {
      await publish(c, first.base);
      await publish(c, first.research);
      const diff = await publish(c, next.research);
      expect(diff).toMatchObject({ researchFactsAdded: 0, researchFactsRetired: 1, organizationsRetired: 0 });
      expect(await liveCount(c, "catalog_research_facts")).toBe(2);
      const { rows: [row] } = await c.query("select retired_release_id is not null as retired from private.catalog_research_facts where fact_key = $1", [researchFactKey(rid("cba"))]);
      expect(row.retired).toBe(true);
    });
  });

  it("refuses a research release over any release but its base, and at activation once the active release changed since its load", async () => {
    const { root, base, research } = releases();
    const other = readRelease(writeBaseRelease(root, { label: "20261015-01" }).dir);
    await withClient(async (c) => {
      const empty = await loadRelease({ client: c, ...research, exclusions: exclusionList() }).then(() => null, (error) => error);
      expect(empty?.message).toMatch(/no active release is neither that base nor a research release on it/);
      await publish(c, base);
      await publish(c, other);
      const stale = await loadRelease({ client: c, ...research, exclusions: exclusionList() }).then(() => null, (error) => error);
      expect(stale?.message).toMatch(/the active release 20261015-01 is neither that base nor a research release on it/);
    });
    await withClient(async (c) => {
      await publish(c, base);
      await loadRelease({ client: c, ...research, exclusions: exclusionList() });
      expect((await verifyRelease({ client: c, ...research, exclusions: exclusionList() })).problems).toEqual([]);
      // As if another release was activated and committed after this load.
      await c.query("update private.catalog_releases set research_loaded_over = gen_random_uuid() where label = $1", [research.manifest.label]);
      const moved = await activateRelease({ client: c, label: research.manifest.label }).then(() => null, (error) => error);
      expect(moved?.message).toBe("catalog research release was loaded over a release that is no longer active; load it again");
    });
  });

  it("rolls back to the retired research release, verified again, though it was loaded over an earlier release", async () => {
    const first = releases();
    const declared = defaultStreams();
    const gone = declared.tier2.shift();
    declared.withdrawn.push(gone.record_id);
    const second = releases(declared, { label: "20261014-01", root: first.root, base: first.baseRelease });
    await withClient(async (c) => {
      await publish(c, first.base);
      await publish(c, first.research);
      await publish(c, second.research);
      expect(await liveCount(c, "catalog_research_facts")).toBe(2);
      // first.research is retired, keeps its staging rows, and was loaded over the base.
      expect((await verifyRelease({ client: c, ...first.research, exclusions: exclusionList() })).problems).toEqual([]);
      const diff = await activateRelease({ client: c, label: first.research.manifest.label });
      expect(diff).toMatchObject({ researchFactsRetired: 0, organizationsRetired: 0 });
      expect(await liveCount(c, "catalog_research_facts")).toBe(3);
    });
  });

  it("retires every live research row when a release without research tables is activated, and the staging check knows both tables", async () => {
    const { root, baseRelease, base, research } = releases();
    const plain = writeBaseRelease(root, { label: "20261015-01" });
    await withClient(async (c) => {
      await publish(c, base);
      await publish(c, research);
      expect(await liveCount(c, "catalog_research_facts")).toBe(3);
      const diff = await publish(c, readRelease(plain.dir));
      expect(diff).toMatchObject({ organizationsRetired: 0, researchFactsRetired: 3, researchCategoriesRetired: 2 });
      expect(await liveCount(c, "catalog_research_facts")).toBe(0);
      expect(await liveCount(c, "catalog_research_categories")).toBe(0);
      const refused = await c.query("savepoint s").then(() => c.query(
        "insert into private.catalog_staging (release_id, table_name, row_key, content, content_sha256) select id, 'research_notes', 'x', '{}'::jsonb, repeat('0', 64) from private.catalog_releases limit 1",
      )).then(() => null, (error) => error);
      await c.query("rollback to savepoint s");
      expect(refused?.code).toBe("23514");
      expect(baseRelease.manifest.label).toBe("20261001-01");
    });
  });

  it("enforces the research CHECKs in the database: a bound fact names its subject, tiers carry or omit reasons, Tier 3 keeps its contract", async () => {
    const { base } = releases();
    await withClient(async (c) => {
      await publish(c, base);
      const { rows: [{ id }] } = await c.query("select id from private.catalog_releases where status = 'active'");
      const insert = async (columns) => {
        await c.query("savepoint chk");
        const error = await c.query(
          `insert into private.catalog_research_facts (fact_key, evidence_tier, binding, catalog_key, publisher_candidates, fact_kind, url, url_host, unresolved, source_sha256, first_release_id, last_release_id, content_sha256)
           values ($1, $2, $3, $4, $5, $6, $7, 'a.example', $8, repeat('a', 64), $9, $9, repeat('0', 64))`,
          [columns.key ?? `rf-${"1".repeat(32)}`, columns.tier ?? 2, columns.binding ?? "bound", columns.catalogKey === undefined ? LOCAL_KEY : columns.catalogKey,
            columns.candidates ?? [], columns.kind ?? "form", columns.url ?? "https://a.example/f", columns.unresolved ?? [], id],
        ).then(() => null, (e) => e);
        await c.query("rollback to savepoint chk");
        return error?.constraint ?? error?.code ?? null;
      };
      expect(await insert({})).toBeNull();
      expect(await insert({ catalogKey: null })).toBe("catalog_research_facts_bound_names_subject");
      expect(await insert({ binding: "unconfirmed", catalogKey: null })).toBe("catalog_research_facts_unbound_has_candidate");
      expect(await insert({ binding: "unconfirmed", catalogKey: null, candidates: ["loc-fixture01"] })).toBe("catalog_research_facts_publisher_candidates_check");
      // Export v1 publishes tier 1 facts with and without ur-* codes; tier 2 never carries one.
      expect(await insert({ tier: 1 })).toBeNull();
      expect(await insert({ tier: 1, unresolved: [UR_PARENT] })).toBeNull();
      expect(await insert({ unresolved: [UR_PARENT] })).toBe("catalog_research_facts_tier_reasons");
      expect(await insert({ tier: 1, unresolved: ["receipt_proof_held"] })).toBe("catalog_research_facts_unresolved_check");
      expect(await insert({ kind: "role" })).toBe("catalog_research_facts_fact_kind_check");
      expect(await insert({ url: "http://a.example/f" })).toBeNull();
      expect(await insert({ url: "ftp://a.example/f" })).toBe("catalog_research_facts_url_check");
      expect(await insert({ binding: "unconfirmed", catalogKey: null, candidates: Array.from({ length: 51 }, () => LOCAL_KEY) }))
        .toBe("catalog_research_facts_publisher_candidates_check");
      expect(await insert({ catalogKey: "olms-999999999" })).toBe("catalog_research_facts_catalog_key_fkey");
      await c.query("savepoint chk");
      const tier3 = await c.query(
        `insert into private.catalog_research_categories (category_key, catalog_key, evidence_tier, category, outcome, gate_contract, evaluated_on, first_release_id, last_release_id, content_sha256)
         values ($1, $2, 3, 'contracts', 'captured_publication', 'usability_contract_v4.q9_gate', '2026-10-09', $3, $3, repeat('0', 64))`,
        [`rc-${"2".repeat(32)}`, LOCAL_KEY, id],
      ).then(() => null, (e) => e);
      await c.query("rollback to savepoint chk");
      expect(tier3?.constraint).toBe("catalog_research_categories_gate_contract_check");
    });
  });
});
