// @vitest-environment node
//
// The offline export of the public-record union catalog (spec 2026-09-24
// union catalog design §2.5): snapshot hashing, the F1 input boundary
// (including the contacts.json sentinel), the F9 fail-closed exclusion list,
// and the manifest's hashes and counts. Fixtures are fictional.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, appendFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseRecordViolations } from "../scripts/union-catalog/catalog-shape.mjs";
import {
  ARTIFACT_FILE,
  ID_MAP_FILE,
  MANIFEST_FILE,
  REPOSITORY_ROOT,
  defaultLabel,
  exportRelease,
  extractJsonMember,
  insideGitRepository,
  readStableInput,
  sampleFixtureIdentities,
  sha256,
} from "../scripts/union-catalog/export-release.mjs";
import { releaseCounts } from "../scripts/union-catalog/privacy-filter.mjs";
import { LOCAL_ID, TEST_SALT, baseFixture } from "./helpers/union-catalog-fixture.mjs";

// A pass-through spy, so one test can make the catalog_releases check refuse.
vi.mock("../scripts/union-catalog/catalog-shape.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, releaseRecordViolations: vi.fn(actual.releaseRecordViolations) };
});

const SENTINEL = "SENTINEL-PRIVATE-MEMBER";
const dirs = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(process.env.CI_DB_TEMP_ROOT || tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A fictional git working tree (a .git entry) with a sub/ directory; returns both paths. */
function fakeRepository() {
  const root = tempDir("union-catalog-fake-repo-");
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "sub"));
  return { root, sub: join(root, "sub") };
}

/** Writes a fictional snapshot in the research layout; returns its paths. */
function writeSnapshot({ mutate = () => {}, sourceDataExtra = {} } = {}) {
  const root = tempDir("union-catalog-snapshot-");
  const fixture = baseFixture();
  mutate(fixture);
  // The fixture ledger records use the TESTFAM family; the committed config
  // does not know it, so family-national mailboxes simply never match here.
  mkdirSync(join(root, "build"), { recursive: true });
  mkdirSync(join(root, "documents"), { recursive: true });
  writeFileSync(join(root, "build", "enriched.json"), JSON.stringify(fixture.enriched));
  const sourceData = {
    "contacts.json": { [LOCAL_ID]: { reference: { note: `${SENTINEL}-REFERENCE` }, email: `${SENTINEL}-EMAIL@private.example` } },
    "family-TESTFAM.json": { [LOCAL_ID]: { officers: [[1, `${SENTINEL}-FAMILY-OFFICER`]] } },
    "index-data.json": {
      rank: [LOCAL_ID],
      top: [],
      records: fixture.ledger,
      count: Object.keys(fixture.ledger).length,
      officers: [`${SENTINEL}-INDEX-OFFICER`],
      topOfficers: [{ name: `${SENTINEL}-TOP-OFFICER`, note: "a string with } and { and \" inside" }],
    },
    "profiles.json": { [LOCAL_ID]: { name: `${SENTINEL}-PROFILE` } },
    ...sourceDataExtra,
  };
  writeFileSync(join(root, "build", "source-data.json"), JSON.stringify(sourceData));
  // A stray contacts.json beside the build must be ignored too.
  writeFileSync(join(root, "build", "contacts.json"), JSON.stringify({ [LOCAL_ID]: { reference: `${SENTINEL}-STRAY` } }));
  writeFileSync(join(root, "documents", "index.json"), JSON.stringify({ generated: "2026-09-24T19:14:58-04:00", documents: fixture.documents }));
  return root;
}

function writeExclusions(values = []) {
  const dir = tempDir("union-catalog-exclusions-");
  const path = join(dir, "catalog-exclusions.json");
  writeFileSync(path, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: values }));
  return path;
}

function exportFixture(options = {}) {
  const sourceDir = options.sourceDir ?? writeSnapshot();
  const outDir = options.outDir ?? join(tempDir("union-catalog-release-"), "20260924-01");
  const env = options.env ?? { CATALOG_EXCLUSIONS_FILE: writeExclusions() };
  const manifest = exportRelease({ sourceDir, outDir, label: "20260924-01", env, now: new Date("2026-09-25T00:30:00Z") });
  return { sourceDir, outDir, manifest, env };
}

