// Ported on November 11, 2026 from an earlier repository's
// tests/repository-conventions.test.js (at 7ecfc1101c)
// with scripts/verify-repository-conventions.mjs. "upstream #N" names that
// repository's pull requests, not this one's.
//
// The conventions are only worth documenting if a violation fails a required
// check, so every rule the documents state is exercised here against a fixture
// repository, plus the shipped tree itself.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stamp } from "../scripts/lib/provenance.mjs";
import {
  ADDED_FILE_MAX_BYTES,
  addedFileFindings,
  overrideRegisterFindings,
  lockfileLibcFindings,
  scopedOverrideFindings,
  provenanceFindings,
} from "../scripts/verify-repository-conventions.mjs";
import { runnerTimeoutMultiplier } from "../scripts/lib/runner-timeout.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptSource = join(repoRoot, "scripts", "verify-repository-conventions.mjs");
const libcPolicy = JSON.parse(readFileSync(join(repoRoot, "config/dependency-overrides.json"), "utf8")).lockfileLibc;
// Coverage runs of the verifier took 43–47 seconds on a 2-vCPU shard.
const conventionsTimeout = 90_000 * runnerTimeoutMultiplier();
const created = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "psg-conventions-"));
  created.push(root);
  for (const dir of [
    "scripts",
    "config",
    "supabase/migrations",
    "docs/conventions",
    "api",
  ]) mkdirSync(join(root, dir), { recursive: true });
  cpSync(scriptSource, join(root, "scripts", "verify-repository-conventions.mjs"));
  mkdirSync(join(root, "scripts", "lib"), { recursive: true });
  for (const name of ["provenance.mjs", "db-contract-inventories.mjs", "db-contract-tables.mjs", "inline-operation-key-scan.mjs", "swallowed-error-scan.mjs", "eastern-time-scan.mjs", "fixed-zone-scan.mjs"]) {
    cpSync(join(repoRoot, "scripts/lib", name), join(root, "scripts/lib", name));
  }
  for (const name of [
    "migration-naming.md",
    "rls-policy-comments.md",
    "provenance.md",
  ]) writeFileSync(join(root, "docs", "conventions", name), "# fixture\n");
  writeFileSync(join(root, "api", "example.js"), "export const example = 1;\n");
  writeMigration(root, "20260906010000_initial.sql", "begin;\ncommit;\n");
  writeBaseline(root, {});
  writeDatabaseAssuranceCliPin(root);
  writeFileSync(join(root, "config/dependency-overrides.json"), JSON.stringify({ schema: 1, manifests: {}, lockfileLibc: libcPolicy }));
  for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"], ["update-ref", "refs/remotes/origin/main", "HEAD"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  return root;
}

function writeMigration(root, name, sql, { wrap = true } = {}) {
  const content = wrap && !/^\s*begin\s*;/i.test(sql)
    ? `begin;\n${sql}\ncommit;\n`
    : sql;
  writeFileSync(join(root, "supabase", "migrations", name), content);
}

// The database assurance CLI pin lives in two files that must agree: the
// `supabase` devDependency and the reviewed baseline the lane's version guard
// reads. The fixture writes a matching pair so every other case judges what it
// is about.
function writeDatabaseAssuranceCliPin(root, {
  manifest = "2.109.1",
  baseline = "2.109.1",
  locked = null,
  lockedPlatform = null,
  omitLockEntry = false,
  omitPlatform = false,
  nestedPlatform = null,
  declared = null,
} = {}) {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "fixture",
      private: true,
      devDependencies: manifest === null ? {} : { supabase: manifest },
    }, null, 2)}\n`,
  );
  const packages = { "": { name: "fixture" } };
  if (!omitLockEntry) {
    packages["node_modules/supabase"] = {
      version: locked ?? manifest,
      optionalDependencies: declared === null
        ? undefined
        : { "@supabase/cli-linux-x64": declared ?? locked ?? manifest },
    };
  }
  if (!omitPlatform) {
    packages["node_modules/@supabase/cli-linux-x64"] = { version: lockedPlatform ?? locked ?? manifest };
    packages["node_modules/@supabase/cli-darwin-arm64"] = { version: locked ?? manifest };
  }
  if (nestedPlatform) {
    packages["node_modules/supabase/node_modules/@supabase/cli-linux-x64"] = { version: nestedPlatform };
  }
  packages["node_modules/@supabase/client"] = { version: "9.9.9" };
  writeFileSync(
    join(root, "package-lock.json"),
    `${JSON.stringify({ name: "fixture", lockfileVersion: 3, packages }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "config", "database-assurance-baseline.json"),
    `${JSON.stringify({
      version: 1,
      sourceSha: "3b3735d4f0f59750e38b5133cf24ce64bed54dce",
      supabaseCliVersion: baseline,
      findings: [],
    }, null, 2)}\n`,
  );
}

function writeBaseline(root, overrides) {
  writeFileSync(
    join(root, "config", "migration-conventions-baseline.json"),
    `${JSON.stringify({
      schema: 1,
      adoptedOn: "2026-09-06",
      note: "fixture baseline",
      policyCommentExempt: [],
      duplicateSlugExempt: [],
      ...overrides,
    }, null, 2)}\n`,
  );
}

// Clear the Actions event context too, so a main push run of this suite still
// exercises the failing (pull-request and local) behaviour by default.
const neutralEnv = { CONVENTIONS_BASE_REF: "", CI_BASE_SHA: "", GITHUB_EVENT_NAME: "", GITHUB_REF: "" };

function runWith(env, root, ...args) {
  return spawnSync(
    process.execPath,
    [join(root, "scripts", "verify-repository-conventions.mjs"), ...args],
    { cwd: root, encoding: "utf8", env: { ...process.env, ...neutralEnv, ...env } },
  );
}

function run(root, ...args) {
  return runWith({}, root, ...args);
}

function green(root, env = {}) {
  return runWith(env, root);
}

describe("Eastern time conventions", () => {
  // SYS-UG-SHARED-EASTERN-TIME-GUARD-20261113: a new migration may
  // not read the UTC session day, and a new time needs its zone label.
  it("refuses a new migration that reads the session's day unless it says why", () => {
    const root = fixture();
    writeMigration(root, "20261113180000_due_today.sql", "begin;\nselect current_date;\nselect now()::date; -- utc-day: retention cut-off\ncommit;\n");
    writeMigration(root, "20261113115000_before_helper.sql", "begin;\nselect current_date;\ncommit;\n");
    expect(spawnSync("git", ["add", "supabase/migrations"], { cwd: root }).status).toBe(0);
    const result = green(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supabase/migrations/20261113180000_due_today.sql:2: reads the session's (UTC) day");
    expect(result.stderr).not.toContain("20261113180000_due_today.sql:3");
    expect(result.stderr).not.toContain("20261113115000_before_helper.sql");
  });

  it("refuses a new time formatter without a zone label and a known count that should shrink", () => {
    const root = fixture();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "clock.js"), "export const at = { hour: \"numeric\" };\nexport const shown = { hour: \"numeric\" }; // zone-labelled\n");
    writeFileSync(join(root, "config", "eastern-time-known.json"), JSON.stringify({ files: { "src/gone.js": 1 } }));
    expect(spawnSync("git", ["add", "src/clock.js"], { cwd: root }).status).toBe(0);
    const result = green(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/clock.js: 1 time formatter(s) without a zone label (known 0)");
    expect(result.stderr).toContain("src/gone.js now has 0 unlabelled time formatter(s); lower its known count from 1 to 0");
  });
});

