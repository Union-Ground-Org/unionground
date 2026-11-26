// UX-UG-COMPASS-PANEL-POLISH-BATCH-20261122 (#9563): the website's
// Compass panel. Follow-up chips wrap inside the panel, the question box shows
// one focus ring, the placeholder fits the worn hat, a scroll cue shows when
// the starters run past the panel, a long conversation title is read in full,
// and on wide desktops the page reflows beside the open panel instead of
// sitting under it.
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { Assistant } from "../src/components/FloatingControls.jsx";

const styles = readFileSync("src/styles.css", "utf8");
const app = readFileSync("src/App.jsx", "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`(?:^|\\n)\\s*${escaped} \\{([^}]*)\\}`));
  return match ? match[1] : null;
}

describe("the question box placeholder fits the hat", () => {
  const cases = [
    ["member", "compass.placeholder"],
    ["steward", "compass.placeholderSteward"],
    ["coordinator", "compass.placeholderSteward"],
    ["advisor", "compass.placeholderSteward"],
    ["admin", "compass.placeholderAdmin"],
    ["vp", "compass.placeholderAdmin"],
  ];
  for (const lang of ["en", "es"]) {
    it.each(cases)(`%s sees its own placeholder (${lang})`, (hat, key) => {
      render(<LanguageProvider lang={lang}><Assistant hat={hat} threads={[]} onClose={vi.fn()} onSend={vi.fn()} /></LanguageProvider>);
      const box = screen.getByLabelText(t(lang, "compass.askAria"));
      expect(box).toHaveAttribute("placeholder", t(lang, key));
    });

    it(`an Admin is not asked about "your contract or rights" (${lang})`, () => {
      render(<LanguageProvider lang={lang}><Assistant hat="admin" threads={[]} onClose={vi.fn()} onSend={vi.fn()} /></LanguageProvider>);
      expect(screen.getByLabelText(t(lang, "compass.askAria"))).not.toHaveAttribute("placeholder", t(lang, "compass.placeholder"));
    });
  }

  it("has distinct, translated wording for each group", () => {
    for (const key of ["compass.placeholderSteward", "compass.placeholderAdmin"]) {
      expect(t("en", key)).not.toBe(key);
      expect(t("es", key)).not.toBe(key);
      expect(t("es", key)).not.toBe(t("en", key));
      expect(t("en", key)).not.toBe(t("en", "compass.placeholder"));
    }
  });

  it("App hands the worn hat to the panel the same way it picks the suggestions", () => {
    expect(app).toContain('hat={selectedStaffHatAuthorized ? selectedStaffHat : "member"}');
  });
});

describe("follow-up chips wrap inside the panel (Web shell and landing contract)", () => {
  it("the chip row wraps and never scrolls or fades sideways", () => {
    const chips = rule(".compass-chips");
    expect(chips).toMatch(/flex-wrap: wrap;/);
    expect(chips).not.toMatch(/nowrap|overflow-x|mask-image/);
    expect(styles).not.toContain(".compass-chips::-webkit-scrollbar");
  });

  it("a chip's own text wraps so no chip is wider than the panel", () => {
    const button = rule(".compass-chips button");
    expect(button).toMatch(/max-width: 100%;/);
    expect(button).toMatch(/white-space: normal;/);
    expect(button).not.toMatch(/white-space: nowrap/);
  });

  it("the composer's suggestions center, and a tall block scrolls down with a cue", () => {
    const composerChips = rule(".assistant .guide2-composer > .compass-chips:not(.compass-mode)");
    expect(composerChips).toMatch(/justify-content: center;/);
    expect(composerChips).toMatch(/max-height: 154px;/);
    expect(composerChips).toMatch(/overflow-y: auto;/);
    expect(composerChips).toMatch(/no-repeat local/);
    expect(composerChips).toMatch(/no-repeat scroll/);
  });
});

describe("the question box shows one focus ring", () => {
  it("the pill becomes the ring and the input drops its own outline where :has() works", () => {
    const block = styles.match(/@supports selector\(:has\(\*\)\) \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/\.assistant \.guide2-composer__row:has\(\.guide2-input:focus-visible\) \{[^}]*border-color: var\(--green\);/);
    expect(block[1]).toMatch(/\.assistant \.guide2-input:focus-visible \{ outline: none; \}/);
  });

  it("keeps the input's own ring as the fallback outside that block", () => {
    expect(rule(".assistant .guide2-input:focus-visible")).toMatch(/outline: 2px solid var\(--green\);/);
  });
});

describe("the starter questions show a scroll cue", () => {
  it("the conversation area paints a shadow at an edge that has more", () => {
    const chat = rule(".assistant > .assistant-chat");
    expect(chat).not.toBeNull();
    const all = styles.match(/(?:^|\n)\.assistant > \.assistant-chat \{([^}]*)\}/g).join("\n");
    expect(all).toMatch(/linear-gradient\(var\(--canvas\) 30%, transparent\) top \/ 100% 32px no-repeat local/);
    expect(all).toMatch(/linear-gradient\(transparent, var\(--canvas\) 70%\) bottom \/ 100% 32px no-repeat local/);
    expect(all).toMatch(/radial-gradient\(farthest-side at 50% 100%, [^)]*\), transparent\) bottom \/ 100% 12px no-repeat scroll/);
  });
});

describe("a long conversation title is read in full", () => {
  it("the title wraps instead of an ellipsis", () => {
    const title = rule(".assistant > header strong");
    expect(title).not.toMatch(/nowrap|ellipsis/);
    expect(title).toMatch(/overflow-wrap: anywhere;/);
  });

  it("the header row grows with it and the history opens under it", () => {
    expect(rule(".assistant")).toMatch(/grid-template-rows: minmax\(68px, auto\) minmax\(0,1fr\) auto;/);
    const history = rule(".assistant-history");
    expect(history).toMatch(/grid-row: 2 \/ auto;/);
    expect(history).not.toMatch(/68px/);
    expect(rule(".assistant-history > button")).not.toMatch(/nowrap|ellipsis/);
  });
});

describe("the open panel keeps the page's own buttons reachable on wide desktops", () => {
  it("the page column makes room for the panel from 1500px, and not below", () => {
    const block = styles.match(/@media \(min-width: 1500px\) \{\n  \.sg-app--compass-wide \.app-column \{ padding-right: calc\(min\(440px, 100vw - 48px\) \+ 28px\); \}\n\}/);
    expect(block).not.toBeNull();
    // Exactly one reflow rule: none inside the 1360px dock block, where the
    // column beside an open rail would be only 562px.
    expect(styles.match(/\.sg-app--compass-wide \.app-column \{/g)).toHaveLength(1);
  });
});
