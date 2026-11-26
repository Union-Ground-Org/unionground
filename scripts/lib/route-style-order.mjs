import postcss from "postcss";
import { createRequire } from "node:module";
import { coMatchTest, specificity, subjectOf } from "./route-styles.mjs";

// Independent of the splitter's family table: this is the order contract's
// overlap model, including logical axes and legacy shorthand aliases.
function family(property) {
  const prop = property.toLowerCase().replace(/^-(?:webkit|moz|ms|o)-/, "");
  if (prop.startsWith("--")) return prop;
  if (prop === "all") return "*";
  if (/^(?:width|height|inline-size|block-size)$/.test(prop)) return "size";
  if (/^grid-(?:row-|column-)?gap$/.test(prop)) return "gap";
  if (/^white-space(?:-|$)/.test(prop)) return "text";
  if (prop === "word-wrap") return "overflow";
  if (prop === "columns") return "gap";
  if (/^page-break-/.test(prop)) return "break";
  if (prop === "color-adjust") return "print";
  const head = prop.split("-")[0];
  return [["inset", "top", "right", "bottom", "left"], ["place", "align", "justify"],
    ["gap", "row", "column"], ["font", "line"]].find((group) => group.includes(head))?.[0] ?? head;
}

function wrappers(rule) {
  const result = [];
  for (let node = rule.parent; node?.type !== "root"; node = node.parent) {
    if (node.type === "atrule") result.unshift([node.name, node.params]);
    else if (node.type === "rule") result.unshift(["rule", node.selector]);
  }
  return result;
}

function rules(css) {
  const result = [];
  postcss.parse(css).walkRules((rule) => {
    if (!wrappers(rule).some(([name]) => /keyframes$/.test(name))) result.push(rule);
  });
  return result;
}

const declarations = (rule) => rule.nodes.filter((node) => node.type === "decl");
const declarationKey = (rule, decl) => JSON.stringify([wrappers(rule), rule.selector, decl.prop, decl.value, Boolean(decl.important)]);
const token = (decl) => JSON.stringify([decl.prop.toLowerCase(), decl.value, Boolean(decl.important)]);
const selectorKey = (rule, selector) => JSON.stringify([wrappers(rule), selector.replace(/::(before|after|first-line|first-letter)/g, ":$1")]);

function fact(rule, sheet, order, ownedSubjects) {
  return { rule, sheet, order,
    families: new Set(declarations(rule).map((decl) => `${family(decl.prop)}${decl.important ? "!" : ""}`)),
    selectors: rule.selectors.map((selector) => ({ specificity: specificity(selector).join(","), subject: subjectOf(selector, ownedSubjects) })),
  };
}

function orderedSubsequence(wanted, actual) {
  let index = 0;
  for (const value of actual) if (wanted[index] === value) index += 1;
  return index === wanted.length;
}

// Check original declaration order before trusting any minifier rewrite.
// The returned facts retain the source rule's position, not partition order.
function sourceFacts(source, partitions, ownedSubjects) {
  const queues = new Map();
  let declarationCount = 0;
  rules(source).forEach((rule, order) => declarations(rule).forEach((decl, position) => {
    const key = declarationKey(rule, decl);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push({ order, position });
    declarationCount += 1;
  }));
  const facts = [];
  for (const [sheet, css] of Object.entries(partitions)) {
    for (const rule of rules(css)) {
      const positions = declarations(rule).map((decl) => {
        const entry = queues.get(declarationKey(rule, decl))?.shift();
        if (!entry) throw new Error(`Missing or duplicated source declaration: ${sheet} ${rule.selector} ${decl}`);
        return entry;
      });
      if (!positions.length) continue;
      if (positions.some((entry, index) => entry.order !== positions[0].order
        || (index > 0 && entry.position <= positions[index - 1].position))) {
        throw new Error(`Changed declaration order inside fragment: ${sheet} ${rule.selector}`);
      }
      facts.push(fact(rule, sheet, positions[0].order, ownedSubjects));
    }
  }
  if ([...queues.values()].some((queue) => queue.length)) throw new Error("Source declarations missing from the partition");
  return { facts, declarationCount };
}