describe("swallowed error conventions", () => {
  // SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113: a new catch may not
  // turn a failure into an empty answer without saying why.
  it("refuses a new swallowing catch and a known count that should shrink", () => {
    const root = fixture();
    writeFileSync(join(root, "api", "quiet.js"), "export const read = (load) => load().catch(() => []);\nexport const ok = (load) => load().catch(() => null); // swallow-ok: optional prefetch\n");
    writeFileSync(join(root, "config", "swallowed-error-known.json"), JSON.stringify({ files: { "api/gone.js": 1 } }));
    expect(spawnSync("git", ["add", "api/quiet.js"], { cwd: root }).status).toBe(0);
    const result = green(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("api/quiet.js: 1 catch(es) that swallow the error (known 0)");
    expect(result.stderr).toContain("api/gone.js now has 0 swallowing catch(es); lower its known count from 1 to 0");
  });
});

describe("inline operation key conventions", () => {
  // SYS-UG-SHARED-RETRY-IDEMPOTENCY-GUARD-20261113: a key minted at
  // the call gives every retry a new key; the known list only shrinks.
  const minted = "export const send = (rpc) => rpc('x', { p_idempotency_key: crypto.randomUUID() });\n";

  it("refuses a new operation key minted at the call", () => {
    const root = fixture();
    writeFileSync(join(root, "api", "send.js"), minted);
    expect(spawnSync("git", ["add", "api/send.js"], { cwd: root }).status).toBe(0);
    const result = green(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("api/send.js: 1 operation key(s) minted at the call (known 0)");
  });

  it("accepts a listed case and refuses a listed count the file no longer reaches", () => {
    const root = fixture();
    writeFileSync(join(root, "api", "send.js"), minted);
    writeFileSync(join(root, "config", "inline-operation-key-known.json"), JSON.stringify({ files: { "api/send.js": 1, "api/gone.js": 1 } }));
    expect(spawnSync("git", ["add", "api/send.js"], { cwd: root }).status).toBe(0);
    const result = green(root);
    expect(result.stderr).not.toContain("api/send.js: 1 operation key(s)");
    expect(result.stderr).toContain("api/gone.js now has 0 inline operation key(s); lower its known count from 1 to 0");
  });
});

describe("Supabase logs endpoint conventions", () => {
  // Removing the endpoint check must let these retired callers through and
  // fail this regression. Assemble the forbidden example so the test source
  // itself never becomes a retired-endpoint example to copy.
  const retiredEndpoint = ["analytics", "endpoints", "logs.all"].join("/");

  it.each([
    "scripts/log-sweep.mjs",
    "api/log-sweep.js",
    "supabase/functions/log-sweep/index.ts",
    ".github/workflows/log-sweep.yml",
    "docs/operations/log-sweep.md",
    "docs/operations/evidence-copy/log-sweep.md",
  ])("rejects a retired endpoint in tracked %s", (path) => {
    const root = fixture();
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `https://api.supabase.com/v1/projects/example/${retiredEndpoint}\n`);
    expect(spawnSync("git", ["add", path], { cwd: root }).status).toBe(0);

    const result = green(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${path}: retired Supabase logs endpoint`);
  });

  it("accepts the current endpoint and preserves historical evidence", () => {
    const root = fixture();
    const path = "docs/operations/evidence/vendor-schema.json";
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify({ path: retiredEndpoint }));
    writeFileSync(join(root, "scripts/log-sweep.mjs"), 'const endpoint = "analytics/endpoints/logs";\n');
    expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);

    const result = green(root);

    expect(result.status).toBe(0);
    expect(readFileSync(join(root, path), "utf8")).toBe(JSON.stringify({ path: retiredEndpoint }));
  });
});

describe("added-file policy", () => {
  function add(root, path, bytes) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), Buffer.alloc(bytes, 1));
    expect(spawnSync("git", ["add", path], { cwd: root }).status).toBe(0);
  }

  it.each(["shot.png", "shot.JPG", "shot.jpeg", "shot.webp", "shot.gif", "report.pdf", "dump.json.gz"])(
    "refuses a newly added evidence binary %s and names where it goes",
    (name) => {
      const root = fixture();
      const path = `docs/operations/evidence/operator-acceptance/c99/${name}`;
      add(root, path, 10);

      const result = green(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${path}: new binary evidence is not committed to main; attach it to the issue or pull request instead`);
    },
  );

  it("refuses any newly added file over 1 MB and accepts one at the limit", () => {
    const root = fixture();
    add(root, "public/at-limit.bin", 1024 * 1024);
    add(root, "public/over-limit.bin", 1024 * 1024 + 1);

    const result = green(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("public/over-limit.bin: new file is 1048577 bytes, over the 1 MB limit");
    expect(result.stderr).not.toContain("public/at-limit.bin");
  });

  // A name that is not valid UTF-8 used to decode to
  // a different string, look absent on disk and skip the policy.
  it("refuses a newly added file over 1 MB whose name is not valid UTF-8", () => {
    const root = fixture();
    mkdirSync(join(root, "public"), { recursive: true });
    writeFileSync(Buffer.concat([Buffer.from(join(root, "public", "b")), Buffer.from([0xff]), Buffer.from(".bin")]), Buffer.alloc(1024 * 1024 + 1, 1));
    expect(spawnSync("git", ["add", "-A", "public"], { cwd: root }).status).toBe(0);

    const result = green(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"public/b\ufffd.bin" (a name that is not valid UTF-8): new file is 1048577 bytes, over the 1 MB limit');
  });

  function commitAsDefaultBranch(root) {
    for (const args of [["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "history"], ["update-ref", "refs/remotes/origin/main", "HEAD"]]) {
      expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
    }
  }

  it("leaves retained evidence and text evidence alone", () => {
    const root = fixture();
    add(root, "docs/operations/evidence/old/shot.png", 10);
    add(root, "docs/operations/evidence/old/notes.txt", 10);
    commitAsDefaultBranch(root);
    writeFileSync(join(root, "docs/operations/evidence/old/notes.txt"), Buffer.alloc(20, 2));
    add(root, "docs/operations/evidence/old/hashes.txt", 10);

    expect(green(root).status).toBe(0);
  });

  // A pure rename adds no bytes; replacing the bytes
  // of an existing path is judged like an addition.
  it("accepts a byte-identical rename of evidence or of a file over 1 MB", () => {
    const root = fixture();
    add(root, "docs/operations/evidence/old/shot.png", 10);
    add(root, "public/large.bin", 1024 * 1024 + 1);
    commitAsDefaultBranch(root);
    for (const [from, to] of [["docs/operations/evidence/old/shot.png", "docs/operations/evidence/moved/shot.png"], ["public/large.bin", "public/moved/large.bin"]]) {
      mkdirSync(dirname(join(root, to)), { recursive: true });
      expect(spawnSync("git", ["mv", from, to], { cwd: root }).status).toBe(0);
    }

    expect(green(root).status).toBe(0);
  });

  it("judges a rename that changes the bytes as an addition", () => {
    const root = fixture();
    add(root, "docs/operations/evidence/old/shot.png", 10);
    commitAsDefaultBranch(root);
    mkdirSync(join(root, "docs/operations/evidence/moved"), { recursive: true });
    expect(spawnSync("git", ["mv", "docs/operations/evidence/old/shot.png", "docs/operations/evidence/moved/shot.png"], { cwd: root }).status).toBe(0);
    add(root, "docs/operations/evidence/moved/shot.png", 11);

    const result = green(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/operations/evidence/moved/shot.png: new binary evidence is not committed to main");
  });

  it("refuses new bytes at an existing evidence binary or a file that crosses 1 MB", () => {
    const root = fixture();
    add(root, "docs/operations/evidence/old/shot.png", 10);
    add(root, "public/small.bin", 10);
    add(root, "public/already-large.json", 1024 * 1024 + 1);
    add(root, "public/large-jump.bin", 1024 * 1024 + 1);
    commitAsDefaultBranch(root);
    add(root, "docs/operations/evidence/old/shot.png", 20);
    add(root, "public/small.bin", 1024 * 1024 + 1);
    add(root, "public/already-large.json", 1024 * 1024 + 4096);
    add(root, "public/large-jump.bin", 3 * 1024 * 1024);

    const result = green(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/operations/evidence/old/shot.png: replaced binary evidence is not committed to main");
    expect(result.stderr).toContain("public/small.bin: replaced with 1048577 bytes (was 10), over the 1 MB limit");
    expect(result.stderr).toContain("public/large-jump.bin: replaced with 3145728 bytes (was 1048577), over the 1 MB limit");
    expect(result.stderr).not.toContain("public/already-large.json");
  });

  it("accepts an allowlisted path or folder and refuses an entry without a reason", () => {
    const root = fixture();
    add(root, "docs/operations/evidence/kept/shot.png", 10);
    add(root, "public/large.bin", 1024 * 1024 + 1);
    const allowlist = (entries) => writeFileSync(
      join(root, "config/repository-added-file-allowlist.json"),
      JSON.stringify({ schema: 1, entries }),
    );
    allowlist([
      { path: "docs/operations/evidence/kept/", reason: "fixture", record: "OPS-FIXTURE" },
      { path: "public/large.bin", reason: "fixture", record: "OPS-FIXTURE" },
    ]);
    expect(green(root).status).toBe(0);

    allowlist([{ path: "public/large.bin", record: "OPS-FIXTURE" }]);
    const result = green(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("config/repository-added-file-allowlist.json: entries[0] needs path, reason and record");
    expect(result.stderr).toContain("docs/operations/evidence/kept/shot.png: new binary evidence");
  });

  it("judges additions from the merge base, not a moved origin/main", () => {
    const root = fixture();
    const git = (...args) => expect(spawnSync("git", args, { cwd: root }).status).toBe(0);
    add(root, "docs/operations/evidence/base/shot.png", 10);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base evidence");
    git("branch", "feature");
    git("rm", "-q", "docs/operations/evidence/base/shot.png");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "main moves evidence out");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "-q", "feature");

    expect(green(root).status).toBe(0);
  });

  // OPS-UG-CI-PR-COMPARISON-BASE-BLOBS-FOR-CONVENTIONS-20261110:
  // CI fetches both lines with --filter=blob:none and then drops its token, so
  // a fork-point version that Main has changed since is tree data only.
  describe("on a blob-filtered clone of a pull request behind Main", () => {
    const commit = (cwd, message) => {
      for (const args of [["add", "-A"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message]]) {
        expect(spawnSync("git", args, { cwd }).status).toBe(0);
      }
      return spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim();
    };

    // held: paths whose Main (pull-request base) blob the clone holds, as the
    // trusted impact step's `git archive "$CI_BASE_SHA" scripts` leaves them.
    // large: the path of the file over 1 MB that both lines change.
    // also: files the pull request adds beside it (path -> contents).
    // env: the run's event (GITHUB_EVENT_NAME), cleared unless a case sets it.
    function behindMain(path, bytes, held = [], large = "public/large.bin", also = {}, env = {}) {
      const origin = fixture();
      // A .json file stays a readable database contract (other checks read it
      // and its RLS table count): exactly `size` bytes, distinct per fill.
      const body = (file, size, fill) => {
        if (!file.endsWith(".json")) return Buffer.alloc(size, fill);
        const [open, close] = ['{"policyCoverage":{"rlsTableCount":1},"padding":"', '"}\n'];
        return `${open}${String.fromCharCode(97 + fill).repeat(size - open.length - close.length)}${close}`;
      };
      const git = (cwd, ...args) => {
        const result = spawnSync("git", args, { cwd, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      // Distinct contents, so no fork-point blob is shared with the head.
      for (const [file, size, fill] of [["src/screen.tsx", 10, 1], [large, 1024 * 1024 + 1, 4], ["docs/operations/evidence/old/shot.png", 10, 5]]) {
        mkdirSync(dirname(join(origin, file)), { recursive: true });
        writeFileSync(join(origin, file), body(file, size, fill));
      }
      const fork = commit(origin, "fork point");
      writeFileSync(join(origin, "src/screen.tsx"), Buffer.alloc(12, 3));
      writeFileSync(join(origin, large), body(large, 1024 * 1024 + 2, 3));
      writeFileSync(join(origin, "docs/operations/evidence/old/shot.png"), Buffer.alloc(12, 3));
      const main = commit(origin, "Main changes the same files");
      git(origin, "checkout", "-q", "-b", "feature", fork);
      writeFileSync(join(origin, path), body(path, bytes, 2));
      for (const [file, contents] of Object.entries(also)) {
        mkdirSync(dirname(join(origin, file)), { recursive: true });
        writeFileSync(join(origin, file), contents);
      }
      const head = commit(origin, "pull request");
      for (const [key, value] of [["uploadpack.allowFilter", "true"], ["uploadpack.allowAnySHA1InWant", "true"]]) git(origin, "config", key, value);

      const candidate = mkdtempSync(join(tmpdir(), "509-conventions-candidate-"));
      created.push(candidate);
      git(candidate, "init", "-q");
      git(candidate, "remote", "add", "origin", `file://${origin}`);
      for (const sha of [head, main]) git(candidate, "fetch", "-q", "--no-tags", "--filter=blob:none", "--depth=8", "origin", sha);
      git(candidate, "checkout", "-q", "--detach", head);
      git(candidate, "update-ref", "refs/remotes/origin/main", main);
      for (const file of held) git(candidate, "cat-file", "-e", `${main}:${file}`);
      // The token removal leaves the promisor unreachable.
      git(candidate, "remote", "set-url", "origin", `file://${join(candidate, "unreachable")}`);
      expect(spawnSync("git", ["cat-file", "-e", `${fork}:${path}`], { cwd: candidate }).status).not.toBe(0);
      return runWith({ CONVENTIONS_BASE_REF: git(candidate, "merge-base", main, head), CI_BASE_SHA: main, GIT_TERMINAL_PROMPT: "0", ...env }, candidate);
    }

    it("passes a small modification to a file Main changed after the fork", () => {
      const result = behindMain("src/screen.tsx", 11);

      expect(result.stderr).not.toContain("added-file policy");
      expect(result.status, result.stderr).toBe(0);
    });

    it("still refuses replaced evidence without its base blob", () => {
      const result = behindMain("docs/operations/evidence/old/shot.png", 11);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("docs/operations/evidence/old/shot.png: replaced binary evidence is not committed to main");
    });

    it("fails closed when a file over 1 MB needs its unreadable base size", () => {
      const result = behindMain("public/large.bin", 1024 * 1024 + 3);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`public/large.bin: replaced with ${1024 * 1024 + 3} bytes, over the 1 MB limit, and its earlier size is not held here; this check fetches no blob`);
      expect(result.stderr).not.toContain("cannot list added files");
    });

    // The Mobile application check
    // holds neither base blob of the database contract file and has no token
    // to fetch one. A pull-request run says so and leaves the verdict to the
    // merge group, which is the binding check.
    it("leaves an unreadable base size to the merge group in a pull-request run, and says so", () => {
      const result = behindMain("public/large.bin", 1024 * 1024 + 3, [], "public/large.bin", {}, { GITHUB_EVENT_NAME: "pull_request" });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("added-file policy");
      expect(result.stdout).toContain(`REPOSITORY_CONVENTIONS_NOTICE: public/large.bin: replaced with ${1024 * 1024 + 3} bytes, over 1 MB; its earlier size is not held in this pull-request checkout, so the merge-group run measures it`);
    });

    it("still fails closed on an unreadable base size in a merge-group run", () => {
      const result = behindMain("public/large.bin", 1024 * 1024 + 3, [], "public/large.bin", {}, { GITHUB_EVENT_NAME: "merge_group" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`public/large.bin: replaced with ${1024 * 1024 + 3} bytes, over the 1 MB limit, and its earlier size is not held here`);
      expect(result.stdout).not.toContain("REPOSITORY_CONVENTIONS_NOTICE: public/large.bin");
    });

    it.each(["pull_request", "merge_group"])("still refuses growth of more than 1 MB over a held base blob in a %s run", (event) => {
      const result = behindMain("public/large.bin", 2 * 1024 * 1024 + 3, ["public/large.bin"], "public/large.bin", {}, { GITHUB_EVENT_NAME: event });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`public/large.bin: replaced with ${2 * 1024 * 1024 + 3} bytes (was ${1024 * 1024 + 2}), over the 1 MB limit`);
    });

    // The database contract file is over 1 MB and
    // every migration pull request modifies it; CI holds only Main's blob.
    it("sizes a file over 1 MB from the held pull-request base blob when the fork-point blob is missing", () => {
      const result = behindMain("public/large.bin", 1024 * 1024 + 3, ["public/large.bin"]);

      expect(result.stderr).not.toContain("added-file policy");
      expect(result.status, result.stderr).toBe(0);
    });

    // BUG-UG-SHARED-RED-TEST-REPOSITORY-CONVENTIONS-TEST-33DF6E1B-20261115
    //: the shared red test of Nov 15 ( and). A migration
    // pull request behind Main adds a migration and modifies the database
    // contract file, which is over 1 MB; Main changed that file after the
    // fork, so the blob-filtered CI clone lacks its fork-point blob and holds
    // only Main's copy (the trusted step archives every scripts/ blob). Before
    //  this failed closed with "cannot list added files against the
    // comparison base" on every such pull request.
    it("passes a migration pull request behind Main whose fork-point database contract blob the clone lacks", () => {
      const contract = "scripts/db-contract.json";
      const result = behindMain(contract, 1024 * 1024 + 3, [contract], contract, {
        "supabase/migrations/20261115090000_shared_red_test_fixture.sql": "begin;\nselect 1;\ncommit;\n",
      });

      expect(result.stderr).not.toContain("added-file policy");
      expect(result.status, result.stderr).toBe(0);
    });

    // Git quotes a non-ASCII path in plain
    // ls-tree output, so the fork-point tree check must read it NUL-separated.
    it("sizes a non-ASCII path over 1 MB from the held pull-request base blob too", () => {
      const large = "public/gr\u00e4nde-\u5927.bin";
      const result = behindMain(large, 1024 * 1024 + 3, [large], large);

      expect(result.stderr).not.toContain("added-file policy");
      expect(result.status, result.stderr).toBe(0);
    });

    it("still refuses growth of more than 1 MB over the held pull-request base blob", () => {
      const result = behindMain("public/large.bin", 2 * 1024 * 1024 + 3, ["public/large.bin"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`public/large.bin: replaced with ${2 * 1024 * 1024 + 3} bytes (was ${1024 * 1024 + 2}), over the 1 MB limit`);
      expect(result.stderr).not.toContain("cannot list added files");
    });

    it("still refuses a new file over 1 MB in the same clone", () => {
      const result = behindMain("public/new.bin", 1024 * 1024 + 1, ["public/large.bin"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`public/new.bin: new file is ${1024 * 1024 + 1} bytes, over the 1 MB limit`);
    });
  });

  it("checks the exported finding helper directly", () => {
    expect(addedFileFindings([{ path: "docs/operations/evidence/a.txt", size: 5 }])).toEqual([]);
    expect(addedFileFindings([{ path: "src/a.js", size: ADDED_FILE_MAX_BYTES + 1 }])).toHaveLength(1);
    expect(addedFileFindings([{ path: "src/a.js", size: ADDED_FILE_MAX_BYTES + 1, previousSize: ADDED_FILE_MAX_BYTES + 1 }])).toEqual([]);
    expect(addedFileFindings([{ path: "src/a.js", size: ADDED_FILE_MAX_BYTES + 1, previousSize: ADDED_FILE_MAX_BYTES }])).toHaveLength(1);
  });
});

describe("retained lockfile libc selectors (ledger 395)", () => {
  const pkg = "@rolldown/binding-linux-x64-musl";
  const path = `node_modules/${pkg}`;
  const binary = { version: "1.3.2", optional: true, os: ["linux"], cpu: ["x64"], libc: ["musl"] };
  for (const name of ["package-lock.json", "apps/mobile/package-lock.json"]) {
    it(`${name}: refuses omitted, weakened or changed selectors across versions and nesting`, () => {
      expect(lockfileLibcFindings({ [name]: { packages: { [path]: binary } } }, libcPolicy)).toEqual([]);
      for (const libc of [undefined, [], ["glibc"], ["musl", "glibc"]]) {
        for (const target of [path, `node_modules/parent/${path}`]) {
          const entry = { ...binary, version: "2.0.0", libc };
          expect(lockfileLibcFindings({ [name]: { packages: { [target]: entry } } }, libcPolicy))
            .toEqual([`${name}: ${target} lost or changed its libc selector; expected ["musl"]`]);
        }
      }
      expect(lockfileLibcFindings({ [name]: { packages: {} } }, libcPolicy)).toEqual([]);
    });

    it(`${name}: the conventions command rejects a stripped selector`, () => {
      const root = fixture();
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      const lock = name === "package-lock.json" ? JSON.parse(readFileSync(file, "utf8")) : { packages: {} };
      lock.packages[path] = { ...binary };
      writeFileSync(file, JSON.stringify(lock));
      expect(green(root).status).toBe(0);
      delete lock.packages[path].libc;
      writeFileSync(file, JSON.stringify(lock));
      const result = green(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${name}: ${path} lost or changed its libc selector`);
      expect(result.stderr).toContain("REPOSITORY_CONVENTIONS_FAIL: lost libc selectors: run node scripts/restore-lockfile-libc.mjs");
    });

    it(`${name}: accepts a new binary with its registry libc selector outside the inventory`, () => {
      const newPath = "node_modules/new-binary";
      expect(lockfileLibcFindings({ [name]: { packages: { [newPath]: binary } } }, libcPolicy)).toEqual([]);
      const root = fixture();
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      const lock = name === "package-lock.json" ? JSON.parse(readFileSync(file, "utf8")) : { packages: {} };
      lock.packages[newPath] = { ...binary };
      writeFileSync(file, JSON.stringify(lock));
      expect(green(root).status).toBe(0);
    });
  }

  it("rejects all ten stripped entries captured from PR 8976 and accepts their restored selectors", () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/dependabot-libc-loss.json"), "utf8"));
    expect(lockfileLibcFindings({ "package-lock.json": lock }, libcPolicy)).toHaveLength(10);
    for (const [path, entry] of Object.entries(lock.packages)) {
      entry.libc = libcPolicy.manifests["package-lock.json"][path.slice("node_modules/".length)];
    }
    expect(lockfileLibcFindings({ "package-lock.json": lock }, libcPolicy)).toEqual([]);
  });

  it("requires a valid inventory", () => {
    expect(lockfileLibcFindings({}, undefined)).toHaveLength(1);
    expect(lockfileLibcFindings({ "package-lock.json": {} }, libcPolicy)).toHaveLength(1);
    const invalid = structuredClone(libcPolicy);
    invalid.manifests["package-lock.json"][pkg] = ["unknown"];
    expect(lockfileLibcFindings({}, invalid)).toHaveLength(1);
    invalid.manifests["other-lock.json"] = {};
    expect(lockfileLibcFindings({}, invalid)).toHaveLength(2);
  });

  it("accepts both shipped locks against the retained Main metadata", () => {
    const locks = Object.fromEntries(["package-lock.json", "apps/mobile/package-lock.json"]
      .map(name => [name, JSON.parse(readFileSync(join(repoRoot, name), "utf8"))]));
    expect(lockfileLibcFindings(locks, libcPolicy)).toEqual([]);
  });
});

describe("dependency override register (OPS-UG-EVIDENCE-BINARIES-AND-DOCS-SEARCH-20261109)", () => {
  function withOverrides(root, overrides) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ ...manifest, overrides }, null, 2)}\n`);
  }
  function register(root, entries) {
    writeFileSync(join(root, "config/dependency-overrides.json"), JSON.stringify({ schema: 1, manifests: { "package.json": entries }, lockfileLibc: libcPolicy }));
  }
  const entry = { reason: "patched advisory", record: "OPS-FIXTURE", reviewBy: "2999-01-01" };

  it("refuses an override with no register entry", () => {
    const root = fixture();
    withOverrides(root, { qs: "6.16.1" });

    const result = green(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package.json: override "qs" has no entry in config/dependency-overrides.json');
  });

  it("accepts a registered override and counts it", () => {
    const root = fixture();
    withOverrides(root, { qs: "6.16.1", "@expo/cli": { zod: "4.6.7" } });
    register(root, { qs: entry, "@expo/cli": entry });

    const result = green(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("overrides=2");
  });

  it("refuses an incomplete entry and a stale one", () => {
    const root = fixture();
    withOverrides(root, { qs: "6.16.1" });
    register(root, { qs: { reason: " ", record: "OPS-FIXTURE", reviewBy: "soon" }, glob: entry });

    const result = green(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('config/dependency-overrides.json: package.json "qs" needs a reason');
    expect(result.stderr).toContain('config/dependency-overrides.json: package.json "qs" needs reviewBy as YYYY-MM-DD');
    expect(result.stderr).toContain('config/dependency-overrides.json: package.json "glob" is not an override any more; remove its entry');
  });

  it("warns, never fails, when a review date has passed", () => {
    const { failures, notices } = overrideRegisterFindings(
      { "package.json": { qs: "6.16.1" } },
      { manifests: { "package.json": { qs: { ...entry, reviewBy: "2026-01-01" } } } },
      "2026-11-09",
    );
    expect(failures).toEqual([]);
    expect(notices).toEqual(['package.json override "qs" was due for review on 2026-01-01']);
  });

  it("refuses a register manifest the check does not read", () => {
    const { failures } = overrideRegisterFindings({}, { manifests: { "packages/x/package.json": {} } });
    expect(failures).toEqual(["config/dependency-overrides.json: packages/x/package.json is not a checked manifest"]);
  });

  // OPS-UG-VERSION-SCOPED-OVERRIDE-GOES-DEAD-ON-PARENT-BUMP-20261118:
  //  moved miniflare past "miniflare@5.20261110.2-beta" and its undici
  // copy fell back from patched 7.30.2 to 7.30.1 with every check green.
  describe("version-scoped overrides (#9135)", () => {
    const scoped = { "miniflare@5.20261110.2-beta": { undici: "7.30.2" } };
    const lockWith = (packages) => ({ "package-lock.json": { packages: { "": { name: "fixture" }, ...packages } } });
    const moved = lockWith({
      "node_modules/miniflare": { version: "5.20261113.0-beta" },
      "node_modules/miniflare/node_modules/undici": { version: "7.30.1" },
    });
    const dead = 'package.json: override "miniflare@5.20261110.2-beta" matches no miniflare 5.20261110.2-beta in package-lock.json'
      + " (it installs miniflare 5.20261113.0-beta), so npm ignores it;"
      + " re-key it and its config/dependency-overrides.json entry to the miniflare version the lock installs if the pin is still needed, or remove both";
    const npmLocks = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/scoped-override-locks.json"), "utf8")).cases;
    const findingsFor = ({ overrides, lock }) => scopedOverrideFindings({ "package.json": overrides }, { "package-lock.json": lock });

    it("refuses a parent-only key whose exact parent version the lock no longer installs", () => {
      expect(scopedOverrideFindings({ "package.json": scoped }, moved)).toEqual([dead]);
      expect(findingsFor(npmLocks["pr9109-dependabot"])).toEqual([dead]);
      expect(findingsFor(npmLocks.stranded)).toEqual([
        expect.stringContaining('package.json: override "parent@1.0.0" matches no parent 1.0.0 in package-lock.json (it installs parent 2.0.0)'),
      ]);
    });

    it("accepts the shapes npm writes for a live or unjudgeable key", () => {
      // Real npm locks: the parent still at the keyed version; a key that replaces
      // its own package (string value, or "."), whose lock records the replacement
      // version; an optional dependency npm left out of the lock.
      for (const name of ["pr9109-repaired", "matching", "replacement", "dot-replacement", "optional-absent"]) {
        expect([name, findingsFor(npmLocks[name])]).toEqual([name, []]);
      }
      expect(npmLocks.replacement.lock.packages["node_modules/child"].version).toBe("2.0.0");
      expect(npmLocks["optional-absent"].lock.packages).toEqual({ "": expect.any(Object) });
      // A package the lock records as a link or a workspace has no version to compare.
      const linked = lockWith({
        "node_modules/workspace-parent": { resolved: "packages/parent", link: true },
        "packages/parent": { name: "workspace-parent", version: "1.0.0" },
        "node_modules/linked": { resolved: "../linked", link: true },
        "node_modules/x/node_modules/linked": { version: "3.0.0" },
      });
      expect(scopedOverrideFindings({ "package.json": { "workspace-parent@2.0.0": { child: "1.0.0" }, "linked@2.0.0": { child: "1.0.0" } } }, linked)).toEqual([]);
      expect(scopedOverrideFindings({ "package.json": scoped }, lockWith({}))).toEqual([]);
    });

    it("checks parent-only keys at any nesting, and leaves unscoped and range keys alone", () => {
      const overrides = {
        "miniflare@5.20261113.0-beta": { undici: "7.30.2" },
        qs: "6.16.1",
        "@expo/cli": { zod: "4.6.7", "@scope/tool@2.0.0": { deep: "1.0.0" } },
        "glob@^14": { minimatch: "11.0.4" },
        "child@1.0.0": { ".": "2.0.0", "grandchild@4.0.0": { leaf: "1.0.0" } },
      };
      const locks = lockWith({
        "node_modules/miniflare": { version: "5.20261113.0-beta" },
        "node_modules/x/node_modules/@scope/tool": { version: "2.0.0" },
        "node_modules/glob": { version: "13.0.0" },
        "node_modules/child": { version: "2.0.0" },
        "node_modules/grandchild": { version: "4.0.0" },
      });
      expect(scopedOverrideFindings({ "package.json": overrides }, locks)).toEqual([]);
      locks["package-lock.json"].packages["node_modules/x/node_modules/@scope/tool"].version = "3.0.0";
      locks["package-lock.json"].packages["node_modules/grandchild"].version = "5.0.0";
      expect(scopedOverrideFindings({ "package.json": overrides }, locks)).toEqual([
        expect.stringContaining('package.json: override "@expo/cli > @scope/tool@2.0.0" matches no @scope/tool 2.0.0 in package-lock.json (it installs @scope/tool 3.0.0)'),
        expect.stringContaining('package.json: override "child@1.0.0 > grandchild@4.0.0" matches no grandchild 4.0.0 in package-lock.json (it installs grandchild 5.0.0)'),
      ]);
    });

    it("reads each manifest against its own lock and skips a manifest with no lock", () => {
      const mobile = { "apps/mobile/package-lock.json": moved["package-lock.json"] };
      expect(scopedOverrideFindings({ "apps/mobile/package.json": scoped }, mobile)).toEqual([
        expect.stringContaining('apps/mobile/package.json: override "miniflare@5.20261110.2-beta" matches no miniflare 5.20261110.2-beta in apps/mobile/package-lock.json'),
      ]);
      expect(scopedOverrideFindings({ "package.json": scoped }, mobile)).toEqual([]);
    });

    it("the conventions command fails on the stranded key and passes once it is re-keyed", () => {
      const root = fixture();
      const lockFile = join(root, "package-lock.json");
      const lock = JSON.parse(readFileSync(lockFile, "utf8"));
      lock.packages["node_modules/miniflare"] = { version: "5.20261113.0-beta" };
      writeFileSync(lockFile, JSON.stringify(lock));
      withOverrides(root, scoped);
      register(root, { "miniflare@5.20261110.2-beta": entry });

      const stranded = green(root);
      expect(stranded.status).toBe(1);
      expect(stranded.stderr).toContain(`REPOSITORY_CONVENTIONS_FAIL: ${dead}`);

      withOverrides(root, { "miniflare@5.20261113.0-beta": { undici: "7.30.2" } });
      register(root, { "miniflare@5.20261113.0-beta": entry });
      expect(green(root).status).toBe(0);
    });
  });
});

describe("Vercel includeFiles length", () => {
  // Vercel refuses a vercel.json whose includeFiles value is longer than 256
  // characters before the build starts, so only this check can catch it in CI.
  function writeVercel(root, length) {
    const pattern = `{content/legal/**,${"x".repeat(length - 19)}}`;
    expect(pattern).toHaveLength(length);
    writeFileSync(join(root, "vercel.json"), JSON.stringify({
      functions: {
        "api/example.js": { includeFiles: pattern },
        "api/other.js": { maxDuration: 30 },
      },
    }));
  }

  it("accepts a pattern at the 256-character limit and reports it", () => {
    const root = fixture();
    writeVercel(root, 256);

    const result = green(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("longest_include_files=256(api/example.js)");
  });

  it("refuses a pattern over the limit, naming the function and its length", () => {
    const root = fixture();
    writeVercel(root, 257);

    const result = green(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'vercel.json: functions["api/example.js"].includeFiles is 257 characters; Vercel refuses more than 256',
    );
  });
});

describe("migration identifier conventions", () => {
  it("accepts the documented fourteen-digit convention", () => {
    const root = fixture();

    const result = green(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REPOSITORY_CONVENTIONS_OK");
  });

  it("accepts a sequence position that is not a valid clock reading", () => {
    const root = fixture();
    // Repairs reserve ordering space with values like 026000 and 240000. The
    // donor rule would have rejected the entire tree; this one must not.
    writeMigration(root, "20260906240000_reserved_sequence_position.sql", "begin;\ncommit;\n");

    const result = green(root);

    expect(result.status).toBe(0);
  });

  it("rejects backdated additions against the Git base inventory but accepts later versions", () => {
    const root = fixture();
    writeMigration(root, "20200101000000_backdated_probe.sql", "select 1;");
    expect(green(root).stderr).toContain("must follow comparison base maximum");
    rmSync(join(root, "supabase/migrations/20200101000000_backdated_probe.sql"));
    writeMigration(root, "20260906020000_later_probe.sql", "begin;\nselect 1;\ncommit;\n");
    expect(green(root).status).toBe(0);
  });

  it("reports an out-of-order version as a warning only on main push runs", () => {
    const root = fixture();
    writeMigration(root, "20200101000000_out_of_order_probe.sql", "begin;\nselect 1;\ncommit;\n");

    const mainPush = green(root, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" });
    expect(mainPush.status).toBe(0);
    expect(mainPush.stderr).toContain("REPOSITORY_CONVENTIONS_WARN: 20200101000000_out_of_order_probe.sql: added migration must follow comparison base maximum");
    expect(mainPush.stderr).not.toContain("REPOSITORY_CONVENTIONS_FAIL");

    const pullRequest = green(root, { GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" });
    expect(pullRequest.status).not.toBe(0);
    expect(pullRequest.stderr).toContain("REPOSITORY_CONVENTIONS_FAIL: 20200101000000_out_of_order_probe.sql: added migration must follow comparison base maximum");
  });

  it("keeps a re-used version a failure on main push runs", () => {
    const root = fixture();
    rmSync(join(root, "supabase/migrations/20260906010000_initial.sql"));
    writeMigration(root, "20260906010000_reused.sql", "begin;\nselect 1;\ncommit;\n");

    const result = green(root, { GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("REPOSITORY_CONVENTIONS_FAIL: 20260906010000_reused.sql: re-used migration version");
  });

  it.each([
    ["missing begin", "-- begin;\nselect 1;\ncommit;\n", "must begin with BEGIN"],
    ["missing commit", "begin;\nselect 'commit;';\n", "must end with COMMIT"],
  ])("requires transaction boundaries for a new migration: %s", (_label, sql, message) => {
    const root = fixture();
    writeMigration(root, "20260906020000_transaction_probe.sql", sql, { wrap: false });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it.each([
    ["missing begin", "select 1;\ncommit;\n", "must begin with BEGIN"],
    ["missing commit", "begin;\nselect 1;\n", "must end with COMMIT"],
    ["wrapped", "begin;\nselect 1;\ncommit;\n", null],
  ])("checks candidate atomicity after merging main: %s", (_label, sql, error) => {
    const root = fixture();
    const git = (...args) => {
      const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    git("switch", "-c", "fixture-main");
    // An existing baseline file remains grandfathered, even without a wrapper.
    writeMigration(root, "20260906010000_initial.sql", "select 0;\n", { wrap: false });
    git("add", ".");
    git("commit", "-qm", "historical migration baseline");
    git("switch", "-c", "feature");
    writeMigration(root, "20260906020000_feature_probe.sql", sql, { wrap: false });
    git("add", ".");
    git("commit", "-qm", "candidate migration");
    git("switch", "fixture-main");
    writeMigration(root, "20260906030000_main_probe.sql", "select 2;");
    git("add", ".");
    git("commit", "-qm", "main advances independently");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "feature");
    git("merge", "--no-ff", "fixture-main", "-m", "integrate main");

    const result = green(root);

    // The ordering allowance still accepts the earlier feature timestamp;
    // presence on a merge's first parent must not exempt its transaction.
    expect(result.stderr).not.toContain("must follow comparison base maximum");
    if (error) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`20260906020000_feature_probe.sql: cannot validate transaction wrapper: new migration ${error}`);
    } else {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("REPOSITORY_CONVENTIONS_OK");
    }
  });

  it("recognizes real transaction boundaries without matching comments or literals", () => {
    const root = fixture();
    writeMigration(root, "20260906020000_transaction_probe.sql", "-- select 1;\nbegin;\nselect 'commit;';\ncommit;\n", { wrap: false });

    const result = green(root);

    expect(result.status).toBe(0);
  });

  it.each([
    ["an interior COMMIT", "begin;\nselect 1;\ncommit;\nselect 2;\ncommit;", /premature transaction termination|must end/i],
    ["an interior END", "begin;\nselect 1;\nend;\nselect 2;\ncommit;", /premature transaction termination/i],
    ["an interior ROLLBACK", "begin;\nselect 1;\nrollback;\ncommit;", /premature transaction termination/i],
    ["an interior ABORT", "begin;\nselect 1;\nabort;\ncommit;", /premature transaction termination/i],
    ["an interior ABORT WORK", "begin;\nselect 1;\nabort work;\ncommit;", /premature transaction termination/i],
    ["an interior ABORT TRANSACTION", "begin;\nselect 1;\nabort transaction;\ncommit;", /premature transaction termination/i],
    ["COMMIT PREPARED", "begin;\nselect 1;\ncommit prepared 'fixture';", /prepared transaction variants/i],
    ["ROLLBACK PREPARED", "begin;\nrollback prepared 'fixture';\ncommit;", /prepared transaction variants/i],
    ["PREPARE TRANSACTION", "begin;\nprepare transaction 'fixture';\ncommit;", /prepared transaction variants/i],
  ])("rejects %s instead of treating token boundaries as atomicity", (_label, sql, message) => {
    const root = fixture();
    writeMigration(root, "20260906020000_transaction_probe.sql", sql, { wrap: false });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(message);
  });

  it("parses savepoint controls inside one outer transaction", () => {
    const root = fixture();
    writeMigration(root, "20260906020000_transaction_probe.sql", "start transaction;\nsavepoint before_probe;\nselect 1;\nrollback to savepoint before_probe;\nrelease savepoint before_probe;\nend;", { wrap: false });

    expect(green(root).status).toBe(0);
  });

  const disposableIt = process.env.RUN_REPOSITORY_CONVENTIONS_DB_TESTS === "1" ? it : it.skip;
  disposableIt("proves a failed migration retains no partial change on the owned disposable database", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
    });
    const table = `conventions_atomicity_${randomBytes(6).toString("hex")}`;
    await client.connect();
    try {
      await expect(client.query(`begin; create table public.${table} (id integer); select 1 / 0; commit;`)).rejects.toMatchObject({ code: "22012" });
      await client.query("rollback");
      expect((await client.query("select to_regclass($1) as relation", [`public.${table}`])).rows[0].relation).toBeNull();
    } finally {
      await client.query(`drop table if exists public.${table}`);
      await client.end();
    }
  });

  disposableIt("proves ABORT variants cannot silently discard migration DDL", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
    });
    const table = `conventions_abort_${randomBytes(6).toString("hex")}`;
    await client.connect();
    try {
      await client.query(`begin; create table public.${table} (id integer); abort;`);
      await expect(client.query("select 1")).resolves.toBeTruthy();
      expect((await client.query("select to_regclass($1) as relation", [`public.${table}`])).rows[0].relation).toBeNull();
    } finally {
      await client.query(`drop table if exists public.${table}`);
      await client.end();
    }
  });

  it("rejects a re-used version even when its base filename was removed", () => {
    const root = fixture();
    rmSync(join(root, "supabase/migrations/20260906010000_initial.sql"));
    writeMigration(root, "20260906010000_reused.sql", "select 1;");
    expect(green(root).stderr).toContain("re-used migration version");
  });

  it("fails closed without comparison history", () => {
    const root = fixture();
    rmSync(join(root, ".git"), { recursive: true });
    expect(green(root).stderr).toContain("cannot resolve an authenticated comparison base");
  });

  // The Mobile application check's red on  and  (Nov 17, 2026): a
  // pull request's CI_BASE_SHA is Main's tip at run time, and a branch cut
  // from an older Main does not contain it. The check compares against the
  // merge base, as the check job's CONVENTIONS_BASE_REF does, and keeps its teeth.
  describe("on a pull request cut from an older Main", () => {
    const behindMain = (branchMigration) => {
      const root = fixture();
      const git = (...args) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const commit = (message) => {
        git("add", "-A");
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message);
        return git("rev-parse", "HEAD");
      };
      git("branch", "feature");
      writeMigration(root, "20260906030000_main_moves_on.sql", "select 1;");
      const main = commit("Main moves on");
      git("update-ref", "refs/remotes/origin/main", main);
      git("checkout", "-q", "feature");
      writeMigration(root, branchMigration, "select 1;");
      commit("pull request");
      return { root, main };
    };
    const pullRequestEnv = (main) => ({ CI_BASE_SHA: main, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/1/merge" });

    it("passes an in-order migration when CI_BASE_SHA is not an ancestor of the head", () => {
      const { root, main } = behindMain("20260906020000_branch_probe.sql");
      expect(spawnSync("git", ["merge-base", "--is-ancestor", main, "HEAD"], { cwd: root }).status).toBe(1);

      const result = green(root, pullRequestEnv(main));

      expect(result.stderr).not.toContain("cannot resolve an authenticated comparison base");
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("REPOSITORY_CONVENTIONS_OK");
    });

    it("still refuses an out-of-order migration against the merge base", () => {
      const { root, main } = behindMain("20200101000000_backdated_probe.sql");

      const result = green(root, pullRequestEnv(main));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("REPOSITORY_CONVENTIONS_FAIL: 20200101000000_backdated_probe.sql: added migration must follow comparison base maximum 20260906010000");
      expect(result.stderr).not.toContain("cannot resolve an authenticated comparison base");
    });

    it("fails closed in a shallow checkout that holds no merge base", () => {
      const { root, main } = behindMain("20260906020000_branch_probe.sql");
      const shallow = mkdtempSync(join(tmpdir(), "509-conventions-shallow-"));
      created.push(shallow);
      const clone = spawnSync("git", ["clone", "-q", "--depth", "1", "--branch", "feature", `file://${root}`, shallow], { encoding: "utf8" });
      expect(clone.status, clone.stderr).toBe(0);

      const result = green(shallow, pullRequestEnv(main));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cannot resolve an authenticated comparison base");
    });
  });

  it("rejects a duplicate migration identifier", () => {
    const root = fixture();
    writeMigration(root, "20260906010000_initial_again.sql", "begin;\ncommit;\n");

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("duplicate migration identifier 20260906010000");
  });

  it("rejects a malformed identifier and a non-date prefix", () => {
    const root = fixture();
    writeMigration(root, "add_widgets.sql", "begin;\ncommit;\n");
    writeMigration(root, "20260931010000_impossible_day.sql", "begin;\ncommit;\n");

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("identifier must be <14-digit UTC timestamp>_<snake_case_slug>.sql");
    expect(result.stderr).toContain("20260931 is not a real calendar date");
  });

  it("rejects a repeated slug unless the baseline records it as applied history", () => {
    const root = fixture();
    writeMigration(root, "20260906020000_initial.sql", "begin;\ncommit;\n");

    const strict = green(root);
    writeBaseline(root, { duplicateSlugExempt: ["20260906020000_initial.sql"] });
    const exempt = green(root);

    expect(strict.status).not.toBe(0);
    expect(strict.stderr).toContain('slug "initial" repeats');
    expect(exempt.status).toBe(0);
  });

  it("rejects a baseline that exempts a migration which no longer exists", () => {
    const root = fixture();
    writeBaseline(root, { duplicateSlugExempt: ["20260101000000_gone.sql"] });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no longer exists");
  });
});

describe("RLS policy rationale", () => {
  const policy = `begin;
create policy widgets_select_staff on public.widgets for select to authenticated
  using (private.is_active_org_staff(organization_id));
commit;
`;

  it.each([
    ["line-comment markers in literals", "SELECT '--'; ALTER POLICY p ON public.widgets USING (true);"],
    ["fake rationale in a SELECT dollar-string", "ALTER POLICY p ON public.widgets USING (true); SELECT $$COMMENT ON POLICY p ON public.widgets IS 'Every active staff member may read widget rows.';$$;"],
    ["nested dollar tags inside an outer literal", "SELECT $outer$ $inner$COMMENT ON POLICY p ON public.widgets IS 'Every active staff member may read widget rows.';$inner$ $outer$; ALTER POLICY p ON public.widgets USING (true);"],
    ["block comment containing fake rationale", "ALTER POLICY p ON public.widgets USING (true); /* outer /* nested */ COMMENT ON POLICY p ON public.widgets IS 'Every active staff member may read widget rows.'; */"],
  ])("requires executable rationale despite %s", (_label, sql) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    expect(green(root).stderr).toContain("has no COMMENT ON POLICY rationale");
  });

  it.each([
    [
      "top-level lone CR before CREATE POLICY",
      Buffer.from("-- header\rCREATE POLICY probe ON public.widgets USING (true);", "utf8"),
      "new policy probe on public.widgets has no COMMENT ON POLICY rationale",
    ],
    [
      "top-level CRLF before ALTER POLICY",
      Buffer.from("-- header\r\nALTER POLICY probe ON public.widgets USING (true);", "utf8"),
      "materially altered policy probe on public.widgets has no COMMENT ON POLICY rationale",
    ],
    [
      "procedural lone CR before CREATE POLICY",
      Buffer.from("CREATE FUNCTION probe() RETURNS void LANGUAGE plpgsql AS $$BEGIN -- hidden\rCREATE POLICY probe ON public.widgets USING (true); END$$;", "utf8"),
      "policy DDL inside procedural/dynamic SQL is unsupported",
    ],
    [
      "procedural CRLF before COMMENT ON POLICY",
      Buffer.from("CREATE FUNCTION probe() RETURNS void LANGUAGE plpgsql AS $$BEGIN -- hidden\r\nCOMMENT ON POLICY probe ON public.widgets IS 'Every active organization staff member may read widget rows.'; END$$;", "utf8"),
      "policy DDL inside procedural/dynamic SQL is unsupported",
    ],
  ])("recognizes policy statements after raw-byte %s", (_label, sql, message) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    const result = green(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });

  it.each([
    [
      "function",
      "CREATE FUNCTION make_policy() RETURNS void LANGUAGE plpgsql AS 'BEGIN '\n'EXECUTE ''CREATE POLICY probe ON public.widgets USING (true)''; END'; SELECT make_policy();",
    ],
    [
      "procedure",
      "CREATE PROCEDURE make_policy() LANGUAGE plpgsql AS 'BEGIN '\n'EXECUTE ''CREATE POLICY probe ON public.widgets USING (true)''; END'; CALL make_policy();",
    ],
    [
      "trigger function",
      "CREATE FUNCTION make_policy_trigger() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN '\n'EXECUTE ''CREATE POLICY probe ON public.widgets USING (true)''; RETURN NEW; END';",
    ],
  ])("rejects newline-concatenated executable policy bodies in a %s", (_label, sql) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    const result = green(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("policy DDL inside procedural/dynamic SQL is unsupported");
  });

  it("scans dollar-quoted comments for protected data including overwritten comments", () => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", "COMMENT ON POLICY p ON public.widgets IS $tag$Only staff at private@example.invalid may read these rows.$tag$; COMMENT ON POLICY p ON public.widgets IS 'Only active organization staff may read these rows.';");
    expect(green(root).stderr).toContain("contains an email address");
  });

  it("accepts executable dollar rationale with semicolons and comment markers", () => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", "ALTER POLICY p ON public.widgets USING (true); COMMENT ON POLICY p ON public.widgets IS $$All active staff may read; '--' and /* markers */ are literal rationale.$$;");
    expect(green(root).status).toBe(0);
  });

  it.each(["COMMENT ON POLICY p ON public.widgets IS E'unsupported escape form';", "ALTER POLICY p ON public.widgets UNKNOWN (true);", "SELECT $tag$unterminated;", "DO $$BEGIN ALTER POLICY p ON public.widgets USING (true); END$$;"])("fails closed on unsupported SQL/policy syntax: %s", (sql) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    expect(green(root).stderr).toContain("unsupported SQL/policy syntax");
  });

  it.each([
    "DO $$BEGIN CREATE/*split*/POLICY probe ON public.widgets USING (true); END;$$;",
    "DO LANGUAGE plpgsql $body$BEGIN ALTER-- split\nPOLICY probe ON public.widgets USING (true); END;$body$;",
    "DO $$BEGIN CREATE/* outer /* nested */ comment */POLICY probe ON public.widgets USING (true); END;$$;",
    "CREATE FUNCTION probe() RETURNS void AS $fn$BEGIN CREATE/*split*/POLICY probe ON public.widgets USING (true); END;$fn$ LANGUAGE plpgsql;",
    "CREATE OR REPLACE FUNCTION probe() RETURNS void LANGUAGE plpgsql AS $$BEGIN ALTER/*split*/POLICY probe ON public.widgets USING (true); END;$$;",
    "CREATE FUNCTION probe() RETURNS void LANGUAGE sql AS $sql$CREATE/*split*/POLICY probe ON public.widgets USING (true);$sql$;",
    "CREATE PROCEDURE probe() LANGUAGE plpgsql AS $$BEGIN ALTER/*split*/POLICY probe ON public.widgets USING (true); END;$$;",
    "DO $$BEGIN EXECUTE 'CREATE/*split*/POLICY probe ON public.widgets USING (true)'; END;$$;",
    "DO $body$BEGIN EXECUTE $$ALTER/*split*/POLICY probe ON public.widgets USING (true)$$; END;$body$;",
    "DO $$BEGIN EXECUTE 'CREATE '\n'POLICY probe ON public.widgets USING (true)'; END;$$;",
    "DO $$BEGIN COMMENT/*split*/ON/*split*/POLICY probe ON public.widgets IS 'Only active organization staff may read these rows.'; END;$$;",
  ])("rejects tokenized procedural policy DDL: %s", (sql) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    const result = green(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("policy DDL inside procedural/dynamic SQL is unsupported");
  });

  it.each([
    "DO $$BEGIN EXECUTE 'CRE' || 'ATE POLICY probe ON public.widgets USING (true)'; END;$$;",
    "DO $$BEGIN EXECUTE format('CREATE %s probe ON public.widgets USING (true)', 'POLICY'); END;$$;",
    "CREATE FUNCTION probe() RETURNS void AS $$BEGIN EXECUTE 'ALTER ' || 'POLICY probe ON public.widgets USING (true)'; END;$$ LANGUAGE plpgsql;",
    "CREATE OR REPLACE FUNCTION probe() RETURNS void LANGUAGE plpgsql AS $$BEGIN EXECUTE format('%s %s probe ON public.widgets USING (true)', 'CREATE', 'POLICY'); END;$$;",
    "DO $$DECLARE command text := 'CREATE POLICY probe ON public.widgets USING (true)'; BEGIN EXECUTE command; END;$$;",
    "DO $$BEGIN EXECUTE ('CREATE POLICY probe ON public.widgets USING (true)'); END;$$;",
  ])("rejects unproven dynamic EXECUTE expressions: %s", (sql) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    const result = green(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("dynamic EXECUTE cannot be safely analyzed");
  });

  it.each([
    "DO $outer$BEGIN DO $inner$BEGIN CREATE/*split*/POLICY probe ON public.widgets USING (true); END;$inner$; END;$outer$;",
    "DO $outer$BEGIN EXECUTE $command$DO $inner$BEGIN CREATE/*split*/POLICY probe ON public.widgets USING (true); END;$inner$;$command$; END;$outer$;",
    "CREATE FUNCTION probe() RETURNS void AS $outer$BEGIN EXECUTE $command$DO LANGUAGE plpgsql $inner$BEGIN NULL; END;$inner$;$command$; END;$outer$ LANGUAGE plpgsql;",
    "DO $outer$BEGIN EXECUTE $command$CREATE FUNCTION nested() RETURNS void AS $inner$BEGIN NULL; END;$inner$ LANGUAGE plpgsql;$command$; END;$outer$;",
  ])("rejects nested executable dollar bodies beyond the supported grammar: %s", (sql) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    const result = green(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("nested procedural/dollar bodies cannot be safely analyzed");
  });

  it.each([
    "DO $$BEGIN /* CREATE POLICY is only a comment */ PERFORM 'ALTER POLICY is only data'; END;$$;",
    "CREATE FUNCTION probe() RETURNS text AS $fn$BEGIN RETURN $$CREATE/*split*/POLICY is only data$$; END;$fn$ LANGUAGE plpgsql;",
    "DO $$BEGIN EXECUTE 'SELECT 1'; END;$$;",
    "DO $outer$BEGIN EXECUTE $query$SELECT $$ALTER POLICY is only data$$;$query$; END;$outer$;",
    "CREATE FUNCTION probe() RETURNS void LANGUAGE plpgsql AS $$BEGIN NULL; END;$$;",
  ])("accepts analyzable procedural SQL without policy changes: %s", (sql) => {
    const root = fixture();
    writeMigration(root, "20260906030000_probe.sql", sql);
    expect(green(root).status).toBe(0);
  });

  describe.each(["'", "$comment$"])("phone detection in %s-quoted rationale", (quote) => {
    it.each(["(202) 555-0101", "202-555-0101", "202.555.0101", "202 555 0101", "2025550101", "1 (202) 555-0101", "+1 202-555-0101"])("rejects %s", (phone) => {
      const root = fixture();
      writeMigration(root, "20260906030000_probe.sql", `COMMENT ON POLICY probe ON public.widgets IS ${quote}Only staff reachable at ${phone} may read widget rows.${quote};`);
      const result = green(root);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("contains a phone number");
    });
  });

  it("requires a COMMENT ON POLICY for a policy a new migration creates", () => {
    const root = fixture();
    writeMigration(root, "20260906030000_widgets_policy.sql", policy);

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("has no COMMENT ON POLICY rationale");
  });

  it("accepts a policy whose rationale explains who it admits", () => {
    const root = fixture();
    writeMigration(root, "20260906030000_widgets_policy.sql", `${policy.replace("commit;", "")}
comment on policy widgets_select_staff on public.widgets is
  'Active staff of the owning organization read widget rows; no other role is admitted.';
commit;
`);

    const result = green(root);

    expect(result.status).toBe(0);
  });

  it("rejects a placeholder rationale and one that carries protected data", () => {
    const root = fixture();
    writeMigration(root, "20260906030000_widgets_policy.sql", `${policy.replace("commit;", "")}
comment on policy widgets_select_staff on public.widgets is 'staff only';
commit;
`);
    const placeholder = green(root);
    writeMigration(root, "20260906030000_widgets_policy.sql", `${policy.replace("commit;", "")}
comment on policy widgets_select_staff on public.widgets is
  'Admits the steward reachable at steward@example.invalid and nobody else at all.';
commit;
`);
    const disclosure = green(root);

    expect(placeholder.status).not.toBe(0);
    expect(placeholder.stderr).toContain("must explain who the policy admits");
    expect(disclosure.status).not.toBe(0);
    expect(disclosure.stderr).toContain("contains an email address");
  });

  it("does not read a commented-out policy as a live one", () => {
    const root = fixture();
    writeMigration(root, "20260906030000_widgets_policy.sql", `begin;
-- create policy widgets_select_staff on public.widgets for select to authenticated;
commit;
`);

    const result = green(root);

    expect(result.status).toBe(0);
  });

  // A MATERIAL CHANGE TO AN EXISTING POLICY NEEDS THE SAME RATIONALE.
  //
  // The acceptance names "new security-relevant RLS policies AND material
  // policy changes", and widening an existing policy is the change least
  // visible in review: `using (true)` is shorter than the tenancy predicate it
  // replaces and removes every bound that predicate had.
  const widened = `begin;
alter policy widgets_select_staff on public.widgets using (true);
commit;
`;

  it("requires a COMMENT ON POLICY for a policy a new migration materially alters", () => {
    const root = fixture();
    writeMigration(root, "20260907010000_widen_policy.sql", widened);

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "materially altered policy widgets_select_staff on public.widgets has no COMMENT ON POLICY rationale",
    );
  });

  it("requires a rationale when a material alter is the final unterminated statement", () => {
    const root = fixture();
    writeMigration(root, "20260907010000_widen_policy.sql", "begin;\nalter policy widgets_select_staff on public.widgets using (true)\n");

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "materially altered policy widgets_select_staff on public.widgets has no COMMENT ON POLICY rationale",
    );
  });

  it("accepts a material alter whose rationale explains the new predicate", () => {
    const root = fixture();
    writeMigration(root, "20260907010000_widen_policy.sql", `${widened.replace("commit;", "")}
comment on policy widgets_select_staff on public.widgets is
  'Widget rows carry no member identity, so every authenticated account may read them; the tenancy bound moved to the view that joins them.';
commit;
`);

    const result = green(root);

    expect(result.status).toBe(0);
  });

  // A rename moves the identifier and leaves the same rows visible to the same
  // roles. There is no new decision, so demanding a rationale for one would
  // teach authors that the rule is noise.
  it("does not demand a rationale for a rename-only alter", () => {
    const root = fixture();
    writeMigration(root, "20260907010000_rename_policy.sql", `begin;
alter policy widgets_select_staff on public.widgets rename to widgets_read_staff;
commit;
`);

    const result = green(root);

    expect(result.status).toBe(0);
  });

  // A comment is readable by every role that can read the catalog whether or
  // not the migration that writes it also creates the policy.
  it("rejects protected data in a comment on a policy an earlier migration created", () => {
    const root = fixture();
    writeMigration(root, "20260907010000_comment_only.sql", `begin;
comment on policy widgets_select_staff on public.widgets is
  'Admits the steward whose account id is 3f2504e0-4f89-41d3-9a0c-0305e82c3301 and nobody else.';
commit;
`);

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("contains a UUID");
  });

  it("exempts the migrations the baseline froze", () => {
    const root = fixture();
    writeMigration(root, "20260906030000_widgets_policy.sql", policy);
    writeBaseline(root, { policyCommentExempt: ["20260906030000_widgets_policy.sql"] });

    const result = green(root);

    expect(result.status).toBe(0);
  });
});

// scripts/run-database-assurance.mjs throws unless the installed Supabase CLI
// equals the reviewed baseline, and no CI job here runs it, so the conventions
// check holds the pin: a bump fails in seconds until the baseline moves with it.
describe("database assurance CLI pin", () => {
  it("accepts a manifest pin that matches the reviewed baseline", () => {
    const root = fixture();

    const result = green(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REPOSITORY_CONVENTIONS_OK");
  });

  it("rejects a Supabase CLI bump that leaves the reviewed baseline behind", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { manifest: "2.110.0", baseline: "2.109.1" });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package.json pins supabase 2.110.0");
    expect(result.stderr).toContain("supabaseCliVersion \"2.109.1\"");
  });

  it("rejects a baseline moved without its manifest pin", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { manifest: "2.109.1", baseline: "2.110.0" });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("package.json pins supabase 2.109.1");
  });

  it("refuses a range instead of an exact Supabase CLI version", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { manifest: "^2.109.1", baseline: "2.109.1" });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be an exact version");
  });

  it("refuses a manifest with no Supabase CLI pin at all", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { manifest: null });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("devDependencies.supabase is missing");
  });

  // The manifest string is not what
  // CI installs. `npm ci` installs the lockfile, so an `overrides` entry or a
  // lockfile edit can move the binary with `devDependencies.supabase`
  // untouched. The platform packages carry the executable; the `supabase`
  // package is only its bin wrapper.
  it("rejects a lockfile that moves the CLI wrapper away from the reviewed version", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { manifest: "2.109.1", baseline: "2.109.1", locked: "2.110.0" });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("locks node_modules/supabase at \"2.110.0\"");
  });

  it("rejects an overridden platform package even when the wrapper still matches", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { manifest: "2.109.1", baseline: "2.109.1", lockedPlatform: "2.110.0" });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("locks node_modules/@supabase/cli-linux-x64 at \"2.110.0\"");
  });

  it("refuses a lockfile with no Supabase CLI entry", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { omitLockEntry: true });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no node_modules/supabase entry");
  });

  // Checking only
  // the entries that happen to be present passes a lockfile with none of
  // them, and a nested copy escapes a top-level-only pattern.
  it("refuses a lockfile with no linux-x64 CLI executable to run", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { omitPlatform: true });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no node_modules/@supabase/cli-linux-x64 entry");
  });

  it("rejects a nested platform copy that Node would prefer over the hoisted one", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { nestedPlatform: "2.110.0" });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("node_modules/supabase/node_modules/@supabase/cli-linux-x64 at \"2.110.0\"");
  });

  it("rejects a wrapper that declares a platform version other than the reviewed one", () => {
    const root = fixture();
    writeDatabaseAssuranceCliPin(root, { declared: "2.110.0" });

    const result = green(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("wrapper depending on @supabase/cli-linux-x64");
  });

  it("ignores unrelated @supabase packages that are not the CLI", () => {
    const root = fixture();

    const result = green(root);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("@supabase/client");
  });
});

