// @vitest-environment node
//
// REQ-UG-CATALOG-DIRECTORY-LISTED-BODIES-WITHOUT-FEDERAL-FILE-20261111:
// catalog:export accepts a directory-listed body (no federal file number, a
// dated http(s) source and a parent filer) under a stable ug-d key, refuses a
// body or ledger record with neither, keeps every olms-N row and the id map
// exactly as they are without such bodies, applies the privacy gate to them
// unchanged, and catalog:plan passes the result. build-directory-snapshot.mjs
// fixes its inputs by sha256, copies the base snapshot unchanged and holds out
// the candidates the record names, with a count per reason. Every value here
// is fictional ("Example ..." bodies, .example domains, 555-01xx numbers).
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planRelease, readRelease } from "../scripts/load-union-catalog.mjs";
import { CATALOG_KEY_PATTERN } from "../scripts/union-catalog/catalog-shape.mjs";
import { DIRECTORY_INPUT_PATH, INPUT_PATHS, exportRelease, sha256 } from "../scripts/union-catalog/export-release.mjs";
import {
  DIRECTORY_BODIES_SCHEMA,
  DIRECTORY_BODY_NOTE,
  buildCatalogRelease,
  directoryBodyKey,
  projectDirectoryBodies,
} from "../scripts/union-catalog/privacy-filter.mjs";
import {
  HOLD_REASONS,
  buildDirectorySnapshot,
  placeOf,
  selectDirectoryBodies,
} from "../scripts/union-catalog/build-directory-snapshot.mjs";
import {
  FAMILY,
  LOCAL_ID,
  OLMS_KEY,
  PEOPLE,
  PERSON_EMAILS,
  PERSON_PHONES,
  TEST_SALT,
  baseFixture,
  filterOptions,
} from "./helpers/union-catalog-fixture.mjs";

const NATIONAL_FILE = 900000002;
const SOURCE = "https://testfamily.example/directory/councils";
const STAFF_SENTINELS = ["SENTINEL-DIRECTORY-STAFF", "SENTINEL-DIRECTORY-OFFICER", "SENTINEL-DIRECTORY-ADDRESS"];

/** A fictional directory-listed body, carrying person fields that must never be read. */
function directoryBody(overrides = {}) {
  return {
    id: "directory-1",
    name: "Example Workers Council 12",
    family: FAMILY,
    tier: "regional",
    parentFileNumber: NATIONAL_FILE,
    city: "Exampleville",
    state: "VT",
    country: "US",
    website: "https://examplecouncil12.example/",
    sources: [{ url: SOURCE, asOf: "2026-09-24", note: "SENTINEL-DIRECTORY-SOURCE-NOTE" }],
    staff: [{ name: PEOPLE.staff, email: PERSON_EMAILS[3], phone: PERSON_PHONES[3], title: STAFF_SENTINELS[0] }],
    people: [{ name: PEOPLE.president, role: STAFF_SENTINELS[1] }],
    leaders: [{ name: PEOPLE.chair, email: PERSON_EMAILS[1] }],
    email: PERSON_EMAILS[0],
    phone: PERSON_PHONES[0],
    address: STAFF_SENTINELS[2],
    ...overrides,
  };
}

function directoryInput(bodies, held = {}) {
  return projectDirectoryBodies({ schema: DIRECTORY_BODIES_SCHEMA, held, bodies });
}

function release(bodies, held = {}) {
  const input = directoryInput(bodies, held);
  return buildCatalogRelease({ ...filterOptions(baseFixture()), directoryBodies: input.bodies, directoryHeld: input.held });
}

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeSnapshot(snapshot, fixture, directory = null) {
  mkdirSync(join(snapshot, "build"), { recursive: true });
  mkdirSync(join(snapshot, "documents"), { recursive: true });
  writeFileSync(join(snapshot, "build", "enriched.json"), JSON.stringify(fixture.enriched));
  writeFileSync(join(snapshot, "build", "source-data.json"), JSON.stringify({ "index-data.json": { records: fixture.ledger, "contacts.json": { SENTINEL: PERSON_EMAILS[2] } } }));
  writeFileSync(join(snapshot, "documents", "index.json"), JSON.stringify({ generated: null, documents: fixture.documents }));
  if (directory) {
    mkdirSync(join(snapshot, "directory"), { recursive: true });
    writeFileSync(join(snapshot, DIRECTORY_INPUT_PATH), JSON.stringify(directory));
  }
}

