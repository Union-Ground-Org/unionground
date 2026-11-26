// @vitest-environment node
//
// REQ-UG-UNION-CATALOG-RESEARCH-EXPORT-TRANSLATOR-20261012: the research
// export translator (scripts/union-catalog/translate-research-export.mjs)
// builds a complete union-catalog-release/1 snapshot from the research
// export: the seven content tables of the pinned base release unchanged, plus
// research_facts and research_categories under catalog keys only, with
// loc-/irs- records held out. The export is union-directory-research-export/1,
// the contract the research lane published with batch A89. It refuses, as a whole, any export carrying a
// person-shaped or packet-text field, an email, phone, election source or
// exclusion-list match, or a schema it does not know; and the loader's plan
// proves a research release retires nothing it does not withdraw on purpose.
// Every fixture is fictional.
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELEASE_COLUMNS,
  assertReleaseColumns,
  formatPlan,
  planRelease,
  readRelease,
  releaseCounts as currentReleaseCounts,
  runPlan,
  unintendedRetirement,
} from "../scripts/load-union-catalog.mjs";
import { CONTENT_TABLES, releaseViolations, rowViolations } from "../scripts/union-catalog/catalog-shape.mjs";
import { assertReleasePrivacy, exclusionHashes, releaseCounts } from "../scripts/union-catalog/privacy-filter.mjs";
import {
  HELD_FILE,
  researchCategoryKey,
  researchFactKey,
  translateResearchExport,
} from "../scripts/union-catalog/translate-research-export.mjs";
import { TEST_SALT } from "./helpers/union-catalog-fixture.mjs";
import { addAmericasSnapshot, combinedAmericasRelease, exportKey, fixtureLocale } from "./helpers/union-catalog-americas-fixture.mjs";
import {
  BASE_LABEL,
  POISON,
  RESEARCH_LABEL,
  UR_PARENT,
  body,
  candidates,
  defaultStreams,
  fact,
  inventoryOf,
  rid,
  target,
  writeBaseRelease,
  writeResearchExport,
} from "./helpers/union-catalog-research-fixture.mjs";

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function workdir() {
  const dir = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), "union-catalog-research-"));
  dirs.push(dir);
  return dir;
}

/** A base release, an export and a translation; `streams` and `options` shape the export. */
function translate({ streams = defaultStreams(), exportOptions = {}, label = RESEARCH_LABEL, baseSha = null, exclusionValues = [], baseMutate } = {}) {
  const root = workdir();
  const base = writeBaseRelease(root, { exclusionHashes: exclusionValues.flatMap((v) => exclusionHashes(TEST_SALT, v)), mutate: baseMutate });
  const exportDir = writeResearchExport(join(root, "export"), streams, exportOptions);
  const outDir = join(root, `out-${label}`);
  const run = () => translateResearchExport({
    exportDir,
    baseDir: base.dir,
    baseSha256: baseSha ?? base.manifest.artifact.sha256,
    outDir,
    label,
    env: { CATALOG_EXCLUSIONS_FILE: base.exclusionsFile },
  });
  return { root, base, exportDir, outDir, run };
}

const releaseOf = (dir) => JSON.parse(gunzipSync(readFileSync(join(dir, "catalog-release.json.gz"))).toString("utf8"));

