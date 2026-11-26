import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

const DESKTOP_APP_TOKEN = /(?:^|[^\w-])sg-app--desktop(?:$|[^\w-])/;
// `.app-column--plane` is the same column as `.app-column`, with a modifier.
const APP_COLUMN_TOKEN = /(?:^|[^\w-])app-column(?:--[\w-]+)?(?:$|[^\w-])/;

// The pre-change guard. Kept so the compound fixture below can show it misses
// a selector that is not this exact string, and a cap outside these four.
const HISTORICAL_DESKTOP_COLUMN_CLAMP =
  /\.sg-app--desktop \.app-column[^{]*\{[^}]*width:\s*min\(100%,\s*(?:860|1160|1320|1440)px\)/;

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Selector-list entries. Commas inside () or [] stay in the same entry. */
function selectorListEntries(selector) {
  const entries = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index += 1) {
    const ch = selector[index];
    if (quote) {
      current += ch;
      if (ch === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if ((ch === ")" || ch === "]") && depth > 0) depth -= 1;
    else if (ch === "," && depth === 0) {
      const entry = current.trim().replace(/\s+/g, " ");
      if (entry) entries.push(entry);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim().replace(/\s+/g, " ");
  if (tail) entries.push(tail);
  return entries;
}

function declarationValues(body, property) {
  const values = [];
  for (const raw of body.split(";")) {
    const match = raw.match(/^\s*([A-Za-z_-][\w-]*)\s*:\s*([\s\S]*)$/);
    if (!match || match[1].toLowerCase() !== property) continue;
    const value = match[2].replace(/\s*!important\s*$/i, "").trim().replace(/\s+/g, " ");
    if (value) values.push(value);
  }
  return values;
}

/**
 * Comment-stripped rules whose selector combines `.sg-app--desktop` and
 * `.app-column`, including rules nested in @media. `min-width` is not `width`.
 */
function desktopAppColumnWidths(css) {
  const found = [];
  for (const match of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith("@")) continue;
    for (const selector of selectorListEntries(prelude)) {
      if (!DESKTOP_APP_TOKEN.test(selector) || !APP_COLUMN_TOKEN.test(selector)) continue;
      found.push({
        selector,
        widths: declarationValues(match[2], "width"),
        maxWidths: declarationValues(match[2], "max-width"),
      });
    }
  }
  return found;
}

function desktopAppColumnWidthClamps(css) {
  const clamps = [];
  for (const rule of desktopAppColumnWidths(css)) {
    for (const value of rule.widths) {
      if (value !== "100%") clamps.push({ selector: rule.selector, property: "width", value });
    }
    for (const value of rule.maxWidths) {
      clamps.push({ selector: rule.selector, property: "max-width", value });
    }
  }
  return clamps;
}

describe("annotated desktop and companion-phone polish", () => {
  const styles = read("src/styles.css");
  const app = read("src/App.jsx");
  const cases = read("src/views/CasesView.jsx");
  const assistant = read("src/components/FloatingControls.jsx");
  const i18n = read("src/lib/i18n.js");

  it("does not reserve a companion-phone lane beside the desktop plane", () => {
    expect(app).toContain('desktopShell && assistantOpen ? " sg-app--compass-wide"');
    expect(styles).toContain("--companion-column: 0px");
    expect(styles).toContain(".sg-app--compass-wide .assistant { right: var(--companion-column); }");
  });

  it("lets the desktop workspace column fill the remaining shell width", () => {
    expect(styles).toMatch(/\.sg-app--desktop \.app-column\s*\{[^}]*width:\s*100%;[^}]*padding-inline:\s*28px;/);
    expect(styles).toMatch(/\.sg-app--desktop \.app-column--plane\s*\{[^}]*width:\s*100%;/);
    const observed = desktopAppColumnWidths(styles);
    expect(observed.some((rule) => rule.widths.includes("100%"))).toBe(true);
    expect(desktopAppColumnWidthClamps(styles)).toEqual([]);
  });

  it("flags any desktop app-column width other than 100%, including a compound selector", () => {
    const compound = ".sg-app.sg-app--desktop main .app-column { width: min(100%, 1000px); }";
    const clamp = { selector: ".sg-app.sg-app--desktop main .app-column", property: "width", value: "min(100%, 1000px)" };
    expect(compound).not.toMatch(HISTORICAL_DESKTOP_COLUMN_CLAMP);
    expect(desktopAppColumnWidthClamps(`${styles}\n${compound}`)).toEqual([clamp]);
    expect(desktopAppColumnWidthClamps(`@media (min-width: 1600px) {\n  ${compound}\n}`)).toEqual([clamp]);
    expect(desktopAppColumnWidthClamps(`.app-column,\n${compound}`)).toEqual([clamp]);
    expect(desktopAppColumnWidthClamps(
      ".sg-app--desktop .app-column--plane { width: 100%; max-width: 1440px; }",
    )).toEqual([{ selector: ".sg-app--desktop .app-column--plane", property: "max-width", value: "1440px" }]);
    expect(desktopAppColumnWidthClamps(`/* ${compound} */`)).toEqual([]);
  });

  it("keeps the phone surround and status row transparent", () => {
    expect(styles).toMatch(/\.companion-phone__app \{[^}]*background: transparent;/);
    expect(styles).toMatch(/\.phone-frame__screen \{[^}]*background: transparent;/);
    expect(styles).toMatch(/\.phone-frame__statusbar \{[^}]*background: transparent;/);
  });

  it("uses a compact 56px dock without sacrificing 48px targets", () => {
    expect(styles).toContain("padding: 4px 6px max(4px, env(safe-area-inset-bottom))");
    expect(styles).toMatch(/\.bottom-nav a, \.bottom-nav button \{[^}]*min-height: 48px;/);
  });

  it("shapes Compass suggestions per state and keeps the footer removed", () => {
    // 2026-08-08 refining the 08-07 ChatGPT reference: a fresh
    // chat shows icon starter ROWS in the thread area; an active conversation
    // shows them as chips above the composer. Since  those chips wrap
    // and center, as the Web shell and landing contract says.
    expect(styles).toMatch(/\.assistant \.compass-starters \{[^}]*flex-direction: column;[^}]*align-items: stretch;/);
    expect(styles).toMatch(/\.compass-chips \{[^}]*flex-wrap: wrap;/);
    expect(styles).toMatch(/\.hub2-tabs \{[^}]*overflow-x: auto;[^}]*mask-image: linear-gradient\(90deg, #000 calc\(100% - 26px\), transparent\);/);
    expect(assistant).toContain("compass-starters");
    expect(assistant).not.toContain("guide2-composer__note");
    expect(i18n).not.toContain("guide2.privacyNote");
  });

  it("centers the active case milestone when no history precedes it", () => {
    expect(cases).toContain('strip.length === 0 ? " mcases-desk__strip--center-current"');
    expect(styles).toContain('.mcases-desk__strip--center-current::before { content: ""; flex: 1; min-width: 0; }');
  });
});
