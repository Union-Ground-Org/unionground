import { afterEach, describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { spanishCatalogue } from "../src/lib/i18n/es.js";
import { declaredFor, mountStylesheets } from "./helpers/appStylesheet.js";

// BUG-UG-MEMBER-HOME-SEARCH-PLACEHOLDER-TRUNCATED-20261106: the
// member Home search button read "Search the local…" at 1280 and 1440 px. The
// ellipsis was part of the copy, so the hint looked cut mid-phrase at every
// width. The hint is now a whole phrase with no trailing ellipsis, short
// enough for the 220 px button: 220 minus 26 px padding, 2 px border, the
// 16 px icon and the 8 px gap leaves 168 px, about 21 characters at 13 px.
const HINT_CHARACTER_BUDGET = 21;

describe("member Home search hint", () => {
  let unmount = () => {};
  afterEach(() => unmount());

  it.each([
    ["English", catalogue.en["today.searchLocal"], "Search everything"],
    ["Spanish", spanishCatalogue.es["today.searchLocal"], "Buscar en todo"],
  ])("reads as a whole phrase in %s", (_language, hint, expected) => {
    expect(hint).toBe(expected);
    expect(hint).not.toMatch(/(…|\.\.\.)\s*$/);
    expect(hint.length).toBeLessThanOrEqual(HINT_CHARACTER_BUDGET);
  });

  it("keeps the button at the width the budget assumes", () => {
    unmount = mountStylesheets();
    const button = declaredFor(".home-search");
    expect(button).toMatch(/width: 220px/);
    expect(button).toMatch(/font-size: 13px/);
    expect(button).not.toMatch(/overflow: hidden/);
  });
});
