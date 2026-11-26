import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { measure, pairs } from "../scripts/contrast-audit.mjs";
import { collectVars, scopedVars, stripComments } from "../scripts/lib/css-vars.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");
const theme = read("src/coordinator-theme.css");
const main = read("src/main.jsx");
const tokens = read("src/sg-tokens.css");
const app = read("src/App.jsx");
const rail = read("src/components/DesktopRail.jsx");
const styleSheet = read("src/styles.css");
const styles = `${styleSheet}\n${theme}`;
const identitySelector = '.sg-app[data-workspace-theme="union-ground"]';

const directBorderConsumers = (sheet, token) => {
  const consumers = [];
  const rules = stripComments(sheet).matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const tokenPattern = new RegExp(
    `(?:^|;)\\s*border(?:-[a-z-]+)?\\s*:[^;]*var\\(${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[,)]).*?(?=;|$)`,
  );

  for (const [, selectors, declarations] of rules) {
    if (!tokenPattern.test(declarations)) continue;
    for (const selector of selectors.split(",")) consumers.push(selector.trim().replace(/\s+/g, " "));
  }

  return consumers.sort();
};

// Union Ground's one workspace theme maps the app aliases onto the vendored
// --sg-color-* roles in src/sg-tokens.css (cream canvas, forest green, gold).
// The few literals the block carries are colours no token exists for; this is
// the closed list, so a new raw colour cannot join the block unreviewed.
const identityAnchors = {
  "--primary": "var(--sg-color-green)",
  "--primary-foreground": "var(--sg-color-card)",
  "--accent": "var(--sg-color-gold)",
  "--accent-foreground": "var(--sg-color-ink)",
  "--canvas": "var(--sg-color-canvas)",
  "--background": "var(--sg-color-canvas)",
  "--card": "var(--sg-color-card)",
  "--ink": "var(--sg-color-ink)",
  "--ring": "var(--sg-color-green)",
  "--border": "var(--sg-color-border-strong)",
};
const identityLiterals = new Set(["#0b3329", "#c9dbd2", "#704700", "#e6efe9", "#17513f", "#1d5a4a", "#8a5a00"]);

const evergreenPaletteRows = [
  ["--union-ground-canvas", "--sg-color-ink", 4.5, "Union Ground Evergreen: primary text on the cream desktop canvas"],
  ["--union-ground-card-2", "--sg-color-ink", 4.5, "Union Ground Evergreen: primary text on a raised cream surface"],
  ["--union-ground-track", "--sg-color-sec", 4.5, "Union Ground Evergreen: metadata on a quiet cream surface"],
  ["--sg-color-card", "--sg-color-border-strong", 3, "Union Ground Evergreen: meaningful control boundary on a card"],
  ["--union-ground-canvas", "--sg-color-border-strong", 3, "Union Ground Evergreen: meaningful control boundary on the cream canvas"],
  ["--union-ground-canvas", "--sg-color-green", 3, "Union Ground Evergreen: focus ring on the cream canvas"],
];

