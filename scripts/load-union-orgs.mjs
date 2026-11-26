// Loads the USUnions Union Atlas directory into public.union_orgs.
//
// The schema lives in a migration (20260726164045_union_orgs_registry); the
// DATA lives here, deliberately. A 20,699-row INSERT migration would be a
// ~25 MB versioned file replayed on every branch reset, and a migration
// cannot express a refresh — the Atlas is rebuilt upstream and this table
// has to be able to follow it.
//
//   node scripts/load-union-orgs.mjs plan   --atlas <dir>   # no database needed
//   node scripts/load-union-orgs.mjs load   --atlas <dir>
//   node scripts/load-union-orgs.mjs verify --atlas <dir>
//
// `plan` transforms every row and reports what WOULD be written, including any
// row that would violate a table constraint. It touches no database, so it is
// the one mode that runs anywhere.
//
// `load` and `verify` need SUPABASE_DB_URL and go through the same
// assertExactTarget guard as verify:db — a loader that can silently point at
// the wrong project is worse than no loader.
//
// The Atlas checkout is NOT vendored into this repo. --atlas (or
// UNION_ATLAS_DIR) points at a USUnions-Union-Atlas working copy; the loader
// verifies its payload against its own manifest before reading a single row,
// so a truncated or CRLF-mangled .gz fails closed rather than loading garbage.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { assertExactTarget, postgresSslForTarget, postgresConnectionStringForTarget } from "./lib/assert-exact-target.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(HERE, "db-contract.json"), "utf8"));

const BATCH_SIZE = 500;

// Column order is shared by the INSERT, the value builder and the DO UPDATE
// list. Keeping it in one place is what stops a silent column/value skew.
export const COLUMNS = [
  "id",
  "olms_file_number",
  "name",
  "affiliation",
  "designation",
  "local_number",
  "level",
  "parent_olms_file_number",
  "parent_affiliation",
  "parent_name",
  "sector_public_private",
  "sector_tags",
  "city",
  "state",
  "zip",
  "latitude",
  "longitude",
  "geocode_precision",
  "geocode_match_type",
  "website",
  "members_latest",
  "members_latest_year",
  "membership_history",
  "finances",
  "public_record_coverage",
  "sources",
  "enrichment_status",
  "source_updated_at",
  "atlas_manifest_sha",
];

// jsonb columns must be stringified for the driver; text[] must not be.
const JSON_COLUMNS = new Set(["membership_history", "finances", "public_record_coverage", "sources"]);

/**
 * Flattens one Atlas directory record into a union_orgs row.
 *
 * The nesting is the whole reason this function exists: `parent`, `membership`
 * and `sector` are objects in the source and columns in the table, and 194
 * rows have no parent at all while 1,145 have no latest membership reading.
 * Optional chaining collapses both cases to null rather than throwing.
 */
export function transformRow(row, manifestSha) {
  const latest = row.membership?.latest ?? null;
  return {
    id: row.id,
    olms_file_number: row.olmsFileNumber,
    name: row.name,
    affiliation: row.affiliation ?? null,
    designation: row.designation ?? null,
    local_number: row.localNumber ?? null,
    level: row.level,
    parent_olms_file_number: row.parent?.olmsFileNumber ?? null,
    parent_affiliation: row.parent?.affiliation ?? null,
    parent_name: row.parent?.name ?? null,
    sector_public_private: row.sector?.publicPrivate ?? null,
    sector_tags: row.sector?.tags ?? [],
    city: row.city ?? null,
    state: row.state ?? null,
    zip: row.zip ?? null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    geocode_precision: row.geocodePrecision ?? null,
    geocode_match_type: row.geocodeMatchType ?? null,
    website: row.website ?? null,
    members_latest: latest?.count ?? null,
    members_latest_year: latest?.year ?? null,
    membership_history: row.membership?.history ?? [],
    finances: row.finances ?? null,
    public_record_coverage: row.publicRecordCoverage ?? null,
    sources: row.sources ?? [],
    enrichment_status: row.enrichmentStatus,
    source_updated_at: row.updatedAt ?? null,
    atlas_manifest_sha: manifestSha,
  };
}

const LEVELS = new Set(["local", "intermediate", "unknown", "national"]);
const PRECISIONS = new Set(["address", "zcta"]);
const MATCH_TYPES = new Set(["Exact", "Non_Exact"]);
const SECTORS = new Set(["private", "public", "mixed"]);
const STATUSES = new Set(["enriched", "no_web_presence"]);

