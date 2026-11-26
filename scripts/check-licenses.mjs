#!/usr/bin/env node
// License gate: every production package locked in package-lock.json and
// apps/mobile/package-lock.json must declare a license that is compatible with
// Union Ground's own license, AGPL-3.0-only.
//
// The check reads the `license` field npm records for each package in the lock
// file. It fails closed: a license expression passes only when it evaluates
// true against ALLOWED_LICENSES (an OR passes when one side does, an AND only
// when both do). A missing license, UNLICENSED, a source-available license
// (SSPL, BUSL, FSL, Elastic, Commons Clause), a non-commercial license
// (CC-BY-NC) or GPL-2.0-only fails. Development-only packages (`"dev": true`)
// are not shipped and are not checked.
//
// A package that fails but has been reviewed goes in EXCEPTIONS with the
// exact license it declares and the reason; a license change on an excepted
// package fails again until it is reviewed again.
//
// Usage: node scripts/check-licenses.mjs [--list] [lockfile ...]

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..");
export const DEFAULT_LOCKFILES = Object.freeze(["package-lock.json", "apps/mobile/package-lock.json"]);

// SPDX identifiers whose terms allow combination with, or distribution beside,
// AGPL-3.0-only code (the FSF's GPLv3-compatible list).
export const ALLOWED_LICENSES = Object.freeze(new Set([
  "0BSD",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "WTFPL",
  "X11",
  "Zlib",
]));

// Reviewed packages that would otherwise fail. `name` is an exact package name
// or a RegExp; `license` must match the lock file exactly.
export const EXCEPTIONS = Object.freeze([
  {
    name: /^@sentry\/cli(?:-[a-z0-9-]+)?$/,
    license: "FSL-1.1-MIT",
    reason: "Build-time command-line tool that uploads debug symbols and source maps; it is not linked into "
      + "or shipped with the app.",
  },
]);

// Older SPDX spellings npm packages still use.
const ALIASES = new Map([
  ["GPL-2.0+", "GPL-2.0-or-later"],
  ["GPL-3.0", "GPL-3.0-only"],
  ["GPL-3.0+", "GPL-3.0-or-later"],
  ["LGPL-2.1", "LGPL-2.1-only"],
  ["LGPL-2.1+", "LGPL-2.1-or-later"],
  ["LGPL-3.0", "LGPL-3.0-only"],
  ["LGPL-3.0+", "LGPL-3.0-or-later"],
  ["AGPL-3.0", "AGPL-3.0-only"],
  ["AGPL-3.0+", "AGPL-3.0-or-later"],
]);

function tokenize(expression) {
  return expression.replace(/[()]/g, " $& ").trim().split(/\s+/).filter(Boolean);
}

// Parses an SPDX license expression into a tree of { op, left, right } and
// { id } nodes. Throws on a malformed expression.
export function parseSpdx(expression) {
  if (typeof expression !== "string" || !expression.trim()) throw new Error("empty license expression");
  const tokens = tokenize(expression);
  let i = 0;
  const peek = () => tokens[i]?.toUpperCase();
  const atom = () => {
    const token = tokens[i++];
    if (token === undefined) throw new Error(`unexpected end of license expression ${JSON.stringify(expression)}`);
    if (token === "(") {
      const inner = or();
      if (tokens[i++] !== ")") throw new Error(`unbalanced parentheses in ${JSON.stringify(expression)}`);
      return inner;
    }
    if (token === ")" || ["AND", "OR", "WITH"].includes(token.toUpperCase())) {
      throw new Error(`unexpected ${token} in ${JSON.stringify(expression)}`);
    }
    let node = { id: ALIASES.get(token) ?? token };
    if (peek() === "WITH") {
      i += 1;
      const exception = tokens[i++];
      if (!exception || exception === "(" || exception === ")") throw new Error(`WITH needs an exception in ${JSON.stringify(expression)}`);
      node = { ...node, exception };
    }
    return node;
  };
  const and = () => {
    let left = atom();
    while (peek() === "AND") { i += 1; left = { op: "AND", left, right: atom() }; }
    return left;
  };
  const or = () => {
    let left = and();
    while (peek() === "OR") { i += 1; left = { op: "OR", left, right: and() }; }
    return left;
  };
  const tree = or();
  if (i !== tokens.length) throw new Error(`unexpected ${tokens[i]} in ${JSON.stringify(expression)}`);
  return tree;
}

