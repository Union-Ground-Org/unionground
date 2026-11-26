#!/usr/bin/env node
// Release calendar: read and change the release time of held feature switches
// on Production and the SAMPLE tour together, record
// REQ-UG-RELEASE-DATE-CONTROL-WITHOUT-MIGRATION-20261112 (#8580).
// The rules are in docs/contracts/staged-feature-releases.md.
//
//   release-calendar.mjs list
//   release-calendar.mjs set KEY "YYYY-MM-DD [HH:MM]" --by NAME --reason TEXT   (Eastern; 9:00 AM when no time)
//   release-calendar.mjs move KEY --weeks N --by NAME --reason TEXT
//   release-calendar.mjs shift YYYY-MM-DD --weeks N --by NAME --reason TEXT     (every dated hold from that day on)
//   release-calendar.mjs hold KEY --by NAME --reason TEXT                       (held, no date)
//   release-calendar.mjs release KEY --by NAME --reason TEXT                    (released now)
//   release-calendar.mjs sync --by NAME --reason TEXT                           (SAMPLE takes Production's times)
//   release-calendar.mjs history [KEY]
//
// Writes go through public.set_platform_setting_release and
// public.shift_platform_setting_releases on each database (one audit row per
// change), Production first, then SAMPLE ("SAMPLE follows Production"). Each
// write shows what will change on each site and asks once; --yes saves without
// asking, and without a terminal and without --yes it only previews. A write
// that would leave the two sites different is refused; --site production or
// --site sample acts on one site, and `list` shows the difference until `sync`.
// "Now" is the databases' clock. A shift carries the holds it showed and the
// database moves nothing if they changed. After saving, every switch must read
// back as shown, or the command exits 1.
// The first hold of a switch stays a reviewed migration: these functions
// refuse a switch that was never held.
//
// Transport: the Supabase Management API query endpoint with the access token
// in SUPABASE_ACCESS_TOKEN or the workstation keyring ("Supabase CLI"); reads
// use the read-only role. The token is never printed.
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

export const SITES = Object.freeze({
  production: { label: "Production", ref: "productionprojectref" },
  sample: { label: "SAMPLE", ref: "sampledemoprojectref" },
});
const ORDER = ["production", "sample"];
const KEY = /^features\.[a-z0-9_]+(?:\.[a-z0-9_]+)+$/u;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const WHEN = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?$/u;
const EASTERN_TEXT = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/u;
const WRITES = new Set(["set", "move", "shift", "hold", "release", "sync"]);
export const USAGE = `usage: release-calendar.mjs list | history [KEY]
  | set KEY "YYYY-MM-DD [HH:MM]" | move KEY --weeks N | shift YYYY-MM-DD --weeks N | hold KEY | release KEY | sync
  writes need --by NAME --reason TEXT; options --site production|sample|both, --yes`;

export class UsageError extends Error {}

export function sqlText(value) {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) throw new UsageError("text must be one line with no control characters");
  return `'${value.replaceAll("'", "''")}'`;
}

export function parseArgs(argv) {
  const options = { site: "both", yes: false, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--yes") options.yes = true;
    else if (arg === "--by") options.by = value().trim();
    else if (arg === "--reason") options.reason = value().trim();
    else if (arg === "--site") options.site = value();
    else if (arg === "--weeks") options.weeks = Number(value());
    else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    else options.positional.push(arg);
  }
  const [command, ...rest] = options.positional;
  options.command = command;
  options.rest = rest;
  if (!["list", "history", ...WRITES].includes(command)) throw new UsageError(USAGE);
  if (!["both", ...ORDER].includes(options.site)) throw new UsageError("--site is production, sample or both");
  if (WRITES.has(command)) {
    if (!options.by || options.by.length > 120) throw new UsageError("--by NAME is required (who is making the change)");
    if (!options.reason || options.reason.length > 500) throw new UsageError("--reason TEXT is required (500 characters at most)");
    sqlText(options.by);
    sqlText(options.reason);
  }
  const needsKey = ["set", "move", "hold", "release"].includes(command);
  if (needsKey && !KEY.test(rest[0] ?? "")) throw new UsageError(`${command} needs a switch key such as features.civic.watchlist`);
  if (command === "history" && rest[0] !== undefined && !KEY.test(rest[0])) throw new UsageError("history takes a switch key");
  if (command === "set" && !WHEN.test(rest[1] ?? "")) throw new UsageError('set needs an Eastern time: "YYYY-MM-DD" or "YYYY-MM-DD HH:MM"');
  if (command === "shift" && !validDay(rest[0])) throw new UsageError("shift needs a day: YYYY-MM-DD (Eastern)");
  if (["move", "shift"].includes(command) && !(Number.isInteger(options.weeks) && options.weeks !== 0 && Math.abs(options.weeks) <= 8)) {
    throw new UsageError("--weeks is a whole number from -8 to 8, not 0");
  }
  const expected = { list: 0, history: rest[0] === undefined ? 0 : 1, set: 2, move: 1, shift: 1, hold: 1, release: 1, sync: 0 }[command];
  if (rest.length !== expected) throw new UsageError(USAGE);
  return options;
}

