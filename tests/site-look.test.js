// REQ-UG-SIGNED-OUT-SITE-PINE-LOOK-COMPARED-WITH-LIGHT-20261117: the
// signed-out site's two looks are compared with nothing stored in the browser.
// The look follows the Eastern calendar day, `?look=` shows one for review, and
// a join request names the look in its campaign code.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySiteLook, joinCampaignCode, shownSiteLook } from "../src/lib/siteLook.js";

const root = () => ({ dataset: {} });
const lookAt = (iso, search = "") => applySiteLook({ root: root(), search, now: new Date(iso) });

describe("the signed-out site's look", () => {
  it("is the same for every visit on one Eastern day and alternates day by day", () => {
    // 05:00 UTC is midnight Eastern in November (standard time).
    const startOfDay = lookAt("2026-11-18T05:00:00Z");
    expect(["pine", "light"]).toContain(startOfDay);
    expect(lookAt("2026-11-18T17:30:00Z")).toBe(startOfDay);
    expect(lookAt("2026-11-19T04:59:59Z")).toBe(startOfDay);
    const nextDay = lookAt("2026-11-19T05:00:00Z");
    expect(nextDay).not.toBe(startOfDay);
    expect(lookAt("2026-11-20T05:00:00Z")).toBe(startOfDay);
  });

  it("turns over at midnight Eastern in daylight time too", () => {
    // 04:00 UTC is midnight Eastern in July.
    const before = lookAt("2027-07-10T03:59:59Z");
    const after = lookAt("2027-07-10T04:00:00Z");
    expect(after).not.toBe(before);
    expect(lookAt("2027-07-11T03:59:59Z")).toBe(after);
  });

  it("gives each look the same number of days in any two weeks", () => {
    const days = Array.from({ length: 14 }, (_, day) => lookAt(new Date(Date.UTC(2026, 10, 18 + day, 17)).toISOString()));
    expect(days.filter((look) => look === "pine")).toHaveLength(7);
    expect(days.filter((look) => look === "light")).toHaveLength(7);
  });

  it("shows the look a reviewer asks for and ignores any other value", () => {
    const day = "2026-11-18T17:00:00Z";
    expect(lookAt(day, "?look=pine")).toBe("pine");
    expect(lookAt(day, "?c=invite&look=light")).toBe("light");
    expect(lookAt(day, "?look=dark")).toBe(lookAt(day));
    expect(lookAt(day, "?look=")).toBe(lookAt(day));
  });

  it("marks the document for the stylesheets and reads the mark back", () => {
    const element = root();
    expect(applySiteLook({ root: element, search: "?look=pine", now: new Date("2026-11-18T17:00:00Z") })).toBe("pine");
    expect(element.dataset.siteLook).toBe("pine");
    expect(shownSiteLook(element)).toBe("pine");
    expect(shownSiteLook(root())).toBeNull();
    expect(shownSiteLook({ dataset: { siteLook: "dark" } })).toBeNull();
  });

  it("names the look in the site's own campaign codes and leaves outside codes alone", () => {
    expect(joinCampaignCode("", "pine")).toBe("look-pine");
    expect(joinCampaignCode("invite", "light")).toBe("invite-light");
    expect(joinCampaignCode("flyer-boston", "pine")).toBe("flyer-boston");
    // A page with no look on the document sends the code as it came.
    expect(joinCampaignCode("invite", null)).toBe("invite");
    expect(joinCampaignCode("", null)).toBe("");
    // Every code it can produce passes the request form's own code rule.
    for (const look of ["pine", "light"]) {
      expect(joinCampaignCode("", look)).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
      expect(joinCampaignCode("invite", look)).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
    }
  });

  it("writes nothing to the browser: no storage, cookie or identifier", () => {
    const source = readFileSync("src/lib/siteLook.js", "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|window\.name|crypto\.|Math\.random/);
  });

  it("is applied once at startup, before the first render", () => {
    const entry = readFileSync("src/main.jsx", "utf8");
    expect(entry.indexOf("applySiteLook();")).toBeGreaterThan(-1);
    expect(entry.indexOf("applySiteLook();")).toBeLessThan(entry.indexOf("createRoot("));
  });
});
