import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { stripComments } from "../scripts/lib/css-vars.mjs";

const escapeRegExp = (value) => String(value).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");

// Finding E2 of the design review, and the reason it needed a test rather than
// a sweep: it had already been "reported fixed" by an earlier pass and was
// still live in 65 rules. Sizes drift back one declaration at a time, each one
// locally defensible — a badge here, a timestamp there — and nothing in the
// repo could tell the difference between a sheet that had been swept and one
// that had been swept and then re-crept.
//
// The floor: nothing READABLE renders below 11px. Dates, names, references,
// counts, statuses and sources are what live in this size band, and they are
// exactly the content a member quotes back to a steward.
//
// Deliberately a text-level assertion over the sheets, not a rendered check.
// A rendered check needs a browser and a viewport and would only cover the
// rules that happen to be on screen; the property here is about every
// declaration in every stylesheet under src, including the ones behind media
// queries that a desktop test run never enters. Feature, component, theme, and
// membership-card rules do not live in src/styles.css, so a scan of that one
// file cannot see them.
//
// px is already pixels. rem and em are resolved at 16px — the browser default
// root size this product does not override — and checked against the same
// floor. A unitless 0 is not a length in that sense; the zero assertion owns it.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const FLOOR_PX = 11;
const ROOT_FONT_PX = 16;
const MIN_STYLESHEET_COUNT = 15;

function filesUnder(dir, ext, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesUnder(join(dir, entry.name), ext, rel);
    return entry.name.endsWith(ext) ? [rel] : [];
  });
}

function readSheet(rel) {
  return stripComments(readFileSync(join(srcDir, rel), "utf8").replace(/\r\n/g, "\n"));
}

const stylesheets = filesUnder(srcDir, ".css")
  .sort()
  .map((rel) => ({ rel: `src/${rel}`, css: readSheet(rel) }));

const stylesCss = stylesheets.find((sheet) => sheet.rel === "src/styles.css")?.css;
if (typeof stylesCss !== "string") {
  throw new Error("src/styles.css was not included in the stylesheet scan");
}

function zeroFontSizeDeclarations(css) {
  return [...css.matchAll(/font-size\s*:\s*([+.-]?[0-9]*\.?[0-9]+)([a-z%]*)\s*(?=;|})/gi)]
    .filter(([, number]) => Number.parseFloat(number) === 0)
    .map(([declaration]) => declaration.trim());
}

function literalFontSizes(css) {
  return [...css.matchAll(/font-size\s*:\s*([+-]?(?:\d+\.?\d*|\.\d+))(px|rem|em)\b/gi)];
}

function pixelsFor(rawNumber, unit) {
  const value = Number.parseFloat(rawNumber);
  const normalized = unit.toLowerCase();
  if (normalized === "px") return value;
  if (normalized === "rem" || normalized === "em") return value * ROOT_FONT_PX;
  return null;
}

function declarationText(match) {
  return match[0].replace(/\s+/g, " ").trim();
}

function floorOffenders(sheets) {
  const offenders = [];
  for (const sheet of sheets) {
    for (const match of literalFontSizes(sheet.css)) {
      const pixels = pixelsFor(match[1], match[2]);
      if (pixels != null && pixels < FLOOR_PX) {
        offenders.push(`${sheet.rel}:${declarationText(match)}`);
      }
    }
  }
  return offenders;
}

function zeroOffenders(sheets) {
  return sheets.flatMap((sheet) => zeroFontSizeDeclarations(sheet.css).map((declaration) => {
    const text = declaration.replace(/\s+/g, " ").trim();
    return `${sheet.rel}:${text}`;
  })).sort();
}

/**
 * NO `font-size: 0` anywhere, as of the phase-2 calendar rebuild.
 *
 * The one historic exception (`.calendar-task > span`) collapsed the old
 * calendar chip to its icon under 720px. The rebuilt calendar hides its
 * narrow-width text with `display: none` instead — absence stated as
 * absence — so the exemption list is empty, and the next rule reaching for
 * `font-size: 0` has to come argue here rather than ride an old excuse.
 */

