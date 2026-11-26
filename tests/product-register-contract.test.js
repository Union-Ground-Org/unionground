// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

const product = readFileSync(new URL("../PRODUCT.md", import.meta.url), "utf8");

// The register's prose has to name the hats the shipped shell actually offers,
// so the hat ids come from the navigation table rather than a second list.
// Display names are the words product copy uses for those ids ("vp" is the
// President hat), and they stay explicit here: a new hat id must be given a
// display name and written into PRODUCT.md, not silently satisfied.
const HAT_DISPLAY_NAME = { steward: "Committee", coordinator: "Campaign lead", advisor: "Advisor", admin: "Admin", vp: "Campaign chair" };
// Union Ground also ships the Organizer hat, which has no staff navigation table of its own.
const HATS_SENTENCE = /Its hats are ([^.]+)\./;

describe("PRODUCT.md register", () => {
  it("names the shipped product and its sibling, never the deprecated brand", () => {
    expect(product).toContain("Union Ground");
    expect(product).toContain("Union Ground");
    expect(product).not.toMatch(/Union\s+Base/i);
  });

  // BUG-UG-FIRST-CUSTOMER-LEFTOVERS-IN-WHAT-EVERY-UNION-GETS-20261122:
  // the product serves every organization that uses it, so the register names
  // no single union as its users.
  it("describes the users without naming a single numbered local", () => {
    const users = product.slice(product.indexOf("## Users"), product.indexOf("## Product Purpose"));
    expect(users).toMatch(/Every deployment keeps its own members/);
    expect(product).not.toMatch(/\bLocal\s+\d+\b/i);
  });

  it("describes the current staff-hat count plus Worker", () => {
    expect(Object.keys(STAFF_ROLE_NAVIGATION)).toHaveLength(5);
    const listed = product.replace(/\s+/g, " ").match(HATS_SENTENCE)?.[1].split(/,\s*(?:and\s+)?/).map((name) => name.trim());
    expect(listed).toEqual(["Worker", "Organizer", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair"]);
    expect(product).not.toMatch(/Four hats/i);
  });

  it("enumerates every staff hat the shell ships alongside Worker", () => {
    for (const hat of Object.keys(STAFF_ROLE_NAVIGATION)) {
      const displayName = HAT_DISPLAY_NAME[hat];
      expect(displayName, `no display name recorded for hat "${hat}"`).toBeTruthy();
      expect(product, hat).toMatch(new RegExp(`\\b${displayName}\\b`));
    }
    expect(product).toMatch(/\bWorker\b/);
  });
});