describe("provenance migration rule", () => {
  // The documented CREATE TABLE is the shape every campaign table copies, so it
  // is read out of the document itself: if the document drifts from the rule,
  // this fails.
  const documentedSql = (() => {
    const doc = readFileSync(join(repoRoot, "docs", "conventions", "provenance.md"), "utf8");
    const match = /<!-- provenance-check-sql -->\n```sql\n([\s\S]*?)\n```/.exec(doc);
    if (!match) throw new Error("docs/conventions/provenance.md lost its provenance-check-sql block");
    return `${match[1]}\n`;
  })();
  const withoutCheck = documentedSql.replace(/,\n {2}constraint reference_example_provenance_complete check \([\s\S]*?\n {2}\)\n/, "\n");
  const findings = (sql) => provenanceFindings(sql).findings.join("\n");

  // End to end through a fixture repository, as CI runs it.
  function judged(sql) {
    const root = fixture();
    writeMigration(root, "20261120010000_reference_example.sql", sql);
    return green(root);
  }
  function expectRefused(sql, message) {
    const result = judged(sql);
    expect(result.status, sql).not.toBe(0);
    expect(result.stderr, sql).toContain(message);
  }
  function expectAccepted(sql) {
    const result = judged(sql);
    expect(result.stderr, sql).toBe("");
    expect(result.status, sql).toBe(0);
    return result;
  }

  it("accepts the table shape the document prescribes", () => {
    const result = expectAccepted(documentedSql);
    expect(result.stdout).toContain("provenance_tables=1");
  });

  // The table was a schema element, and only
  // token 0 of a statement was read.
  it("refuses a provenance table declared inside CREATE SCHEMA", () => {
    expectRefused(
      `create schema staging\n  create table reference_example (id uuid primary key, provenance jsonb not null);`,
      "table reference_example: a provenance table is created only by a top-level CREATE TABLE, never inside CREATE SCHEMA",
    );
  });

  // Neither statement was classified.
  it("refuses a foreign table with a provenance name and IMPORT FOREIGN SCHEMA", () => {
    expectRefused(
      "create foreign table private.reference_remote (id uuid, provenance jsonb not null) server remote_server;",
      "table reference_remote: CREATE FOREIGN TABLE may not take a provenance name",
    );
    expectRefused(
      "import foreign schema remote_public limit to (reference_remote) from server remote_server into private;",
      "IMPORT FOREIGN SCHEMA is refused",
    );
  });

  // Tokens after the CHECK's closing parenthesis
  // were ignored, so NO INHERIT let a child table hold rows without it.
  it("refuses a CHECK followed by NO INHERIT, NOT VALID or NOT ENFORCED", () => {
    for (const tail of ["no inherit", "not valid", "not enforced"]) {
      expectRefused(
        documentedSql.replace(/\n {2}\)\n\);\n$/, `\n  ) ${tail}\n);\n`),
        "provenance needs the documented CHECK predicate verbatim as constraint reference_example_provenance_complete, with nothing after it",
      );
    }
  });

  // The fail-closed rule's other named escapes: a child table under any name
  // shows its rows through the parent.
  it("refuses INHERITS and PARTITION OF involving a provenance table", () => {
    expectRefused(
      `${documentedSql}\ncreate table private.staging_example (note text) inherits (private.reference_example);`,
      "table staging_example: INHERITS and PARTITION OF may not involve a provenance table",
    );
    expectRefused(
      "create table private.staging_example partition of private.reference_example for values in ('x');",
      "table staging_example: INHERITS and PARTITION OF may not involve a provenance table",
    );
    expectRefused(
      `${documentedSql}\nalter table private.staging_example inherit private.reference_example;`,
      "INHERIT and ATTACH or DETACH PARTITION may not involve a provenance table",
    );
    expectRefused(
      documentedSql.replace(/\);\n$/, ") partition by list (id);\n"),
      "nothing may follow the column list",
    );
  });

  // Every string literal was parsed as SQL, so a
  // COMMENT that mentioned execute was refused.
  it("accepts a COMMENT whose text mentions execute", () => {
    expectAccepted(`${documentedSql}\ncomment on table private.reference_example is 'Loaders execute assertProvenance() first; may execute format(''%I'') never.';\ncomment on column private.reference_example.provenance is 'execute';`);
  });

  // Any ALTER naming a word containing "provenance"
  // was refused.
  it("accepts an ALTER that adds a provenance_note column", () => {
    expectAccepted(`${documentedSql}\nalter table private.reference_example add column provenance_note text, add column provenance_reviewed_at timestamptz;`);
  });

  it("refuses a catalog, reference, research or content table without a provenance column", () => {
    for (const table of ["catalog_lm2_summaries", "public.reference_state_law", "\"research_outcomes\"", "content_glossary"]) {
      expect(findings(`create table ${table} (id uuid primary key, value text);`), table)
        .toContain("must declare the column as exactly provenance pg_catalog.jsonb not null");
    }
    expectRefused("create table private.content_glossary (id uuid primary key, value text);", "table content_glossary: must declare the column as exactly provenance pg_catalog.jsonb not null");
  });

  it("refuses a nullable, mistyped, defaulted or generated provenance column", () => {
    const cases = [
      [documentedSql.replace("provenance pg_catalog.jsonb not null,", "provenance jsonb,"), "must declare the column as exactly provenance pg_catalog.jsonb not null"],
      [documentedSql.replace("provenance pg_catalog.jsonb not null,", "provenance text not null,"), "must declare the column as exactly provenance pg_catalog.jsonb not null"],
      [documentedSql.replace("provenance pg_catalog.jsonb not null,", "provenance jsonb check (provenance is not null or true),"), "must declare the column as exactly provenance pg_catalog.jsonb not null"],
      [documentedSql.replace("provenance pg_catalog.jsonb not null,", "provenance jsonb not null default '{}'::jsonb,"), "must not have a default"],
      [documentedSql.replace("provenance pg_catalog.jsonb not null,", "provenance jsonb not null generated always as ('{}'::jsonb) stored,"), "must not have a default or be generated"],
    ];
    for (const [sql, message] of cases) expect(findings(sql), sql).toContain(message);
  });

  it("requires the documented CHECK verbatim, not a predicate that merely names the keys", () => {
    const keys = ["provenance_id", "source", "url", "publisher", "retrieved_at", "content_sha256", "capture", "method", "as_of", "review", "status"];
    const tautology = `check (provenance is not null and ${keys.map((key) => `'${key}' = '${key}'`).join(" and ")})`;
    const cases = [
      withoutCheck,
      documentedSql.replace(/\n {4}and pg_catalog\.btrim\(coalesce\(provenance -> 'review' ->> 'status', ''\)\) <> ''/, ""),
      documentedSql.replace("jsonb_typeof(provenance) = 'object'\n    and", "jsonb_typeof(provenance) = 'object'\n    or"),
      withoutCheck.replace("provenance pg_catalog.jsonb not null\n", `provenance pg_catalog.jsonb not null,\n  constraint reference_example_provenance_complete ${tautology}\n`),
      documentedSql.replace("constraint reference_example_provenance_complete check", "constraint source_complete check"),
    ];
    for (const sql of cases) {
      expect(findings(sql), sql).toContain("provenance needs the documented CHECK predicate verbatim as constraint reference_example_provenance_complete");
    }
    // The predicate the document prescribes requires every contract key.
    for (const key of keys) expect(documentedSql).toContain(`'${key}'`);
    // Case and whitespace are not part of the shape.
    expect(findings(documentedSql.replaceAll("\n    and ", "\n AND  ").replace("jsonb_typeof", "JSONB_TYPEOF"))).toBe("");
  });

  it("refuses a provenance table declared any way but the documented CREATE TABLE", () => {
    const cases = [
      [documentedSql.replace("create table", "create table if not exists"), "IF NOT EXISTS would keep an older table"],
      [documentedSql.replace("create table", "create unlogged table"), "declare it as exactly create table <name> (...)"],
      [documentedSql.replace("  provenance pg_catalog.jsonb not null,", "  like private.staging_example including all,\n  provenance pg_catalog.jsonb not null,"), "a LIKE element"],
      ["create table private.reference_copy as select * from private.staging_example;", "must declare its columns inline"],
      ["select 1 as value into private.reference_copied;", "SELECT ... INTO may not create a provenance table"],
      ["select 1 as value into unlogged table reference_copied;", "SELECT ... INTO may not create a provenance table"],
      ["create view private.reference_example_view as select 1;", "a provenance name is for the documented table only"],
      ["create materialized view private.content_glossary as select 1;", "a provenance name is for the documented table only"],
      ['create table private.U&"reference_new" (value text);', "U& identifiers are unsupported"],
      ["explain analyze create table private.reference_copy as select 1;", "EXPLAIN ANALYZE names reference_copy"],
    ];
    for (const [sql, message] of cases) expect(findings(sql), sql).toContain(message);
  });

  it("refuses provenance DDL hidden in DO, routine and EXECUTE bodies", () => {
    const cases = [
      ["do $$ begin create table private.reference_hidden (id uuid primary key); end $$;", "never inside CREATE SCHEMA, a DO block, a routine body or an EXECUTE string"],
      ["do $outer$ begin execute 'create table private.content_hidden (id uuid primary key)'; end $outer$;", "never inside CREATE SCHEMA, a DO block, a routine body or an EXECUTE string"],
      ["create function private.f() returns void language plpgsql as $$ begin if true then create table private.research_hidden (id int); end if; end $$;", "never inside CREATE SCHEMA"],
      ["do $$ begin execute 'select 1 as value into private.reference_copied'; end $$;", "SELECT ... INTO may not create a provenance table"],
      ["create function private.f() returns void language sql as $$ select 1 as value into private.reference_copied $$;", "SELECT ... INTO may not create a provenance table"],
      ["do $$ begin execute 'alter table private.reference_example drop constraint reference_example_provenance_complete'; end $$;", "ALTER may not change the provenance column"],
      ['do $$ begin execute \'create table private.U&"reference_new" (value text)\'; end $$;', "the checker cannot read"],
      ["do $$ declare definition text := 'create table private.' || 'reference_hidden (value text)'; begin execute definition; end $$;", "EXECUTE in a DO or routine body must run one constant string"],
      ["do $$ begin execute format('create table private.%I (value text)', 'reference_hidden'); end $$;", "EXECUTE in a DO or routine body must run one constant string"],
      ["do $$ begin execute 'create table x (v text)' || ''; end $$;", "EXECUTE in a DO or routine body must run one constant string"],
    ];
    for (const [sql, message] of cases) expect(findings(sql), sql).toContain(message);
  });

  it("refuses ALTERs that weaken, rename or re-parent a provenance table", () => {
    const cases = [
      ["alter table private.reference_example drop constraint reference_example_provenance_complete;", "may not change the provenance column or its reference_example_provenance_complete constraint"],
      ["alter table only private.reference_example alter column provenance drop not null;", "may not change the provenance column"],
      ["alter table private.reference_example alter provenance set default '{}';", "may not change the provenance column"],
      ["alter table private.reference_example add column note text, drop column provenance;", "may not change the provenance column"],
      ["alter table private.reference_example rename constraint reference_example_provenance_complete to kept;", "may not change the provenance column"],
      ["alter table private.reference_example add constraint reference_example_provenance_complete check (true);", "may not change the provenance column"],
      ["alter table private.reference_example rename to staging_example;", "ALTER may not rename a provenance table"],
      ["alter table private.staging_example rename to reference_example;", "ALTER may not rename a provenance table, or any relation to a provenance name"],
      ["alter index private.staging_example rename to reference_example;", "ALTER may not rename a provenance table, or any relation to a provenance name"],
      ["alter table private.reference_example attach partition private.staging_example for values in ('x');", "INHERIT and ATTACH or DETACH PARTITION"],
      ["create trigger fill before insert on private.reference_example for each row execute function private.fill();", "a trigger could fill or rewrite provenance"],
      ["create rule fill as on insert to private.reference_example do instead nothing;", "CREATE RULE names reference_example"],
    ];
    for (const [sql, message] of cases) expect(findings(`${documentedSql}\n${sql}`), sql).toContain(message);
  });

  // Each case passed the head it reviewed.
  it("closes the token-collision, three-part-name, typed-table and truncation escapes", () => {
    // A literal spelling out serialized tokens stood in for the '' fallbacks.
    const collided = documentedSql.replace(/'([a-z_]+)', ''/g, "'$1 symbol:, literal:'");
    expect(collided).not.toBe(documentedSql);
    expect(findings(collided)).toContain("provenance needs the documented CHECK predicate verbatim");
    // database.schema.table was read as a table named after the schema.
    expect(findings("create table postgres.private.reference_missing (id int);")).toContain("table reference_missing: must declare the column as exactly provenance pg_catalog.jsonb not null");
    expect(findings(`${documentedSql}\nalter table postgres.private.reference_example drop column provenance;`)).toContain("may not change the provenance column");
    expect(findings("select 1 into postgres.private.reference_copied;")).toContain("SELECT ... INTO may not create a provenance table");
    // OF ties the table to a composite type; ALTER TYPE ... DROP ATTRIBUTE
    // CASCADE would then drop the provenance column and its CHECK.
    for (const action of ["of private.example_type", "not of"]) {
      expect(findings(`create type private.example_type as (id uuid, provenance jsonb);\n${documentedSql}\nalter table private.reference_example ${action};\nalter type private.example_type drop attribute provenance cascade;`), action)
        .toContain(`table reference_example: ALTER ${action.split(" ")[0].toUpperCase()} is not an action known to leave the provenance column and CHECK intact`);
    }
    // PostgreSQL would store a truncated constraint name the ALTER guard never matches.
    const long = documentedSql.replaceAll("reference_example", "reference_external_records_publication_review_queue");
    expect(findings(long)).toContain("is longer than 63 bytes and PostgreSQL would truncate it");
    expect(findings(documentedSql.replaceAll("reference_example", `reference_${"x".repeat(32)}`))).toBe("");
  });

  // INSERT as a column alias, and a search_path
  // that lets another schema's operator shadow the CHECK's.
  it("closes the INSERT-alias INTO and search_path shadowing escapes", () => {
    for (const sql of [
      "select 1 as insert into private.reference_hidden;",
      "select 1 insert into private.reference_hidden;",
      "with x as (select 1) select 1 as merge into private.reference_hidden from x;",
      "do $$ begin execute 'select 1 as insert into private.reference_hidden'; end $$;",
    ]) expect(findings(sql), sql).toContain("table reference_hidden: SELECT ... INTO may not create a provenance table");
    for (const sql of [
      "insert into private.reference_example (provenance) values ('{}');",
      "with picked as (select provenance from private.staging_example) insert into private.reference_example (provenance) select provenance from picked;",
      "with moved as (insert into private.reference_example (provenance) values ('{}') returning id) select count(*) from moved;",
      "merge into private.reference_example as t using private.staging_example as s on false when not matched then insert (provenance) values (s.provenance);",
    ]) expect(findings(sql), sql).toBe("");

    const shadow = "search_path may not put another schema ahead of pg_catalog";
    for (const sql of [
      `set search_path = public, pg_catalog;\ncreate operator public.~ (leftarg = text, rightarg = text, function = private.always_true);\n${documentedSql}`,
      `set local search_path to public, pg_catalog;\n${documentedSql}`,
      `select pg_catalog.set_config('search_path', 'public, pg_catalog', true);\n${documentedSql}`,
      `alter role postgres set search_path = public, pg_catalog;`,
      `do $$ begin perform set_config('search_path', 'public,pg_catalog', true); end $$;`,
      `create function private.f() returns void language sql set search_path = public, pg_catalog as $$ select 1 $$;`,
    ]) expect(findings(sql), sql).toContain(shadow);
    expect(findings("create operator public.~ (leftarg = text, rightarg = text, function = private.always_true);")).toContain("CREATE OPERATOR is refused");
    for (const sql of ["set search_path = '';", "SET search_path TO '';", "set search_path = pg_catalog, public;", "set search_path = public;", "create function private.f() returns void language sql set search_path = '' as $$ select 1 $$;"]) {
      expect(findings(sql), sql).toBe("");
    }
  });

  // An overlong operand PostgreSQL truncates onto
  // the protected name, and a quoted "search_path" that let a domain named
  // jsonb shadow the column type until DROP DOMAIN ... CASCADE removed it.
  it("compares names as PostgreSQL stores them and reads a quoted search_path", () => {
    const table = `reference_${"x".repeat(33)}`;
    const longest = documentedSql.replaceAll("reference_example", table);
    expect(findings(longest)).toBe("");
    for (const operand of [`${table}_provenance_completex`, `"${table}_provenance_complete${"y".repeat(9)}"`]) {
      expect(findings(`${longest}\nalter table private.${table} drop constraint ${operand};`), operand)
        .toContain(`may not change the provenance column or its ${table}_provenance_complete constraint`);
    }
    for (const sql of [
      `create domain private.jsonb as pg_catalog.jsonb;\nset local "search_path" to private, pg_catalog;\n${documentedSql}\ndrop domain private.jsonb cascade;`,
      `set "SEARCH_PATH" = private, pg_catalog;`,
      `select pg_catalog."set_config"('search_path', 'private, pg_catalog', true);`,
    ]) expect(findings(sql), sql).toContain("search_path may not put another schema ahead of pg_catalog");
  });

  // A temporary type named jsonb, a non-ASCII
  // schema name the lexer cut short, and backslash escapes decoded with
  // standard_conforming_strings off.
  it("qualifies the column type, reads non-ASCII names and keeps strings standard", () => {
    const unqualified = documentedSql.replace("provenance pg_catalog.jsonb not null,", "provenance jsonb not null,");
    for (const sql of [
      unqualified,
      `set local search_path = pg_catalog, private;\ncreate domain pg_temp.jsonb as pg_catalog.jsonb;\n${unqualified}\ndrop domain pg_temp.jsonb cascade;`,
    ]) expect(findings(sql), sql).toContain("must declare the column as exactly provenance pg_catalog.jsonb not null");

    expect(findings("create schema privées;\ncreate table privées.reference_hidden (id integer);"))
      .toContain("table reference_hidden: must declare the column as exactly provenance pg_catalog.jsonb not null");
    expect(findings("create table priv\u00a0x.reference_hidden (id integer);")).toContain("table reference_hidden: must declare");
    expect(findings("create table privées.organization_widgets (id integer);")).toBe("");

    for (const sql of [
      "set local standard_conforming_strings = off;\ndo $body$ begin execute 'cr\\145ate table private.ref\\145rence_hidden (id int)'; end $body$;",
      "set \"standard_conforming_strings\" to off;",
      "select set_config('standard_conforming_strings', 'off', true);",
      "alter role postgres set standard_conforming_strings = off;",
    ]) expect(findings(sql), sql).toContain("standard_conforming_strings may not be changed");

    // A SET string is refused unless it is '' or
    // a plain lowercase name (round 6 below).
    for (const sql of [
      "set local search_path = 'public, pg_catalog';",
      "set local search_path = $$public,pg_catalog$$;",
      "set local search_path = public, 'pg_catalog ';",
    ]) expect(findings(sql), sql).toContain("search_path may not put another schema ahead of pg_catalog");
    expect(findings("set local search_path = pg_catalog, public;")).toBe("");
    expect(findings("set local search_path = 'pg_catalog, public';")).toContain("search_path may not put another schema ahead of pg_catalog");

    // A quoted schema keeps its case and spaces,
    // and quotes inside a string change how PostgreSQL splits it.
    for (const sql of [
      "set local search_path = 'pg_catalog\", provenance_shadow, pg_catalog';",
      "set local search_path = '\"pg_catalog, public\", provenance_shadow, pg_catalog';",
      "set local search_path = \"PG_CATALOG\", provenance_shadow, pg_catalog;",
      "set local search_path = \"pg_catalog \", provenance_shadow, pg_catalog;",
      "set local search_path = '\vpg_catalog, provenance_shadow, pg_catalog';",
      "select pg_catalog.set_config('search_path', '\"PG_CATALOG\", provenance_shadow, pg_catalog', true);",
    ]) expect(findings(sql), sql).toContain("search_path may not put another schema ahead of pg_catalog");
    expect(findings("set local search_path = \"pg_catalog\", public;")).toBe("");
    expect(findings("select pg_catalog.set_config('search_path', ' PG_CATALOG , public', true);")).toBe("");

    // SET takes each
    // string as one exact name, so 'PG_CATALOG' and 'pg_catalog ' are other
    // schemas, skipped when missing, and provenance_shadow is searched first.
    for (const sql of [
      "set local search_path = 'PG_CATALOG', provenance_shadow, pg_catalog;",
      "set local search_path = 'pg_catalog ', provenance_shadow, pg_catalog;",
      "set local search_path = $$PG_CATALOG$$, provenance_shadow, pg_catalog;",
      "create function private.f() returns int language sql set search_path = 'PG_CATALOG', provenance_shadow, pg_catalog as 'select 1';",
    ]) expect(findings(sql), sql).toContain("search_path may not put another schema ahead of pg_catalog");
    expect(findings("set local search_path = '';")).toBe("");
    expect(findings("set local search_path = 'pg_catalog', 'public';")).toBe("");

    // Only the first literal of set_config was read.
    expect(findings("select pg_catalog.set_config('search_path', '' || 'private, pg_catalog', true);")).toContain("search_path may not put another schema ahead of pg_catalog");
    expect(findings("select pg_catalog.set_config(format('search_%s', 'path'), 'private, pg_catalog', true);")).toContain("set_config must name its setting with one constant string");
    expect(findings("select pg_catalog.set_config('request.jwt.claims', '{}', true);")).toBe("");
  });

  it("accepts the statements a provenance table needs after it is created", () => {
    expect(findings(`${documentedSql}
alter table private.reference_example add column note text;
alter table private.reference_example rename column note to remark;
alter table private.reference_example enable row level security, force row level security;
alter table private.reference_example no force row level security;
alter table private.reference_example add constraint reference_example_review_kind check (provenance -> 'review' ->> 'status' in ('reviewed', 'pending')) not valid;
create index reference_example_remark_idx on private.reference_example (remark);
create policy reference_example_read on private.reference_example for select to authenticated using (true);
comment on policy reference_example_read on private.reference_example is 'Any signed-in member may read reference rows.';
revoke all on table private.reference_example from public, anon, authenticated;
grant select on private.reference_example to authenticated;
insert into private.reference_example (provenance) select provenance from private.reference_example;
update private.reference_example set remark = 'x' where provenance ->> 'provenance_id' = 'x';
create view private.example_view as select remark from private.reference_example;
create function private.lookup(r private.reference_example) returns text language plpgsql as $$
declare research_loaded_over uuid; n integer;
begin
  select count(*) into n from private.reference_example;
  select r.id into research_loaded_over from private.reference_example as r limit 1;
  execute 'analyze private.reference_example';
  insert into private.reference_example (provenance) values ('{}') on conflict do nothing;
  return 'ok';
end $$;
do $$ begin execute 'select 1' into strict n using 1; end $$;
grant execute on function private.lookup(private.reference_example) to authenticated;
create table private.organization_widgets (id uuid primary key, catalog_key text, content_sha256 text, like private.reference_example);
drop table private.reference_example;`)).toBe("");
  });

  it("leaves other tables, earlier migrations and the comparison base alone", () => {
    expectAccepted("create table private.organization_widgets (id uuid primary key);");

    const before = fixture();
    // The last migration present at adoption is still before the rule.
    writeMigration(before, "20261019224500_research_tables.sql", "create table private.catalog_research_facts (id uuid primary key);");
    expect(green(before).status).toBe(0);

    const based = fixture();
    writeMigration(based, "20261120010000_catalog_base.sql", "create table private.catalog_base (id uuid primary key);");
    for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base table"], ["update-ref", "refs/remotes/origin/main", "HEAD"]]) {
      expect(spawnSync("git", args, { cwd: based, encoding: "utf8" }).status).toBe(0);
    }
    expect(green(based).status).toBe(0);
  });

  // Every migration in the tree, read as if it were new, so an ordinary migration
  // the rule would refuse shows up here. Only two kinds of refusal may appear:
  // the catalog tables that predate the contract, and bodies the policy
  // comment rule also cannot read (E'' strings, EXECUTE of an assembled string
  // or of a variable such as the older `execute definition` rewrites).
  it("passes every ordinary migration in the tree", () => {
    const precontract = new Set([
      "20260925950000_union_catalog_reference_foundation.sql",
      "20260930040000_union_catalog_claims_verification.sql",
      "20261012090000_union_catalog_research_tables.sql",
    ]);
    const unreadable = /^(?:EXECUTE in a DO or routine body must run one constant string|a DO, routine or EXECUTE body the checker cannot read|cannot read the SQL for the provenance rule)/;
    const names = readdirSync(join(repoRoot, "supabase", "migrations")).filter((name) => name.endsWith(".sql"));
    expect(names.length).toBeGreaterThan(600);
    const unexpected = [];
    let clean = 0;
    for (const name of names) {
      const { findings: messages } = provenanceFindings(readFileSync(join(repoRoot, "supabase", "migrations", name), "utf8"));
      if (!messages.length) clean++;
      // Tables created before the rule required pg_catalog.jsonb used the
      // documented jsonb; with the type qualified they must be clean.
      const qualified = messages.some((message) => message.includes("exactly provenance pg_catalog.jsonb not null"))
        ? provenanceFindings(readFileSync(join(repoRoot, "supabase", "migrations", name), "utf8").replaceAll("provenance jsonb not null", "provenance pg_catalog.jsonb not null")).findings
        : null;
      for (const message of qualified && !precontract.has(name) ? qualified : messages) {
        if (unreadable.test(message)) continue;
        if (precontract.has(name) && /^table catalog_\w+: /.test(message)) continue;
        unexpected.push(`${name}: ${message}`);
      }
    }
    expect(unexpected).toEqual([]);
    expect(clean).toBeGreaterThan(560);
  });
});

