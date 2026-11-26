// Builds the snapshot for a union catalog release that adds directory-listed
// bodies: locals, councils and state or intermediate bodies that a national
// union lists in its own published directory but that have no federal (OLMS)
// file number.
//
//   node scripts/union-catalog/build-directory-snapshot.mjs \
//     --base <base release dir> --candidates <candidates.jsonl> --candidates-sha256 <hex> \
//     --registry <registry export> --out <new release dir>
//
// What it does, and nothing else:
//   1. Checks the base release's three snapshot inputs against the sha256s its
//      manifest recorded, and the candidates file against --candidates-sha256,
//      so the inputs are fixed by hash. A mismatch refuses the run.
//   2. Copies the three base inputs byte for byte into <out>/snapshot/,
//      keeping their modification times (the exporter takes the release's
//      source build time from build/enriched.json's mtime).
//   3. Reads only the organization fields of each candidate (CANDIDATE_FIELDS;
//      never a staff, officer or contact-person field), compares it with the
//      registry export and the base catalog, holds out the ones listed in
//      HOLD_REASONS with a count per reason, and writes the rest to
//      <out>/snapshot/directory/listed-bodies.json (union-catalog-directory-bodies/1).
//
// The registry export is read-only output of public.union_orgs with
// olms_file_number, affiliation, local_number and state (a JSON array, or
// {rows: [...]}). It prints counts and hashes only, never a dataset value.
// Every path it writes sits outside every repository; nothing it writes is
// committed. catalog:export then reads <out>/snapshot as usual.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DIRECTORY_INPUT_PATH, INPUT_PATHS, MANIFEST_FILE, extractJsonMember, insideGitRepository, sha256 } from "./export-release.mjs";
import { DIRECTORY_BODIES_SCHEMA, US_STATE_CODES, directoryBodyKey, nameTokens, projectLedgerRecords } from "./privacy-filter.mjs";
import { isRealIsoDate } from "./catalog-shape.mjs";

