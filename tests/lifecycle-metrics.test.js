import { describe, expect, it } from "vitest";
import {
  coveragePercent,
  netGrowth,
  safePercent,
  stageAgeDays,
  suppressSmall,
} from "../src/lib/lifecycleMetrics.js";

describe("lifecycle metrics", () => {
  it("parses both date-only and live timestamp stage dates", () => {
    const now = new Date("2026-07-23T12:00:00Z");
    expect(stageAgeDays("2026-07-20", now)).toBe(3);
    expect(stageAgeDays("2026-07-20T12:00:00Z", now)).toBe(3);
    expect(stageAgeDays("not-a-date", now)).toBeNull();
  });

  it("suppresses the numerator and complement below the privacy floor", () => {
    expect(suppressSmall(1, 29)).toMatchObject({ suppressed: true, status: "suppressed", value: null });
    expect(suppressSmall(28, 29)).toMatchObject({ suppressed: true, status: "suppressed", value: null });
    expect(suppressSmall(18, 29)).toMatchObject({ suppressed: false });
  });

  it("returns a status code, never a rendered label", () => {
    // A baked English label here reaches a Spanish-locale organizer verbatim on
    // the one string that must be unambiguous, so the module must not own it.
    // OrganizeView's RatioBar maps these codes onto its own en/es COPY table.
    expect(suppressSmall(1, 29).status).toBe("suppressed");
    expect(suppressSmall(18, 29)).not.toHaveProperty("label");
    expect(Object.values(suppressSmall(1, 29))).not.toContain("Not shown");
  });

  it("does not turn missing aggregate values into zero", () => {
    expect(coveragePercent({ contactedCount: null, eligibleEstimate: 29 })).toBeNull();
    expect(netGrowth({ joined: null, left: null })).toBeNull();
  });

  it("clamps percentages and rejects invalid denominators", () => {
    expect(safePercent(120, 100)).toBe(100);
    expect(safePercent(-2, 100)).toBe(0);
    expect(safePercent(2, 0)).toBeNull();
  });
});
