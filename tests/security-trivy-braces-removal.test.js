// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPolicy, loadPolicy, normalizeTrivyReport, validatePolicy } from "../scripts/lib/security-scanner-policy.mjs";

// braces <= 3.0.3 (GHSA-vfj7-8cjw-p6xm / CVE-2026-93687) has no patched release. It entered the
// mobile build only through metro-file-map -> micromatch, which calls micromatch.some() and nothing
// else, so the owner authorised replacing micromatch with a picomatch-backed shim instead of
// renewing the exception. The shim is vendored in apps/mobile/vendor/micromatch-picomatch, so the
// build depends on no package repository outside this one. These assertions keep both halves of
// that fix in place: the override stays on the vendored folder, and the exception cannot come back
// by itself.
const SHIM_DIR = "vendor/micromatch-picomatch";
const BRACES_TREE = ["braces", "fill-range", "to-regex-range", "is-number"];
const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const policy = loadPolicy();
const manifest = read("apps/mobile/package.json");
const lock = read("apps/mobile/package-lock.json");
const packages = Object.entries(lock.packages ?? {});
const finding = normalizeTrivyReport({ SchemaVersion: 2, Results: [{ Target: "apps/mobile/package-lock.json", Vulnerabilities: [{
  VulnerabilityID: "CVE-2026-93687", PkgName: "braces", InstalledVersion: "3.0.3", Severity: "HIGH",
}] }] });

describe("braces stays out of the mobile build", () => {
  it("overrides micromatch with the vendored shim folder", () => {
    expect(manifest.dependencies.micromatch).toBe(`file:./${SHIM_DIR}`);
    expect(manifest.overrides.micromatch).toBe("$micromatch");
  });

  it("resolves every micromatch node to that folder and fetches nothing from a git host", () => {
    const nodes = packages.filter(([path]) => path.endsWith("node_modules/micromatch"));
    expect(nodes).toEqual([["node_modules/micromatch", { resolved: SHIM_DIR, link: true }]]);
    const shim = lock.packages[SHIM_DIR];
    expect(read(`apps/mobile/${SHIM_DIR}/package.json`).name).toBe("micromatch-picomatch");
    expect(shim.version).toBe(read(`apps/mobile/${SHIM_DIR}/package.json`).version);
    expect(shim.version).not.toMatch(/^4\./);
    expect(Object.keys(shim.dependencies)).toEqual(["picomatch"]);
    for (const [, node] of packages) expect(String(node.resolved ?? "")).not.toMatch(/^(git\+|github:)/);
  });

  it("keeps the shim free of braces and its MIT notice in place", () => {
    const source = readFileSync(new URL(`../apps/mobile/${SHIM_DIR}/index.js`, import.meta.url), "utf8");
    expect(source).not.toMatch(/require\(["'](braces|micromatch)["']\)/);
    expect(readFileSync(new URL(`../apps/mobile/${SHIM_DIR}/LICENSE`, import.meta.url), "utf8")).toMatch(/^MIT License/);
  });

  it("leaves no braces, fill-range, to-regex-range or is-number node in the mobile lockfile", () => {
    for (const name of BRACES_TREE) {
      expect(packages.filter(([path]) => path.endsWith(`node_modules/${name}`))).toEqual([]);
      expect(packages.filter(([, node]) => node.name === name)).toEqual([]);
      for (const [, node] of packages) expect(Object.keys(node.dependencies ?? {})).not.toContain(name);
    }
  });

  it("carries no braces exception in either committed policy, and the policy still validates", () => {
    expect(policy.allowlist.filter(entry => entry.package === "braces")).toEqual([]);
    expect(JSON.stringify(policy)).not.toContain("GHSA-vfj7-8cjw-p6xm");
    expect(read("apps/mobile/security-audit-exceptions.json").exceptions.filter(entry => entry.package === "braces")).toEqual([]);
    expect(validatePolicy(policy)).toEqual([]);
  });

  it("blocks the advisory again if braces ever returns to the lockfile", () => {
    const result = applyPolicy(finding, policy, { today: "2026-10-28", scanners: ["trivy"] });
    expect(result.accepted).toEqual([]);
    expect(result.blocking).toHaveLength(1);
  });
});