describe("the 11px readability floor", () => {
  it("scans every stylesheet under src", () => {
    const rels = stylesheets.map((sheet) => sheet.rel);
    expect(rels.length).toBeGreaterThanOrEqual(MIN_STYLESHEET_COUNT);
    expect(stylesheets.every((sheet) => sheet.css.length > 0)).toBe(true);
    expect(rels).toContain("src/styles.css");
    expect(rels.some((rel) => rel.startsWith("src/features/"))).toBe(true);
    expect(rels.some((rel) => rel.startsWith("src/components/"))).toBe(true);
  });

  it("declares no font-size below the floor", () => {
    const offenders = floorOffenders(stylesheets);
    expect(
      offenders,
      `nothing readable renders below ${FLOOR_PX}px. This band held 65 rules — ` +
        "badges, timestamps, case references, source citations, the whole " +
        "timeline header — and every one of them carries meaning a member acts " +
        "on. If a new rule genuinely needs to be smaller, it is hiding text " +
        "rather than shrinking it, and it belongs in the exemption below with " +
        "an argument.",
    ).toEqual([]);
  });

  it("allows no `font-size: 0` at all", () => {
    expect(zeroOffenders(stylesheets)).toEqual([]);
  });

  it("rejects a sub-floor px or rem size in a feature or component stylesheet", () => {
    const feature = {
      rel: "src/features/dues/dues.css",
      css: ".dues-meta { font-size: 9px; } .dues-note { font-size: 0.5rem; } .dues-ok { font-size: .75rem; font-size: 11px; }",
    };
    const component = {
      rel: "src/components/workspacePages.css",
      css: ".page-meta { font-size:\n  10px; } .page-title { font-size: 0.6875rem; } .page-em { font-size: 0.6em; }",
    };
    expect(floorOffenders([feature, component])).toEqual([
      "src/features/dues/dues.css:font-size: 9px",
      "src/features/dues/dues.css:font-size: 0.5rem",
      "src/components/workspacePages.css:font-size: 10px",
      "src/components/workspacePages.css:font-size: 0.6em",
    ]);
  });

  it("leaves unitless zero to the zero-font-size check", () => {
    const sheet = {
      rel: "src/features/memberSupport/member-support.css",
      css: ".one { font-size: 0 } .two { font-size: 0px; } .three { font-size: 12px; }",
    };
    expect(floorOffenders([sheet])).toEqual([
      "src/features/memberSupport/member-support.css:font-size: 0px",
    ]);
    expect(zeroOffenders([sheet])).toEqual([
      "src/features/memberSupport/member-support.css:font-size: 0",
      "src/features/memberSupport/member-support.css:font-size: 0px",
    ]);
  });

  it("recognizes multiline and unitless zero declarations", () => {
    expect(zeroFontSizeDeclarations(`
      .one {
        font-size:
          0;
      }
      .two { font-size: 0.0 }
      .three { font-size: 0px; }
      .safe { font-size: 11px; }
    `)).toHaveLength(3);
  });

  it("read a sheet with sizes in it", () => {
    // The floor assertion is vacuous over a sheet the reader failed to load, or
    // over one whose declarations it can no longer parse. 300+ font-size
    // declarations exist today.
    expect(
      [...stylesCss.matchAll(/font-size:/g)].length,
      "the size reader returned almost nothing",
    ).toBeGreaterThanOrEqual(200);
  });
});

