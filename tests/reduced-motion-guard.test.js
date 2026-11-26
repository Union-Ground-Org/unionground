import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every animation and transition src/motion.css introduces is cancelled by one
// universal block in src/styles.css. That makes the block load-bearing far
// beyond the rules that sit next to it: narrow it to a scope, drop `!important`,
// or delete a property from it, and most of the motion layer escapes at once
// with no local fallback and nothing else in the suite notices. This file is the
// tripwire for exactly that edit.
//
// The guard is necessary but not sufficient, and the gap is easy to miss:
// `transform` is neither an animation nor a transition, so the D1/D4 hover lift
// and press scale survive `animation: none !important; transition: none
// !important` and merely lose their easing — an instant 2px jump and an instant
// shrink instead of a suppressed one. src/motion.css closes that with its own
// `prefers-reduced-motion: reduce` block, and the third describe below pins it
// selector-by-selector so a new `:hover`/`:active` transform cannot be added
// without its counterpart.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const read = (name) => readFileSync(join(srcDir, name), "utf8").replace(/\r\n/g, "\n");

const stylesCss = read("styles.css");
const motionCss = read("motion.css");
const tokensCss = read("sg-tokens.css");
const mainJsx = read("main.jsx");

const UNIVERSAL_SELECTOR = "*, *::before, *::after";

// Declarations the guard must keep. `transition` is what silences D1/D4 hover
// and press feedback; `animation` is what silences D2 stagger, D3 chart growth,
// the D5 infinite ambient loops and the dialog/toast springs.
const REQUIRED_DECLARATIONS = ["animation", "transition"];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Brace-matched split into the bodies of every
 * `@media (prefers-reduced-motion: reduce)` block and everything outside them.
 */
function splitReduceBlocks(css) {
  const bodies = [];
  const opener = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;
  let outside = "";
  let cursor = 0;
  let match;
  while ((match = opener.exec(css)) !== null) {
    outside += css.slice(cursor, match.index);
    let depth = 1;
    let at = opener.lastIndex;
    while (at < css.length && depth > 0) {
      if (css[at] === "{") depth += 1;
      else if (css[at] === "}") depth -= 1;
      at += 1;
    }
    bodies.push(css.slice(opener.lastIndex, at - 1));
    cursor = at;
    opener.lastIndex = at;
  }
  outside += css.slice(cursor);
  return { bodies, outside };
}

/**
 * Flat `selector { declarations }` pairs. The selector pattern cannot span a
 * brace, so an `@media` prelude never matches and the innermost rules of a
 * nested block are returned on their own.
 */
function rulesIn(body) {
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((rule) => ({
    selector: rule[1].trim().replace(/\s+/g, " "),
    declarations: rule[2].trim().replace(/\s+/g, " "),
    index: rule.index,
  }));
}

