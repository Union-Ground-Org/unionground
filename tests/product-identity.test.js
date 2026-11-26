import { describe, expect, it } from "vitest";
import {
  PRODUCT_NAME,
  WORKER_NAV_ITEMS,
  railItemsForHat,
} from "../src/lib/productIdentity.js";
import { STAFF_PLANES } from "../src/components/planes.js";
import { RIGHTS_FALLBACK } from "../src/lib/rightsFallback.js";

describe("Union Ground organizing identity", () => {
  it("names the product Union Ground", () => {
    expect(PRODUCT_NAME).toBe("Union Ground");
  });

  it("puts Organizer first among staff planes", () => {
    expect(STAFF_PLANES[0].key).toBe("organize");
    expect(STAFF_PLANES.map((plane) => plane.view)).toContain("steward");
  });

  it("keeps worker destinations on existing routes", () => {
    const paths = WORKER_NAV_ITEMS.map((item) => item.path);
    expect(paths).toEqual(["/m", "/m/work", "/m/messages", "/m/cases", "/m/rights", "/m/events", "/m/search"]);
    expect(WORKER_NAV_ITEMS.find((item) => item.key === "cases").labelKey).toBe("nav.issues");
  });

  it("gives the organizer desk campaign destinations", () => {
    const items = railItemsForHat("organize");
    expect(items.some((item) => item.path === "/m/organize")).toBe(true);
  });

  it("defaults live rights to concerted-activity language, not Weingarten", () => {
    expect(RIGHTS_FALLBACK.label).toBe("Section 7");
    expect(RIGHTS_FALLBACK.title.toLowerCase()).toContain("union");
    expect(RIGHTS_FALLBACK.script.toLowerCase()).not.toContain("union representation");
    expect(RIGHTS_FALLBACK.steps.join(" ")).toMatch(/supervisor|interrogat|signed/i);
  });
});
