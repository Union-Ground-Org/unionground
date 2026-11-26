// @vitest-environment node
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyPolicy, loadPolicy, lockfileBuildToolPathProven, lockfileReachableInProduction, normalizeTrivyReport, validatePolicy } from "../scripts/lib/security-scanner-policy.mjs";
import { buildToolPathProven, reachableInProduction } from "../apps/mobile/scripts/security-audit.mjs";

const policy = loadPolicy();
// The Trivy node-forge build-tool entry this file was written against
// The public fixture preserves the build-tool classification after the dependency upgrade.
const entry = Object.freeze({
  "scanner": "trivy",
  "identifier": "CVE-2026-85393",
  "path": "apps/mobile/package-lock.json",
  "reason": "The mobile build CLI is the only path to this package at the pinned version. The advisory is recorded with the exact severity and version. Mobile npm audit verifies that no production bundle reaches it.",
  "reviewed_by": "Security maintainers",
  "reviewed_on": "2026-10-11",
  "classification": "build-tool",
  "reached_only_through": [
    "@expo/cli"
  ],
  "alternate_identifiers": [
    "GHSA-86w9-cpqp-85rv"
  ],
  "package": "node-forge",
  "installed_version": "1.4.0",
  "severity": "HIGH",
  "affected_range": "<=1.4.0"
});
const ids = ["CVE-2026-85393", "GHSA-86w9-cpqp-85rv"];
const report = (id, changes = {}) => ({ SchemaVersion: 2, Results: [{ Target: "apps/mobile/package-lock.json", Vulnerabilities: [{
  VulnerabilityID: id, PkgName: "node-forge", InstalledVersion: "1.4.0", Severity: "HIGH", ...changes,
}] }] });
const scoped = { ...policy, allowlist: [entry] };
const mobileLock = JSON.parse(readFileSync(new URL("../apps/mobile/package-lock.json", import.meta.url), "utf8"));
// expo-updates (REQ-UG-PHONE-APPS-OVER-THE-AIR-UPDATES-20261113) adds a
// second route to node-forge: expo-updates -> @expo/code-signing-certificates,
// which only expo-updates' build-time Node CLI (`expo-updates codesigning:*`)
// imports, never an app bundle. The fixture above was bound when @expo/cli was
// the only route, so it is proven against the lockfile with that one edge cut;
// "keeps the expo-updates route to node-forge build-time only" pins the edge.
const realLock = structuredClone(mobileLock);
delete realLock.packages["node_modules/expo-updates"].dependencies["@expo/code-signing-certificates"];
const readLockfile = (path) => {
  if (path !== "apps/mobile/package-lock.json") throw new Error(`unexpected lockfile ${path}`);
  return realLock;
};
const apply = (findings, today = "2026-10-28", options = { readLockfile }) => applyPolicy(findings, scoped, { today, scanners: ["trivy"], ...options });
// The fail-closed exception shape node-forge used until October 11, kept as a
// fixture so the strict-expiry machinery stays proven for the next one.
const { classification: _c, reached_only_through: _r, ...unclassified } = entry;
const exception = { ...unclassified, reviewed_on: "2026-10-08", expires_on: "2026-10-29", expiry_enforcement: "fail-closed" };
const strict = { ...policy, allowlist: [exception] };
const applyStrict = (findings, today = "2026-10-28") => applyPolicy(findings, strict, { today, scanners: ["trivy"] });