const selectorList = (selector) => selector.split(",").map((part) => part.trim()).filter(Boolean);
const declares = (declarations, property, value = "[^;]+") =>
  new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`).test(declarations);

/**
 * Body ranges of every `@media (prefers-reduced-motion: reduce)` block, as
 * offsets into the string passed in. splitReduceBlocks() above throws the
 * offsets away when it concatenates, and source order is exactly what the
 * transform suppression depends on — see the third describe.
 */
function reduceBlockRanges(css) {
  const ranges = [];
  const opener = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;
  while (opener.exec(css) !== null) {
    let depth = 1;
    let at = opener.lastIndex;
    while (at < css.length && depth > 0) {
      if (css[at] === "{") depth += 1;
      else if (css[at] === "}") depth -= 1;
      at += 1;
    }
    ranges.push({ start: opener.lastIndex, end: at - 1 });
    opener.lastIndex = at;
  }
  return ranges;
}

/**
 * Every file with `ext` UNDER `dir`, at any depth, as paths relative to `dir`.
 *
 * One walker for both halves of this file. The .jsx half always recursed --
 * src/views/ and src/components/ are where the views live -- but the .css half
 * used a flat readdirSync(srcDir), so a stylesheet one level down was never
 * opened. Vite bundles `src/views/Foo.css` exactly like the three sheets at the
 * root, so a press declared there shipped to the browser with nothing demanding
 * its reduced-motion reset. Discovery from disk is the entire point of this
 * guard; a flat read left the identical hole for the next stylesheet added that
 * hard-coding the filenames would have.
 *
 * Relative, not absolute: read() below joins with srcDir, and every failure
 * message prints this name, where `views/Foo.css` is what a reader needs.
 */
function filesUnder(dir, ext, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return filesUnder(join(dir, entry.name), ext, rel);
    return entry.name.endsWith(ext) ? [rel] : [];
  });
}

/**
 * Every literal class token any `className=` in the source can produce.
 * Handles the three shapes src/ actually uses — `className="a b"`,
 * `className={`a ${x}`}` and `className={cond ? "a" : ""}` — by taking the
 * whole attribute value (brace-matched for the expression form), dropping
 * `${...}` interpolations, and splitting what is left inside quotes or
 * backticks on whitespace. A fully computed value (`className={CARD_CLASS}`)
 * contributes nothing, which is fine: overlays are written literally.
 */
function classNamesIn(source) {
  const values = [];
  const attr = /className\s*=\s*/g;
  let match;
  while ((match = attr.exec(source)) !== null) {
    const at = attr.lastIndex;
    const ch = source[at];
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, at + 1);
      if (end === -1) continue;
      values.push(source.slice(at, end + 1));
      attr.lastIndex = end + 1;
    } else if (ch === "{") {
      let depth = 0;
      let cursor = at;
      while (cursor < source.length) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}" && (depth -= 1) === 0) break;
        cursor += 1;
      }
      values.push(source.slice(at + 1, cursor));
      attr.lastIndex = cursor + 1;
    }
  }
  const names = new Set();
  for (const value of values) {
    for (const literal of value.replace(/\$\{[^{}]*\}/g, " ").matchAll(/["'`]([^"'`]*)["'`]/g)) {
      for (const token of literal[1].split(/\s+/)) if (token) names.add(token);
    }
  }
  return names;
}

/**
 * Classes styles.css lifts out of flow across the whole viewport: `position:
 * fixed`, or `position: absolute` pinned to every edge. Both are how an overlay
 * is built; the second is included so the next one written that way does not
 * walk past this net the way `.task-editor-backdrop` walked past the
 * hand-written list in motion.css. Takes the LAST class of each selector part,
 * i.e. the element the rule actually positions, not its ancestors.
 */
function outOfFlowClasses(css) {
  const names = new Set();
  for (const rule of rulesIn(stripComments(css))) {
    const lifted =
      declares(rule.declarations, "position", "fixed") ||
      (declares(rule.declarations, "position", "absolute") && declares(rule.declarations, "inset", "0"));
    if (!lifted) continue;
    for (const part of selectorList(rule.selector)) {
      const classes = [...part.matchAll(/\.([a-zA-Z][\w-]*)/g)];
      if (classes.length) names.add(classes[classes.length - 1][1]);
    }
  }
  return names;
}

