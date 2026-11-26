// BUG-UG-SHARED-RED-TEST-REPOSITORY-CONVENTIONS-TEST-96F15639-20261118:
// Dependabot's npm drops the retained libc selectors (ledger 395) from every
// lock it writes (#8976, #9107, #9109). scripts/restore-lockfile-libc.mjs puts
// them back so a Dependabot head can be repaired in place.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { restoreLockfiles, restoreLockLibc } from "../scripts/restore-lockfile-libc.mjs";
import { LIBC_LOCKFILES, lockfileLibcFindings } from "../scripts/verify-repository-conventions.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const register = readFileSync(join(repoRoot, "config/dependency-overrides.json"), "utf8");
const policy = JSON.parse(register).lockfileLibc;
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function inventory(name) {
  return policy.manifests[name];
}

// What Dependabot's npm writes: the same lock with every retained selector gone.
function stripped(text, name) {
  const lock = JSON.parse(text);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (inventory(name)[path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)]) delete entry.libc;
  }
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function checkout(locks) {
  const root = mkdtempSync(join(tmpdir(), "restore-lockfile-libc-"));
  roots.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config/dependency-overrides.json"), register);
  for (const [name, text] of Object.entries(locks)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe("restore-lockfile-libc (ledger 395)", () => {
  it("rebuilds both shipped locks byte for byte from their Dependabot-stripped copies", () => {
    const shipped = Object.fromEntries(LIBC_LOCKFILES.map(name => [name, readFileSync(join(repoRoot, name), "utf8")]));
    const root = checkout(Object.fromEntries(LIBC_LOCKFILES.map(name => [name, stripped(shipped[name], name)])));
    const before = Object.fromEntries(LIBC_LOCKFILES.map(name => [name, JSON.parse(readFileSync(join(root, name), "utf8"))]));
    expect(lockfileLibcFindings(before, policy)).toHaveLength(
      Object.keys(inventory("package-lock.json")).length + Object.keys(inventory("apps/mobile/package-lock.json")).length,
    );

    const { restored, remaining } = restoreLockfiles(root);

    expect(remaining).toEqual([]);
    for (const name of LIBC_LOCKFILES) {
      expect(restored[name]).toHaveLength(Object.keys(inventory(name)).length);
      expect(readFileSync(join(root, name), "utf8")).toBe(shipped[name]);
    }
    expect(restoreLockfiles(root).restored).toEqual(Object.fromEntries(LIBC_LOCKFILES.map(name => [name, []])));
  });

  it("restores the ten entries captured from PR 8976 between dev and license", () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, "tests/fixtures/dependabot-libc-loss.json"), "utf8"));
    const { restored } = restoreLockLibc(lock, inventory("package-lock.json"));

    expect(restored).toHaveLength(10);
    expect(lockfileLibcFindings({ "package-lock.json": lock }, policy)).toEqual([]);
    for (const entry of Object.values(lock.packages)) {
      const keys = Object.keys(entry);
      expect(keys.indexOf("libc")).toBe(keys.indexOf("license") - 1);
    }
  });

  it("restores nested copies, leaves unlisted packages alone and never rewrites a changed selector", () => {
    const binary = { version: "9.0.0", cpu: ["x64"], license: "MIT", optional: true, os: ["linux"] };
    const lock = {
      packages: {
        "": { name: "fixture" },
        "node_modules/parent/node_modules/@rolldown/binding-linux-x64-musl": { ...binary },
        "node_modules/unlisted-binary": { ...binary },
        "node_modules/@rolldown/binding-linux-x64-gnu": { ...binary, libc: ["musl"] },
      },
    };

    const { restored } = restoreLockLibc(lock, inventory("package-lock.json"));

    expect(restored).toEqual(["node_modules/parent/node_modules/@rolldown/binding-linux-x64-musl"]);
    expect(Object.keys(lock.packages[restored[0]])).toEqual(["version", "cpu", "libc", "license", "optional", "os"]);
    expect(lock.packages[restored[0]].libc).toEqual(["musl"]);
    expect(lock.packages["node_modules/unlisted-binary"]).not.toHaveProperty("libc");
    expect(lockfileLibcFindings({ "package-lock.json": lock }, policy)).toEqual([
      'package-lock.json: node_modules/@rolldown/binding-linux-x64-gnu lost or changed its libc selector; expected ["glibc"]',
    ]);
    expect(restoreLockLibc({}, inventory("package-lock.json")).restored).toEqual([]);
  });

  it("the command repairs a checkout and fails on a changed selector it must not rewrite", () => {
    const name = "package-lock.json";
    const shipped = readFileSync(join(repoRoot, name), "utf8");
    const root = checkout({ [name]: stripped(shipped, name) });
    const script = join(repoRoot, "scripts/restore-lockfile-libc.mjs");

    const repaired = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    expect(repaired.status).toBe(0);
    expect(repaired.stdout).toContain(`LOCKFILE_LIBC_RESTORED ${name}: ${Object.keys(inventory(name)).length} (`);
    expect(readFileSync(join(root, name), "utf8")).toBe(shipped);

    const pkg = Object.keys(inventory(name))[0];
    writeFileSync(join(root, name), shipped.replace(
      new RegExp(`("node_modules/${pkg.replace(/[/.]/g, "\\$&")}": \\{[^}]*?"libc": \\[\\n\\s*)"(?:glibc|musl)"`),
      `$1"${inventory(name)[pkg][0] === "musl" ? "glibc" : "musl"}"`,
    ));
    const changed = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    expect(changed.status).toBe(1);
    expect(changed.stdout).toContain(`LOCKFILE_LIBC_RESTORED ${name}: 0`);
    expect(changed.stderr).toContain(`LOCKFILE_LIBC_REMAINING ${name}: node_modules/${pkg} lost or changed its libc selector`);
  });
});
