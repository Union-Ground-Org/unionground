// @vitest-environment node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBaselinePristine, assertBaselineTarget, assertCleanupLedger, baselineEnvironment, baselineHash, canonicalSchema,
  comparisonMismatches, fromZeroBuild, identityMismatchFields, imageRepository, incrementalBuild, nextAttempt, orderedSchema, physicalKey,
  physicalProjectId, physicalRunKey, removePhysicalProject, runtimeMismatchFields, selectTrustedRuns, snapshotComparison,
  stackInputMismatches, suffixAfter, validatePhysicalManifest,
} from "../scripts/lib/physical-db-baseline.mjs";
import {
  PHYSICAL_PACKAGES, PhysicalStack, attemptOutputs, attemptPlan, buildPhysicalBaseline, cleanupPhysicalBuild, migrationNames, physicalIdentity,
  restoreLabs, verifyPhysicalSnapshot,
} from "../scripts/physical-db-baseline.mjs";
import { PHYSICAL_SNAPSHOT_LOOKBACK, fetchPhysicalBaseline } from "../scripts/fetch-physical-db-baseline.mjs";
import { PRISTINE_DB_PROOFS } from "../scripts/run-required-db-proofs.mjs";

// The physical database baseline ci.yml's db job restores instead of a
// from-zero replay (docs/contracts/ci.md, "Database lane"). Ported from the
// sibling repository's tests/physical-db-baseline.test.js and
// tests/physical-db-baseline-lifecycle.test.js. Everything here is offline:
// Docker, the CLI and GitHub are stubbed. The first GitHub runs prove the rest.

const REPOSITORY = "example-org/union-ground";
const STATE = { auth_users: 0, auth_identities: 0, auth_sessions: 0, members: 0, storage_objects: 0, organizations: 0, chapters: 0 };
const RUNTIME = { image: "public.ecr.aws/supabase/postgres:17.4.1", imageId: "sha256:pinned", engine: "PostgreSQL 17.4", settings: [], availableExtensions: [],
  extensions: [{ extname: "plpgsql", extversion: "1.0" }] };
const SOURCE = { commit: "c".repeat(40), run: 41 };
const NAMES = migrationNames();

function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// A snapshot of this tree at `prefix`, as the producer writes it: schema 1
// (before incremental builds) unless a `build` record is given.
function writeSnapshot(directory, { prefix = NAMES.at(-1).slice(0, 14), runtime = RUNTIME, source = SOURCE, build, edit = (m) => m } = {}) {
  mkdirSync(directory, { recursive: true });
  const archive = Buffer.from(`archive ${prefix}`);
  writeFileSync(join(directory, "data.tgz"), archive);
  const identity = physicalIdentity(prefix, runtime);
  const manifest = edit({ schema: build ? 2 : 1, kind: "physical-disposable", identity, key: physicalKey(identity), schemaSha256: baselineHash("schema"),
    orderedSchemaSha256: baselineHash("ordered"), archiveSha256: baselineHash(archive), archiveBytes: archive.length, pristine: true, state: STATE, source,
    ...(build ? { build } : {}) });
  const bytes = JSON.stringify(manifest) + "\n";
  writeFileSync(join(directory, "manifest.json"), bytes);
  return baselineHash(bytes);
}

