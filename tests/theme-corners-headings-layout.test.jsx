// UX-UG-THEME-CORNERS-HEADINGS-AND-LAYOUT-GAPS-FROM-NOV-15-SWEEPS-20261117
// (#9052): card and control corners, page headings and five layout gaps follow
// the Union Ground theme. The values are the promo package's
// kit/brand/theme/tokens.json (radius.card 16px, radius.control 10px,
// color.line #deddd7, color.line-strong #4f5a54, color.ink #14201c, Archivo 800
// headings), carried by the shared tokens in src/sg-tokens.css. One test per
// component or page changed.
import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";


const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const tokens = read("src/sg-tokens.css");
const styles = read("src/styles.css");
const motion = read("src/motion.css");

function token(name) {
  const match = tokens.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m"));
  return match?.[1].trim();
}

// The declarations of the one rule whose selector list starts with `selector`.
function rule(css, selector) {
  const start = css.indexOf(`\n${selector}`);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

describe("shared tokens carry the theme's corners and control edge", () => {
  it("sets cards to 16px, controls to 10px and the strong edge to line-strong", () => {
    expect(token("--sg-corner-card")).toBe("16px");
    expect(token("--sg-radius-card")).toBe("16px");
    expect(token("--sg-corner-control")).toBe("10px");
    expect(token("--sg-color-border-strong")).toBe("#4f5a54");
    // The public scope's copies agree, so no page gets two corner sizes.
    expect(token("--sg-theme-corner-card")).toBe(token("--sg-corner-card"));
    expect(token("--sg-theme-corner-control")).toBe(token("--sg-corner-control"));
  });
});

describe("form cards (sign in, /join, /request-invite, /contribute, /get-app)", () => {
  it("gives every shared form control the control corner, never a 12px constant", () => {
    const shared = rule(styles, ".auth-card input, .stack-form input");
    expect(shared).toContain("border-radius: var(--sg-corner-control)");
    expect(shared).toContain("border: 1px solid var(--border)");
    for (const selector of [".rqi-form input,\n.rqi-form textarea {", ".rqi-form select {"]) {
      expect(rule(styles, selector)).toContain("border-radius: var(--sg-corner-control)");
    }
  });

  it("draws the form card's edge in the theme's line, not a translucent ink", () => {
    expect(motion).toMatch(/\n\.auth-card \{ border: 1px solid var\(--sg-light-line\); \}/);
    const elevation = rule(motion, ".stat-card, .case-card, .rights-card,");
    expect(motion.slice(motion.indexOf(".stat-card, .case-card"), motion.indexOf(elevation))).not.toContain(".auth-card");
  });

});

describe("signed-in cards take the shared card corner", () => {
  it.each([".cwk-panel {", ".hub2-card {", ".inbox-detail {", ".pkpi {"])("%s", (selector) => {
    const body = rule(styles, selector);
    expect(body).toContain("border-radius: var(--sg-corner-card)");
    expect(body).not.toMatch(/border-radius:\s*(18|20)px/);
  });

  it("the split inbox's list panel takes the card corner", () => {
    expect(rule(styles, ".inbox-screen--split .inbox-panel {")).toContain("border-radius: var(--sg-corner-card)");
  });

  it("the caseload's filter controls take the control corner, the get-app list its tile corner", () => {
    expect(rule(styles, ".case-list__control {")).toContain("border-radius: var(--sg-corner-control)");
    expect(rule(styles, ".gapp-item {")).toContain("border-radius: var(--sg-corner-tile)");
    expect(token("--sg-corner-tile")).toBe("10px");
  });

  it("the organization map's cards read the card token, now 16px", () => {
    const css = read("src/features/organizationIntelligence/organization-intelligence.css");
    expect(rule(css, ".oi-card, .oi-action-card {")).toContain("border-radius: var(--sg-radius-card)");
  });
});

describe("page headings are Archivo 800 in ink", () => {
  it("Messages and Organize drop weight 900", () => {
    for (const selector of [".inbox-title {", ".hub2-ph__title {"]) {
      const body = rule(styles, selector);
      expect(body).toContain("font-weight: var(--sg-font-weight-extrabold)");
      expect(body).not.toContain("font-weight: 900");
    }
    expect(token("--sg-font-weight-extrabold")).toBe("800");
  });

  it("the organization map's hero heading is ink at 800, not forest at 700", () => {
    const css = read("src/features/organizationIntelligence/organization-intelligence.css");
    const body = rule(css, ".oi-hero h1 {");
    expect(body).toContain("color: var(--ink, var(--sg-light-ink))");
    expect(body).toContain("font-weight: var(--sg-font-weight-extrabold)");
    expect(body).not.toContain("--sg-color-forest");
  });

  it("the Automations heading is Archivo 800 in ink, not Public Sans", () => {
    const body = rule(read("src/features/automation/automationPages.css"), ".automation-pages__masthead h1 {");
    expect(body).toContain("font-family: var(--sg-font-family-display)");
    expect(body).toContain("font-weight: var(--sg-font-weight-extrabold)");
    expect(body).toContain("color: var(--ink)");
  });
});

describe("the desktop rail's scrolled top row", () => {
  it("fades under the chapter card inside the list's top padding, with no animation", () => {
    const list = rule(styles, ".desktop-rail__items:not(.desktop-rail__items--foot) {");
    expect(list).toContain("padding-top: 10px;");
    const fade = rule(styles, ".desktop-rail__items:not(.desktop-rail__items--foot)::before {");
    expect(fade).toContain("position: sticky; top: 0;");
    expect(fade).toContain("height: 10px; margin-top: -10px;");
    expect(fade).toContain("pointer-events: none;");
    expect(fade).not.toContain("animation");
    // A scroll-driven animation never finishes while the list is unscrolled,
    // which held the assurance smoke's page-settled wait (CI run 44196152997).
    expect(styles).not.toMatch(/animation-timeline|scroll-timeline|rail-items-top-fade/);
  });
});