function checkRivals(facts, laterSheets, sources, ownedSubjects) {
  const later = laterSheets.flatMap(({ css, path }) => rules(css).map((rule) => ({ ...fact(rule, "later", Infinity, ownedSubjects), path })));
  const all = [...facts, ...later], byFamily = new Map(), coMatch = coMatchTest(sources);
  for (const entry of all) for (const name of entry.families) {
    if (!byFamily.has(name)) byFamily.set(name, []);
    byFamily.get(name).push(entry);
  }
  for (const entry of facts) {
    if (entry.sheet === "critical") continue;
    const rivals = new Set();
    for (const name of entry.families) {
      const wildcard = name.endsWith("!") ? "*!" : "*";
      for (const other of name === wildcard ? all.filter((item) => [...item.families].some((value) => value.endsWith("!") === name.endsWith("!")))
        : [...byFamily.get(name), ...(byFamily.get(wildcard) ?? [])]) rivals.add(other);
    }
    for (const other of rivals) {
      if (other.sheet === entry.sheet || (other.sheet === "critical" && other.order <= entry.order)) continue;
      if (!entry.selectors.some((mine) => other.selectors.some((theirs) => mine.specificity === theirs.specificity
        && coMatch(mine.subject, theirs.subject, ["tasks", "kan"].includes(entry.sheet))))) continue;
      throw new Error(`Cross-sheet equal-specificity rival: ${entry.sheet} ${entry.rule.selector} vs ${other.path ?? other.sheet} ${other.rule.selector}`);
    }
  }
}

function withWrappers(rule) {
  let node = rule.clone();
  for (const [name, params] of wrappers(rule).reverse()) {
    if (name === "rule") node = postcss.rule({ selector: params, nodes: [node] });
    else node = postcss.atRule({ name, params, nodes: [node] });
  }
  return node.toString();
}

// Use the production browser floor. Expected fragments are normalized in
// separate layers so the minifier cannot merge two source fragments before
// their individual declaration order has been checked.
// Resolve Vite's own compiler, rather than normalize its output through a
// different minifier (background:none and place-self have different forms).
const { transform } = createRequire(import.meta.resolve("vite"))("lightningcss");
const CSS_TARGETS = { edge: 88 << 16, firefox: 78 << 16, chrome: 87 << 16, safari: 14 << 16 };
const normalize = async (css) => transform({ filename: "route-order.css", code: Buffer.from(css), minify: true, targets: CSS_TARGETS }).code.toString();

