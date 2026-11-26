// @vitest-environment node
// Required CI's production audit fails a
// change only for advisories its own lockfile change introduces. Each case
// runs the script as CI would, with real git on a fixture history and real
// npm against a scripted registry that answers by package name.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compareAdvisories, mergeBaseFiles, productionAdvisories } from "../scripts/dependency-audit-introduced.mjs";

const script = fileURLToPath(new URL("../scripts/dependency-audit-introduced.mjs", import.meta.url));
const manifestScript = fileURLToPath(new URL("../scripts/dependency-audit-manifests.mjs", import.meta.url));
const cleanup = [];
afterEach(async () => { for (const done of cleanup.splice(0)) await done(); });

const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const ADVISORIES = {
  "left-pad": { id: 1, url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc", title: "Left-pad fixture advisory", severity: "high", vulnerable_versions: "<=1.3.0", cwe: [], cvss: { score: 7 } },
  "is-odd": { id: 2, url: "https://github.com/advisories/GHSA-dddd-eeee-ffff", title: "Is-odd fixture advisory", severity: "moderate", vulnerable_versions: "<=3.0.1", cwe: [], cvss: { score: 5 } },
};

// The bulk endpoint answers with the advisories of the packages it was asked
// about; `outage` lists request numbers (1-based) that get a 503 instead.
async function registry({ outage = [] } = {}) {
  const seen = { bulk: 0 };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => { chunks.push(chunk); });
    req.on("end", () => {
      if (req.url.includes("/security/advisories/bulk")) {
        seen.bulk += 1;
        if (outage.includes(seen.bulk)) return json(res, 503, { error: "Service Unavailable" });
        let names = [];
        // npm gzips the bulk request body.
        const raw = Buffer.concat(chunks);
        try { names = Object.keys(JSON.parse(req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw)); } catch { names = []; }
        return json(res, 200, Object.fromEntries(names.filter(name => ADVISORIES[name]).map(name => [name, [ADVISORIES[name]]])));
      }
      if (req.url.includes("/security/audits/quick")) return json(res, 503, { error: "Service Unavailable" });
      json(res, 404, { error: "Not found" });
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  cleanup.push(() => new Promise(done => server.close(done)));
  return { url: `http://127.0.0.1:${server.address().port}/`, seen };
}

const VERSIONS = { "left-pad": "1.3.0", "is-odd": "3.0.1", "is-number": "7.0.0" };
function project(dir, dependencies) {
  const deps = Object.fromEntries(dependencies.map(name => [name, VERSIONS[name]]));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "audit-fixture", version: "1.0.0", dependencies: deps }, null, 2));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "audit-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
    "": { name: "audit-fixture", version: "1.0.0", dependencies: deps },
    ...Object.fromEntries(dependencies.map(name => [`node_modules/${name}`, { version: VERSIONS[name],
      resolved: `https://registry.npmjs.org/${name}/-/${name}-${VERSIONS[name]}.tgz`, integrity: "sha512-AAAA" }])),
  } }, null, 2));
}

// A repository whose merge base has `base` dependencies and whose HEAD (a
// branch off it) has `head`; returns the directory and the base commit.
function history(base, head, { scripts = false, baseExtra = {}, headExtra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dependency-audit-introduced-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "Main");
  writeFileSync(join(dir, ".npmrc"), "");
  project(dir, base);
  for (const [name, text] of Object.entries(baseExtra)) writeFileSync(join(dir, name), text);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  git("checkout", "-q", "-b", "change");
  project(dir, head);
  if (scripts) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ ...manifest, scripts: { check: "true" } }, null, 2));
  }
  for (const [name, text] of Object.entries(headExtra)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "README.md"), "change\n");
  git("add", "-A");
  git("commit", "-q", "-m", "head");
  return { dir, baseSha };
}

