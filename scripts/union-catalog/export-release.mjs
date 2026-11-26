// Exports one privacy-filtered release of the public-record union catalog
// (spec docs/superpowers/specs/2026-09-24-union-catalog-prefilled-organizations-design.md §2.5).
//
//   CATALOG_EXCLUSIONS_FILE=/path/outside/every/repo/catalog-exclusions.json \
//     node scripts/union-catalog/export-release.mjs --source <snapshot dir> --out <release dir> [--label YYYYMMDD-NN]
//
// RUNBOOK (operator, one release)
//   1. Snapshot. After the research build finishes, copy the three inputs into
//      the release directory with `cp -p` (or `cp -a` for a tree), keeping
//      their layout and their modification times:
//        <release dir>/snapshot/build/enriched.json
//        <release dir>/snapshot/build/source-data.json
//        <release dir>/snapshot/documents/index.json
//      The timestamps matter: sourceBuiltAt and the default label are taken
//      from the mtime of the snapshot copy of build/enriched.json (the build
//      output carries no build time of its own). A plain `cp` stamps the copy
//      time instead, so the release would record when it was snapshotted, not
//      when the research build finished.
//      Release directories live in a local artifacts directory outside every
//      repository. Nothing in them is ever committed.
//   2. Export: this script. It hashes each input before and after parsing and
//      refuses the run if a hash, size or mtime changed, so a research session
//      still writing cannot hand it half a file.
//   3. Plan: `npm run catalog:plan -- --release <release dir>` (no database).
//   4. Load, verify and activate: scripts/load-union-catalog.mjs (§2.6).
//
// What it reads (F1): enriched.json in full; from source-data.json only the
// member index-data.json -> records, cut out of the file at the byte level so
// no other member (contacts.json, profiles.json, the family officer lists) is
// ever parsed; documents/index.json limited to its metadata fields; and, when
// the snapshot has one, directory/listed-bodies.json limited to the
// organization fields of each directory-listed body (see
// build-directory-snapshot.mjs and the runbook). Any parsed input carrying a
// key named `reference` refuses the run.
//
// What it writes, into --out: catalog-release.json.gz (union-catalog-release/1),
// manifest.json (sha256s, counts, a drop report with counts only, the filter
// version, the source build time, and the exclusion file's sha256 and match
// count) and catalog-id-map.json (ledger id -> catalog key). It never prints a
// value from the dataset.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { RELEASE_LABEL_PATTERN, RELEASE_SCHEMA, releaseRecordViolations } from "./catalog-shape.mjs";
import {
  FILTER_VERSION,
  assertNoReferenceKey,
  buildCatalogRelease,
  parseExclusionList,
  projectDirectoryBodies,
  projectDocumentIndex,
  projectLedgerRecords,
} from "./privacy-filter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..", "..");
export const MANIFEST_SCHEMA = "union-catalog-manifest/1";
export const ID_MAP_SCHEMA = "union-catalog-id-map/1";
export const ARTIFACT_FILE = "catalog-release.json.gz";
export const MANIFEST_FILE = "manifest.json";
export const ID_MAP_FILE = "catalog-id-map.json";
export const INPUT_PATHS = Object.freeze({
  enriched: join("build", "enriched.json"),
  sourceData: join("build", "source-data.json"),
  documents: join("documents", "index.json"),
});
// Optional fourth input: directory-listed bodies with no federal file number,
// written by build-directory-snapshot.mjs beside a copied base snapshot.
export const DIRECTORY_INPUT_PATH = join("directory", "listed-bodies.json");

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasGitAncestor(start) {
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * True when `path` sits inside a git working tree (a .git entry in it or any
 * parent). Both the lexical path and the real path of its nearest existing
 * ancestor are walked, so a symlinked file, or a path under a symlinked
 * directory, that leads into a working tree is caught as well. `path` need not
 * exist yet (an --out directory is created later).
 */
export function insideGitRepository(path) {
  const lexical = resolve(path);
  return hasGitAncestor(lexical) || hasGitAncestor(realpathSync(nearestExisting(lexical)));
}

/**
 * Refuses an output file name that already exists in the release directory.
 * A symbolic link, live or dangling, would let the write follow it (possibly
 * into a working tree the --out check never saw), so it is refused by name;
 * a regular entry that resolves into a git repository is refused; any other
 * entry means the directory already holds a release. Messages name the path
 * only.
 */
export function refuseExistingOutput(path) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return;
  if (entry.isSymbolicLink()) {
    throw new Error(`${path} is a symbolic link; release files are never written through a link`);
  }
  if (insideGitRepository(realpathSync(path))) {
    throw new Error(`${path} resolves inside a git repository. Release artifacts live outside every repository and are never committed.`);
  }
  throw new Error(`${dirname(path)} already holds a release; a release directory is written once`);
}

