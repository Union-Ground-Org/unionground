// @vitest-environment node
//
// BUG-UG-HELD-FEATURE-TRACES-PACKET-LIMIT-AND-MAP-SUBTITLE-20261113 (#8598).
//
// The admin settings list leaves a held switch out, and a row that acts only
// beside it has to leave with it (src/lib/heldSettingCompanions.js and
// SETTING_LISTED_WITH in src/lib/organizationSettingsAdmin.js). The
// definitions carry no parent column, so this walks the migration chain: every
// settings definition, every switch a migration holds, and the newest body of
// every function. A row whose every server reader names a held switch acts
// beside it, and is listed only with it; a new limit like that cannot be
// listed by omission (field notes per draft packet was).
import { describe, expect, it } from "vitest";
import { SETTING_ACTS_BESIDE, withoutRowsBesideHeldSwitches } from "../src/lib/heldSettingCompanions.js";
import { SETTING_LISTED_WITH, listedSettings } from "../src/lib/organizationSettingsAdmin.js";
import { migrationFiles, stripComments } from "./helpers/migration.js";
import { RELEASE_CALENDAR_HELD_KEYS } from "./helpers/release-calendar-holds.js";

// Rows whose every server reader names a held switch but which still act on
// their own, each with the reason. Keep it short.
const STANDS_ALONE = {
  // #7663: the seven-argument public.create_member_invitation (unit-aware
  // admin invitations) reads it with no switch. The walk keys bodies by name,
  // so the six-argument wrapper declared after it hides that reader.
  "limits.security.invitation_chapter_daily": "admin invitations cap a chapter's day with no member-invitations switch",
};

const DEFINITIONS_TABLE = "public\\.platform_setting_definitions";
const SETTING_KEY = "[a-z_]+\\.[a-z0-9_]+(?:\\.[a-z0-9_]+)*";

// The chain in apply order, comments stripped.
const chain = migrationFiles().map(({ name, sql }) => ({ name, sql: stripComments(sql) }));

// Every settings definition the chain leaves in place, by key, with its kind.
function definitions() {
  const defined = new Map();
  // A definition row opens with its key and kind; a description may hold a
  // semicolon, so rows are matched in place rather than by statement.
  const rowOrRemoval = new RegExp(
    `\\(\\s*'(${SETTING_KEY})'\\s*,\\s*'(boolean|integer|text|text_list)'`
    + `|delete\\s+from\\s+${DEFINITIONS_TABLE}\\s+where\\s+key\\s*=\\s*'(${SETTING_KEY})'`,
    "gi",
  );
  for (const { sql } of chain) {
    for (const match of sql.matchAll(rowOrRemoval)) {
      if (match[3]) defined.delete(match[3]);
      else defined.set(match[1], match[2]);
    }
  }
  return defined;
}

// Every key whose newest release time in the chain is set: an update of
// release_at, or an insert that carries one as its last column.
function heldSwitches() {
  const releaseAt = new Map();
  const quotedKeys = (text) => [...text.matchAll(new RegExp(`'(${SETTING_KEY})'`, "g"))].map((match) => match[1]);
  for (const { sql } of chain) {
    const statements = new RegExp(
      `update\\s+${DEFINITIONS_TABLE}\\s+set\\s+release_at\\s*=\\s*(null|'[^']*')\\s+where\\s+key\\s*(?:in\\s*\\(([^)]*)\\)|=\\s*'(${SETTING_KEY})')`
      + `|insert\\s+into\\s+${DEFINITIONS_TABLE}\\s*\\(([^)]*)\\)\\s*values([\\s\\S]*?);`,
      "gi",
    );
    for (const match of sql.matchAll(statements)) {
      if (match[1] !== undefined) {
        for (const key of match[3] ? [match[3]] : quotedKeys(match[2])) releaseAt.set(key, match[1].toLowerCase());
        continue;
      }
      const columns = match[4].split(",").map((column) => column.trim().toLowerCase());
      if (columns.at(-1) !== "release_at") continue;
      for (const tuple of match[5].matchAll(new RegExp(`\\(\\s*'(${SETTING_KEY})'[\\s\\S]*?,\\s*(null|'[^']*')\\s*\\)\\s*(?=,|$|on\\s+conflict)`, "gi"))) {
        releaseAt.set(tuple[1], tuple[2].toLowerCase());
      }
    }
  }
  return [...releaseAt].filter(([, value]) => value !== "null").map(([key]) => key).sort();
}

// Newest body of every function in the chain, keyed by schema.name.
function newestBodies() {
  const newest = new Map();
  const declares = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi;
  for (const { name, sql } of chain) {
    for (const match of sql.matchAll(declares)) {
      const open = sql.slice(match.index).match(/\bas\s+(\$[a-z_]*\$)/i);
      if (!open) throw new Error(`${match[1]} in ${name} has no dollar-quoted body`);
      const start = match.index + open.index + open[0].length;
      const end = sql.indexOf(open[1], start);
      if (end === -1) throw new Error(`${match[1]} in ${name} does not terminate`);
      newest.set(match[1].toLowerCase(), sql.slice(start, end));
    }
  }
  return newest;
}

const defined = definitions();
const held = heldSwitches();
const bodies = [...newestBodies()];
const readersOf = (key) => bodies.filter(([, body]) => body.includes(`'${key}'`));