describe("Casefile Control design system", () => {
  it("loads after shared styles and before motion", () => {
    expect(main.indexOf('import "./styles.css"')).toBeLessThan(main.indexOf('import "./coordinator-theme.css"'));
    expect(main.indexOf('import "./coordinator-theme.css"')).toBeLessThan(main.indexOf('import "./motion.css"'));
  });

  it("defines the complete semantic surface, action, state, type, and shape contract", () => {
    for (const token of [
      "--casework-canvas",
      "--casework-canvas-foreground",
      "--casework-surface",
      "--casework-surface-foreground",
      "--casework-muted-surface",
      "--casework-muted-foreground",
      "--casework-primary",
      "--casework-primary-foreground",
      "--casework-secondary",
      "--casework-secondary-foreground",
      "--casework-accent",
      "--casework-accent-foreground",
      "--casework-critical",
      "--casework-critical-foreground",
      "--casework-control-border",
      "--casework-focus",
      "--casework-display",
      "--casework-body",
      "--casework-data",
      "--casework-radius-panel",
    ]) expect(theme).toContain(`${token}: var(`);
  });

  it("keeps raw colors out of the scoped theme", () => {
    expect(theme).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(theme).not.toMatch(/\brgba?\(/i);
    expect(theme).not.toMatch(/\bhsla?\(/i);
  });

  it("keeps raw colors out of every rendered workspace-theme block and caps each palette contract", () => {
    // The coordinator scan above never touches styles.css, where the ledger
    // actually lives — scan every rule block scoped to a rendered
    // WORKSPACE theme. The selector match is anchored to the
    // data-workspace-theme attribute on purpose: the work-tab palette blocks
    // (`data-work-theme="aubergine-ledger"` etc.) share a theme name but are
    // first declarations of an audited --kan-* palette, hex by the same
    // necessity as the:root kanban block, and carry their own contract in
    // tests/work-tab-theme.test.jsx.
    // Superseded in design Step 2: the scanned themes were the member/steward
    // "aubergine-ledger" and the desktop "union-ground-evergreen"; they are now
    // the one identity (the steward's Harbor Ledger exception retired with the
    // owner's ruling of November 3, 2026).
    for (const [themeName, minimumBlocks] of [["union-ground", 10]]) {
      const scoped = styles.match(new RegExp(`[^{}]*data-workspace-theme="${themeName}"[^{]*\\{[^{}]*\\}`, "g")) || [];
      expect(scoped.length).toBeGreaterThanOrEqual(minimumBlocks);
      for (const block of scoped) {
        // The identity block may carry only the closed list of literals; the
        // steward exception block carries none.
        const literals = (block.match(/#[0-9a-f]{3,8}\b/gi) || []).map((value) => value.toLowerCase());
        for (const literal of literals) expect(themeName === "union-ground" && identityLiterals.has(literal), `${themeName} ${literal}`).toBe(true);
        expect(block).not.toMatch(/\brgba?\(/i);
        expect(block).not.toMatch(/\bhsla?\(/i);
      }
    }
    // Porcelain stays at the compatibility boundary; plum and aubergine now
    // come from canonical tokens. Cap the same three raw palette literals
    // across both sources, plus the three Union Ground's identity block
    // restates (plum, copper, copper boundary); nothing more may join them.
    const contract = stripComments(`${tokens}\n${styleSheet}`)
      .match(/--(?:sg-color-)?ledger-[a-z-]+:\s*#[0-9a-f]{3,8}\b/gi) || [];
    expect(contract).toHaveLength(6);
    // Raw-literal declarations: none since record
    // REQ-UG-SITEWIDE-NEUROMAP-PAPER-VISUAL-LANGUAGE-20261104. The four
    // carriers held the cream until the Neuromap sample's paper moved into
    // sg-tokens.css; they now alias those tokens at the root.
    const evergreenContract = [...stripComments(styleSheet).matchAll(/(--union-ground-[a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\b/gi)]
      .map(([, name, value]) => [name, value.trim()]);
    expect(evergreenContract).toEqual([]);
    const rootCarriers = [...stripComments(styleSheet).matchAll(/(--union-ground-(?:canvas|card-2|track|border))\s*:\s*(var\(--sg-color-[a-z0-9-]+\))/gi)]
      .map(([, name, value]) => [name, value]);
    expect(Object.fromEntries(rootCarriers)).toEqual({
      "--union-ground-canvas": "var(--sg-color-canvas)",
      "--union-ground-card-2": "var(--sg-color-card-2)",
      "--union-ground-track": "var(--sg-color-track)",
      "--union-ground-border": "var(--sg-color-border)",
    });
    expect(tokens).toContain("--sg-color-canvas: #f4f2ec;");
  });

  // Superseded rule, quoted from this test until design Step 2: "applies
  // Lovable Aubergine Ledger to Member and Steward, not the other staff hats"
  // (and, from workspaceTheme.js, owner feedback 2026-08-25 "all hats are using
  // the same theme" — each staff hat wore its own palette). New rule: October 2
  // design direction, decision 2, "One identity for every role", with the
  // steward exception kept by the owner on October 3, 2026 for one more step.
  it("applies the one identity to every hat, with no steward exception", () => {
    // Union Ground has no steward exception and no system-dark form: App
    // renders the one identity for every hat, light only.
    expect(app).toContain("const workspaceTheme = IDENTITY_WORKSPACE_THEME;");
    expect(app).toContain("const renderedWorkspaceTheme = resolveRenderedWorkspaceTheme(workspaceTheme, false)");
    expect(app).not.toContain("deriveWorkspaceTheme");
    expect(app).not.toContain("STEWARD_WORKSPACE_THEME");
    expect(app).toContain('data-workspace-theme={renderedWorkspaceTheme || undefined}');
    expect(app).toContain('workspaceTheme={renderedWorkspaceTheme}');
    expect(rail).toContain('data-workspace-theme={workspaceTheme || undefined}');
    expect(rail).not.toContain('activeHat === "coordinator"');
    expect(styles).toContain('.sg-app[data-workspace-theme="union-ground"]');
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"]');
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"] :is(a, button):focus-visible { outline-color: var(--rail-selected-border); }');
    expect(styles).toContain('.sg-app[data-workspace-theme="union-ground"] .mobile-top__hat { min-height: 44px; }');
    for (const retired of ["harbor-ledger", "cobalt-signal", "aubergine-ledger", "garnet-ledger", "indigo-ledger", "graphite-ledger", "midnight-ledger", "union-ground-evergreen"]) {
      expect(styles, retired).not.toContain(`data-workspace-theme="${retired}"`);
    }
    expect(theme).not.toContain("--sg-color-green");
  });

  it("builds the identity block only from the identity roles", () => {
    const declared = Object.fromEntries(scopedVars(styleSheet, identitySelector));
    for (const [name, value] of Object.entries(identityAnchors)) expect(declared[name], name).toBe(value);
    const foreign = Object.entries(declared)
      .filter(([, value]) => !/^var\(--(sg-color-[\w-]+|sg-light-[\w-]+|sg-depth-1|identity-canvas-veil)\)$/.test(value) && !identityLiterals.has(value.toLowerCase()))
      .map(([name, value]) => `${name}: ${value}`);
    expect(foreign).toEqual([]);
  });

  it("keeps the root control boundary on the hairline (the identity restates its own)", () => {
    const expectRootCompatibility = (sheet) => {
      expect(collectVars([sheet]).get("--control-border")).toBe("var(--sg-color-border)");
    };
    const globallyPromoted = styleSheet.replace(
      "  --control-border: var(--sg-color-border);",
      "  --control-border: var(--border);",
    );

    expectRootCompatibility(styleSheet);
    expect(globallyPromoted).not.toBe(styleSheet);
    expect(() => expectRootCompatibility(globallyPromoted)).toThrow();
  });

  it("keeps the root hairline decorative and routes every direct control or state boundary through its strong semantic", () => {
    expect(directBorderConsumers(styleSheet, "--sg-color-border")).toEqual([
      ".bevoice-asks",
      ".bevoice-card",
      ".bevoice-empty",
      ".bevoice-weekly",
      ".demo-welcome__header",
      ".home-card",
      // No ".home-chapter-cards__grid article": Union Ground removed the
      // home chapter cards with the points economy, so that rule is gone.
      ".home-receipt",
      // The landing footer and company card that drew hairlines here left
      // styles.css with: the site's
      // shared footer (src/components/siteChrome.css) draws its rules from its
      // own --chrome-line value, and the company card is retired.
      ".learn-ph",
      ".learn-stat",
      ".mcases-desk",
      ".mcases-panel",
      ".mevents-card",
      ".mevents-list-card",
      ".phead",
      ".pinned-editor__row",
      // REQ-UG-ORG-PARENT-UNION-LOGO-20261030: the frame around a
      // union's logo is decoration on a non-interactive mark, not a control.
      ".union-logo-tile",
      ".voting-stat",
    ].sort());
    expect(directBorderConsumers(styleSheet, "--control-border")).toEqual([
      //  registers the shared member action boundary. This helper
      // records comma-separated fragments, including those inside:is().
      ...`.sg-app[data-workspace-theme="union-ground"]:where(:not(.sg-app--public)) :is(
        .member-guide-card__primary:where(:not(.staff-guide-card *, .org-start *)),
        .member-guide-card__quiet:where(:not(.staff-guide-card *, .org-start *)),
        .onboarding-hud__cta, .onboarding-hud__dismiss,
        .home-takeover__open, .home-takeover__read, .what-matters__action,
        .home-nudge__primary, .home-nudge__later, .welcome-back__primary, .welcome-back__secondary,
        .home-steward__contact, .home-steward__channel, .home-steward__org,
        .home-vote-hero__cta, .home-vote-hero__later, .home-vote__cta, .home-vote__alt,
        .home-action-row__cta, .home-allevents,
        .voting-btn, .voting-hero__approve, .voting-hero__docs, .voting-extra__submit,
        .voting-suggest__send, a.voting-voted__verify,
        .mcases-ph__new, .mcases-new, .mcases-primary, .mcases-ghost,
        .inbox-head__action, .inbox-send, .inbox-quick__chip,
        .home .outline-pill, .voting-screen .outline-pill, .mcases .outline-pill, .inbox-screen .outline-pill,
        .home .dialog-primary, .home .dialog-secondary,
        .voting-screen .dialog-primary, .voting-screen .dialog-secondary,
        .mcases .dialog-primary, .mcases .dialog-secondary,
        .inbox-screen .dialog-primary, .inbox-screen .dialog-secondary
      )`.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
      // REQ-UG-CASEWORK-CONSOLE-52: the shared case list routes every
      // facet select, saved-view input, and list button through one control
      // class, so the list adds a single reviewable boundary consumer.
      ".case-list__control",
      ".home-mytasks__toggle",
      ".home-quorum",
      ".home-row",
      ".home-search",
      // REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922 and
      // REQ-UG-MEMBER-ORG-STRUCTURE-VIEW-20260922: the Home steward card's
      // secondary actions and the member org-structure page's controls. Every
      // one is a real control or container boundary on the hairline, the same
      // register .home-mytasks__toggle and .home-row already sit in; the
      // primary Contact button carries the strong green boundary instead.
      ".home-steward__channel",
      ".home-steward__org",
      ".institutional-attendance",
      ".institutional-card",
      ".institutional-export",
      ".institutional-runs",
      ".learn-search--desktop",
      ".learn-step",
      ".learn-step__dot",
      ".mcases-desk__icon--todo",
      ".mcases-desk__titletext",
      ".mevents-feed-link",
      ".mevents-history__toggle",
      ".orgstructure-tree .orgstructure-tree",
      ".orgstructure-tree__node",
      // REQ-UG-TENANT-ORG-CHART-BASELINE-20261030: the org chart's
      // branch toggles, seat filter, expand/print/export actions and seat
      // labels are controls or state boundaries in the same register.
      ".orgstructure-tree__toggle",
      ".orgstructure__actions button",
      ".orgstructure__search select",
      ".orgstructure-marker",
      ".orgstructure__detail",
      ".orgstructure__detail-close",
      ".orgstructure__kinds button",
      ".orgstructure__search input",
      ".phead__btn",
      ".pinned-shortcuts__customize",
      ".pinned-shortcuts__tile",
      // REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006: the
      // profile page's work and contact fields and their visibility selects.
      ".profile-details__grid input",
      ".profile-details__grid select",
      ".steward-contact__row input[type=\"email\"]",
      ".steward-contact__row input[type=\"tel\"]",
      ".voting-done-strip--muted",
      ".voting-openvote__title",
      ".voting-option",
      ".voting-option__dot",
      ".voting-verify-link",
    ].sort());
  });

  it("passes every Casefile Control contrast row", () => {
    const rows = measure({ tokens, styles }).filter((row) => row.scope === "app" && row.usage.startsWith("Casefile Control:"));
    // Rows 15–19 added 2026-08-22: the themed command header/docket pair
    // (QA round 1), the step-ladder pill family (QA round 2), the status-ok
    // pill + warn register (QA round 4), and the warn chip (QA round 5).
    // Row 20 added 2026-09-11: the themed header/docket eyebrow pair, after
    // the PR1815 campaign measured the primary eyebrow at 4.16:1 in Night Shift.
    // Row 21 added 2026-11-04: header search and header-button edges against
    // the header ground (gate r3g1 on); the header focus row now
    // measures against that ground too.
    expect(rows).toHaveLength(21);
    for (const row of rows) {
      expect(row.error).toBeUndefined();
      expect(row.ratio).toBeGreaterThanOrEqual(row.minimum);
    }
  });

  // The --ledger-* workspace tokens are the member and steward contract, bound
  // to the identity; the selectable Aubergine Ledger theme that named them was
  // removed (REQ-UG-REMOVE-AUBERGINE-LEDGER-THEME-20261030).
  it("passes every ledger workspace member and steward contrast row", () => {
    const rows = measure({ tokens, styles }).filter((row) => row.scope === "app" && /^Ledger (workspace|shell):/.test(row.usage));
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.error).toBeUndefined();
      expect(row.ratio).toBeGreaterThanOrEqual(row.minimum);
    }
  });

  // Gate r2s1: with the steward on the identity, the aubergine casework
  // header and the global --ring are the same brand fill, so header controls
  // carry their own ring in the header's text colour. The light identity paints
  // the header (the dormant dark form, which left it on the canvas, is deleted).
  it("keeps a visible focus ring on the steward header's controls", () => {
    expect(styles).toContain('.sg-app[data-workspace-theme="union-ground"] .cwk-screen > .phead :is(a, button, input, select, textarea):focus-visible {\n  outline-color: var(--sg-light-focus);\n}');
    const rows = measure({ tokens, styles });
    const ring = (scope, usage) => rows.find((row) => row.scope === scope && row.usage === usage);
    for (const [scope, usage] of [
      ["union-ground", "Steward header: focus ring on header controls"],
      ["union-ground", "Focus indicator"],
    ]) {
      const row = ring(scope, usage);
      expect(row, `${scope} ${usage}`).toBeDefined();
      expect(row.error).toBeUndefined();
      expect(row.ratio, `${scope} ${usage}`).toBeGreaterThanOrEqual(3);
    }
    // The defect itself: the global ring (the --ring side of the "Focus
    // indicator" row) is the header fill, 1:1.
    expect(ring("union-ground", "Ledger workspace: primary surfaces and hovered navigation").background)
      .toBe(ring("union-ground", "Focus indicator").background);
  });

  // Superseded in design Step 2: "passes the complete Evergreen scope". The
  // identity is a full scope (the steward exception retired with the owner's
  // ruling of November 3, 2026; the dormant dark scope is deleted).
  it("passes the identity scope, and every build-order identity row", () => {
    const rows = measure({ tokens, styles });
    expect(new Set(rows.map((row) => row.scope))).not.toContain("harbor-ledger");
    expect(new Set(rows.map((row) => row.scope))).not.toContain("union-ground-dark");
    for (const scope of ["union-ground"]) {
      const scopedRows = rows.filter((row) => row.scope === scope);
      expect(scopedRows.length, scope).toBeGreaterThan(300);
      for (const row of scopedRows) {
        expect(row.error, `${scope} ${row.usage}`).toBeUndefined();
        expect(row.ratio, `${scope} ${row.usage}`).toBeGreaterThanOrEqual(row.minimum);
      }
    }
    const identityRows = pairs.filter((row) => row[3].startsWith("Identity ("));
    expect(identityRows.filter((row) => row[3].startsWith("Identity (light)"))).toHaveLength(38);
    expect(identityRows.filter((row) => row[3].startsWith("Identity (dark)"))).toHaveLength(0);

    // The cream rows now measure only the public pages' canvas (design Step 10).
    const palettePairs = pairs.filter((row) => row[3].startsWith("Union Ground Evergreen:"));
    expect(palettePairs).toEqual(evergreenPaletteRows);
    expect(new Set(palettePairs.map(([background, foreground, minimum]) => `${background}|${foreground}|${minimum}`)).size)
      .toBe(palettePairs.length);
  });
});
