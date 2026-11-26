import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// REQ-UG-HOVER-PARITY-20260801: the prototype gives every interactive
// element hover/press feedback and lifts its shadowed cards (master guide
// §6.1, Site S:212-231 + S:42-44). These pins hold the ported block to the
// shapes that keep it safe: zero-specificity fallback, the deliberate
// exclusions, reduced-motion resets AFTER the moving rules with the same
// selectors, and background-only row tints (a color alongside would demand
// a contrast-audit row the block deliberately avoids needing).

const stylesCss = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css"),
  "utf8",
);
// Whitespace-collapsed view so selector lists match regardless of wrapping.
const flat = stylesCss.replace(/\s+/g, " ");

const PRESS_SELECTOR = ':where(button:not(:disabled):not([role="switch"]):not(.kan-chip--drag)):active';
const HOVER_SELECTOR =
  ':where(button:not(:disabled):not([role="switch"]):not([aria-pressed="true"]):not(.voting-option--selected)):hover';

const LIFT_SELECTOR = [
  "button.home-row:not(:disabled):hover",
  "button.home-quorum:hover",
  "button.voting-deal:hover",
  ".mcases-closed__row:hover",
  ".learn-row:hover",
  "button.learn-article:hover",
  ".reports-card--open:hover",
  ".search-result:hover",
  ".mappt-typecard:hover",
].join(", ");

const TINT_SELECTOR = [
  ".inbox-row:hover",
  ".morehub-row--nav:hover",
  ".morehub-card-btn:hover",
  ".setin-row--nav:hover",
  ".mcases-panel__row:hover",
  ".mcases-desk__latest:hover",
  ".learn-step:hover",
  ".voting-quorum-row:hover",
  ".voting-past-row:hover",
  "button.voting-option:not(.voting-option--selected):hover",
  "button.home-event:hover",
  ".search-ask:hover",
].join(", ");

// Every `{...}` body that follows an occurrence of the selector, in order.
function bodiesFor(selector) {
  const bodies = [];
  let from = 0;
  for (;;) {
    const at = flat.indexOf(`${selector} {`, from);
    if (at === -1) return bodies;
    const open = flat.indexOf("{", at + selector.length);
    bodies.push({ at, body: flat.slice(open + 1, flat.indexOf("}", open)) });
    from = open;
  }
}

describe("universal pointer feedback", () => {
  it("presses with the prototype's exact pair, then resets under reduced motion", () => {
    const rules = bodiesFor(PRESS_SELECTOR);
    expect(rules.length).toBe(2);
    expect(rules[0].body).toContain("transform: scale(.978)");
    expect(rules[0].body).toContain("filter: brightness(.9)");
    expect(rules[1].body).toContain("transform: none");
    expect(rules[1].body).toContain("filter: none");
  });

  it("hovers at brightness(.955) only inside a hover-capable gate", () => {
    const rules = bodiesFor(HOVER_SELECTOR);
    expect(rules.length).toBe(2);
    expect(rules[0].body).toContain("filter: brightness(.955)");
    expect(rules[1].body).toContain("filter: none");
    const gateAt = flat.indexOf(
      "@media (hover: hover)",
      flat.indexOf("Pointer feedback parity"),
    );
    expect(gateAt).toBeGreaterThan(-1);
    expect(rules[0].at).toBeGreaterThan(gateAt);
  });

  it("keeps the switch, disabled, drag-chip, and pressed-pill exclusions", () => {
    expect(PRESS_SELECTOR).toContain(":not(:disabled)");
    expect(PRESS_SELECTOR).toContain(':not([role="switch"])');
    expect(PRESS_SELECTOR).toContain(":not(.kan-chip--drag)");
    expect(HOVER_SELECTOR).toContain(':not([aria-pressed="true"])');
    // Voting options mark selection by class, not aria-pressed — the
    // selected option must not read as hoverable.
    expect(HOVER_SELECTOR).toContain(":not(.voting-option--selected)");
  });
});

describe("the card lift", () => {
  it("lifts every shadowed clickable card by -2px, then resets under reduced motion", () => {
    const rules = bodiesFor(LIFT_SELECTOR);
    expect(rules.length).toBe(2);
    expect(rules[0].body).toContain("transform: translateY(-2px)");
    expect(rules[0].body).toContain("box-shadow: 0 2px 3px rgba(20, 32, 28, .05)");
    expect(rules[1].body).toContain("transform: none");
    expect(rules[1].at).toBeGreaterThan(rules[0].at);
  });

  it("keeps no lift, base, or label rule for the removed Home points ring", () => {
    // Union Ground has no points economy: the Home points ring is gone, so
    // no stylesheet rule may still target it.
    expect(flat).not.toMatch(/\.home-ring\b/);
    expect(flat).not.toMatch(/\.rewards-ring\b/);
  });

  it("element-scopes polymorphic classes and class-gates reports cards", () => {
    // home-row/home-event render as div without a handler; voting-deal and
    // learn-article share classes with static surfaces; reports-card keeps
    // cursor:pointer in edit mode but loses its full-card button.
    expect(LIFT_SELECTOR).toContain("button.home-row:not(:disabled):hover");
    expect(LIFT_SELECTOR).toContain(".reports-card--open:hover");
    expect(TINT_SELECTOR).toContain("button.home-event:hover");
    expect(TINT_SELECTOR).toContain(
      "button.voting-option:not(.voting-option--selected):hover",
    );
  });
});

describe("the row tint", () => {
  it("tints every flat row family with the canvas background and nothing else", () => {
    const rules = bodiesFor(TINT_SELECTOR);
    expect(rules.length).toBe(1);
    expect(rules[0].body).toContain("background: var(--canvas)");
    // Background-only on purpose: no color declaration may ride along.
    expect(rules[0].body).not.toMatch(/(^|[^-])color:/);
  });
});

describe("links", () => {
  it("underlines bare anchors and the two hoverless link classes on hover", () => {
    const rules = bodiesFor(
      ":where(a:not([class])):hover, a.voting-verify-link:hover, .vrx-back:hover",
    );
    expect(rules.length).toBe(1);
    expect(rules[0].body).toContain("text-decoration: underline");
  });
});