function validDay(text) {
  const match = DAY.exec(text ?? "");
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === text;
}

// Eastern wall-clock text ("YYYY-MM-DD HH:MM") moved by whole weeks: the date
// moves, the time of day stays (the database turns it into an instant).
export function addWeeks(easternText, weeks) {
  const match = EASTERN_TEXT.exec(easternText);
  if (!match) throw new Error(`not an Eastern time: ${easternText}`);
  const [year, month, day] = match[1].split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + weeks * 7));
  return `${date.toISOString().slice(0, 10)} ${match[2]}:${match[3]}`;
}

// Whether an Eastern wall-clock time ("YYYY-MM-DD HH:MM") happens at all: the
// night the clocks spring forward, 2:00 to 2:59 AM never does, and the database
// would turn such a time into one an hour later without saying so (#8783). A
// time in the fall-back hour happens twice and is kept.
const EASTERN_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
export function easternTimeExists(easternText) {
  const match = EASTERN_TEXT.exec(easternText ?? "");
  if (!match) return false;
  const [year, month, day] = match[1].split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day, Number(match[2]), Number(match[3]));
  const shown = `${match[1]} ${match[2]}:${match[3]}`;
  // Eastern is four hours behind UTC in daylight time and five in standard time.
  return [4, 5].some((hours) => {
    const parts = Object.fromEntries(EASTERN_PARTS.formatToParts(new Date(wall + hours * 3600_000)).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` === shown;
  });
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2027-01-04 09:00" -> "Mon Jan 4, 2027, 9:00 AM ET".
export function formatEastern(easternText) {
  const match = EASTERN_TEXT.exec(easternText ?? "");
  if (!match) return String(easternText);
  const [year, month, day] = match[1].split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const hour = Number(match[2]);
  const clock = `${hour % 12 || 12}:${match[3]} ${hour < 12 ? "AM" : "PM"}`;
  return `${weekday} ${MONTHS[month - 1]} ${day}, ${year}, ${clock} ET`;
}

export function describeRow(row) {
  if (!row) return "not held here";
  if (row.release_at === "infinity") return "held, no date";
  const when = formatEastern(row.eastern);
  return row.held ? `held until ${when}` : `released ${when}`;
}

// The two functions of the platform_setting_release_control migration, as
// that migration grants them. A site has the control only when both exist;
// tests/release-calendar-control-db.test.js runs STATE_SQL on a migrated
// database, so a signature that drifts from the migration fails there.
export const CONTROL_FUNCTIONS = Object.freeze([
  "public.set_platform_setting_release(text, timestamptz, text, text)",
  "public.shift_platform_setting_releases(date, integer, jsonb, text, text)",
]);

export const STATE_SQL = `/* release-calendar:state */ select pg_catalog.json_build_object(
  'control', ${CONTROL_FUNCTIONS.map((signature) => `pg_catalog.to_regprocedure(${sqlText(signature)}) is not null`).join("\n    and ")},
  'now', pg_catalog.now()::text,
  'rows', coalesce((select pg_catalog.json_agg(pg_catalog.json_build_object(
    'key', d.key, 'release_at', d.release_at::text,
    'eastern', case when pg_catalog.isfinite(d.release_at)
      then pg_catalog.to_char(d.release_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') end,
    'held', d.release_at > pg_catalog.now()) order by d.key)
  from public.platform_setting_definitions d where d.release_at is not null), '[]'::json)) as state`;

function historySql(key) {
  return `/* release-calendar:history */ select c.created_at::text as at, c.action, c.setting_key as key,
  case when pg_catalog.isfinite(c.previous_release_at)
    then pg_catalog.to_char(c.previous_release_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') end as previous,
  c.previous_release_at::text as previous_raw,
  case when pg_catalog.isfinite(c.new_release_at)
    then pg_catalog.to_char(c.new_release_at at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI') end as next,
  c.new_release_at::text as next_raw, c.reason, coalesce(c.actor_name, c.actor_user_id::text) as who
from private.platform_setting_release_changes c
${key ? `where c.setting_key = ${sqlText(key)}` : ""}
order by c.id desc limit 50`;
}

const setSql = (key, timeLiteral, reason, by) => `/* release-calendar:set */ select public.set_platform_setting_release(${sqlText(key)}, ${timeLiteral}, ${sqlText(reason)}, ${sqlText(by)}) as result`;
// The previewed holds (key -> release_at) go with the shift: the database moves
// nothing unless, under its row locks, they are exactly the ones it would move.
const shiftSql = (day, weeks, previewed, reason, by) => `/* release-calendar:shift */ select public.shift_platform_setting_releases(${sqlText(day)}::date, ${weeks}, ${sqlText(JSON.stringify(previewed))}::jsonb, ${sqlText(reason)}, ${sqlText(by)}) as result`;
const easternLiteral = (easternText) => `${sqlText(`${easternText} America/New_York`)}::timestamptz`;

export async function readState(deps, site) {
  const rows = await deps.query(site, STATE_SQL, { readOnly: true });
  const state = rows?.[0]?.state;
  if (!state || !Array.isArray(state.rows)) throw new Error(`${SITES[site].label}: unexpected answer to the state read`);
  return { control: state.control === true, now: state.now, rows: new Map(state.rows.map((row) => [row.key, row])) };
}

export function listLines(states, sites) {
  const keys = [...new Set(sites.flatMap((site) => [...states[site].rows.keys()]))].sort();
  const lines = [];
  let differs = 0;
  for (const key of keys) {
    const values = sites.map((site) => states[site].rows.get(key));
    const differ = sites.length > 1 && values[0]?.release_at !== values[1]?.release_at;
    if (differ) differs += 1;
    lines.push(`${differ ? "DIFFERS " : ""}${key}`);
    sites.forEach((site, index) => lines.push(`  ${SITES[site].label.padEnd(10)} ${describeRow(values[index])}`));
  }
  if (!keys.length) lines.push("No switch has a release time.");
  for (const site of sites) {
    if (!states[site].control) lines.push(`${SITES[site].label}: the release control functions are not applied here yet; dates can only be read.`);
  }
  if (differs) lines.push(`${differs} switch(es) differ between the sites: run "release-calendar.mjs sync" to give SAMPLE Production's times.`);
  return { lines, differs };
}

// The plan: changes, one per site and key, { site, key, from, to, call, check }
// (call is the SQL; check says whether the row read back is what was shown),
// plus a shift's one call per site, and refusals (keys sync cannot repair).
export function planChanges(options, states, sites) {
  const { command, rest, weeks, reason, by } = options;
  const changes = [];
  const refusals = [];
  const refuse = (message) => { throw new UsageError(message); };
  const mustExist = (key, eastern) => {
    if (!easternTimeExists(eastern)) {
      refuse(`${key} would move to ${eastern}, which does not exist in Eastern time (the clocks spring forward that night); nothing was saved. Choose another time or number of weeks.`);
    }
  };
  for (const site of sites) if (!states[site].control) refuse(`${SITES[site].label} does not have the release control functions yet (apply the migration there first)`);

  if (command === "shift") {
    const [day] = rest;
    const affected = (site) => [...states[site].rows.values()]
      .filter((row) => row.held && row.release_at !== "infinity" && row.eastern.slice(0, 10) >= day)
      .map((row) => `${row.key}=${row.release_at}`).sort();
    if (sites.length > 1 && affected(sites[0]).join() !== affected(sites[1]).join()) {
      refuse(`the sites disagree on the dated holds from ${day} on; run sync first (see list)`);
    }
    for (const site of sites) {
      const moved = [...states[site].rows.values()].filter((row) => row.held && row.release_at !== "infinity" && row.eastern.slice(0, 10) >= day);
      for (const row of moved) {
        const eastern = addWeeks(row.eastern, weeks);
        mustExist(row.key, eastern);
        changes.push({ site, key: row.key, from: describeRow(row), to: `held until ${formatEastern(eastern)}`, check: (after) => after?.eastern === eastern });
      }
      changes.push({ site, call: shiftSql(day, weeks, Object.fromEntries(moved.map((row) => [row.key, row.release_at])), reason, by) });
    }
    return { changes, refusals };
  }

  if (command === "sync") {
    if (sites.length !== 2) refuse("sync works on both sites");
    for (const [key, row] of states.production.rows) {
      const other = states.sample.rows.get(key);
      if (other?.release_at === row.release_at) continue;
      if (!other) {
        refusals.push(`${key}: held on Production (${describeRow(row)}) but never held on SAMPLE; apply its hold migration on SAMPLE`);
        continue;
      }
      const literal = row.release_at === "infinity" ? "'infinity'::timestamptz" : sqlText(row.release_at) + "::timestamptz";
      changes.push({ site: "sample", key, from: describeRow(other), to: describeRow(row), call: setSql(key, literal, reason, by), check: (after) => after?.release_at === row.release_at });
    }
    // Sync copies Production's times to SAMPLE and never writes Production, so
    // it cannot clear a hold that only SAMPLE has.
    for (const [key, row] of states.sample.rows) {
      if (!states.production.rows.has(key)) {
        refusals.push(`${key}: held on SAMPLE (${describeRow(row)}) but has no release time on Production; sync never writes Production and cannot clear a hold, so reconcile it in the migration line (the hold migration on Production, or a migration clearing it on SAMPLE)`);
      }
    }
    return { changes, refusals };
  }

  const [key, when] = rest;
  const current = sites.map((site) => states[site].rows.get(key));
  if (sites.length > 1 && current[0]?.release_at !== current[1]?.release_at) {
    refuse(`${key} differs between the sites (${describeRow(current[0])} / ${describeRow(current[1])}); run sync first`);
  }
  if (!current[0]) refuse(`${key} was never held: its first hold is a reviewed migration (docs/contracts/staged-feature-releases.md)`);
  let literal;
  let to;
  let check;
  if (command === "set") {
    const match = WHEN.exec(when);
    if (!validDay(match[1])) refuse(`not a calendar day: ${match[1]}`);
    const eastern = `${match[1]} ${match[2] ?? "09"}:${match[3] ?? "00"}`;
    mustExist(key, eastern);
    literal = easternLiteral(eastern);
    to = `${formatEastern(eastern)} (held until then; a time already past releases it)`;
    check = (after) => after?.eastern === eastern;
  } else if (command === "move") {
    if (!current[0].held || current[0].release_at === "infinity") refuse(`${key} has no future date to move (${describeRow(current[0])}); use set`);
    const eastern = addWeeks(current[0].eastern, weeks);
    mustExist(key, eastern);
    literal = easternLiteral(eastern);
    to = `held until ${formatEastern(eastern)}`;
    check = (after) => after?.eastern === eastern;
  } else if (command === "hold") {
    literal = "'infinity'::timestamptz";
    to = "held, no date";
    check = (after) => after?.release_at === "infinity";
  } else {
    // "Now" is the databases' clock, never the workstation's: the earliest
    // now() the sites reported, one time for both so they stay the same.
    const now = sites.map((site) => states[site].now).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    literal = `${sqlText(now)}::timestamptz`;
    to = "released now";
    check = (after) => Boolean(after) && after.held === false;
  }
  for (const site of sites) changes.push({ site, key, from: describeRow(states[site].rows.get(key)), to, call: setSql(key, literal, reason, by), check });
  return { changes, refusals };
}

async function managementQuery(site, query, { readOnly }, token) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${SITES[site].ref}/database/query`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only: readOnly }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || !Array.isArray(body)) {
    throw new Error(`${SITES[site].label}: ${response.status} ${String(body?.message ?? text).slice(0, 400)}`);
  }
  return body;
}

function accessToken() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const token = execFileSync("secret-tool", ["lookup", "service", "Supabase CLI", "username", "supabase"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (!token) throw new Error("no Supabase access token: set SUPABASE_ACCESS_TOKEN or the keyring entry");
  return token;
}

export async function main(argv, deps) {
  const out = deps.out;
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) { out(error.message); return 2; }
    throw error;
  }
  const sites = options.site === "both" ? ORDER : [options.site];

  if (options.command === "history") {
    for (const site of sites) {
      out(`${SITES[site].label}:`);
      const rows = await deps.query(site, historySql(options.rest[0]), { readOnly: false });
      if (!rows.length) out("  no changes recorded");
      for (const row of rows) {
        out(`  ${row.at} ${row.key}: ${row.previous_raw === "infinity" ? "no date" : formatEastern(row.previous)} -> ${row.next_raw === "infinity" ? "no date" : formatEastern(row.next)} by ${row.who} (${row.action}): ${row.reason}`);
      }
    }
    return 0;
  }

  const states = {};
  for (const site of sites) states[site] = await readState(deps, site);
  if (options.command === "list") {
    const { lines, differs } = listLines(states, sites);
    lines.forEach((line) => out(line));
    return differs ? 1 : 0;
  }

  let changes;
  let refusals;
  try {
    ({ changes, refusals } = planChanges(options, states, sites));
  } catch (error) {
    if (error instanceof UsageError) { out(`Refused: ${error.message}`); return 2; }
    throw error;
  }
  const shown = changes.filter((change) => change.key);
  if (refusals.length) {
    out("Cannot sync:");
    for (const refusal of refusals) out(`  ${refusal}`);
  }
  if (!shown.length) {
    if (refusals.length) { out("Nothing was saved: the sites still differ (see above)."); return 2; }
    out("Nothing to change.");
    return 0;
  }
  out(`This will change, ${sites.map((site) => SITES[site].label).join(" then ")}:`);
  for (const change of shown) out(`  ${SITES[change.site].label.padEnd(10)} ${change.key}: ${change.from} -> ${change.to}`);
  out(`By ${options.by}: ${options.reason}`);
  if (!options.yes) {
    if (!deps.interactive) { out("Preview only: nothing was saved. Add --yes to save."); return 0; }
    if (!(await deps.confirm("Save these changes? (y/N) "))) { out("Not saved."); return 0; }
  }

  const calls = changes.filter((change) => change.call);
  for (const site of [...new Set(calls.map((change) => change.site))]) {
    for (const change of calls.filter((entry) => entry.site === site)) {
      try {
        await deps.query(site, change.call, { readOnly: false });
      } catch (error) {
        out(`${SITES[site].label} refused: ${error.message}`);
        if (site === "production") out("Nothing was saved on SAMPLE.");
        else out('Production was changed and SAMPLE was not: run "release-calendar.mjs sync" once the cause is fixed.');
        return 1;
      }
    }
  }
  out("Saved. Now:");
  const after = {};
  for (const site of ORDER) after[site] = await readState(deps, site);
  const { lines, differs } = listLines(after, ORDER);
  lines.forEach((line) => out(line));
  // Each saved switch must read back as it was shown.
  const wrong = shown.filter((change) => !change.check(after[change.site].rows.get(change.key)));
  for (const change of wrong) {
    out(`NOT AS SHOWN: ${SITES[change.site].label} ${change.key} is ${describeRow(after[change.site].rows.get(change.key))}, expected ${change.to}`);
  }
  return differs || wrong.length || refusals.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let token;
  const deps = {
    out: (line) => console.log(line),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try { return /^y(es)?$/iu.test((await prompt.question(question)).trim()); } finally { prompt.close(); }
    },
    query: (site, sql, options) => managementQuery(site, sql, options, token ??= accessToken()),
  };
  main(process.argv.slice(2), deps).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
