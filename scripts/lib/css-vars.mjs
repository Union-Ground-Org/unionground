// Custom-property extraction, split out of scripts/contrast-audit.mjs so it can
// be tested against hand-built inputs rather than only against the two real
// stylesheets. Both holes closed here were demonstrated on a scratch copy
// before the fix, and both are pure no-ops on current content — the audit reads
// the same 100 + 45 variables with the same values before and after.

/**
 * CSS comments, removed before anything is parsed.
 *
 * collectVars() below is a regex over raw text filling a last-write-wins Map,
 * so a comment is not inert to it — it is more text that matches. A comment
 * reading "rejected: --border: var(--sg-color-border-strong);" placed AFTER a
 * real declaration of --border replaced that declaration outright: the audit
 * resolved the commented value, printed its ratio and exited 0, while the
 * browser rendered the real one. A comment BEFORE the declaration lost to it,
 * so position alone decided whether the checker could be disarmed.
 *
 * The edit that exploits this is the responsible-looking one — recording why a
 * token was rejected, in the block the rejection is about.
 */
export const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The body of EVERY unconditional `:root` block in the sheet, in source order.
 *
 * This replaced a single `css.indexOf(":root")` that read the first block and
 * stopped. CSS applies the LAST declaration of a name, so appending a second
 * `:root` to the foot of a file overrode every audited alias in the browser
 * while the audit kept resolving the first block and passing. Returning all of
 * them, and letting the caller's Map take the last, matches the cascade.
 *
 * The first fix for that was an opener regex requiring the `:root` to follow
 * `}`, `;`, or the start of the sheet. That is ADJACENCY, and adjacency is the
 * wrong model — it decides by what character happens to precede the selector
 * rather than by where the rule sits in the document:
 *
 *   html, :root { --border: … }            preceded by `,` → never matched
 *   @media (min-width: 900px) { :root { … } }   preceded by `{` → never matched
 *
 * Both are ordinary CSS a person would write on purpose, both change what the
 * browser paints, and both left the audit resolving the untouched first block
 * and printing PASS. The second is worse than a miss: a `:root` inside an
 * at-rule is CONDITIONAL, and a flat last-write-wins Map has nowhere to put a
 * value that only sometimes applies. Under the old regex the same nested rule
 * was found or missed depending on whether another rule preceded it inside the
 * block — so the parser's answer depended on adjacency, not structure.
 *
 * So this walks the block structure instead: at-rules are descended into, and a
 * `:root` is classified rather than pattern-matched. Anything this cannot model
 * THROWS rather than being skipped, because a checker that silently ignores the
 * rule it cannot understand reports the same exit code as one that verified it.
 */
function walk(text, visit, atRulePrelude = null) {
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf("{", pos);
    if (open === -1) break;

    // Take the last statement before the brace: `@import "a"; :root` must read
    // as the selector `:root`, not as an at-rule that swallowed it.
    const selector = text.slice(pos, open).split(";").pop().trim();

    let depth = 1;
    let at = open + 1;
    for (; at < text.length && depth > 0; at += 1) {
      if (text[at] === "{") depth += 1;
      else if (text[at] === "}") depth -= 1;
    }
    if (depth !== 0) throw new Error(`unclosed block after selector: ${selector.slice(0, 60)}`);
    const body = text.slice(open + 1, at - 1);

    if (selector.startsWith("@")) walk(body, visit, selector);
    else visit({ selector, body, atRulePrelude });

    pos = at;
  }
}

/** A selector list, split and trimmed: `html, :root` -> ["html", ":root"]. */
const selectorParts = (selector) => selector.split(",").map((part) => part.trim());

const conditional = (name, atRulePrelude) =>
  new Error(
    `${name} inside \`${atRulePrelude.slice(0, 60)}\` is conditional, and this audit resolves ` +
      "one unconditional value per property. Move the override to a non-conditional " +
      "selector, or teach the audit about conditions — do not let it resolve a value " +
      "the browser may never apply.",
  );

export function rootBlocks(css) {
  const blocks = [];
  walk(css, ({ selector, body, atRulePrelude }) => {
    const parts = selectorParts(selector);
    if (parts.some((part) => part === ":root")) {
      if (atRulePrelude) throw conditional(":root", atRulePrelude);
      blocks.push(body);
    } else if (parts.some((part) => part.includes(":root"))) {
      throw new Error(
        `selector \`${selector.slice(0, 60)}\` targets :root in a form this audit cannot ` +
          "classify. Refusing to skip it silently.",
      );
    }
  });
  if (blocks.length === 0) throw new Error("no :root block found");
  return blocks;
}

/**
 * Custom properties declared by a SCOPED block, e.g. `.tasks-screen`.
 *
 * `:root` is not where this app keeps all of its tokens. `.tasks-screen`
 * declares the four --task-status-* aliases and `.tasks-screen--dark` re-declares
 * roughly thirty colour names behind a user toggle, and none of it is visible to
 * a `:root`-only reader — which is why the audit cannot see any of it, and why
 * the one alias src/styles.css's --status-foreground comment leans on for its
 * non-text argument could not be pinned until this existed.
 *
 * Same refusal as above: a match inside an at-rule is conditional and throws.
 */
export function selectorBlocks(css, selector) {
  const blocks = [];
  walk(css, ({ selector: found, body, atRulePrelude }) => {
    if (!selectorParts(found).includes(selector)) return;
    if (atRulePrelude) throw conditional(selector, atRulePrelude);
    blocks.push(body);
  });
  return blocks;
}