describe("research export translator", () => {
  it("preserves an accepted numeric registry identifier when translating a later research release", () => {
    const t = translate();
    const base = readRelease(t.base.dir);
    const identifier = combinedAmericasRelease(base).release.identifiers[0];
    identifier.catalog_key = base.release.organizations.find((row) => row.duplicate_of === null).catalog_key;
    identifier.identifier = "8025550100";
    base.release.identifiers = [identifier];
    const json = Buffer.from(JSON.stringify(base.release));
    const artifact = gzipSync(json);
    const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
    Object.assign(t.base.manifest.artifact, { sha256: sha(artifact), jsonSha256: sha(json), bytes: artifact.length });
    t.base.manifest.counts = currentReleaseCounts(base.release);
    writeFileSync(join(t.base.dir, "catalog-release.json.gz"), artifact);
    writeFileSync(join(t.base.dir, "manifest.json"), JSON.stringify(t.base.manifest));
    t.run();
    expect(readRelease(t.outDir).release.identifiers).toEqual([identifier]);
  });

  it("retains validated locale through the JSONL allow-lists for facts and categories", () => {
    const streams = defaultStreams();
    Object.assign(streams.tier2[0], fixtureLocale("MX"));
    Object.assign(streams.tier3[0], fixtureLocale("CA"));
    const t = translate({ streams });
    const manifest = t.run();
    const release = releaseOf(t.outDir);
    expect(manifest.research.translator).toBe("research-translator/2");
    expect(release.research_facts.find((row) => row.fact_key === researchFactKey(rid("cba")))).toMatchObject(fixtureLocale("MX"));
    expect(release.research_categories.find((row) => row.catalog_key === streams.tier3[0].body_id)).toMatchObject(fixtureLocale("CA"));
  });

  it.each([{ country: "ZZ" }, { country: 42 }, { subdivision: "CA-ZZ" }, { language: "es_XX" }, { timezone: "America/Invented" }])("refuses malformed research locale before output: %j", (patch) => {
    const streams = defaultStreams();
    Object.assign(streams.tier2[0], fixtureLocale("CA"), patch);
    const t = translate({ streams });
    expect(t.run).toThrow(/invalid research locale/);
    expect(existsSync(t.outDir)).toBe(false);
  });

  it("builds a complete snapshot: the base's seven tables unchanged plus the two research tables under catalog keys only", () => {
    const t = translate();
    const manifest = t.run();
    const release = releaseOf(t.outDir);
    const base = readRelease(t.base.dir);
    for (const table of CONTENT_TABLES) expect(release[table], table).toEqual(base.release[table]);
    expect(release.label).toBe(RESEARCH_LABEL);
    expect(release.filterVersion).toBe(base.manifest.filterVersion);
    expect(releaseViolations(release)).toEqual([]);

    const facts = new Map(release.research_facts.map((row) => [row.fact_key, row]));
    expect(facts.size).toBe(3);
    // The nested body names the subject; export v1 carries no title.
    const bound = facts.get(researchFactKey(rid("cba")));
    expect(bound).toMatchObject({
      evidence_tier: 2, binding: "bound", catalog_key: "olms-900000001", fact_kind: "contract", title: null,
      url: "https://exampleworkers1.example/files/cba-2026.pdf", url_host: "exampleworkers1.example", as_of: "2026-09-30", unresolved: [],
    });
    const candidate = facts.get(researchFactKey(rid("grievance-form")));
    expect(candidate).toMatchObject({
      evidence_tier: 1, binding: "unconfirmed", catalog_key: null, fact_kind: "grievance",
      publisher_candidates: ["olms-900000001", "olms-900000002"], unresolved: [UR_PARENT],
    });
    // A duplicate filer and an irs- body are never candidates in the release;
    // an http source is carried as it is.
    expect(facts.get(researchFactKey(rid("constitution")))).toMatchObject({
      publisher_candidates: ["olms-900000002"], url: "http://testfamily.example/constitution", as_of: null,
    });
    for (const row of release.research_facts) expect(Object.keys(row).sort()).toEqual([...RELEASE_COLUMNS.research_facts].sort());

    expect(release.research_categories.map((row) => [row.catalog_key, row.category, row.outcome, row.evidence_tier, row.evaluated_on])).toEqual(
      expect.arrayContaining([
        ["olms-900000001", "contracts", "captured_publication", 3, "2026-10-12"],
        ["olms-900000002", "governing_documents", "checked_not_published", 3, "2026-10-12"],
      ]),
    );
    expect(release.research_categories).toHaveLength(2);
    expect(release.research_categories.map((row) => row.category_key)).toContain(researchCategoryKey(`${target("olms-900000001")}|contracts`));

    // The public dataAsOf stays the base's: only the research rows are new.
    expect(manifest.sourceBuiltAt).toBe(t.base.manifest.sourceBuiltAt);
    expect(release.sourceBuiltAt).toBe(t.base.manifest.sourceBuiltAt);
    expect(manifest.research.exportWrittenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.counts).toEqual(releaseCounts(release));
    expect(manifest.counts).toMatchObject({ research_facts: 3, research_facts_by_tier: { 1: 1, 2: 2 }, research_facts_bound: 1, research_categories: 2 });
    expect(manifest.research).toMatchObject({
      exportSchema: "union-directory-research-export/1",
      exportBatch: "F01-fixture",
      base: { label: BASE_LABEL, artifactSha256: t.base.manifest.artifact.sha256 },
      heldOut: { research_facts: 2, research_categories: 1 },
      withdrawn: { research_facts: [researchFactKey(rid("old-form"))], research_categories: [] },
      gateContract: "usability_contract_v5.category_gate",
    });
    expect(manifest.dropReport).toMatchObject({
      "research_facts:held_loc_body": 1, "research_facts:held_irs_body": 1, "research_categories:held_loc_body": 1,
    });

    // loc- and irs- records are held out beside the release, never in it.
    const held = JSON.parse(readFileSync(join(t.outDir, HELD_FILE), "utf8"));
    expect(held.research_facts.map((row) => [row.body_id, row.held_reason])).toEqual(
      expect.arrayContaining([["loc-fixture01", "loc_body"], [null, "irs_body"]]),
    );
    expect(held.research_categories.map((row) => row.body_id)).toEqual(["loc-fixture01"]);
    const releaseText = JSON.stringify(release);
    for (const id of ["loc-fixture01", "irs-fixture02", "irs-fixture77", rid("cba"), "registry.example", "exact_OLMS_filer_address"]) {
      expect(releaseText).not.toContain(id);
    }

    // The loader reads it like any release, and plan against the base proves
    // nothing retires.
    const report = planRelease(readRelease(t.outDir), { previousRelease: base.release });
    expect(report.retirement.total).toBe(0);
    expect(report.rows).toMatchObject({ research_facts: 3, research_categories: 2 });
    const text = formatPlan(report).join("\n");
    expect(text).toContain(`research release on base ${BASE_LABEL}`);
    expect(text).toMatch(/^ {2}research_facts +retired 0, withdrawn on purpose 0, unintended 0$/m);
    expect(text).not.toContain("exampleworkers1.example/forms");
  }, 60_000);

  it("refuses a poisoned export carrying a person's name and email, at any depth, and writes nothing", () => {
    const streams = defaultStreams();
    streams.tier2.push(fact("poison", { name: POISON.name, email: POISON.email }));
    const t = translate({ streams });
    expect(t.run).toThrow(/privacy: tier2-facts\.jsonl record 4 carries a forbidden name field/);
    expect(() => readFileSync(join(t.outDir, "manifest.json"))).toThrow();

    const nested = defaultStreams();
    nested.tier2[0].body.holder = POISON.name;
    expect(translate({ streams: nested }).run).toThrow(/privacy: tier2-facts\.jsonl record 1 carries a forbidden holder field/);
    const inCandidate = defaultStreams();
    inCandidate.tier1[0].publisher_candidates[0].phone = POISON.phone;
    expect(translate({ streams: inCandidate }).run).toThrow(/privacy: tier1-facts\.jsonl record 1 carries a forbidden phone field/);
  }, 60_000);

  it.each(["quote", "label", "value", "holder", "name", "email", "phone"])("refuses any record carrying a %s field", (field) => {
    const streams = defaultStreams();
    streams.tier3[0][field] = "x";
    const t = translate({ streams });
    expect(t.run).toThrow(new RegExp(`tier3-categories\\.jsonl record 1 carries a forbidden ${field} field`));
  });

  it("refuses a name through the exclusion list, and an email or phone pattern anywhere it is emitted", () => {
    const named = defaultStreams();
    named.tier2[0].source_url = "https://exampleworkers1.example/people/avery-fixtureperson.pdf";
    expect(translate({ streams: named, exclusionValues: [POISON.name] }).run).toThrow(/F9 research gate: research_facts\.url/);

    const emailed = defaultStreams();
    emailed.tier2[0].source_url = `https://exampleworkers1.example/contact/${POISON.email}`;
    expect(translate({ streams: emailed }).run).toThrow(/F8 privacy gate: research_facts\.url .* email or phone/);

    const phoned = defaultStreams();
    phoned.tier2[0].source_url = `https://exampleworkers1.example/call/${POISON.phone}`;
    expect(translate({ streams: phoned }).run).toThrow(/F8 privacy gate: research_facts\.url/);

    // The held-out sidecar passes the same gate.
    const heldOut = defaultStreams();
    heldOut.tier2[2].source_url = `https://localsite.example/ask/${POISON.email}`;
    expect(translate({ streams: heldOut }).run).toThrow(/F8 research gate: held research_facts\.url/);
  }, 60_000);

  it("refuses an election, candidate, ballot or nomination source, held out or not", () => {
    const url = defaultStreams();
    url.tier2[0].source_url = "https://exampleworkers1.example/2026-election/ballot.pdf";
    expect(translate({ streams: url }).run).toThrow(/F3 research gate: research_facts\.url/);
    const held = defaultStreams();
    held.tier1[1].source_url = "https://charity.example/nominations";
    expect(translate({ streams: held }).run).toThrow(/F3 research gate: held research_facts\.url/);
    // A held row's URL is percent-decoded first, as the release gate does.
    const encoded = defaultStreams();
    encoded.tier1[1].source_url = "https://charity.example/2026-%65lection/notice";
    expect(translate({ streams: encoded }).run).toThrow(/F3 research gate: held research_facts\.url/);
  }, 60_000);

  it("refuses before writing when a carried base value matches an exclusion added after the base was exported", () => {
    const t = translate();
    writeFileSync(t.base.exclusionsFile, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: exclusionHashes(TEST_SALT, "Example Workers Local 1") }));
    expect(t.run).toThrow(/F9 research gate: [1-9][0-9]* release value\(s\) match the exclusion list/);
    expect(existsSync(t.outDir)).toBe(false);
  }, 60_000);

  it("refuses an export schema it does not know, an unknown field, a role fact and a candidate posing as a subject", () => {
    expect(translate({ exportOptions: { manifest: { schema: "union-directory-research-export/draft-1" } } }).run)
      .toThrow(/export manifest schema is not one this translator knows/);
    expect(translate({ exportOptions: { manifest: { consumer_contract: { tier3_definition_locked: "usability_contract_v4.q9_gate" } } } }).run)
      .toThrow(/Tier 3 keeps its authorized definition/);
    const extra = defaultStreams();
    extra.tier2[0].incumbent = "x";
    expect(translate({ streams: extra }).run).toThrow(/tier2-facts\.jsonl record 1 carries incumbent, which the export schema does not define/);
    const role = defaultStreams();
    role.tier2[0].kind = "role";
    expect(translate({ streams: role }).run).toThrow(/tier2-facts\.jsonl record 1: kind is not one of/);
    const confirmed = defaultStreams();
    confirmed.tier1[0].publisher_candidates[0].binding = "bound";
    expect(translate({ streams: confirmed }).run).toThrow(/a publisher candidate is not marked unconfirmed/);
    const mappable = defaultStreams();
    mappable.tier2[2].body.catalog_key_mappable = true;
    expect(translate({ streams: mappable }).run).toThrow(/catalog_key_mappable does not match the body id/);
    // B05: a ug- catalog key is syntactically mappable; the legacy false is still read.
    for (const flag of [true, false]) {
      const ug = defaultStreams();
      ug.tier2[2].body = { ...body(exportKey("CA")), catalog_key_mappable: flag };
      ug.tier2[2].publisher_candidates = candidates(exportKey("CA"));
      const t = translate({ streams: ug, baseMutate: addAmericasSnapshot });
      t.run();
      expect(releaseOf(t.outDir).research_facts.some((row) => row.catalog_key === exportKey("CA")), String(flag)).toBe(true);
    }
    const ugTier3 = defaultStreams();
    ugTier3.tier3[2] = { ...ugTier3.tier3[2], body_id: "ug-exca000000", id_namespace: "ug", catalog_key_mappable: true };
    expect(translate({ streams: ugTier3 }).run).not.toThrow(/catalog_key_mappable/);
    const tiers = defaultStreams();
    tiers.tier2[0].unresolved_codes = [UR_PARENT];
    expect(translate({ streams: tiers }).run).toThrow(/a tier 2 fact carries an unresolved code/);
    const wrongStream = defaultStreams();
    wrongStream.tier2[0].evidence_tier = "research-t1";
    expect(translate({ streams: wrongStream }).run).toThrow(/evidence_tier is not research-t2, the tier of its stream/);
    const unknownCode = defaultStreams();
    unknownCode.tier1[0].unresolved_codes = ["ur-000000000000"];
    expect(translate({ streams: unknownCode }).run).toThrow(/codes the manifest's unresolved_legend defines/);
  }, 60_000);

  it("keeps a tier 1 fact with no unresolved code, as export v1 publishes them", () => {
    const streams = defaultStreams();
    streams.tier1[0].unresolved_codes = [];
    const t = translate({ streams });
    t.run();
    expect(releaseOf(t.outDir).research_facts.find((row) => row.fact_key === researchFactKey(rid("grievance-form"))))
      .toMatchObject({ evidence_tier: 1, unresolved: [] });
  }, 60_000);

  it("refuses a stream that does not match its manifest, a base that is not the pinned one, a reused label, a repeated record and an unreconciled inventory", () => {
    const streams = defaultStreams();
    const torn = translate({ streams, exportOptions: { files: { "tier2-facts.jsonl": `${JSON.stringify(streams.tier2[0])}\n` } } });
    expect(torn.run).toThrow(/tier2-facts\.jsonl does not match the sha256 its manifest declares/);
    expect(translate({ baseSha: "0".repeat(64) }).run).toThrow(/not the pinned one/);
    expect(translate({ label: BASE_LABEL }).run).toThrow(/must differ from the base release's label/);
    // The export's stable key must name one record: batch A89 repeated 480.
    const repeated = defaultStreams();
    repeated.tier1.push({ ...repeated.tier2[0], evidence_tier: "research-t1" });
    expect(translate({ streams: repeated, exportOptions: { inventory: inventoryOf(defaultStreams()) } }).run)
      .toThrow(/record_id repeats an earlier fact/);
    const contradictory = inventoryOf(defaultStreams()).map((row) => (row.record_id === rid("cba") ? { ...row, state: "withdrawn" } : row));
    expect(translate({ exportOptions: { inventory: contradictory } }).run).toThrow(/withdraws a fact the fact streams still list/);
    const twice = defaultStreams();
    twice.withdrawn.push(rid("cba"));
    expect(translate({ streams: twice }).run).toThrow(/record_id repeats an earlier inventory record/);
    const missing = defaultStreams();
    expect(translate({ streams: missing, exportOptions: { inventory: inventoryOf(missing).slice(1) } }).run)
      .toThrow(/the inventory lists 4 current records but the fact streams carry 5/);
  }, 60_000);

  it("plan refuses research tables without a research manifest block, and never reads a ug- candidate key as a phone", () => {
    const t = translate();
    t.run();
    const built = readRelease(t.outDir);
    const { research: _research, ...bare } = built.manifest;
    expect(() => planRelease({ manifest: bare, release: built.release })).toThrow(/carries research tables but its manifest has no research block/);
    const unpinned = { ...built.manifest, research: { ...built.manifest.research, base: { label: BASE_LABEL } } };
    expect(() => planRelease({ manifest: unpinned, release: built.release })).toThrow(/does not name its base release artifact/);
    const ug = structuredClone(built.release);
    ug.research_facts.find((row) => row.binding === "unconfirmed").publisher_candidates = ["ug-8025550102"];
    expect(() => assertReleasePrivacy(ug)).not.toThrow();
  }, 60_000);

  it("keeps keys stable across exports, and plan refuses a research release that drops a row it does not withdraw", () => {
    const t = translate();
    t.run();
    const first = readRelease(t.outDir);

    // A second export that silently drops the bound fact is a delta: refused.
    const dropped = defaultStreams();
    dropped.tier2.shift();
    const secondDir = writeResearchExport(join(t.root, "export-2"), dropped);
    const secondOut = join(t.root, "release-20261013-01");
    translateResearchExport({
      exportDir: secondDir, baseDir: t.base.dir, baseSha256: t.base.manifest.artifact.sha256, outDir: secondOut,
      label: "20261013-01", env: { CATALOG_EXCLUSIONS_FILE: t.base.exclusionsFile },
    });
    expect(() => planRelease(readRelease(secondOut), { previousRelease: first.release }))
      .toThrow(/must not retire a row it does not withdraw on purpose.*research_facts 1/);
    expect(() => runPlan({ release: secondOut, previous: null })).toThrow(/a research release needs --previous/);

    // The same drop with an inventory withdrawal passes, and is counted.
    const withdrawn = defaultStreams();
    const gone = withdrawn.tier2.shift();
    withdrawn.withdrawn.push(gone.record_id);
    const thirdDir = writeResearchExport(join(t.root, "export-3"), withdrawn);
    const thirdOut = join(t.root, "release-20261014-01");
    translateResearchExport({
      exportDir: thirdDir, baseDir: t.base.dir, baseSha256: t.base.manifest.artifact.sha256, outDir: thirdOut,
      label: "20261014-01", env: { CATALOG_EXCLUSIONS_FILE: t.base.exclusionsFile },
    });
    const report = planRelease(readRelease(thirdOut), { previousRelease: first.release });
    expect(report.retirement.tables.research_facts).toMatchObject({ retired: 1, withdrawn: 1, unintended: 0 });
    expect(report.retirement.total).toBe(0);

    // A content row missing against the previous release is never withdrawn on purpose.
    const shrunk = { ...first.release, edges: first.release.edges.slice(1) };
    expect(unintendedRetirement(first.release, shrunk, first.manifest).tables.edges.unintended).toBe(1);
  }, 60_000);

  it("withdraws a loaded fact the next export holds out, so plan against the active release retires only that row", () => {
    const t = translate();
    t.run();
    const first = readRelease(t.outDir);
    const loadedKey = researchFactKey(rid("cba"));
    expect(first.release.research_facts.map((row) => row.fact_key)).toContain(loadedKey);

    // The next export moves the loaded fact onto a body the base cannot map.
    const moved = defaultStreams();
    moved.tier2[0] = fact("cba", { body: body("loc-fixture02"), publisher_candidates: candidates("loc-fixture02") });
    const nextDir = writeResearchExport(join(t.root, "export-moved"), moved);
    const next = (label, previousDir) => {
      const outDir = join(t.root, `release-${label}`);
      const manifest = translateResearchExport({
        exportDir: nextDir, baseDir: t.base.dir, baseSha256: t.base.manifest.artifact.sha256, previousDir, outDir,
        label, env: { CATALOG_EXCLUSIONS_FILE: t.base.exclusionsFile },
      });
      return { manifest, release: readRelease(outDir) };
    };

    // Without the active release the translator cannot know the key was
    // loaded: the plan against it still refuses, as before.
    const blind = next("20261013-01", null);
    expect(blind.manifest.research.withdrawn.research_facts).toEqual([researchFactKey(rid("old-form"))]);
    expect(() => planRelease(blind.release, { previousRelease: first.release })).toThrow(/research_facts 1/);

    // With it, only the loaded key is withdrawn; held-out keys no release
    // loaded (the loc- bylaws, the irs- annual) stay off the list.
    const { manifest, release } = next("20261013-02", t.outDir);
    expect(release.release.research_facts.map((row) => row.fact_key)).not.toContain(loadedKey);
    expect(manifest.research.heldOut.research_facts).toBe(3);
    expect(manifest.research.withdrawn.research_facts).toEqual([researchFactKey(rid("old-form")), loadedKey].sort());
    const report = planRelease(release, { previousRelease: first.release });
    expect(report.retirement.tables.research_facts).toMatchObject({ retired: 1, withdrawn: 1, unintended: 0 });
    expect(report.retirement.total).toBe(0);

    // A base that is itself the research release teaches the same key.
    const fromResearchBase = translateResearchExport({
      exportDir: nextDir, baseDir: t.outDir, baseSha256: first.manifest.artifact.sha256, outDir: join(t.root, "release-20261013-03"),
      label: "20261013-03", env: { CATALOG_EXCLUSIONS_FILE: t.base.exclusionsFile },
    });
    expect(fromResearchBase.research.withdrawn.research_facts).toContain(loadedKey);
  }, 60_000);

  it("writes only outside a git repository, and the loader refuses an extra research column", () => {
    const t = translate();
    const inside = translate();
    expect(() => translateResearchExport({
      exportDir: inside.exportDir, baseDir: inside.base.dir, baseSha256: inside.base.manifest.artifact.sha256,
      outDir: join(process.cwd(), "tmp-research-release"), label: RESEARCH_LABEL, env: { CATALOG_EXCLUSIONS_FILE: inside.base.exclusionsFile },
    })).toThrow(/inside a git repository/);
    t.run();
    const { release } = readRelease(t.outDir);
    expect(() => assertReleaseColumns(release)).not.toThrow();
    release.research_facts[0].quote = "x";
    expect(() => assertReleaseColumns(release)).toThrow(/research_facts rf-[0-9a-f]{32} carries quote/);
    expect(() => assertReleasePrivacy(release)).toThrow(/research gate: research_facts rf-[0-9a-f]{32} carries a quote field/);
  }, 60_000);
});

