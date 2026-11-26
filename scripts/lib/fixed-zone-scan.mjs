// The inventory of everything that still works on one fixed time zone
// (REQ-UG-TIME-ZONES-PER-GROUP-20261122; docs/contracts/time-zones-per-group.md).
//
// Every group has its own zone, so a day, a deadline, a clock and a send time
// come from the zone of the group the item belongs to. Until the last of the
// old code is converted, config/fixed-zone-inventory.json lists what is left:
//
// - `source`: web, native and server files, with the number of lines that
//   name New York's zone or Eastern time (`fixed`), read the device's zone
//   (`device`), or take the UTC day of an instant as a date (`utcDay`).
//   This scan counts them and the list only shrinks: a file's count may not
//   pass its entry, and the total of each kind may not pass the total in the
//   list at the merge base with Main, so raising an entry beside the code is
//   refused wherever that base file is held (every lane checkout; a
//   blob-filtered clone that does not hold it leaves that to review).
// - `database`: the functions, column defaults, constraints, views and
//   scheduled jobs that do the same, read from the catalog by
//   scripts/fixed-zone-inventory.mjs --write-database; its reader is proven
//   by tests/fixed-zone-inventory-db.test.js.
//
// A line that must stay on a fixed zone, or that only looks like one (the
// PDF operator `ET`), says why at its end or in a comment on the line above:
// `fixed-zone: <reason>`, `device-zone: <reason>` or `utc-day: <reason>`.
//
// Database code written after the group helpers exist is held to the same
// rule: see scanFixedZoneMigrations below.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INVENTORY_PATH = "config/fixed-zone-inventory.json";
const SOURCE = /^(?:src|apps\/mobile\/src|api)\/.+\.(?:[cm]?js|jsx|ts|tsx|json)$/u;
const TEST_FILE = /(?:\.test\.|\.spec\.|\/__tests__\/|\/fixtures\/)/u;

export const KINDS = Object.freeze({
  fixed: Object.freeze({
    // "Eastern North America" is a place (a storage region), not a clock.
    pattern: /America\/New_York|[Ee]astern(?! North America)|EASTERN|\b(?:ET|EST|EDT)\b/gu,
    marker: /fixed-zone:\s*\S/u,
    means: "name New York's zone or Eastern time",
    repair: "take the zone from the item's group (groupTimeZone and the zone functions of src/lib/zoneTime.js)",
    mark: "fixed-zone: <why>",
  }),
  device: Object.freeze({
    pattern: /resolvedOptions\(\)\s*\.timeZone|getTimezoneOffset\s*\(/gu,
    marker: /device-zone:\s*\S/u,
    means: "read the device's time zone",
    repair: "take the zone from the item's group (groupTimeZone in src/lib/zoneTime.js); a person's device never decides a zone",
    mark: "device-zone: <why>",
  }),
  utcDay: Object.freeze({
    pattern: /toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/gu,
    marker: /utc-day:\s*\S/u,
    means: "take the UTC day of an instant as a date",
    repair: "use zoneDay(value, zone) from src/lib/zoneTime.js for a day a person sees",
    mark: "utc-day: <why>",
  }),
});

const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "in", "of", "do", "else", "void", "delete", "throw", "new", "yield", "await", "instanceof"]);
const REGEX_AFTER_CHAR = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "~", "^"]);

