import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import postcss from "postcss";

// PERF-UG-FIRST-PAINT-OBSERVABILITY-DEFER-AND-CSS-SPLIT-20261028.
// src/styles.css stays the one ordered source every style test reads. At build
// time the rules that only style a lazily loaded view's own class namespace
// leave the critical sheet the document head links: each prefix below becomes
// a route sheet, imported by every module that names one of its classes, so it
// loads with that view's chunk and before the view renders. Everything else,
// tokens, fonts and keyframes included, stays critical.
// Split only namespaces owned by lazy renderers; even small single-view cuts
// reduce the sheet every route fetches. The cascade guard keeps order-sensitive
// rules critical, and the build guard below refuses eager imports (#7728).
export const ROUTE_STYLE_PREFIXES = ["tasks", "voice", "voting", "mwl", "kan", "ftm", "gq", "gapp", "company", "orgstructure", "mforms", "cdash", "mappt", "ach", "case-list", "cam", "institutional-timeline", "mevents", "public-document", "contact-help", "leadership-card", "form-signature", "xus-intake", "recovery-code", "vrx", "xus-action", "cwk-contact", "screen-header", "pkpi", "chapter-appts", "form-filing", "setin-session", "xus-field", "cwk-input", "chapter-budget", "case-macros", "mcases", "knowledge-workspace"];

// These modules mention route classes in DOM queries or documentation, but
// never render them, so they do not import route sheets.
export const QUERY_ONLY_SOURCES = [
  "src/lib/rowHighlight.js",
  "src/App.jsx",
  "src/components/DesktopRail.jsx",
  "src/components/ChapterRail.jsx",
  "src/lib/kanban.js",
];

const VIRTUAL_PREFIX = "virtual:route-styles/";
const SOURCE_PATTERN = /\.(?:jsx?|tsx?)$/;

// These form-editor header base rules precede responsive overrides that the
// cascade guard keeps critical. Keep their layout together in source order.
const CRITICAL_LAYOUT_CLASSES = new Set(["ftm-editor__head", "ftm-schema-head", "ftm-options__head"]);

function classPattern(prefix) {
  return new RegExp(`(?:^|[^a-zA-Z0-9_-])${prefix}(?:-|__)`);
}

// Classes a selector requires on the page. Classes inside functional
// pseudo-classes (:not, :is, :where, :has) are not required, so they never
// make a rule route-owned.
function requiredClasses(selector) {
  let plain = selector;
  for (let previous = ""; previous !== plain;) {
    previous = plain;
    plain = plain.replace(/:(?:not|is|where|has|matches|-webkit-any)\([^()]*\)/g, "");
  }
  return (plain.match(/\.[a-zA-Z_][\w-]*/g) || []).map((name) => name.slice(1));
}

function ownerOf(rule) {
  const owners = new Set();
  for (const selector of rule.selectors) {
    const classes = requiredClasses(selector);
    if (classes.some((name) => CRITICAL_LAYOUT_CLASSES.has(name))) return null;
    const owner = ROUTE_STYLE_PREFIXES.find((prefix) => classes.some((name) => name.startsWith(`${prefix}-`) || name.startsWith(`${prefix}__`)));
    if (!owner) return null;
    owners.add(owner);
  }
  return owners.size === 1 ? [...owners][0] : null;
}