function exclusionsFile(root) {
  const path = join(root, "catalog-exclusions.json");
  writeFileSync(path, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: [] }));
  return path;
}

describe("directory-listed body keys", () => {
  it("are ug-d and the first 9 hex of sha256 over the parent's file number and the name tokens, stable across respellings", () => {
    const expected = `ug-d${createHash("sha256").update(`directory-listed-body/1\u0000${NATIONAL_FILE}\u0000example workers council 12`).digest("hex").slice(0, 9)}`;
    expect(directoryBodyKey(NATIONAL_FILE, "Example Workers Council 12")).toBe(expected);
    expect(directoryBodyKey(NATIONAL_FILE, "  EXAMPLE workers, Council #12 ")).toBe(expected);
    expect(directoryBodyKey(NATIONAL_FILE + 1, "Example Workers Council 12")).not.toBe(expected);
    expect(expected).toMatch(CATALOG_KEY_PATTERN);
    expect(expected).toMatch(/^ug-d[0-9a-f]{9}$/);
  });
});

describe("catalog:export with directory-listed bodies", () => {
  it("exports a body with a dated source and a parent filer: no file number, unreviewed, sourced, with a parent_body edge", () => {
    const built = release([directoryBody()]);
    const key = directoryBodyKey(NATIONAL_FILE, "Example Workers Council 12");
    const org = built.release.organizations.find((o) => o.catalog_key === key);
    expect(org).toMatchObject({
      olms_file_number: null,
      union_org_id: null,
      origin: "research",
      name: "Example Workers Council 12",
      family: FAMILY,
      tier: "regional",
      city: "Exampleville",
      state: "VT",
      website: "https://examplecouncil12.example/",
      confidence: "unreviewed",
      researched_on: "2026-09-24",
      source_urls: [SOURCE],
      structure_note: DIRECTORY_BODY_NOTE,
      members_reported: null,
      members_fiscal_year: null,
      designation: null,
      local_number: null,
      duplicate_of: null,
    });
    expect(DIRECTORY_BODY_NOTE).not.toMatch(/\bfiles\b|\bfiled\b|\bfiling (?:body|organization)\b/i);
    expect(built.release.edges.filter((e) => e.child_key === key)).toEqual([expect.objectContaining({
      parent_key: OLMS_KEY.national, parent_label: null, edge_kind: "parent_body", certainty: "confirmed", source_url: SOURCE,
    })]);
    for (const table of ["subunits", "seat_outlines", "contacts", "documents"]) {
      expect(built.release[table].filter((row) => row.catalog_key === key)).toEqual([]);
    }
    expect(built.counts.organizations_without_file_number).toBe(1);
    expect(built.idMap).not.toHaveProperty("directory-1");
  });

  it("leaves every olms-N row, the id map and the counts of a release without such bodies exactly as they were", () => {
    const without = buildCatalogRelease(filterOptions(baseFixture()));
    const withBodies = release([directoryBody(), directoryBody({ id: "directory-2", name: "Example Workers State Council", tier: "state" })]);
    expect(withBodies.idMap).toEqual(without.idMap);
    const olmsOnly = (rel, table) => rel[table].filter((row) => !String(row.catalog_key ?? row.child_key).startsWith("ug-"));
    for (const table of ["organizations", "edges", "subunits", "seat_outlines", "contacts", "documents", "document_subunits"]) {
      expect(olmsOnly(withBodies.release, table)).toEqual(without.release[table]);
    }
    const { organizations_without_file_number: added, ...rest } = withBodies.counts;
    expect(added).toBe(2);
    expect(rest.organizations).toBe(without.counts.organizations + 2);
    expect(without.counts).not.toHaveProperty("organizations_without_file_number");
  });

  it("refuses a body with no dated http(s) source or no parent filer, and still refuses a ledger record with no file number", () => {
    const refusal = /Structural fault: directory-listed body directory-1 has no federal file number/;
    expect(() => release([directoryBody({ sources: [] })])).toThrow(refusal);
    expect(() => release([directoryBody({ sources: [{ url: SOURCE, asOf: "" }] })])).toThrow(refusal);
    expect(() => release([directoryBody({ sources: [{ url: "ftp://testfamily.example/list", asOf: "2026-09-24" }] })])).toThrow(refusal);
    expect(() => release([directoryBody({ parentFileNumber: null })])).toThrow(refusal);
    const fixture = baseFixture();
    fixture.ledger[LOCAL_ID].file = 0;
    expect(() => buildCatalogRelease(filterOptions(fixture))).toThrow(/ledger record 9001 has no positive integer OLMS file number/);
    expect(() => release([directoryBody(), directoryBody({ id: "directory-2", name: "EXAMPLE WORKERS COUNCIL 12" })])).toThrow(/catalog key collision ug-d/);
  });

  it("applies the privacy gate unchanged: no staff, officer, person contact or person-shaped value from a body reaches the release", () => {
    const built = release([
      directoryBody(),
      directoryBody({ id: "directory-3", name: "Example Council, call 802-555-0123" }),
      directoryBody({ id: "directory-4", name: "Example Workers Council 14", website: `https://examplecouncil14.example/${PERSON_PHONES[1]}` }),
      directoryBody({ id: "test-directory-5", name: "Example Test Council" }),
    ]);
    const text = JSON.stringify(built.release);
    for (const value of [...STAFF_SENTINELS, "SENTINEL-DIRECTORY-SOURCE-NOTE", PEOPLE.staff, PEOPLE.president, PEOPLE.chair, "Fixtureperson", ...PERSON_EMAILS, ...PERSON_PHONES, "555-0123"]) {
      expect(text).not.toContain(value);
    }
    expect(built.dropReport["organizations.name:contact_pattern"]).toBe(1);
    expect(built.dropReport["directory_bodies:name_unusable"]).toBe(1);
    expect(built.dropReport["organizations.website:contact_pattern"]).toBe(1);
    expect(built.release.organizations.find((o) => o.name === "Example Workers Council 14").website).toBeNull();
    // F11: a test- id is a fixture identity, refused before anything else.
    expect(built.dropReport["organizations:fixture_identity"]).toBe(1);
    expect(text).not.toContain("Example Test Council");
  });

  it("drops a body outside the United States, one whose parent is not exported, and one whose only source fails the gate, each counted", () => {
    const built = release([
      directoryBody({ id: "d-ca", name: "Example Canadian Council", country: "CA", state: null }),
      directoryBody({ id: "d-on", name: "Example Provincial Council", country: null, state: "ON" }),
      directoryBody({ id: "d-orphan", name: "Example Orphan Council", parentFileNumber: 900000099 }),
      directoryBody({ id: "d-src", name: "Example Unsourced Council", sources: [{ url: `https://testfamily.example/${PERSON_PHONES[2]}`, asOf: "2026-09-24" }] }),
      directoryBody({ id: "d-none", name: "Example Placeless Council", city: null, state: null, country: null }),
    ], { registry_match: 2, outside_united_states: 7 });
    expect(built.dropReport).toMatchObject({
      "directory_bodies:outside_united_states": 2,
      "directory_bodies:parent_not_exported": 1,
      "directory_bodies:no_usable_source": 1,
      "directory_bodies.held:registry_match": 2,
      "directory_bodies.held:outside_united_states": 7,
    });
    const names = built.release.organizations.map((o) => o.name);
    expect(names).toContain("Example Placeless Council");
    for (const name of ["Example Canadian Council", "Example Provincial Council", "Example Orphan Council", "Example Unsourced Council"]) {
      expect(names).not.toContain(name);
    }
    expect(built.release.organizations.find((o) => o.name === "Example Placeless Council")).toMatchObject({ state: null, city: null });
  });

  it("reads directory/listed-bodies.json from the snapshot, records its hash, and catalog:plan passes the release", () => {
    const root = tempDir("union-catalog-directory-");
    const snapshot = join(root, "snapshot");
    const directory = { schema: DIRECTORY_BODIES_SCHEMA, held: { registry_match: 2 }, bodies: [directoryBody()] };
    writeSnapshot(snapshot, baseFixture(), directory);
    const out = join(root, "release");
    const manifest = exportRelease({ sourceDir: snapshot, outDir: out, label: "20261112-01", env: { CATALOG_EXCLUSIONS_FILE: exclusionsFile(root) } });
    expect(manifest.inputs["directory/listed-bodies.json"]).toEqual({
      sha256: sha256(readFileSync(join(snapshot, DIRECTORY_INPUT_PATH))),
      bytes: readFileSync(join(snapshot, DIRECTORY_INPUT_PATH)).length,
      bodies: 1,
    });
    expect(manifest.dropReport["directory_bodies.held:registry_match"]).toBe(2);
    const plan = planRelease(readRelease(out));
    expect(plan.counts.organizations_without_file_number).toBe(1);
    expect(plan.rows.organizations).toBe(5);
    const artifact = readFileSync(join(out, "catalog-release.json.gz"));
    for (const value of [...STAFF_SENTINELS, PEOPLE.staff, ...PERSON_EMAILS]) expect(artifact.includes(Buffer.from(value))).toBe(false);

    // Without the file, the manifest has exactly the three inputs it always had.
    const plain = join(root, "plain");
    writeSnapshot(join(plain, "snapshot"), baseFixture());
    const plainManifest = exportRelease({ sourceDir: join(plain, "snapshot"), outDir: join(plain, "release"), label: "20261112-01", env: { CATALOG_EXCLUSIONS_FILE: exclusionsFile(root) } });
    expect(Object.keys(plainManifest.inputs)).toEqual(["build/enriched.json", "build/source-data.json", "documents/index.json"]);
    expect(plainManifest.counts).not.toHaveProperty("organizations_without_file_number");
  });

  it("refuses a malformed directory file instead of skipping it", () => {
    expect(() => projectDirectoryBodies({ schema: "other/1", bodies: [] })).toThrow(/is not union-catalog-directory-bodies\/1/);
    expect(() => projectDirectoryBodies({ schema: DIRECTORY_BODIES_SCHEMA, bodies: [{ name: "Example" }] })).toThrow(/body 0 has no id/);
    expect(() => projectDirectoryBodies({ schema: DIRECTORY_BODIES_SCHEMA, held: { "Bad Reason": 1 }, bodies: [] })).toThrow(/held counts/);
    const projected = projectDirectoryBodies({ schema: DIRECTORY_BODIES_SCHEMA, bodies: [directoryBody()] }).bodies[0];
    expect(Object.keys(projected).sort()).toEqual(["city", "country", "family", "id", "name", "parentFileNumber", "sources", "state", "tier", "website"]);
    expect(projected.sources).toEqual([{ url: SOURCE, asOf: "2026-09-24" }]);
  });
});