// CI's clones are blob-filtered: HEAD's blobs are checked out, the merge
// base's differing blobs are absent, and the script must not fetch them.
function filteredClone(source) {
  execFileSync("git", ["config", "uploadpack.allowFilter", "true"], { cwd: source });
  const dir = mkdtempSync(join(tmpdir(), "dependency-audit-clone-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", "--filter=blob:none", "--branch", "change", `file://${source}`, dir], { encoding: "utf8" });
  // No credential survives into the audit step; a lazy fetch would succeed
  // here only because the fixture remote is local, so point it nowhere.
  execFileSync("git", ["remote", "set-url", "origin", join(dir, "missing-remote")], { cwd: dir });
  return dir;
}

async function runScript(dir, baseSha, options, args = [script]) {
  const { url, seen } = await registry(options);
  const env = { ...process.env, CI_BASE_SHA: baseSha, RUNNER_TEMP: dir, NPM_AUDIT_RETRY_SECONDS: "0", npm_config_registry: url,
    npm_config_cache: join(dir, ".cache"), npm_config_userconfig: join(dir, ".npmrc"), npm_config_update_notifier: "false" };
  const child = spawn(process.execPath, typeof args === "function" ? args(url) : args, { cwd: dir, env });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const status = await new Promise(done => child.on("close", done));
  return { status, stdout, stderr, bulkRequests: seen.bulk };
}