function nearestExisting(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

// V8 ends a JSON.parse SyntaxError with "in JSON at position N (line L column C)"
// when it knows the offset. Its "Unexpected token" form quotes about ten
// characters of the input on each side of the fault instead, and never matches.
const JSON_POSITION = /in JSON at position ([0-9]+)(?: \(line [0-9]+ column [0-9]+\))?$/;

/**
 * What a parse failure may say about itself. A SyntaxError's message can quote
 * input text (a person's name or email next to a stray NaN), so only the
 * numeric position survives. Plain Errors are this pipeline's own structural
 * faults (the F1 reference-key refusal, ledger and document-index shape
 * faults) and name keys only. Any other error type (a TypeError, say, can
 * quote a value) is reduced to its name. The original error is never attached
 * as `cause`, so logging the thrown object cannot print the input either.
 */
function parseFailureDetail(error) {
  if (error instanceof SyntaxError) {
    const position = JSON_POSITION.exec(error.message);
    return position ? `invalid JSON at position ${Number(position[1])}` : "invalid JSON";
  }
  if (error?.constructor === Error) return error.message;
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * Reads a file, parses it, then reads it again. A changed hash, size or mtime
 * means another process was writing it; the run refuses rather than export a
 * torn snapshot.
 */
export function readStableInput(path, label, parse) {
  if (!existsSync(path)) throw new Error(`Input ${label} is missing from the snapshot`);
  const before = statSync(path);
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  let value;
  try {
    value = parse(bytes.toString("utf8"));
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- A JSON.parse error quotes input text; see parseFailureDetail.
    throw new Error(`Structural fault: ${label} does not parse (${parseFailureDetail(error)})`);
  }
  const after = statSync(path);
  const again = sha256(readFileSync(path));
  if (again !== digest || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`${label} changed while it was being read; refusing to run. Snapshot the build first.`);
  }
  return { value, sha256: digest, bytes: bytes.length, mtime: before.mtime };
}

// ---------------------------------------------------------------- byte-level member extraction

function skipWhitespace(source, i) {
  let j = i;
  while (j < source.length) {
    const c = source.charCodeAt(j);
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    j += 1;
  }
  return j;
}

function endOfString(source, i) {
  let j = i + 1;
  while (j < source.length) {
    const c = source.charCodeAt(j);
    if (c === 0x5c) j += 2;
    else if (c === 0x22) return j + 1;
    else j += 1;
  }
  throw new Error("unterminated string");
}

function endOfValue(source, i) {
  const start = skipWhitespace(source, i);
  const c = source[start];
  if (c === '"') return endOfString(source, start);
  if (c === "{" || c === "[") {
    let depth = 0;
    let j = start;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '"') {
        j = endOfString(source, j);
        continue;
      }
      if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    throw new Error("unterminated container");
  }
  let j = start;
  while (j < source.length && !",}] \t\n\r".includes(source[j])) j += 1;
  return j;
}

/**
 * Returns the raw JSON text of one member of a top-level object without
 * parsing any sibling member. `path` walks nested objects, for example
 * ["index-data.json", "records"]. This is how the exporter reads the ledger
 * out of source-data.json while never parsing contacts.json (F1, F10).
 */
export function extractJsonMember(source, path) {
  let start = 0;
  let end = source.length;
  for (const wanted of path) {
    let i = skipWhitespace(source, start);
    if (source[i] !== "{") throw new Error(`member ${wanted} is not inside an object`);
    i += 1;
    let found = null;
    for (;;) {
      i = skipWhitespace(source, i);
      if (source[i] === "}") break;
      if (source[i] !== '"') throw new Error("expected an object key");
      const keyEnd = endOfString(source, i);
      const key = JSON.parse(source.slice(i, keyEnd));
      i = skipWhitespace(source, keyEnd);
      if (source[i] !== ":") throw new Error("expected ':' after an object key");
      const valueStart = skipWhitespace(source, i + 1);
      const valueEnd = endOfValue(source, valueStart);
      if (key === wanted) {
        if (found) throw new Error(`member ${wanted} appears twice`);
        found = [valueStart, valueEnd];
      }
      i = skipWhitespace(source, valueEnd);
      if (source[i] === ",") i += 1;
      else if (source[i] === "}") break;
      else throw new Error("expected ',' or '}' in an object");
      if (i > end) break;
    }
    if (!found) throw new Error(`member ${path.join(" -> ")} is missing`);
    [start, end] = found;
  }
  return source.slice(start, end);
}

