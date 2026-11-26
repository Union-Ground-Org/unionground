import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { stripComments } from "../scripts/lib/css-vars.mjs";

// The desktop shell is a JS decision, not a CSS one: App.jsx mounts the rail on
// matchMedia("(min-width: 1024px)"), TasksView mounts the four-column board on
// the same query, and styles.css enters/leaves the same band with min-width
// 1024px / max-width 1023px rules. Nothing ties the three files together except
// the literal itself, so a "small" edit to any one of them silently forks the
// breakpoint: two navs in the DOM, a board with no columns, or a demo bar over
// a phone shell. Same story for the 1360px companion gate (JS mount gate in
// App.jsx + CSS bezel hide + compass-wide reflow).
//
// Deliberately a text-level pin, like density-floor next door: a rendered check
// only sees whichever side of the breakpoint the test viewport is on.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

const DESKTOP_SHELL_MIN = 1024;
const TABLET_SHELL_MIN = 768;
const TABLET_SHELL_MAX = 1023;
const COMPANION_MIN = 1360;

const appJsx = read("src/App.jsx");
const tasksJsx = read("src/views/TasksView.jsx");
const stylesCss = stripComments(read("src/styles.css"));

const jsGate = (px) => new RegExp(`window\\.matchMedia\\("\\(min-width: ${px}px\\)"\\)`, "g");
const tabletJsGate = new RegExp(`window\\.matchMedia\\("\\(min-width: ${TABLET_SHELL_MIN}px\\) and \\(max-width: ${TABLET_SHELL_MAX}px\\)"\\)`, "g");
const count = (text, re) => [...text.matchAll(re)].length;

