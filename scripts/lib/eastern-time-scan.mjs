// Two checks for the Eastern-time class
// (SYS-UG-SHARED-EASTERN-TIME-GUARD-20261113; src/lib/easternTime.js).
//
// 1. A migration newer than the one that adds private.eastern_day()
//    (MIGRATION_CUTOFF) may not read the session's day (current_date,
//    now()::date): the hosted databases run in UTC, so from 7 PM Eastern that
//    is tomorrow. Use private.local_day with private.group_time_zone of the
//    item's group (REQ-UG-TIME-ZONES-PER-GROUP-20261122; a new
//    migration may no longer call private.eastern_day, which
//    scripts/lib/fixed-zone-scan.mjs refuses). A line that means the UTC day on
//    purpose carries a "utc-day:" comment saying why. Older migrations had no
//    helper to call and are history (#8568 lists the functions they still
//    define).
// 2. Web and native code may not add a time formatter (an hour or timeStyle
//    option, toLocaleTimeString) without a zone label. Use formatZoneInstant
//    from src/lib/zoneTime.js with the zone of the group the item belongs to
//    (REQ-UG-TIME-ZONES-PER-GROUP-20261122: the Eastern formatters
//    are for their existing callers, and scripts/lib/fixed-zone-scan.mjs
//    refuses a new line that names Eastern time); a line that prints the
//    zone beside the time some other way ends with "zone-labelled". The files
//    that had unlabelled formatters on Nov 13, 2026 are listed with counts in
//    config/eastern-time-known.json, and the list only shrinks.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KNOWN_PATH = "config/eastern-time-known.json";
// The stamp of 20261113122500_eastern_day_helper.sql.
export const MIGRATION_CUTOFF = "20261113122500";
const MIGRATION = /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/u;
const SESSION_DAY = /\bcurrent_date\b|\bnow\s*\(\s*\)\s*::\s*date\b/iu;
const SOURCE = /^(?:src|apps\/mobile\/src)\/.+\.(?:[cm]?js|jsx|ts|tsx)$/u;
const TEST_FILE = /(?:\.test\.|\.spec\.|\/__tests__\/|\/fixtures\/)/u;
const TIME_FORMATTER = /\bhour\s*:\s*["'](?:numeric|2-digit)["']|\btimeStyle\s*:|\.toLocaleTimeString\s*\(/gu;
const LABELLED = /timeZoneName|zone-labelled/u;

export function sessionDayReads(sql) {
  const found = [];
  String(sql).split("\n").forEach((line, index) => {
    const code = line.replace(/--.*$/u, "");
    if (SESSION_DAY.test(code) && !/--\s*utc-day:/iu.test(line)) found.push(index + 1);
  });
  return found;
}

export function countUnlabelledTimes(text) {
  return String(text).split("\n")
    .filter((line) => !LABELLED.test(line))
    .reduce((total, line) => total + [...line.matchAll(TIME_FORMATTER)].length, 0);
}

export function easternTimeFindings({ migrations, counts, known }) {
  const failures = [];
  for (const [path, lines] of Object.entries(migrations)) {
    for (const line of lines) {
      failures.push(`${path}:${line}: reads the session's (UTC) day; count the day in the item's group zone with private.local_day(private.group_time_zone(organization, chapter, unit)), or say why with a "-- utc-day:" comment`);
    }
  }
  for (const [path, count] of Object.entries(counts)) {
    const allowed = known[path] ?? 0;
    if (count > allowed) {
      failures.push(`${path}: ${count} time formatter(s) without a zone label (known ${allowed}); use formatZoneInstant(value, lang, groupTimeZone(group)) from src/lib/zoneTime.js, with the group the item belongs to`);
    }
  }
  for (const [path, allowed] of Object.entries(known)) {
    const count = counts[path] ?? 0;
    if (count < allowed) failures.push(`${KNOWN_PATH}: ${path} now has ${count} unlabelled time formatter(s); lower its known count from ${allowed} to ${count}`);
  }
  return failures;
}

export function checkEasternTime(root, fail) {
  let paths;
  try {
    paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
      .split("\0");
  } catch (error) {
    fail(`eastern time scan: cannot list tracked files (${String(error.stderr || error.message).trim().split("\n")[0]})`);
    return { migrations: {}, counts: {} };
  }
  const read = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "");
  const migrations = {};
  const counts = {};
  for (const path of paths) {
    const version = MIGRATION.exec(path)?.[1];
    if (version && version > MIGRATION_CUTOFF) {
      const lines = sessionDayReads(read(path));
      if (lines.length) migrations[path] = lines;
    } else if (SOURCE.test(path) && !TEST_FILE.test(path)) {
      const count = countUnlabelledTimes(read(path));
      if (count) counts[path] = count;
    }
  }
  const known = existsSync(join(root, KNOWN_PATH)) ? JSON.parse(readFileSync(join(root, KNOWN_PATH), "utf8")).files ?? {} : {};
  for (const message of easternTimeFindings({ migrations, counts, known })) fail(message);
  return { migrations, counts };
}
