import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { measure, pairs, ratiosFor, scopedPairs, scopes } from "../scripts/contrast-audit.mjs";
import {
  collectVars,
  paintDeclarations,
  paintedPairs,
  rootBlocks,
  scopedBlocks,
  scopedVars,
  stripComments,
} from "../scripts/lib/css-vars.mjs";

const escapeRegExp = (value) => String(value).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");

// The styles.css :root block is where the app's semantic names meet the
// generated Union Base tokens. Five of those names held a raw hex until this
// pass; three were byte-identical to a token that already existed and two were
// four units away from one. Re-pointing them is cheap. Keeping them pointed is
// what needs a guard, and the interesting part is that the guard's OWN parser
// was the softest thing in the chain — it could be disarmed by a comment.
//
// So this file pins three separate layers:
//   1. the parser (behaviourally, against hand-built sheets)
//   2. the aliases (they must stay bare var(--sg-*), and must not restate a hex)
//   3. the invocation (npm run check must still call the audit at all)

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

const tokensCss = read("src/sg-tokens.css");
const stylesCss = `${read("src/styles.css")}\n${read("src/coordinator-theme.css")}`;
const packageJson = JSON.parse(read("package.json"));

/** Aliases this pass moved off a literal, and the token each must resolve to. */
const ALIASED = {
  "--muted-foreground": "--sg-color-sec",
  "--status-foreground": "--sg-color-sec",
  "--destructive": "--sg-color-danger",
  "--border": "--sg-color-border-strong",
  "--success": "--sg-color-success",
};

/**
 * Tokens whose NAME invites the wrong pick, with the value that makes it wrong.
 * Each of these was a real candidate during the pass: --sg-color-muted shares a
 * word with --muted-foreground but is a #8a938c *surface-adjacent* grey that
 * measures 2.43:1 as text on --muted, and --sg-color-border is the #d1d1d1
 * hairline where --border is the input/control edge, a drop from 3.37:1 to
 * 1.37:1 on the audited pair.
 */
const NAME_TRAPS = {
  "--muted-foreground": "--sg-color-muted",
  "--border": "--sg-color-border",
};

describe("token alias parser", () => {
  // Behavioural, not textual. A pin on the SHAPE of scripts/lib/css-vars.mjs
  // would pass against a parser that had been quietly reverted to indexOf.
  it("does not read a comment as a declaration", () => {
    const disarmed = `:root {
  --border: var(--sg-color-border);
  /* Rejected: --border: var(--sg-color-border-strong); measures 3.37:1. */
}`;
    expect(
      collectVars([disarmed]).get("--border"),
      "a comment placed after a declaration replaced it. That is the shape of a " +
        "note explaining why a token was rejected, written in the block the " +
        "rejection is about — so documenting the decision disarmed the checker.",
    ).toBe("var(--sg-color-border)");
  });

  it("reads a comment before a declaration as inert too", () => {
    const documented = `:root {
  /* Rejected: --border: var(--sg-color-border); measures 1.37:1. */
  --border: var(--sg-color-border-strong);
}`;
    expect(collectVars([documented]).get("--border")).toBe("var(--sg-color-border-strong)");
  });

  it("takes the LAST :root, the way the cascade does", () => {
    const appended = `:root { --muted-foreground: var(--sg-color-sec); }
.unrelated { color: red; }
:root { --muted-foreground: var(--sg-color-muted); }`;
    expect(
      collectVars([appended]).get("--muted-foreground"),
      "only the first :root was being read, so appending a second one to the " +
        "foot of a sheet overrode every audited alias in the browser while the " +
        "audit kept resolving the first block and printing PASS.",
    ).toBe("var(--sg-color-muted)");
    expect(rootBlocks(appended)).toHaveLength(2);
  });

  it("finds a :root that follows a comma", () => {
    // `html, :root { … }` is ordinary CSS and applies to the root element. The
    // first version of this parser matched `:root` only after `}`, `;` or the
    // start of the sheet, so a comma-adjacent one was invisible: the audit kept
    // resolving the untouched earlier block and printed border/background at
    // 3.37:1 PASS while Chromium painted 1.37:1. Worse than the miss is that a
    // TEXT-shaped pin does not help — the original declaration is still there,
    // unmodified, for any regex to find.
    const commaAdjacent = `:root { --border: var(--sg-color-border-strong); }
/* Control-edge tuning for the redesigned inputs. */
html, :root { --border: var(--sg-color-border); }`;
    expect(collectVars([commaAdjacent]).get("--border")).toBe("var(--sg-color-border)");
  });

  it("refuses a :root inside an at-rule instead of skipping it", () => {
    // A conditional :root has no single value, and this audit resolves one
    // value per name. Under the previous parser the SAME nested rule was found
    // or missed depending on whether another rule happened to precede it in the
    // block — the answer came from adjacency, not structure. Both outcomes were
    // wrong: missed meant a silent PASS on a value the browser overrides, found
    // meant media-gated values flattened into the unconditional table.
    const conditional = `:root { --border: var(--sg-color-border-strong); }
@media (min-width: 900px) { :root { --border: var(--sg-color-border); } }`;
    expect(() => collectVars([conditional])).toThrow(/conditional/i);
  });

  it("refuses a :root-targeting selector it cannot classify", () => {
    expect(() => collectVars([":root { --a: 1; } :root.dark { --a: 2; }"])).toThrow(/cannot classify/i);
  });

  it("still reads every real stylesheet root in full", () => {
    // Lower bounds, deliberately, on BOTH files. The property under test is
    // that the parser has not been NARROWED, and a floor catches narrowing
    // exactly as well as an equality does.
    //
    // An exact pin here would additionally fail on GROWTH, and growth is the
    // normal life of the token file: sg-tokens.css is the canonical token
    // source (owner ruling, October 3, 2026; it was synced from a separate
    // design-system repository before design Step 2), and adding a
    // token is a routine edit. There IS an exact count pin for that file, in
    // tests/sg-tokens.test.js beside the SHA256 — and it is maintained: the
    // pin is "exactly one expect(defined.size).toBe(<n>)" there, edited
    // together with the hash whenever the canonical file changes (Union
    // Ground's design-sync tool did this; it is not part of Union Ground).
    // A second count pin, in a different file and a different expression
    // shape, is invisible to the sync tool: it would neither be updated nor
    // reported, so the next upstream token addition would land red — and in
    // this repo the sync workflow commits and pushes BEFORE it can report a
    // failure, so the red would arrive already merged.
    expect(collectVars([tokensCss]).size).toBeGreaterThanOrEqual(100);
    expect(collectVars([stylesCss]).size).toBeGreaterThanOrEqual(45);
    expect(rootBlocks(stripComments(stylesCss))).toHaveLength(2);
  });

  it("does not read `background-color` as a text colour", () => {
    // The one mistake that would quietly wreck the derived guard. `color:` also
    // appears inside `background-color:`, so a pattern without the `(?:^|;)`
    // anchor reports every surface as its own foreground — an all-1.00:1 table
    // of pairs nothing paints. A guard that cries wolf gets deleted, so this is
    // pinned rather than trusted.
    const sheet = ".a { background-color: var(--surface); color: var(--text); }";
    expect(paintedPairs(sheet)).toEqual([
      { selector: ".a", background: "--surface", foreground: "--text", conditional: false },
    ]);
    // Neighbouring properties that end in `-color` and are not text.
    const decoys = ".b { background: var(--s); border-color: var(--x); accent-color: var(--y); }";
    expect(paintedPairs(decoys)).toEqual([]);
  });

  it("reports only rules that name BOTH halves in the same block", () => {
    // The whole basis for calling this derivation rather than guessing: a rule
    // naming one half needs its backdrop resolved through ancestry, which this
    // does not attempt and must not pretend to.
    const sheet = ".only-bg { background: var(--s); } .only-fg { color: var(--t); }";
    expect(paintedPairs(sheet)).toEqual([]);
  });

  it("reports a pair inside an at-rule, and marks it conditional", () => {
    // Deliberately NOT the refusal the :root readers make. Their model stores
    // one unconditional value per name and has nowhere to put a conditional one.
    // A pair has no such model: painted inside a media query it is still a real
    // pair that must hold whenever the query does, so it is reported and
    // labelled rather than thrown away.
    const sheet = "@media (min-width: 900px) { .c { background: var(--s); color: var(--t); } }";
    expect(paintedPairs(sheet)).toEqual([
      { selector: ".c", background: "--s", foreground: "--t", conditional: true },
    ]);
  });

  it("does not read a commented-out rule as a painted pair", () => {
    // Same disarming trick the alias parser fell to, pointed at the new reader:
    // a plausible-looking note recording a rejected rule would otherwise add a
    // pair nobody paints, and the guard would demand a row for it.
    const sheet = "/* rejected: .d { background: var(--s); color: var(--t); } */ .e { color: var(--t); }";
    expect(paintedPairs(sheet)).toEqual([]);
  });

  it("skips a gradient background rather than misreporting its first stop", () => {
    // .tasks-progress-ring paints a conic-gradient, and reading `var(--accent)`
    // out of it as "the background" would name the ARC as the surface its own
    // text sits on. The reader requires a bare var() and takes nothing here —
    // which is why the ring's two stops are pinned by hand in the call-site
    // test. A limitation that is covered elsewhere, stated where it is caused.
    const sheet = ".f { background: conic-gradient(var(--a) 50%, var(--b) 0); color: var(--t); }";
    expect(paintedPairs(sheet)).toEqual([]);
  });

  it("takes the LAST declaration in a block, the way the cascade does", () => {
    // The defect a reviewer used to defeat the previous commit, pinned as
    // behaviour. A non-global .match() returns the FIRST match, so a rule with
    // two `color` declarations was reported as its first one — the guard did not
    // merely miss the rule, it CERTIFIED a pair the browser does not paint.
    const sheet = ".g { background: var(--s); color: var(--first); color: var(--last); }";
    expect(paintedPairs(sheet)).toEqual([
      { selector: ".g", background: "--s", foreground: "--last", conditional: false },
    ]);
    // Same for the surface, including via the longhand.
    const surfaces = ".h { background: var(--first); background-color: var(--last); color: var(--t); }";
    expect(paintedPairs(surfaces)[0].background).toBe("--last");
  });

  it("drops the pair when the LAST declaration is one it cannot resolve", () => {
    // The half of last-write-wins that is easy to get wrong: an unresolvable
    // final value must EMPTY the slot, not fall back to the earlier value the
    // browser has already overridden. Each of these renders the second value.
    for (const suffix of ["var(--x) !important", "var(--x, #7d4f00)", "#7d4f00"]) {
      const sheet = `.i { background: var(--s); color: var(--t); color: ${suffix}; }`;
      expect(paintedPairs(sheet), `last value ${suffix} must not report --t`).toEqual([]);
    }
  });

  it("hands back the raw declarations, including ones it cannot resolve", () => {
    // Silent exclusion is the failure mode this file refuses everywhere else, so
    // the caller gets the declarations as written and can assert over them.
    const sheet = ".j { background: transparent; color: var(--t) !important; }";
    expect(paintDeclarations(sheet)).toEqual([
      { selector: ".j", property: "background", value: "transparent", conditional: false },
      { selector: ".j", property: "color", value: "var(--t) !important", conditional: false },
    ]);
    // background-color is normalised to background so a caller cannot miss one
    // by checking only the shorthand.
    expect(paintDeclarations(".k { background-color: var(--s); }")[0].property).toBe("background");

    // Comments are inert here too. This has to be pinned on a hand-built sheet
    // rather than by mutating the real one: no comment in styles.css currently
    // contains a paint declaration, so removing stripComments() from this reader
    // is a no-op against live content and a mutation battery cannot see it. The
    // hole is latent rather than absent — the disarming edit is the responsible
    // -looking one, a note recording a rejected colour in the rule it concerns —
    // and it would feed the bare-var guard a violation nobody wrote.
    const commented = ".l { /* rejected: color: #7d4f00; */ background: var(--s); color: var(--t); }";
    expect(paintDeclarations(commented)).toEqual([
      { selector: ".l", property: "background", value: "var(--s)", conditional: false },
      { selector: ".l", property: "color", value: "var(--t)", conditional: false },
    ]);
  });
});