describe("provenance reference data", () => {
  it("validates every JSON file under data/reference against the contract", () => {
    const record = stamp({
      bytes: "statute text",
      source: { url: "https://malegislature.gov/Laws/GeneralLaws/PartI/TitleXXI/Chapter150E", publisher: "Massachusetts Legislature" },
      retrievedAt: "2026-10-11T07:00:00Z",
      capture: { method: "http-get" },
      asOf: "2026-10-11",
    });
    const root = fixture();
    mkdirSync(join(root, "data", "reference", "state-labor-law"), { recursive: true });
    writeFileSync(join(root, "data", "reference", "state-labor-law", "ma.json"), `${JSON.stringify({ jurisdiction: "MA", provenance: record })}\n`);
    writeFileSync(join(root, "data", "reference", "README.md"), "# not JSON, not checked\n");
    const ok = green(root);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("reference_files=1");

    writeFileSync(join(root, "data", "reference", "state-labor-law", "nh.json"), `${JSON.stringify({ jurisdiction: "NH", provenance: { ...record, as_of: "2026-10-12" } })}\n`);
    writeFileSync(join(root, "data", "reference", "state-labor-law", "vt.json"), `${JSON.stringify({ jurisdiction: "VT" })}\n`);
    writeFileSync(join(root, "data", "reference", "state-labor-law", "me.json"), "{ not json");
    writeFileSync(join(root, "data", "reference", "state-labor-law", "nm.json"), "null\n");
    const result = green(root);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("data/reference/state-labor-law/nh.json: $.provenance: provenance_id does not match the record's fingerprint");
    expect(result.stderr).toContain("data/reference/state-labor-law/vt.json: document carries no provenance record");
    expect(result.stderr).toContain("data/reference/state-labor-law/me.json is not readable JSON");
    expect(result.stderr).toContain("data/reference/state-labor-law/nm.json: document must be a JSON object or array");
  });

  it("refuses symlinks under data/reference, which the walk would otherwise pass by", () => {
    // A Dirent for a symlink is neither a file nor a directory.
    const root = fixture();
    mkdirSync(join(root, "data", "raw", "sub"), { recursive: true });
    mkdirSync(join(root, "data", "reference"), { recursive: true });
    writeFileSync(join(root, "data", "raw", "vt.json"), `${JSON.stringify({ jurisdiction: "VT" })}\n`);
    symlinkSync(join("..", "raw", "vt.json"), join(root, "data", "reference", "vt.json"));
    symlinkSync(join("..", "raw", "sub"), join(root, "data", "reference", "linked-dir"));
    symlinkSync(join("..", "raw", "missing.json"), join(root, "data", "reference", "dangling.json"));
    const result = green(root);
    expect(result.status).not.toBe(0);
    for (const name of ["vt.json", "linked-dir", "dangling.json"]) {
      expect(result.stderr).toContain(`data/reference/${name} must be a regular file or directory`);
    }

    const linkedRoot = fixture();
    mkdirSync(join(linkedRoot, "data", "raw"), { recursive: true });
    symlinkSync("raw", join(linkedRoot, "data", "reference"));
    const linked = green(linkedRoot);
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain("data/reference must be a real directory");
  });
});

describe("the shipped repository", () => {
  it("satisfies its own documented conventions", () => {
    const result = spawnSync(process.execPath, [scriptSource], { cwd: repoRoot, encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("REPOSITORY_CONVENTIONS_OK");
  }, conventionsTimeout);

  // The check runs as its own step in the required workflow, not inside
  // `npm run check`, which is also vercel.json's buildCommand; a pull request
  // passes its base commit so the ordering and added-file rules compare
  // against exactly what the pull request merges into.
  it("runs the conventions check in the required workflow with the pull request base", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");

    expect(pkg.scripts["verify:conventions"]).toBe("node scripts/verify-repository-conventions.mjs");
    const step = /- name: Repository conventions\n([\s\S]*?)\n\n/.exec(ci)?.[1] ?? "";
    expect(step).toContain("CI_BASE_SHA: ${{ github.event.pull_request.base.sha }}");
    expect(step).toContain("run: npm run verify:conventions");
    expect(ci).toContain("fetch-depth: 0");
  });
});
