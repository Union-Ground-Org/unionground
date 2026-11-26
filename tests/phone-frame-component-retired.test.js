// @vitest-environment node
//
// DEBT-UG-DEAD-PHONE-FRAME-COMPONENT-20260920 — the companion-phone shell
// was removed by REQ-UNION-GROUND-DEMO-DESK-SHELL-20260820, but its standalone
// PhoneFrame bezel component survived as unimported source carrying an
// accepted-debt allowance in the quality ratchet. Modelled on
// tests/casework-retired-w2-layer.test.js: this file is the durable half of the
// removal. It fails if the component file, an import of it, or the baseline
// allowance comes back.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");

const COMPONENT_PATH = "src/components/PhoneFrame.jsx";
const RETIRED_IDENTIFIER = /\bPhoneFrame\b/;
// This file names the retired identifier on purpose, so the sweep below must
// not count itself as a reintroduction.
const SELF_PATH = relative(root, fileURLToPath(import.meta.url)).replaceAll("\\", "/");
const SOURCE_ROOTS = ["src", "tests", "e2e", "apps/mobile/src"];
const SOURCE_EXTENSIONS = [".js", ".jsx", ".mjs", ".ts", ".tsx"];

function walk(directory) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "dist" || name === "coverage" || name === ".expo") continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) results.push(...walk(path));
    else if (SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension))) results.push(path);
  }
  return results;
}

function sourceFiles() {
  return SOURCE_ROOTS
    .map((directory) => resolve(root, directory))
    .filter((directory) => existsSync(directory))
    .flatMap((directory) => walk(directory))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter((path) => path !== SELF_PATH);
}

describe("the retired companion-phone frame component", () => {
  it("no longer exists as source", () => {
    expect(existsSync(resolve(root, COMPONENT_PATH))).toBe(false);
  });

  it("is named by no module under src, tests, e2e, or the mobile client", () => {
    const offenders = sourceFiles().filter((path) => RETIRED_IDENTIFIER.test(read(path)));
    expect(offenders).toEqual([]);
  });

  it("holds no unused-export allowance in the static-quality baseline", () => {
    const baseline = JSON.parse(read("config/static-quality-baseline.json"));
    expect(baseline.unused_exports.filter((entry) => RETIRED_IDENTIFIER.test(entry))).toEqual([]);
  });
});
