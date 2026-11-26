import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// UB-UG-STAFF-DESK-STAT-CARDS-THREE-TREATMENTS-20261108: Steward and
// Advisor drew sentence-case tiles with a left edge, Coordinator's theme
// restyled the same tile as monospace caps with a top edge, and President
// used the member StatCard with letterspaced caps and no edge. Every staff
// desk now draws its headline numbers with PlaneKpi, and no stylesheet
// restyles that tile under a desk's own screen class.
const root = join(import.meta.dirname, "..");
const STAFF_DESKS = ["StewardView", "CoordinatorView", "AdvisorView", "AdminView", "VpView"];

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

describe("staff desk stat tiles", () => {
  it.each(STAFF_DESKS)("%s draws its headline numbers with the shared PlaneKpi tile", (view) => {
    const source = readFileSync(join(root, "src/views", `${view}.jsx`), "utf8");
    expect(source).toMatch(/<PlaneKpi\b/);
    expect(source).not.toMatch(/<StatCard\b/);
  });

  it("no desk screen restyles the shared tile", () => {
    const scoped = [];
    for (const file of cssFiles(join(root, "src"))) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of css.matchAll(/([^{}]+)\{/g)) {
        for (const selector of match[1].split(",").map((part) => part.trim())) {
          const compounds = selector.split(/\s*[\s>+~]\s*/).filter(Boolean);
          const tile = compounds.at(-1) ?? "";
          // A tile's own tone scoping its parts (.pkpi--gold .pkpi__sub) is
          // the tile itself; .ugalt .ug-legacy is the alternate shell's
          // adapter, which repaints the same left edge in its own tokens.
          const scopedByOther = compounds.slice(0, -1).some((part) => !part.startsWith(".pkpi"));
          if (/\.pkpi(?![-\w])|\.pkpi(__|--)/.test(tile) && scopedByOther && !selector.includes(".ug-legacy")) {
            scoped.push(`${relative(root, file)}: ${selector}`);
          }
        }
      }
    }
    expect(scoped).toEqual([]);
  });
});