function evaluate(node, allowed) {
  if (node.op === "OR") return evaluate(node.left, allowed) || evaluate(node.right, allowed);
  if (node.op === "AND") return evaluate(node.left, allowed) && evaluate(node.right, allowed);
  // A license exception (e.g. "WITH Classpath-exception-2.0") only adds
  // permissions, so the base license decides.
  return allowed.has(node.id);
}

// True when the expression is compatible with AGPL-3.0-only.
export function isAllowedLicense(expression, allowed = ALLOWED_LICENSES) {
  try {
    return evaluate(parseSpdx(expression), allowed);
  } catch {
    return false;
  }
}

function packageName(path, entry) {
  if (entry.name) return entry.name;
  const index = path.lastIndexOf("node_modules/");
  return index < 0 ? path : path.slice(index + "node_modules/".length);
}

function declaredLicense(entry) {
  const { license } = entry;
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && typeof license.type === "string") return license.type;
  return undefined;
}

const exceptionMatches = (exception, name) =>
  exception.name instanceof RegExp ? exception.name.test(name) : exception.name === name;

// Checks one parsed lock file (lockfileVersion 2 or 3). Returns
// { checked, problems, excepted, unusedExceptions, licenses }.
export function checkLockfile(lockfile, { exceptions = EXCEPTIONS, allowed = ALLOWED_LICENSES } = {}) {
  const packages = lockfile?.packages;
  if (!packages || typeof packages !== "object") {
    throw new Error("lock file has no \"packages\" map; regenerate it with npm 7 or later (lockfileVersion 2 or 3)");
  }
  const problems = [];
  const excepted = [];
  const used = new Set();
  const licenses = new Map();
  let checked = 0;
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "" || entry.link || entry.dev === true) continue;
    checked += 1;
    const name = packageName(path, entry);
    const license = declaredLicense(entry);
    licenses.set(license ?? "(none)", (licenses.get(license ?? "(none)") ?? 0) + 1);
    if (license !== undefined && isAllowedLicense(license, allowed)) continue;
    const exception = exceptions.find((candidate) => exceptionMatches(candidate, name) && candidate.license === license);
    if (exception) {
      used.add(exception);
      excepted.push({ path, name, version: entry.version, license, reason: exception.reason });
      continue;
    }
    problems.push({
      path,
      name,
      version: entry.version,
      license: license ?? null,
      reason: license === undefined
        ? "declares no license"
        : `license ${JSON.stringify(license)} is not on the AGPL-3.0-compatible allowlist`,
    });
  }
  const unusedExceptions = exceptions.filter((exception) => !used.has(exception));
  return { checked, problems, excepted, unusedExceptions, licenses };
}

export function checkLockfiles(paths = DEFAULT_LOCKFILES, { root = REPOSITORY_ROOT, ...options } = {}) {
  return paths.map((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) throw new Error(`${path} does not exist`);
    return { path, ...checkLockfile(JSON.parse(readFileSync(absolute, "utf8")), options) };
  });
}

function main(argv) {
  const list = argv.includes("--list");
  const paths = argv.filter((arg) => arg !== "--list");
  const results = checkLockfiles(paths.length ? paths : DEFAULT_LOCKFILES);
  let failed = false;
  const usedAnywhere = new Set();
  for (const result of results) {
    for (const exception of EXCEPTIONS) if (!result.unusedExceptions.includes(exception)) usedAnywhere.add(exception);
    console.log(`${result.path}: ${result.checked} production packages checked, `
      + `${result.excepted.length} reviewed exceptions, ${result.problems.length} problems.`);
    if (list) {
      for (const [license, count] of [...result.licenses].sort((a, b) => b[1] - a[1])) console.log(`  ${count}\t${license}`);
      for (const item of result.excepted) console.log(`  exception: ${item.name}@${item.version} (${item.license}): ${item.reason}`);
    }
    for (const problem of result.problems) {
      failed = true;
      console.error(`  FAIL ${problem.name}@${problem.version} (${problem.path}): ${problem.reason}`);
    }
  }
  for (const exception of EXCEPTIONS) {
    if (!usedAnywhere.has(exception)) {
      console.warn(`warning: exception for ${exception.name} (${exception.license}) matches no locked package; remove it.`);
    }
  }
  if (failed) {
    console.error("License check failed. Replace the package, or review it and add it to EXCEPTIONS in scripts/check-licenses.mjs with the reason.");
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