export const BUILDER_VERSION = "build-directory-snapshot/1";
// F1 for a candidate row: the only fields ever read.
export const CANDIDATE_FIELDS = Object.freeze([
  "ledgerId", "name", "family", "label", "level", "place", "website", "parentOlmsFile", "country", "region", "sources",
]);
// Checked in this order; a candidate is counted under the first that applies.
export const HOLD_REASONS = Object.freeze([
  // The registry already holds a body with the same affiliation and local number.
  "registry_match",
  // The base catalog already holds an organization with the same name.
  "catalog_name_match",
  // No source with an http(s) URL and a YYYY-MM-DD as-of date.
  "no_dated_source",
  // The parent's file number is not a filer in the base snapshot.
  "parent_not_in_base",
  // The place is outside the United States (or names a region that is not a
  // U.S. state), and the catalog's place fields cannot say so.
  "outside_united_states",
  // A national union listed as a member of a department: it files under its
  // own federal number, so it is not loaded again without one.
  "affiliated_national_union",
  // Two listings give the same key (same parent, same name); all are held.
  "duplicate_listing",
]);
const CANADIAN_CODES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
const LOCAL_NUMBER = /\bLocal(?: Union)?(?: No\.?)?\s*#?\s*([0-9]{1,5}[A-Z]?)\b/i;

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${label} is missing or is not valid JSON`);
  }
}

function localNumberKey(value) {
  return String(value ?? "").trim().toUpperCase().replace(/^0+/, "");
}

/** The registry export as {affiliation|local number} keys (the record's comparison rule). */
export function registryKeys(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : null;
  if (!rows) throw new Error("the registry export must be a JSON array of union_orgs rows or an object with a rows array");
  const keys = new Set();
  for (const row of rows) {
    const number = localNumberKey(row?.local_number);
    if (typeof row?.affiliation === "string" && number) keys.add(`${row.affiliation}|${number}`);
  }
  return { rows: rows.length, keys };
}

/** F1: the organization fields of one candidate, and {url, asOf} of each source. */
export function projectCandidate(row) {
  const out = {};
  for (const field of CANDIDATE_FIELDS) out[field] = row?.[field] ?? null;
  out.sources = Array.isArray(row?.sources)
    ? row.sources.filter((s) => s && typeof s === "object").map((s) => ({ url: s.url ?? null, asOf: s.asOf ?? null }))
    : [];
  return out;
}

/** {state, city, outside}: a U.S. postal code from the region or the place's last ", XX", and the city before it. */
export function placeOf(candidate) {
  const place = typeof candidate.place === "string" ? candidate.place.trim() : "";
  const match = /^(?:(.*?),\s*)?([A-Z]{2})$/.exec(place);
  const region = typeof candidate.region === "string" ? candidate.region.trim() : "";
  const code = region || (match ? match[2] : "");
  const country = typeof candidate.country === "string" ? candidate.country.trim().toUpperCase() : "";
  const outside = (country !== "" && country !== "US" && country !== "UNKNOWN") || CANADIAN_CODES.has(code) || (code !== "" && !US_STATE_CODES.has(code));
  if (outside) return { outside: true, state: null, city: null };
  const city = match && match[1] && (!region || match[2] === region) ? match[1].trim() : null;
  return { outside: false, state: code || null, city: city || null };
}

export function tierOf(candidate) {
  if (/\bSTATE/i.test(String(candidate.label ?? ""))) return "state";
  return candidate.level === 1 ? "regional" : "local";
}

function hasDatedSource(candidate) {
  return candidate.sources.some((s) => typeof s.url === "string" && /^https?:\/\/\S+$/i.test(s.url.trim()) && typeof s.asOf === "string" && isRealIsoDate(s.asOf));
}

/**
 * Compares the candidates with the registry and the base catalog and returns
 * the bodies to list, sorted by catalog key, and the held-out count per reason.
 * `base` is {filerFiles: Set<file number>, names: Set<name tokens>}.
 */
export function selectDirectoryBodies(candidates, { registry, base }) {
  const held = Object.fromEntries(HOLD_REASONS.map((reason) => [reason, 0]));
  const kept = [];
  for (const raw of candidates) {
    const candidate = projectCandidate(raw);
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const number = localNumberKey(LOCAL_NUMBER.exec(name)?.[1]);
    const tokens = nameTokens(name).join(" ");
    const bare = nameTokens(name.replace(/\([^)]*\)/g, " ")).join(" ");
    const place = placeOf(candidate);
    let reason = null;
    if (number && registry.keys.has(`${candidate.family}|${number}`)) reason = "registry_match";
    else if ((tokens && base.names.has(tokens)) || (bare && base.names.has(bare))) reason = "catalog_name_match";
    else if (!hasDatedSource(candidate)) reason = "no_dated_source";
    else if (!Number.isInteger(candidate.parentOlmsFile) || !base.filerFiles.has(candidate.parentOlmsFile)) reason = "parent_not_in_base";
    else if (place.outside) reason = "outside_united_states";
    else if (/\bMEMBER$/i.test(String(candidate.label ?? "").trim())) reason = "affiliated_national_union";
    if (reason) {
      held[reason] += 1;
      continue;
    }
    kept.push({
      key: directoryBodyKey(candidate.parentOlmsFile, name),
      body: {
        id: `directory-${candidate.ledgerId}`,
        name,
        family: typeof candidate.family === "string" ? candidate.family : null,
        tier: tierOf(candidate),
        parentFileNumber: candidate.parentOlmsFile,
        city: place.city,
        state: place.state,
        country: place.state ? "US" : null,
        website: typeof candidate.website === "string" && candidate.website ? candidate.website : null,
        sources: candidate.sources.filter((s) => typeof s.url === "string" && s.url && typeof s.asOf === "string" && isRealIsoDate(s.asOf)),
      },
    });
  }
  const byKey = new Map();
  for (const entry of kept) byKey.set(entry.key, (byKey.get(entry.key) ?? 0) + 1);
  const bodies = [];
  for (const entry of kept) {
    if (byKey.get(entry.key) > 1) held.duplicate_listing += 1;
    else bodies.push(entry);
  }
  bodies.sort((a, b) => a.key.localeCompare(b.key));
  return { bodies: bodies.map((entry) => entry.body), held };
}

/** Filer file numbers and name-token forms (name and aka) of the base snapshot's research records. */
export function baseCatalogIndex(enriched, ledger) {
  const filerFiles = new Set();
  const names = new Set();
  for (const [id, record] of Object.entries(enriched)) {
    const file = ledger[id]?.file;
    if (Number.isInteger(file) && file > 0) filerFiles.add(file);
    for (const value of [record?.name, ...(Array.isArray(record?.aka) ? record.aka : [])]) {
      const tokens = nameTokens(value).join(" ");
      if (tokens) names.add(tokens);
      const bare = nameTokens(String(value ?? "").replace(/\([^)]*\)/g, " ")).join(" ");
      if (bare) names.add(bare);
    }
  }
  return { filerFiles, names };
}

function verifiedBytes(path, expected, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expected) throw new Error(`${label} does not match the sha256 it is fixed by; refusing to build`);
  return bytes;
}

export function buildDirectorySnapshot({ baseDir, candidatesPath, candidatesSha256, registryPath, outDir }) {
  if (!baseDir || !candidatesPath || !candidatesSha256 || !registryPath || !outDir) {
    throw new Error("Pass --base, --candidates, --candidates-sha256, --registry and --out");
  }
  const out = resolve(outDir);
  for (const path of [out, resolve(candidatesPath), resolve(registryPath)]) {
    if (insideGitRepository(path)) throw new Error("Release inputs and outputs live outside every repository; a path given points inside one");
  }
  const snapshotOut = join(out, "snapshot");
  if (existsSync(snapshotOut)) throw new Error(`${snapshotOut} already exists; a release directory is written once`);
  const base = resolve(baseDir);
  const manifest = readJson(join(base, MANIFEST_FILE), "the base release manifest");

  // 1. Fixed inputs.
  const inputs = {};
  for (const [name, relative] of Object.entries(INPUT_PATHS)) {
    const declared = manifest.inputs?.[relative.split("\\").join("/")]?.sha256;
    if (typeof declared !== "string") throw new Error(`the base manifest records no sha256 for ${relative}`);
    inputs[name] = { relative, path: join(base, "snapshot", relative), bytes: verifiedBytes(join(base, "snapshot", relative), declared, `base snapshot ${relative}`) };
  }
  const candidateBytes = verifiedBytes(resolve(candidatesPath), candidatesSha256, "the candidates file");
  const registryBytes = readFileSync(resolve(registryPath));
  const registry = registryKeys(JSON.parse(registryBytes.toString("utf8")));
  const candidates = candidateBytes.toString("utf8").split("\n").filter((line) => line.trim()).map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`candidates line ${i + 1} is not valid JSON`);
    }
  });

  // 3 (read side). The base catalog's filers and names.
  const enriched = JSON.parse(inputs.enriched.bytes.toString("utf8"));
  const ledger = projectLedgerRecords(JSON.parse(extractJsonMember(inputs.sourceData.bytes.toString("utf8"), ["index-data.json", "records"])));
  const selection = selectDirectoryBodies(candidates, { registry, base: baseCatalogIndex(enriched, ledger) });

  // 2. Copy the base inputs, keeping their modification times.
  for (const input of Object.values(inputs)) {
    const target = join(snapshotOut, input.relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(input.path, target);
    const stat = statSync(input.path);
    utimesSync(target, stat.atime, stat.mtime);
    if (sha256(readFileSync(target)) !== sha256(input.bytes)) throw new Error(`the copy of ${input.relative} does not match its source`);
  }

  // 3 (write side).
  const document = {
    schema: DIRECTORY_BODIES_SCHEMA,
    builder: BUILDER_VERSION,
    base: {
      label: manifest.label ?? null,
      artifactSha256: manifest.artifact?.sha256 ?? null,
      inputs: Object.fromEntries(Object.values(inputs).map((input) => [input.relative.split("\\").join("/"), sha256(input.bytes)])),
    },
    candidates: { sha256: candidatesSha256, rows: candidates.length },
    registry: { sha256: sha256(registryBytes), rows: registry.rows },
    held: selection.held,
    bodies: selection.bodies,
  };
  const target = join(snapshotOut, DIRECTORY_INPUT_PATH);
  mkdirSync(dirname(target), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(document, null, 1)}\n`);
  writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
  return {
    snapshot: snapshotOut,
    sha256: sha256(bytes),
    candidates: candidates.length,
    listed: selection.bodies.length,
    held: selection.held,
  };
}

function parseArgs(argv) {
  const flags = { "--base": "baseDir", "--candidates": "candidatesPath", "--candidates-sha256": "candidatesSha256", "--registry": "registryPath", "--out": "outDir" };
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const name = flags[argv[i]];
    if (!name) throw new Error(`Unknown argument ${argv[i]}. Usage: build-directory-snapshot.mjs --base <dir> --candidates <jsonl> --candidates-sha256 <hex> --registry <json> --out <dir>`);
    args[name] = argv[i + 1];
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = buildDirectorySnapshot(parseArgs(process.argv));
    console.log(`snapshot             ${result.snapshot}`);
    console.log(`listed-bodies sha256 ${result.sha256}`);
    console.log(`candidates           ${result.candidates}`);
    console.log(`listed               ${result.listed}`);
    for (const [reason, count] of Object.entries(result.held)) console.log(`held ${reason.padEnd(26)} ${count}`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