describe("introduced-only production audit", () => {
  it("fails an advisory the change introduces", async () => {
    const { dir, baseSha } = history(["is-number"], ["is-number", "left-pad"]);
    const result = await runScript(dir, baseSha);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.bulkRequests).toBe(2);
    expect(result.stdout).toContain("::error::left-pad high: Left-pad fixture advisory (GHSA-aaaa-bbbb-cccc), introduced by this change");
    expect(result.stdout).toContain("::error::This change introduces 1 production advisory at moderate or above");
  }, 60_000);

  it("passes with a warning for an advisory already on the merge base, without auditing it again", async () => {
    const { dir, baseSha } = history(["left-pad"], ["left-pad"]);
    const result = await runScript(dir, baseSha);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.bulkRequests).toBe(1);
    expect(result.stdout).toContain(`::warning::left-pad high: Left-pad fixture advisory (GHSA-aaaa-bbbb-cccc) is already on the merge base ${baseSha.slice(0, 12)}; not blocking, tracked by the daily Main audit`);
  }, 60_000);

  it("fails only the new advisory when the change adds one beside a pre-existing one", async () => {
    const { dir, baseSha } = history(["left-pad"], ["left-pad", "is-odd"]);
    const result = await runScript(dir, baseSha);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("left-pad high: Left-pad fixture advisory (GHSA-aaaa-bbbb-cccc) is already on the merge base");
    expect(result.stdout).toContain("::error::is-odd moderate: Is-odd fixture advisory (GHSA-dddd-eeee-ffff), introduced by this change");
  }, 60_000);

  it("passes a change that fixes the merge base's advisory", async () => {
    const { dir, baseSha } = history(["left-pad", "is-odd"], ["is-odd"]);
    const result = await runScript(dir, baseSha);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("This change fixes left-pad high: Left-pad fixture advisory (GHSA-aaaa-bbbb-cccc)");
    expect(result.stdout).toContain("is-odd moderate: Is-odd fixture advisory (GHSA-dddd-eeee-ffff) is already on the merge base");
  }, 60_000);

  it("keeps the old behaviour when the merge base cannot be read", async () => {
    const { dir } = history(["left-pad"], ["left-pad"]);
    const result = await runScript(dir, "f".repeat(40));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("::warning::No merge-base comparison (the merge base of ffffffffffff and HEAD is not in this clone); every production advisory at moderate or above blocks, as before");
    expect(result.stdout).toContain("::error::left-pad high: Left-pad fixture advisory (GHSA-aaaa-bbbb-cccc)");
    expect(result.stdout).toContain("::error::npm audit found production advisories at moderate or above");
  }, 60_000);

  it("compares in a blob-filtered clone when only package.json changed", async () => {
    const { dir: source, baseSha } = history(["left-pad"], ["left-pad"], { scripts: true });
    const dir = filteredClone(source);
    const result = await runScript(dir, baseSha);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("is already on the merge base");
  }, 60_000);

  it("keeps the old behaviour in a blob-filtered clone that lacks the changed base lockfile", async () => {
    const { dir: source, baseSha } = history(["left-pad", "is-number"], ["left-pad"]);
    const dir = filteredClone(source);
    const result = await runScript(dir, baseSha);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/::warning::No merge-base comparison \(package-lock\.json on the merge base [0-9a-f]{12} \(blob [0-9a-f]{12}\) is not in this blob-filtered clone\)/u);
    expect(result.stdout).toContain("::error::npm audit found production advisories at moderate or above");
  }, 60_000);

  it("keeps the old behaviour when the merge base audit fails every attempt", async () => {
    const { dir, baseSha } = history(["is-number"], ["left-pad"]);
    const result = await runScript(dir, baseSha, { outage: [2, 3, 4] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::warning::No merge-base comparison (the merge base ${baseSha.slice(0, 12)} audit failed`);
    expect(result.stdout).toContain("::error::npm audit found production advisories at moderate or above");
  }, 60_000);

  it("still fails as unproven when the head audit fails every attempt", async () => {
    const { dir, baseSha } = history(["left-pad"], ["left-pad"]);
    const result = await runScript(dir, baseSha, { outage: [1, 2, 3] });
    expect(result.status).toBe(1);
    expect(result.bulkRequests).toBe(3);
    expect(result.stdout).toContain("::error::The npm audit endpoint failed on all 3 attempts");
  }, 60_000);
});

// Review A6-S2 on: npm prefers npm-shrinkwrap.json over
// package-lock.json for audit and ci alike. A change that leaves
// package-lock.json alone and adds a shrinkwrap carrying a vulnerable
// production graph must not be told its advisory is already on the base.
describe("a shrinkwrap beside an unchanged package-lock.json", () => {
  const shrinkwrap = () => {
    const dir = mkdtempSync(join(tmpdir(), "dependency-audit-shrinkwrap-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    project(dir, ["is-number", "left-pad"]);
    return readFileSync(join(dir, "package-lock.json"), "utf8");
  };

  it("is refused in a checkout before anything is audited", async () => {
    const { dir, baseSha } = history(["is-number"], ["is-number"], { headExtra: { "npm-shrinkwrap.json": shrinkwrap() } });
    expect(execFileSync("git", ["diff", "--name-only", baseSha, "HEAD"], { cwd: dir, encoding: "utf8" })).not.toContain("package-lock.json");
    const result = await runScript(dir, baseSha);
    expect(result.status).toBe(1);
    expect(result.bulkRequests).toBe(0);
    expect(result.stdout).toContain("::error::The production audit reads package-lock.json only; remove npm-shrinkwrap.json");
  }, 60_000);

  it("on the merge base keeps the old rule instead of comparing", async () => {
    const { dir, baseSha } = history(["left-pad"], ["left-pad"], { baseExtra: { "npm-shrinkwrap.json": shrinkwrap() } });
    rmSync(join(dir, "npm-shrinkwrap.json"));
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "-am", "drop shrinkwrap"], { cwd: dir });
    const result = await runScript(dir, baseSha);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`::warning::No merge-base comparison (npm-shrinkwrap.json exists on the merge base ${baseSha.slice(0, 12)})`);
  }, 60_000);

  it("is refused by the isolated form, whose directory may hold only the two manifests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dependency-audit-isolated-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "base"));
    mkdirSync(join(dir, "head"));
    project(join(dir, "base"), ["is-number"]);
    project(join(dir, "head"), ["is-number"]);
    writeFileSync(join(dir, "head", "npm-shrinkwrap.json"), shrinkwrap());
    const result = await runScript(dir, "", {}, (url) => [manifestScript, "--head", join(dir, "head"), "--base", join(dir, "base"), "--registry", url]);
    expect(result.status).toBe(1);
    expect(result.bulkRequests).toBe(0);
    expect(result.stdout).toContain("::error::The audit directory must hold exactly package.json and package-lock.json");
  }, 60_000);
});

describe("isolated manifest audit", () => {
  // Writes head and base manifest directories and runs the trusted entry
  // point as ci.yml's dependency-audit job does.
  async function runIsolated(base, head, { mutateHead, withBase = true, options } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "dependency-audit-isolated-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "head"));
    mkdirSync(join(dir, "base"));
    project(join(dir, "head"), head);
    if (withBase) project(join(dir, "base"), base);
    mutateHead?.(join(dir, "head"));
    return runScript(dir, "", options, (url) => [manifestScript, "--head", join(dir, "head"), "--base", join(dir, "base"),
      "--merge-base", "c".repeat(40), "--registry", url]);
  }

  it("reuses the head's advisories only when both manifests are byte-identical", async () => {
    const result = await runIsolated(["left-pad"], ["left-pad"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.bulkRequests).toBe(1);
    expect(result.stdout).toContain(`is already on the merge base ${"c".repeat(12)}; not blocking`);
  }, 60_000);

  it("audits the base again when only package.json changed", async () => {
    const result = await runIsolated(["left-pad"], ["left-pad"], { mutateHead: (head) => {
      const manifest = JSON.parse(readFileSync(join(head, "package.json"), "utf8"));
      writeFileSync(join(head, "package.json"), JSON.stringify({ ...manifest, scripts: { check: "true" } }));
    } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.bulkRequests).toBe(2);
  }, 60_000);

  it("fails an advisory the change introduces", async () => {
    const result = await runIsolated(["is-number"], ["is-number", "left-pad"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("::error::left-pad high: Left-pad fixture advisory (GHSA-aaaa-bbbb-cccc), introduced by this change");
  }, 60_000);

  it("keeps the old rule when the fork point's manifests are missing", async () => {
    const result = await runIsolated([], ["left-pad"], { withBase: false });
    expect(result.status).toBe(1);
    expect(result.bulkRequests).toBe(1);
    expect(result.stdout).toContain("::warning::No merge-base comparison (the fork point's package.json and package-lock.json were not provided)");
  }, 60_000);

  // Review W1-S2 on: without packages/work/package.json npm would mark
  // the workspace's graph dev and leave left-pad out of an --omit=dev audit.
  const workspace = (dir) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "audit-fixture", version: "1.0.0", workspaces: ["packages/*"] }));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ name: "audit-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: {
      "": { name: "audit-fixture", version: "1.0.0", workspaces: ["packages/*"] },
      "node_modules/work": { resolved: "packages/work", link: true },
      "packages/work": { version: "1.0.0", dev: true, dependencies: { "left-pad": "1.3.0" } },
      "node_modules/left-pad": { version: "1.3.0", resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz", integrity: "sha512-AAAA" },
    } }));
  };

  it("refuses a workspace layout whose graph the two manifests cannot show, before npm runs", async () => {
    const result = await runIsolated(["is-number"], ["is-number"], { mutateHead: workspace });
    expect(result.status).toBe(1);
    expect(result.bulkRequests).toBe(0);
    expect(result.stdout).toContain("::error::The production audit cannot see the whole dependency graph from the root package.json and package-lock.json: package.json declares workspaces; package-lock.json links node_modules/work; package-lock.json has the local package packages/work");
  }, 60_000);

  it("keeps the old rule when only the fork point has a workspace layout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dependency-audit-isolated-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "head"));
    mkdirSync(join(dir, "base"));
    project(join(dir, "head"), ["left-pad"]);
    workspace(join(dir, "base"));
    const result = await runScript(dir, "", {}, (url) => [manifestScript, "--head", join(dir, "head"), "--base", join(dir, "base"), "--registry", url]);
    expect(result.status).toBe(1);
    expect(result.bulkRequests).toBe(1);
    expect(result.stdout).toContain("::warning::No merge-base comparison (the fork point's layout is not supported: package.json declares workspaces;");
  }, 60_000);

  it("still fails as unproven when the head audit fails every attempt", async () => {
    const result = await runIsolated(["left-pad"], ["left-pad"], { options: { outage: [1, 2, 3] } });
    expect(result.status).toBe(1);
    expect(result.bulkRequests).toBe(3);
    expect(result.stdout).toContain("::error::The npm audit endpoint failed on all 3 attempts");
  }, 60_000);
});

describe("merge-base lockfile reading", () => {
  it("marks unchanged files and reads changed ones from the clone", () => {
    const { dir, baseSha } = history(["left-pad"], ["is-odd"]);
    const files = mergeBaseFiles({ cwd: dir, base: baseSha, paths: ["package.json", "package-lock.json", ".npmrc"] });
    expect(files.readable).toBe(true);
    expect(files.mergeBase).toBe(baseSha);
    expect(files.files[".npmrc"].unchanged).toBe(true);
    expect(files.files["package-lock.json"].unchanged).toBe(false);
    expect(JSON.parse(files.files["package-lock.json"].text).packages["node_modules/left-pad"].version).toBe("1.3.0");
  });

  it("never fetches a blob the blob-filtered clone lacks", () => {
    const { dir, baseSha } = history(["left-pad"], ["is-odd"]);
    const real = (args, cwd) => {
      if (args[0] === "cat-file") return { ok: false, stdout: "", stderr: "missing" };
      return { ok: true, stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), stderr: "" };
    };
    const files = mergeBaseFiles({ cwd: dir, base: baseSha, paths: ["package-lock.json"], run: real });
    expect(files.readable).toBe(false);
    expect(files.reason).toMatch(/^package-lock\.json on the merge base [0-9a-f]{12} \(blob [0-9a-f]{12}\) is not in this blob-filtered clone$/u);
    expect(mergeBaseFiles({ cwd: dir, base: undefined, paths: [] })).toEqual({ readable: false, reason: "no base commit was given (CI_BASE_SHA)" });
    expect(mergeBaseFiles({ cwd: dir, base: baseSha, paths: ["absent.json"] }).reason).toMatch(/^absent\.json does not exist on the merge base/u);
  });
});

describe("advisory comparison", () => {
  const report = (via) => ({ vulnerabilities: { pkg: { via } }, metadata: { vulnerabilities: { moderate: 0, high: via.length, critical: 0 } } });
  const advisory = { name: "pkg", url: "https://github.com/advisories/GHSA-1111-2222-3333", severity: "high", title: "t" };

  it("ignores advisories below moderate and never treats an unparsed report as pre-existing", () => {
    expect(productionAdvisories({ vulnerabilities: { pkg: { via: [{ ...advisory, severity: "low" }] } }, metadata: { vulnerabilities: { low: 1 } } })).toEqual([]);
    const unparsed = productionAdvisories({ vulnerabilities: { pkg: { via: ["other"] } }, metadata: { vulnerabilities: { high: 1 } } });
    expect(unparsed.map(entry => entry.key)).toEqual(["unparsed-report"]);
    expect(compareAdvisories(unparsed, unparsed).introduced).toHaveLength(1);
  });

  it("keys an advisory by id and package, so the same advisory in a new package is introduced", () => {
    const base = productionAdvisories(report([advisory]));
    const head = productionAdvisories(report([advisory, { ...advisory, name: "pkg-fork" }]));
    expect(compareAdvisories(head, base).introduced.map(entry => entry.package)).toEqual(["pkg-fork"]);
    expect(compareAdvisories(head, base).preexisting.map(entry => entry.package)).toEqual(["pkg"]);
  });
});