describe("global reduced-motion guard", () => {
  const guards = splitReduceBlocks(stripComments(stylesCss))
    .bodies.flatMap(rulesIn)
    .filter((rule) => rule.selector === UNIVERSAL_SELECTOR);

  it("keeps a universal prefers-reduced-motion block in src/styles.css", () => {
    expect(
      guards.length,
      `src/styles.css must keep a @media (prefers-reduced-motion: reduce) rule whose selector is exactly "${UNIVERSAL_SELECTOR}". ` +
        "src/motion.css has no reduced-motion handling of its own and relies entirely on it.",
    ).toBeGreaterThan(0);
  });

  it("kills animation and transition with !important for every element and pseudo-element", () => {
    for (const property of REQUIRED_DECLARATIONS) {
      const enforced = guards.some((rule) =>
        new RegExp(`(^|;)\\s*${property}\\s*:\\s*none\\s*!important\\s*(;|$)`).test(rule.declarations),
      );
      expect(
        enforced,
        `the universal reduced-motion guard must declare "${property}: none !important". ` +
          `Weakening it (a duration override, a dropped !important, a narrower selector) un-gates every ${property} in src/motion.css.`,
      ).toBe(true);
    }
  });

  it("keeps src/motion.css free of !important so the guard always wins", () => {
    const offenders = [...stripComments(motionCss).matchAll(/[^;{}]*!important[^;{}]*/g)].map((m) =>
      m[0].trim(),
    );
    expect(
      offenders,
      "an !important declaration in src/motion.css would tie or beat the guard and survive prefers-reduced-motion.",
    ).toEqual([]);
  });
});

