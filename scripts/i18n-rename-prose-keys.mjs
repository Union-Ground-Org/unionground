#!/usr/bin/env node
// Re-runnable codemod for UX-UG-I18N-KEY-NAMES-SPELL-THE-ENGLISH-COPY-20260917.
//
//   node scripts/i18n-rename-prose-keys.mjs --apply   # rewrite catalogue + call sites
//   node scripts/i18n-rename-prose-keys.mjs --check   # assert mapping vs live catalogue
//
// `--check` is the mechanical EN/ES value-multiset equality gate: the frozen
// values in the mapping table must equal the live catalogue values at each
// `to` key, the `from` keys must be gone, and the renamed EN/ES multisets
// must match the frozen ones. Re-running `--apply` after a successful check
// is a no-op.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROSE_KEY_RENAMES } from "./lib/i18n-prose-key-rename-map.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..");

const CONVENTION_LINE = [
  "// KEY NAMES: a key names the surface and the role, never the sentence it",
  "// holds (automation.discover.heroTitle, not a dotted English sentence).",
  "// Disambiguate with a role suffix, never an ordinal (.2).",
].join("\n");

const APPLY_ROOTS = ["src", "tests"];
const APPLY_SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const TEXT_EXT = /\.(js|jsx|mjs|ts|tsx)$/;

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (APPLY_SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, acc);
    else if (TEXT_EXT.test(entry.name)) acc.push(path);
  }
  return acc;
}

function sortedValues(rows, locale) {
  return rows.map((row) => row[locale]).slice().sort();
}

function replaceQuotedKeys(source, from, to) {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(["'\`])${escaped}\\1`, "g");
  return source.replace(pattern, `$1${to}$1`);
}

export function applyProseKeyRename(root = REPOSITORY_ROOT) {
  const files = APPLY_ROOTS.flatMap((dir) => walk(join(root, dir)));
  const ordered = [...PROSE_KEY_RENAMES].sort((a, b) => b.from.length - a.from.length);
  const changed = [];
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel === "scripts/lib/i18n-prose-key-rename-map.mjs") continue;
    if (rel === "scripts/i18n-rename-prose-keys.mjs") continue;
    if (rel === "tests/i18n-prose-key-rename.test.js") continue;
    const before = readFileSync(file, "utf8");
    let next = before;
    for (const { from, to } of ordered) next = replaceQuotedKeys(next, from, to);
    if (rel === "src/lib/i18n.js" && !next.includes("KEY NAMES: a key names the surface and the role")) {
      const needle = "// (delegado/delegada, Paso 1, comprobante, boleta, Ajustes, etc.).\n";
      if (!next.includes(needle)) {
        throw new Error("i18n.js header needle missing — update the convention insert");
      }
      next = next.replace(needle, `${needle}${CONVENTION_LINE}\n`);
    }
    if (next !== before) {
      writeFileSync(file, next);
      changed.push(rel);
    }
  }
  return changed;
}

export function checkProseKeyRename(catalogue) {
  const failures = [];
  const liveEn = [];
  const liveEs = [];
  const seenTo = new Set();
  for (const row of PROSE_KEY_RENAMES) {
    if (seenTo.has(row.to)) failures.push(`mapping duplicate to ${row.to}`);
    seenTo.add(row.to);
    if (row.from in catalogue.en) failures.push(`old key still in en: ${row.from}`);
    if (row.from in catalogue.es) failures.push(`old key still in es: ${row.from}`);
    if (!(row.to in catalogue.en)) failures.push(`new key missing from en: ${row.to}`);
    if (!(row.to in catalogue.es)) failures.push(`new key missing from es: ${row.to}`);
    if (catalogue.en[row.to] !== row.en) {
      failures.push(`en value drifted for ${row.to}`);
    }
    if (catalogue.es[row.to] !== row.es) {
      failures.push(`es value drifted for ${row.to}`);
    }
    if (catalogue.en[row.to] !== undefined) liveEn.push(catalogue.en[row.to]);
    if (catalogue.es[row.to] !== undefined) liveEs.push(catalogue.es[row.to]);
  }
  const frozenEn = sortedValues(PROSE_KEY_RENAMES, "en");
  const frozenEs = sortedValues(PROSE_KEY_RENAMES, "es");
  liveEn.sort();
  liveEs.sort();
  const enEqual = JSON.stringify(liveEn) === JSON.stringify(frozenEn);
  const esEqual = JSON.stringify(liveEs) === JSON.stringify(frozenEs);
  if (!enEqual) failures.push("EN value multiset of renamed keys does not equal the frozen mapping");
  if (!esEqual) failures.push("ES value multiset of renamed keys does not equal the frozen mapping");
  const enKeys = Object.keys(catalogue.en).sort();
  const esKeys = Object.keys(catalogue.es).sort();
  if (JSON.stringify(enKeys) !== JSON.stringify(esKeys)) {
    failures.push("catalogue en/es key sets differ");
  }
  return {
    ok: failures.length === 0,
    failures,
    renamed: PROSE_KEY_RENAMES.length,
    enMultisetEqual: enEqual,
    esMultisetEqual: esEqual,
    enCount: liveEn.length,
    esCount: liveEs.length,
  };
}

export function leftoverProseKeys(root = REPOSITORY_ROOT) {
  const leftovers = [];
  const files = APPLY_ROOTS.flatMap((dir) => walk(join(root, dir)));
  const ordered = [...PROSE_KEY_RENAMES].sort((a, b) => b.from.length - a.from.length);
  for (const file of files) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (rel.startsWith("scripts/")) continue;
    if (rel === "tests/i18n-prose-key-rename.test.js") continue;
    const source = readFileSync(file, "utf8");
    for (const { from } of ordered) {
      const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(["'\`])${escaped}\\1`).test(source)) {
        leftovers.push(`${rel}: ${from}`);
      }
    }
  }
  return leftovers;
}

function printReport(result) {
  console.log(`renamed keys: ${result.renamed}`);
  console.log(`EN value multiset: frozen=${result.enCount} live=${result.enCount} equal=${result.enMultisetEqual}`);
  console.log(`ES value multiset: frozen=${result.esCount} live=${result.esCount} equal=${result.esMultisetEqual}`);
  if (result.failures.length) {
    console.log("failures:");
    for (const line of result.failures) console.log(`  ${line}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const mode = process.argv.includes("--apply") ? "apply" : "check";
  if (mode === "apply") {
    const changed = applyProseKeyRename();
    console.log(changed.length ? `rewrote:\n  ${changed.join("\n  ")}` : "already applied (no file changes)");
  }
  const { catalogue } = await import("../src/lib/i18n/allLanguages.js");
  const result = checkProseKeyRename(catalogue);
  printReport(result);
  const leftovers = leftoverProseKeys();
  if (leftovers.length) {
    console.log("leftover old keys:");
    for (const line of leftovers) console.log(`  ${line}`);
  }
  if (!result.ok || leftovers.length) process.exit(1);
}