describe("the controls the sweep resized are real targets", () => {
  // Two rules were structural rather than typographic and are pinned by name,
  // because a size that goes back is invisible next to sixty that did not.
  const rule = (selector) => {
    const found = stylesCss.match(new RegExp(`(?:^|})\\s*${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`));
    expect(found, `${selector} rule not found`).not.toBeNull();
    return found[1];
  };

  it("gives the timeline date-shift buttons a 44px target", () => {
    // They are the ONLY way to move a task's dates without opening the editor,
    // so they are a primary control — and they were 30x30 in a product whose
    // own floor is 44px everywhere else.
    expect(rule(".timeline-row__shift button")).toContain("width: 44px; height: 44px");
    expect(rule(".sg-app--desktop .tasks-screen--desktop-work .kan-timeline__shift button"))
      .toMatch(/width:\s*44px;\s*height:\s*44px/);
    expect(rule(".sg-app--desktop .tasks-screen--desktop-work .kan-timeline__bar"))
      .toMatch(/min-width:\s*44px;[\s\S]*min-height:\s*44px/);
  });

  it("gives every Green desktop Calendar date its own 44px add target", () => {
    expect(rule(".sg-app--desktop .tasks-screen--desktop-work .kan-cal--desktop-work .kan-cal__add-date"))
      .toMatch(/width:\s*44px;[\s\S]*height:\s*44px/);
  });

  it("gives the lesson and script chips a 44px target", () => {
    // Wave 2b renamed RightsView's anatomy (.lesson-tabs/.script-card became
    // learn-*), but the property is the same: the chips a member taps
    // repeatedly — the walkthrough step toggles, the guide rows, and the
    // say-this card's copy button — never shrink below the 44px floor.
    const minTarget = (selector) => {
      const found = rule(selector).match(/min-height:\s*([0-9.]+)px/);
      expect(found, `${selector} declares no min-height`).not.toBeNull();
      return Number.parseFloat(found[1]);
    };
    expect(minTarget(".learn-step")).toBeGreaterThanOrEqual(44);
    expect(minTarget(".learn-row")).toBeGreaterThanOrEqual(44);
    expect(minTarget(".learn-say__copy")).toBeGreaterThanOrEqual(44);
  });

  it("stacks the steward request action when the paired desktop narrows its guide rail", () => {
    const nestedRule = (selector) => {
      const found = stylesCss.match(new RegExp(`\\s${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`));
      expect(found, `${selector} nested rule not found`).not.toBeNull();
      return found[1];
    };
    expect(rule(".sg-app--desktop .learn-rail")).toContain("container-type: inline-size");
    expect(stylesCss).toContain("@container (max-width: 280px)");
    expect(nestedRule(".sg-app--desktop .learn-rail .learn-steward")).toContain("grid-template-columns: 38px minmax(0, 1fr)");
    expect(nestedRule(".sg-app--desktop .learn-rail .learn-request-btn")).toContain("grid-column: 2");
    expect(nestedRule(".sg-app--desktop .learn-rail .learn-request-btn")).toContain("width: 100%");
  });

  it("stacks the Messages workflow choices when their inbox container is narrow", () => {
    expect(rule(".message-workflow-onboarding")).toMatch(/container-name:\s*message-workflow-onboarding/);
    expect(rule(".message-workflow-onboarding")).toMatch(/container-type:\s*inline-size/);
    expect(stylesCss).toContain("@container message-workflow-onboarding (max-width: 600px)");
    expect(stylesCss).toMatch(/@container message-workflow-onboarding \(max-width: 600px\)\s*\{[\s\S]*?\.message-workflow-picker\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(rule(".message-workflow-option__copy")).toContain("overflow-wrap: anywhere");
  });

  it("gives the task card's status select a 44px target", () => {
    expect(rule(".task-card__move select")).toContain("height: 44px");
  });

  it("keeps form resume and start actions at the mobile target floor", () => {
    expect(rule(".mforms-btn")).toContain("min-height: 44px");
  });

  it("keeps workload increment and decrement actions at the mobile target floor", () => {
    expect(rule(".mwl-stepbtn")).toContain("width: 44px; height: 44px");
  });

  it("keeps messaging section actions at the mobile target floor", () => {
    expect(rule(".inbox-sect__action")).toContain("min-height: 44px");
    expect(rule(".inbox-showall")).toContain("min-height: 44px");
  });

  it("keeps integrated reports, events, and rail actions at the target floor", () => {
    expect(rule(".reports-customize")).toContain("min-height: 44px");
    expect(rule(".home-event")).toContain("min-height: 44px");
    expect(rule(".mevents-btn")).toContain("min-height: 44px");
    expect(rule(".mevents-row__more")).toContain("width: 44px; height: 44px");
    expect(rule(".desktop-rail__items a, .desktop-rail__items button")).toContain("min-height: 44px");
    expect(rule(".desktop-rail__bell")).toContain("width: 44px; height: 44px");
    expect(rule(".desktop-rail__hat-option")).toContain("min-height: 44px");
    expect(rule(".desktop-rail__hat-menu-trigger")).toContain("width: 44px; height: 44px");
    expect(rule(".desktop-rail__hat-menuitem")).toContain("min-height: 44px");
    expect(rule(".desktop-rail__collapse")).toContain("min-height: 44px");
    expect(rule(".mcases-desk__latest")).toContain("min-height: 44px");
  });

  it("stacks the expanded hat switcher without shrinking its targets", () => {
    expect(rule(".desktop-rail__hat-options")).toContain("flex-direction: column");
    expect(rule(".desktop-rail__hat-option")).toContain("min-height: 44px");
    expect(rule(".desktop-rail__hat-option")).toContain("font-size: 12.5px");
  });

  it("keeps desktop demo controls and adjacent task-card actions disjoint", () => {
    expect(rule(".demo-hat-selector__trigger")).toContain("min-height: 44px");
    expect(rule(".demo-hat-selector__option")).toContain("min-height: 44px");
    expect(rule(".demo-bar__guide")).toContain("min-height: 44px");
    expect(rule(".kan-search input")).toContain("min-height: 44px");
    expect(rule(".kan-search input:focus-visible")).toContain("outline: 2px solid var(--ring)");
    expect(rule(".kan-card__circle")).toContain("margin: -11px 0 -10px -11px");
  });
});