describe("export-release", () => {
  it("writes the artifact, manifest and id map with matching sha256s and counts", () => {
    const { sourceDir, outDir, manifest, env } = exportFixture();
    const gz = readFileSync(join(outDir, ARTIFACT_FILE));
    const json = gunzipSync(gz);
    const release = JSON.parse(json.toString("utf8"));

    expect(manifest.schema).toBe("union-catalog-manifest/1");
    expect(manifest.label).toBe("20260924-01");
    expect(manifest.filterVersion).toBe("privacy-filter/1");
    expect(manifest.artifact.sha256).toBe(sha256(gz));
    expect(manifest.artifact.jsonSha256).toBe(sha256(json));
    expect(manifest.idMap.sha256).toBe(sha256(readFileSync(join(outDir, ID_MAP_FILE))));
    expect(JSON.parse(readFileSync(join(outDir, MANIFEST_FILE), "utf8"))).toEqual(manifest);
    for (const [name, input] of Object.entries(manifest.inputs)) {
      expect(input.sha256).toBe(sha256(readFileSync(join(sourceDir, name))));
    }
    expect(manifest.sourceSha256).toBe(manifest.inputs["build/enriched.json"].sha256);
    expect(release.sourceSha256).toBe(manifest.sourceSha256);
    expect(release.label).toBe(manifest.label);
    expect(manifest.counts).toEqual(releaseCounts(release));
    expect(manifest.counts.organizations).toBe(4);
    expect(releaseRecordViolations(manifest)).toEqual([]);
    expect(manifest.exclusions).toEqual({ fileSha256: sha256(readFileSync(env.CATALOG_EXCLUSIONS_FILE)), matchCount: 0 });
    // The drop report holds counts only.
    for (const [key, value] of Object.entries(manifest.dropReport)) {
      expect(key).toMatch(/^[a-z_.]+:[a-z_]+$/);
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(outDir, ID_MAP_FILE), "utf8")).organizations[LOCAL_ID]).toBe("olms-900000001");
  });

  it("never parses contacts.json or any other private member of source-data.json", () => {
    // contacts.json carries a key named `reference`. Were the member parsed,
    // the F1 guard would refuse the run; it succeeds because it never is.
    const { outDir } = exportFixture();
    for (const file of [ARTIFACT_FILE, MANIFEST_FILE, ID_MAP_FILE]) {
      const bytes = readFileSync(join(outDir, file));
      const text = file === ARTIFACT_FILE ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      expect(text).not.toContain("SENTINEL");
      expect(text).not.toContain("private.example");
    }
  });

  it("refuses a parsed input that carries a key named reference", () => {
    const enriched = writeSnapshot({ mutate: (f) => {
      f.enriched[LOCAL_ID].reference = "fictional";
    } });
    expect(() => exportFixture({ sourceDir: enriched })).toThrow(/F1: enriched\.json carries a key named "reference"/);
    const ledger = writeSnapshot({ mutate: (f) => {
      f.ledger[LOCAL_ID].reference = "fictional";
    } });
    expect(() => exportFixture({ sourceDir: ledger })).toThrow(/F1: source-data\.json index-data\.json\.records/);
    const documents = writeSnapshot({ mutate: (f) => {
      f.documents[0].reference = "fictional";
    } });
    expect(() => exportFixture({ sourceDir: documents })).toThrow(/F1: documents\/index\.json/);
  });

  it("fails closed without the exclusion list, and when it sits inside a repository", () => {
    const outDir = join(tempDir("union-catalog-release-"), "20260924-01");
    expect(() => exportFixture({ outDir, env: {} })).toThrow(/F9: CATALOG_EXCLUSIONS_FILE is not set/);
    expect(() => exportFixture({ outDir, env: { CATALOG_EXCLUSIONS_FILE: join(tempDir("x-"), "absent.json") } })).toThrow(/F9: CATALOG_EXCLUSIONS_FILE does not exist/);
    expect(() => exportFixture({ outDir, env: { CATALOG_EXCLUSIONS_FILE: join(REPOSITORY_ROOT, "catalog-exclusions.json") } })).toThrow(/F9: .*inside a git repository/);
    const malformed = writeExclusions();
    writeFileSync(malformed, "{\"schema\":\"catalog-exclusions/1\",\"salt\":\"short\",\"hashes\":[]}");
    expect(() => exportFixture({ outDir, env: { CATALOG_EXCLUSIONS_FILE: malformed } })).toThrow(/F9/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("drops a value matched by the exclusion list and records only the file hash and a count", () => {
    const { manifest } = exportFixture({ env: { CATALOG_EXCLUSIONS_FILE: writeExclusions([sha256(`${TEST_SALT}\u0000northside chapter`)]) } });
    expect(manifest.exclusions.matchCount).toBeGreaterThan(0);
    expect(Object.keys(manifest.exclusions).sort()).toEqual(["fileSha256", "matchCount"]);
    expect(JSON.stringify(manifest)).not.toContain("northside");
  });

  it("refuses to write inside a repository or over an existing release", () => {
    expect(() => exportFixture({ outDir: join(REPOSITORY_ROOT, "scratch", "catalog-release-test") })).toThrow(/inside a git repository/);
    const { outDir } = exportFixture();
    expect(() => exportFixture({ outDir })).toThrow(/already holds a release/);
  });

  it("refuses a symlinked exclusion file or a path under a symlinked directory that leads into a repository", () => {
    const repo = fakeRepository();
    const inside = join(repo.sub, "catalog-exclusions.json");
    writeFileSync(inside, JSON.stringify({ schema: "catalog-exclusions/1", salt: TEST_SALT, hashes: [] }));
    const outside = tempDir("union-catalog-links-");
    const fileLink = join(outside, "catalog-exclusions.json");
    symlinkSync(inside, fileLink);
    const dirLink = join(outside, "sub-link");
    symlinkSync(repo.sub, dirLink, "dir");
    const outDir = join(tempDir("union-catalog-release-"), "20260924-01");

    expect(insideGitRepository(fileLink)).toBe(true);
    expect(insideGitRepository(join(dirLink, "not-yet", "20260924-01"))).toBe(true);
    // A symlinked file.
    expect(() => exportFixture({ outDir, env: { CATALOG_EXCLUSIONS_FILE: fileLink } })).toThrow(/F9: .*inside a git repository/);
    // A symlinked directory.
    expect(() => exportFixture({ outDir, env: { CATALOG_EXCLUSIONS_FILE: join(dirLink, "catalog-exclusions.json") } })).toThrow(/F9: .*inside a git repository/);
    expect(existsSync(outDir)).toBe(false);
  });

  it("refuses an --out that reaches a repository through a symlinked directory or a symlinked release directory", () => {
    const repo = fakeRepository();
    const outside = tempDir("union-catalog-links-");
    const dirLink = join(outside, "releases");
    symlinkSync(repo.sub, dirLink, "dir");
    expect(() => exportFixture({ outDir: join(dirLink, "20260924-01") })).toThrow(/--out points inside a git repository/);
    mkdirSync(join(repo.sub, "existing"));
    const releaseLink = join(outside, "20260924-01");
    symlinkSync(join(repo.sub, "existing"), releaseLink, "dir");
    expect(() => exportFixture({ outDir: releaseLink })).toThrow(/--out points inside a git repository/);
    expect(existsSync(join(repo.sub, "20260924-01"))).toBe(false);
    expect(existsSync(join(repo.sub, "existing", MANIFEST_FILE))).toBe(false);
  });

  it("still accepts a symlinked exclusion file whose target sits outside every repository", () => {
    const outside = tempDir("union-catalog-links-");
    const link = join(outside, "catalog-exclusions.json");
    symlinkSync(writeExclusions(), link);
    expect(exportFixture({ env: { CATALOG_EXCLUSIONS_FILE: link } }).manifest.label).toBe("20260924-01");
  });

  it("refuses an --out that already holds a symbolic link at a release file name, dangling or live", () => {
    const repo = fakeRepository();
    // A dangling link named manifest.json in an otherwise valid --out.
    const outDir = tempDir("union-catalog-release-");
    symlinkSync(join(repo.sub, MANIFEST_FILE), join(outDir, MANIFEST_FILE));
    let thrown = null;
    try {
      exportFixture({ outDir });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toMatch(/manifest\.json is a symbolic link/);
    expect(thrown.message).not.toContain("SENTINEL");
    expect(existsSync(join(repo.sub, MANIFEST_FILE))).toBe(false);
    expect(existsSync(join(outDir, ARTIFACT_FILE))).toBe(false);
    expect(existsSync(join(outDir, ID_MAP_FILE))).toBe(false);
    // A live link at the id-map name, pointing at a file inside a working tree.
    const other = tempDir("union-catalog-release-");
    const target = join(repo.sub, "id-map.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(other, ID_MAP_FILE));
    expect(() => exportFixture({ outDir: other })).toThrow(/catalog-id-map\.json is a symbolic link/);
    expect(readFileSync(target, "utf8")).toBe("{}");
    expect(existsSync(join(other, ARTIFACT_FILE))).toBe(false);
  });

  it("names a parse failure by input and position, never by the text around the fault", () => {
    // V8's "Unexpected token" message quotes about ten characters either side
    // of the fault; the sentinel sits right next to it.
    const enriched = writeSnapshot();
    writeFileSync(join(enriched, "build", "enriched.json"), `{"900000001":{"n":["Fixtureperson QX7",NaN]}}`);
    const ledger = writeSnapshot();
    writeFileSync(join(ledger, "build", "source-data.json"), `{"index-data.json":{"records":{"900000001":{"n":["Fixtureperson QX7",NaN]}}}}`);
    const positioned = writeSnapshot();
    writeFileSync(join(positioned, "documents", "index.json"), `{"generated":"Fixtureperson QX7",}`);
    const cases = [
      [enriched, /^Structural fault: build\/enriched\.json does not parse \(invalid JSON\)$/],
      [ledger, /^Structural fault: build\/source-data\.json does not parse \(invalid JSON\)$/],
      [positioned, /^Structural fault: documents\/index\.json does not parse \(invalid JSON at position 33\)$/],
    ];
    for (const [sourceDir, expected] of cases) {
      let thrown = null;
      try {
        exportFixture({ sourceDir });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown.message).toMatch(expected);
      for (const part of ["QX7", "person", "NaN", "\""]) expect(thrown.message).not.toContain(part);
      expect(thrown.cause).toBeUndefined();
    }
  });

  it("refuses before writing anything when the manifest would violate a catalog_releases constraint", () => {
    releaseRecordViolations.mockReturnValueOnce(["dropReport (400 keys) may take 20000 bytes as jsonb; the cap is 16384"]);
    const outDir = join(tempDir("union-catalog-release-"), "20260924-01");
    expect(() => exportFixture({ outDir })).toThrow(/would violate a catalog_releases constraint:\n {2}- dropReport \(400 keys\)/);
    expect(existsSync(outDir)).toBe(false);
    const [manifest] = releaseRecordViolations.mock.calls.at(-1);
    expect(Object.keys(manifest)).toEqual(expect.arrayContaining(["label", "releaseSchema", "filterVersion", "sourceSha256", "artifact", "counts", "dropReport"]));
  });

  it("refuses a snapshot that changes while it is being read", () => {
    const dir = tempDir("union-catalog-torn-");
    const path = join(dir, "enriched.json");
    writeFileSync(path, "{}");
    expect(() => readStableInput(path, "build/enriched.json", (raw) => {
      appendFileSync(path, " ");
      return JSON.parse(raw);
    })).toThrow(/changed while it was being read/);
    expect(() => readStableInput(join(dir, "absent.json"), "build/absent.json", JSON.parse)).toThrow(/missing from the snapshot/);
  });
});

describe("extractJsonMember", () => {
  it("cuts one nested member out of the file without parsing its siblings", () => {
    const source = JSON.stringify({
      "contacts.json": { a: "} { \" [ ]", nested: { deeper: [1, 2, { x: "}" }] } },
      "index-data.json": { officers: ["x"], records: { 1: { id: 1, file: 5 } }, count: 1 },
    });
    expect(JSON.parse(extractJsonMember(source, ["index-data.json", "records"]))).toEqual({ 1: { id: 1, file: 5 } });
    expect(() => extractJsonMember(source, ["index-data.json", "absent"])).toThrow(/is missing/);
    // A sibling that is not valid JSON on its own never gets parsed at all.
    const withJunk = `{"profiles.json": {"k": [1, 2, 3e5, true, null]}, "index-data.json": {"records": {}}}`;
    expect(extractJsonMember(withJunk, ["index-data.json", "records"])).toBe("{}");
  });
});

describe("release labels and fixture identities", () => {
  it("defaults the label to the source build date in Eastern time", () => {
    expect(defaultLabel(new Date("2026-09-25T02:00:00Z"))).toBe("20260924-01");
    expect(defaultLabel(new Date("2026-09-25T05:00:00Z"))).toBe("20260925-01");
  });

  it("hands the F11 guard no SAMPLE fixture identities, because Union Ground seeds none", () => {
    // Union Ground's SAMPLE partner catalog is not carried; no fixture name,
    // id or file number may reach the export from it.
    expect(sampleFixtureIdentities()).toEqual({ names: [], fixtures: { ids: [], fileNumbers: [] } });
    expect(existsSync(join(REPOSITORY_ROOT, "scripts", "sample-lived-in-history.mjs"))).toBe(false);
  });
});

describe("committed configuration", () => {
  it("parses both catalog domain lists and wires the npm scripts", () => {
    const families = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "config", "catalog-family-domains.json"), "utf8"));
    const blocked = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "config", "catalog-blocked-email-domains.json"), "utf8"));
    expect(families.schema).toBe("catalog-family-domains/1");
    for (const domains of Object.values(families.families)) {
      for (const domain of domains) expect(domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    }
    expect(blocked.schema).toBe("catalog-blocked-email-domains/1");
    expect(blocked.consumer).toEqual(expect.arrayContaining(["gmail.com", "yahoo.com", "aol.com", "hotmail.com", "comcast.net", "outlook.com"]));
    expect(new Set([...blocked.consumer, ...blocked.hosting]).size).toBe(blocked.consumer.length + blocked.hosting.length);
    const pkg = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["catalog:export"]).toBe("node scripts/union-catalog/export-release.mjs");
    expect(pkg.scripts["catalog:plan"]).toBe("node scripts/load-union-catalog.mjs plan");
  });
});