describe("motion layer wiring", () => {
  it("imports src/motion.css after src/styles.css in main.jsx", () => {
    const stylesAt = mainJsx.indexOf('import "./styles.css"');
    const motionAt = mainJsx.indexOf('import "./motion.css"');
    expect(stylesAt).toBeGreaterThan(-1);
    expect(motionAt).toBeGreaterThan(-1);
    expect(
      motionAt,
      "motion.css must load after styles.css: its overrides (notably `.screen { animation: none }`) win only on source order at equal specificity.",
    ).toBeGreaterThan(stylesAt);
  });

  it("references only --sg-* tokens that sg-tokens.css defines", () => {
    const defined = new Set([...tokensCss.matchAll(/(--sg-[\w-]+):/g)].map((m) => m[1]));
    const referenced = [...motionCss.matchAll(/var\(\s*(--sg-[\w-]+)\s*[),]/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((name) => !defined.has(name))).toEqual([]);
  });

});

// Overlays render as direct children of `.screen` (CasesView's dialog backdrop
// is the 5th, RightsView's status toast the 6th, TasksView's task editor and
// task-message backdrops last), so the D2 `:nth-child()` ramp hands them an
// entrance delay. Its (0,2,0) `animation-delay` longhand beats the (0,1,0)
// `animation` shorthand the overlay rules use, and the `backwards` fill those
// shorthands do win holds the overlay at opacity 0 for the whole delay — so the
// ramp must exempt them explicitly, in a rule placed after the ramp.
//
// The exemption in motion.css was originally hand-written against the views
// that existed when the design kit was generated. TasksView merged later and
// `.task-editor-backdrop` fell straight through the gap: a full-screen steward
// dialog held invisible for 160-280ms with a green suite, because the test that
// was supposed to catch it carried its own hard-coded copy of the same stale
// list. So the list is derived from src/ here instead — a view added tomorrow
// that ships a new overlay fails this test until motion.css exempts it.
//
// "Overlay" = a class named like one (…-backdrop / …-dialog / toast / …-sheet /
// …-drawer / …-popover / …-overlay / …-scrim / …-modal) that styles.css lifts
// out of flow across the viewport. The position filter is what separates the
// outer overlay from the panel inside it: `.app-dialog` and
// `.task-message-dialog` are in-flow children of a backdrop and are never a
// `.screen` child themselves, so they are correctly excluded.
//
// Deliberately NOT filtered by "does this actually render under a .screen
// today". Tracing that statically means resolving the component graph, and it
// re-opens every time a dialog moves between App.jsx and a view. Requiring the
// exemption for every positioned overlay is over-inclusive in the harmless
// direction: a `.screen > x` rule for an overlay that never lands under
// `.screen` simply never matches, which is why `.tour-dialog` and
// `.guide-dialog` (siblings of <main>, App.jsx:1618-1619) stay listed.
describe("D2 entrance stagger vs overlays", () => {
  const OVERLAY_NAME = /(^|-)(backdrop|dialog|toast|sheet|drawer|popover|overlay|scrim|modal)$/;
  // If the scanner ever silently matches nothing, every assertion below passes
  // vacuously. These three are the overlays that provably exist today —
  // src/components/Dialog.jsx:14, src/views/RightsView.jsx:78, and
  // src/views/TasksView.jsx:764/878 — and the floor test fails loudly instead.
  const KNOWN_OVERLAYS = ["dialog-backdrop", "task-editor-backdrop", "toast"];

  const lifted = outOfFlowClasses(stylesCss);
  const rendered = new Set(
    filesUnder(srcDir, ".jsx").flatMap((file) => [...classNamesIn(read(file))]),
  );
  const overlays = [...rendered].filter((name) => OVERLAY_NAME.test(name) && lifted.has(name)).sort();

  const rules = rulesIn(stripComments(motionCss));
  const ramp = rules.filter((rule) => /^\.screen > :nth-child\(/.test(rule.selector));

  it("finds the overlays src/ actually renders", () => {
    expect(
      KNOWN_OVERLAYS.filter((name) => !overlays.includes(name)),
      "the overlay scanner stopped seeing overlays that are still in src/. Every assertion in this " +
        "describe is derived from that scan, so a silent miss here turns the whole block green and " +
        "useless. Check classNamesIn() against the className shapes in src/, and outOfFlowClasses() " +
        "against the positioning rules in src/styles.css.",
    ).toEqual([]);
  });

  it("exempts every positioned overlay from the stagger, after the ramp", () => {
    expect(ramp.length, "the .screen > :nth-child() ramp this test guards has disappeared").toBeGreaterThan(0);
    const rampEndsAt = Math.max(...ramp.map((rule) => rule.index));

    const unexempt = overlays.filter(
      (overlay) =>
        !rules.some(
          (rule) =>
            rule.index > rampEndsAt &&
            selectorList(rule.selector).includes(`.screen > .${overlay}`) &&
            declares(rule.declarations, "animation-delay", "0s"),
        ),
    );
    expect(
      unexempt,
      "each overlay class listed here is rendered by src/ and positioned fixed by src/styles.css, but " +
        'src/motion.css never resets its stagger with `.screen > .<class> { animation-delay: 0s }` in a ' +
        "rule placed AFTER the .screen > :nth-child() ramp. If it mounts as a direct child of a .screen " +
        "it is held at opacity 0 for up to 280ms and then rises like page content instead of opening. " +
        "Add it to the exemption rule in src/motion.css — the cost of exempting one that never lands " +
        "under .screen is zero, the cost of missing one is a dialog that looks like a dead tap.",
    ).toEqual([]);
  });

  // Zeroing the delay is only half of it. `.screen > *` also hands an overlay
  // the sg-rise animation NAME, and an 8px translateY on a `position: fixed;
  // inset: 0` backdrop drags the scrim and the panel inside it up the viewport
  // on open. Every overlay therefore has to claim an entrance of its own, in a
  // rule after `.screen > *` so it takes the (0,1,0) tie.
  it("gives every positioned overlay an entrance of its own, after the .screen > * ramp", () => {
    const rampStart = rules.find((rule) => rule.selector === ".screen > *");
    expect(rampStart, "the `.screen > *` rule this test anchors on has disappeared").toBeTruthy();

    const inherited = overlays.filter(
      (overlay) =>
        !rules.some(
          (rule) =>
            rule.index > rampStart.index &&
            selectorList(rule.selector).includes(`.${overlay}`) &&
            (declares(rule.declarations, "animation") || declares(rule.declarations, "animation-name")),
        ),
    );
    expect(
      inherited,
      "each overlay class listed here inherits `animation: sg-rise` from `.screen > *` in src/motion.css " +
        "instead of declaring its own. sg-rise translates 8px on entry, which on a full-viewport fixed " +
        "overlay slides the whole thing — backdrop and dialog together — rather than opening it. Give it " +
        "its own animation (sg-fade for a backdrop, sg-spring-up or sg-toast-in for a panel) in a rule " +
        "after `.screen > *`.",
    ).toEqual([]);
  });
});

describe("motion layer transform suppression", () => {
  // The global guard cancels `animation` and `transition`. It does not touch
  // `transform`, so a hover lift or press scale survives reduce mode with its
  // easing stripped: an instant jump rather than a suppressed one.
  //
  // Set membership is only half the invariant. `.case-card:hover { transform:
  // none }` inside the reduce block and `.case-card:hover { transform:
  // translateY(-2px) }` outside it are both (0,2,0) — the reset wins on nothing
  // but source order, and motion.css:71 says so out loud. So indices are kept
  // here rather than flattened away: a refactor that hoists the reduce block
  // above the rules it cancels (a stylelint autofix, a "group all media
  // queries" pass) reverts the fix exactly, and a membership-only test would
  // stay green through it.
  // Two scope corrections, both of which were live escapes before this pass.
  //
  // 1. EVERY stylesheet under src/, discovered, not named. This describe used to
  //    read motion.css alone. src/styles.css carried press contracts of its
  //    own — at the time two .is-tappable card rules (since retired as dead
  //    code, zero consumers) and .bottom-nav, the app's most tapped control at
  //    the deepest scale in the file (.88 against .95/.97) —
  //    and .bottom-nav had NO reset in either file. It was moving 12% under
  //    reduce, instantly rather than over 160ms, and the suite was green. Naming
  //    the files would leave the same hole for the next stylesheet added, which
  //    is the append-only shape: pin a name and the un-named file is the free
  //    move. So the list is read off disk.
  //
  // 2. `scale:`, `translate:` and `rotate:` count as moving. They are baseline
  //    CSS, render identically to the equivalent `transform`, and defeated BOTH
  //    halves of this guard at once: a rule declaring `scale: .97` produced no
  //    entry in `movedAt`, so no reset was demanded — and the existing
  //    `transform: none` resets would not have cancelled it anyway, because
  //    they are a different property. Rewriting one press that way was a silent
  //    revert of the whole fix. Each property must be reset by ITS OWN name,
  //    which is why suppression is tracked per property rather than pooled.
  const MOVING_PROPERTIES = ["transform", "scale", "translate", "rotate"];
  const RESET_VALUE = { transform: "none", scale: "none", translate: "none", rotate: "none" };

  // 3. A press can be written without naming a moving property at all:
  //
  //      .x:active { --press: scale(.90); }
  //      .x        { transform: var(--press, none); transition: transform .16s; }
  //
  //    The state rule declares nothing in MOVING_PROPERTIES, and the rule that
  //    does declare `transform` carries no :hover/:active — so no reset is ever
  //    demanded and the element shrinks under reduce, permanently outside this
  //    guard. Resolving custom properties to decide whether a value ends up in
  //    a transform is a lot of machinery for a shape nobody needs; banning it
  //    is one rule with a clear instruction. Declare the transform on the state
  //    rule, where it can be paired with a reset.
  const TRANSFORM_FUNCTION = /\b(?:matrix|perspective|rotate|scale|skew|translate)(?:3d|X|Y|Z)?\s*\(/;

  const cssFiles = filesUnder(srcDir, ".css").sort();

  const lastIndexByKey = (entries) => {
    const seen = new Map();
    for (const { key, index } of entries) seen.set(key, Math.max(seen.get(key) ?? -1, index));
    return seen;
  };

  // Keys are `property` + SEP + `selector`, so a `scale:` press is only ever
  // satisfied by a `scale: none` reset for the SAME selector, never by a
  // `transform: none`.
  //
  // SEP is NUL because selectors contain spaces (`.bottom-nav a:active`) and
  // commas: a separator that can occur in the data turns a key collision into
  // a silently wrong verdict, and splitting on one truncates the selector in
  // every failure message. It is written as an escape rather than typed
  // literally -- a raw NUL byte makes ripgrep classify this file as binary
  // and skip it, so the repo's own search stops seeing its own guard.
  const SEP = "\u0000";
  const perFile = cssFiles.map((name) => {
    const stripped = stripComments(read(name));
    const reduceRanges = reduceBlockRanges(stripped);
    const insideReduce = (index) => reduceRanges.some((range) => index >= range.start && index < range.end);
    const rules = rulesIn(stripped);

    const movedAt = lastIndexByKey(
      rules.flatMap((rule) =>
        insideReduce(rule.index)
          ? []
          : MOVING_PROPERTIES.filter((property) => declares(rule.declarations, property)).flatMap((property) =>
              selectorList(rule.selector)
                .filter((selector) => /:(hover|active)\b/.test(selector))
                .map((selector) => ({ key: `${property}${SEP}${selector}`, index: rule.index })),
            ),
      ),
    );
    const suppressedAt = lastIndexByKey(
      rules.flatMap((rule) =>
        insideReduce(rule.index)
          ? MOVING_PROPERTIES.filter((property) =>
              declares(rule.declarations, property, RESET_VALUE[property]),
            ).flatMap((property) =>
              selectorList(rule.selector).map((selector) => ({
                key: `${property}${SEP}${selector}`,
                index: rule.index,
              })),
            )
          : [],
      ),
    );
    // An `!important` press is the one shape source order cannot answer. The
    // reset below wins today only because it is declared later at equal
    // specificity — but `transform: scale(.88) !important` beats a plain
    // `transform: none` from anywhere in the cascade, so both keys are still
    // present, the ordering assertion still passes, and the element still
    // shrinks under reduce. The existing ban covers src/motion.css only, which
    // is the file least likely to carry the offending declaration.
    const importantMovers = rules.flatMap((rule) =>
      insideReduce(rule.index)
        ? []
        : MOVING_PROPERTIES.filter((property) =>
            declares(rule.declarations, property, "[^;]*!important[^;]*"),
          ).map((property) => `${name}: ${rule.selector} { ${property}: … !important }`),
    );

    const indirectMovers = rules.flatMap((rule) =>
      insideReduce(rule.index) || !/:(hover|active)\b/.test(rule.selector)
        ? []
        : [...rule.declarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)]
            .filter((match) => TRANSFORM_FUNCTION.test(match[2]))
            .map((match) => `${name}: ${rule.selector} { ${match[1]}: ${match[2].trim()} }`),
    );

    return { name, reduceRanges, movedAt, suppressedAt, importantMovers, indirectMovers };
  });

  const describeKey = (key) => {
    const [property, selector] = key.split(SEP);
    return `${selector} { ${property} }`;
  };

  it("discovers stylesheets by walking src/, not by reading its top level", () => {
    // The property under test is that filesUnder RECURSES. No .css sits in a
    // subdirectory today, so .css cannot prove it — but .jsx can: every view
    // lives under src/views/. Feeding the same walker the extension that DOES
    // have nested files makes this a real assertion against repo content,
    // with no fixture directory to keep alive. Reverting the walk to a flat
    // readdirSync(srcDir) empties this list and reds the suite.
    const nestedJsx = filesUnder(srcDir, ".jsx").filter((file) => file.includes("/"));
    expect(
      nestedJsx.length,
      "src/ no longer has nested .jsx, so this pin can no longer detect a flattened " +
        "walk — give filesUnder a fixture, or pin it on whichever extension nests now",
    ).toBeGreaterThan(0);

    // A floor, not an exact count: an added stylesheet is routine and must not
    // red the suite, while a discovery that stops finding the three sheets the
    // app imports is the failure this is here to catch.
    expect(cssFiles).toEqual(expect.arrayContaining(["motion.css", "sg-tokens.css", "styles.css"]));

    // And the set actually scanned must equal what Node's own recursive listing
    // finds — a second, independent implementation, so this does not merely
    // agree with filesUnder about filesUnder.
    //
    // Be honest about when this bites: with no .css in any subdirectory it is
    // DORMANT, because a flat read and a deep read return the same three names.
    // It arms itself the moment someone adds src/<dir>/x.css, which is exactly
    // the commit that would otherwise ship an unscanned press. The assertion
    // above catches a broken walker; this one catches the call site being
    // reverted to a flat read. Neither catches the other — an earlier version
    // of this test pinned only the walker, and reverting just this line stayed
    // green because filesUnder was still correct and still used for .jsx.
    const nodeRecursive = readdirSync(srcDir, { recursive: true })
      .map((entry) => String(entry).replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".css"))
      .sort();
    expect(cssFiles).toEqual(nodeRecursive);
  });

  it("lets no hover or press hide a transform inside a custom property", () => {
    const offenders = perFile.flatMap((file) => file.indirectMovers);
    expect(
      offenders.sort(),
      "each of these sets a custom property to a transform value on a state " +
        "selector. Whatever rule consumes it carries no :hover/:active, so this " +
        "guard pairs nothing and the element keeps moving under reduce. Declare " +
        "the transform on the state rule itself and give it a reset.",
    ).toEqual([]);
  });

  it("lets no !important moving declaration stand outside a reduce block", () => {
    const offenders = perFile.flatMap((file) => file.importantMovers);
    expect(
      offenders.sort(),
      "an !important transform beats the reduced-motion reset from anywhere in the " +
        "cascade, so the source-order invariant below cannot cancel it. The press " +
        "and its reset both stay in the key sets and every other assertion here " +
        "still passes while the element keeps moving under reduce.",
    ).toEqual([]);
  });

  it("still moves something on hover or press", () => {
    const totalMoved = perFile.reduce((sum, file) => sum + file.movedAt.size, 0);
    expect(totalMoved, "the D1/D4 feedback this suite guards has disappeared").toBeGreaterThan(0);
    expect(
      perFile.filter((file) => file.movedAt.size > 0 && file.reduceRanges.length === 0).map((file) => file.name),
      "each stylesheet listed here moves something on hover or press and has no " +
        "@media (prefers-reduced-motion: reduce) block at all",
    ).toEqual([]);
  });

  it("resets every hover and press transform under prefers-reduced-motion: reduce", () => {
    const unreset = perFile.flatMap((file) =>
      [...file.movedAt.keys()]
        .filter((key) => !file.suppressedAt.has(key))
        .map((key) => `${file.name}: ${describeKey(key)}`),
    );
    expect(
      unreset.sort(),
      "each entry listed here moves on hover or press with no reset for THAT PROPERTY inside a " +
        "@media (prefers-reduced-motion: reduce) block in the same file. The global guard in styles.css " +
        "cannot cover them: it cancels animation and transition, and none of transform/scale/translate/" +
        "rotate is either. Note a `transform: none` reset does NOT cancel a `scale:` — reset the property " +
        "that was actually set.",
    ).toEqual([]);
  });

  it("declares those resets after the rules they cancel, which is the only reason they win", () => {
    const tooEarly = perFile.flatMap((file) =>
      [...file.movedAt.keys()]
        .filter((key) => file.suppressedAt.has(key) && file.suppressedAt.get(key) < file.movedAt.get(key))
        .map((key) => `${file.name}: ${describeKey(key)}`),
    );
    expect(
      tooEarly.sort(),
      "each entry listed here has its reset EARLIER in the file than the rule that moves it. Both are " +
        "equal specificity and neither is !important (pinned above, and it must stay that way so the " +
        "global guard keeps winning), so the later one wins: the reset loses and the hover lift and press " +
        "scale come back under prefers-reduced-motion: reduce with nothing else in the suite noticing. " +
        "Move the reduce block back below the rules it cancels.",
    ).toEqual([]);
  });
});