// The source with every comment turned to spaces, line breaks kept, so a
// dated note such as "decided at 10:10 AM ET" is history and not a clock the
// product shows. It walks the whole file and knows a string, a template and
// a regular expression from a comment, so the two slashes of a URL, or of
// "see // help" in a string, start nothing. Where it cannot tell (an
// apostrophe or a backtick in JSX text) it keeps the text as code, which can
// count a comment but never hides code.
export function withoutComments(source) {
  const text = String(source);
  // One entry per UTF-16 unit, as the string is indexed: spreading it would
  // make one entry of an emoji and shift every blank after it.
  const out = text.split("");
  const blank = (from, to) => { for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " "; };
  const modes = [{ template: false, depth: 0, inTemplate: false }];
  let last = "";
  let word = "";
  let spaced = false;
  let index = 0;
  while (index < text.length) {
    const mode = modes[modes.length - 1];
    const char = text[index];
    const next = text[index + 1];
    if (mode.template) {
      if (char === "\\") index += 2;
      else if (char === "`") { modes.pop(); last = "`"; word = ""; index += 1; }
      else if (char === "$" && next === "{") { modes.push({ template: false, depth: 0, inTemplate: true }); last = "{"; word = ""; index += 2; }
      else index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const stop = text.indexOf("\n", index);
      blank(index, stop === -1 ? text.length : stop);
      index = stop === -1 ? text.length : stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      index += 1;
      while (index < text.length && text[index] !== char && text[index] !== "\n") index += text[index] === "\\" ? 2 : 1;
      if (text[index] === char) index += 1;
      last = char;
      word = "";
      continue;
    }
    if (char === "`") {
      modes.push({ template: true });
      index += 1;
      continue;
    }
    if (char === "/" && (word ? REGEX_AFTER_WORD.has(word) : REGEX_AFTER_CHAR.has(last))) {
      let at = index + 1;
      let inClass = false;
      let close = -1;
      while (at < text.length && text[at] !== "\n") {
        if (text[at] === "\\") { at += 2; continue; }
        if (text[at] === "[") inClass = true;
        else if (text[at] === "]") inClass = false;
        else if (text[at] === "/" && !inClass) { close = at; break; }
        at += 1;
      }
      if (close !== -1) {
        index = close + 1;
        last = "/";
        word = "";
        continue;
      }
    }
    if (char === "{") mode.depth += 1;
    else if (char === "}") {
      if (mode.inTemplate && mode.depth === 0) { modes.pop(); index += 1; continue; }
      mode.depth -= 1;
    }
    if (/\s/u.test(char)) spaced = true;
    else {
      // The word before a slash decides it: "return /x/" is an expression, "a / b" a division.
      if (/[\w$]/u.test(char)) word = !spaced && /[\w$]/u.test(last) ? word + char : char;
      else word = "";
      last = char;
      spaced = false;
    }
    index += 1;
  }
  return out.join("");
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\{\/\*|\*)/u;

// The number of lines of each kind in a source file. A match may run over a
// line break (`.toISOString()` on one line, `.slice(0, 10)` on the next) and
// counts once, on the line it starts; a marker on any line it covers, or in a
// comment on the line above (for a line inside a template, where a trailing
// comment would be text), excuses it.
// Answers the line (from 0) an offset of the text is on.
function lineFinder(text) {
  const starts = [0];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
}

export function countFixedZoneLines(source) {
  const text = String(source);
  const code = withoutComments(text);
  const lines = text.split("\n");
  const lineOf = lineFinder(text);
  const counts = {};
  for (const [kind, rule] of Object.entries(KINDS)) {
    const hit = new Set();
    for (const match of code.matchAll(rule.pattern)) {
      const from = lineOf(match.index);
      const to = lineOf(match.index + match[0].length - 1);
      const above = from > 0 && COMMENT_LINE.test(lines[from - 1]) && rule.marker.test(lines[from - 1]);
      if (!above && !lines.slice(from, to + 1).some((line) => rule.marker.test(line))) hit.add(from);
    }
    if (hit.size) counts[kind] = hit.size;
  }
  return counts;
}

export function sourceTotals(source) {
  const totals = {};
  for (const kinds of Object.values(source ?? {})) {
    for (const [kind, count] of Object.entries(kinds)) totals[kind] = (totals[kind] ?? 0) + count;
  }
  return totals;
}

// The list only shrinks: the total of each kind may not pass the total of
// the list at the merge base. Totals, not files, so a file may be renamed or
// split without converting every line it carries.
export function inventoryGrowth(baseSource, source) {
  if (!baseSource) return [];
  const before = sourceTotals(baseSource);
  return Object.entries(sourceTotals(source))
    .filter(([kind, total]) => KINDS[kind] && total > (before[kind] ?? 0))
    .map(([kind, total]) => `${INVENTORY_PATH}: its lines that ${KINDS[kind].means} rose from ${before[kind] ?? 0} on Main to ${total}; the list only shrinks, so ${KINDS[kind].repair}, or say why with "${KINDS[kind].mark}" at the end of the new line or in a comment on the line above`);
}

// The source list at the merge base with Main: an object when it can be
// read from objects held here, null when the base has no list yet (the first
// list may be any size), undefined when it cannot be told (no git, no base,
// or a blob-filtered clone that does not hold the file; never a fetch).
export function baseSourceInventory(root, env = process.env) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: { ...env, GIT_NO_LAZY_FETCH: "1" },
  });
  try {
    const base = git("merge-base", "HEAD", env.WORKLIST_BASE_REF || env.CI_BASE_SHA || "origin/Main").trim();
    if (!git("ls-tree", base, "--", INVENTORY_PATH).trim()) return null;
    return JSON.parse(git("cat-file", "-p", `${base}:${INVENTORY_PATH}`)).source ?? null;
  } catch {
    return undefined; // swallow-ok: an unreadable base leaves the comparison out; the per-file check above still runs
  }
}