describe("the exclusive 768–1023px tablet-shell threshold", () => {
  it("App.jsx reads the tablet gate twice (initial answer + subscription)", () => {
    expect(count(appJsx, tabletJsGate)).toBe(2);
  });

  it("styles.css carries one matching tablet band with the 220px rail contract", () => {
    expect(count(stylesCss, /@media \(min-width: 768px\) and \(max-width: 1023px\)/g)).toBe(1);
    expect(stylesCss).toMatch(/\.sg-app--tablet\s*\{[^}]*--shell-rail-width:\s*220px/);
    expect(stylesCss).toMatch(/\.sg-app--tablet\s*\{[^}]*display:\s*flex/);
    expect(stylesCss).toMatch(/\.sg-app--tablet \.desktop-rail\s*\{[^}]*flex-basis:\s*220px/);
    expect(stylesCss).toMatch(/\.sg-app--tablet \.sg-shell-body\s*\{[^}]*min-width:\s*0/);
    expect(stylesCss).toMatch(/\.sg-app--tablet :is\(button, input:not\(\[type="checkbox"\]\), select, summary\)\s*\{[^}]*min-height:\s*44px/);
    expect(stylesCss).toMatch(/\.sg-app--tablet button\s*\{[^}]*min-width:\s*44px/);
    expect(stylesCss).toMatch(/\.sg-app--tablet \.assistant\s*\{[^}]*bottom:\s*var\(--keyboard-inset,\s*0px\)/);
    expect(stylesCss).toMatch(/\.sg-app--tablet \.assistant\s*\{[^}]*max-height:\s*calc\(100dvh - var\(--keyboard-inset,\s*0px\) - env\(safe-area-inset-top,\s*0px\)\)/);
    expect(stylesCss).toMatch(/\.sg-app--tablet \.assistant\s*\{[^}]*width:\s*min\(440px,/);
  });

  it("folds every staff-plane split before the tablet rail can crush it", () => {
    expect(stylesCss).toMatch(/\.sg-app--desktop \.gq-grid,\s*\.sg-app--tablet \.gq-grid,/);
    expect(stylesCss).toMatch(/\.sg-app--desktop \.cwk-grid,\s*\.sg-app--tablet \.cwk-grid,/);
    expect(stylesCss).toMatch(/\.sg-app--desktop \.ach-split,\s*\.sg-app--tablet \.ach-split\s*\{\s*grid-template-columns:\s*1fr/);
  });
});

describe("the 1024px desktop-shell threshold", () => {
  it("App.jsx reads the wideScreen gate twice (initial answer + subscription), both at the literal", () => {
    expect(count(appJsx, jsGate(DESKTOP_SHELL_MIN))).toBe(2);
  });

  it("TasksView.jsx reads the same gate twice for the wide board", () => {
    expect(count(tasksJsx, jsGate(DESKTOP_SHELL_MIN))).toBe(2);
  });

  it("styles.css switches bands at the same pixel, complementarily", () => {
    // The assistant dock and the four-column task board enter at 1024…
    expect(count(stylesCss, /@media \(min-width: 1024px\)/g)).toBe(2);
    // …and the demo-bar hide + phone gutters leave at 1023, never 1024, so no
    // 1px dead band or double band can open between the two sides.
    expect(count(stylesCss, /@media \(max-width: 1023px\)/g)).toBe(1);
  });

  it("pins the top-level desktop rail to the Green guide's semantic 248px and 72px modes", () => {
    expect(stylesCss).toMatch(/--desktop-rail-expanded-width:\s*248px/);
    expect(stylesCss).toMatch(/\.desktop-rail\s*\{[^}]*width:\s*var\(--desktop-rail-expanded-width\);[^}]*min-width:\s*0;[^}]*flex:\s*0 0 var\(--desktop-rail-expanded-width\)/);
    expect(stylesCss).toMatch(
      /\.desktop-rail\[data-render-mode="desktop"\]\[data-collapsed="true"\]\s*\{[^}]*flex-basis:\s*72px/,
    );
  });

  it("preserves tablet rhythm while centering expanded rows with optional metadata", () => {
    expect(stylesCss).toMatch(
      /\.desktop-rail__items a,\s*\.desktop-rail__items button\s*\{[^}]*gap:\s*12px/,
    );
    expect(stylesCss).toMatch(
      /\.sg-app--tablet \.desktop-rail__items a,\s*\.sg-app--tablet \.desktop-rail__items button\s*\{[^}]*gap:\s*8px/,
    );
    expect(stylesCss).toMatch(
      /\.desktop-rail\[data-render-mode="desktop"\]\[data-collapsed="false"\] \.desktop-rail__items :is\(a, button\)\s*\{[^}]*align-content:\s*center;[^}]*column-gap:\s*7px;[^}]*row-gap:\s*0/,
    );
    expect(stylesCss).toMatch(
      /\.desktop-rail\[data-render-mode="desktop"\]\[data-collapsed="false"\] \.desktop-rail__items \.desktop-rail__shortcut\s*\{[^}]*margin:\s*3px 0 0/,
    );
  });

  it("expands chapter copy only when the desk reaches the supported 1280px catalog width", () => {
    expect(stylesCss).toMatch(/--chapter-rail-expanded-width:\s*184px/);
    expect(stylesCss).toMatch(
      /@media \(min-width: 1280px\)\s*\{\s*\.sg-app--desktop\s*\{\s*--chapter-rail-expanded-width:\s*272px/,
    );
  });

  it("sizes all eight Work tabs from the measured toolbar box without viewport units or containment", () => {
    expect(stylesCss).not.toMatch(/\.tasks-screen--desktop-work \.kan-topbar\s*\{[^}]*container-type/);
    expect(tasksJsx).toMatch(/new globalThis\.ResizeObserver\(measure\)/);
    expect(tasksJsx).toContain('desktopWorkViewWidth(topbar.clientWidth - horizontalPadding)');
    expect(tasksJsx).toContain('measureLabel?.scrollWidth');
    expect(tasksJsx).toContain('allocatedWidth: button.getBoundingClientRect().width');
    expect(tasksJsx).toContain('desktopWorkViewLabelsFit(labelMeasurements, viewIds.length)');
    expect(tasksJsx).toContain('data-labels-visible={desktopShell ? String(desktopViewLabelsVisible) : undefined}');
    expect(tasksJsx).not.toMatch(/--kan-view-width[\s\S]{0,240}100(?:cqw|vw)/);
  });

  it("makes an overflowing chapter rail scrollable at short desktop heights", () => {
    expect(stylesCss).toMatch(
      /@media \(max-height: 600px\) and \(min-width: 1024px\)\s*\{\s*\.chapter-rail\[data-collapsed="false"\]\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain/,
    );
    expect(stylesCss).toMatch(/\.chapter-rail__list\s*\{[^}]*flex:\s*0 0 auto;[^}]*overflow:\s*visible/);
    expect(stylesCss).toMatch(/\.desktop-rail\[data-render-mode="desktop"\]\[data-collapsed="false"\]\s*\{[^}]*scroll-padding-block:\s*2px/);
    expect(stylesCss).toMatch(/\.desktop-rail\[data-render-mode="desktop"\]\[data-collapsed="false"\]\s*:is\(a, button\)\s*\{[^}]*scroll-margin-block:\s*2px/);
  });

  it("no other width literal is queried from JS anywhere near the gates", () => {
    const widths = [...(appJsx + tasksJsx).matchAll(/matchMedia\("\((?:min|max)-width: (\d+)px\)"\)/g)]
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    // The exclusive compound tablet query is pinned above. This sweep matches
    // only one-clause media queries and ensures desktop/companion literals do
    // not drift while the new band is added beside them.
    expect(widths).toEqual([1024, 1024, 1024, 1024]);
  });
});