// ---------------------------------------------------------------- inputs

/** F9: the exclusion list is required, and must live outside every repository. */
export function loadExclusionList(env = process.env) {
  const configured = env.CATALOG_EXCLUSIONS_FILE;
  if (!configured) {
    throw new Error("F9: CATALOG_EXCLUSIONS_FILE is not set. The export refuses to run without the owner's exclusion list.");
  }
  const path = resolve(configured);
  if (insideGitRepository(path)) {
    throw new Error("F9: CATALOG_EXCLUSIONS_FILE points inside a git repository. The exclusion list must live outside every repository.");
  }
  if (!existsSync(path)) {
    throw new Error("F9: CATALOG_EXCLUSIONS_FILE does not exist. The export refuses to run without the owner's exclusion list.");
  }
  return parseExclusionList(readFileSync(path, "utf8"));
}

export function readConfig(name) {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, "config", name), "utf8"));
}

/**
 * SAMPLE fixture identities (F11): names, ids and OLMS file numbers of SAMPLE
 * partner rows. Union Ground seeds no SAMPLE project and carries no partner
 * fixture catalog, so there is nothing to refuse beyond the privacy filter's
 * own test-key guard; the shape stays so the F11 guard keeps its input.
 */
export function sampleFixtureIdentities() {
  return { names: [], fixtures: { ids: [], fileNumbers: [] } };
}

/** Reads the three F1 inputs from a snapshot directory. */
export function readSnapshot(sourceDir) {
  const enriched = readStableInput(join(sourceDir, INPUT_PATHS.enriched), "build/enriched.json", (raw) => {
    const value = JSON.parse(raw);
    assertNoReferenceKey(value, "enriched.json");
    return value;
  });
  const sourceData = readStableInput(join(sourceDir, INPUT_PATHS.sourceData), "build/source-data.json", (raw) => {
    const records = JSON.parse(extractJsonMember(raw, ["index-data.json", "records"]));
    assertNoReferenceKey(records, "source-data.json index-data.json.records");
    return projectLedgerRecords(records);
  });
  const documents = readStableInput(join(sourceDir, INPUT_PATHS.documents), "documents/index.json", (raw) => {
    const value = JSON.parse(raw);
    assertNoReferenceKey(value, "documents/index.json");
    return { generated: typeof value.generated === "string" ? value.generated : null, documents: projectDocumentIndex(value) };
  });
  const directoryPath = join(sourceDir, DIRECTORY_INPUT_PATH);
  const directory = existsSync(directoryPath)
    ? readStableInput(directoryPath, "directory/listed-bodies.json", (raw) => {
      const value = JSON.parse(raw);
      assertNoReferenceKey(value, "directory/listed-bodies.json");
      return projectDirectoryBodies(value);
    })
    : null;
  return { enriched, sourceData, documents, directory };
}

