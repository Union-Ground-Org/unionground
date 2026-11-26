// TEST-UG-SMALL-NEW-ORGANIZATION-FIXTURE-AND-WEB-ROUTE-JOURNEYS-20261111
//: the files allowed to keep raising React's duplicate-key warning
// may only shrink. Fixing one means deleting its line and lowering CEILING.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DUPLICATE_KEY_OFFENDERS } from "./helpers/duplicateKeyOffenders.js";
import { settleDuplicateKeyWarnings } from "./helpers/duplicateKeyGate.js";

// The number of offenders when the check arrived. Lower it with each fix;
// never raise it.
const CEILING = 4;

describe("the duplicate-key offender list", () => {
  it("never grows past the count it started with", () => {
    expect(DUPLICATE_KEY_OFFENDERS.length).toBeLessThanOrEqual(CEILING);
  });

  it("names real test files once each, in order", () => {
    expect([...new Set(DUPLICATE_KEY_OFFENDERS)]).toEqual(DUPLICATE_KEY_OFFENDERS);
    expect([...DUPLICATE_KEY_OFFENDERS].sort()).toEqual(DUPLICATE_KEY_OFFENDERS);
    for (const file of DUPLICATE_KEY_OFFENDERS) expect(existsSync(file), file).toBe(true);
  });

  it("is what the browser test setup reads before it fails a test", () => {
    const setup = readFileSync("tests/helpers/browser-setup.js", "utf8");
    expect(setup).toContain('import { DUPLICATE_KEY_OFFENDERS } from "./duplicateKeyOffenders.js";');
    expect(setup).toContain("settleDuplicateKeyWarnings({");
    expect(setup).not.toMatch(/UG_DUPLICATE_KEY_REPORT\)\s*\{/);
  });
});

// Report mode must not switch the failure
// off, with CI set or not.
describe("report mode records offenders and still fails an unlisted duplicate key", () => {
  const warning = ["Encountered two children with the same key, `same`."];
  const settle = (file, reportPath) => {
    const appended = [];
    const run = () => settleDuplicateKeyWarnings({
      warnings: warning, file, testName: "renders twice", offenders: new Set(["tests/listed.test.jsx"]),
      reportPath, append: (path, line) => appended.push([path, line]),
    });
    return { run, appended };
  };

  it.each([["", "no report file"], ["/fixture/report.txt", "a report file"]])("fails an unlisted file with %s (%s)", (reportPath) => {
    const { run, appended } = settle("tests/unlisted.test.jsx", reportPath);
    expect(run).toThrow("React warned about two children with the same key in tests/unlisted.test.jsx (renders twice).");
    expect(appended).toEqual(reportPath ? [[reportPath, "tests/unlisted.test.jsx\n"]] : []);
  });

  it("lets a listed file pass and still records it in the report", () => {
    const { run, appended } = settle("tests/listed.test.jsx", "/fixture/report.txt");
    expect(run).not.toThrow();
    expect(appended).toEqual([["/fixture/report.txt", "tests/listed.test.jsx\n"]]);
  });

  it("does nothing when React raised no duplicate-key warning", () => {
    expect(() => settleDuplicateKeyWarnings({ warnings: [], file: "tests/unlisted.test.jsx", offenders: new Set(), reportPath: "/fixture/report.txt", append: () => { throw new Error("no write"); } })).not.toThrow();
  });
});