export async function verifyRouteStyleOrder({ source, partitions, laterSheets = [], otherSheets = laterSheets, ownedSubjects = {}, sources = [], assets, criticalAsset }) {
  const ownership = new Map(Object.entries(ownedSubjects));
  const { facts, declarationCount } = sourceFacts(source, partitions, ownership);
  checkRivals(facts, laterSheets, sources, ownership);
  if (!assets || !(criticalAsset in assets)) throw new Error("Missing emitted head stylesheet");
  const emitted = new Map();
  for (const [asset, css] of Object.entries(assets)) {
    // These are already production output. Re-minifying them would sort
    // independent properties again and conceal a post-build reordering.
    for (const rule of rules(css)) for (const selector of rule.selectors) {
      const key = selectorKey(rule, selector);
      if (!emitted.has(key)) emitted.set(key, new Map());
      const locations = emitted.get(key);
      if (!locations.has(asset)) locations.set(asset, []);
      locations.get(asset).push(...declarations(rule).map(token));
    }
  }
  const normalized = postcss.parse(await normalize(facts.map((entry, index) => `@layer __route_order_${index}{${withWrappers(entry.rule)}}`).join("\n")));
  const allowed = new Map(), sourceFamilies = new Set(), movedSelectors = new Set(), sheetCandidates = new Map([["critical", new Set([criticalAsset])]]);
  let movedFragments = 0;
  for (const layer of normalized.nodes) {
    if (layer.type === "atrule" && layer.name === "charset") continue;
    if (layer.type !== "atrule" || layer.name !== "layer") throw new Error("Lost fragment normalization boundary");
    const entry = facts[Number(layer.params.slice("__route_order_".length))];
    const candidates = new Set(Object.keys(assets).filter((asset) => (entry.sheet === "critical") === (asset === criticalAsset)));
    const fragmentRoot = postcss.root({ nodes: layer.nodes.map((node) => node.clone()) });
    fragmentRoot.walkRules((rule) => {
      const wanted = declarations(rule).map(token);
      for (const selector of rule.selectors) {
        const key = selectorKey(rule, selector);
        for (const decl of declarations(rule)) {
          const item = JSON.stringify([key, token(decl)]);
          if (!allowed.has(item)) allowed.set(item, new Set());
          allowed.get(item).add(entry.sheet);
          sourceFamilies.add(JSON.stringify([key, family(decl.prop), Boolean(decl.important)]));
        }
        if (entry.sheet === "critical") continue;
        movedSelectors.add(key);
        const locations = emitted.get(key);
        for (const candidate of candidates) {
          if (!orderedSubsequence(wanted, locations?.get(candidate) ?? [])) candidates.delete(candidate);
        }
      }
    });
    if (entry.sheet === "critical") continue;
    if (!candidates.size) throw new Error(`Emitted fragment missing, misplaced or reordered: ${entry.sheet} ${entry.rule.selector}`);
    const previous = sheetCandidates.get(entry.sheet) ?? candidates;
    sheetCandidates.set(entry.sheet, new Set([...previous].filter((asset) => candidates.has(asset))));
    movedFragments += 1;
  }
  const sheetAssets = new Map();
  for (const [sheet, candidates] of sheetCandidates) {
    if (candidates.size !== 1) throw new Error(`Ambiguous emitted route sheet: ${sheet}: ${[...candidates]}`);
    sheetAssets.set(sheet, [...candidates][0]);
  }
  // Component/eager CSS can legitimately use a selector also in styles.css.
  // Account for those unchanged source declarations before rejecting an extra
  // declaration or a critical declaration copied into a lazy asset.
  const external = new Set();
  for (const { css } of otherSheets) for (const rule of rules(await normalize(css))) for (const selector of rule.selectors) {
    for (const decl of declarations(rule)) external.add(JSON.stringify([selectorKey(rule, selector), token(decl)]));
  }
  for (const [key, locations] of emitted) for (const [asset, tokens] of locations) for (const value of tokens) {
    if (asset === criticalAsset && !movedSelectors.has(key)) continue;
    const [property, , important] = JSON.parse(value), item = JSON.stringify([key, value]);
    if (!sourceFamilies.has(JSON.stringify([key, family(property), important])) || external.has(item)) continue;
    const sheets = allowed.get(item);
    if (!sheets || ![...sheets].some((sheet) => sheetAssets.get(sheet) === asset)) {
      throw new Error(`Cross-sheet emitted declaration absent from its source placement: ${asset} ${key} ${value}`);
    }
  }
  // Also inspect declarations introduced only in the output. Checking the
  // source partition alone would miss a plugin copying or adding a rival
  // under a different selector, even when every expected fragment is intact.
  const coMatch = coMatchTest(sources);
  const moved = facts.filter((entry) => entry.sheet !== "critical");
  for (const [asset, css] of Object.entries(assets)) for (const rule of rules(css)) for (const selector of rule.selectors) {
    const key = selectorKey(rule, selector);
    const unknown = declarations(rule).filter((decl) => {
      const item = JSON.stringify([key, token(decl)]);
      return !allowed.has(item) && !external.has(item);
    });
    if (!unknown.length) continue;
    const other = fact(rule.clone({ selector, nodes: unknown.map((decl) => decl.clone()) }), asset, Infinity, ownership);
    for (const entry of moved) {
      if (sheetAssets.get(entry.sheet) === asset) continue;
      const overlap = [...entry.families].some((name) => [...other.families].some((rival) => name === rival
        || (name.endsWith("!") === rival.endsWith("!") && [name, rival].some((value) => value === "*" || value === "*!"))));
      if (overlap && entry.selectors.some((mine) => other.selectors.some((theirs) => mine.specificity === theirs.specificity
        && coMatch(mine.subject, theirs.subject, ["tasks", "kan"].includes(entry.sheet))))) {
        throw new Error(`Unaccounted emitted rival: ${entry.sheet} ${entry.rule.selector} vs ${asset} ${selector}`);
      }
    }
  }
  return { declarations: declarationCount, fragments: facts.length, movedFragments, assets: Object.keys(assets).length };
}
