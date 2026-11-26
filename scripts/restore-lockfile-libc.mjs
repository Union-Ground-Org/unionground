#!/usr/bin/env node
// Ledger 395 repair (BUG-UG-SHARED-RED-TEST-REPOSITORY-CONVENTIONS-TEST-96F15639-20261118).
// Dependabot's npm rewrites package-lock.json without the optional Linux
// binaries' "libc" selectors (#8976, #9107, #9109), so a glibc install can pull
// musl binaries. The conventions check refuses that lock; this puts back every
// missing selector the reviewed inventory in config/dependency-overrides.json
// retains, at the key position npm itself writes, and leaves everything else in
// the lock byte for byte. A selector that is present but different is not
// rewritten: that is a real metadata change for a person to review.
//
// Usage: node scripts/restore-lockfile-libc.mjs [--root <checkout>]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LIBC_LOCKFILES, lockfileLibcFindings } from "./verify-repository-conventions.mjs";

const NPM_HEAD_KEYS = new Set(["name", "version", "resolved", "integrity", "link"]);

// npm writes version, resolved and integrity first, then the platform and flag
// keys in name order (cpu, dev, libc, license, optional, os) before the rest.
function withLibc(entry, libc) {
  const keys = Object.keys(entry);
  let at = 0;
  while (at < keys.length && NPM_HEAD_KEYS.has(keys[at])) at += 1;
  while (at < keys.length && keys[at] < "libc") at += 1;
  const out = {};
  keys.slice(0, at).forEach(key => { out[key] = entry[key]; });
  out.libc = [...libc];
  keys.slice(at).forEach(key => { out[key] = entry[key]; });
  return out;
}

export function restoreLockLibc(lock, selectors) {
  const restored = [];
  const packages = lock?.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) return { lock, restored };
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.includes("node_modules/") || !entry || typeof entry !== "object") continue;
    const expected = selectors?.[path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)];
    if (!Array.isArray(expected) || Object.hasOwn(entry, "libc")) continue;
    packages[path] = withLibc(entry, expected);
    restored.push(path);
  }
  return { lock, restored };
}

export function restoreLockfiles(root) {
  const policy = JSON.parse(readFileSync(join(root, "config/dependency-overrides.json"), "utf8")).lockfileLibc;
  const locks = {};
  const restored = {};
  for (const name of LIBC_LOCKFILES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const result = restoreLockLibc(JSON.parse(text), policy?.manifests?.[name]);
    locks[name] = result.lock;
    restored[name] = result.restored;
    if (result.restored.length) {
      writeFileSync(file, `${JSON.stringify(result.lock, null, 2)}${text.endsWith("\n") ? "\n" : ""}`);
    }
  }
  return { restored, remaining: lockfileLibcFindings(locks, policy) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--root");
  const root = at > 0 ? resolve(process.argv[at + 1] ?? ".") : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { restored, remaining } = restoreLockfiles(root);
  for (const [name, paths] of Object.entries(restored)) {
    console.log(`LOCKFILE_LIBC_RESTORED ${name}: ${paths.length}${paths.length ? ` (${paths.join(", ")})` : ""}`);
  }
  for (const finding of remaining) console.error(`LOCKFILE_LIBC_REMAINING ${finding}`);
  if (remaining.length) process.exitCode = 1;
}
