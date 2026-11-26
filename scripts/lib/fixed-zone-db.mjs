// The database half of the fixed-zone inventory
// (REQ-UG-TIME-ZONES-PER-GROUP-20261122; scripts/lib/fixed-zone-scan.mjs).
// It reads the catalog of a migrated database, never the migration files:
// the last definition of every function, column default, constraint, view,
// index, policy and trigger in the product's own schemas, and every
// scheduled job. An object is listed when its text does one of these:
//
// - `fixed`: names New York's zone or calls private.eastern_day.
// - `sessionDay`: reads the session's clock as a day or a local time
//   (current_date, now()::date, localtimestamp, date_trunc of now()). The
//   hosted sessions run in UTC.
// - `utc`: converts to or from UTC by name. Often right for machine time;
//   listed so each one is looked at once.
// - `fixedHour` (scheduled jobs only): fires at stated hours of the UTC day
//   and not every hour, so it may stand for one zone's time of day.
//
// A cast of a stored instant to a date with no zone (the class of #8876)
// cannot be seen in text and is not listed here; the test grid of the
// contract covers it.
export const DATABASE_SCHEMAS = Object.freeze(["private", "public"]);

const KIND_PATTERNS = Object.freeze({
  fixed: /america\/new_york|\beastern_day\s*\(/iu,
  sessionDay: new RegExp([
    String.raw`\bcurrent_date\b`,
    String.raw`\blocaltimestamp\b`,
    String.raw`\blocaltime\b`,
    String.raw`\b(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)\s*\)*\s*::\s*(?:date|time)\b`,
    String.raw`\bcurrent_timestamp\s*\)*\s*::\s*(?:date|time)\b`,
    String.raw`\bdate_trunc\s*\(\s*'[a-z]+'(?:::text)?\s*,\s*(?:pg_catalog\.)?(?:now|clock_timestamp|statement_timestamp|transaction_timestamp)\s*\(\s*\)\s*\)`,
    String.raw`\bdate_trunc\s*\(\s*'[a-z]+'(?:::text)?\s*,\s*current_timestamp\s*\)`,
  ].join("|"), "iu"),
  utc: /at\s+time\s+zone\s+'utc'|\btimezone\s*\(\s*'utc'/iu,
});

// SQL comments are history, not behaviour.
function sqlCode(text) {
  return String(text ?? "").replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/--[^\n]*/gu, " ");
}

export function classifyDatabaseText(text) {
  const code = sqlCode(text);
  return Object.entries(KIND_PATTERNS).filter(([, pattern]) => pattern.test(code)).map(([kind]) => kind);
}

// A cron schedule fires at stated hours when its hour field is not "*" or a
// plain "*/n" step.
export function firesAtStatedHours(schedule) {
  const fields = String(schedule ?? "").trim().split(/\s+/u);
  if (fields.length < 5) return false;
  return !/^\*(?:\/\d+)?$/u.test(fields[1]);
}

const OBJECT_QUERIES = Object.freeze({
  functions: `
    select p.oid::regprocedure::text as name, p.prosrc as text
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = any($1::text[]) and p.prokind in ('f', 'p')`,
  columnDefaults: `
    select n.nspname || '.' || c.relname || '.' || a.attname as name,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid) as text
      from pg_catalog.pg_attrdef d
      join pg_catalog.pg_class c on c.oid = d.adrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where n.nspname = any($1::text[]) and not a.attisdropped`,
  constraints: `
    select n.nspname || '.' || c.relname || ' ' || k.conname as name,
           pg_catalog.pg_get_constraintdef(k.oid) as text
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class c on c.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1::text[]) and k.contype = 'c'`,
  views: `
    select n.nspname || '.' || c.relname as name, pg_catalog.pg_get_viewdef(c.oid) as text
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1::text[]) and c.relkind in ('v', 'm')`,
  indexes: `
    select n.nspname || '.' || c.relname as name, pg_catalog.pg_get_indexdef(i.indexrelid) as text
      from pg_catalog.pg_index i
      join pg_catalog.pg_class c on c.oid = i.indexrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1::text[]) and (i.indexprs is not null or i.indpred is not null)`,
  policies: `
    select schemaname || '.' || tablename || ' ' || policyname as name,
           coalesce(qual, '') || ' ' || coalesce(with_check, '') as text
      from pg_catalog.pg_policies
     where schemaname = any($1::text[])`,
  triggers: `
    select n.nspname || '.' || c.relname || ' ' || t.tgname as name, pg_catalog.pg_get_triggerdef(t.oid) as text
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1::text[]) and not t.tgisinternal and t.tgqual is not null`,
});

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// Reads the catalog through a connected pg client and answers the listed
// objects of each kind, sorted, as {name, kinds}; a scheduled job also
// carries its schedule.
export async function collectFixedZoneDatabase(client) {
  const found = {};
  for (const [group, sql] of Object.entries(OBJECT_QUERIES)) {
    const { rows } = await client.query(sql, [[...DATABASE_SCHEMAS]]);
    found[group] = rows
      .map((row) => ({ name: row.name, kinds: classifyDatabaseText(row.text) }))
      .filter((row) => row.kinds.length)
      .sort(byName);
  }
  const hasCron = await client.query("select pg_catalog.to_regclass('cron.job') is not null as present");
  const jobs = hasCron.rows[0].present
    ? (await client.query("select jobname as name, schedule, command as text from cron.job where jobname is not null")).rows
    : [];
  found.scheduledJobs = jobs
    .map((row) => ({
      name: row.name,
      schedule: row.schedule,
      kinds: [...classifyDatabaseText(row.text), ...(firesAtStatedHours(row.schedule) ? ["fixedHour"] : [])],
    }))
    .filter((row) => row.kinds.length)
    .sort(byName);
  return found;
}

// What differs between the catalog and the saved list, as plain sentences.
export function databaseInventoryDifferences(saved, live) {
  const differences = [];
  for (const group of new Set([...Object.keys(saved ?? {}), ...Object.keys(live ?? {})])) {
    const listed = new Map((saved?.[group] ?? []).map((row) => [row.name, row]));
    const present = new Map((live?.[group] ?? []).map((row) => [row.name, row]));
    for (const [name, row] of present) {
      const was = listed.get(name);
      const now = [row.kinds.join(","), row.schedule ?? ""].join(" ");
      if (!was) differences.push(`${group}: ${name} is not listed (${now.trim()}); take its zone from the group, or add it with its kinds`);
      else if ([was.kinds.join(","), was.schedule ?? ""].join(" ") !== now) differences.push(`${group}: ${name} is listed as ${was.kinds.join(",")} ${was.schedule ?? ""} and is now ${now}`.replace(/\s+/gu, " ").trim());
    }
    for (const name of listed.keys()) {
      if (!present.has(name)) differences.push(`${group}: ${name} is listed and no longer uses a fixed zone or no longer exists; remove it`);
    }
  }
  return differences.sort();
}
