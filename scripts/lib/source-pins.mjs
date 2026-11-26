import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const pinHash = (value) => createHash("sha256").update(value).digest("hex");
export const pinName = (key) => `${pinHash(key)}.json`;

// One independently reviewed identity per file. No aggregate digest or mutable
// index is written when a source changes. GitHub needs no custom merge driver.
export function readPins(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error(`${directory}: expected a regular pin directory`);
  const result = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (!/^[a-f0-9]{64}\.json$/.test(name) || !lstatSync(path).isFile()) throw new Error(`${path}: invalid pin file`);
    const row = JSON.parse(readFileSync(path, "utf8"));
    if (typeof row.key !== "string" || pinName(row.key) !== name || !Object.hasOwn(row, "value")
      || Object.keys(row).sort().join(",") !== "key,value" || Object.hasOwn(result, row.key)) throw new Error(`${path}: invalid pin identity`);
    Object.defineProperty(result, row.key, { value: row.value, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

export function writePins(directory, values) {
  mkdirSync(directory, { recursive: true });
  // Read first: a malformed or symlinked store must never be silently repaired.
  const previous = readPins(directory);
  for (const key of Object.keys(previous)) if (!Object.hasOwn(values, key)) unlinkSync(join(directory, pinName(key)));
  for (const [key, value] of Object.entries(values)) {
    const path = join(directory, pinName(key));
    const text = `${JSON.stringify({ key, value }, null, 2)}\n`;
    if (!Object.hasOwn(previous, key) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
  }
}

export function assertPins(actual, retained, label) {
  const canonical = (value) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (canonical(actual) !== canonical(retained)) throw new Error(`${label}: stale or incorrect source pins; review before updating`);
}