// Specificity as [ids, classes, types]; :where() counts nothing and :is(),
// :not() and :has() count their most specific argument.
export function specificity(selector) {
  let ids = 0;
  let classes = 0;
  let types = 0;
  let rest = selector;
  for (;;) {
    const match = /:(not|is|has|matches|where|-webkit-any)\(/.exec(rest);
    if (!match) break;
    let depth = 1;
    let end = match.index + match[0].length;
    while (end < rest.length && depth) {
      if (rest[end] === "(") depth += 1;
      else if (rest[end] === ")") depth -= 1;
      end += 1;
    }
    const inner = rest.slice(match.index + match[0].length, end - 1);
    if (match[1] !== "where") {
      const best = splitSelectorList(inner).map(specificity).sort(compareSpecificity).at(-1) || [0, 0, 0];
      ids += best[0];
      classes += best[1];
      types += best[2];
    }
    rest = `${rest.slice(0, match.index)} ${rest.slice(end)}`;
  }
  rest = rest.replace(/\[[^\]]*\]/g, () => { classes += 1; return " "; });
  rest = rest.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, (token) => {
    if (token.startsWith("::") || /^:(?:before|after|first-line|first-letter)$/.test(token)) types += 1;
    else classes += 1;
    return " ";
  });
  ids += (rest.match(/#[\w-]+/g) || []).length;
  classes += (rest.match(/\.[\w-]+/g) || []).length;
  types += (rest.replace(/[#.][\w-]+/g, " ").match(/(?:^|[\s>+~(])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, types];
}

function compareSpecificity(left, right) {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function splitSelectorList(list) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === "(") depth += 1;
    else if (list[index] === ")") depth -= 1;
    else if (list[index] === "," && depth === 0) {
      parts.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

const PROPERTY_GROUPS = [
  // Logical dimensions can use either physical axis in a vertical writing mode.
  ["size", "width", "height"],
  ["inset", "top", "right", "bottom", "left"],
  ["place", "align", "justify"],
  ["gap", "row", "column"],
  ["font", "line"],
];

const PROPERTY_ALIASES = {
  "inline-size": "width", "block-size": "height",
  "min-inline-size": "min-width", "min-block-size": "min-height",
  "max-inline-size": "max-width", "max-block-size": "max-height",
  "grid-gap": "gap", "grid-row-gap": "row-gap", "grid-column-gap": "column-gap",
  "word-wrap": "overflow-wrap", "columns": "column-width",
  "white-space": "text-wrap", "white-space-collapse": "text-wrap",
  "white-space-trim": "text-wrap",
  "page-break-before": "break-before", "page-break-after": "break-after",
  "page-break-inside": "break-inside", "color-adjust": "print-color-adjust",
  "overflow-inline": "overflow-x", "overflow-block": "overflow-y",
};

// Two declarations can set the same longhand: one name, a shorthand and its
// longhands, or a logical and a physical side share their first segment.
function propertyFamily(property) {
  if (property.startsWith("--")) return property;
  if (property === "all") return "*";
  const unprefixed = property.replace(/^-(?:webkit|moz|ms|o)-/, "");
  const head = (PROPERTY_ALIASES[unprefixed] ?? unprefixed).split("-")[0];
  return PROPERTY_GROUPS.find((group) => group.includes(head))?.[0] ?? head;
}

// Only these reviewed, independently cascading families may leave part of a
// rule behind. Logical dimensions, grid/gap aliases, text wrapping and unknown
// shorthands stay together in the critical part. Custom-property rules and
// resets remain whole. No selector, specificity or declaration value changes.
const INDEPENDENT_FAMILIES = new Set([
  "background", "color", "display", "flex", "padding", "margin", "font",
  "place", "inset", "box", "border", "opacity", "position", "z",
  "visibility", "cursor", "list", "object", "content", "transform",
  "animation", "transition", "outline",
]);

function declarationParts(rule, sheet, ownedSubjects) {
  const whole = [{ rule, sheet, nodes: rule.nodes }];
  if (sheet === "critical" || rule.nodes.some((node) => node.type !== "decl"
    || node.prop.startsWith("--") || node.prop.toLowerCase() === "all")) return whole;
  if (rule.selectors.some((selector) => {
    const subject = subjectOf(selector, ownedSubjects);
    return subject.alternatives.some((alternative) => !alternative.classes.length && !subject.neighbour.length);
  })) return whole;
  for (let parent = rule.parent; parent?.type !== "root"; parent = parent.parent) {
    if (parent?.type !== "atrule" || !["media", "supports", "container"].includes(parent.name)) return whole;
  }
  const groups = new Map();
  for (const node of rule.nodes) {
    const family = propertyFamily(node.prop.toLowerCase());
    const key = INDEPENDENT_FAMILIES.has(family) ? `${family}${node.important ? "!" : ""}` : "critical";
    if (!groups.has(key)) groups.set(key, { sheet: key === "critical" ? "critical" : sheet, nodes: [] });
    groups.get(key).nodes.push(node);
  }
  if (groups.size < 2) return whole;
  return [...groups.values()].map((part) => ({ ...part, rule: rule.clone({ nodes: part.nodes.map((node) => node.clone()) }) }));
}

// Top-level pieces of a selector, split at combinators (or at commas when
// separator is ","), leaving parenthesized arguments whole.
function topLevel(selector, separator) {
  const parts = [];
  const combinators = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    const splits = separator === "," ? character === "," : /[\s>+~]/.test(character);
    if (depth === 0 && splits) {
      if (separator !== ",") {
        let combinator = character.trim();
        while (/[\s>+~]/.test(selector[index + 1] || "")) {
          index += 1;
          combinator ||= selector[index].trim();
        }
        if (current.trim()) { parts.push(current.trim()); combinators.push(combinator || " "); }
        else if (combinator && combinators.length) combinators[combinators.length - 1] = combinator;
      } else { parts.push(current.trim()); }
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return { parts, combinators };
}

function compoundFacts(compound) {
  return {
    classes: requiredClasses(compound),
    element: /^[a-zA-Z][\w-]*/.exec(compound)?.[0].toLowerCase() ?? null,
    pseudoElement: /::?(before|after|placeholder|marker|selection|backdrop|first-line|first-letter|-webkit-[\w-]+)/.exec(compound)?.[1] ?? null,
  };
}

// What a selector styles: the alternatives its last compound allows (an
// :is() list gives one per argument) and, when the subject is reached by a
// child or sibling combinator, the classes of the compound before it.
export function subjectOf(selector, ownedSubjects) {
  const { parts, combinators } = topLevel(selector.trim(), " ");
  const compound = parts.at(-1) || "";
  const alternative = /:(?:is|matches|where)\(/.exec(compound);
  let alternatives = [compoundFacts(compound)];
  if (alternative) {
    let depth = 1;
    let end = alternative.index + alternative[0].length;
    while (end < compound.length && depth) {
      if (compound[end] === "(") depth += 1;
      else if (compound[end] === ")") depth -= 1;
      end += 1;
    }
    const outside = compound.slice(0, alternative.index) + compound.slice(end);
    const base = compoundFacts(outside);
    alternatives = topLevel(compound.slice(alternative.index + alternative[0].length, end - 1), ",").parts
      .map((argument) => compoundFacts(topLevel(argument, " ").parts.at(-1) || ""))
      .map((facts) => ({
        classes: [...base.classes, ...facts.classes],
        element: base.element ?? facts.element,
        pseudoElement: base.pseudoElement ?? facts.pseudoElement,
      }));
  }
  const combinator = combinators.at(-1);
  const neighbour = parts.length > 1 && combinator && combinator !== " " ? requiredClasses(parts.at(-2)) : [];
  // A closed-subject contract is backed by real JSX owner markers and an
  // exhaustive renderer/DOM test. Keep the CSS selector and specificity
  // unchanged; use that proven required class only for co-match analysis.
  const owner = ownedSubjects?.get(selector.trim());
  const marker = typeof owner === "string" ? owner : owner?.marker;
  const unownedSubject = marker ? { alternatives, neighbour } : null;
  if (marker) alternatives = alternatives.map((alternative) => ({ ...alternative, classes: [...alternative.classes, marker] }));
  return { alternatives, neighbour, ...(unownedSubject ? { unownedSubject } : {}), ...(owner?.classes ? { knownClasses: owner.classes } : {}) };
}

function ruleFacts(rule, order, sheet, ownedSubjects) {
  const declarations = rule.nodes.filter((node) => node.type === "decl")
    .map((node) => `${propertyFamily(node.prop.toLowerCase())}${node.important ? "!" : ""}`);
  return {
    rule,
    order,
    sheet,
    families: new Set(declarations),
    selectors: rule.selectors.map((selector) => ({
      specificity: specificity(selector).join(","),
      subject: subjectOf(selector, ownedSubjects),
    })),
  };
}

function sourceIndex(root) {
  const files = [];
  (function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE_PATTERN.test(entry.name)) files.push(readFileSync(path, "utf8"));
    }
  })(join(root, "src"));
  return files;
}

// Could one element match both selectors? Not if they style different
// pseudo-elements or name different elements. Class names that appear
// together in some source module (including a template that builds one,
// `kan-pill--${x}`) are treated as co-occurring. A subject with no class (an
// element, attribute or pseudo-class) can match anything, unless it is the
// child or sibling of a classed compound: a parent and its children are
// written in one component, so that compound's classes must co-occur.
export function coMatchTest(sources) {
  const files = new Map();
  const open = new Set();
  sources.forEach((source, index) => {
    for (const token of new Set(source.match(/[a-zA-Z_][\w-]*/g) || [])) {
      if (!files.has(token)) files.set(token, new Set());
      files.get(token).add(index);
      if (/[-_]$/.test(token)) open.add(token);
    }
  });
  const cache = new Map();
  const mentions = (name) => {
    if (!cache.has(name)) {
      const result = new Set(files.get(name));
      for (const token of open) if (name.startsWith(token)) files.get(token).forEach((file) => result.add(file));
      cache.set(name, result);
    }
    return cache.get(name);
  };
  const together = (names) => names.map(mentions).reduce((shared, next) => new Set([...shared].filter((file) => next.has(file))));
  const cooccur = (left, right) => {
    if (left.some((name) => right.includes(name))) return true;
    const leftFiles = together(left);
    return [...together(right)].some((file) => leftFiles.has(file));
  };
  const classesOf = (subject, alternative) => alternative.classes.length ? alternative.classes : subject.neighbour;
  return (mine, theirs, useOwnership = true) => {
    if (!useOwnership) {
      mine = mine.unownedSubject ?? mine;
      theirs = theirs.unownedSubject ?? theirs;
    }
    return mine.alternatives.some((left) => theirs.alternatives.some((right) => {
    if (left.pseudoElement !== right.pseudoElement) return false;
    if (left.element && right.element && left.element !== right.element) return false;
    // Closed JSX inventories can rule out a subject class even when both
    // selectors occur in the same large renderer module. An absent class is
    // conclusive; a present one still uses the conservative co-match check.
    if (mine.knownClasses && right.classes.some((name) => !mine.knownClasses.includes(name))) return false;
    if (theirs.knownClasses && left.classes.some((name) => !theirs.knownClasses.includes(name))) return false;
    const leftClasses = classesOf(mine, left);
    const rightClasses = classesOf(theirs, right);
    return !leftClasses.length || !rightClasses.length || cooccur(leftClasses, rightClasses);
    }));
  };
}

// Moving a rule to a sheet that loads later changes the cascade only where an
// element can match it and another rule of equal specificity that sets the
// same property and that would now be ordered differently: a critical rule
// that used to follow it, a rule in another route sheet, or a rule in a later
// stylesheet (laterFacts: the global sheets after styles.css and every
// component sheet). Such a rule stays critical.
function cascadeConflicts(facts, laterFacts, coMatch) {
  const byFamily = new Map();
  const allFacts = [...facts, ...laterFacts];
  for (const fact of allFacts) {
    for (const family of fact.families) {
      if (!byFamily.has(family)) byFamily.set(family, []);
      byFamily.get(family).push(fact);
    }
  }
  const familyRivals = new Map();
  const rivalsFor = (family) => {
    if (!familyRivals.has(family)) {
      const wildcard = family.endsWith("!") ? "*!" : "*";
      const rivals = family === wildcard
        ? allFacts.filter((fact) => [...fact.families].some((name) => name.endsWith("!") === family.endsWith("!")))
        : [...byFamily.get(family), ...(byFamily.get(wildcard) ?? [])];
      familyRivals.set(family, [...new Set(rivals)]);
    }
    return familyRivals.get(family);
  };
  const kept = new Set();
  for (;;) {
    const newlyKept = [];
    for (const moved of facts) {
      if (moved.sheet === "critical") continue;
      const rival = (other) => other.sheet !== moved.sheet && (other.sheet !== "critical" || other.order > moved.order)
        && moved.selectors.some((mine) => other.selectors.some((theirs) => mine.specificity === theirs.specificity
          // This ownership slice is proved for Tasks/Kanban. Do not unlock
          // another family's fragments merely by narrowing one of its rivals.
          && coMatch(mine.subject, theirs.subject, ["tasks", "kan"].includes(moved.sheet))));
      if ([...moved.families].some((family) => rivalsFor(family).some(rival))) {
        kept.add(moved.rule);
        newlyKept.push(moved);
      }
    }
    if (!newlyKept.length) break;
    // Update together, so each pass can only retain more rules. The family
    // index holds these same facts; earlier rules see the new rivals next pass.
    for (const fact of newlyKept) fact.sheet = "critical";
  }
  return kept;
}

function rulesOf(root, visit) {
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
    visit(rule);
  });
}

export function splitRouteStyles(source, { laterSheets = [], sources = [], ownedSubjects = {} } = {}) {
  const original = postcss.parse(source);
  const ownership = new Map(Object.entries(ownedSubjects));
  const facts = [];
  const partsOf = new Map();
  let order = 0;
  rulesOf(original, (rule) => {
    const parts = declarationParts(rule, ownerOf(rule) ?? "critical", ownership).map((part) => ({
      ...part, fact: ruleFacts(part.rule, order, part.sheet, ownership),
    }));
    partsOf.set(rule, parts);
    facts.push(...parts.map((part) => part.fact));
    order += 1;
  });
  const laterFacts = laterSheets.flatMap((sheet) => {
    const result = [];
    rulesOf(postcss.parse(sheet), (rule) => result.push(ruleFacts(rule, Infinity, "later", ownership)));
    return result;
  });
  const kept = cascadeConflicts(facts, laterFacts, coMatchTest(sources));
  const sheets = Object.fromEntries(["critical", ...ROUTE_STYLE_PREFIXES].map((name) => [name, postcss.root()]));
  function partition(nodes, target) {
    for (const node of nodes) {
      if (node.type === "atrule" && ["media", "supports", "container"].includes(node.name)) {
        const children = Object.fromEntries(Object.keys(sheets).map((name) => [name, postcss.root()]));
        partition(node.nodes || [], children);
        for (const [name, child] of Object.entries(children)) {
          if (child.nodes.length) target[name].append(node.clone({ nodes: child.nodes }));
        }
      } else if (node.type === "rule" && partsOf.has(node)) {
        const nodesBySheet = new Map();
        for (const { fact, nodes: declarations } of partsOf.get(node)) {
          const sheet = kept.has(fact.rule) ? "critical" : fact.sheet;
          if (!nodesBySheet.has(sheet)) nodesBySheet.set(sheet, new Set());
          for (const declaration of declarations) nodesBySheet.get(sheet).add(declaration);
        }
        for (const [sheet, declarations] of nodesBySheet) {
          // Coalesce parts of the original rule, retaining declaration order
          // and avoiding one repeated selector per property family.
          target[sheet].append(node.clone({ nodes: node.nodes.filter((declaration) => declarations.has(declaration)).map((declaration) => declaration.clone()) }));
        }
      } else {
        target.critical.append(node.clone());
      }
    }
  }
  partition(original.nodes, sheets);
  return Object.fromEntries(Object.entries(sheets).map(([name, root]) => [name, root.toString()]));
}

// Prefixes a module names, i.e. the route sheets it must import.
export function routeSheetsFor(code) {
  return ROUTE_STYLE_PREFIXES.filter((prefix) => classPattern(prefix).test(code));
}

function cssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith(".css") ? [path] : [];
  }).sort();
}

