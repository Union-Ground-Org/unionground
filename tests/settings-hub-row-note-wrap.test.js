import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountStylesheets, styleRule } from "./helpers/appStylesheet.js";

// BUG-UG-SETTINGS-HUB-ROW-LABEL-LETTER-STACK-20261106. A Settings hub
// row note that could not shrink ("Write, review, publish and schedule content
// for members.") left the label almost no width at 320 CSS px, and the label's
// overflow-wrap broke it into one letter per line. The note now shrinks and
// wraps inside at most half the row, matching the alt shell adapter.

let unmountStyles;
beforeAll(() => { unmountStyles = mountStylesheets("src/styles.css"); });
afterAll(() => unmountStyles());

describe("Settings hub row note", () => {
  it("shrinks and wraps within half the row instead of squeezing the label", () => {
    const meta = styleRule(".morehub-row__meta");
    expect(meta.getPropertyValue("flex-shrink")).toBe("1");
    expect(meta.getPropertyValue("min-width")).toBe("0px");
    expect(meta.getPropertyValue("max-width")).toBe("50%");
    expect(meta.getPropertyValue("white-space")).toBe("normal");
    expect(meta.getPropertyValue("text-align")).toBe("right");
  });

  it("keeps the label as the growing column", () => {
    const label = styleRule(".morehub-row__label");
    expect(label.getPropertyValue("flex-grow")).toBe("1");
    expect(label.getPropertyValue("min-width")).toBe("0px");
  });
});
