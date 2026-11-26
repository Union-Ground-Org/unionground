import { describe, expect, it } from "vitest";
import { unstableTestTitles, unstableTitleLines } from "./helpers/stableTestTitles.js";

// TEST-UG-MEMBERSHIP-CARD-TEST-TITLE-EMBEDS-CLOCK-20261110 (#7990): every
// test title is the same on every run of its file, so the merge-group retry
// can find a failed test again on the rerun.
describe("test titles are the same on every run", () => {
  it("names no test title built from the clock or a random value", () => {
    // This file's own examples are strings, not tests.
    const found = unstableTestTitles(["tests", "apps/mobile/src", "apps/mobile/app", "src", "scripts"], { ignore: ["tests/stable-test-titles.test.js"] });
    expect(found, "a test title prints a clock or random value: label the case instead (for example \"already past\") and compute the value inside the test").toEqual([]);
  });

  it("reports the shapes that change between runs", () => {
    expect(unstableTitleLines('it.each([null, Date.now() - 1000])("refuses %s", (value) => {});')).toEqual([1]);
    expect(unstableTitleLines('test.each([[new Date()]])("rejects $value", () => {});')).toEqual([1]);
    expect(unstableTitleLines('describe.each([Math.random()])("seed %d", () => {});')).toEqual([1]);
    expect(unstableTitleLines('it(`expires at ${Date.now()}`, () => {});')).toEqual([1]);
  });

  it("passes stable titles: the case index, a fixed time, labels and values outside the title", () => {
    expect(unstableTitleLines('it.each([Date.now()])("refuses case %#", () => {});')).toEqual([]);
    expect(unstableTitleLines('it.each([new Date(now), new Date("2026-11-10")])("rejects %s", () => {});')).toEqual([]);
    expect(unstableTitleLines('it.each([["already past", () => Date.now() - 1000]])("refuses %s", () => {});')).toEqual([]);
    expect(unstableTitleLines('it.each([{ label: "already past", at: () => Date.now() - 1000 }])("refuses $label", () => {});')).toEqual([]);
    // An arrow body ends at its own comma: a clock value after it still counts.
    expect(unstableTitleLines('it.each([[() => 0, Date.now()]])("refuses %s", () => {});')).toEqual([1]);
    expect(unstableTitleLines('it("expires", () => { expect(Date.now()).toBeGreaterThan(0); });')).toEqual([]);
  });
});
