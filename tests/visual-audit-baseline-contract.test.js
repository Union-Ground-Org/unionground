import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VISUAL_RULES, applyVisualBaseline } from "../scripts/visual-audit.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(readFileSync(join(repositoryRoot, "config/visual-audit-baseline.json"), "utf8"));

// The companion-phone preview was removed from every web surface by
// REQ-UNION-GROUND-DEMO-DESK-SHELL-20260820, so no accepted visual debt may
// still be recorded against it.
const RETIRED_COMPANION_PHONE = /companion-phone|phone-frame/;

describe("config/visual-audit-baseline.json", () => {
  it("is a well-formed canonical baseline document", () => {
    expect(Array.isArray(baseline)).toBe(true);
    for (const entry of baseline) {
      expect(Object.values(VISUAL_RULES)).toContain(entry.rule);
      expect(entry.route.startsWith("/")).toBe(true);
      expect(Number.isFinite(entry.viewport?.width)).toBe(true);
      expect(Number.isFinite(entry.viewport?.height)).toBe(true);
      expect(entry.selectors).toContain(entry.selector);
      expect(entry.maxOccurrences).toBeGreaterThan(0);
      expect(entry.maxSeverity).toBeGreaterThanOrEqual(0);
    }

    // createVisualBaseline emits one entry per identity, sorted by that identity.
    const identities = baseline.map(({ maxOccurrences, maxSeverity, ...identity }) => JSON.stringify(identity));
    expect(new Set(identities).size).toBe(identities.length);
    expect(identities).toEqual([...identities].sort((left, right) => left.localeCompare(right)));
  });

  it("records no accepted debt on the retired companion-phone surface", () => {
    expect(baseline.filter((entry) => RETIRED_COMPANION_PHONE.test(JSON.stringify(entry)))).toEqual([]);
  });

  it("no longer waives a companion-phone obstruction of the Kanban header", () => {
    const reviewed = applyVisualBaseline({
      failures: [{
        rule: VISUAL_RULES.FIXED_OBSTRUCTION,
        route: "/m/tasks",
        viewport: { width: 1360, height: 900 },
        selector: "div.phone-frame > div.phone-frame__screen > div.phone-frame__viewport > iframe.companion-phone__app",
        selectors: [
          "div.phone-frame > div.phone-frame__screen > div.phone-frame__viewport > iframe.companion-phone__app",
          "div.kan-viewstage > section.kan-board > div.kan-col > header.kan-ws-head",
        ],
        obstruction: "div.kan-viewstage > section.kan-board > div.kan-col > header.kan-ws-head",
        intersectionRect: { left: 0, top: 0, right: 120, bottom: 120, width: 120, height: 120 },
      }],
      warnings: [],
    }, baseline);

    expect(reviewed.warnings).toEqual([]);
    expect(reviewed.failures).toHaveLength(1);
  });
});
