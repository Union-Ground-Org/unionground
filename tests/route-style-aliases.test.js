import { describe, expect, it } from "vitest";
import { splitRouteStyles } from "../scripts/lib/route-styles.mjs";

describe("route cascade aliases", () => {
  it.each([
    ["inline-size", "10px", "width", "20px"],
    ["block-size", "10px", "height", "20px"],
    // A vertical writing mode exchanges the physical axes.
    ["inline-size", "10px", "height", "20px"],
    ["block-size", "10px", "width", "20px"],
    ["min-inline-size", "10px", "min-width", "20px"],
    ["max-block-size", "10px", "max-height", "20px"],
    ["grid-gap", "1px", "gap", "2px"],
    ["grid-row-gap", "1px", "row-gap", "2px"],
    ["grid-column-gap", "1px", "column-gap", "2px"],
    ["word-wrap", "break-word", "overflow-wrap", "normal"],
    ["white-space", "normal", "text-wrap", "nowrap"],
    ["white-space", "normal", "white-space-collapse", "preserve"],
    ["columns", "2", "column-width", "20px"],
    ["page-break-before", "always", "break-before", "avoid"],
    ["page-break-after", "always", "break-after", "avoid"],
    ["page-break-inside", "auto", "break-inside", "avoid"],
    ["overflow-inline", "auto", "overflow-x", "hidden"],
    ["overflow-block", "auto", "overflow-y", "hidden"],
    ["color-adjust", "economy", "print-color-adjust", "exact"],
    ["-webkit-print-color-adjust", "economy", "color-adjust", "exact"],
  ])("retains %s against a later %s alias", (property, value, later, laterValue) => {
    for (const priority of ["", " !important"]) {
      const source = `.kan-card { ${property}: ${value}${priority}; } .outside { ${later}: ${laterValue}${priority}; }`;
      const sheets = splitRouteStyles(source, { sources: ['"kan-card outside"'] });
      expect(sheets.kan).toBe("");
      expect(sheets.critical).toContain(`${property}: ${value}${priority}`);
    }
  });
});