// ---------------------------------------------------------------- the snapshot builder

function candidate(overrides = {}) {
  return {
    ledgerId: 100001,
    name: "Example Workers District Council 4",
    family: FAMILY,
    label: "TESTFAM COUNCIL",
    level: 1,
    place: "Exampleville, VT",
    website: "https://examplecouncil4.example/",
    parentLedgerId: 9002,
    parentOlmsFile: NATIONAL_FILE,
    address: STAFF_SENTINELS[2],
    region: "VT",
    country: "US",
    sources: [{ url: SOURCE, asOf: "2026-09-24", note: "official directory" }],
    note: "Intermediate body listed on the official structure pages",
    staff: [{ name: PEOPLE.staff, phone: PERSON_PHONES[3] }],
    ...overrides,
  };
}

const BASE = { filerFiles: new Set([900000001, NATIONAL_FILE, 900000003, 900000004]), names: new Set(["example workers local 1"]) };
const REGISTRY = { rows: 1, keys: new Set([`${FAMILY}|77`]) };

describe("build-directory-snapshot candidate selection", () => {
  it("holds out each case the record names, counted under the first reason that applies, and lists the rest by key", () => {
    const { bodies, held } = selectDirectoryBodies([
      candidate(),
      candidate({ ledgerId: 100002, name: "Example Workers Local 77", label: "TESTFAM 77", level: 2 }),
      candidate({ ledgerId: 100003, name: "Example Workers Local 1 (EWL1)" }),
      candidate({ ledgerId: 100004, name: "Example Undated Council", sources: [{ url: SOURCE, asOf: "September 2026" }] }),
      candidate({ ledgerId: 100005, name: "Example Unlinked Council", sources: [{ url: "", asOf: "2026-09-24" }] }),
      candidate({ ledgerId: 100006, name: "Example Orphan Council", parentOlmsFile: 900000099 }),
      candidate({ ledgerId: 100007, name: "Example Canadian Council", country: "CA", region: "ON", place: "Exampletown, ON" }),
      candidate({ ledgerId: 100008, name: "Example Provincial Council", country: "unknown", region: null, place: "QC" }),
      candidate({ ledgerId: 100009, name: "Example National Member Union (ENMU)", label: "TESTDEPT MEMBER", level: 2 }),
      candidate({ ledgerId: 100010, name: "Example Twin Council" }),
      candidate({ ledgerId: 100011, name: "EXAMPLE TWIN COUNCIL" }),
      candidate({ ledgerId: 100012, name: "Example State Federation", label: "TESTFAM STATEFED", country: "unknown", region: null, place: "VT" }),
      candidate({ ledgerId: 100013, name: "Example Placeless Retiree Chapter", country: "unknown", region: null, place: "" }),
    ], { registry: REGISTRY, base: BASE });
    expect(Object.keys(held)).toEqual([...HOLD_REASONS]);
    expect(held).toEqual({
      registry_match: 1,
      catalog_name_match: 1,
      no_dated_source: 2,
      parent_not_in_base: 1,
      outside_united_states: 2,
      affiliated_national_union: 1,
      duplicate_listing: 2,
    });
    expect(bodies.map((b) => b.id).sort()).toEqual(["directory-100001", "directory-100012", "directory-100013"]);
    const keys = bodies.map((b) => directoryBodyKey(b.parentFileNumber, b.name));
    expect(keys).toEqual([...keys].sort());
    expect(bodies.find((b) => b.id === "directory-100001")).toEqual({
      id: "directory-100001",
      name: "Example Workers District Council 4",
      family: FAMILY,
      tier: "regional",
      parentFileNumber: NATIONAL_FILE,
      city: "Exampleville",
      state: "VT",
      country: "US",
      website: "https://examplecouncil4.example/",
      sources: [{ url: SOURCE, asOf: "2026-09-24" }],
    });
    expect(bodies.find((b) => b.id === "directory-100012")).toMatchObject({ tier: "state", state: "VT", city: null, country: "US" });
    expect(bodies.find((b) => b.id === "directory-100013")).toMatchObject({ tier: "regional", state: null, city: null, country: null });
    const text = JSON.stringify(bodies);
    for (const value of [STAFF_SENTINELS[2], PEOPLE.staff, PERSON_PHONES[3], "official directory", "Intermediate body"]) expect(text).not.toContain(value);
  });

  it("never gives a place outside the United States a U.S. state", () => {
    expect(placeOf({ place: "Exampleton, BC", region: "BC", country: "CA" })).toEqual({ outside: true, state: null, city: null });
    expect(placeOf({ place: "Exampleton, ON", region: null, country: "unknown" })).toEqual({ outside: true, state: null, city: null });
    expect(placeOf({ place: "Exampleton, XX", region: null, country: "US" })).toEqual({ outside: true, state: null, city: null });
    expect(placeOf({ place: "Exampleville, VT", region: "VT", country: "US" })).toEqual({ outside: false, state: "VT", city: "Exampleville" });
    expect(placeOf({ place: "Exampleville, NH", region: "VT", country: "US" })).toEqual({ outside: false, state: "VT", city: null });
  });
});

