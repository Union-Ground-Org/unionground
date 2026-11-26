// TEST-UG-MIGRATION-ORDERING-TITLES-MISSTATE-NEWEST-MAIN-20260920
//
// Many migration suites carry an apply-order pin: `findMigrationName(x) > "<a
// frozen migration filename>"`. The frozen operand is deliberate (it is the
// composition floor the migration was written against) — but eight of those
// tests were TITLED "sorts after Main's newest migration", and the literal
// each one compared against was the newest migration on the day the file was
// written, not the newest migration on Main. By 2026-09-20 every one of them
// named a file more than a dozen migrations from the tail, so the title
// asserted a property the test had never checked and could not check: a reader
// triaging a failure was told the pin covered the whole tail when it covered
// exactly one floor.
//
// A title is only prose, so nothing in the suite could go red for it. This
// sweep is what goes red: a test may claim to pin MAIN's newest migration only
// if it derives that name from the migrations directory at run time. Comparing
// against a frozen filename is fine — it is the floor the file was written
// against — but then the title has to say so.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testsDir = dirname(fileURLToPath(import.meta.url));
const self = "migration-order-pin-titles.test.js";

const suites = readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.js") && name !== self)
  .sort()
  .map((name) => [name, readFileSync(join(testsDir, name), "utf8").replace(/\r\n/g, "\n")]);

// "Main's newest migration" and its spelling variants. Titles that name some
// other newest thing — the newest stamp on an open candidate, the newest
// reviewed version in a comparison base — are claims about their own operand,
// not about the branch, and are left alone.
const CLAIMS_MAIN_TAIL = /\bmain'?s\s+newest\b|\bnewest\s+migration\s+on\s+main\b/i;

// The helpers that read the directory tail at run time. A test that
// calls one of these can hold the claim its title makes; a frozen filename
// cannot.
const DERIVES_THE_TAIL = /\bmigration(Names|Files)\s*\(/;

/** Every `it(...)` in `source`, with the lines of its callback body. */
function testCases(name, source) {
  const lines = source.split("\n");
  const cases = [];
  for (let at = 0; at < lines.length; at += 1) {
    const opened = lines[at].match(/^(\s*)it(?:\.\w+)?\(\s*(["'`])(.*?)\2/);
    if (!opened) continue;
    const [, indent, , title] = opened;
    // The callback ends at the first line that closes the call at the `it`'s
    // own indentation. An undelimited case is reported rather than skipped:
    // silently widening the body to the rest of the file would let a dynamic
    // read in some LATER test excuse this one.
    const closer = `${indent}});`;
    let end = at + 1;
    while (end < lines.length && lines[end] !== closer) end += 1;
    cases.push({
      where: `${name}:${at + 1}`,
      title,
      delimited: end < lines.length,
      body: lines.slice(at, end).join("\n"),
    });
  }
  return cases;
}

describe("migration apply-order pins describe the ordering they actually assert", () => {
  it("found suites to sweep, including the migration-order pins", () => {
    expect(suites.length).toBeGreaterThanOrEqual(600);
    expect(suites.filter(([, source]) => source.includes("findMigrationName(")).length).toBeGreaterThanOrEqual(15);
  });

  it("lets no test claim it pins Main's newest migration while comparing against a frozen filename", () => {
    const offenders = suites
      .flatMap(([name, source]) => testCases(name, source))
      .filter(({ title }) => CLAIMS_MAIN_TAIL.test(title))
      .filter(({ body, delimited }) => !delimited || !DERIVES_THE_TAIL.test(body))
      .map(({ where, title }) => `${where}: ${title}`);
    expect(offenders).toEqual([]);
  });
});