describe("research export Eastern timestamps", () => {
  const invalid = [
    ["a positive offset crossing the Eastern date boundary", "2026-10-12T00:30:00+09:00"],
    ["a zero offset crossing the Eastern date boundary", "2026-10-12T00:30:00+00:00"],
    ["a daylight offset during standard time", "2026-01-15T12:00:00-04:00"],
    ["a standard offset during daylight time", "2026-07-15T12:00:00-05:00"],
    ["a clock time in the spring transition gap", "2026-03-08T02:30:00-05:00"],
    ["midnight normalized into the following day", "2026-10-12T24:00:00-04:00"],
    ["an impossible calendar date", "2026-02-30T12:00:00-05:00"],
    ["an impossible minute", "2026-10-12T12:60:00-04:00"],
  ];

  it.each(invalid)("refuses %s in written_at_et before writing a release", (_name, timestamp) => {
    const t = translate({ exportOptions: { manifest: { written_at_et: timestamp } } });

    expect(t.run).toThrow(/written_at_et is not an Eastern timestamp/);
    expect(existsSync(t.outDir)).toBe(false);
  });

  it.each(invalid)("refuses %s in fact as_of before writing a release", (_name, timestamp) => {
    const streams = defaultStreams();
    streams.tier2[0].as_of = timestamp;
    const t = translate({ streams });

    expect(t.run).toThrow(/as_of is not null or an Eastern timestamp/);
    expect(existsSync(t.outDir)).toBe(false);
  });

  it.each([
    "2026-01-15T00:00:00-05:00",
    "2026-07-15T23:59:59.123456-04:00",
    "2026-03-08T01:59:59.999999-05:00",
    "2026-03-08T03:00:00-04:00",
    "2026-11-01T01:30:00-04:00",
    "2026-11-01T01:30:00-05:00",
    "2026-10-12T00:00:00.000000-04:00",
  ])("preserves the Eastern date of valid timestamp %s", (timestamp) => {
    const streams = defaultStreams();
    streams.tier2[0].as_of = timestamp;
    const t = translate({ streams, exportOptions: { manifest: { written_at_et: timestamp } } });

    t.run();
    const release = releaseOf(t.outDir);
    const expected = timestamp.slice(0, 10);
    expect(release.research_facts.find(row => row.fact_key === researchFactKey(rid("cba"))).as_of).toBe(expected);
    expect(release.research_categories.map(row => row.evaluated_on)).toEqual([expected, expected]);
  });

  it("preserves a null fact date", () => {
    const streams = defaultStreams();
    streams.tier2[0].as_of = null;
    const t = translate({ streams });
    t.run();

    expect(releaseOf(t.outDir).research_facts.find(row => row.fact_key === researchFactKey(rid("cba"))).as_of).toBeNull();
  });
});