describe("Trivy node-forge build-tool classification", () => {
  it("is retired from the live policy once a patched node-forge (1.4.3 since November 10) is installed", () => {
    expect(policy.allowlist.filter(e => e.package === "node-forge" || [e.identifier, ...(e.alternate_identifiers ?? [])].includes("GHSA-86w9-cpqp-85rv"))).toEqual([]);
    expect(realLock.packages["node_modules/node-forge"].version).toBe("1.4.3");
  });

  it("binds exactly one advisory, package, installed version, severity and path, with no expiry", () => {
    expect(entry).toMatchObject({ identifier: ids[0], alternate_identifiers: [ids[1]], package: "node-forge",
      installed_version: "1.4.0", affected_range: "<=1.4.0", severity: "HIGH", path: "apps/mobile/package-lock.json",
      classification: "build-tool", reached_only_through: ["@expo/cli"], reviewed_on: "2026-10-11" });
    expect(entry).not.toHaveProperty("expires_on");
    expect(entry).not.toHaveProperty("expiry_enforcement");
    expect(validatePolicy(policy)).toEqual([]);
    expect(validatePolicy({ ...policy, allowlist: [...policy.allowlist, entry] })).toEqual([]);
  });
  it("matches the lockfile: node-forge is unreachable from production without @expo/cli", () => {
    expect(reachableInProduction(realLock, "node-forge", [])).toBe(true);
    expect(reachableInProduction(realLock, "node-forge", entry.reached_only_through)).toBe(false);
    // The scanner's copy and the mobile audit's copy must agree.
    for (const blocked of [[], ["@expo/cli"], ["expo"], ["@expo/code-signing-certificates"]]) {
      expect(lockfileReachableInProduction(realLock, "node-forge", blocked)).toBe(reachableInProduction(realLock, "node-forge", blocked));
      const full = { includeDev: true };
      expect(lockfileReachableInProduction(realLock, "node-forge", blocked, full)).toBe(reachableInProduction(realLock, "node-forge", blocked, full));
    }
    // The full install, dev dependencies included, reaches it only through @expo/cli.
    expect(lockfileBuildToolPathProven(realLock, "node-forge", entry.reached_only_through)).toBe(true);
    expect(buildToolPathProven(realLock, "node-forge", entry.reached_only_through)).toBe(true);
  });
  it("keeps the expo-updates route to node-forge build-time only", () => {
    const signing = mobileLock.packages["node_modules/@expo/code-signing-certificates"];
    expect(mobileLock.packages["node_modules/expo-updates"].dependencies).toHaveProperty("@expo/code-signing-certificates");
    expect(signing.dependencies).toHaveProperty("node-forge");
    // Its only dependents are Expo's CLI and expo-updates.
    const dependents = Object.entries(mobileLock.packages)
      .filter(([, value]) => value.dependencies?.["@expo/code-signing-certificates"])
      .map(([path]) => path).sort();
    expect(dependents).toEqual(["node_modules/@expo/cli", "node_modules/expo-updates"]);
    // Every other production route stays cut in both copies.
    expect(lockfileReachableInProduction(mobileLock, "node-forge", ["@expo/cli"])).toBe(true);
    expect(lockfileReachableInProduction(mobileLock, "node-forge", ["@expo/cli", "@expo/code-signing-certificates"])).toBe(false);
    expect(reachableInProduction(mobileLock, "node-forge", ["@expo/cli", "@expo/code-signing-certificates"])).toBe(false);
  });
  it("follows root peers and linked packages in both copies", () => {
    const peer = structuredClone(realLock);
    peer.packages[""].peerDependencies = { ...peer.packages[""].peerDependencies, "node-forge": "1.4.0" };
    const linked = structuredClone(realLock);
    linked.packages[""].dependencies = { ...linked.packages[""].dependencies, "local-signer": "file:packages/signer" };
    linked.packages["node_modules/local-signer"] = { resolved: "packages/signer", link: true };
    linked.packages["packages/signer"] = { version: "1.0.0", dependencies: { "node-forge": "^1.3.0" } };
    for (const lock of [peer, linked]) {
      expect(lockfileReachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(true);
      expect(reachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(true);
      expect(apply(normalizeTrivyReport(report(ids[0])), "2026-10-28", { readLockfile: () => lock }).blocking).toHaveLength(1);
    }
    const dangling = structuredClone(linked);
    delete dangling.packages["packages/signer"];
    expect(() => lockfileReachableInProduction(dangling, "node-forge", ["@expo/cli"])).toThrow("no target entry");
    expect(apply(normalizeTrivyReport(report(ids[0])), "2026-10-28", { readLockfile: () => dangling }).blocking).toHaveLength(1);
  });
  it("resolves through ancestor node_modules and npm aliases in both copies", () => {
    const ancestor = structuredClone(realLock);
    ancestor.packages[""].dependencies = { ...ancestor.packages[""].dependencies, "local-signer": "file:packages/signer" };
    ancestor.packages["node_modules/local-signer"] = { resolved: "packages/signer", link: true };
    ancestor.packages["packages/signer"] = { version: "1.0.0", dependencies: { helper: "1.0.0" } };
    ancestor.packages["packages/node_modules/helper"] = { version: "1.0.0", dependencies: { "node-forge": "^1.3.0" } };
    const alias = structuredClone(realLock);
    alias.packages[""].dependencies = { ...alias.packages[""].dependencies, "runtime-forge": "npm:node-forge@1.4.0" };
    alias.packages["node_modules/runtime-forge"] = { name: "node-forge", version: "1.4.0" };
    for (const lock of [ancestor, alias]) {
      expect(lockfileReachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(true);
      expect(reachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(true);
      expect(apply(normalizeTrivyReport(report(ids[0])), "2026-10-28", { readLockfile: () => lock }).blocking).toHaveLength(1);
    }
  });
  // the cut must not follow a package's metadata name.
  const forged = (dependency, entries) => {
    const lock = structuredClone(realLock);
    lock.packages[""].dependencies = { ...lock.packages[""].dependencies, [dependency]: "1.0.0" };
    Object.assign(lock.packages, entries);
    return lock;
  };
  const runtime = { dependencies: { "node-forge": "^1.3.0" } };
  // npm installs the registry @expo/cli hoisted or nested under expo, depending on the
  // resolution (hoisted since @expo/cli 57.0.33,); read whichever the lockfile holds.
  const cliPaths = ["node_modules/@expo/cli", "node_modules/expo/node_modules/@expo/cli"];
  const expoCliPath = (lock) => {
    const path = cliPaths.find((candidate) => lock.packages[candidate]);
    if (!path) throw new Error(`apps/mobile/package-lock.json has no @expo/cli entry at ${cliPaths.join(" or ")}`);
    return path;
  };
  const cliVersion = realLock.packages[expoCliPath(realLock)].version;
  const registry = `https://registry.npmjs.org/@expo/cli/-/cli-${cliVersion}.tgz`;
  it.each([
    ["a vendored file: package named @expo/cli", forged("compat-cli", {
      "node_modules/compat-cli": { resolved: "vendor/compat-cli", link: true },
      "vendor/compat-cli": { name: "@expo/cli", version: "57.0.28", ...runtime },
    })],
    ["a file: link installed in the @expo/cli folder", forged("@expo/cli", {
      "node_modules/@expo/cli": { resolved: "vendor/compat-cli", link: true },
      "vendor/compat-cli": { name: "@expo/cli", version: "57.0.28", ...runtime },
    })],
    ["a local tarball in the @expo/cli folder", forged("@expo/cli", {
      "node_modules/@expo/cli": { version: "57.0.28", resolved: "file:vendor/cli-57.0.28.tgz", ...runtime },
    })],
    ["a git install in the @expo/cli folder", forged("@expo/cli", {
      "node_modules/@expo/cli": { version: "57.0.28", resolved: "git+ssh://git@github.com/example/cli.git#5b7ed5f", ...runtime },
    })],
    ["an alias installed as @expo/cli", forged("@expo/cli", {
      "node_modules/@expo/cli": { name: "compat-cli", version: "1.0.0", resolved: "https://registry.npmjs.org/compat-cli/-/compat-cli-1.0.0.tgz", ...runtime },
    })],
  ])("keeps node-forge reachable through %s in both copies and blocks the finding", (_label, lock) => {
    expect(lockfileReachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(true);
    expect(reachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(true);
    const result = apply(normalizeTrivyReport(report(ids[0])), "2026-10-28", { readLockfile: () => lock });
    expect(result.blocking).toHaveLength(1);
    expect(result.recorded).toEqual([]);
  });
  it("still cuts the registry @expo/cli at its top-level or nested path in both copies", () => {
    const topLevel = forged("@expo/cli", { "node_modules/@expo/cli": { version: cliVersion, resolved: registry, ...runtime } });
    const nested = structuredClone(realLock);
    nested.packages["node_modules/expo/node_modules/@expo/cli"] = { version: cliVersion, resolved: registry, ...runtime };
    expect(realLock.packages[expoCliPath(realLock)].resolved).toBe(registry);
    for (const lock of [realLock, topLevel, nested]) {
      expect(lockfileReachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(false);
      expect(reachableInProduction(lock, "node-forge", ["@expo/cli"])).toBe(false);
      const result = apply(normalizeTrivyReport(report(ids[0])), "2026-10-28", { readLockfile: () => lock });
      expect(result.blocking).toEqual([]);
      expect(result.recorded).toHaveLength(1);
    }
  });
  it("refuses to prove a workspace lockfile in both copies", () => {
    const workspace = structuredClone(realLock);
    workspace.packages[""].workspaces = ["packages/*"];
    workspace.packages["node_modules/signer"] = { resolved: "packages/signer", link: true };
    workspace.packages["packages/signer"] = { name: "signer", version: "1.0.0", dependencies: { "node-forge": "^1.3.0" } };
    expect(() => lockfileReachableInProduction(workspace, "node-forge", ["@expo/cli"])).toThrow("declares workspaces");
    expect(() => reachableInProduction(workspace, "node-forge", ["@expo/cli"])).toThrow("declares workspaces");
    expect(apply(normalizeTrivyReport(report(ids[0])), "2026-10-28", { readLockfile: () => workspace }).blocking).toHaveLength(1);
  });
  it("re-proves the build-tool path on every scan and blocks when it cannot", () => {
    const finding = normalizeTrivyReport(report(ids[0]));
    expect(apply(finding, "2026-10-28", {}).blocking).toHaveLength(1);
    expect(apply(finding, "2026-10-28", { readLockfile: () => { throw new Error("missing"); } }).blocking).toHaveLength(1);
    const widened = structuredClone(realLock);
    widened.packages[""].dependencies = { ...widened.packages[""].dependencies, "review-signer": "1.0.0" };
    widened.packages["node_modules/review-signer"] = { version: "1.0.0", dependencies: { "node-forge": "^1.3.0" } };
    const result = apply(finding, "2026-10-28", { readLockfile: () => widened });
    expect(result.blocking).toHaveLength(1);
    expect(result.recorded).toEqual([]);
  });
  // only a positively proven route through the registry
  // build tool earns the classification. A package with any other route, dev or
  // production, or with no route at all, blocks as before.
  const devOnly = { packages: {
    "": { dependencies: {}, devDependencies: { "dev-signer": "1.0.0" } },
    "node_modules/dev-signer": { version: "1.0.0", dependencies: { "node-forge": "^1.3.0" } },
    "node_modules/node-forge": { version: "1.4.0" },
  } };
  const directDev = { packages: { "": { devDependencies: { "node-forge": "1.4.0" } }, "node_modules/node-forge": { version: "1.4.0" } } };
  const mixed = structuredClone(realLock);
  mixed.packages[""].devDependencies = { ...mixed.packages[""].devDependencies, "dev-signer": "1.0.0" };
  mixed.packages["node_modules/dev-signer"] = { version: "1.0.0", dev: true, dependencies: { "node-forge": "^1.3.0" } };
  const orphan = { packages: { "": { dependencies: {} }, "node_modules/node-forge": { version: "1.4.0" } } };
  it.each([
    ["dev-only, with no Expo path", devOnly],
    ["a direct devDependency, with no Expo path", directDev],
    ["the real Expo path plus a dev-only route that avoids Expo", mixed],
    ["no route from the root at all", orphan],
  ])("never classifies node-forge reached through %s", (_label, lock) => {
    expect(lockfileBuildToolPathProven(lock, "node-forge", ["@expo/cli"])).toBe(false);
    expect(buildToolPathProven(lock, "node-forge", ["@expo/cli"])).toBe(false);
    const result = apply(normalizeTrivyReport(report(ids[0])), "2027-10-29", { readLockfile: () => lock });
    expect(result.recorded).toEqual([]);
    expect(result.blocking).toHaveLength(1);
    expect(result.unused).toEqual([entry]);
  });
  it("classifies node-forge reached only through a registry @expo/cli under a dev-only expo", () => {
    const devExpo = structuredClone(realLock);
    const { expo, ...rest } = devExpo.packages[""].dependencies;
    devExpo.packages[""].dependencies = rest;
    devExpo.packages[""].devDependencies = { ...devExpo.packages[""].devDependencies, expo };
    const result = apply(normalizeTrivyReport(report(ids[0])), "2027-10-29", { readLockfile: () => devExpo });
    expect(result.blocking).toEqual([]);
    expect(result.recorded).toHaveLength(1);
  });
  it("the actual scanner CLI fails a dev-only node-forge with no Expo path", () => {
    const root = mkdtempSync(join(tmpdir(), "trivy-build-tool-dev-"));
    try {
      for (const path of ["scripts/lib", "config", "bin", "apps/mobile"]) mkdirSync(join(root, path), { recursive: true });
      for (const path of ["scripts/run-security-scan.mjs", "scripts/lib/security-scanner-policy.mjs"]) {
        copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
      }
      writeFileSync(join(root, "config/security-scanner-policy.json"), JSON.stringify(scoped));
      writeFileSync(join(root, "apps/mobile/package-lock.json"), JSON.stringify(devOnly));
      writeFileSync(join(root, "bin/docker"), `#!/bin/sh\ncat <<'REPORT'\n${JSON.stringify(report(ids[0]))}\nREPORT\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [join(root, "scripts/run-security-scan.mjs"), "trivy"], {
        encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      });
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stdout).not.toContain("recorded:");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(ids)("records %s below the blocking floor on and long after October 29", id => {
    for (const today of ["2026-10-28", "2026-10-29", "2027-10-29"]) {
      const result = apply(normalizeTrivyReport(report(id)), today);
      expect(result.blocking).toEqual([]);
      expect(result.accepted).toEqual([]);
      expect(result.recorded).toHaveLength(1);
      expect(result.expired).toEqual([]);
      expect(result.unused).toEqual([]);
    }
  });
  it.each([
    { VulnerabilityID: "CVE-2026-99999" }, { PkgName: "other-package" },
    { InstalledVersion: "1.4.1" }, { Severity: "CRITICAL" },
  ])("blocks a changed finding %j", change => {
    expect(apply(normalizeTrivyReport(report(ids[0], change))).blocking).toHaveLength(1);
  });
  it("blocks the advisory from a different lockfile and keeps other findings blocking", () => {
    const finding = normalizeTrivyReport(report(ids[0]))[0];
    expect(apply([{ ...finding, path: "package-lock.json" }]).blocking).toHaveLength(1);
    const result = apply([finding, { ...finding, identifier: "CVE-2026-99999" }]);
    expect(result.recorded).toHaveLength(1);
    expect(result.blocking).toHaveLength(1);
  });
  it("binds one installed version per entry, so several vulnerable copies take one entry each (picomatch, record #9048)", () => {
    const older = { ...entry, installed_version: "1.3.0", affected_range: "<=1.3.0" };
    const both = { ...policy, allowlist: [entry, older] };
    expect(validatePolicy(both)).toEqual([]);
    expect(validatePolicy({ ...policy, allowlist: [entry, { ...entry }] }))
      .toContain("allowlist entry 1 duplicates an earlier allowlist entry");
    const findings = normalizeTrivyReport({ SchemaVersion: 2, Results: [{ Target: "apps/mobile/package-lock.json", Vulnerabilities: ["1.4.0", "1.3.0"].map(version => ({
      VulnerabilityID: ids[0], PkgName: "node-forge", InstalledVersion: version, Severity: "HIGH",
    })) }] });
    const result = applyPolicy(findings, both, { today: "2026-10-28", scanners: ["trivy"], readLockfile });
    expect(result.blocking).toEqual([]);
    expect(result.recorded.map(finding => finding.installed_version).sort()).toEqual(["1.3.0", "1.4.0"]);
    const one = applyPolicy(findings, scoped, { today: "2026-10-28", scanners: ["trivy"], readLockfile });
    expect(one.blocking.map(finding => finding.installed_version)).toEqual(["1.3.0"]);
    expect(applyPolicy(findings.slice(0, 1), both, { today: "2026-10-28", scanners: ["trivy"], readLockfile }).unused).toEqual([older]);
  });
  it.each([
    { reached_only_through: [] }, { reached_only_through: ["node-forge"] }, { reached_only_through: "@expo/cli" },
    { expires_on: "2027-01-01" }, { expiry_enforcement: "fail-closed" }, { classification: "dev-only" },
    { package: "*" }, { installed_version: "<=1.4.0" }, { affected_range: "<=1.4.1" },
  ])("refuses widened or malformed classification fields %j", fields => {
    expect(validatePolicy({ ...policy, allowlist: [{ ...entry, ...fields }] }).length).toBeGreaterThan(0);
  });
  it("refuses the classification outside Trivy and build tools on an ordinary exception", () => {
    const gitleaks = policy.allowlist.find(e => e.scanner === "gitleaks");
    expect(validatePolicy({ ...policy, allowlist: [{ ...gitleaks, classification: "build-tool", reached_only_through: ["x"] }] }).length).toBeGreaterThan(0);
    expect(validatePolicy({ ...policy, allowlist: [{ ...exception, reached_only_through: ["@expo/cli"] }] }).length).toBeGreaterThan(0);
  });
});

describe("fail-closed Trivy exceptions (the shape node-forge used until October 11)", () => {
  it("validates the strict fixture", () => {
    expect(validatePolicy(strict)).toEqual([]);
  });
  it.each(ids)("accepts the exact finding reported as %s before expiry and blocks it on and after", id => {
    expect(applyStrict(normalizeTrivyReport(report(id))).accepted).toHaveLength(1);
    for (const today of ["2026-10-29", "2026-10-30"]) {
      const result = applyStrict(normalizeTrivyReport(report(id)), today);
      expect(result.accepted).toEqual([]);
      expect(result.blocking).toHaveLength(1);
      expect(result.expired).toEqual([exception]);
    }
  });
  it.each(["tree", "history"])("reports strict expiry in every selected scanner in %s mode", lane => {
    for (const scanner of ["semgrep", "gitleaks", "trivy"]) {
      const result = applyPolicy([], strict, { today: "2026-10-29", scanners: [scanner], lane });
      expect(result.expired).toEqual([exception]);
    }
  });
  it.each([false, true])("the actual scanner CLI exits %s on expiry without a date override", expired => {
    const root = mkdtempSync(join(tmpdir(), "trivy-expiry-"));
    try {
      for (const path of ["scripts/lib", "config", "bin"]) mkdirSync(join(root, path), { recursive: true });
      for (const path of ["scripts/run-security-scan.mjs", "scripts/lib/security-scanner-policy.mjs"]) {
        copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
      }
      const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
      const fixturePolicy = { ...strict, allowlist: [{ ...exception, reviewed_on: day(-14), expires_on: day(expired ? 0 : 1) }] };
      writeFileSync(join(root, "config/security-scanner-policy.json"), JSON.stringify(fixturePolicy));
      writeFileSync(join(root, "bin/docker"), `#!/bin/sh\ncat <<'REPORT'\n${JSON.stringify(report(ids[0]))}\nREPORT\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [join(root, "scripts/run-security-scan.mjs"), "trivy"], {
        encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      });
      expect(result.status, result.stdout + result.stderr).toBe(expired ? 1 : 0);
      if (expired) expect(result.stderr).toContain("reviewed exceptions have expired");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("the actual scanner CLI passes the build-tool finding with no date limit", () => {
    const root = mkdtempSync(join(tmpdir(), "trivy-build-tool-"));
    try {
      for (const path of ["scripts/lib", "config", "bin"]) mkdirSync(join(root, path), { recursive: true });
      for (const path of ["scripts/run-security-scan.mjs", "scripts/lib/security-scanner-policy.mjs"]) {
        copyFileSync(new URL(`../${path}`, import.meta.url), join(root, path));
      }
      writeFileSync(join(root, "config/security-scanner-policy.json"), JSON.stringify(scoped));
      mkdirSync(join(root, "apps/mobile"), { recursive: true });
      writeFileSync(join(root, "apps/mobile/package-lock.json"), JSON.stringify(realLock));
      writeFileSync(join(root, "bin/docker"), `#!/bin/sh\ncat <<'REPORT'\n${JSON.stringify(report(ids[0]))}\nREPORT\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [join(root, "scripts/run-security-scan.mjs"), "trivy"], {
        encoding: "utf8", env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("recorded: [trivy] HIGH CVE-2026-85393 apps/mobile/package-lock.json");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
