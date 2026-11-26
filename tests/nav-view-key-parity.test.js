// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Twice now the same defect has shipped: a nav item whose `key` is not the name
// of a view and which carries no `viewKey`, so the click changes the URL and
// leaves the previous view mounted. #1945 fixed the phone nav's Member support
// item; the 828c32e87 acceptance campaign then found the desktop rail's copy of
// the SAME item still broken, which is how /m/support/rights and
// /m/support/accommodations failed DISCOVERABLE_PARENT_REQUIRED at 768x1024 and
// 1440x900 while passing at 390x844.
//
// The pin is the parity itself rather than a list of expected view names: the
// two lists are the phone and desktop presentations of one navigation model, so
// a key they both carry must resolve to one view in both. That catches the next
// item added to one list and mis-keyed in the other, including keys this test
// has never heard of.
//
// Read as source text on purpose. mobileNav.js reaches into BottomNav.jsx (and
// React with it) to compose its cards, so importing the arrays would pull the
// whole rail in to check a data fact that is legible from the files.
const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// Items are single-line object literals in all three files. A `sectionId` item
// scrolls within an already-mounted view, so its key is a section anchor and
// not a view.
function itemLiterals(source) {
  const items = new Map();
  for (const [literal, key] of [...source.matchAll(/\{[^{}]*?\bkey:\s*"([a-z0-9-]+)"[^{}]*?\}/g)].map((m) => [m[0], m[1]])) {
    if (/\bsectionId:/.test(literal)) continue;
    const viewKey = literal.match(/\bviewKey:\s*"([A-Za-z0-9]+)"/)?.[1];
    // Same default as the two call sites: `const { key, viewKey = key } = item`
    // in DesktopRail.jsx, and the mobile nav's equivalent.
    items.set(key, viewKey ?? key);
  }
  return items;
}

// Rewards, appointments, forms, workload and actions are never written as
// literals in either navigation list: both splice them in from BottomNav.jsx's
// RAIL_EXTRA_ITEMS by key. A scan of the two lists alone therefore never sees
// five live destinations, and the mis-keyed item this file exists to refuse
// could ship inside any of them with every assertion below still green.
const railExtraItems = itemLiterals(
  read("../src/components/BottomNav.jsx").match(/export const RAIL_EXTRA_ITEMS = \[[\s\S]*?\n\];/)?.[0] ?? "",
);

// `RAIL_EXTRA_ITEMS.find((item) => item.key === "forms")` — the composition
// both lists use, at the top of mobileNav.js and inline in the rail's groups.
const composedKeys = (source) => [...source.matchAll(/RAIL_EXTRA_ITEMS\.find\(.*?\bkey === "([a-z0-9-]+)"/g)].map((m) => m[1]);

function navItems(source) {
  const items = itemLiterals(source);
  for (const key of composedKeys(source)) {
    // A literal written in the list itself is what that list renders; the
    // composed entry only fills a key the list does not spell out.
    if (!items.has(key) && railExtraItems.has(key)) items.set(key, railExtraItems.get(key));
  }
  return items;
}

describe("desktop rail and phone nav name the same view for the same key", () => {
  const railSource = read("../src/components/DesktopRail.jsx");
  const phoneSource = read("../src/lib/mobileNav.js");
  const rail = navItems(railSource);
  const phone = navItems(phoneSource);

  it("parsed both navigation lists", () => {
    // A regex pin that silently matched nothing would pass every assertion
    // below, so the parse itself is asserted.
    expect(rail.size).toBeGreaterThan(10);
    expect(phone.size).toBeGreaterThan(10);
    expect([...rail.keys()]).toContain("member-support");
    expect([...phone.keys()]).toContain("member-support");
  });

  it("parsed the shared rail extras both lists compose", () => {
    // If this file stops finding RAIL_EXTRA_ITEMS or the composition changes
    // shape, coverage of those five destinations would drop out in silence.
    expect([...railExtraItems.keys()]).toEqual(
      expect.arrayContaining(["rewards", "appointments", "forms", "workload", "actions"]),
    );
    expect(composedKeys(railSource).length).toBeGreaterThan(0);
    expect(composedKeys(phoneSource).length).toBeGreaterThan(0);
    for (const [name, source] of [["desktop rail", railSource], ["phone nav", phoneSource]]) {
      const missing = composedKeys(source).filter((key) => !railExtraItems.has(key));
      // A key with no entry composes to `undefined` and the list renders it.
      expect(missing, `${name} composes RAIL_EXTRA_ITEMS keys that do not exist`).toEqual([]);
      expect([...navItems(source).keys()], `${name} items missing their composed entries`)
        .toEqual(expect.arrayContaining(composedKeys(source)));
      // Every use of RAIL_EXTRA_ITEMS past the import must be a find-by-key
      // this file resolves. Any other shape (an index, a filter, a spread)
      // would drop that destination from the comparison while every other
      // assertion stayed green.
      const uses = (source.match(/\bRAIL_EXTRA_ITEMS\b/g) ?? []).length - 1;
      expect(composedKeys(source).length, `${name} uses RAIL_EXTRA_ITEMS in a shape this test cannot resolve`).toBe(uses);
    }
    // The destinations each list is known to compose today. Losing one from a
    // map fails here rather than passing on the map-size guard alone.
    expect([...rail.keys()]).toEqual(expect.arrayContaining(["rewards", "forms", "workload"]));
    expect([...phone.keys()]).toEqual(expect.arrayContaining(["rewards", "appointments", "forms", "workload"]));
  });

  it("resolves every shared key to one view", () => {
    const shared = [...rail.keys()].filter((key) => phone.has(key));
    expect(shared.length).toBeGreaterThan(5);
    expect(Object.fromEntries(shared.map((key) => [key, rail.get(key)])))
      .toEqual(Object.fromEntries(shared.map((key) => [key, phone.get(key)])));
  });

  it("never leaves a hyphenated key to stand in for a camelCase view name", () => {
    // Views are camelCase identifiers, so a hyphenated key can never be one.
    // This is the exact shape of both shipped defects and it is cheap to refuse.
    // The rail extras are included on purpose: an item composed into both lists
    // is no less able to change the URL and mount nothing.
    for (const [name, items] of [["desktop rail", rail], ["phone nav", phone], ["shared rail extras", railExtraItems]]) {
      const unnamed = [...items].filter(([key, viewKey]) => key.includes("-") && viewKey === key).map(([key]) => key);
      expect(unnamed, `${name} items whose hyphenated key is used as a view name`).toEqual([]);
    }
  });

  it("keeps the member-support item pointed at the member support view in both", () => {
    expect(rail.get("member-support")).toBe("memberSupport");
    expect(phone.get("member-support")).toBe("memberSupport");
  });
});