const lab = (root, name, basePort) => {
  const workdir = join(root, `unionground-lab-ci-${name}`);
  mkdirSync(join(workdir, "supabase/migrations"), { recursive: true });
  return { CI_DB_WORKDIR: workdir, CI_DB_PROJECT_ID: `unionground-lab-ci-${baselineHash(name).slice(0, 12)}`, CI_DB_BASE_PORT: String(basePort),
    SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${basePort + 2}/postgres` };
};

describe("snapshot identity and manifest", () => {
  it("keys every input, including each runtime pin", () => {
    const identity = physicalIdentity(NAMES.at(-1).slice(0, 14), RUNTIME);
    expect(physicalKey(identity)).toBe(physicalKey(structuredClone(identity)));
    for (const changed of [{ ...identity, runtime: { ...RUNTIME, imageId: "sha256:other" } }, { ...identity, packages: [] }, { ...identity, preparedConfig: "x" }]) {
      expect(physicalKey(changed)).not.toBe(physicalKey(identity));
    }
  });

  it("holds what shapes the data directory and nothing the scripts or Node add", () => {
    const prefix = NAMES.at(-2).slice(0, 14);
    const identity = physicalIdentity(prefix, {});
    expect(identity.migrations.map(([name]) => name)).toEqual(NAMES.slice(0, -1));
    expect(identity.migrations.at(-1)[1]).toBe(baselineHash(readFileSync(new URL(`../supabase/migrations/${NAMES.at(-2)}`, import.meta.url))));
    expect(identity.files.map(([name]) => name)).toEqual(expect.arrayContaining(["supabase/config.toml"]));
    expect(identity.files.every(([name]) => /^supabase\/[^/]+$/.test(name))).toBe(true);
    expect("node" in identity).toBe(false);
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")).packages;
    expect(identity.packages).toEqual(PHYSICAL_PACKAGES.map((name) => [name, lock[`node_modules/${name}`].version, lock[`node_modules/${name}`].integrity]));
    expect(identity.packages.every(([, version, integrity]) => version && integrity)).toBe(true);
    expect(() => physicalIdentity("20990101000000", {})).toThrow(/missing physical prefix/);
  });

  it("requires a trusted digest, the exact identity, a named source, a pristine state and the archive's bytes", () => {
    const identity = physicalIdentity(NAMES.at(-1).slice(0, 14), RUNTIME);
    const make = (extra = {}) => Buffer.from(JSON.stringify({ schema: 1, kind: "physical-disposable", identity, key: physicalKey(identity),
      schemaSha256: "a".repeat(64), orderedSchemaSha256: "b".repeat(64), archiveSha256: baselineHash("archive"), pristine: true, state: STATE, source: SOURCE, ...extra }));
    const verify = (bytes, { digest = baselineHash(bytes), expected = identity, archive = Buffer.from("archive") } = {}) =>
      validatePhysicalManifest(bytes, archive, digest, expected);
    expect(verify(make()).key).toBe(physicalKey(identity));
    expect(() => verify(make(), { digest: null })).toThrow(/manifest digest/);
    expect(() => verify(make(), { digest: "0".repeat(64) })).toThrow(/manifest digest/);
    expect(() => verify(make(), { expected: { ...identity, platform: "darwin" } })).toThrow(/identity mismatch: platform/);
    expect(() => verify(make(), { archive: Buffer.from("corrupt") })).toThrow(/archive digest/);
    expect(() => verify(make({ source: { commit: "short", run: 41 } }))).toThrow(/incomplete/);
    expect(() => verify(make({ state: { ...STATE, auth_users: 1 } }))).toThrow(/non-pristine/);
  });

  it("names the differing fields and tells stack inputs from migration history", () => {
    const expected = { prefix: "1", files: [["supabase/config.toml", "1"]], migrations: [["a.sql", "1"], ["b.sql", "2"]], packages: [["supabase", "2.109.1", "x"]] };
    expect(identityMismatchFields(expected, structuredClone(expected))).toEqual([]);
    const fields = identityMismatchFields(expected, { ...expected, migrations: [["a.sql", "1"], ["b.sql", "3"]], packages: [["supabase", "2.110.0", "y"]] });
    expect(fields).toEqual(["migrations b.sql", "packages supabase"]);
    expect(stackInputMismatches(fields)).toEqual(["packages supabase"]);
    expect(stackInputMismatches(["prefix", "migrations a.sql"])).toEqual([]);
  });
});

describe("schema digests", () => {
  it("drop only the dump nonce, and the ordered digest keeps statement order", () => {
    expect(canonicalSchema("b\n\\restrict nonce\na\n\\unrestrict nonce\n")).toBe("a\nb\n");
    const a = "CREATE FUNCTION f() AS $$\nSELECT 1;\nSELECT 2;\n$$;\n";
    const b = "CREATE FUNCTION f() AS $$\nSELECT 2;\nSELECT 1;\n$$;\n";
    expect(canonicalSchema(a)).toBe(canonicalSchema(b));
    expect(orderedSchema(a)).not.toBe(orderedSchema(b));
  });

  it("ignore realtime's dated message partitions and nothing else", () => {
    const entry = (name, type, schema, body) => `--\n-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: supabase_admin\n--\n\n${body}\n\n`;
    const dump = (days) => [entry("messages", "TABLE", "realtime", "CREATE TABLE realtime.messages (\n    topic text NOT NULL,\n    inserted_at timestamp\n)\nPARTITION BY RANGE (inserted_at);"),
      ...days.map((day) => entry(`messages_${day}`, "TABLE", "realtime", `CREATE TABLE realtime.messages_${day} (id bigint);`)),
      entry("messages_2026_11_10", "TABLE", "public", "CREATE TABLE public.messages_2026_11_10 (id bigint);")].join("");
    const before = dump(["2026_11_08", "2026_11_09"]), after = dump(["2026_11_09", "2026_11_10", "2026_11_11"]);
    expect(orderedSchema(before)).toBe(orderedSchema(after));
    expect(canonicalSchema(before)).toBe(canonicalSchema(after));
    expect(orderedSchema(after)).toMatch(/CREATE TABLE public\.messages_2026_11_10/);
    expect(orderedSchema(after)).toMatch(/PARTITION BY RANGE/);
    const changed = after.replace("topic text NOT NULL", "topic text");
    expect(orderedSchema(changed)).not.toBe(orderedSchema(after));
  });
});

describe("runtime pins", () => {
  it("match one image's content across registries and refuse different content", () => {
    const pins = { image: "public.ecr.aws/supabase/postgres:17.4.1", imageId: "sha256:75e1", engine: "17" };
    for (const image of ["ghcr.io/supabase/postgres:17.4.1", "supabase/postgres:17.4.1", "localhost:5000/supabase/postgres:17.4.1"]) {
      expect(runtimeMismatchFields(pins, { ...pins, image })).toEqual([]);
    }
    expect(imageRepository("postgres:pinned")).toBe("postgres:pinned");
    expect(runtimeMismatchFields(pins, { ...pins, imageId: "sha256:other" })).toEqual(["imageId"]);
    expect(runtimeMismatchFields(pins, { ...pins, image: "ghcr.io/supabase/postgres:17.5.0" })).toEqual(["image"]);
  });
});

describe("owned labs", () => {
  it("accept only loopback unionground-lab-ci targets, never an alias of another", () => {
    const root = scratch("physical-target-");
    try {
      const shared = lab(root, "shared", 55000), sensitive = lab(root, "sensitive", 55010);
      expect(assertBaselineTarget(shared)).toBe(shared);
      expect(assertBaselineTarget(sensitive, [shared])).toBe(sensitive);
      expect(() => assertBaselineTarget(shared, [shared])).toThrow(/alias/);
      for (const bad of [{ CI_DB_PROJECT_ID: "mi1-xdb-ci-aaaaaaaaaaaa" }, { SUPABASE_DB_URL: "postgresql://postgres:postgres@db.example.supabase.co:55002/postgres" },
        { SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" }, { CI_DB_WORKDIR: "relative/unionground-lab-ci-x" },
        { CI_DB_WORKDIR: join(root, "shared-lab") }]) {
        expect(() => assertBaselineTarget({ ...shared, ...bad }), JSON.stringify(bad)).toThrow(/owned local disposable target/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("hold no login, identity, session, member or stored object", () => {
    expect(assertBaselinePristine(STATE)).toBe(STATE);
    expect(assertBaselinePristine({ ...STATE, organizations: 2, chapters: 3 })).toBeTruthy();
    for (const key of ["auth_users", "auth_identities", "auth_sessions", "members", "storage_objects"]) {
      expect(() => assertBaselinePristine({ ...STATE, [key]: 1 }), key).toThrow(/non-pristine/);
    }
    expect(() => assertBaselinePristine({ ...STATE, extra: 0 })).toThrow(/non-pristine/);
  });

  it("keep credentials out of every baseline command and keep the runner's time budget", () => {
    const env = baselineEnvironment({ PATH: "/bin", HOME: "/home/runner", GH_TOKEN: "t", SUPABASE_ACCESS_TOKEN: "s", NODE_OPTIONS: "--inspect", RUNNER_ENVIRONMENT: "github-hosted" }, "/tmp/out");
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/runner", TMPDIR: "/tmp/out", RUNNER_ENVIRONMENT: "github-hosted", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "America/New_York" });
  });
});

describe("snapshot verification against this tree", () => {
  it("accepts this tree's own snapshot and says which migrations a newer tree applies on top", () => {
    const directory = scratch("physical-verify-");
    try {
      const prefix = NAMES.at(-2).slice(0, 14);
      const digest = writeSnapshot(directory, { prefix });
      expect(verifyPhysicalSnapshot(directory, digest).manifest.identity.prefix).toBe(prefix);
      expect(suffixAfter(NAMES, prefix)).toEqual([NAMES.at(-1)]);
      expect(suffixAfter(NAMES, NAMES.at(-1).slice(0, 14))).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refuses a branch behind main, an edited migration and a changed stack input, and says which can be bridged", () => {
    const directory = scratch("physical-verify-");
    try {
      let digest = writeSnapshot(directory, { edit: (m) => ({ ...m, identity: { ...m.identity, prefix: "20991231000000" } }) });
      let error = (() => { try { verifyPhysicalSnapshot(directory, digest); } catch (caught) { return caught; } })();
      expect(error.message).toMatch(/lacks the snapshot's last migration 20991231000000/);
      expect(error.stackInputs).toEqual([]);

      digest = writeSnapshot(directory, { edit: (m) => ({ ...m, identity: { ...m.identity, migrations: m.identity.migrations.map(([name, hash], index) => [name, index === 3 ? "0".repeat(64) : hash]) } }) });
      error = (() => { try { verifyPhysicalSnapshot(directory, digest); } catch (caught) { return caught; } })();
      expect(error.message).toMatch(new RegExp(`identity mismatch: migrations ${NAMES[3]}`));
      expect(error.stackInputs).toEqual([]);

      digest = writeSnapshot(directory, { edit: (m) => ({ ...m, identity: { ...m.identity, preparedConfig: "1".repeat(64), packages: [["supabase", "2.0.0", "x"]] } }) });
      error = (() => { try { verifyPhysicalSnapshot(directory, digest); } catch (caught) { return caught; } })();
      expect(error.stackInputs).toEqual(expect.arrayContaining(["preparedConfig", "packages supabase, @supabase/cli-linux-x64"]));

      writeSnapshot(directory);
      expect(() => verifyPhysicalSnapshot(directory, "0".repeat(64))).toThrow(/manifest digest/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

// An incremental snapshot of this tree: built on main run 30's snapshot at
// the third-newest migration, two incremental builds after run 20's replay.
const BASE_PREFIX = NAMES.at(-3).slice(0, 14);
const CHAIN = { path: "incremental", reason: "main run 30's snapshot fits this tree",
  base: { run: 30, commit: "3".repeat(40), manifestSha256: "a".repeat(64), prefix: BASE_PREFIX }, applied: NAMES.slice(-2), depth: 2,
  root: { run: 20, commit: "2".repeat(40), manifestSha256: "b".repeat(64) } };
const refusal = (action) => { try { action(); } catch (error) { return error; } throw new Error("expected a refusal"); };

describe("incremental builds and their chain", () => {
  it("records the base, the migrations applied on top, the depth and the from-zero root", () => {
    const base = (schema, build, run = 30) => ({ schema, identity: { prefix: BASE_PREFIX }, source: { commit: "3".repeat(40), run }, ...(build ? { build } : {}) });
    const self = { run: 30, commit: "3".repeat(40), manifestSha256: "a".repeat(64) };
    // A schema 1 snapshot was always a from-zero replay, so it is the root.
    expect(incrementalBuild(base(1), "a".repeat(64), NAMES.slice(-2), "why")).toEqual({ path: "incremental", reason: "why",
      base: { ...self, prefix: BASE_PREFIX }, applied: NAMES.slice(-2), depth: 1, root: self });
    expect(incrementalBuild(base(2, fromZeroBuild("bootstrap")), "a".repeat(64), [], "why")).toMatchObject({ depth: 1, root: self, applied: [] });
    expect(incrementalBuild(base(2, CHAIN), "a".repeat(64), [], "why")).toMatchObject({ depth: 3, root: CHAIN.root, base: { ...self, prefix: BASE_PREFIX } });
  });

  it("accepts a consistent chain, and a from-zero or schema 1 snapshot as a root", () => {
    const directory = scratch("physical-chain-");
    try {
      expect(verifyPhysicalSnapshot(directory, writeSnapshot(directory, { build: CHAIN })).manifest.build).toEqual(CHAIN);
      expect(verifyPhysicalSnapshot(directory, writeSnapshot(directory, { build: fromZeroBuild("bootstrap") })).manifest.build.path).toBe("from-zero");
      expect(verifyPhysicalSnapshot(directory, writeSnapshot(directory)).manifest.schema).toBe(1);
      const first = { ...CHAIN, depth: 1, root: { run: 30, commit: "3".repeat(40), manifestSha256: "a".repeat(64) } };
      expect(verifyPhysicalSnapshot(directory, writeSnapshot(directory, { build: first })).manifest.build.depth).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("refuses a chain it cannot verify against this tree", () => {
    const directory = scratch("physical-chain-");
    try {
      const refused = (options) => refusal(() => verifyPhysicalSnapshot(directory, writeSnapshot(directory, options))).message;
      const chain = (extra) => ({ build: { ...CHAIN, ...extra } });
      // Applied migrations that are not exactly those after the base: one
      // missing, one extra, reordered, or an edited earlier one slipped in.
      expect(refused(chain({ applied: NAMES.slice(-1) }))).toMatch(/applied migrations are not exactly/);
      expect(refused(chain({ applied: NAMES.slice(-3) }))).toMatch(/applied migrations are not exactly/);
      expect(refused(chain({ applied: [...NAMES.slice(-2)].reverse() }))).toMatch(/applied migrations are not exactly/);
      expect(refused(chain({ base: { ...CHAIN.base, prefix: "20991231000000" } }))).toMatch(/base prefix 20991231000000 is not one of/);
      // A base that is not older than the snapshot, or the snapshot itself.
      expect(refused(chain({ base: { ...CHAIN.base, run: SOURCE.run } }))).toMatch(/not an older snapshot/);
      expect(refused(chain({ depth: 1 }))).toMatch(/root and depth disagree/);
      expect(refused(chain({ root: { ...CHAIN.root, run: 30 } }))).toMatch(/root and depth disagree/);
      for (const broken of [{ base: null }, { root: null }, { depth: 0 }, { reason: "" }, { path: "guessed" }, { base: { ...CHAIN.base, commit: "short" } }]) {
        expect(refused(chain(broken)), JSON.stringify(broken)).toMatch(/physical chain incomplete/);
      }
      expect(refused({ build: { ...fromZeroBuild("x"), base: CHAIN.base } })).toMatch(/a from-zero snapshot names a base/);
      expect(refused({ edit: (m) => ({ ...m, build: CHAIN }) })).toMatch(/schema 1 manifest carries no build record/);
      expect(refused({ edit: (m) => ({ ...m, schema: 2 }) })).toMatch(/physical chain incomplete/);
      expect(refused({ edit: (m) => ({ ...m, schema: 3, build: CHAIN }) })).toMatch(/manifest incomplete/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("compares a full replay with the snapshot by inputs, runtime pins, both schema digests and state", () => {
    const identity = physicalIdentity(NAMES.at(-1).slice(0, 14), RUNTIME);
    const manifest = { schema: 2, identity, schemaSha256: "1".repeat(64), orderedSchemaSha256: "2".repeat(64), state: STATE, source: SOURCE, build: CHAIN };
    const snapshot = snapshotComparison(manifest, "d".repeat(64));
    expect(snapshot).toMatchObject({ run: SOURCE.run, manifestSha256: "d".repeat(64), path: "incremental", prefix: identity.prefix, runtime: RUNTIME });
    const replay = (extra = {}) => snapshotComparison({ ...manifest, build: fromZeroBuild("replay"), ...extra }, "e".repeat(64));
    expect(comparisonMismatches(snapshot, replay())).toEqual([]);
    expect(comparisonMismatches(snapshot, replay({ identity: { ...identity, runtime: { ...RUNTIME, image: "supabase/postgres:17.4.1" } } }))).toEqual([]);
    expect(comparisonMismatches(snapshot, replay({ orderedSchemaSha256: "3".repeat(64) }))).toEqual(["orderedSchemaSha256"]);
    expect(comparisonMismatches(snapshot, replay({ state: { ...STATE, organizations: 1 } }))).toEqual(["state"]);
    expect(comparisonMismatches(snapshot, replay({ identity: { ...identity, runtime: { ...RUNTIME, imageId: "sha256:x" } } }))).toEqual(["runtime imageId"]);
    expect(comparisonMismatches(snapshot, replay({ identity: { ...identity, preparedConfig: "x" } }))).toEqual(["inputsKey"]);
  });

  it("says what the next attempt does after a failed one", () => {
    expect(nextAttempt(null, "auto")).toEqual({ next: "auto", reason: "" });
    expect(nextAttempt(null, "from-zero")).toEqual({ next: "from-zero", reason: "" });
    expect(nextAttempt({ path: "incremental", failure: "statement timeout" }, "auto")).toEqual({ next: "auto", reason: "" });
    expect(nextAttempt({ path: "incremental", baseRefused: true, base: { run: 30 }, failure: "physical schema digest\nmismatch" }, "auto"))
      .toEqual({ next: "from-zero", reason: "the previous attempt could not restore main run 30's snapshot: physical schema digest mismatch" });
    expect(nextAttempt({ path: "from-zero", reason: "bootstrap: none yet" }, "auto")).toEqual({ next: "from-zero", reason: "bootstrap: none yet" });
    expect(nextAttempt({ path: "compare", mismatches: ["schemaSha256"] }, "compare").next).toBe("stop");
    expect(nextAttempt({ path: "compare", failure: "statement timeout" }, "compare").next).toBe("compare");
    expect(attemptOutputs("", "from-zero")).toBe("next=from-zero\nreason=\n");
  });
});

// A PhysicalStack whose Docker, SQL and CLI calls are recorded, not run.
async function withRestoreFixture(action, { prefix = NAMES.at(-2).slice(0, 14) } = {}) {
  const directory = scratch("physical-restore-");
  try {
    const digest = writeSnapshot(join(directory, "snapshot"), { prefix });
    const target = lab(directory, "abcdef", 55000);
    const stack = new PhysicalStack(target, { output: directory, log: () => {} });
    const events = [];
    stack.ensureLocalDocker = () => {};
    stack.cold = ({ bootstrapOnly = false } = {}) => events.push([bootstrapOnly ? "empty-start" : "full-replay"]);
    stack.runtime = async () => RUNTIME;
    stack.stopPhysical = () => { events.push(["stop"]); return {}; };
    stack.helper = (_stopped, label) => events.push([label]);
    stack.restart = () => events.push(["restart"]);
    stack.history = async (list) => events.push(["history", list.length]);
    stack.pristineState = async () => { events.push(["pristine"]); return STATE; };
    stack.schema = (ordered) => baselineHash(ordered ? "ordered" : "schema");
    stack.cli = (label, args) => events.push([label, ...args]);
    await action({ stack, events, directory: join(directory, "snapshot"), digest });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("restore", () => {
  it("starts the lab's own empty stack, imports the verified bytes, checks them, then applies only the newer migrations", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    const { suffix } = await stack.restore(directory, digest);
    expect(suffix).toEqual([NAMES.at(-1)]);
    expect(events).toEqual([["empty-start"], ["stop"], ["physical-import"], ["restart"], ["history", NAMES.length - 1], ["pristine"],
      ["suffix", "migration", "up", "--local"], ["history", NAMES.length], ["pristine"]]);
    expect(readFileSync(join(stack.target.CI_DB_WORKDIR, "verified-physical-baseline/data.tgz"))).toEqual(readFileSync(join(directory, "data.tgz")));
  }));

  it("runs the change's migrations under the grant probe after applying the baseline suffix", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    const file = NAMES.at(-1);
    const path = join(stack.target.CI_DB_WORKDIR, "supabase/migrations", file);
    writeFileSync(path, "select 1;");
    stack.run = (label, _command, args, options) => {
      expect(options.env.CI_DB_GRANT_PROBE_ADDED).toBe(file);
      if (label === "grant-probe-hosted") {
        expect(args.at(-1)).toBe(file);
        expect(existsSync(path)).toBe(false);
      }
      events.push([label]);
    };
    const { suffix } = await stack.restore(directory, digest, { grantProbeMigrations: [file] });
    expect(suffix).toEqual(NAMES.slice(-2));
    expect(events.slice(7, -2)).toEqual([["grant-probe-revoke"], ["grant-probe-hosted"],
      ["grant-probe-migration", "migration", "up", "--local"], ["grant-probe-restore"]]);
    expect(readFileSync(path, "utf8")).toBe("select 1;");
  }, { prefix: NAMES.at(-3).slice(0, 14) }));

  it("refuses a snapshot that already contains an added migration", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    await expect(stack.restore(directory, digest, { grantProbeMigrations: [NAMES.at(-2)] })).rejects.toThrow(/already includes a migration/);
    expect(events).toEqual([]);
  }));

  it("applies nothing when the snapshot holds every migration", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    expect((await stack.restore(directory, digest)).suffix).toEqual([]);
    expect(events.some(([label]) => label === "suffix")).toBe(false);
  }, { prefix: NAMES.at(-1).slice(0, 14) }));

  it("refuses corrupt bytes before touching the lab", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    writeFileSync(join(directory, "data.tgz"), "corrupt");
    await expect(stack.restore(directory, digest)).rejects.toThrow(/archive digest/);
    expect(events).toEqual([]);
  }));

  it("refuses a different engine, image or extension set before importing, and keeps both sides", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    for (const [field, value] of [["imageId", "sha256:other"], ["engine", "PostgreSQL 18"], ["availableExtensions", [{ name: "x", default_version: "1" }]]]) {
      stack.runtime = async () => ({ ...RUNTIME, [field]: value });
      await expect(stack.restore(directory, digest)).rejects.toThrow(new RegExp(`availability mismatch: ${field}$`));
      rmSync(join(stack.target.CI_DB_WORKDIR, "verified-physical-baseline"), { recursive: true });
    }
    expect(events.some(([label]) => ["stop", "physical-import", "suffix"].includes(label))).toBe(false);
  }));

  it("refuses a schema or state that differs from the snapshot before any newer migration runs", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    stack.schema = (ordered) => ordered ? "changed-function-order" : baselineHash("schema");
    await expect(stack.restore(directory, digest)).rejects.toThrow(/schema digest/);
    rmSync(join(stack.target.CI_DB_WORKDIR, "verified-physical-baseline"), { recursive: true });
    stack.schema = (ordered) => baselineHash(ordered ? "ordered" : "schema");
    stack.pristineState = async () => ({ ...STATE, organizations: 1 });
    await expect(stack.restore(directory, digest)).rejects.toThrow(/restored state differs/);
    expect(events.some(([label]) => label === "suffix")).toBe(false);
  }));

  it("stops the owned postmaster through pg_ctl and requires a clean exit", () => withRestoreFixture(async ({ stack }) => {
    const db = { Id: "a".repeat(64), Image: "sha256:pinned", HostConfig: { RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 } },
      Config: { Labels: { "com.supabase.cli.project": stack.target.CI_DB_PROJECT_ID } },
      Mounts: [{ Destination: "/var/lib/postgresql/data", Type: "volume", Name: `supabase_db_${stack.target.CI_DB_PROJECT_ID}` }] };
    const service = { Id: "b".repeat(64), Config: db.Config };
    stack.container = () => db;
    const calls = [];
    let exitCode = 0;
    stack.run = (label, command, args) => {
      calls.push({ label, args });
      if (label === "owned-services") return `${db.Id.slice(0, 12)}\n${service.Id.slice(0, 12)}\n`;
      if (label === "owned-inspect") return JSON.stringify([db, service]);
      if (label === "stopped-inspect") return JSON.stringify([{ Id: db.Id, State: { Running: false, ExitCode: exitCode } }]);
      return "";
    };
    const stopped = PhysicalStack.prototype.stopPhysical.call(stack);
    const args = (label) => calls.find((call) => call.label === label)?.args;
    expect(args("physical-disable-restart")).toEqual(["update", "--restart=no", db.Id]);
    expect(args("physical-stop-services")).toEqual(["stop", "--time", "60", service.Id]);
    expect(args("physical-db-shutdown")).toEqual(["exec", "--user", "postgres", db.Id, "pg_ctl", "-D", "/var/lib/postgresql/data", "-m", "fast", "-W", "stop"]);
    PhysicalStack.prototype.restart.call(stack, stopped);
    expect(args("physical-restart-policy")).toEqual(["update", "--restart=unless-stopped", db.Id]);
    exitCode = 137;
    expect(() => PhysicalStack.prototype.stopPhysical.call(stack)).toThrow(/did not shut down cleanly/);
  }));

  it("refuses a remote Docker context", () => withRestoreFixture(async ({ stack }) => {
    stack.run = () => "ssh://remote-docker";
    expect(() => PhysicalStack.prototype.ensureLocalDocker.call(stack)).toThrow(/local Unix-socket/);
  }));

  it("runs the pristine proofs against the lab with no inherited credential", () => withRestoreFixture(async ({ stack }) => {
    let seen;
    stack.run = (_label, _command, args, options) => { seen = { args, env: options.env }; };
    PhysicalStack.prototype.proofs.call(stack);
    expect(seen.args.slice(2, 2 + PRISTINE_DB_PROOFS.length)).toEqual(PRISTINE_DB_PROOFS);
    expect(seen.env).toMatchObject({ CI: "true", REQUIRE_DB_REPAIR_PROOFS: "1", SUPABASE_DB_URL: stack.target.SUPABASE_DB_URL });
    expect(seen.env.GH_TOKEN).toBeUndefined();
  }));

  it("still removes the exact project's containers when the CLI stop fails", () => withRestoreFixture(async ({ stack }) => {
    stack.cli = () => { throw new Error("cancelled CLI stop"); };
    const calls = [];
    stack.run = (label) => { calls.push(label); return label.endsWith("docker-context") ? "unix:///var/run/docker.sock" : ""; };
    PhysicalStack.prototype.cleanup.call(stack);
    expect(calls).toEqual(["cleanup-list", "cleanup-list"]);
  }));
});

describe("building on a base snapshot", () => {
  it("restores the base through the pull request's restore, applies the newer migrations and records the chain", () => withRestoreFixture(async ({ stack, events, directory, digest }) => {
    const out = join(stack.output, "artifact");
    stack.proofs = () => events.push(["proofs"]);
    stack.helper = (_stopped, label, _args, target) => { events.push([label]); if (label === "physical-export") writeFileSync(join(target, "data.tgz"), "new archive"); };
    const source = { commit: "d".repeat(40), run: 50 };
    const { manifest, trustedDigest } = await stack.produce(out, source, { path: "incremental", reason: "fits", directory, manifestSha256: digest });
    const labels = events.map(([label]) => label);
    expect(labels.indexOf("suffix")).toBeGreaterThan(labels.indexOf("physical-import"));
    expect(labels.indexOf("proofs")).toBeGreaterThan(labels.indexOf("suffix"));
    expect(labels.at(-1)).toBe("physical-export");
    const base = { run: SOURCE.run, commit: SOURCE.commit, manifestSha256: digest };
    expect(manifest).toMatchObject({ schema: 2, source, build: { path: "incremental", reason: "fits", base: { ...base, prefix: NAMES.at(-2).slice(0, 14) },
      applied: [NAMES.at(-1)], depth: 1, root: base } });
    expect(manifest.identity.prefix).toBe(NAMES.at(-1).slice(0, 14));
    // What the round trip and every pull request then check.
    expect(verifyPhysicalSnapshot(out, trustedDigest).manifest.build).toEqual(manifest.build);
  }));

  it("replays from zero when the plan says so and records it as a chain root", () => withRestoreFixture(async ({ stack, events }) => {
    const out = join(stack.output, "artifact");
    stack.proofs = () => events.push(["proofs"]);
    stack.helper = (_stopped, label, _args, target) => { if (label === "physical-export") writeFileSync(join(target, "data.tgz"), "new archive"); };
    const { manifest } = await stack.produce(out, SOURCE, { path: "from-zero", reason: "bootstrap" });
    expect(events[0]).toEqual(["full-replay"]);
    expect(events.some(([label]) => label === "physical-import")).toBe(false);
    expect(manifest.build).toEqual(fromZeroBuild("bootstrap"));
  }));

  it("marks a refusal of the base itself, and not a failure of the newer migrations", () => withRestoreFixture(async ({ stack, directory, digest }) => {
    stack.schema = () => "other";
    const refused = await stack.restore(directory, digest).catch((error) => error);
    expect(refused.message).toMatch(/schema digest/);
    expect(refused.baseRefused).toBe(true);
    rmSync(join(stack.target.CI_DB_WORKDIR, "verified-physical-baseline"), { recursive: true });
    stack.schema = (ordered) => baselineHash(ordered ? "ordered" : "schema");
    stack.cli = () => { throw new Error("suffix: 57014 statement timeout"); };
    const failed = await stack.restore(directory, digest).catch((error) => error);
    expect(failed.message).toMatch(/statement timeout/);
    expect(failed.baseRefused).toBeUndefined();
  }));

  it("refuses a base with a broken chain before touching the lab", () => withRestoreFixture(async ({ stack, events, directory }) => {
    const digest = writeSnapshot(directory, { build: { ...CHAIN, applied: NAMES.slice(-1) } });
    const refused = await stack.restore(directory, digest).catch((error) => error);
    expect(refused.message).toMatch(/applied migrations are not exactly/);
    expect(refused.baseRefused).toBe(true);
    expect(events).toEqual([]);
  }));
});

describe("restoring both labs in the db job", () => {
  const jobEnv = (root, extra = {}) => {
    const shared = lab(root, "shared", 55000), sensitive = lab(root, "sensitive", 55010);
    return { ...shared, ...Object.fromEntries(Object.entries(sensitive).map(([key, value]) => [`SENSITIVE_PROOF_${key}`, value])),
      PHYSICAL_DB_BASELINE_MODE: "warm", PHYSICAL_DB_BASELINE_DIRECTORY: join(root, "snapshot"), PHYSICAL_DB_BASELINE_MANIFEST_SHA256: "d".repeat(64),
      PHYSICAL_DB_BASELINE_RECORD: join(root, "record.json"), GITHUB_STEP_SUMMARY: join(root, "summary.md"), ...extra };
  };

  it("restores the shared lab, then the sensitive-rollout lab, and records the source and the migrations applied on top", async () => {
    const root = scratch("physical-labs-");
    try {
      const env = jobEnv(root);
      writeFileSync(env.PHYSICAL_DB_BASELINE_RECORD, JSON.stringify({ schema: 1, mode: "warm" }));
      const order = [];
      const stackFor = (target) => ({ restore: async (directory, digest) => {
        order.push([target.CI_DB_PROJECT_ID, directory, digest]);
        return { manifest: { identity: { prefix: "20261019224500" }, source: SOURCE }, suffix: ["20261111000000_added.sql"] };
      } });
      const labs = await restoreLabs(env, { log: () => {}, stackFor });
      expect(order.map(([project]) => project)).toEqual([env.CI_DB_PROJECT_ID, env.SENSITIVE_PROOF_CI_DB_PROJECT_ID]);
      expect(order.every(([, directory, digest]) => directory === env.PHYSICAL_DB_BASELINE_DIRECTORY && digest === env.PHYSICAL_DB_BASELINE_MANIFEST_SHA256)).toBe(true);
      const record = JSON.parse(readFileSync(env.PHYSICAL_DB_BASELINE_RECORD, "utf8"));
      expect(record.labs).toEqual(labs);
      expect(record.labs.map((entry) => [entry.name, entry.suffix])).toEqual([["shared", ["20261111000000_added.sql"]], ["sensitive-rollout", ["20261111000000_added.sql"]]]);
      const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
      expect(summary).toContain(`from main ${SOURCE.commit} (producer run ${SOURCE.run}`);
      expect(summary).toContain("applied on top: 20261111000000_added.sql");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses to start without a warm decision or with one lab aliasing the other", async () => {
    const root = scratch("physical-labs-");
    try {
      const never = () => { throw new Error("must not restore"); };
      for (const extra of [{ PHYSICAL_DB_BASELINE_MODE: "cold" }, { PHYSICAL_DB_BASELINE_MODE: undefined }, { PHYSICAL_DB_BASELINE_MANIFEST_SHA256: "" }]) {
        await expect(restoreLabs(jobEnv(root, extra), { log: () => {}, stackFor: never })).rejects.toThrow(/no verified snapshot/);
      }
      const env = jobEnv(root);
      await expect(restoreLabs({ ...env, SENSITIVE_PROOF_CI_DB_BASE_PORT: env.CI_DB_BASE_PORT, SENSITIVE_PROOF_SUPABASE_DB_URL: env.SUPABASE_DB_URL },
        { log: () => {}, stackFor: never })).rejects.toThrow(/alias/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("builder attempt", () => {
  const prepareFor = (root) => async ({ tempRoot, runKey }) => {
    expect(tempRoot).toBe(root);
    const name = runKey.split(":").at(-1);
    const target = lab(root, name.replace("-", ""), name === "producer" ? 55000 : 55010);
    return { ...target, CI_DB_PROJECT_ID: `unionground-lab-ci-${baselineHash(runKey).slice(0, 12)}` };
  };
  const attemptId = "12345678-1234-1234-1234-123456789abc";
  const FROM_ZERO = { path: "from-zero", reason: "bootstrap" };
  const producedManifest = (build = fromZeroBuild("bootstrap")) => {
    const identity = physicalIdentity(NAMES.at(-1).slice(0, 14), RUNTIME);
    return { schema: 2, identity, key: physicalKey(identity), schemaSha256: baselineHash("schema"), orderedSchemaSha256: baselineHash("ordered"),
      archiveBytes: 9, state: STATE, source: SOURCE, build };
  };

  it("writes each lab to the ledger before starting it, round-trips the snapshot and cleans up both", async () => {
    const root = scratch("physical-build-");
    try {
      const calls = [];
      const stackFor = (target) => ({ target, events: [],
        produce: async (artifact, source, plan) => {
          const ledger = JSON.parse(readFileSync(join(root, "build.json"), "utf8"));
          expect(ledger.targets).toEqual([{ name: "producer", projectId: target.CI_DB_PROJECT_ID }]);
          calls.push(["produce", source, plan]);
          return { trustedDigest: "e".repeat(64), manifest: producedManifest() };
        },
        restore: async (artifact, digest) => { calls.push(["restore", digest]); return { suffix: [] }; },
        cleanup: () => calls.push(["cleanup", target.CI_DB_PROJECT_ID]) });
      const report = await buildPhysicalBaseline(root, { attemptId, source: SOURCE, plan: FROM_ZERO, prepare: prepareFor(root), stackFor });
      expect(report.complete).toBe(true);
      expect(report.targets.map(({ name }) => name)).toEqual(["producer", "round-trip"]);
      for (const target of report.targets) expect(target.projectId).toBe(physicalProjectId(root, attemptId, target.name));
      expect(calls.filter(([kind]) => kind !== "cleanup")).toEqual([["produce", SOURCE, FROM_ZERO], ["restore", "e".repeat(64)]]);
      expect(report.snapshot).toEqual(snapshotComparison(producedManifest(), "e".repeat(64)));
      expect(attemptOutputs(root, "auto")).toBe(`next=from-zero\nreason=bootstrap\nsnapshot=${JSON.stringify(report.snapshot)}\n`);
      // Each lab once when done with it, then again at the end.
      expect(calls.filter(([kind]) => kind === "cleanup")).toHaveLength(3);
      expect(JSON.parse(readFileSync(join(root, "build.json"), "utf8")).complete).toBe(true);
      await expect(buildPhysicalBaseline(root, { attemptId, source: SOURCE, plan: FROM_ZERO, prepare: prepareFor(root), stackFor })).rejects.toThrow(/already exists/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fails when the round trip had to apply a migration, and still cleans up", async () => {
    const root = scratch("physical-build-");
    try {
      const cleaned = [];
      const stackFor = (target) => ({ target, events: [],
        produce: async () => ({ trustedDigest: "e".repeat(64), manifest: producedManifest() }),
        restore: async () => ({ suffix: ["20991231000000_late.sql"] }),
        cleanup: () => cleaned.push(target.CI_DB_PROJECT_ID) });
      await expect(buildPhysicalBaseline(root, { attemptId, source: SOURCE, plan: FROM_ZERO, prepare: prepareFor(root), stackFor })).rejects.toThrow(/round trip applied/);
      const report = JSON.parse(readFileSync(join(root, "build.json"), "utf8"));
      expect(report.complete).toBe(false);
      expect(report.failure).toMatch(/round trip applied/);
      expect(new Set(cleaned)).toEqual(new Set(report.targets.map(({ projectId }) => projectId)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("builder attempt paths", () => {
  const attemptId = "12345678-1234-1234-1234-123456789abc";
  const prepareFor = (root) => async ({ runKey }) => {
    const name = runKey.split(":").at(-1);
    const target = lab(root, name.replace("-", ""), name === "producer" ? 55000 : 55010);
    return { ...target, CI_DB_PROJECT_ID: `unionground-lab-ci-${baselineHash(runKey).slice(0, 12)}` };
  };
  const identity = physicalIdentity(NAMES.at(-1).slice(0, 14), RUNTIME);
  const produced = (build) => ({ schema: 2, identity, key: physicalKey(identity), schemaSha256: baselineHash("schema"), orderedSchemaSha256: baselineHash("ordered"),
    archiveBytes: 9, state: STATE, source: SOURCE, build });
  const INCREMENTAL = { path: "incremental", reason: "fits", directory: "/runner/base", manifestSha256: "a".repeat(64), run: 30, commit: "3".repeat(40) };
  const attempt = async (plan, { produce, restore = async () => ({ suffix: [] }), compare = null } = {}) => {
    const root = scratch("physical-path-");
    try {
      const labs = [];
      const stackFor = (target) => ({ target, events: [], cleanup: () => {},
        produce: async (...args) => { labs.push("producer"); return produce(...args); },
        restore: async (...args) => { labs.push("round-trip"); return restore(...args); } });
      const result = await buildPhysicalBaseline(root, { attemptId, source: SOURCE, plan, compare, runner: { cpu: "AMD EPYC 9V74" }, prepare: prepareFor(root), stackFor })
        .catch((error) => error);
      return { result, labs, report: JSON.parse(readFileSync(join(root, "build.json"), "utf8")), outputs: attemptOutputs(root, plan.path === "incremental" ? "auto" : plan.path) };
    } finally { rmSync(root, { recursive: true, force: true }); }
  };

  it("builds incrementally on the chosen base and records the base, path and runner", async () => {
    const build = { ...CHAIN, base: { ...CHAIN.base } };
    let seen;
    const { result, report, labs } = await attempt(INCREMENTAL, { produce: async (_artifact, _source, plan) => { seen = plan; return { trustedDigest: "e".repeat(64), manifest: produced(build) }; } });
    expect(seen).toBe(INCREMENTAL);
    expect(result.complete).toBe(true);
    expect(labs).toEqual(["producer", "round-trip"]);
    expect(report).toMatchObject({ path: "incremental", reason: "fits", base: { run: 30, commit: "3".repeat(40), manifestSha256: "a".repeat(64) },
      runner: { cpu: "AMD EPYC 9V74" }, manifest: { build }, snapshot: { path: "incremental", manifestSha256: "e".repeat(64) } });
  });

  it("hands the next attempt a replay from zero only when the base itself was refused", async () => {
    const baseRefused = Object.assign(new Error("physical schema digest mismatch"), { baseRefused: true });
    const refused = await attempt(INCREMENTAL, { produce: async () => { throw baseRefused; } });
    expect(refused.report).toMatchObject({ complete: false, baseRefused: true });
    expect(refused.outputs).toBe("next=from-zero\nreason=the previous attempt could not restore main run 30's snapshot: physical schema digest mismatch\n");
    // The round trip refusing this attempt's own snapshot is not the base's fault.
    const roundTrip = await attempt(INCREMENTAL, { produce: async () => ({ trustedDigest: "e".repeat(64), manifest: produced(CHAIN) }), restore: async () => { throw baseRefused; } });
    expect(roundTrip.report.baseRefused).toBeUndefined();
    expect(roundTrip.outputs).toBe("next=auto\nreason=\n");
  });

  it("runs the full replay from zero, compares it without a round trip, and stops the replays on a difference", async () => {
    const snapshot = snapshotComparison(produced(CHAIN), "d".repeat(64));
    const plan = { path: "compare", reason: "periodic" };
    let seen;
    const same = await attempt(plan, { compare: snapshot, produce: async (_artifact, _source, given) => { seen = given; return { trustedDigest: "e".repeat(64), manifest: produced(fromZeroBuild("periodic")) }; } });
    expect(seen).toEqual({ path: "from-zero", reason: "periodic" });
    expect(same.result.complete).toBe(true);
    expect(same.labs).toEqual(["producer"]);
    expect(same.report).toMatchObject({ path: "compare", comparedWith: { run: SOURCE.run, manifestSha256: "d".repeat(64) }, mismatches: [] });
    expect(same.report.snapshot).toBeUndefined();
    const differs = await attempt(plan, { compare: snapshot, produce: async () => ({ trustedDigest: "e".repeat(64), manifest: { ...produced(fromZeroBuild("periodic")), schemaSha256: "f".repeat(64) } }) });
    expect(differs.result.message).toMatch(/full replay differs from main run 41's snapshot .*schemaSha256/);
    expect(differs.outputs).toBe("next=stop\nreason=\n");
  });

  it("refuses a plan it does not know or a replay with nothing to compare", async () => {
    const root = scratch("physical-path-");
    try {
      for (const [plan, compare] of [[undefined, null], [{ path: "guess", reason: "x" }, null], [{ path: "from-zero" }, null], [{ path: "compare", reason: "x" }, null],
        [{ path: "from-zero", reason: "x" }, { run: 1 }]]) {
        await expect(buildPhysicalBaseline(root, { attemptId, source: SOURCE, plan, compare })).rejects.toThrow(/invalid physical build plan/);
      }
      expect(existsSync(join(root, "build.json"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("takes its plan from the inputs and the fetch's decision, and refuses one it cannot trust", () => {
    const root = scratch("physical-plan-");
    try {
      const record = join(root, "record.json");
      const write = (value) => writeFileSync(record, JSON.stringify(value));
      const env = (extra) => ({ PHYSICAL_BASELINE_PATH: "auto", PHYSICAL_DB_BASELINE_RECORD: record, ...extra });
      write({ mode: "warm", source: { run: 30, commit: "3".repeat(40), manifestSha256: "a".repeat(64) }, suffix: [NAMES.at(-1)] });
      expect(attemptPlan(env({ PHYSICAL_DB_BASELINE_MODE: "warm", PHYSICAL_DB_BASELINE_DIRECTORY: "/runner/base", PHYSICAL_DB_BASELINE_MANIFEST_SHA256: "a".repeat(64) })).plan)
        .toEqual({ ...INCREMENTAL, reason: "main run 30's snapshot fits this tree; 1 newer migration(s) to apply" });
      expect(() => attemptPlan(env({ PHYSICAL_DB_BASELINE_MODE: "warm", PHYSICAL_DB_BASELINE_DIRECTORY: "/runner/base", PHYSICAL_DB_BASELINE_MANIFEST_SHA256: "b".repeat(64) })))
        .toThrow(/no verified base/);
      expect(() => attemptPlan(env({ PHYSICAL_DB_BASELINE_MODE: "cold" }))).toThrow(/decision and its record disagree/);
      expect(() => attemptPlan(env({ PHYSICAL_DB_BASELINE_MODE: undefined, PHYSICAL_DB_BASELINE_RECORD: undefined }))).toThrow(/decision and its record disagree/);
      write({ mode: "cold", reason: "bootstrap: none yet" });
      expect(attemptPlan(env({ PHYSICAL_DB_BASELINE_MODE: "cold" })).plan).toEqual({ path: "from-zero", reason: "bootstrap: none yet" });
      expect(attemptPlan({ PHYSICAL_BASELINE_PATH: "from-zero", PHYSICAL_BASELINE_REASON: "requested" }).plan).toEqual({ path: "from-zero", reason: "requested" });
      const snapshot = snapshotComparison(produced(CHAIN), "d".repeat(64));
      expect(attemptPlan({ PHYSICAL_BASELINE_PATH: "compare", PHYSICAL_BASELINE_COMPARE: JSON.stringify(snapshot) })).toMatchObject({ plan: { path: "compare" }, compare: snapshot });
      expect(() => attemptPlan({ PHYSICAL_BASELINE_PATH: "compare", PHYSICAL_BASELINE_COMPARE: "" })).toThrow(/needs the snapshot this run built/);
      expect(() => attemptPlan({ PHYSICAL_BASELINE_PATH: "" })).toThrow(/unknown physical build path/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("cleanup by ledger", () => {
  const attemptId = "12345678-1234-1234-1234-123456789abc";

  it("removes only the exact inspected containers of each project the ledger derives", () => {
    const root = scratch("physical-cleanup-");
    try {
      const targets = ["producer", "round-trip"].map((name) => ({ name, projectId: physicalProjectId(root, attemptId, name) }));
      expect(physicalProjectId(root, attemptId, "producer")).toBe(`unionground-lab-ci-${baselineHash(physicalRunKey(root, attemptId, "producer")).slice(0, 12)}`);
      writeFileSync(join(root, "build.json"), JSON.stringify({ attemptId, targets }));
      const removed = [];
      const listed = new Map(targets.map(({ projectId }, index) => [projectId, [String(index + 1).repeat(64)]]));
      const run = (label, command, args) => {
        if (label === "cleanup-local-docker-context") return "unix:///var/run/docker.sock";
        const project = args.find((arg) => arg.startsWith("label="))?.slice("label=com.supabase.cli.project=".length);
        if (label === "cleanup-list") return (listed.get(project) ?? []).map((id) => id.slice(0, 12)).join("\n");
        if (label === "cleanup-inspect") {
          const owner = [...listed].find(([, ids]) => ids[0].startsWith(args[1]))[0];
          return JSON.stringify([{ Id: listed.get(owner)[0], Config: { Labels: { "com.supabase.cli.project": owner } } }]);
        }
        if (label === "cleanup-remove") {
          removed.push(args[2]);
          for (const [owner, ids] of listed) if (ids.includes(args[2])) listed.set(owner, []);
          return "";
        }
        throw new Error(`unexpected ${label}`);
      };
      cleanupPhysicalBuild(root, { run });
      expect(removed).toEqual(["2".repeat(64), "1".repeat(64)]);
      expect(() => assertCleanupLedger(root, { attemptId, targets: [{ name: "producer", projectId: "unionground-lab-ci-000000000000" }] })).toThrow(/ownership mismatch/);
      expect(() => assertCleanupLedger(root, { attemptId, targets: [{ name: "other", projectId: physicalProjectId(root, attemptId, "other") }] })).toThrow(/ownership mismatch/);
      expect(() => removePhysicalProject("supabase_db_other", run)).toThrow(/invalid physical cleanup project/);
      cleanupPhysicalBuild(join(root, "missing"), { run: () => { throw new Error("must not run"); } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a container whose label names another project", () => {
    const id = "f".repeat(64);
    const run = (label) => label === "cleanup-list" ? id.slice(0, 12) : JSON.stringify([{ Id: id, Config: { Labels: { "com.supabase.cli.project": "unionground-lab-ci-bbbbbbbbbbbb" } } }]);
    expect(() => removePhysicalProject("unionground-lab-ci-aaaaaaaaaaaa", run)).toThrow(/ownership mismatch/);
  });
});

describe("choosing the baseline in the db job", () => {
  const producerRun = (id, extra = {}) => ({ id, path: ".github/workflows/disposable-db-baseline.yml", event: "push", head_branch: "main", status: "completed",
    conclusion: "success", head_sha: String(id % 10).repeat(40), repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, ...extra });

  it("trusts only completed producer runs on main in this repository, from a push, the schedule or a dispatch", () => {
    const runs = [producerRun(9), producerRun(8, { event: "pull_request" }), producerRun(7, { head_branch: "feature" }), producerRun(6, { status: "in_progress" }),
      producerRun(5, { head_repository: { full_name: "fork/union-ground" } }), producerRun(4, { event: "schedule", conclusion: "failure" }),
      producerRun(3, { event: "workflow_dispatch" }), producerRun(2, { path: ".github/workflows/ci.yml" })];
    expect(selectTrustedRuns(runs, REPOSITORY).map((run) => run.id)).toEqual([9, 4, 3]);
  });

  // GitHub, gh and unzip stubbed: `snapshots` maps a producer run id to the
  // snapshot it published (written with this tree's real identity), or null.
  function fetchFixture({ runs, snapshots, listStatus = 0, listStderr = "", repository = REPOSITORY, trusted, zipFor = () => null, builder = false, runId = "1000", grantProbeMigrations = [] }) {
    const root = scratch("physical-fetch-");
    const env = { GITHUB_REPOSITORY: repository, RUNNER_TEMP: root, GITHUB_ENV: join(root, "env"), GITHUB_OUTPUT: join(root, "output"), GITHUB_STEP_SUMMARY: join(root, "summary"),
      GITHUB_RUN_ID: runId, CI_DB_GRANT_PROBE_ADDED: grantProbeMigrations.join(","), ...(trusted ? { PHYSICAL_DB_BASELINE_REPOSITORY: trusted } : {}) };
    const calls = [], logs = [];
    const sources = join(root, "sources");
    const zips = new Map();
    for (const [id, options] of Object.entries(snapshots)) {
      if (!options) continue;
      writeSnapshot(join(sources, id), { source: { commit: String(Number(id) % 10).repeat(40), run: Number(id) }, ...options });
      zips.set(Number(id), zipFor(Number(id)) ?? Buffer.from(`zip ${id}`));
    }
    const execute = (command, args) => {
      calls.push([command, ...args].join(" "));
      const endpoint = args.at(-1);
      if (endpoint.includes("/workflows/")) return listStatus ? { status: listStatus, stdout: "", stderr: listStderr } : { status: 0, stdout: JSON.stringify({ workflow_runs: runs }) };
      const runId = Number(endpoint.match(/runs\/(\d+)\/artifacts/)?.[1]);
      if (runId) {
        return { status: 0, stdout: JSON.stringify({ artifacts: snapshots[runId] ? [{ id: runId * 10, name: "physical-disposable-baseline", size_in_bytes: 99, expired: false,
          digest: `sha256:${baselineHash(Buffer.from(`zip ${runId}`))}` }, { id: 1, name: "physical-db-baseline-build-1", expired: false }] : [] }) };
      }
      const artifactId = Number(endpoint.match(/artifacts\/(\d+)\/zip/)?.[1]);
      if (artifactId) return { status: 0, stdout: zips.get(artifactId / 10) };
      if (command === "unzip" && args[0] === "-Z1") return { status: 0, stdout: "manifest.json\ndata.tgz\n" };
      if (command === "unzip") {
        const id = args.at(-1).split("-").at(-1);
        for (const name of ["manifest.json", "data.tgz"]) writeFileSync(join(args.at(-1), name), readFileSync(join(sources, id, name)));
        return { status: 0, stdout: "" };
      }
      throw new Error(`unexpected ${command} ${args.join(" ")}`);
    };
    const decision = fetchPhysicalBaseline(env, { log: (line) => logs.push(line), execute, builder });
    const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : "";
    const result = { decision, calls, logs, exported: read(env.GITHUB_ENV), output: read(env.GITHUB_OUTPUT), summary: read(env.GITHUB_STEP_SUMMARY),
      record: existsSync(join(root, "physical-db-baseline-record.json")) ? JSON.parse(read(join(root, "physical-db-baseline-record.json"))) : null,
      kept: readdirSync(root).filter((name) => name.startsWith("physical-db-baseline-") && !name.endsWith(".json")), root };
    rmSync(root, { recursive: true, force: true });
    return result;
  }
  const behind = { edit: (m) => ({ ...m, identity: { ...m.identity, prefix: "20991231000000" } }) };

  it("restores the newest snapshot that fits and records its source and the migrations to apply on top", () => {
    const prefix = NAMES.at(-2).slice(0, 14);
    const { decision, exported, output, summary, record, kept, root, logs } = fetchFixture({ runs: [producerRun(30), producerRun(20)], snapshots: { 30: { prefix }, 20: {} } });
    expect(decision.mode).toBe("warm");
    expect(decision.source).toMatchObject({ run: 30, commit: "0".repeat(40), prefix });
    expect(decision.suffix).toEqual([NAMES.at(-1)]);
    expect(exported).toBe([`PHYSICAL_DB_BASELINE_MODE=warm`, `PHYSICAL_DB_BASELINE_RECORD=${join(root, "physical-db-baseline-record.json")}`,
      `PHYSICAL_DB_BASELINE_DIRECTORY=${join(root, "physical-db-baseline-30")}`, `PHYSICAL_DB_BASELINE_MANIFEST_SHA256=${decision.source.manifestSha256}`].join("\n") + "\n");
    expect(output).toBe("mode=warm\n");
    expect(kept).toEqual(["physical-db-baseline-30"]);
    expect(record).toMatchObject({ mode: "warm", suffix: [NAMES.at(-1)], source: { run: 30 } });
    expect(summary).toContain(`main ${"0".repeat(40)} (producer run 30`);
    expect(logs.some((line) => line.startsWith("::"))).toBe(false);
  });

  it("goes back past snapshots a branch behind main cannot hold, within the look-back", () => {
    const { decision, logs, calls } = fetchFixture({ runs: [producerRun(50), producerRun(41), producerRun(40)], snapshots: { 50: behind, 41: null, 40: {} } });
    expect(decision.mode).toBe("warm");
    expect(decision.source.run).toBe(40);
    expect(logs[0]).toMatch(/run 50 does not fit this tree: .*lacks the snapshot's last migration/);
    // Run 41 published nothing (every attempt failed): not a candidate, nothing downloaded.
    expect(calls.some((call) => call.includes("artifacts/410/zip"))).toBe(false);
  });

  it("fails the job when no recent snapshot fits the branch's migrations, after a bounded look-back", () => {
    const ids = Array.from({ length: PHYSICAL_SNAPSHOT_LOOKBACK + 2 }, (_, index) => 90 - index);
    const { decision, exported, output, record, kept, logs } = fetchFixture({ runs: ids.map((id) => producerRun(id)), snapshots: Object.fromEntries(ids.map((id) => [id, behind])) });
    expect(decision.mode).toBe("refused");
    expect(decision.reason).toMatch(new RegExp(`none of the ${PHYSICAL_SNAPSHOT_LOOKBACK} newest main snapshots fits this tree`));
    expect(decision.reason).toMatch(/Update the branch from main/);
    expect(record.refusedSnapshots).toHaveLength(PHYSICAL_SNAPSHOT_LOOKBACK);
    expect(exported).toBe("");
    expect(output).toBe("mode=refused\n");
    expect(kept).toEqual([]);
    expect(logs.at(-1)).toMatch(/^::error::PHYSICAL BASELINE REFUSED/);
  });

  it("refuses bytes that disagree with GitHub's digest without extracting them", () => {
    const { decision, calls } = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: {} }, zipFor: () => Buffer.from("tampered") });
    expect(decision.mode).toBe("refused");
    expect(decision.reason).toMatch(/ZIP digest mismatch/);
    expect(calls.some((call) => call.startsWith("unzip"))).toBe(false);
  });

  it("refuses a manifest that names another producer run or commit", () => {
    const { decision } = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: { source: { commit: "9".repeat(40), run: 30 } } } });
    expect(decision.mode).toBe("refused");
    expect(decision.reason).toMatch(/names producer run 30 at 9{40}, not run 30 at 0{40}/);
  });

  it("replays from zero, loudly, for the bootstrap or a changed stack input", () => {
    const missing = fetchFixture({ runs: [], snapshots: {}, listStatus: 1, listStderr: "gh: Not Found (HTTP 404)" });
    expect(missing.decision).toMatchObject({ mode: "cold", reason: expect.stringMatching(/bootstrap: .*not on main yet/) });
    expect(missing.exported).toBe(`PHYSICAL_DB_BASELINE_MODE=cold\nPHYSICAL_DB_BASELINE_RECORD=${join(missing.root, "physical-db-baseline-record.json")}\n`);
    expect(missing.logs.at(-1)).toMatch(/^::warning::PHYSICAL BASELINE COLD REPLAY: bootstrap/);
    expect(missing.summary).toMatch(/replay every migration from zero/);

    const expired = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: null } });
    expect(expired.decision).toMatchObject({ mode: "cold", reason: expect.stringMatching(/bootstrap: no main run .* live snapshot/) });

    const changed = { edit: (m) => ({ ...m, identity: { ...m.identity, packages: [["supabase", "2.0.0", "x"], m.identity.packages[1]] } }) };
    const input = fetchFixture({ runs: [producerRun(30), producerRun(20)], snapshots: { 30: changed, 20: changed } });
    expect(input.decision.mode).toBe("cold");
    expect(input.decision.reason).toMatch(/alters a stack input .*packages supabase/);

    // A stack input change on a branch that is also behind main still replays.
    const both = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: { edit: (m) => ({ ...changed.edit(m), identity: { ...changed.edit(m).identity, prefix: "20991231000000" } }) } } });
    expect(both.decision.mode).toBe("cold");
  });

  it("looks for an older snapshot before it replays migrations needed by the grant probe", () => {
    const runs = [producerRun(30), producerRun(20)];
    const grantProbeMigrations = [NAMES.at(-1)];
    const prefix = NAMES.at(-2).slice(0, 14);
    const warm = fetchFixture({ runs, snapshots: { 30: {}, 20: { prefix } }, grantProbeMigrations });
    expect(warm.decision).toMatchObject({ mode: "warm", source: { run: 20 }, suffix: grantProbeMigrations });
    const cold = fetchFixture({ runs, snapshots: { 30: {}, 20: {} }, grantProbeMigrations });
    expect(cold.decision).toMatchObject({ mode: "cold", reason: expect.stringMatching(/must run under the public-table grant probe/) });
  });

  it("fails rather than guess when GitHub cannot be read or the repository is not this one", () => {
    const outage = fetchFixture({ runs: [], snapshots: {}, listStatus: 1, listStderr: "gh: Server Error (HTTP 502)" });
    expect(outage.decision.mode).toBe("refused");
    expect(outage.decision.reason).toMatch(/HTTP 502/);
    // A deployment that pins its repository refuses a run anywhere else.
    const fork = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: {} }, repository: "someone/union-ground", trusted: REPOSITORY });
    expect(fork.decision).toMatchObject({ mode: "refused", reason: "untrusted repository someone/union-ground" });
    expect(fork.calls).toEqual([]);
    const unknown = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: {} }, repository: "" });
    expect(unknown.decision).toMatchObject({ mode: "refused", reason: "untrusted repository " });
  });

  // A snapshot whose identity names an edited earlier migration, or lacks one
  // that now sorts before its prefix (a reordered history).
  const edited = { edit: (m) => ({ ...m, identity: { ...m.identity, migrations: m.identity.migrations.map(([name, hash], index) => [name, index === 5 ? "0".repeat(64) : hash]) } }) };
  const reordered = { edit: (m) => ({ ...m, identity: { ...m.identity, migrations: m.identity.migrations.filter((_, index) => index !== 5) } }) };
  const changedInput = { edit: (m) => ({ ...m, identity: { ...m.identity, packages: [["supabase", "2.0.0", "x"], m.identity.packages[1]] } }) };

  it("shows the pull request how its snapshot was built, and refuses one whose chain it cannot verify", () => {
    const chained = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: { build: { ...CHAIN, base: { ...CHAIN.base, run: 25 }, root: { ...CHAIN.root, run: 21 } } } } });
    expect(chained.decision.mode).toBe("warm");
    expect(chained.record.source.build).toMatchObject({ path: "incremental", depth: 2, applied: NAMES.slice(-2) });
    expect(chained.summary).toContain(`built incrementally on main run 25's snapshot (commit ${"3".repeat(40)}, manifest ${"a".repeat(64)}) by applying ${NAMES.slice(-2).join(", ")}; 2 incremental build(s) since the from-zero snapshot of run 21`);
    const legacy = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: {} } });
    expect(legacy.summary).toContain("replayed every migration from zero (schema 1 snapshot, before incremental builds)");

    const broken = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: { build: { ...CHAIN, applied: NAMES.slice(-1) } } } });
    expect(broken.decision.mode).toBe("refused");
    expect(broken.decision.reason).toMatch(/applied migrations are not exactly those after the base's prefix/);
    expect(broken.exported).toBe("");
  });

  it("holds the prefix rule: an edited or reordered earlier migration refuses the pull request and sends the builder from zero", () => {
    for (const [label, change] of [["edited", edited], ["reordered", reordered]]) {
      const pr = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: change } });
      expect(pr.decision.mode, label).toBe("refused");
      expect(pr.decision.reason, label).toMatch(new RegExp(`identity mismatch: migrations ${NAMES[5]}`));
      const built = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: change }, builder: true });
      expect(built.decision.mode, label).toBe("cold");
      expect(built.decision.reason, label).toMatch(/none of the 1 newest main snapshots is a prefix of this tree's migrations .*only a replay from zero/);
      expect(built.summary, label).toMatch(/Snapshot base: none; this attempt replays every migration from zero/);
    }
  });

  it("builds incrementally on the newest fitting snapshot older than its own run, and replays from zero for a changed stack input", () => {
    const prefix = NAMES.at(-2).slice(0, 14);
    const warm = fetchFixture({ runs: [producerRun(1000), producerRun(30), producerRun(20)], snapshots: { 1000: {}, 30: { prefix }, 20: {} }, builder: true, runId: "1000" });
    expect(warm.decision).toMatchObject({ mode: "warm", source: { run: 30, prefix }, suffix: [NAMES.at(-1)] });
    expect(warm.calls.some((call) => call.includes("runs/1000/artifacts"))).toBe(false);
    expect(warm.summary).toContain("Migrations this build applies on top: " + NAMES.at(-1));

    const input = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: changedInput }, builder: true });
    expect(input.decision.mode).toBe("cold");
    expect(input.decision.reason).toMatch(/alters a stack input .*packages supabase/);

    const bootstrap = fetchFixture({ runs: [producerRun(30)], snapshots: { 30: null }, builder: true });
    expect(bootstrap.decision).toMatchObject({ mode: "cold", reason: expect.stringMatching(/^bootstrap/) });

    // An unreadable API, or no run id to order the chain by, fails the attempt.
    expect(fetchFixture({ runs: [], snapshots: {}, listStatus: 1, listStderr: "HTTP 502", builder: true }).decision.mode).toBe("refused");
    expect(fetchFixture({ runs: [producerRun(30)], snapshots: { 30: {} }, builder: true, runId: "" }).decision).toMatchObject({ mode: "refused", reason: expect.stringMatching(/GITHUB_RUN_ID/) });
  });
});