export function defaultLabel(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}${parts.month}${parts.day}-01`;
}

// ---------------------------------------------------------------- export

export function exportRelease({ sourceDir, outDir, label, env = process.env, now = new Date(), log = () => {} }) {
  if (!sourceDir || !outDir) throw new Error("Pass --source <snapshot dir> and --out <release dir>");
  const exclusions = loadExclusionList(env);
  const out = resolve(outDir);
  if (insideGitRepository(out)) {
    throw new Error("--out points inside a git repository. Release artifacts live outside every repository and are never committed.");
  }
  for (const file of [ARTIFACT_FILE, ID_MAP_FILE, MANIFEST_FILE]) refuseExistingOutput(join(out, file));

  const snapshot = readSnapshot(resolve(sourceDir));
  const releaseLabel = label ?? defaultLabel(snapshot.enriched.mtime);
  if (!RELEASE_LABEL_PATTERN.test(releaseLabel)) throw new Error(`Release label ${releaseLabel} must match YYYYMMDD-NN`);
  const { names, fixtures } = sampleFixtureIdentities();

  const built = buildCatalogRelease({
    enriched: snapshot.enriched.value,
    ledger: snapshot.sourceData.value,
    documents: snapshot.documents.value.documents,
    directoryBodies: snapshot.directory?.value.bodies ?? [],
    directoryHeld: snapshot.directory?.value.held ?? {},
    exclusions,
    familyDomains: readConfig("catalog-family-domains.json"),
    blockedDomains: readConfig("catalog-blocked-email-domains.json"),
    fixtureNames: names,
    fixtures,
  });

  const sourceBuiltAt = snapshot.enriched.mtime.toISOString();
  const payload = {
    schema: RELEASE_SCHEMA,
    filterVersion: FILTER_VERSION,
    label: releaseLabel,
    sourceBuiltAt,
    sourceSha256: snapshot.enriched.sha256,
  };
  for (const [key, value] of Object.entries(built.release)) {
    if (key !== "schema" && key !== "filterVersion") payload[key] = value;
  }
  const json = Buffer.from(JSON.stringify(payload));
  const gz = gzipSync(json, { level: 9 });
  const idMap = Buffer.from(`${JSON.stringify({ schema: ID_MAP_SCHEMA, label: releaseLabel, organizations: built.idMap }, null, 2)}\n`);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    releaseSchema: RELEASE_SCHEMA,
    label: releaseLabel,
    filterVersion: FILTER_VERSION,
    createdAt: now.toISOString(),
    sourceBuiltAt,
    sourceSha256: snapshot.enriched.sha256,
    documentsIndexGenerated: snapshot.documents.value.generated,
    inputs: {
      "build/enriched.json": { sha256: snapshot.enriched.sha256, bytes: snapshot.enriched.bytes },
      "build/source-data.json": { sha256: snapshot.sourceData.sha256, bytes: snapshot.sourceData.bytes, read: "index-data.json.records" },
      "documents/index.json": { sha256: snapshot.documents.sha256, bytes: snapshot.documents.bytes },
      ...(snapshot.directory
        ? { "directory/listed-bodies.json": { sha256: snapshot.directory.sha256, bytes: snapshot.directory.bytes, bodies: snapshot.directory.value.bodies.length } }
        : {}),
    },
    artifact: { file: ARTIFACT_FILE, sha256: sha256(gz), bytes: gz.length, jsonSha256: sha256(json) },
    idMap: { file: ID_MAP_FILE, sha256: sha256(idMap) },
    counts: built.counts,
    dropReport: built.dropReport,
    exclusions: { fileSha256: exclusions.fileSha256, matchCount: built.exclusionMatches },
  };
  // The catalog_releases row the load will insert from this manifest must
  // pass its CHECKs; refuse now, before anything is written, rather than at load.
  const recordProblems = releaseRecordViolations(manifest);
  if (recordProblems.length > 0) {
    throw new Error(`The release manifest would violate a catalog_releases constraint:\n  - ${recordProblems.join("\n  - ")}`);
  }

  // "wx" creates each file exclusively: a name that appeared meanwhile, a
  // symbolic link included, fails the write instead of being followed.
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, ARTIFACT_FILE), gz, { mode: 0o600, flag: "wx" });
  writeFileSync(join(out, ID_MAP_FILE), idMap, { mode: 0o600, flag: "wx" });
  writeFileSync(join(out, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  log(`release ${releaseLabel} written to ${out}${sep}`);
  return manifest;
}

function parseArgs(argv) {
  const args = { sourceDir: null, outDir: null, label: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source") args.sourceDir = value;
    else if (flag === "--out") args.outDir = value;
    else if (flag === "--label") args.label = value;
    else throw new Error(`Unknown argument ${flag}. Usage: export-release.mjs --source <snapshot dir> --out <release dir> [--label YYYYMMDD-NN]`);
    i += 1;
  }
  return args;
}

export function summaryLines(manifest) {
  const lines = [
    `release          ${manifest.label} (${manifest.filterVersion})`,
    `source built at  ${manifest.sourceBuiltAt}`,
    `source sha256    ${manifest.sourceSha256}`,
    `artifact sha256  ${manifest.artifact.sha256} (${manifest.artifact.bytes} bytes)`,
    `exclusions       file ${manifest.exclusions.fileSha256.slice(0, 12)}..., ${manifest.exclusions.matchCount} match(es)`,
    "counts:",
  ];
  for (const [key, value] of Object.entries(manifest.counts)) {
    lines.push(`  ${key.padEnd(28)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }
  lines.push("drops (counts only):");
  for (const [key, value] of Object.entries(manifest.dropReport)) lines.push(`  ${key.padEnd(58)} ${value}`);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv);
    const manifest = exportRelease({ ...args, log: (line) => console.log(line) });
    for (const line of summaryLines(manifest)) console.log(line);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