describe("build-directory-snapshot", () => {
  function baseRelease() {
    const root = tempDir("union-catalog-directory-base-");
    writeSnapshot(join(root, "base", "snapshot"), baseFixture());
    const old = new Date("2026-09-29T08:29:19.000Z");
    for (const relative of Object.values(INPUT_PATHS)) utimesSync(join(root, "base", "snapshot", relative), old, old);
    exportRelease({ sourceDir: join(root, "base", "snapshot"), outDir: join(root, "base"), label: "20261022-01", env: { CATALOG_EXCLUSIONS_FILE: exclusionsFile(root) } });
    const candidates = join(root, "candidates.jsonl");
    writeFileSync(candidates, `${[candidate(), candidate({ ledgerId: 100002, name: "Example Workers Local 77", label: "TESTFAM 77", level: 2 })].map((c) => JSON.stringify(c)).join("\n")}\n`);
    const registry = join(root, "registry.json");
    writeFileSync(registry, JSON.stringify([{ olms_file_number: 990000777, affiliation: FAMILY, local_number: "077", state: "VT" }]));
    return { root, base: join(root, "base"), candidates, registry, candidatesSha256: sha256(readFileSync(candidates)) };
  }

  it("copies the base inputs byte for byte with their mtimes, writes the bodies, and catalog:export and plan accept the snapshot", () => {
    const fx = baseRelease();
    const out = join(fx.root, "next");
    const result = buildDirectorySnapshot({ baseDir: fx.base, candidatesPath: fx.candidates, candidatesSha256: fx.candidatesSha256, registryPath: fx.registry, outDir: out });
    expect(result).toMatchObject({ candidates: 2, listed: 1, held: expect.objectContaining({ registry_match: 1 }) });
    for (const relative of Object.values(INPUT_PATHS)) {
      const from = join(fx.base, "snapshot", relative);
      const to = join(out, "snapshot", relative);
      expect(sha256(readFileSync(to))).toBe(sha256(readFileSync(from)));
      expect(statSync(to).mtimeMs).toBe(statSync(from).mtimeMs);
    }
    const written = readFileSync(join(out, "snapshot", DIRECTORY_INPUT_PATH));
    expect(sha256(written)).toBe(result.sha256);
    for (const value of [STAFF_SENTINELS[2], PEOPLE.staff, PERSON_PHONES[3], "Example Workers Local 77"]) expect(written.includes(Buffer.from(value))).toBe(false);

    const manifest = exportRelease({ sourceDir: join(out, "snapshot"), outDir: out, label: "20261112-01", env: { CATALOG_EXCLUSIONS_FILE: exclusionsFile(fx.root) } });
    const baseManifest = JSON.parse(readFileSync(join(fx.base, "manifest.json"), "utf8"));
    expect(manifest.sourceSha256).toBe(baseManifest.sourceSha256);
    expect(manifest.sourceBuiltAt).toBe(baseManifest.sourceBuiltAt);
    expect(manifest.dropReport["directory_bodies.held:registry_match"]).toBe(1);
    expect(readFileSync(join(out, "catalog-id-map.json"), "utf8").replace("20261112-01", "20261022-01"))
      .toBe(readFileSync(join(fx.base, "catalog-id-map.json"), "utf8"));
    const previous = readRelease(fx.base).release;
    const plan = planRelease(readRelease(out), { previousRelease: previous });
    expect(plan.comparison).toMatchObject({ organizationsAdded: 1, organizationsRetired: 0, subunitsRetired: 0 });
    expect(plan.retirement.total).toBe(0);
  });

  it("refuses inputs that do not match the sha256 they are fixed by, and a release directory written twice", () => {
    const fx = baseRelease();
    const args = { baseDir: fx.base, candidatesPath: fx.candidates, candidatesSha256: fx.candidatesSha256, registryPath: fx.registry };
    expect(() => buildDirectorySnapshot({ ...args, candidatesSha256: "0".repeat(64), outDir: join(fx.root, "a") })).toThrow(/candidates file does not match/);
    buildDirectorySnapshot({ ...args, outDir: join(fx.root, "b") });
    expect(() => buildDirectorySnapshot({ ...args, outDir: join(fx.root, "b") })).toThrow(/already exists/);
    writeFileSync(join(fx.base, "snapshot", "documents", "index.json"), JSON.stringify({ generated: null, documents: [] }));
    expect(() => buildDirectorySnapshot({ ...args, outDir: join(fx.root, "c") })).toThrow(/base snapshot documents\/index.json does not match/);
  });
});
