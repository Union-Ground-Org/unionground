// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCESS_DONOR_BASELINE,
  ACCESS_DONOR_UNITS,
  ACCESS_PERSISTENCE_CONTRACT,
  ACCESS_VIEW_STATES,
  presentLoading,
} from "../src/features/accessHistory/index.js";

// Recurse into subdirectories (e.g. ui/) and include .jsx so this boundary
// check actually covers what the assertions below claim, instead of a
// non-recursive .js-only scan that silently skips the ui/ folder.
function collectImplementationFiles(dirUrl) {
  return readdirSync(dirUrl, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "provenance.js") return [];
    const entryUrl = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dirUrl);
    if (entry.isDirectory()) return collectImplementationFiles(entryUrl);
    if (!/\.jsx?$/.test(entry.name)) return [];
    return [readFileSync(entryUrl, "utf8")];
  });
}

const root = new URL("../src/features/accessHistory/", import.meta.url);
const files = collectImplementationFiles(root);
const NEXT_IMPORT = /from ["']next\//;
// No-arg `new Date()` reads the live clock; `new Date(value)` merely
// formats an already-known timestamp (e.g. ui/AccessHistory.jsx's
// occurredAt display) and is not a boundary violation.
const LIVE_CLOCK_CALL = /new Date\s*\(\s*\)/;

function scanFixture(sources) {
  const dir = mkdtempSync(join(tmpdir(), "access-history-boundary-"));
  try {
    for (const [name, source] of Object.entries(sources)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), source);
    }
    return collectImplementationFiles(pathToFileURL(`${dir}/`)).join("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("access history donor and launch boundaries", () => {
  it("records donor provenance and rejected mixed activity feeds", () => {
    expect(ACCESS_DONOR_BASELINE).toBe("donor-baseline-20260721");
    expect(ACCESS_DONOR_UNITS.every((unit) => unit.auditId === "CR-086")).toBe(true);
    expect(ACCESS_DONOR_UNITS.some((unit) => unit.rejected.includes("member-own grievance/survey/rsvp/vote/question buckets as access history"))).toBe(true);
  });

  it("does not ship Next.js, emails, or reward-log shortcuts", () => {
    const joined = files.join("\n");
    expect(joined).not.toMatch(NEXT_IMPORT);
    expect(joined).not.toContain("member_action_log");
    expect(joined).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(joined).not.toMatch(/Date\.now\s*\(/);
    expect(joined).not.toMatch(LIVE_CLOCK_CALL);
    expect(ACCESS_PERSISTENCE_CONTRACT.migration).toBe("20260828021500_mi1_member_access_history.sql");
    expect(ACCESS_PERSISTENCE_CONTRACT.rpcs).toEqual([
      "list_my_access_history",
      "record_member_access_event",
    ]);
  });

  it("fails on a next/ import or a live clock in a nested .jsx file, but not on new Date(value)", () => {
    const nested = scanFixture({
      "index.js": "export const ready = true;\n",
      "ui/deep/Nested.jsx": 'import Link from "next/link";\nexport const stamp = () => new Date();\n',
    });
    expect(nested).toMatch(NEXT_IMPORT);
    expect(nested).toMatch(LIVE_CLOCK_CALL);

    const parsing = scanFixture({ "ui/When.jsx": "export const when = (value) => new Date(value).toISOString();\n" });
    expect(parsing).toContain("new Date(value)");
    expect(parsing).not.toMatch(LIVE_CLOCK_CALL);
  });

  it("covers empty, loading, success, unauthorized, wrong-organization, retry, and MFA-required states", () => {
    expect(ACCESS_VIEW_STATES).toEqual([
      "empty",
      "loading",
      "success",
      "unauthorized",
      "wrong_organization",
      "retry",
      "mfa_required",
    ]);
    expect(presentLoading().state).toBe("loading");
  });
});