describe("hat-refusal toast stays out of the rail", () => {
  // Non-overlap is guaranteed by the centering formula, not by any number
  // typed here: recomputing rectangles from viewport/rail/toast constants
  // declared in this file would assert arithmetic on those constants and stay
  // green through a real src/styles.css regression. The pins below read the
  // product rule itself; a measured bounding-box claim belongs in the
  // Playwright lane, against the live layout at the audited viewports.
  it("centres rail-shell toasts in the content column and leaves phone placement alone", () => {
    expect(stylesCss).toMatch(
      /\.toast\s*\{[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\)/,
    );
    expect(stylesCss).toMatch(
      /\.sg-app--tablet \.toast,\s*\.sg-app--desktop \.toast\s*\{[^}]*left:\s*calc\(var\(--shell-rail-width\) \+ \(100vw - var\(--shell-rail-width\)\) \/ 2\)/,
    );
    // #7660: the classic shell no longer uses that fixed centering, except
    // Work. Its in-flow rule outranks the rail formula. .ugalt .toast is untouched.
    expect(stylesCss).toMatch(
      /\.sg-app:not\(\.ugalt\):not\(\.sg-app--tasks\) \.toast\s*\{[^}]*position:\s*relative;[^}]*left:\s*auto;[^}]*transform:\s*none/,
    );
    expect(stylesCss).toMatch(
      /\.sg-app--desktop\s*\{[^}]*--shell-rail-width:\s*calc\(var\(--chapter-rail-current-width\) \+ var\(--desktop-rail-current-width\)\)/,
    );
    expect(stylesCss).toMatch(
      /\.sg-app--desktop:has\(\.desktop-rail\[data-collapsed="true"\]\)\s*\{[^}]*--desktop-rail-current-width:\s*72px/,
    );
    // The 146px Cobalt Signal rail width retired with the selectable palettes
    // (design Step 2), and since the owner's ruling of November 3, 2026 no
    // stylesheet rule names Cobalt Signal or the steward's Harbor Ledger at all.
    expect(stylesCss).not.toMatch(/data-workspace-theme="(cobalt-signal|harbor-ledger)"/);
  });
});

describe("the retired 1360px companion gate", () => {
  it("App.jsx no longer mounts a companion phone on a width query", () => {
    expect(count(appJsx, jsGate(COMPANION_MIN))).toBe(0);
    expect(appJsx).not.toContain("companion-phone");
  });

  it("styles.css hides the bezel and docks Compass at the same pixel, complementarily", () => {
    expect(count(stylesCss, /@media \(max-width: 1359px\)/g)).toBe(1);
    expect(stylesCss).toMatch(/\.sg-app--desktop\s*\{[^}]*--companion-column:\s*0px/);
    expect(count(stylesCss, /\.sg-app--compass-wide \.assistant\s*\{\s*right:\s*var\(--companion-column\);\s*\}/g)).toBe(1);
    expect(stylesCss).toMatch(
      /@media \(min-width: 1360px\)\s*\{\s*\.sg-app--compass-wide \.assistant\s*\{\s*right:\s*var\(--companion-column\);\s*\}/,
    );
    expect(stylesCss).not.toContain(".sg-app--compass-wide .sg-shell-body");
  });

  it("lets every desktop workspace column fill the remaining shell width", () => {
    expect(stylesCss).toMatch(/\.sg-app--desktop \.app-column\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*padding-inline:\s*28px;/);
    expect(stylesCss).toMatch(/\.sg-app--desktop \.app-column--plane\s*\{[^}]*width:\s*100%;/);
    expect(stylesCss).not.toMatch(/\.sg-app--desktop \.app-column[^{]*\{[^}]*width:\s*min\(100%,\s*(?:860|1160|1320|1440)px\)/);
  });
});