export function fixedZoneFindings({ counts, known }) {
  const failures = [];
  for (const [path, found] of Object.entries(counts)) {
    for (const [kind, count] of Object.entries(found)) {
      const allowed = known[path]?.[kind] ?? 0;
      const rule = KINDS[kind];
      if (count > allowed) {
        failures.push(`${path}: ${count} line(s) that ${rule.means} (known ${allowed}); ${rule.repair}, or say why with "${rule.mark}" at the end of the line or in a comment on the line above`);
      }
    }
  }
  for (const [path, allowedKinds] of Object.entries(known)) {
    for (const [kind, allowed] of Object.entries(allowedKinds)) {
      if (!KINDS[kind]) {
        failures.push(`${INVENTORY_PATH}: ${path} has an unknown kind "${kind}"`);
        continue;
      }
      const count = counts[path]?.[kind] ?? 0;
      if (count < allowed) {
        failures.push(count === 0
          ? `${INVENTORY_PATH}: ${path} no longer has a line that would ${KINDS[kind].means}; remove its "${kind}" entry`
          : `${INVENTORY_PATH}: ${path} now has ${count} line(s) that ${KINDS[kind].means}; lower its "${kind}" count from ${allowed} to ${count}`);
      }
    }
  }
  return failures;
}

function trackedPaths(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
    .split("\0").sort();
}

export function scanFixedZones(root, paths = trackedPaths(root)) {
  const counts = {};
  for (const path of paths) {
    if (!SOURCE.test(path) || TEST_FILE.test(path) || !existsSync(join(root, path))) continue;
    const found = countFixedZoneLines(readFileSync(join(root, path), "utf8"));
    if (Object.keys(found).length) counts[path] = found;
  }
  return counts;
}

// The migration that adds private.group_time_zone and private.local_day is
// found by its name, not its stamp, which changes at its turn in the
// migration line. From it on, a migration may not name New York's zone or
// call private.eastern_day: older migrations had no group helper to call and
// are history (the database half of the inventory lists what they still
// define).
export const FOUNDATION_MIGRATION = /^supabase\/migrations\/(\d{14})_group_time_zones_foundation\.sql$/u;
const MIGRATION = /^supabase\/migrations\/(\d{14})_[^/]+\.sql$/u;
// The helper's name may be written as a quoted name: private."eastern_day"().
const MIGRATION_FIXED = /america\/new_york|(?<![\w$])"?eastern_day"?\s*\(/giu;
const MIGRATION_MARKER = /--\s*fixed-zone:\s*\S/u;
const SQL_COMMENT_LINE = /^\s*--/u;

// SQL with every comment turned to spaces, line breaks kept. Two hyphens
// inside a quoted string or a quoted name start nothing, and block comments
// nest as Postgres nests them. A dollar-quoted block after AS or DO, or
// after DO LANGUAGE name, is a routine's body: it is code and is read like
// the rest. Any other
// dollar-quoted block is a string, whose hyphens and slashes are its
// content. Strings stay: the zone's name is one.
// A tag is empty or an identifier that does not start with a digit (tooling
// a review note).
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/uy;
const BODY_AFTER = new Set(["as", "do"]);

export function sqlWithoutComments(source) {
  const text = String(source);
  const out = text.split("");
  const blank = (from, to) => { for (let at = from; at < to; at += 1) if (out[at] !== "\n") out[at] = " "; };
  const bodies = [];
  let word = "";
  let wordEnded = true;
  // The two words before the last one, oldest first.
  let earlier = ["", ""];
  const forget = () => { word = ""; wordEnded = true; earlier = ["", ""]; };
  const opensBody = () => BODY_AFTER.has(word.toLowerCase())
    || (word !== "" && earlier[0].toLowerCase() === "do" && earlier[1].toLowerCase() === "language");
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "-" && next === "-") {
      const stop = text.indexOf("\n", index);
      blank(index, stop === -1 ? text.length : stop);
      index = stop === -1 ? text.length : stop;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      let at = index + 2;
      while (at < text.length && depth > 0) {
        if (text[at] === "/" && text[at + 1] === "*") { depth += 1; at += 2; }
        else if (text[at] === "*" && text[at + 1] === "/") { depth -= 1; at += 2; }
        else at += 1;
      }
      blank(index, at);
      index = at;
    } else if (char === "'" || char === '"') {
      // DO LANGUAGE "plpgsql" or 'plpgsql': the quoted name is the language,
      // and the body still follows it.
      const languageName = word.toLowerCase() === "language" && earlier[1].toLowerCase() === "do";
      // E'...' strings escape a quote with a backslash; every string doubles it.
      const escapes = char === "'" && /^[Ee]$/u.test(text[index - 1] ?? "") && !/[\w$]/u.test(text[index - 2] ?? "");
      index += 1;
      while (index < text.length) {
        if (escapes && text[index] === "\\") index += 2;
        else if (text[index] !== char) index += 1;
        else if (text[index + 1] === char) index += 2;
        else { index += 1; break; }
      }
      if (languageName) { earlier = [earlier[1], word]; word = "name"; wordEnded = true; }
      else forget();
    } else if (char === "$" && !/[\w$]/u.test(text[index - 1] ?? "")) {
      DOLLAR_TAG.lastIndex = index;
      const tag = DOLLAR_TAG.exec(text)?.[0];
      if (!tag) index += 1;
      else if (bodies[bodies.length - 1] === tag) { bodies.pop(); index += tag.length; }
      else if (opensBody()) { bodies.push(tag); index += tag.length; }
      else {
        const close = text.indexOf(tag, index + tag.length);
        index = close === -1 ? text.length : close + tag.length;
      }
      forget();
    } else {
      // The last word before a dollar quote says whether it opens a body.
      if (/[\w$]/u.test(char)) {
        if (wordEnded) { if (word !== "") earlier = [earlier[1], word]; word = char; }
        else word += char;
        wordEnded = false;
      } else { wordEnded = true; if (!/\s/u.test(char)) forget(); }
      index += 1;
    }
  }
  return out.join("");
}