/**
 * Every CHECK and NOT NULL the table declares, evaluated in JS.
 *
 * This is not belt-and-braces: without it a constraint violation surfaces as a
 * failed batch of 500 rows with no indication of which record caused it. Here
 * the offending id is named before anything is written.
 */
export function violations(row) {
  const out = [];
  const isNull = (v) => v === null || v === undefined;
  if (isNull(row.id)) out.push("id is null");
  if (isNull(row.olms_file_number)) out.push("olms_file_number is null");
  if (isNull(row.name)) out.push("name is null");
  if (!LEVELS.has(row.level)) out.push(`level ${JSON.stringify(row.level)} is not one of ${[...LEVELS].join("/")}`);
  if (!STATUSES.has(row.enrichment_status)) out.push(`enrichment_status ${JSON.stringify(row.enrichment_status)} is unknown`);
  if (!isNull(row.geocode_precision) && !PRECISIONS.has(row.geocode_precision)) {
    out.push(`geocode_precision ${JSON.stringify(row.geocode_precision)} is unknown`);
  }
  if (!isNull(row.geocode_match_type) && !MATCH_TYPES.has(row.geocode_match_type)) {
    out.push(`geocode_match_type ${JSON.stringify(row.geocode_match_type)} is unknown`);
  }
  if (!isNull(row.sector_public_private) && !SECTORS.has(row.sector_public_private)) {
    out.push(`sector_public_private ${JSON.stringify(row.sector_public_private)} is unknown`);
  }
  if (isNull(row.latitude) !== isNull(row.longitude)) out.push("latitude/longitude are not paired");
  if (isNull(row.members_latest) !== isNull(row.members_latest_year)) out.push("members_latest/year are not paired");
  return out;
}

/**
 * Reads and integrity-checks an Atlas checkout.
 *
 * The SHA-256 gate is the important part. The Atlas's own worker verifies each
 * package digest before inflating it, and this loader has to be at least as
 * strict: `.gitattributes` in that repo carries `* text=auto eol=lf` with no
 * `*.gz` entry, so a checkout on the wrong platform can corrupt the payload by
 * exactly one byte per line ending.
 */
export function readAtlas(atlasDir) {
  const manifestPath = join(atlasDir, "data", "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the Atlas manifest at ${manifestPath}: ${error.message}`, { cause: error });
  }

  const dataPath = join(atlasDir, "data", manifest.dataFile);
  const gz = readFileSync(dataPath);
  const actual = createHash("sha256").update(gz).digest("hex");
  if (actual !== manifest.sha256) {
    throw new Error(
      `${manifest.dataFile} does not match its manifest.\n  declared ${manifest.sha256}\n  actual   ${actual}\n`
      + "Refusing to load. A mismatch usually means the .gz was line-ending mangled on checkout.",
    );
  }

  const payload = JSON.parse(gunzipSync(gz));
  const directory = payload.directory;
  if (!Array.isArray(directory)) throw new Error("Atlas payload has no .directory array");
  if (directory.length !== manifest.counts.unions) {
    throw new Error(`Manifest declares ${manifest.counts.unions} unions but .directory holds ${directory.length}`);
  }
  const ids = new Set(directory.map((r) => r.id));
  if (ids.size !== directory.length) {
    throw new Error(`.directory holds ${directory.length} records but only ${ids.size} distinct ids`);
  }

  const fileNumbers = new Map();
  for (const [index, row] of directory.entries()) {
    const fileNumber = String(row.olmsFileNumber ?? "").trim();
    if (!/^[+-]?\d+$/.test(fileNumber)) continue;
    // PostgreSQL accepts integer text such as +001 as the same identity as 1.
    const identity = BigInt(fileNumber).toString();
    const previous = fileNumbers.get(identity);
    if (previous) {
      throw new Error(`Duplicate olms_file_number ${identity}: .directory[${previous.index}] (${JSON.stringify(previous.id)}) and .directory[${index}] (${JSON.stringify(row.id)})`);
    }
    fileNumbers.set(identity, { index, id: row.id });
  }

  return { manifest, directory };
}

