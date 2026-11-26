// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCKFILES,
  EXCEPTIONS,
  checkLockfile,
  checkLockfiles,
  isAllowedLicense,
  parseSpdx,
} from "../scripts/check-licenses.mjs";

const lock = (packages) => ({
  name: "fixture-app",
  lockfileVersion: 3,
  packages: { "": { name: "fixture-app", version: "1.0.0", license: "AGPL-3.0-only" }, ...packages },
});
const pkg = (license, extra = {}) => ({ version: "1.0.0", ...(license === undefined ? {} : { license }), ...extra });

describe("SPDX expression evaluation", () => {
  it("parses AND, OR, WITH and parentheses with AND binding tighter than OR", () => {
    expect(parseSpdx("MIT OR Apache-2.0 AND BSD-3-Clause")).toEqual({
      op: "OR",
      left: { id: "MIT" },
      right: { op: "AND", left: { id: "Apache-2.0" }, right: { id: "BSD-3-Clause" } },
    });
    expect(parseSpdx("(GPL-2.0-or-later WITH Classpath-exception-2.0)")).toEqual({
      id: "GPL-2.0-or-later", exception: "Classpath-exception-2.0",
    });
    for (const bad of ["", "(MIT", "MIT)", "MIT OR", "AND MIT", "MIT WITH"]) expect(() => parseSpdx(bad), bad).toThrow();
  });

  it("allows AGPL-compatible licenses and expressions", () => {
    for (const license of [
      "MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "MPL-2.0", "LGPL-3.0-or-later",
      "CC-BY-4.0", "Python-2.0", "BlueOak-1.0.0", "(MPL-2.0 OR Apache-2.0)", "(MIT AND Zlib)",
      "Apache-2.0 AND LGPL-3.0-or-later AND MIT", "(BSD-3-Clause OR GPL-2.0)", "(MIT OR CC0-1.0)",
      "AGPL-3.0", "GPL-3.0+", "MIT or Apache-2.0",
    ]) expect(isAllowedLicense(license), license).toBe(true);
  });

  it("refuses proprietary, source-available, non-commercial and GPLv2-only licenses", () => {
    for (const license of [
      "UNLICENSED", "SEE LICENSE IN LICENSE.txt", "SSPL-1.0", "BUSL-1.1", "Elastic-2.0", "FSL-1.1-MIT",
      "FSL-1.1-Apache-2.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "Commons-Clause", "GPL-2.0-only", "GPL-2.0",
      "MIT AND SSPL-1.0", "(BUSL-1.1 OR CC-BY-NC-4.0)", "", "(MIT",
    ]) expect(isAllowedLicense(license), license).toBe(false);
  });
});

describe("lock file license check", () => {
  it("fails on a disallowed or missing license in a production package", () => {
    const result = checkLockfile(lock({
      "node_modules/fine": pkg("MIT"),
      "node_modules/server-side": pkg("SSPL-1.0"),
      "node_modules/business": pkg("BUSL-1.1"),
      "node_modules/@scope/nc": pkg("CC-BY-NC-4.0"),
      "node_modules/closed": pkg("UNLICENSED"),
      "node_modules/nothing": pkg(undefined),
      "node_modules/fine/node_modules/nested": pkg("GPL-2.0-only"),
    }), { exceptions: [] });
    expect(result.checked).toBe(7);
    expect(result.problems.map((problem) => [problem.name, problem.license])).toEqual([
      ["server-side", "SSPL-1.0"],
      ["business", "BUSL-1.1"],
      ["@scope/nc", "CC-BY-NC-4.0"],
      ["closed", "UNLICENSED"],
      ["nothing", null],
      ["nested", "GPL-2.0-only"],
    ]);
    expect(result.problems.find((problem) => problem.name === "nothing").reason).toBe("declares no license");
  });

  it("skips development-only packages and links but checks optional and devOptional ones", () => {
    const result = checkLockfile(lock({
      "node_modules/test-tool": pkg("BUSL-1.1", { dev: true }),
      "node_modules/workspace": { resolved: "packages/workspace", link: true },
      "node_modules/native-binary": pkg("SSPL-1.0", { optional: true }),
      "node_modules/dual-use": pkg("BUSL-1.1", { devOptional: true }),
    }), { exceptions: [] });
    expect(result.checked).toBe(2);
    expect(result.problems.map((problem) => problem.name)).toEqual(["native-binary", "dual-use"]);
  });

  it("honours a reviewed exception only for the exact license it names", () => {
    const exceptions = [{ name: /^@vendor\/cli(?:-.+)?$/, license: "FSL-1.1-MIT", reason: "build tool" }];
    const passing = checkLockfile(lock({
      "node_modules/@vendor/cli": pkg("FSL-1.1-MIT"),
      "node_modules/@vendor/cli-linux-x64": pkg("FSL-1.1-MIT", { optional: true }),
    }), { exceptions });
    expect(passing.problems).toEqual([]);
    expect(passing.excepted.map((item) => item.name)).toEqual(["@vendor/cli", "@vendor/cli-linux-x64"]);
    expect(passing.unusedExceptions).toEqual([]);

    const relicensed = checkLockfile(lock({ "node_modules/@vendor/cli": pkg("BUSL-1.1") }), { exceptions });
    expect(relicensed.problems.map((problem) => problem.name)).toEqual(["@vendor/cli"]);
    expect(relicensed.unusedExceptions).toEqual(exceptions);
  });

  it("refuses a lock file without a packages map", () => {
    expect(() => checkLockfile({ lockfileVersion: 1, dependencies: {} })).toThrow(/packages/);
  });

  it("gives every reviewed exception an exact license and a reason", () => {
    for (const exception of EXCEPTIONS) {
      expect(typeof exception.license).toBe("string");
      expect(isAllowedLicense(exception.license), exception.license).toBe(false);
      expect(exception.reason.length).toBeGreaterThan(20);
    }
  });

  it("passes on the repository's web and mobile lock files", () => {
    const results = checkLockfiles(DEFAULT_LOCKFILES);
    expect(results.map((result) => result.path)).toEqual(["package-lock.json", "apps/mobile/package-lock.json"]);
    for (const result of results) {
      expect(result.checked, result.path).toBeGreaterThan(50);
      expect(result.problems, result.path).toEqual([]);
    }
  });

  it("is wired into package.json as verify:licenses", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.scripts["verify:licenses"]).toBe("node scripts/check-licenses.mjs");
    expect(manifest.license).toBe("AGPL-3.0-only");
  });
});
