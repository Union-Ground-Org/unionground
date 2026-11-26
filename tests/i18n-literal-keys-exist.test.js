import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
// The feature strings register into the same catalogue on demand; load them all.
import "../src/lib/i18n/allLanguages.js";

// BUG-UG-COORDINATOR-DEADLINES-SHOWS-A-RAW-TEXT-KEY-AND-HIDES-OVERDUE-20261122
// (#9512, finding B-49): CoordinatorView asked for coordinator.deadlinesSliceSub,
// which no locale defined, so t() returned the key and a coordinator with a
// long case list read "coordinator.deadlinesSliceSub" under Upcoming deadlines.
// A key missing from both tables comes back verbatim by design (tests/i18n.test.js
// "falls back es -> en -> key"), so only a source scan catches it. This one
// reads every literal key handed to t() in src/ and requires an English entry;
// tests/i18n.test.js already requires the same key set in Spanish.
//
// What it cannot see: a key built at run time (t(`x.${kind}`), t(labelKey)).
// Those are checked where their key lists are known, not here. Some literal
// call shapes are missed too, for example a parenthesised condition,
// t((cond) ? "a.b" : "c.d").

const ROOT = process.cwd();
const KEY = String.raw`[a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+`;
// t("a.b") or t('a.b'), and both branches of t(cond ? "a.b" : "c.d").
const LITERAL = new RegExp(String.raw`\bt\(\s*["'](${KEY})["']`, "g");
const TERNARY = new RegExp(String.raw`\bt\(\s*[^()"',]{1,80}\?\s*["'](${KEY})["']\s*:\s*["'](${KEY})["']`, "g");

function literalKeys(source) {
  const keys = new Set();
  for (const match of source.matchAll(LITERAL)) keys.add(match[1]);
  for (const match of source.matchAll(TERNARY)) { keys.add(match[1]); keys.add(match[2]); }
  return keys;
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(dir, entry.name);
  if (entry.isDirectory()) return walk(path);
  return /\.(?:jsx?|mjs)$/.test(entry.name) ? [path] : [];
});

// The catalogue modules hold keys as data, not as lookups.
const sources = walk(resolve(ROOT, "src")).filter((path) => !relative(ROOT, path).replaceAll("\\", "/").startsWith("src/lib/i18n/"));

describe("every literal t() key in src/ has an English entry (#9512)", () => {
  it("finds the shape of the defect it guards against", () => {
    const keys = literalKeys('{t(queueExtra.cursor ? "coordinator.deadlinesSliceSub" : "coordinator.deadlinesSub", { shown: 1 })}');
    expect([...keys].sort()).toEqual(["coordinator.deadlinesSliceSub", "coordinator.deadlinesSub"]);
    expect([...literalKeys("t('gq.dueCount', { count })")]).toEqual(["gq.dueCount"]);
  });

  it("resolves each one", () => {
    let checked = 0;
    const missing = [];
    for (const path of sources) {
      const keys = literalKeys(readFileSync(path, "utf8"));
      checked += keys.size;
      for (const key of keys) {
        if (typeof catalogue.en[key] !== "string") missing.push(`${relative(ROOT, path)}: ${key}`);
      }
    }
    // A floor, so a broken pattern or path cannot pass by reading nothing
    // (9,554 per-file keys on November 23, 2026).
    expect(checked).toBeGreaterThan(8000);
    expect(missing, "literal t() keys with no English entry; add them to their area module under src/lib/i18n/locales/en and es").toEqual([]);
  });
});
