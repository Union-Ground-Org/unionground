import { describe, expect, it } from "vitest";
import { plainClick } from "../src/lib/plainClick.js";

describe("plainClick", () => {
  const click = (over = {}) => ({ button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });
  it("accepts only an unmodified primary click that nothing else handled", () => {
    expect(plainClick(click())).toBe(true);
    expect(plainClick(click({ button: 1 }))).toBe(false);
    expect(plainClick(click({ defaultPrevented: true }))).toBe(false);
    for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) expect(plainClick(click({ [key]: true }))).toBe(false);
  });
});