// The lines (from 1) of a migration that name New York's zone or call
// private.eastern_day. The whole text is read, so a line break before the
// call's parenthesis hides nothing; a "-- fixed-zone:" reason on a line the
// match covers, or in a comment line directly above it, excuses it.
export function fixedZoneMigrationLines(sql) {
  const text = String(sql);
  const code = sqlWithoutComments(text);
  const lines = text.split("\n");
  const lineOf = lineFinder(text);
  const found = new Set();
  for (const match of code.matchAll(MIGRATION_FIXED)) {
    const from = lineOf(match.index);
    const to = lineOf(match.index + match[0].length - 1);
    const above = from > 0 && SQL_COMMENT_LINE.test(lines[from - 1]) && MIGRATION_MARKER.test(lines[from - 1]);
    if (!above && !lines.slice(from, to + 1).some((line) => MIGRATION_MARKER.test(line))) found.add(from + 1);
  }
  return [...found].sort((a, b) => a - b);
}

export function scanFixedZoneMigrations(root, paths = trackedPaths(root)) {
  const foundation = paths.map((path) => FOUNDATION_MIGRATION.exec(path)?.[1]).find(Boolean);
  const found = {};
  if (!foundation) return found;
  for (const path of paths) {
    const version = MIGRATION.exec(path)?.[1];
    if (!version || version < foundation || !existsSync(join(root, path))) continue;
    const lines = fixedZoneMigrationLines(readFileSync(join(root, path), "utf8"));
    if (lines.length) found[path] = lines;
  }
  return found;
}

export function fixedZoneMigrationFindings(migrations) {
  return Object.entries(migrations).flatMap(([path, lines]) => lines.map((line) => `${path}:${line}: names New York's zone or calls private.eastern_day; take the zone from the item's group with private.group_time_zone(organization, chapter, unit) and count the day with private.local_day, or say why with a "-- fixed-zone:" comment on that line or the line above`));
}

export function readFixedZoneInventory(root) {
  const file = join(root, INVENTORY_PATH);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export function checkFixedZones(root, fail, env = process.env) {
  let paths;
  try {
    paths = trackedPaths(root);
  } catch (error) {
    fail(`fixed zone scan: cannot list tracked files (${String(error.stderr || error.message).trim().split("\n")[0]})`);
    return {};
  }
  const counts = scanFixedZones(root, paths);
  const known = readFixedZoneInventory(root).source ?? {};
  for (const message of fixedZoneFindings({ counts, known })) fail(message);
  for (const message of inventoryGrowth(baseSourceInventory(root, env), known)) fail(message);
  for (const message of fixedZoneMigrationFindings(scanFixedZoneMigrations(root, paths))) fail(message);
  return counts;
}
