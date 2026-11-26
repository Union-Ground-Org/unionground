#!/usr/bin/env node
// UX-UG-ES-USTED-CENSUS-TIER2-20260917
//
//   node scripts/census-es-usted.mjs
//
// Counts the formal-register strings left in catalogue.es in two tiers and
// attributes each key from scripts/lib/es-usted-census-inventory.json:
//   tier 1 - usted/ustedes + the formal-imperative union (key, disposition,
//            owning record or UNOWNED, matched words);
//   tier 2 - keys matching only su/sus/le/les (key, reader-addressed or
//            third-person, full ES string).
// It repairs no copy. The live tier-1 set must equal the inventory, so a new
// match fails instead of silently growing the count (the same ratchet as
// tests/es-usted-tier1-register.test.jsx). Tier 2 is mostly third-person `su`
// and grows with ordinary copy, so tier-2 drift is reported, not fatal: an
// untriaged key or a stale triage entry prints with its count.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { TIER1_MARKERS, TIER2_MARKERS } from "../tests/i18nRegisterMarkers.js";

export const INVENTORY_PATH = join(dirname(fileURLToPath(import.meta.url)), "lib", "es-usted-census-inventory.json");

export function loadInventory() {
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
}

function hits(value, markers) {
  return value.match(new RegExp(markers.source, "gi")) ?? [];
}

export function censusEsUsted(es = catalogue.es) {
  const tier1 = [];
  const tier2 = [];
  for (const [key, raw] of Object.entries(es)) {
    if (typeof raw !== "string") continue;
    const value = raw.normalize("NFC");
    const tier1Hits = hits(value, TIER1_MARKERS);
    if (tier1Hits.length) tier1.push({ key, value, markers: tier1Hits });
    else if (TIER2_MARKERS.test(value)) tier2.push({ key, value });
  }
  return { tier1, tier2 };
}

export function attributeCensus({ tier1, tier2 }, inventory = loadInventory()) {
  const errors = [];
  const tier1Keys = inventory.tier1.keys;
  const reader = new Set(inventory.tier2.reader_addressed);
  const third = new Set(inventory.tier2.third_person);
  for (const row of tier1) {
    if (!Object.hasOwn(tier1Keys, row.key)) errors.push(`tier-1 key ${row.key} is not in the inventory`);
  }
  for (const key of Object.keys(tier1Keys)) {
    if (!tier1.some((row) => row.key === key)) errors.push(`inventory tier-1 key ${key} no longer matches; remove it`);
  }
  for (const key of reader) {
    if (third.has(key)) errors.push(`tier-2 key ${key} is in both triage classes`);
  }
  const classOf = (key) => (reader.has(key) ? "reader-addressed" : third.has(key) ? "third-person" : "untriaged");
  return {
    errors,
    tier1: tier1.map((row) => ({ ...row, ...tier1Keys[row.key] })),
    tier2: tier2.map((row) => ({ ...row, class: classOf(row.key) })),
    staleTier2: [...reader, ...third].filter((key) => !tier2.some((row) => row.key === key)),
  };
}

export function formatCensusReport({ tier1, tier2, staleTier2 = [] }, inventory = loadInventory()) {
  const lines = [
    "ES usted census over catalogue.es",
    `Tier 1 (usted/ustedes + formal-imperative union): ${tier1.length}`,
    `UNOWNED: ${tier1.filter((row) => row.owner == null).length}`,
  ];
  for (const row of tier1) lines.push(`  ${row.key}\t${row.disposition}\t${row.owner ?? "UNOWNED"}\t${row.markers.join(",")}`);
  const count = (name) => tier2.filter((row) => row.class === name).length;
  lines.push(`Tier 2 (su/sus/le/les only): ${tier2.length} (${count("reader-addressed")} reader-addressed, ${count("third-person")} third-person, ${count("untriaged")} untriaged)`);
  lines.push(`Tier 2 reader-addressed sweep record: ${inventory.tier2.follow_up_record.reader_addressed ?? "none"}`);
  for (const row of tier2) lines.push(`  ${row.key}\t${row.class}\t${row.value}`);
  if (staleTier2.length) lines.push(`Tier 2 triage entries that no longer match: ${staleTier2.join(", ")}`);
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inventory = loadInventory();
  const census = attributeCensus(censusEsUsted(), inventory);
  process.stdout.write(`${formatCensusReport(census, inventory)}\n`);
  if (census.errors.length) {
    process.stderr.write(`${census.errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