// Each row that is not held itself, with the held switches every one of its
// server readers names.
function rowsBesideHeldSwitches() {
  const beside = new Map();
  for (const key of defined.keys()) {
    if (held.includes(key)) continue;
    const readers = readersOf(key);
    if (readers.length === 0) continue;
    const named = held.filter((switchKey) => readers.every(([, body]) => body.includes(`'${switchKey}'`)));
    if (named.length > 0) beside.set(key, named);
  }
  return beside;
}

describe("settings rows that act beside a held switch (migration walk)", () => {
  it("reads the definitions and every switch the chain holds", () => {
    expect(defined.size).toBeGreaterThan(150);
    expect(defined.has("limits.analytics.ai_usage_digest_sections")).toBe(false);
    // Every switch Main holds, so a parser that stops seeing a hold fails here.
    for (const key of [...RELEASE_CALENDAR_HELD_KEYS, "features.identity_providers.apple", "features.identity_providers.google"]) {
      expect(held, key).toContain(key);
    }
    for (const key of held) expect(defined.get(key), `${key} is held, so it must be a boolean definition`).toBe("boolean");
  });

  it("lists every row whose every server reader names a held switch only beside that switch", () => {
    const unlisted = [];
    for (const [key, switches] of rowsBesideHeldSwitches()) {
      if (Object.hasOwn(STANDS_ALONE, key)) continue;
      const besideOne = Object.hasOwn(SETTING_ACTS_BESIDE, key) && SETTING_ACTS_BESIDE[key].some((switchKey) => switches.includes(switchKey));
      const listedWith = Object.hasOwn(SETTING_LISTED_WITH, key) && switches.includes(SETTING_LISTED_WITH[key]);
      if (!besideOne && !listedWith) unlisted.push(`${key} (beside ${switches.join(", ")})`);
    }
    expect(unlisted, "add the row to SETTING_ACTS_BESIDE in src/lib/heldSettingCompanions.js, or to STANDS_ALONE here with a reason").toEqual([]);
  });

  it("finds the field notes per draft packet limit beside the held packet switch", () => {
    expect(rowsBesideHeldSwitches().get("limits.ai_assistant.packet_notes")).toEqual(["features.ai_assistant.field_notes_packet"]);
  });

  it("names, for every companion row, switches its server readers check", () => {
    for (const [key, switches] of Object.entries(SETTING_ACTS_BESIDE)) {
      expect(defined.has(key), `${key} is not a settings definition`).toBe(true);
      expect(held, `${key} is held itself`).not.toContain(key);
      const readers = readersOf(key);
      expect(readers.length, `${key} has no server reader to read the relation from`).toBeGreaterThan(0);
      for (const switchKey of switches) {
        expect(defined.get(switchKey), `${key}: ${switchKey}`).toBe("boolean");
        for (const [name, body] of readers) expect(body.includes(`'${switchKey}'`), `${name} reads ${key} without checking ${switchKey}`).toBe(true);
      }
    }
    for (const [key, switchKey] of Object.entries(SETTING_LISTED_WITH)) {
      expect(defined.has(key), `${key} is not a settings definition`).toBe(true);
      expect(defined.get(switchKey), `${key}: ${switchKey}`).toBe("boolean");
    }
  });

  it("keeps the reviewed exceptions current", () => {
    const beside = rowsBesideHeldSwitches();
    for (const [key, reason] of Object.entries(STANDS_ALONE)) {
      expect(reason, key).toMatch(/\S/);
      expect(beside.has(key), `${key} no longer sits beside a held switch; drop it`).toBe(true);
    }
  });

  // The admin list built from every definition, as the server returns it.
  const row = (key) => ({ key, kind: defined.get(key), category: key.split(".")[1], label: key, description: "", value: null, defaultValue: null, overridden: false, updatedAt: null, lastChange: null });
  const listed = (settings) => listedSettings(withoutRowsBesideHeldSwitches(settings)).map((item) => item.key);

  it("leaves out, with the held switches, every row beside them, and nothing else", () => {
    const serverList = [...defined.keys()].filter((key) => !held.includes(key)).map(row);
    const shown = listed(serverList);
    const beside = [...rowsBesideHeldSwitches().keys()].filter((key) => !Object.hasOwn(STANDS_ALONE, key));
    for (const key of beside) expect(shown, key).not.toContain(key);
    for (const [key, switchKey] of Object.entries(SETTING_LISTED_WITH)) if (held.includes(switchKey)) expect(shown, key).not.toContain(key);
    const gone = serverList.map((item) => item.key).filter((key) => !shown.includes(key));
    for (const key of gone) {
      const actsBeside = Object.hasOwn(SETTING_ACTS_BESIDE, key) && SETTING_ACTS_BESIDE[key].some((switchKey) => held.includes(switchKey));
      const listedWith = Object.hasOwn(SETTING_LISTED_WITH, key) && held.includes(SETTING_LISTED_WITH[key]);
      expect(actsBeside || listedWith, `${key} left the list but sits beside no held switch`).toBe(true);
    }
  });

  it("lists every definition again once every switch is released", () => {
    const serverList = [...defined.keys()].map(row);
    expect(listed(serverList)).toEqual(serverList.map((item) => item.key));
  });
});