// Stylesheets the entry reaches through static imports. Component sheets
// precede styles.css; the globals main.jsx imports after it are counted in
// laterSheets below, even though they are eager too.
function eagerStylesheets(root) {
  const seen = new Set();
  const sheets = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const code = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    for (const match of code.matchAll(/(?:^|[\n;])\s*(?:import|export)\s(?:[^;'"]*?\sfrom\s*)?["'](\.[^"']+)["']/g)) {
      const target = join(path, "..", match[1]);
      if (target.endsWith(".css")) sheets.add(target);
      else {
        const file = [target, `${target}.js`, `${target}.jsx`, `${target}.ts`, `${target}.tsx`].find((candidate) => {
          try { return readFileSync(candidate) && true; } catch { return false; }
        });
        if (file) visit(file);
      }
    }
  };
  visit(join(root, "src/main.jsx"));
  return sheets;
}

// The emitted-order check reads the same source boundaries as the build,
// including component sheets that may load after a route.
export function routeStyleInputs(root) {
  const stylesPath = join(root, "src/styles.css");
  const eager = eagerStylesheets(root);
  const otherSheets = cssFiles(join(root, "src"))
    .filter((path) => path !== stylesPath)
    .map((path) => ({ path, css: readFileSync(path, "utf8") }));
  const laterSheets = otherSheets.filter(({ path }) => !eager.has(path) || /\/src\/(?:coordinator-theme|motion|popups)\.css$/.test(path));
  const contractPath = join(root, "config/route-style-owned-subjects.json");
  const ownedSubjects = {};
  if (existsSync(contractPath)) {
    const contract = JSON.parse(readFileSync(contractPath, "utf8"));
    for (const path of contract.renderers) {
      if (!readFileSync(join(root, path), "utf8").includes(contract.marker)) throw new Error(`Route subject owner marker missing: ${path}`);
    }
    for (const { selector, classes } of contract.subjects) ownedSubjects[selector] = { marker: contract.marker, classes };
  }
  return { source: readFileSync(stylesPath, "utf8"), laterSheets, otherSheets, ownedSubjects, sources: sourceIndex(root) };
}

export function readRouteStyles(root) {
  const { source, laterSheets, sources, ownedSubjects } = routeStyleInputs(root);
  return splitRouteStyles(source, { laterSheets: laterSheets.map((sheet) => sheet.css), sources, ownedSubjects });
}

export function routeStylesPlugin() {
  let root;
  let sheets = null;
  const read = () => (sheets ??= readRouteStyles(root));
  return {
    name: "route-styles",
    enforce: "pre",
    configResolved(config) { root = config.root; },
    buildStart() { sheets = null; },
    resolveId(id) { return id.startsWith(VIRTUAL_PREFIX) ? `\0${id}` : undefined; },
    load(id) {
      if (!id.startsWith(`\0${VIRTUAL_PREFIX}`)) return undefined;
      return read()[id.slice(VIRTUAL_PREFIX.length + 1, -".css".length)] ?? "";
    },
    transform(code, id) {
      const path = relative(root, id.split("?")[0]);
      if (path === "src/styles.css") return { code: read().critical, map: null };
      if (!path.startsWith("src/") || !SOURCE_PATTERN.test(path) || QUERY_ONLY_SOURCES.includes(path)) return undefined;
      const imports = routeSheetsFor(code).filter((prefix) => {
        // The shell tour names case-view targets but never renders them.
        // Remove only literal target properties: any other reference (even
        // an open class template) still imports the sheet and fails the cold
        // renderer proof rather than inheriting a file-wide exemption.
        if (path !== "src/components/FloatingControls.jsx" || prefix !== "mcases") return true;
        const withoutTargets = code.replace(/\btarget:\s*(?:"[^"\n]*"|'[^'\n]*')/g, "");
        return classPattern(prefix).test(withoutTargets);
      }).map((prefix) => `import "${VIRTUAL_PREFIX}${prefix}.css";`);
      return imports.length ? { code: `${imports.join("\n")}\n${code}`, map: null } : undefined;
    },
    // A route sheet the entry chunk reaches statically would be critical
    // again, and would sit before styles.css in the cascade: fail the build.
    generateBundle(_options, bundle) {
      const eager = new Set();
      const visit = (fileName) => {
        const chunk = bundle[fileName];
        if (!chunk || chunk.type !== "chunk" || eager.has(fileName)) return;
        eager.add(fileName);
        chunk.imports.forEach(visit);
      };
      Object.values(bundle).filter((chunk) => chunk.type === "chunk" && chunk.isEntry).forEach((chunk) => visit(chunk.fileName));
      const reached = [...eager].flatMap((fileName) => Object.keys(bundle[fileName].modules))
        .filter((id) => id.startsWith(`\0${VIRTUAL_PREFIX}`));
      if (reached.length) this.error(`route stylesheets reached the entry chunk: ${reached.map((id) => id.slice(1)).join(", ")}`);
    },
    // The route sheets are virtual modules, not importers of styles.css, so
    // Vite would keep serving their cached CSS after the reload.
    handleHotUpdate(context) {
      if (!context.file.endsWith("/src/styles.css")) return;
      sheets = null;
      const { moduleGraph } = context.server;
      for (const prefix of ROUTE_STYLE_PREFIXES) {
        const module = moduleGraph.getModuleById(`\0${VIRTUAL_PREFIX}${prefix}.css`);
        if (module) moduleGraph.invalidateModule(module);
      }
      context.server.ws.send({ type: "full-reload" });
    },
  };
}