/**
 * Every NON-`:root` block that declares custom properties, and what it declares.
 *
 * The audit's model is one unconditional value per name, resolved from `:root`.
 * That model is not what this stylesheet does: `.tasks-screen` declares the
 * --task-status-* carriers and `.tasks-screen--dark` re-declares ~30 colour
 * names behind a localStorage toggle, so a whole second palette exists that no
 * contrast row measures. Auditing scoped palettes properly means teaching the
 * pair table about scopes and proving it in a browser under each scope. What
 * this enumeration buys cheaply is the ability to notice a NEW one.
 */
export function scopedBlocks(css) {
  const found = [];
  walk(stripComments(css), ({ selector, body, atRulePrelude }) => {
    if (selectorParts(selector).some((part) => part === ":root")) return;
    const vars = new Map();
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim());
    if (vars.size > 0) found.push({ selector, vars, conditional: Boolean(atRulePrelude) });
  });
  return found;
}

/** The custom properties a scoped block declares, last write winning. */
export function scopedVars(css, selector) {
  const vars = new Map();
  for (const block of selectorBlocks(stripComments(css), selector)) {
    for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(m[1], m[2].trim());
  }
  return vars;
}

/**
 * Every rule that paints BOTH a background and a text colour, as `var()`, in
 * one block.
 *
 * The audit resolves NAMES out of a table someone wrote by hand, so its coverage
 * is only ever as good as that person's list of what the sheet paints. Mine was
 * not good enough. The first version of the pair table was assembled by reasoning
 * about which pairs looked risky, and it missed --ink: the alias thirty rules
 * paint as text and `.tasks-screen--dark` re-points, sitting under no row at all.
 * A reviewer found it by changing that one line and watching every check stay
 * green while the whole board went unreadable.
 *
 * So the list stops being written and starts being derived. A rule declaring
 * both halves of a pair is the one case needing no ancestry guessing and no
 * judgement about which surface an element lands on — the same block names both.
 * It does not find everything: a `color` inherited from an ancestor is invisible
 * here, which is why the call-site pins in the test file still exist. But what it
 * does find, it finds mechanically, and a derived list is one a test can enforce.
 *
 * Keyed by ALIAS NAME, never by resolved value. --ink and --foreground hold the
 * same hex in every scope today, which is exactly the coincidence a scope is free
 * to break; collapsing them by value is how the gap hid in the first place.
 *
 * Unlike the `:root` readers above, a match inside an at-rule is REPORTED rather
 * than thrown on. Their problem was a conditional value in a model that stores
 * one value per name. This has no such model — a pair painted inside a media
 * query is a real pair that must hold whenever that query does.
 */
/**
 * Every `background`, `background-color` and `color` declaration in the sheet,
 * as written.
 *
 * Exported raw because a derivation is only as honest as its failure mode. The
 * first version of paintedPairs() below simply did not match a value it could
 * not parse, so `color: var(--gold-ink) !important`, `color: var(--x, #hex)` and
 * `color: #7d4f00` each removed a rule from the derived set with no trace — the
 * silent-exclusion failure the rest of this file was rebuilt to refuse
 * (rootBlocks THROWS rather than skip what it cannot classify). Handing the
 * declarations back lets the caller assert what it expects to see rather than
 * trusting a reader's silence to mean "nothing there".
 *
 * `(?:^|;)` is load-bearing: without it `background-color:` also matches the
 * `color` alternative, and every surface reports itself as its own text colour.
 * It also keeps `border-color`, `caret-color` and `accent-color` out, none of
 * which is text.
 */
const PAINT_DECLARATION = /(?:^|;)\s*(background-color|background|color)\s*:\s*([^;}]*?)\s*(?=;|$)/g;

/** A value this audit can resolve: one `var(--name)`, no fallback, no suffix. */
const BARE_VAR = /^var\(\s*(--[\w-]+)\s*\)$/;

export function paintDeclarations(css) {
  const found = [];
  walk(stripComments(css), ({ selector, body, atRulePrelude }) => {
    for (const match of body.matchAll(PAINT_DECLARATION)) {
      found.push({
        selector: selector.replace(/\s+/g, " "),
        property: match[1] === "background-color" ? "background" : match[1],
        value: match[2].trim(),
        conditional: Boolean(atRulePrelude),
      });
    }
  });
  return found;
}

export function paintedPairs(css) {
  const found = [];
  walk(stripComments(css), ({ selector, body, atRulePrelude }) => {
    // LAST write wins, because that is what the browser paints and what every
    // other reader in this file already models ("takes the LAST :root, the way
    // the cascade does"). The first version used a non-global .match(), which
    // takes the FIRST — and that is worse than a blind spot. Append a second
    // `color:` to a rule and the reader kept reporting the first one, so the
    // guard CERTIFIED a pair the cascade does not paint: .task-editor stayed
    // "covered" as --card/--ink while the editor rendered --gold-ink at 1.66:1
    // in the dark scope, with the audit at exit 0 and the suite green.
    //
    // Note the null on an unparseable value is deliberate and not a skip: if the
    // LAST write is something this cannot resolve, the slot must go empty rather
    // than keep an earlier value the browser has already overridden.
    let background = null;
    let foreground = null;
    for (const match of body.matchAll(PAINT_DECLARATION)) {
      const bare = match[2].trim().match(BARE_VAR);
      if (match[1] === "color") foreground = bare ? bare[1] : null;
      else background = bare ? bare[1] : null;
    }
    if (!background || !foreground) return;
    found.push({
      selector: selector.replace(/\s+/g, " "),
      background,
      foreground,
      conditional: Boolean(atRulePrelude),
    });
  });
  return found;
}

/**
 * Every custom property declared in any `:root` of the given sheets, resolved
 * the way the cascade resolves them: later declarations win.
 */
export function collectVars(sheets) {
  const vars = new Map();
  for (const css of sheets) {
    for (const block of rootBlocks(stripComments(css))) {
      for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        vars.set(m[1], m[2].trim());
      }
    }
  }
  return vars;
}
