import { afterEach, describe, expect, it } from "vitest";
import { declaredFor, mountStylesheets, styleRule } from "./helpers/appStylesheet.js";

// BUG-UG-COORDINATOR-SEARCH-PLACEHOLDER-CUT-MID-WORD-20261106: the
// 280 px box cut its hint ("Filter by member, title, or article") to
// "... or art" on every coordinator page. The hint measures about 252 px at
// 16 px, so the desktop box is 340 px wide, and a narrower box (phones) ends
// the hint with an ellipsis instead of half a word.
describe("coordinator header search box", () => {
  let unmount = () => {};
  afterEach(() => unmount());

  it("is wide enough on desktop for the whole hint", () => {
    unmount = mountStylesheets();
    expect(declaredFor(".gq-search")).toMatch(/width: 340px/);
    expect(declaredFor(".gq-search")).toMatch(/max-width: 100%/);
  });

  it("ends a hint that does not fit with an ellipsis and keeps 16 px text", () => {
    unmount = mountStylesheets();
    const input = declaredFor(".gq-search__input");
    expect(input).toMatch(/text-overflow: ellipsis/);
    expect(input).toMatch(/font-size: 16px/);
    expect(styleRule(".gq-search__input").minHeight).toBe("44px");
  });
});
