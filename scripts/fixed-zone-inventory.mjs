#!/usr/bin/env node
// Reports and refreshes config/fixed-zone-inventory.json, the list of what
// still works on one fixed time zone
// (REQ-UG-TIME-ZONES-PER-GROUP-20261122; docs/contracts/time-zones-per-group.md).
//
//   node scripts/fixed-zone-inventory.mjs                    report what differs from the saved list
//   node scripts/fixed-zone-inventory.mjs --write-source     lower or remove source entries the scan no longer finds
//   node scripts/fixed-zone-inventory.mjs --write-database   replace the database list from a migrated database
//
// The database half needs SUPABASE_DB_URL to name a fully migrated disposable
// stack (the same loopback ports the live database tests admit). The source
// half only ever shrinks: this command refuses to add a file or raise a count.
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectFixedZoneDatabase, databaseInventoryDifferences } from "./lib/fixed-zone-db.mjs";
import { INVENTORY_PATH, fixedZoneFindings, readFixedZoneInventory, scanFixedZones } from "./lib/fixed-zone-scan.mjs";

const NOTE = "What still works on one fixed time zone (REQ-UG-TIME-ZONES-PER-GROUP-20261122; docs/contracts/time-zones-per-group.md). source: files with the number of lines that name New York's zone or Eastern time (fixed), read the device's zone (device) or take the UTC day of an instant as a date (utcDay); checked by scripts/lib/fixed-zone-scan.mjs on every conventions run and shrink only: lower or remove an entry when a file takes its zone from the item's group (src/lib/zoneTime.js), never raise one or add a file. database: catalog objects read by scripts/fixed-zone-inventory.mjs --write-database from a migrated database (kinds in scripts/lib/fixed-zone-db.mjs); a snapshot each part of the record refreshes, not a required check.";

function sortedSource(counts) {
  return Object.fromEntries(Object.keys(counts).sort().map((path) => [path, Object.fromEntries(Object.keys(counts[path]).sort().map((kind) => [kind, counts[path][kind]]))]));
}

export function nextSourceInventory(known, counts) {
  if (known === undefined) return { source: sortedSource(counts), refused: [] };
  const refused = [];
  const next = {};
  for (const [path, found] of Object.entries(counts)) {
    for (const [kind, count] of Object.entries(found)) {
      const allowed = known[path]?.[kind] ?? 0;
      if (count > allowed) refused.push(`${path}: ${kind} would rise from ${allowed} to ${count}`);
      else (next[path] ??= {})[kind] = count;
    }
  }
  return { source: sortedSource(next), refused };
}

async function connect() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set; start a disposable migrated stack first");
  const { assertDisposableProofUrl } = await import("./run-required-db-proofs.mjs");
  assertDisposableProofUrl(url);
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, application_name: "fixed-zone-inventory" });
  await client.connect();
  await client.query("set default_transaction_read_only = on");
  return client;
}

async function readDatabase() {
  const client = await connect();
  try {
    const newest = await client.query("select max(version) as version, count(*)::int as applied from supabase_migrations.schema_migrations");
    return { readFrom: { newestMigration: newest.rows[0].version, migrationsApplied: newest.rows[0].applied }, ...(await collectFixedZoneDatabase(client)) };
  } finally {
    await client.end();
  }
}

function save(root, inventory) {
  writeFileSync(join(root, INVENTORY_PATH), `${JSON.stringify({ note: NOTE, source: inventory.source ?? {}, database: inventory.database ?? {} }, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2), root = resolve(dirname(fileURLToPath(import.meta.url)), "..")) {
  const inventory = readFixedZoneInventory(root);
  const counts = scanFixedZones(root);
  if (argv.includes("--write-source")) {
    const { source, refused } = nextSourceInventory(inventory.source, counts);
    if (refused.length) {
      for (const line of refused) console.error(`REFUSED ${line}`);
      console.error("The source list only shrinks. Take the zone from the item's group, or mark the line with its reason.");
      return 1;
    }
    save(root, { ...inventory, source });
    console.log(`${INVENTORY_PATH}: source now lists ${Object.keys(source).length} file(s)`);
    return 0;
  }
  if (argv.includes("--write-database")) {
    const database = await readDatabase();
    save(root, { ...inventory, database });
    const total = Object.values(database).filter(Array.isArray).reduce((sum, rows) => sum + rows.length, 0);
    console.log(`${INVENTORY_PATH}: database now lists ${total} object(s), read at migration ${database.readFrom.newestMigration}`);
    return 0;
  }
  const failures = fixedZoneFindings({ counts, known: inventory.source ?? {} });
  for (const line of failures) console.log(`SOURCE ${line}`);
  let drift = [];
  if (process.env.SUPABASE_DB_URL) {
    const { readFrom, ...live } = await readDatabase();
    const { readFrom: savedFrom, ...saved } = inventory.database ?? {};
    drift = databaseInventoryDifferences(saved, live);
    for (const line of drift) console.log(`DATABASE ${line}`);
    console.log(`database read at migration ${readFrom.newestMigration}; saved list read at ${savedFrom?.newestMigration ?? "nothing"}`);
  } else {
    console.log("database half not read: SUPABASE_DB_URL is not set");
  }
  console.log(`${failures.length} source difference(s), ${drift.length} database difference(s)`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