function upsertSql() {
  const cols = COLUMNS.join(", ");
  // first_loaded_at is deliberately absent from the update list: an unchanged
  // re-run must leave it alone, which is what makes it an idempotency signal.
  const updates = COLUMNS.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`).join(", ");
  return (rowCount) => {
    const tuples = [];
    for (let r = 0; r < rowCount; r += 1) {
      const params = COLUMNS.map((_, c) => `$${r * COLUMNS.length + c + 1}`);
      tuples.push(`(${params.join(", ")})`);
    }
    return `insert into public.union_orgs (${cols}) values ${tuples.join(", ")}\n`
      + `on conflict (id) do update set ${updates}`;
  };
}

function flatten(rows) {
  const values = [];
  for (const row of rows) {
    for (const col of COLUMNS) {
      const v = row[col];
      values.push(JSON_COLUMNS.has(col) && v !== null && v !== undefined ? JSON.stringify(v) : v);
    }
  }
  return values;
}

function parseArgs(argv) {
  const mode = argv[2];
  if (!["plan", "load", "verify"].includes(mode)) {
    throw new Error(`Usage: node scripts/load-union-orgs.mjs <plan|load|verify> --atlas <dir>   (got ${mode ?? "nothing"})`);
  }
  const flag = argv.indexOf("--atlas");
  const atlasDir = flag !== -1 ? argv[flag + 1] : process.env.UNION_ATLAS_DIR;
  if (!atlasDir) throw new Error("Pass --atlas <dir> or set UNION_ATLAS_DIR to a USUnions-Union-Atlas checkout");
  return { mode, atlasDir };
}

async function connect() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) throw new Error("SUPABASE_DB_URL is required for load/verify (plan needs no database)");
  assertExactTarget(contract.target, connectionString);
  const client = new pg.Client({
    connectionString: postgresConnectionStringForTarget(connectionString),
    ssl: postgresSslForTarget(connectionString),
    application_name: "load-union-orgs",
  });
  await client.connect();
  return client;
}

export function summarise(rows) {
  // SQL's count(distinct x) ignores NULLs; a JS Set counts null as a value. The
  // two disagreed, so an Atlas build carrying a single null state or affiliation
  // would have failed verify on a perfectly correct load. Filtering here is what
  // makes the two sides comparable.
  const distinct = (f) => new Set(rows.map(f).filter((v) => v !== null && v !== undefined)).size;
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    rows: rows.length,
    states: distinct((r) => r.state),
    affiliations: distinct((r) => r.affiliation),
    massachusetts: rows.filter((r) => r.state === "MA").length,
    geocoded: rows.filter((r) => r.latitude !== null).length,
    withMembership: rows.filter((r) => r.members_latest !== null).length,
    // The nested payload. Everything above is a scalar column, and scalars
    // alone cannot distinguish a complete load from one that wrote every row
    // with its jsonb dropped — see the note on `verify` below.
    withHistory: rows.filter((r) => len(r.membership_history) > 0).length,
    historyPoints: rows.reduce((total, r) => total + len(r.membership_history), 0),
    withFinances: rows.filter((r) => r.finances !== null).length,
    withCoverage: rows.filter((r) => r.public_record_coverage !== null).length,
    withSources: rows.filter((r) => len(r.sources) > 0).length,
    sourceRefs: rows.reduce((total, r) => total + len(r.sources), 0),
  };
}

async function main() {
  const { mode, atlasDir } = parseArgs(process.argv);
  const { manifest, directory } = readAtlas(atlasDir);
  const rows = directory.map((r) => transformRow(r, manifest.sha256));

  const bad = [];
  for (const row of rows) {
    const problems = violations(row);
    if (problems.length > 0) bad.push(`${row.id}: ${problems.join("; ")}`);
  }
  if (bad.length > 0) {
    console.error(`FAIL: ${bad.length} row(s) would violate a table constraint:\n`);
    for (const b of bad.slice(0, 20)) console.error(`  - ${b}`);
    if (bad.length > 20) console.error(`  ... and ${bad.length - 20} more`);
    process.exit(1);
  }

  const stats = summarise(rows);
  console.log(`atlas manifest sha : ${manifest.sha256}`);
  console.log(`atlas source commit: ${manifest.source?.commit ?? "(unrecorded)"}`);
  console.log(
    `rows ${stats.rows}   states ${stats.states}   affiliations ${stats.affiliations}   `
    + `MA ${stats.massachusetts}   geocoded ${stats.geocoded}   with membership ${stats.withMembership}`,
  );
  console.log(
    `jsonb: history ${stats.withHistory} rows / ${stats.historyPoints} entries   `
    + `sources ${stats.withSources} rows / ${stats.sourceRefs} entries   `
    + `finances ${stats.withFinances}   coverage ${stats.withCoverage}`,
  );

  if (mode === "plan") {
    console.log(`\nPLAN: ${rows.length} rows pass every declared constraint. Nothing was written.`);
    return;
  }

  const client = await connect();
  try {
    if (mode === "verify") {
      // The jsonb half of this query is not decoration. Until 2026-07-26 verify
      // counted only scalar columns, and `membership_history` and `sources`
      // default to '[]' while `finances` and `public_record_coverage` default
      // to NULL — so a load that wrote all 20,699 rows with every nested value
      // dropped would have matched on every counted dimension and reported
      // PASS. That is the same shape of defect as a migration recorded but
      // never executed: a check that agrees with itself. Counting the nested
      // values, and their cardinality, is what makes the load falsifiable.
      const { rows: [live] } = await client.query(
        `select count(*)::int as rows,
                count(distinct state)::int as states,
                count(distinct affiliation)::int as affiliations,
                count(*) filter (where state = 'MA')::int as massachusetts,
                count(*) filter (where latitude is not null)::int as geocoded,
                count(*) filter (where members_latest is not null)::int as with_membership,
                count(*) filter (where jsonb_typeof(membership_history) = 'array'
                                   and jsonb_array_length(membership_history) > 0)::int as with_history,
                coalesce(sum(case when jsonb_typeof(membership_history) = 'array'
                                  then jsonb_array_length(membership_history) end), 0)::int as history_points,
                count(*) filter (where finances is not null)::int as with_finances,
                count(*) filter (where public_record_coverage is not null)::int as with_coverage,
                count(*) filter (where jsonb_typeof(sources) = 'array'
                                   and jsonb_array_length(sources) > 0)::int as with_sources,
                coalesce(sum(case when jsonb_typeof(sources) = 'array'
                                  then jsonb_array_length(sources) end), 0)::int as source_refs,
                count(*) filter (where jsonb_typeof(membership_history) <> 'array'
                                    or jsonb_typeof(sources) <> 'array')::int as non_array_json,
                count(distinct atlas_manifest_sha)::int as manifest_shas,
                min(atlas_manifest_sha) as manifest_sha
           from public.union_orgs`,
      );
      const problems = [];
      if (live.rows !== stats.rows) problems.push(`row count ${live.rows} != ${stats.rows}`);
      if (live.states !== stats.states) problems.push(`distinct states ${live.states} != ${stats.states}`);
      if (live.affiliations !== stats.affiliations) problems.push(`affiliations ${live.affiliations} != ${stats.affiliations}`);
      if (live.massachusetts !== stats.massachusetts) problems.push(`MA ${live.massachusetts} != ${stats.massachusetts}`);
      if (live.geocoded !== stats.geocoded) problems.push(`geocoded ${live.geocoded} != ${stats.geocoded}`);
      if (live.with_membership !== stats.withMembership) problems.push(`with membership ${live.with_membership} != ${stats.withMembership}`);
      if (live.with_history !== stats.withHistory) problems.push(`rows with membership_history ${live.with_history} != ${stats.withHistory}`);
      if (live.history_points !== stats.historyPoints) problems.push(`membership_history entries ${live.history_points} != ${stats.historyPoints}`);
      if (live.with_finances !== stats.withFinances) problems.push(`rows with finances ${live.with_finances} != ${stats.withFinances}`);
      if (live.with_coverage !== stats.withCoverage) problems.push(`rows with public_record_coverage ${live.with_coverage} != ${stats.withCoverage}`);
      if (live.with_sources !== stats.withSources) problems.push(`rows with sources ${live.with_sources} != ${stats.withSources}`);
      if (live.source_refs !== stats.sourceRefs) problems.push(`source entries ${live.source_refs} != ${stats.sourceRefs}`);
      if (live.non_array_json !== 0) problems.push(`${live.non_array_json} row(s) hold a non-array membership_history or sources`);
      if (live.manifest_shas !== 1) problems.push(`${live.manifest_shas} distinct atlas_manifest_sha values — the table mixes Atlas builds`);
      else if (live.manifest_sha !== manifest.sha256) problems.push(`table was loaded from ${live.manifest_sha}, not ${manifest.sha256}`);

      if (problems.length > 0) {
        console.error(`\nFAIL: live table disagrees with the Atlas payload:\n`);
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
      }
      console.log(`\nPASS: public.union_orgs matches the Atlas payload on every counted dimension.`);
      return;
    }

    const build = upsertSql();
    let written = 0;
    await client.query("begin");
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await client.query(build(batch.length), flatten(batch));
      written += batch.length;
      if (written % 5000 === 0 || written === rows.length) console.log(`  upserted ${written}/${rows.length}`);
    }
    await client.query("commit");
    console.log(`\nLOADED: ${written} rows at manifest ${manifest.sha256}.`);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