describe("styles.css :root aliases", () => {
  const vars = collectVars([stylesCss]);
  const tokens = collectVars([tokensCss]);

  it("points each aliased name at its token", () => {
    const wrong = Object.entries(ALIASED)
      .filter(([name, token]) => vars.get(name) !== `var(${token})`)
      .map(([name, token]) => `${name} should be var(${token}), is ${vars.get(name)}`);
    expect(wrong).toEqual([]);
  });

  it("keeps public landing ink dark on Union Ground cream", () => {
    expect(vars.get("--pub-canvas")).toBe("var(--union-ground-canvas)");
    expect(vars.get("--pub-ink")).toBe("var(--sg-color-forest)");
    expect(vars.get("--pub-surface-foreground")).toBe("var(--union-ground-canvas)");
  });

  it("writes them bare, with no fallback", () => {
    // scripts/contrast-audit.mjs resolves only /^var\(\s*(--[\w-]+)\s*\)$/. A
    // defensive `var(--sg-color-danger, #b14e30)` throws there for a name that
    // has a contrast row and passes SILENTLY for one that does not — so the
    // fallback form is both a hard build break and a hidden hole depending on
    // which alias a contributor adds it to. Neither is acceptable; ban the form.
    const withFallback = Object.keys(ALIASED).filter((name) => /var\([^)]*,/.test(vars.get(name) ?? ""));
    expect(
      withFallback,
      "a fallback defeats the audit's resolver. Write the bare var(--sg-*).",
    ).toEqual([]);
  });

  it("does not take the name-obvious token where the role disagrees", () => {
    const trapped = Object.entries(NAME_TRAPS)
      .filter(([name, trap]) => vars.get(name) === `var(${trap})`)
      .map(([name, trap]) => `${name} -> ${trap} (${tokens.get(trap)})`);
    expect(
      trapped,
      "these two tokens share a word with the alias and carry a different role. " +
        "sg-tokens.css even name-maps them onto these aliases in its own inline " +
        "comments, and following those comments fails the contrast audit.",
    ).toEqual([]);
  });

  it("never paints a track-grey surface alias as a text colour", () => {
    // --muted and --track are SURFACES (--muted aliases --sg-color-card-2 and
    // --track --sg-color-track, the paper panels); the text role for quiet copy
    // is --muted-foreground.
    // paintedPairs() cannot catch this mistake when the background lives in a
    // different block: `.legal-page` set background:var(--card) while
    // `.legal-page section p` set color:var(--muted) three rules later, and
    // the whole body of /privacy, /terms and /accessibility rendered 1.31:1
    // with the audit exiting 0. Other light tokens (--canvas, --card) ARE
    // legitimate text colours on the dark rail, so the ban is exactly these
    // two, whose alias-layer comment already forbids the text role.
    // Whitespace-tolerant, case-insensitive, and matched against the whole
    // declaration value so a fallback chain (`color: var(--quiet,
    // var(--muted))`) cannot smuggle the surface in — sol-review finding 3
    // on the first cut of this test, which required lowercase `color:` and
    // a direct var().
    const painted = [
      ...stripComments(stylesCss).matchAll(/(?<![-\w])color\s*:\s*[^;{}]*?var\(\s*(--(?:muted|track))\s*[),]/gi),
    ].map((m) => m[1]);
    expect(
      painted,
      "use --muted-foreground for quiet text; --muted/--track are surfaces.",
    ).toEqual([]);
  });

  it("leaves no :root declaration restating a hex a token already defines", () => {
    const tokenHex = new Map();
    for (const [name, value] of tokens) {
      // First spelling wins: the identity roles added in design Step 2 repeat
      // a few earlier hexes (#ffffff is both --sg-color-card and
      // --sg-light-card), and the guard names the earlier, canonical token.
      if (/^#[0-9a-f]{6}$/i.test(value) && !tokenHex.has(value.toLowerCase())) tokenHex.set(value.toLowerCase(), name);
    }
    // The two --union-ground-* copies that used to be excused here are gone:
    // the grey override they routed around was removed when the Neuromap
    // sample's paper moved into sg-tokens.css (record
    // REQ-UG-SITEWIDE-NEUROMAP-PAPER-VISUAL-LANGUAGE-20261104), so
    // they alias their tokens like every other carrier and no exception remains.
    const restated = [...vars]
      .filter(([, value]) => tokenHex.has(String(value).toLowerCase()))
      .map(([name, value]) => `${name}: ${value} is exactly ${tokenHex.get(value.toLowerCase())}`);
    expect(
      restated,
      "a literal in :root that a token already spells is drift waiting to happen: " +
        "the token can move upstream and the copy will not. Alias it instead. " +
        "(Literals with NO exact token are fine and several remain deliberately.)",
    ).toEqual([]);
  });
});

describe("scoped palettes, now that the audit has a scope dimension", () => {
  // A previous pass filed this: `.tasks-screen--dark` re-declared 21 of the
  // names the table measures, behind a localStorage toggle any member can flip,
  // and the audit read `:root` only — so inside that scope its published ratios
  // described a palette that was not on screen. That filing was closed by
  // giving the audit a scope dimension.
  //
  // The part of the filing that was WRONG is the part worth keeping. It assumed
  // the scope was hiding failures among the rows that already existed. It was
  // not: run the fourteen pre-existing rows under the dark overlay and every
  // single one passes. The failures were in pairs the table had no row for at
  // all — --primary under --accent, --green-soft under --green — so a scope
  // dimension shipped on its own would have found nothing and reported a clean
  // sweep of a screen with 1.00:1 text on it. A scope is a multiplier on
  // coverage, never a substitute for it.
  //
  // The dark palette itself is gone (2026-07-28: the per-screen toggle was
  // deleted with the staff-tool wire-in, and this sweep removed the orphaned
  // block, the `tasks dark` scope and the pins below that described it). The
  // MECHANISM stays and is what still earns its place: the first test in this
  // block is what makes the next scoped palette — system dark mode, arriving as
  // a design-system token PR — impossible to add without an audit scope.
  const AUDITED = new Set([...pairs, ...scopedPairs].flatMap(([background, foreground]) => [background, foreground]));
  const COVERED = new Set(scopes.flatMap(({ overlays }) => overlays));

  it("measures every scope that re-points a name the table measures", () => {
    const uncovered = scopedBlocks(stylesCss)
      .filter(({ vars }) => [...vars.keys()].some((name) => AUDITED.has(name)))
      .map(({ selector }) => selector)
      .filter((selector) => !COVERED.has(selector));
    expect(
      uncovered.sort(),
      "this selector re-points a name the contrast audit measures, and no scope " +
        "in scripts/contrast-audit.mjs overlays it — so inside this scope the " +
        "audit's published ratio is not what renders. Add it to `scopes`.",
    ).toEqual([]);
  });

  it("keeps every overlay pointed at a block that declares something", () => {
    // An overlay naming a selector that declares nothing resolves to :root a
    // second time and reports it as another scope's worth of coverage. The
    // audit throws on it; this states the same thing, so the throw is a
    // decision someone made rather than a surprise someone hits.
    for (const { name, overlays } of scopes) {
      for (const selector of overlays) {
        expect(
          scopedVars(stylesCss, selector).size,
          `scope "${name}" overlays ${selector}, which declares nothing`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every scope materially different from :root", () => {
    // A scope that resolved to the same values as :root would pass every row
    // while proving nothing, and would keep passing if someone emptied it.
    //
    // Was written against `.tasks-screen--dark` and its 21 re-declarations;
    // that block is deleted, so the claim is stated over whatever `scopes`
    // actually overlays instead of over one selector by name. Naming the
    // selector was the softer form: it stopped meaning anything the moment the
    // selector left the sheet, whereas this cannot be satisfied by deletion.
    const rootVars = collectVars([tokensCss, stylesCss]);
    const overlaid = scopes.flatMap(({ overlays }) => overlays);
    expect(overlaid.length, "no scope overlays anything; the dimension is inert").toBeGreaterThan(0);
    for (const selector of overlaid) {
      const declared = scopedVars(stylesCss, selector);
      const differing = [...declared.keys()].filter((name) => rootVars.get(name) !== declared.get(name));
      expect(differing.length, `${selector} no longer diverges from :root`).toBeGreaterThan(0);
    }
  });

  it("runs the scoped rows in every scope that has an overlay", () => {
    // Against measure(), not against the scopes table. Asserting that `scopes`
    // lists `.tasks-screen` says nothing about whether the audit ever feeds
    // scopedPairs to it: narrowing the row list to `pairs` inside the audit
    // left this whole file green while the four status-dot rows ran nowhere.
    const rows = measure({ tokens: tokensCss, styles: stylesCss });
    const withOverlays = scopes.filter(({ overlays }) => overlays.length > 0);
    // One, since `tasks dark` was retired with the palette it described. The
    // floor is not dropped to zero: at zero this loop asserts nothing at all,
    // which is the exact vacuity the rest of this file exists to refuse.
    expect(withOverlays.length).toBeGreaterThanOrEqual(1);

    for (const { name } of withOverlays) {
      for (const [background, foreground] of scopedPairs) {
        expect(
          rows.some((row) => row.scope === name
            && row.backgroundVar === background
            && row.foregroundVar === foreground),
          `scope "${name}" never measures ${background} under ${foreground}`,
        ).toBe(true);
      }
    }
  });

  it("has no row, in any scope, that misses its own minimum", () => {
    // The audit reports this by exit code, which only helps if the audit is
    // still in the check chain. Stating it here means `npm run check` fails on
    // a contrast regression even if someone unhooks scripts/contrast-audit.mjs.
    for (const row of measure({ tokens: tokensCss, styles: stylesCss })) {
      const where = `${row.scope}: ${row.backgroundVar} under ${row.foregroundVar}`;
      expect(row.error, `${where} — ${row.error}`).toBeUndefined();
      expect(row.ratio, where).toBeGreaterThanOrEqual(row.minimum);
    }
  });
});

describe("the pairs the retired dark palette broke", () => {
  /**
   * WCAG 2.x relative luminance, written out here rather than imported.
   *
   * The audit owns the only other copy. Importing it would mean this file and
   * the thing it checks agree because they are the same code — the ratios below
   * would be re-derivations of whatever the audit currently believes, and a
   * resolver bug would move both together and be invisible. These numbers were
   * computed from the token hexes by a separate script before any of the fix
   * was written, so they are a genuine second opinion on the audit's arithmetic.
   */
  const channel = (value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = (hex) => {
    const packed = Number.parseInt(hex.slice(1), 16);
    return [packed >> 16, (packed >> 8) & 255, packed & 255]
      .map((byte) => channel(byte / 255))
      .reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const ratio = (a, b) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  };

  const boardVars = new Map([
    ...collectVars([tokensCss, stylesCss]),
    ...scopedVars(stylesCss, ".tasks-screen"),
  ]);
  const hex = (name, seen = new Set()) => {
    expect(seen.has(name), `circular reference at ${name}`).toBe(false);
    seen.add(name);
    const value = boardVars.get(name);
    expect(value, `${name} is not declared on the board scope or in :root`).toBeDefined();
    const reference = value.match(/^var\(\s*(--[\w-]+)\s*\)$/);
    return reference ? hex(reference[1], seen) : value;
  };

  /**
   * Each row is a pair a real rule paints on the tasks board, what it measured
   * under the per-screen dark palette that has since been deleted, and what it
   * has to clear. `was` is not asserted — no sheet produces it any more — it is
   * here so the row cannot be read as a threshold someone picked to fit a value
   * they already had.
   *
   * Kept after that palette's removal on purpose. The reason these five rows
   * exist is the ALIAS SEPARATION they check up on (--hero-surface away from
   * --primary, --priority-low-ink away from --green), and that separation is
   * what a returning dark theme will restate. Deleting the rows because the
   * palette that exposed them went away would put the pairs back where they
   * started: painted by a real rule and measured by nothing.
   */
  const FIXED = [
    { background: "--hero-surface", foreground: "--accent", was: 1.00, minimum: 4.5, where: ".tasks-progress-hero .eyebrow, and the ring's arc" },
    { background: "--hero-surface", foreground: "--hero-ink", was: 8.36, minimum: 4.5, where: ".tasks-progress-hero h2" },
    { background: "--hero-surface", foreground: "--primary-muted-foreground", was: 1.46, minimum: 4.5, where: ".tasks-progress-hero p" },
    { background: "--green-soft", foreground: "--priority-low-ink", was: 1.49, minimum: 4.5, where: ".task-priority--low" },
    { background: "--card", foreground: "--task-status-review", was: 1.66, minimum: 3, where: ".task-status-dot--needs_review" },
  ];

  for (const { background, foreground, was, minimum, where } of FIXED) {
    it(`keeps ${background} under ${foreground} readable (was ${was.toFixed(2)}:1 in dark)`, () => {
      expect(
        ratio(hex(background), hex(foreground)),
        `${where} renders this pair on the tasks board`,
      ).toBeGreaterThanOrEqual(minimum);
    });
  }

  it("states every minimum above as a WCAG threshold", () => {
    // Same bar the pair table is held to: 4.5 is 1.4.3 text, 3 is 1.4.11
    // non-text. A row that relaxed to 2.5 to accommodate a colour would be
    // arguing for a different standard, and has to say so out loud.
    for (const { minimum } of FIXED) expect([3, 4.5, 7]).toContain(minimum);
  });

  it("keeps the hero off --primary, which a dark palette repoints to gold", () => {
    // The root cause, pinned as structure rather than as a ratio. --primary was
    // gold in the dark scope so buttons read as gold; the hero borrowed it as a
    // SURFACE, which turned the panel gold and took the eyebrow, the supporting
    // copy and the ring's arc down with it. A repoint back to --primary reopens
    // three at once, and the ratios above would catch it only while --primary
    // and --hero-surface still differ.
    //
    // This is the load-bearing assertion of the five now that the palette is
    // deleted: with only one value set on the sheet, --hero-surface and
    // --primary resolve to the same hex, so every ratio above passes either
    // way. Structure is the only thing left that can tell the two apart, and it
    // is what the next dark theme will depend on.
    const hero = stylesCss.match(/\.tasks-progress-hero \{([^}]*)\}/);
    expect(hero, ".tasks-progress-hero rule not found").not.toBeNull();
    expect(hero[1]).toContain("background: var(--hero-surface)");
    expect(hero[1]).toContain("color: var(--hero-ink)");

    // The arc and inner disc belong to a decorative sibling, so the text has
    // no painted pseudo-element on an ancestor. Its own opaque panel ground
    // also keeps the sibling gradient out of the contrast calculation.
    const disc = stylesCss.match(/\.tasks-progress-ring__art::after \{([^}]*)\}/);
    expect(disc, ".tasks-progress-ring__art::after rule not found").not.toBeNull();
    expect(disc[1]).toContain("background: var(--hero-surface)");

    // The ring element itself is the text's measurable ground.
    const ringGround = stylesCss.match(/\.tasks-progress-ring \{([^}]*)\}/);
    expect(ringGround, ".tasks-progress-ring rule not found").not.toBeNull();
    expect(ringGround[1]).toContain("background: var(--hero-surface)");
    const labelGround = stylesCss.match(/\.tasks-progress-ring > span \{([^}]*)\}/);
    expect(labelGround, ".tasks-progress-ring label rule not found").not.toBeNull();
    expect(labelGround[1]).toContain("background: var(--hero-surface)");
  });

  it("keeps the call sites pointed at the tokens the rows measure", () => {
    // The ratio tests above resolve TOKENS. They stay green if a rule stops
    // using the token and goes back to the one that broke — the pair would
    // still measure 8.50:1 while nothing on screen paints it. A pair is only
    // guarded where the ratio and the call site are pinned together.
    const rule = (selector) => {
      const found = stylesCss.match(new RegExp(`${escapeRegExp(selector)} \\{([^}]*)\\}`));
      expect(found, `${selector} rule not found`).not.toBeNull();
      return found[1];
    };
    expect(rule(".task-priority--low")).toContain("color: var(--priority-low-ink)");
    expect(rule(".task-status-dot")).toContain("background: var(--task-status-backlog)");

    // The three rules the hero's fix actually depends on. Their absence here was
    // a real hole and not a theoretical one: two independent reviewers each
    // changed line 918 to `color: var(--primary-foreground)` and got a green
    // audit, a green 1332-test suite, and a dark eyebrow at 1.60:1 — the same
    // defect this PR exists to fix, restored through every check.
    //
    // Note the shape of that mutation. It repoints the eyebrow at a --primary-*
    // name, which is EXACTLY the coupling diagnosed as the root cause: --primary
    // means "the primary action colour" and the dark scope repoints it to gold.
    // The tidy-looking edit and the regression are the same edit.
    expect(rule(".tasks-progress-hero .eyebrow")).toContain("color: var(--accent)");
    expect(rule(".tasks-progress-hero p")).toContain("color: var(--primary-muted-foreground)");

    // The arc is painted by a gradient, so paintedPairs() cannot see it and the
    // derived guard below will never cover it. Both stops are pinned by hand:
    // --accent is measured against the panel AND against --primary-deep, and
    // neither row means anything if the gradient stops using them.
    const ring = rule(".tasks-progress-ring__art");
    expect(ring).toContain("var(--accent)");
    expect(ring).toContain("var(--primary-deep)");
  });

  it("has a row for every pair ANY rule in the sheet paints in one block", () => {
    // The guard that would have caught --ink without a reviewer, now with the
    // last hand-chosen thing in it removed.
    //
    // Every assertion above this one measures a pair someone thought to list.
    // That method missed the alias thirty rules paint as text, three lines from
    // the ones this pass edits, because nothing asked the SHEET what it paints.
    // This does: paintedPairs() reports every rule naming both a background and
    // a text colour in one block, and every such pair must have a row or be
    // argued for by name below.
    //
    // The first version of this guard ran the same sweep behind `/task/i`. That
    // filter was the last soft edge in the derivation and it was wrong in BOTH
    // directions. It could be emptied: narrow it to match nothing and the guard
    // inspects zero rules and passes green — which a mutation run duly proved.
    // And it leaked: the board's timeline view names its rules `timeline-*`, so
    // `.timeline-row__label` painted inside .tasks-screen while sitting outside
    // "the tasks board" as the regex defined it.
    //
    // There is now no filter to empty and no boundary to misdraw. 37 pairs are
    // painted sheet-wide; 35 have rows and 2 are named here with their numbers.
    //
    // `failsIn` names the EXACT scopes where the pair measures under 4.5:1, and
    // is asserted for set-equality against a live measurement below. It exists
    // because two different arguments were being made in this ledger and prose
    // was letting them blur:
    //
    //   upstream-blocked  -> failsIn ["app", "tasks"]  (fails where it renders)
    //   unreachable scope -> failsIn ["tasks dark"]    (fails where it cannot)
    //
    // Written down and checked, the shapes are distinguishable. An "unreachable
    // scope" excuse that starts failing in `app` — a scope it demonstrably does
    // reach — no longer keeps its excuse, because the set it claims stops
    // matching the set that measures. Under the old `worst < 4.5` floor that
    // change was invisible: the pair still failed SOMEWHERE, so it still
    // qualified, and an excuse written about the dark theme silently went on
    // covering a real defect in the light one.
    //
    // Only the first shape survives: `tasks dark` is gone (2026-07-28) and the
    // three excuses of the second shape expired with it — see the note where
    // they used to sit. The second shape is kept described rather than deleted
    // because it is the one a returning dark theme will produce again, and
    // because the distinction is what the set-equality check is FOR.
    // EMPTY, and deliberately so. One entry lived here from Wave 2b until the
    // 2026-09-12 acceptance campaign: --terra-soft|--destructive, 4.12:1 in
    // every reachable light scope, excused as upstream-blocked in the design
    // system. The campaign stopped accepting that argument the moment a live
    // browser measured .tasks-error on /m/tasks/report and failed the case, so
    // the three paint sites — .task-priority--high, .tasks-breakdown__row > b em
    // and .tasks-error — moved to --learn-terra-ink, the darkened terra this
    // system already minted for soft terra grounds, and the pair took a row in
    // scripts/contrast-audit.mjs instead of an excuse here.
    //
    // The mechanism below is kept, not deleted, because it is the shape a real
    // upstream block needs and because every assertion in it is what stopped
    // the old entry from quietly widening: paint sites are matched for
    // set-equality, the failing scopes are re-measured, and the reason has to
    // carry its own number. Over an empty map the loop is vacuous; the coverage
    // sweep above is what is load-bearing today, and it now has nothing to
    // forgive.
    const EXCEPTIONS = new Map([]);

    const measured = new Set(
      [...pairs, ...scopedPairs].map(([background, foreground]) => `${background}|${foreground}`),
    );
    const uncovered = [];
    let considered = 0;
    for (const painted of paintedPairs(stylesCss)) {
      considered += 1;
      const key = `${painted.background}|${painted.foreground}`;
      if (measured.has(key)) continue;
      // An excuse is granted to PAINT SITES, never to a pair name.
      //
      // Keying it by name alone was this guard's own version of the bug it was
      // built to kill. The coverage sweep went sheet-wide, but the exception
      // mechanism had no notion of WHERE, so a new rule painting an excused pair
      // inherited the excuse. A reviewer defeated the whole file with one bare
      // declaration: adding `background: var(--green-soft)` to `.tasks-empty` —
      // the tasks-board empty state, rendered inside the board's own dark
      // palette — put real copy at 1.30:1 in dark while every check here stayed
      // green, because --green-soft|--muted-foreground was already excused for
      // a rule that renders somewhere else entirely. (That palette is deleted
      // and that pair now has a row; the mechanism the defeat exposed is what
      // is kept.)
      //
      // So the allow-list is the exact set of selectors painting the pair, and
      // it is asserted for equality below. A new painter is uncovered here; a
      // removed one is a stale entry there. Neither can pass as the other.
      const excused = EXCEPTIONS.get(key);
      if (excused && excused.selectors.includes(painted.selector)) continue;
      uncovered.push(`${key} painted by ${painted.selector}`);
    }
    expect([...new Set(uncovered)].sort()).toEqual([]);

    // The assertion above is vacuous over an empty set. Removing the filter took
    // away the cheap way to empty it, but not the only way — paintedPairs() can
    // still be made to return nothing at all — so the count stays part of the
    // claim. 112 rules match today.
    //
    // That is the fourth time in this one PR that a correct assertion had a soft
    // scope: a pinned row the code stopped consuming, a pinned table main()
    // stopped feeding, a pinned rule set the filter could empty, and a branch of
    // measure() nothing exercised. The pattern never varies — the thing asserted
    // was protected and the thing SELECTING what to assert over was not.
    expect(considered).toBeGreaterThanOrEqual(105);

    const paintedBy = new Map();
    for (const { background, foreground, selector } of paintedPairs(stylesCss)) {
      const key = `${background}|${foreground}`;
      if (!paintedBy.has(key)) paintedBy.set(key, new Set());
      paintedBy.get(key).add(selector);
    }

    for (const [key, { reason, selectors, failsIn }] of EXCEPTIONS) {
      // An exception has to stay a real pair. Left unchecked, the list would
      // outlive the rule it excuses and start silencing a row nobody painted.
      expect(paintedBy.has(key), `${key} is excused but no rule paints it`).toBe(true);
      expect(measured.has(key), `${key} is excused AND measured; drop the exception`).toBe(false);

      // The allow-list must be EXACTLY what the sheet paints — not a subset, not
      // a superset. This is the assertion that closes the defeat described above:
      // a new rule painting an excused pair changes this set and is red here even
      // when the coverage loop has already skipped it.
      expect(
        [...paintedBy.get(key)].sort(),
        `${key}'s excused paint sites no longer match the sheet; re-argue the exception`,
      ).toEqual([...selectors].sort());

      // And it has to still NEED excusing. Without this, the ledger is simply a
      // polite way to delete coverage: add a key, and a pair that would have
      // passed on its own merits stops being measured with no visible cost.
      const [background, foreground] = key.split("|");
      const measurements = ratiosFor({ tokens: tokensCss, styles: stylesCss }, background, foreground);

      // An UNMEASURABLE pair is not a failing one. Coercing a resolver error to 0
      // made "this name does not exist" satisfy "this pair misses its bar", so a
      // typo'd or deleted variable would have qualified for an excuse on the
      // strength of being unreadable. Errors disqualify rather than excuse.
      expect(
        measurements.filter(({ error }) => error).map(({ scope, error }) => `${scope}: ${error}`),
        `${key} cannot be resolved, so it cannot be shown to fail; fix the name`,
      ).toEqual([]);

      // WHICH scopes fail, not merely THAT one does.
      //
      // `worst < 4.5` was the previous form of this check, and it was the same
      // soft-scope bug the rest of this file exists to kill: it asked whether
      // the pair failed anywhere, so an excuse argued about one scope kept
      // covering the pair after it began failing in a different one. Three of
      // the five entries here are excused specifically because the scope they
      // fail in is unreachable — a claim that says nothing at all about the
      // scopes they DO reach, and that a floor cannot tell apart from a real
      // regression appearing in one of them.
      //
      // Set-equality reads both directions. A pair that starts failing in a new
      // scope is red because the measured set grew; a pair that stops failing in
      // a listed one is red because it shrank, which is the signal to drop the
      // entry and take the row.
      const failingScopes = measurements
        .filter(({ ratio }) => ratio < 4.5)
        .map(({ scope }) => scope)
        .sort();
      expect(
        failingScopes,
        `${key} fails in a different set of scopes than its excuse claims; re-argue it`,
      ).toEqual([...failsIn].sort());

      // And it must still fail SOMEWHERE. Without this, `failsIn: []` matched by
      // an all-passing measurement would be a self-consistent way to park a
      // healthy pair in the ledger and quietly stop measuring it.
      expect(
        failsIn.length,
        `${key} clears 4.5:1 in every scope; give it a row instead of an excuse`,
      ).toBeGreaterThan(0);

      // Every named scope has to be a scope the audit actually runs. A typo here
      // would otherwise sit in both the claim and nothing else, and the equality
      // above would fail for a reason nobody could read.
      expect(
        failsIn.filter((scope) => !scopes.some((s) => s.name === scope)),
        `${key} names a scope the audit does not measure`,
      ).toEqual([]);

      // The reason must carry the number it is asking to be forgiven. A prose
      // excuse ages into folklore; a ratio is checkable against the line above.
      expect(reason, `${key}'s reason states no measured ratio`).toMatch(/\d+\.\d\d:1/);
    }
  });

  it("keeps every paint value the derivation cannot read in an explicit ledger", () => {
    // The companion to the guard above, and the answer to its real weakness.
    // paintedPairs() can only derive a pair from a value it can resolve, so any
    // value it cannot parse removes that rule from the derived set — and the
    // only trace is the `considered` count ticking down by one, well inside the
    // floor. Three one-token edits each did it: `!important`, a var() fallback,
    // and a raw hex. All three left the audit at exit 0 and the suite green
    // while .task-editor rendered 1.66:1 in dark.
    //
    // Silent exclusion is the exact failure this library was rebuilt to refuse
    // — rootBlocks throws rather than skip what it cannot classify, because "a
    // checker that silently ignores the rule it cannot understand reports the
    // same exit code as one that verified it". This restores that property for
    // paint values: on the tasks board a text colour must be a bare var(), so a
    // rewrite into a form the derivation cannot see is red rather than quiet.
    //
    // This ran behind `/task/i` too, and leaving it there while the coverage
    // guard above went sheet-wide would have rebuilt the same hole one ring out:
    // a raw hex added anywhere OUTSIDE the tasks board would drop that pair from
    // the derived set with nothing watching. A widened coverage guard whose
    // exclusion check is still narrow is not widened.
    //
    // So both ledgers below are the whole sheet, exact and sorted. They are the
    // list of places this audit structurally cannot see, which makes it a thing
    // a reviewer can read rather than a property nobody has enumerated. A new
    // entry has to be added deliberately, and adding one is the moment to ask
    // whether the pair behind it still gets measured.
    const BARE_VAR = /^var\(\s*--[\w-]+\s*\)$/;
    const declarations = paintDeclarations(stylesCss);
    const ledgerFor = (property) => declarations
      .filter((d) => d.property === property)
      .filter((d) => !BARE_VAR.test(d.value))
      .map((d) => `${d.selector} { ${property}: ${d.value} }`)
      .sort();

    // Text colours. Every one of these is `inherit`, an `!important` override,
    // or a hardcoded hex on a surface this audit also cannot resolve — the
    // compass hero's gradient, the demo banner, the week hero's translucent
    // pill. None is on the tasks board, which is asserted from THIS list rather
    // than from a second filtered scan of the sheet: a derived assertion has no
    // filter of its own to empty.
    const NON_VAR_COLORS = [
      ".assistant .guide2-msg--user p { color: inherit }",
      ".auth-message { color: var(--notice-foreground) !important }",
      ".auth-message--error { color: var(--destructive) !important }",
      ".auth-message--success { color: var(--foreground) !important }",
      // The procedure board's card body paints its own bare-var pair; the
      // supporting line inside it inherits that ink rather than choosing a
      // second colour, so the pair the audit measures is still the card's.
        // Case dashboards: the tiles are links, and a link's ink is the tile's
      // ink. `inherit` is the only way to say that — a named token would have
      // to be re-chosen for every theme that repoints --card's foreground.
      ".cdash-bars__link { color: inherit }",
      // The data table inherits the tile's ink explicitly: Chromium's quirks-
      // mode table colour reset would otherwise paint the theme's body ink.
      ".cdash-chart__data table { color: inherit }",
      ".cdash-columns { color: inherit }",
      ".chapter-rail__abbr { color: inherit }",
      ".desktop-rail__ainame { color: inherit }",
      ".desktop-rail__user-name { color: #eaf3ee }",
      ".gq-assignment__confirm { color: var(--ink) !important }",
      ".gq-write__confirm { color: var(--ink) !important }",
      // #7701: the citation control inherits. Its title and reference set
      // --ink and --muted-foreground themselves, which the pair audit reads.
      ".guide2-msg__source-open { color: inherit }",
      ".home-vote-hero h2 { color: inherit }",
      ".inbox-filters button[aria-pressed=\"true\"] b { color: inherit }",
      ".kan-cal__day { color: inherit }",
      ".kan-card__circle { color: inherit }",
      ".kan-card__title { color: inherit }",
      ".kan-listrow__title { color: inherit }",
      ".learn-hero__title { color: inherit }",
      ".mevents-chip--nextup { color: #ffd98a }",
      ".mforms-btn--primary { color: #fff }",
      ".morehub-row { color: inherit }",
      ".notification-open { color: inherit }",
      ".setin-row { color: inherit }",
      ".voting-btn--green { color: #fff }",
      ".voting-chip--crunch { color: #b23b24 }",
      ".voting-chip--pulse { color: #6845b8 }",
      ".voting-done-strip__check { color: #fff }",
      ".voting-extra__submit { color: #fff }",
      ".voting-hero__countdown { color: #fff }",
      ".voting-hero__title { color: inherit }",
      ".voting-option__dot { color: #fff }",
      ".voting-suggest__send { color: #fff }",
      ".voting-voted-head__seal { color: #fff }",
      // Mobile cards Rev 5: the widget preview rows became buttons; like the
      // base button rule below, the row button inherits the tile's ink rather
      // than choosing a colour of its own.
      ".workwidget__rowbtn { color: inherit }",
      // Printed charts intentionally use black ink on white (21:1), independent
      // of screen themes. org-chart-baseline-reflow-browser.test.js measures
      // the rendered print pair and retains EN/ES Letter PDFs.
      "button { color: inherit }",
      "html:has(.orgstructure), body:has(.orgstructure), body:has(.orgstructure) *, body:has(.orgstructure) *::before, body:has(.orgstructure) *::after { color: #000 !important }",
    ];
    expect(ledgerFor("color")).toEqual(NON_VAR_COLORS);

    // Backgrounds genuinely cannot all be bare names — a knocked-out surface, a
    // gradient, a translucent scrim are all real things CSS does that a custom
    // property cannot express — so they get a list rather than a rule.
    //
    // The kanban wave is why the list grew: status IS the card colour there, and
    // the dark card is the prototype's two-stop diagonal gradient, so four
    // .kan-card rules are unreadable to paintedPairs() by construction. Their
    // pairs are NOT unmeasured because of it — scripts/contrast-audit.mjs carries
    // an explicit row for each `s1`/`ink`, `s1`/`muted` and `s2`/`ink`
    // combination. A background that cannot be derived has to be argued for
    // by hand, and that is what those rows are.
    const NON_VAR_BACKGROUNDS = [
      ".assistant .compass-starters button { background: transparent }",
      // #9563 scroll cues: canvas-coloured covers that ride with the content
      // over a thin edge shadow that stays put, so the shadow shows only at
      // an edge with more to scroll. The ground the text is read on stays
      // var(--canvas), the panel's own audited surface.
      ".assistant .guide2-composer > .compass-chips:not(.compass-mode) { background: linear-gradient(var(--canvas) 30%, transparent) top / 100% 24px no-repeat local, linear-gradient(transparent, var(--canvas) 70%) bottom / 100% 24px no-repeat local, radial-gradient(farthest-side at 50% 0, rgba(13, 36, 30, .2), transparent) top / 100% 10px no-repeat scroll, radial-gradient(farthest-side at 50% 100%, rgba(13, 36, 30, .2), transparent) bottom / 100% 10px no-repeat scroll }",
      ".assistant .guide2-composer { background: transparent }",
      ".assistant .guide2-input { background: transparent }",
      // #9563 scroll cue, the same recipe as above.
      ".assistant > .assistant-chat { background: linear-gradient(var(--canvas) 30%, transparent) top / 100% 32px no-repeat local, linear-gradient(transparent, var(--canvas) 70%) bottom / 100% 32px no-repeat local, radial-gradient(farthest-side at 50% 0, rgba(13, 36, 30, .22), transparent) top / 100% 12px no-repeat scroll, radial-gradient(farthest-side at 50% 100%, rgba(13, 36, 30, .22), transparent) bottom / 100% 12px no-repeat scroll }",
      ".assistant-history > button { background: transparent }",
      ".auth-switch { background: transparent }",
      ".bevoice-again { background: transparent }",
      ".bottom-nav a, .bottom-nav button { background: transparent }",
      ".brand-home { background: transparent }",
      ".cam-dialog-layer { background: color-mix(in srgb, var(--foreground) 42%, transparent) }",
      // The glass chrome family (2026-08-07 chrome-free wave): translucent
      // mixes of already-audited surfaces — the effective grounds stay the
      // card/canvas pairs.
      // Mobile cards Rev 5 (2026-08-08): the side drawers went FLAT — plain
      // var(--canvas), which the derivation reads, so their old glass mixes
      // and gradient seams left this ledger. What remains translucent is the
      // bared function list and the row buttons inheriting their tile's
      // audited ground. The foot's fade left too (#9543, B-35): the foot is a
      // plain var(--canvas) band now.
      ".card-nav__desk { background: color-mix(in srgb, var(--card) 58%, transparent) }",
      ".card-nav__hat select { background: color-mix(in srgb, var(--card) 58%, transparent) }",
      ".card-nav__panel .morehub-list { background: transparent }",
      ".card-nav__skip--menu { background: color-mix(in srgb, var(--card) 58%, transparent) }",
      // The board card's drag handle is a knocked-out control sitting on the
      // card it belongs to, so it paints no surface of its own and its ink is
      // measured against the card's --casework-surface.
      ".case-list__open { background: transparent }",
      ".case-list__sort { background: transparent }",
      ".chapter-rail__abbr { background: transparent }",
      // UB-NAV-03 palette: the scrim derives from the audited foreground and
      // the input deliberately inherits its audited semantic input surface.
      ".command-palette__backdrop { background: color-mix(in srgb, var(--foreground) 42%, transparent) }",
      ".command-palette__search input { background: transparent }",
      ".companion-phone { background: transparent }",
      ".companion-phone__app { background: transparent }",
      ".compass-briefing__toggle { background: transparent }",
      // The phone chip's dot inherits the chip's own --accent-foreground text
      // color (UB-DEMO-02) — currentColor cannot drift from the audited
      // accent pair the chip paints, which is why no new contrast row exists.
      ".demo-chip__dot { background: currentColor }",
      ".demo-welcome-layer { background: color-mix(in srgb, var(--foreground) 72%, transparent) }",
      ".desktop-rail { background: linear-gradient(180deg, var(--rail-surface-start), var(--rail-surface-end)) }",
      // The green desktop rail (REQ-UG-DESKTOP-RAIL-GREEN-THEME-GUIDE-20261112):
      // the guide's pine-to-green fade over a solid Union green, measured at
      // both ends (--rail-surface-start and --rail-surface-end rows in the audit).
      ".desktop-rail[data-workspace-theme=\"union-ground\"] { background: linear-gradient(180deg, var(--rail-surface-start) 0, var(--rail-surface-end) 240px) var(--rail-surface-end) }",
      // The guide's Side rail in every detail (UX-UG-DESKTOP-RAIL-MATCH-THEME-GUIDE-SIDE-RAIL-20261113):
      // the fold pill darkens a touch under the pointer, and a faint rail-line
      // divider marks each later group of the folded rail. Neither carries text.
      // The bell and the fold control are 44px targets that draw their smaller
      // outline and pill inside, so the targets themselves are transparent.
      ".desktop-rail[data-workspace-theme=\"union-ground\"][data-render-mode=\"desktop\"] .desktop-rail__bell { background: transparent }",
      ".desktop-rail[data-workspace-theme=\"union-ground\"][data-render-mode=\"desktop\"] .desktop-rail__collapse { background: transparent }",
      ".desktop-rail[data-workspace-theme=\"union-ground\"][data-render-mode=\"desktop\"] .desktop-rail__collapse:hover::before { background: color-mix(in srgb, var(--sg-light-card) 90%, var(--sg-light-ink) 10%) }",
      ".desktop-rail[data-workspace-theme=\"union-ground\"][data-render-mode=\"desktop\"][data-collapsed=\"true\"] .desktop-rail__items > .desktop-rail__grouplabel:not(:first-child) + .desktop-rail__row::before { background: color-mix(in srgb, var(--rail-line) 70%, transparent) }",
      ".desktop-rail__bell { background: rgba(255,255,255,.07) }",
      ".desktop-rail__items:not(.desktop-rail__items--foot)::before { background: linear-gradient(var(--rail-surface-end), transparent) }",
      ".desktop-rail__user { background: rgba(255,255,255,.05) }",
      ".desktop-rail__user--button:hover { background: rgba(255,255,255,.1) }",
      ".dialog-backdrop { background: rgba(11, 28, 23, .42) }",
      ".dot--blue { background: #1b74b8 }",
      ".dot--gold { background: #9b6d0b }",
      ".guide-dialog header button { background: transparent }",
      // #7701: the citation control is the row. Resting fill is the list card.
      ".guide2-msg__source-open { background: transparent }",
      ".home-action-row__cta { background: none }",
      ".home-allevents { background: none }",
      ".home-event { background: none }",
      // The glass chrome family (2026-08-07 chrome-free wave): translucent
      // mixes of the card surface over the porcelain canvas — the effective
      // ground stays the audited card/canvas pair.
      ".home-orb { background: color-mix(in srgb, var(--card) 58%, transparent) }",
      ".home-quorum__track span { background: linear-gradient(90deg, var(--home-quorum-fill-start), var(--sg-color-gold)) }",
      ".home-vote-hero { background: radial-gradient(130% 120% at 100% -10%, rgba(244,197,108,.18), transparent 55%), linear-gradient(150deg, var(--sg-color-green), var(--home-vote-grad-end)) }",
      ".home-vote-hero__later { background: none }",
      ".hub2-rowbtn { background: transparent }",
      ".hub2-rowbtn:hover { background: rgba(20,32,28,.03) }",
      ".hub2-tab { background: transparent }",
      ".inbox-msg-actions button, .inbox-msg-actions select { background: transparent }",
      ".inbox-row { background: transparent }",
      ".inbox-scheduled__cancel { background: transparent }",
      ".inbox-search input { background: transparent }",
      ".inbox-sect__action { background: none }",
      ".inbox-showall { background: none }",
      ".kan-avatars > button, .kan-avatars .kan-pick > button { background: none }",
      ".kan-cal__day { background: none }",
      ".kan-card__circle { background: none }",
      ".kan-card__title { background: none }",
      ".kan-checkrow { background: none }",
      ".kan-checkrow__box { background: none }",
      ".kan-deprow__x { background: none }",
      ".kan-desc__addbtn { background: transparent }",
      ".kan-disclosure { background: none }",
      ".kan-donehidden { background: none }",
      ".kan-files__attach { background: transparent }",
      ".kan-files__open { background: transparent }",
      ".kan-focus-bar__chip { background: none }",
      ".kan-iconbtn--bare { background: none }",
      ".kan-modal-backdrop { background: rgba(0, 0, 0, .62) }",
      ".kan-popover__clear { background: none }",
      ".kan-popover__members button { background: none }",
      ".kan-popover__opt { background: none }",
      ".kan-records__list button { background: none }",
      ".kan-search input { background: none }",
      ".kan-seg button { background: none }",
      ".kan-title { background: none }",
      ".kan-topbar { background: var(--canvas, var(--kan-canvas)) }",
      ".kan-views :is(button, a) { background: none }",
      ".kan-views :is(button, a):is([aria-pressed=\"true\"], [aria-selected=\"true\"], [aria-current=\"page\"]) { background: none }",
      ".kan-watch { background: transparent }",
      ".kan-ws-head { background: var(--canvas, var(--kan-canvas)) }",
      ".kan-ws-head__focus { background: none }",
      ".learn-back { background: transparent }",
      ".learn-dhero { background: radial-gradient(130% 120% at 100% -10%, rgba(239,167,56,.16), transparent 55%), linear-gradient(140deg, var(--sg-color-forest), var(--hero-green-deep)) }",
      ".learn-hero { background: radial-gradient(130% 120% at 100% -10%, rgba(244,197,108,.18), transparent 55%), linear-gradient(150deg, var(--sg-color-green), var(--learn-grad-green)) }",
      ".learn-pays { background: linear-gradient(180deg, var(--learn-sheen), var(--learn-sheen-2)) }",
      ".learn-say__copy { background: rgba(242,242,242,.12) }",
      ".learn-search input { background: transparent }",
      ".learn-stat { background: linear-gradient(180deg, var(--learn-sheen), var(--sg-color-card)) }",
      ".learn-step__dot { background: transparent }",
      ".m-card.mforms-shell { background: linear-gradient(180deg, #fefefe, var(--card)) }",
      ".mappt-btn--ghost { background: transparent }",
      ".mcases-case__title { background: none }",
      ".mcases-desk__title { background: none }",
      ".mcases-ghost { background: transparent }",
      ".mcases-panel__row { background: none }",
      ".mevents-btn--onhero { background: rgba(255, 255, 255, .12) }",
      ".mevents-chip--nextup { background: rgba(239, 167, 56, .2) }",
      ".mevents-linkbtn { background: transparent }",
      ".mevents-list-card, .mevents-card, .mevents-history__toggle { background: linear-gradient(180deg, color-mix(in srgb, var(--card) 99%, var(--card-foreground)), var(--card)) }",
      ".mfa-qr { background: #fff }",
      ".mfa-turn-off__open { background: none }",
      ".mforms-chip { background: rgba(239, 167, 56, .22) }",
      // The hat-only member header (owner feedback 2026-08-05): the pill
      // floats alone on the page canvas, so the strip itself paints nothing —
      // the select inside it keeps the audited card-on-canvas pair.
      ".mobile-top--hat-only { background: transparent }",
      ".morehub-row { background: none }",
      ".morehub-toggle { background: transparent }",
      ".mwl-checkrow { background: none }",
      ".mwl-tab { background: transparent }",
      ".notification-open { background: none }",
      ".phone-frame__hw { background: #14503f }",
      ".phone-frame__hw--mute { background: #efa738 }",
      ".phone-frame__notch { background: #0a0d10 }",
      ".phone-frame__screen { background: transparent }",
      ".phone-frame__statusbar { background: transparent }",
      ".reports-detail__back { background: none }",
      ".reports-editbar { background: rgba(239, 167, 56, 0.15) }",
      ".search-box input { background: transparent }",
      ".segment button { background: transparent }",
      ".setin-quiet-check input[type=\"checkbox\"], .mappt-toggle input[type=\"checkbox\"] { background: transparent }",
      ".setin-row { background: none }",
      ".sg-app--desktop .tasks-screen--desktop-work .kan-timeline__open { background: transparent }",
      ".sg-app--desktop .tasks-screen--desktop-work .tasks-field-notes__index button { background: transparent }",
      ".sg-app--desktop.sg-app--tasks { background: var(--canvas, var(--kan-canvas)) }",
      ".sg-app--tablet.sg-app--tasks { background: var(--canvas, var(--kan-canvas)) }",
      ".sg-app[data-workspace-theme=\"union-ground\"] .home-vote-hero { background: radial-gradient(130% 120% at 100% -10%, color-mix(in srgb, var(--sg-color-card) 55%, transparent), transparent 55%), var(--sg-color-purple-soft) }",
      ".sg-app[data-workspace-theme=\"union-ground\"] .voting-hero { background: radial-gradient(130% 120% at 100% -10%, var(--ledger-gold-veil), transparent 55%), linear-gradient(150deg, var(--ledger-plum), var(--ledger-aubergine)) }",
      ".sg-switch { background: none }",
      ".sgauth-back { background: transparent }",
      // UB-UG-WEB-SIGNIN-QUIET-UNTIL-NEEDED-20261108: the card's
      // language switch is two words on the card, no track.
      ".sgauth-column .auth-language button[aria-pressed=\"true\"] { background: transparent }",
      ".sgauth-column .auth-language { background: transparent }",
      ".sgauth-password-toggle { background: transparent }",
      ".standalone-shell > .standalone-language-bar .auth-language { background: transparent }",
      // The compact step-up inherits the enclosing Dialog's semantic card.
      ".task-confirm__keep { background: none }",
      ".task-editor-backdrop { background: rgba(0, 0, 0, .62) }",
      ".task-editor__delete { background: none }",
      // The decorative sibling paints the arc; the label has an opaque panel.
      ".tasks-progress-ring__art { background: conic-gradient(var(--accent) var(--task-progress), var(--primary-deep) 0) }",
      ".tasks-report__controls button { background: transparent }",
      ".tasks-screen .kan-swipe-hint { background: var(--canvas, var(--kan-canvas)) }",
      ".tasks-screen { background: var(--canvas, var(--kan-canvas)) }",
      ".timeline-row__label > button { background: transparent }",
      ".tour-layer { background: color-mix(in srgb, var(--foreground) 76%, transparent) }",
      ".tour-layer--focused { background: transparent }",
      // Decorative foreground overlay; the composite contrast is measured below.
      ".ug-hover-list::after { background: color-mix(in srgb, var(--foreground) 4%, transparent) }",
      ".voting-chip--crunch { background: #ffe3dc }",
      ".voting-chip--pulse { background: #ece5f7 }",
      ".voting-done-strip { background: #eaf4ee }",
      ".voting-hero { background: radial-gradient(130% 120% at 100% -10%, rgba(244,197,108,.18), transparent 55%), linear-gradient(150deg, var(--sg-color-green), var(--voting-grad-green)) }",
      ".voting-hero__docs { background: rgba(242,242,242,.08) }",
      ".voting-hero__reject { background: transparent }",
      ".voting-openvote__title { background: none }",
      ".voting-option__dot { background: transparent }",
      ".voting-quorum-row { background: none }",
      ".voting-tab { background: transparent }",
      ".voting-tabs { background: var(--sg-color-track, var(--track)) }",
      ".workwidget__handle { background: none }",
      ".workwidget__open { background: none }",
      ".workwidget__rowbtn { background: none }",
      // The same print-only 21:1 pair recorded in NON_VAR_COLORS above.
      "button.kan-newtask { background: none }",
      "html:has(.orgstructure), body:has(.orgstructure), body:has(.orgstructure) *, body:has(.orgstructure) *::before, body:has(.orgstructure) *::after { background: #fff !important }",
    ];
    expect(ledgerFor("background")).toEqual(NON_VAR_BACKGROUNDS);

    // There was a third assertion here, deriving "which of these are on the tasks
    // board" from the pinned lists with /(^|[^-\w])\.?(task|timeline)/i. It is
    // gone, because it leaked in precisely the way the /task/i it replaced did:
    // `[^-\w]` excludes any hyphen-joined compound, so the calendar view's own
    // rules — .calendar-task, .calendar-task i, .calendar-task i span — read as
    // NOT tasks-board. Writing a third spelling-based predicate would be the same
    // mistake a third time.
    //
    // Nothing is lost by dropping it. EXACTNESS is the guard: both lists are
    // compared for equality, so a tasks-board colour that stops being a bare
    // var() cannot slip out of the derivation quietly — it has to be added here,
    // by hand, which is the moment to ask whether its pair is still measured.
    // An exact list needs no predicate to tell it what it contains.
    //
    // The floor guards the other end: an exact list also matches when the reader
    // that produced it has stopped reading anything at all.
    expect(declarations.length, "the paint reader returned almost nothing").toBeGreaterThanOrEqual(480);

    // Paint forms this reader does not model at all. background-image can repaint
    // a surface and -webkit-text-fill-color overrides text colour outright, and
    // NEITHER passes through paintDeclarations() — so a rule using one is
    // invisible to the pair derivation AND absent from both ledgers above. That
    // made the claim these lists are "everywhere the audit cannot see" false.
    // There are none today; pinning zero keeps it true, and makes introducing one
    // a decision rather than an accident.
    const UNMODELLED = ["background-image", "-webkit-text-fill-color"];
    const smuggled = UNMODELLED.flatMap((property) => {
      const pattern = new RegExp(`(?:^|;|\\{)\\s*${property}\\s*:`, "g");
      return [...stripComments(stylesCss).matchAll(pattern)].map(() => property);
    });
    expect(
      smuggled,
      "a paint form the derivation cannot read entered the sheet; teach the reader or ledger it",
    ).toEqual([]);
  });

  it("keeps row text readable beneath the decorative hover overlay in every theme", () => {
    const rows = measure({ tokens: tokensCss, styles: stylesCss });
    const pairs = new Set([
      "--background/--foreground", "--card/--card-foreground",
      "--primary/--primary-foreground", "--secondary/--secondary-foreground",
      "--muted/--muted-foreground", "--card/--muted-foreground",
    ]);
    const rgb = (hex) => hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
    const luminance = (channels) => channels
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    // The pseudo-element paints above the row, so both text and background
    // receive its 4% foreground tint. Audit the actual composite, not opacity
    // as though it were a background-only surface.
    for (const row of rows.filter((entry) => pairs.has(`${entry.backgroundVar}/${entry.foregroundVar}`))) {
      const ink = rows.find((entry) => entry.scope === row.scope && entry.backgroundVar === "--background" && entry.foregroundVar === "--foreground");
      const tint = rgb(ink.foreground);
      const composite = (hex) => rgb(hex).map((channel, index) => channel * 0.96 + tint[index] * 0.04);
      const background = luminance(composite(row.background));
      const foreground = luminance(composite(row.foreground));
      const ratio = (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
      expect(ratio, `${row.scope}: ${row.backgroundVar}/${row.foregroundVar}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("runs the UNSCOPED rows in every scope too, not only in the bare one", () => {
    // The mirror of "runs the scoped rows in every scope that has an overlay",
    // and its absence was G6 recurring inside the PR that documents G6 as its
    // lesson. measure() picks rows with
    //     overlays.length === 0 ? pairs : [...pairs, ...scopedPairs]
    // and only the half that ADDS scopedPairs was pinned. Narrowing the other
    // branch to `scopedPairs` drops all 29 unscoped rows — every dark-scope fix
    // this PR makes, plus all ten derived rows — from the tasks and dark scopes,
    // with the audit at exit 0 and 41/41 green.
    //
    // Twice now the pinned thing was correct and the thing SELECTING what to
    // pin was not. A conditional has two branches; guarding one of them is not
    // guarding the conditional.
    const rows = measure({ tokens: tokensCss, styles: stylesCss });
    for (const { name } of scopes) {
      const present = new Set(
        rows.filter((row) => row.scope === name).map((row) => `${row.backgroundVar}|${row.foregroundVar}`),
      );
      const missing = pairs
        .map(([background, foreground]) => `${background}|${foreground}`)
        .filter((key) => !present.has(key));
      expect(missing, `scope "${name}" does not run every unscoped row`).toEqual([]);
    }
  });

  it("keeps a row for every status carrier, on every surface it lands on", () => {
    // scopedPairs is the only thing measuring the --task-status-* carriers, and
    // deleting a row from it is invisible to every ratio test above.
    //
    // The surfaces are asserted because the first version of this table put all
    // four carriers on --card, which is the backdrop for exactly one of the
    // three places they render. Reading the sheet did not catch that; measuring
    // the live preview did. .task-column is --card-2, .calendar-task is
    // --status-surface, and only .tasks-calendar__legend inherits --card.
    const measured = new Set(scopedPairs.map(([background, foreground]) => `${background}|${foreground}`));
    for (const status of ["backlog", "in-progress", "review", "done"]) {
      const carrier = `--task-status-${status}`;
      for (const surface of ["--card-2", "--status-surface"]) {
        expect(
          measured.has(`${surface}|${carrier}`),
          `${carrier} is painted on ${surface} and no scoped row measures it`,
        ).toBe(true);
      }
    }
    // The legend renders only these two.
    expect(measured.has("--card|--task-status-in-progress")).toBe(true);
    expect(measured.has("--card|--task-status-review")).toBe(true);
  });

  it("holds every scoped row to the non-text bar, never to a softer one", () => {
    // All ten are 3-9px graphical objects. A row here quietly written at 1.5
    // would pass a dot nobody can see.
    for (const [background, foreground, minimum] of scopedPairs) {
      expect(minimum, `${background}/${foreground}`).toBe(3);
    }
  });

});

describe("the audit stays wired up", () => {
  // Before this pass `contrast-audit` appeared exactly once in the whole repo,
  // in package.json. Deleting it from the check chain retired the only guard on
  // every colour pair with nothing anywhere to notice.
  it("is still a link in the check chain", () => {
    expect(packageJson.scripts.check).toContain("npm run contrast:audit");
    expect(packageJson.scripts["contrast:audit"]).toContain("scripts/contrast-audit.mjs");
  });

  it("audits every alias this pass moved", () => {
    // Against the imported table, not a substring search of the file's source.
    // The text form asked whether a NAME APPEARS anywhere between "const pairs
    // = [" and the first "];" — which a description string satisfies, and which
    // says nothing about whether the name is an operand of a row that runs.
    const measured = new Set(pairs.flatMap(([background, foreground]) => [background, foreground]));
    const unaudited = Object.keys(ALIASED).filter((name) => !measured.has(name));
    expect(
      unaudited,
      "each alias listed here was re-pointed with no contrast row measuring it, " +
        "so the next repoint moves it silently. Add a pair before moving one.",
    ).toEqual([]);
  });

  it("keeps the pairs it already measures", () => {
    // A floor plus an explicit list, because deleting a row is invisible: the
    // audit iterates the table, so a pair that is not in it is not measured, and
    // removing the --input/--foreground row let search-input text go 16.76:1 ->
    // 1.44:1 with the suite green and the audit exiting 0. Named pairs are the
    // ones whose loss is silent rather than obvious.
    const measured = new Set(pairs.map(([background, foreground]) => `${background} on ${foreground}`));
    const REQUIRED = [
      "--background on --foreground",
      "--card on --card-foreground",
      "--input on --foreground",
      "--muted on --muted-foreground",
      "--border on --background",
      "--ring on --background",
      "--status-surface on --status-foreground",
      "--success on --success-foreground",
      "--card on --success",
      // The dark-scope pass. Each of these is the only row measuring a pair a
      // rule really paints; deleting one is invisible to every ratio assertion
      // in this file, because those resolve tokens and stay green whether or
      // not a row is measuring them.
      "--hero-surface on --hero-ink",
      "--hero-surface on --accent",
      "--hero-surface on --primary-muted-foreground",
      "--accent on --primary-deep",
      "--green-soft on --priority-low-ink",
      // The derived rows. These are not here because someone judged them risky
      // — they are every pair a .task* rule paints in one block that had no row,
      // enumerated by paintedPairs(). --canvas/--ink is the one that matters
      // most: it is the board's entire base text pair, re-pointed by the dark
      // block this pass edits, and it measured nothing until now.
      "--canvas on --ink",
      "--canvas on --gold-ink",
      "--card on --ink",
      "--card-2 on --ink",
      "--input on --ink",
      "--track on --ink",
      "--card on --muted-foreground",
      "--card-2 on --muted-foreground",
      "--track on --muted-foreground",
      "--card on --destructive",
      "--notice on --notice-foreground",
      "--rail-mark on --rail-mark-foreground",
      "--rail-control on --rail-control-foreground",
      "--rail-popover on --rail-popover-foreground",
      "--rail-surface-start on --rail-control-border",
      "--rail-surface-end on --rail-control-border",
      "--rail-control on --rail-control-border",
      "--rail-popover on --rail-control-border",
      "--rail-control on --rail-focus",
      "--rail-popover on --rail-focus",
      // The sheet-wide rows. Same derivation, with the `/task/i` filter that
      // scoped it removed — the filter could be emptied AND it leaked, missing
      // the board's own timeline rules. These nine already cleared their bar in
      // every scope; naming them here is what stops a later edit from quietly
      // dropping the rows that prove it.
      "--card on --foreground",
      "--card-2 on --foreground",
      "--muted on --foreground",
      "--card on --green",
      "--card on --terra",
      "--green on --primary-foreground",
      "--input on --muted-foreground",
      "--disabled on --disabled-foreground",
      "--toast on --toast-foreground",
      "--card on --primary",
      "--card-2 on --card-foreground",
      // The three that were parked in the exception ledger on a reachability
      // argument until the scope they failed in was deleted (2026-07-28). Named
      // here for the same reason as everything above: an ex-exception that took
      // a row is exactly the kind of row a later edit drops as redundant, and
      // dropping it returns the pair to being painted and unmeasured — which is
      // where all three started.
      "--green-soft on --muted-foreground",
      "--green-soft on --green",
      "--primary-deep on --primary-foreground",
    ];
    expect(REQUIRED.filter((pair) => !measured.has(pair))).toEqual([]);
    expect(pairs.length).toBeGreaterThanOrEqual(REQUIRED.length);
  });

  it("states every minimum as a WCAG threshold, never a number that fits", () => {
    // 4.5 = 1.4.3 body text, 3 = 1.4.11 non-text UI, 7 = AAA. Nothing else.
    // Lowering the --accent row's minimum from 4.5 to 1 let accent-on-accent
    // print 1.00:1 PASS — literally invisible text, reported as compliant.
    // Constraining the vocabulary means a relaxed bar has to be argued as a
    // change of standard, not typed as a digit.
    const WCAG = new Set([3, 4.5, 7]);
    const offenders = pairs
      .filter(([, , minimum]) => !WCAG.has(minimum))
      .map(([background, foreground, minimum]) => `${background}/${foreground} demands ${minimum}:1`);
    expect(
      offenders,
      "a minimum outside {3, 4.5, 7} is a bar chosen to fit the value we have.",
    ).toEqual([]);
  });

  it("keeps every row well-formed and pointing at names that exist", () => {
    const declared = collectVars([tokensCss, stylesCss]);
    const broken = pairs.flatMap(([background, foreground, minimum, usage]) => {
      const problems = [];
      for (const name of [background, foreground]) {
        if (!declared.has(name)) problems.push(`${name} is not declared in any :root`);
      }
      if (typeof minimum !== "number") problems.push(`${background}/${foreground} minimum is not a number`);
      if (!usage) problems.push(`${background}/${foreground} has no usage note`);
      return problems;
    });
    expect(broken).toEqual([]);
  });

  it("audits Field Notes placeholder and resting textarea boundary usages", () => {
    const usages = pairs.map(([, , , usage]) => usage);
    expect(usages.some((usage) => /Field Notes/i.test(usage) && /placeholder/i.test(usage))).toBe(true);
    expect(usages.some((usage) => /Field Notes/i.test(usage) && /textarea boundary/i.test(usage))).toBe(true);
    const textarea = stylesCss.match(
      /\.sg-app--desktop \.tasks-screen--desktop-work \.tasks-field-notes__composer textarea \{[\s\S]*?\}/,
    );
    expect(textarea?.[0]).toContain("border: 1px solid var(--kan-muted)");
    expect(textarea?.[0]).toContain("background: var(--kan-card)");
    expect(textarea?.[0]).not.toContain("border: 1px solid var(--kan-line)");
    const placeholder = stylesCss.match(
      /\.sg-app--desktop \.tasks-screen--desktop-work \.tasks-field-notes__composer textarea::placeholder \{[\s\S]*?\}/,
    );
    expect(placeholder?.[0]).toContain("color: var(--kan-muted)");
    expect(placeholder?.[0]).toContain("opacity: 1");
  });
});

describe("aliases whose only guard was a comment", () => {
  const vars = collectVars([stylesCss]);

  // Three :root names carry a comment predicting what a plausible "tidying"
  // repoint would cost, and nothing but the comment stopped it. A comment that
  // states a ratio is a testable claim; leaving it as prose means the first
  // person to disagree with it wins silently. None of these can become a
  // contrast row: --terra on --terra-soft is 4.12:1 TODAY and is filed as
  // upstream-blocked, so a row at the 4.5 it owes would red the build for a
  // defect this PR cannot fix. A name pin holds the line without pretending
  // the pair passes.
  const PINNED = {
    "--terra": "var(--destructive)",
    "--notice": "#fff4d8",
    "--notice-foreground": "#704700",
  };

  it("holds each one at the value its comment argues for", () => {
    const moved = Object.entries(PINNED)
      .filter(([name, value]) => vars.get(name) !== value)
      .map(([name, value]) => `${name} should be ${value}, is ${vars.get(name)}`);
    expect(
      moved,
      "each of these has a comment in src/styles.css predicting the cost of moving it: " +
        "--terra -> --sg-color-terra drops terra/terra-soft 4.21:1 -> 3.47:1; the notice " +
        "pair -> the warn ramp collapses 7.41:1 -> 3.26:1; --task-status-backlog -> " +
        "--sg-color-border takes a 4px border-left on .task-card 7.46:1 -> 1.53:1. " +
        "If one of these should move, move the comment and this pin with it.",
    ).toEqual([]);
  });

  it("holds --task-status-backlog, which is not in :root at all", () => {
    // The alias src/styles.css's --status-foreground comment leans on for its
    // WCAG 1.4.11 argument is declared by `.tasks-screen`, a SCOPED block, so a
    // :root-only reader returns undefined for it — the first version of this
    // pin passed `undefined !== the expected value` straight into a failure and
    // that is how the gap surfaced. Repointing it to --sg-color-border takes the
    // 4px border-left on .task-card from 7.46:1 to 1.53:1 with nothing else in
    // the repo measuring it.
    expect(scopedVars(stylesCss, ".tasks-screen").get("--task-status-backlog")).toBe(
      "var(--status-foreground)",
    );
  });

  it("keeps every --task-status-* carrier pointed at a name, not a hex", () => {
    // All four are painted as 3-9px non-text indicators by .task-status-dot,
    // .calendar-task and .task-card's border-left. They now have contrast rows
    // (scopedPairs), so a repoint is measured — but a raw hex would still be
    // drift away from the token set, which no ratio can object to.
    const scoped = scopedVars(stylesCss, ".tasks-screen");
    const carriers = [...scoped].filter(([name]) => name.startsWith("--task-status-"));
    expect(carriers.length).toBeGreaterThanOrEqual(4);
    expect(carriers.filter(([, value]) => !/^var\(--[\w-]+\)$/.test(value))).toEqual([]);
  });
});

describe("mobile task-toolbar flex contract", () => {
  it("keeps retained context controls from shrinking into each other", () => {
    expect(stylesCss).toMatch(/\.kan-topbar__context\s*>\s*\*\s*\{\s*flex:\s*0 0 auto;/);
    expect(stylesCss).toMatch(/\.kan-topbar__context\s*>\s*\.kan-search\s*\{\s*flex:\s*1 1 190px;/);
  });

  it("fills the mobile canvas without repeating the Tasks page header", () => {
    expect(stylesCss).toMatch(
      /\.mobile-top ~ main\.app-column--coordination\s*\{[^}]*height:\s*calc\(100dvh - 49px - max\(8px, env\(safe-area-inset-top, 0px\)\)\);[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;[^}]*padding-bottom:\s*0;[^}]*\}[\s\S]*?\.mobile-top ~ main \.tasks-screen\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;/,
    );
    expect(stylesCss).toMatch(
      /\.tasks-screen \.kan-viewstage\[data-view=["']report["']\]\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/,
    );
    expect(stylesCss).toMatch(
      /@media \(max-width: 720px\) \{[\s\S]*?\.tasks-screen > \.phead\s*\{[^}]*position:\s*absolute;[^}]*overflow:\s*hidden;[^}]*min-height:\s*0;[^}]*clip-path:\s*inset\(50%\);[^}]*clip:\s*rect\(0 0 0 0\);[^}]*width:\s*1px;[^}]*height:\s*1px;/,
    );
  });

  it("keeps Kanban scrollers functional without painting scrollbar tracks", () => {
    expect(stylesCss).toMatch(/\.kan-topbar\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?scrollbar-width:\s*none;/);
    expect(stylesCss).toMatch(/\.kan-board\s*\{[\s\S]*?overflow-x:\s*auto;[\s\S]*?scrollbar-width:\s*none;/);
    expect(stylesCss).toMatch(/\.kan-focus-bar\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;/);
    expect(stylesCss).toMatch(/\.kan-topbar::-webkit-scrollbar,[\s\S]*?\.kan-board::-webkit-scrollbar,[\s\S]*?\.kan-focus-bar::-webkit-scrollbar,[\s\S]*?\.kan-list__scroll::-webkit-scrollbar\s*\{\s*display:\s*none;/);
  });

  it("uses a collapsible second row for mobile-only task tools", () => {
    expect(stylesCss).toMatch(/\.tasks-screen \.kan-topbar__primary\s*\{[^}]*overflow-x:\s*auto;[^}]*scrollbar-width:\s*none;/);
    expect(stylesCss).toMatch(/\.tasks-screen \.kan-topbar__secondary\s*\{[^}]*max-height:\s*0;[^}]*visibility:\s*hidden;/);
    // The open row wraps and takes its height from its content: a fixed px
    // ceiling plus overflow: visible would paint a third wrapped row over the
    // swipe hint and board rather than pushing them down.
    expect(stylesCss).toMatch(/\.tasks-screen \.kan-topbar__secondary\[data-expanded="true"\]\s*\{[^}]*flex-wrap:\s*wrap;[^}]*max-height:\s*none;[^}]*overflow:\s*visible;[^}]*visibility:\s*visible;/);
    expect(stylesCss).toMatch(/\.tasks-screen \.kan-board\s*\{\s*min-height:\s*0;\s*overflow-y:\s*auto;/);
  });

  it("boxes report metrics and removes the list's redundant outer line", () => {
    expect(stylesCss).toMatch(/\.sg-app--desktop\.sg-app--tasks\s*\{\s*background:\s*var\(--canvas, var\(--kan-canvas\)\);/);
    expect(stylesCss).toMatch(/\.tasks-summary__metric\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--kan-line\), var\(--sg-shadow-tonal\);/);
    expect(stylesCss).toMatch(/\.kan-list__scroll\s*\{[^}]*border:\s*0;[^}]*scrollbar-width:\s*none;/);
  });
});

describe("desktop Messages panel scrolling contract", () => {
  it("keeps first-use filters reachable through one panel-level vertical scroller", () => {
    const panel = stylesCss.match(/\.inbox-screen--split \.inbox-panel\s*\{([^}]*)\}/)?.[1] || "";
    const list = stylesCss.match(/\.inbox-screen--split \.inbox-scroll\s*\{([^}]*)\}/)?.[1] || "";

    expect(panel).toMatch(/max-height:\s*calc\(100dvh - 36px\)/);
    expect(panel).toMatch(/overflow-x:\s*hidden/);
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(panel).not.toMatch(/(?:^|;)\s*overflow:\s*hidden/);
    expect(list).toMatch(/flex:\s*none/);
    expect(list).toMatch(/overflow-y:\s*visible/);
    expect(list).not.toMatch(/overflow-y:\s*auto/);
  });
});

describe("appointment availability switch geometry", () => {
  it("keeps the 48x44 switch control from inheriting the generic form-field height and paints its 46x26 track on ::before", () => {
    expect(stylesCss).toMatch(
      /\.mappt-toggle input\[type="checkbox"\]\s*\{[^}]*width:\s*48px;[^}]*height:\s*44px;[^}]*min-height:\s*0;/,
    );
    expect(stylesCss).toMatch(
      /\.mappt-toggle input\[type="checkbox"\]::before\s*\{[^}]*width:\s*46px;[^}]*height:\s*26px;/,
    );
  });
});