describe("research release row shapes", () => {
  const good = {
    fact_key: researchFactKey("x-fact-0001"), evidence_tier: 2, binding: "bound", catalog_key: "olms-900000001",
    publisher_candidates: [], fact_kind: "form", title: null, url: "https://a.example/f", url_host: "a.example",
    as_of: null, unresolved: [], source_sha256: "a".repeat(64),
  };

  it("pins the research_facts CHECKs in JavaScript", () => {
    expect(rowViolations("research_facts", good)).toEqual([]);
    expect(rowViolations("research_facts", { ...good, catalog_key: null })).toEqual(expect.arrayContaining([
      "catalog_key is set exactly when binding is bound", "an unbound fact names no publisher candidate",
    ]));
    expect(rowViolations("research_facts", { ...good, binding: "unconfirmed", catalog_key: null, publisher_candidates: ["loc-x1"] }))
      .toContain("publisher_candidates is not an array of at most 50 catalog keys");
    expect(rowViolations("research_facts", { ...good, evidence_tier: 1 })).toEqual([]);
    expect(rowViolations("research_facts", { ...good, unresolved: ["ur-62ec29b5e95e"] })).toContain("a tier 2 fact carries an unresolved reason");
    expect(rowViolations("research_facts", { ...good, evidence_tier: 1, unresolved: ["mentioned_local"] }))
      .toContain("unresolved is not an array of at most 10 ur-* codes");
    expect(rowViolations("research_facts", { ...good, evidence_tier: 3 })).toContain("evidence_tier is not 1 or 2");
    expect(rowViolations("research_facts", { ...good, url: "http://a.example/f" })).toEqual([]);
    expect(rowViolations("research_facts", { ...good, url: "ftp://a.example/f" })).toContain("url is not an http(s) URL");
    expect(rowViolations("research_facts", { ...good, fact_kind: "role" })).toEqual([expect.stringMatching(/^fact_kind "role" is not one of/)]);
  });

  it("pins the research_categories CHECKs in JavaScript", () => {
    const row = {
      category_key: researchCategoryKey("x-cat-0001"), catalog_key: "olms-900000001", evidence_tier: 3, category: "contracts",
      outcome: "captured_publication", gate_contract: "usability_contract_v5.category_gate", evaluated_on: "2026-10-09",
    };
    expect(rowViolations("research_categories", row)).toEqual([]);
    expect(rowViolations("research_categories", { ...row, evidence_tier: 2 })).toEqual(["evidence_tier is not 3"]);
    expect(rowViolations("research_categories", { ...row, gate_contract: "usability_contract_v4.q9_gate" })).toHaveLength(1);
    expect(rowViolations("research_categories", { ...row, outcome: "accepted" })).toHaveLength(1);
  });

  it("keeps a release without research tables exactly as it was: no research counts, no research rows", () => {
    const root = workdir();
    const base = writeBaseRelease(root);
    const { release, manifest } = readRelease(base.dir);
    expect(Object.hasOwn(release, "research_facts")).toBe(false);
    expect(Object.keys(manifest.counts).filter((key) => key.startsWith("research_"))).toEqual([]);
    expect(planRelease(readRelease(base.dir)).rows).not.toHaveProperty("research_facts");
  });
});
