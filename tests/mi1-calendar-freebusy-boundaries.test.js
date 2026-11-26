// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { forbiddenSupabaseRefsIn } from "../scripts/lib/sibling-deny-list.mjs";
import {
  CALENDAR_FREEBUSY_DONOR_BASELINE,
  CALENDAR_FREEBUSY_DONOR_UNITS,
  CALENDAR_FREEBUSY_PERSISTENCE_CONTRACT,
  CALENDAR_FREEBUSY_VIEW_STATES,
  presentLoading,
  presentRetry,
} from "../src/features/calendarFreeBusy/index.js";

// Recurse into subdirectories and include .jsx so this boundary check
// actually covers what the assertions below claim, instead of a
// non-recursive .js-only scan (see accessHistory's identical fix,
// gf-a-tests-15-tests-F5).
function collectImplementationFiles(dirUrl) {
  return readdirSync(dirUrl, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "provenance.js") return [];
    const entryUrl = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dirUrl);
    if (entry.isDirectory()) return collectImplementationFiles(entryUrl);
    if (!/\.jsx?$/.test(entry.name)) return [];
    return [{ name: entry.name, source: readFileSync(entryUrl, "utf8") }];
  });
}

const featureRoot = new URL("../src/features/calendarFreeBusy/", import.meta.url);
const implementationFiles = collectImplementationFiles(featureRoot);
const NEXT_IMPORT = /from ["']next\//;
// Stricter than accessHistory: this feature takes every instant from its
// caller, so even `new Date(value)` is outside the boundary.
const DATE_CONSTRUCTION = /new Date\s*\(/;

function scanFixture(sources) {
  const dir = mkdtempSync(join(tmpdir(), "calendar-freebusy-boundary-"));
  try {
    for (const [name, source] of Object.entries(sources)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), source);
    }
    return collectImplementationFiles(pathToFileURL(`${dir}/`)).map((file) => file.source).join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("calendar free/busy donor and launch boundaries", () => {
  it("records donor provenance and rejected legacy assumptions", () => {
    expect(CALENDAR_FREEBUSY_DONOR_BASELINE).toBe("donor-baseline-20260721");
    expect(CALENDAR_FREEBUSY_DONOR_UNITS.every((unit) => unit.auditId === "CR-091")).toBe(true);
    expect(CALENDAR_FREEBUSY_DONOR_UNITS.some((unit) => unit.donorPath === "lib/google/calendar.ts" && unit.disposition === "discard")).toBe(true);
    expect(CALENDAR_FREEBUSY_DONOR_UNITS.some((unit) => unit.rejected.includes("grievance case numbers copied into Google Calendar summaries"))).toBe(true);
  });

  it("does not ship donor seeds, project refs, Next.js boundaries, or a live clock", () => {
    const joined = implementationFiles.map((file) => file.source).join("\n");
    expect(forbiddenSupabaseRefsIn(joined)).toEqual([]);
    expect(joined).not.toMatch(NEXT_IMPORT);
    expect(joined).not.toMatch(/Date\.now\s*\(/);
    expect(joined).not.toMatch(DATE_CONSTRUCTION);
    expect(joined).not.toMatch(/createClient\([^)]*service/i);
    expect(joined).not.toMatch(/@googleapis\/calendar/);
    expect(CALENDAR_FREEBUSY_PERSISTENCE_CONTRACT.sessionOrganizationOnly).toBe(true);
    expect(CALENDAR_FREEBUSY_PERSISTENCE_CONTRACT.publicTablesRemainTokenFree).toBe(true);
    expect(CALENDAR_FREEBUSY_PERSISTENCE_CONTRACT.migration).toBe("20260828073000_mi1_calendar_freebusy_oauth.sql");
    expect(CALENDAR_FREEBUSY_PERSISTENCE_CONTRACT.rpcs).toEqual(expect.arrayContaining([
      "save_calendar_oauth_state",
      "list_steward_calendar_oauth_tokens",
      "mark_calendar_connection_error",
      "mark_calendar_import_error",
    ]));
  });

  it("fails on a next/ import or a live clock in a nested .jsx file", () => {
    const nested = scanFixture({
      "index.js": "export const ready = true;\n",
      "ui/deep/Nested.jsx": 'import Link from "next/link";\nexport const stamp = () => new Date();\n',
    });
    expect(nested).toMatch(NEXT_IMPORT);
    expect(nested).toMatch(DATE_CONSTRUCTION);
  });

  it("covers empty, loading, success, validation, unauthorized, wrong-organization, and retry states", () => {
    expect(CALENDAR_FREEBUSY_VIEW_STATES).toEqual([
      "empty",
      "loading",
      "success",
      "validation",
      "unauthorized",
      "wrong_organization",
      "retry",
    ]);
    expect(presentLoading().state).toBe("loading");
    expect(presentRetry().state).toBe("retry");
  });
});
