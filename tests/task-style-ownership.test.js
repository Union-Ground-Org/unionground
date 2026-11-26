// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { ROUTE_STYLE_PREFIXES, readRouteStyles, splitRouteStyles, subjectOf } from "../scripts/lib/route-styles.mjs";

const reactRequire = createRequire(import.meta.resolve("@vitejs/plugin-react"));
const { parse } = createRequire(reactRequire.resolve("@babel/core"))("@babel/parser");
const contract = JSON.parse(readFileSync("config/route-style-owned-subjects.json", "utf8"));
const forward = { BusyButton: "button", BusyInput: "input", BusySelect: "select", BusyTextarea: "textarea", BusyFieldset: "fieldset" };
const files = new Map();
function visit(node, callback) {
  if (!node || typeof node !== "object") return;
  if (node.type) callback(node);
  for (const [key, value] of Object.entries(node)) {
    if (["start", "end", "loc", "extra"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => visit(child, callback));
    else if (value && typeof value === "object") visit(value, callback);
  }
}
(function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scan(path);
    else if (/\.[jt]sx?$/.test(path)) files.set(path, readFileSync(path, "utf8"));
  }
})("src");

function context(path) {
  const text = files.get(path), ast = parse(text, { sourceType: "module", plugins: ["jsx", ...(/\.tsx?$/.test(path) ? ["typescript"] : [])] });
  const locals = new Map(), ambiguous = new Set(), icons = new Set(), roots = new Map();
  const addLocal = (name, body) => { if (locals.has(name)) ambiguous.add(name); locals.set(name, body); };
  visit(ast, (node) => {
    if (node.type === "ImportDeclaration" && node.source.value === "lucide-react") node.specifiers.forEach((specifier) => icons.add(specifier.local.name));
    if (node.type === "FunctionDeclaration" && node.id) addLocal(node.id.name, node.body);
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)) addLocal(node.id.name, node.init.body);
    if (node.type !== "JSXElement") return;
    const attr = node.openingElement.attributes.find((item) => item.type === "JSXAttribute" && item.name.name === "className");
    if (!attr) return;
    for (const match of text.slice(attr.start, attr.end).matchAll(/(?:kan|tasks)-[\w-]+/g)) {
      if (!roots.has(match[0])) roots.set(match[0], []);
      roots.get(match[0]).push(node);
    }
  });
  return { ast, locals, ambiguous, icons, roots };
}
const contexts = new Map(contract.renderers.map((path) => [path, context(path)]));
const markerPattern = new RegExp(`(?:^|\\s)${contract.marker}(?:\\s|$)`);
function marked(expression) {
  if (!expression) return false;
  if (expression.type === "StringLiteral") return markerPattern.test(expression.value);
  if (expression.type === "JSXExpressionContainer") return marked(expression.expression);
  if (expression.type === "TemplateLiteral") return expression.quasis.some((part) => markerPattern.test(part.value.cooked));
  if (expression.type === "ConditionalExpression") return marked(expression.consequent) && marked(expression.alternate);
  if (expression.type === "BinaryExpression" && expression.operator === "+") return marked(expression.left) || marked(expression.right);
  return false;
}

function closedClassValue(expression) {
  if (!expression) return false;
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(expression.type)) return true;
  if (expression.type === "JSXExpressionContainer") return closedClassValue(expression.expression);
  if (expression.type === "TemplateLiteral") return expression.expressions.every(closedClassValue);
  if (expression.type === "ConditionalExpression") return closedClassValue(expression.consequent) && closedClassValue(expression.alternate);
  if (expression.type === "BinaryExpression" && expression.operator === "+") return closedClassValue(expression.left) && closedClassValue(expression.right);
  if (expression.type === "LogicalExpression" && expression.operator === "&&") return closedClassValue(expression.right);
  return false;
}

function inspectSubjects(node, ctx, types, seen = new Set(), classes = new Set()) {
  let count = 0;
  visit(node, (child) => {
    if (child.type === "JSXAttribute" && child.name.name === "dangerouslySetInnerHTML") throw new Error("Unbounded generated HTML in owned root");
    if (child.type === "JSXAttribute" && child.name.name === "className" && !closedClassValue(child.value)) throw new Error(`Unbounded class value at line ${child.loc.start.line}`);
    if (child.type === "JSXSpreadAttribute") throw new Error("Unbounded prop spread in owned root");
    if (child.type === "JSXExpressionContainer") {
      const value = child.expression;
      if ((value.type === "Identifier" && value.name === "children") || (value.type === "MemberExpression" && value.property.name === "children")) throw new Error("Unbounded children in owned root");
      if (value.type === "CallExpression" && value.callee.type === "Identifier" && /^render[A-Z]/.test(value.callee.name) && !ctx.locals.has(value.callee.name)) throw new Error("Injected renderer in owned root");
    }
    if (child.type !== "JSXOpeningElement") return;
    const name = child.name.name, tag = forward[name] ?? name;
    if ((Array.isArray(tag) ? tag : [tag]).some((value) => types.includes(value))) {
      const attr = child.attributes.find((item) => item.type === "JSXAttribute" && item.name.name === "className");
      if (!marked(attr?.value)) throw new Error(`Unowned ${name} at line ${child.loc.start.line}`);
      if (attr.value.type !== "StringLiteral") throw new Error("Owned class list must be a literal, closed inventory");
      attr.value.value.split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
      count += 1;
    }
    if (name && (/^[a-z]/.test(name) || name in forward || ctx.icons.has(name) || name === "Fragment")) return;
    if (ctx.ambiguous.has(name)) throw new Error(`Ambiguous local renderer ${name}`);
    if (ctx.locals.has(name) && !seen.has(name)) {
      seen.add(name);
      count += inspectSubjects(ctx.locals.get(name), ctx, types, seen, classes);
      return;
    }
    throw new Error(`Foreign renderer in owned root: ${name ?? "member JSX"}`);
  });
  return count;
}

describe("closed Tasks/Kanban subject ownership", () => {
  it("pins every marker renderer without adding a route namespace", () => {
    const renderers = [];
    let markerSites = 0;
    for (const [path, text] of files) {
      if (!text.includes(contract.marker)) continue;
      const ctx = contexts.get(path) ?? context(path);
      let rendersMarker = false;
      visit(ctx.ast, (node) => {
        if (node.type === "JSXAttribute" && node.name.name === "className" && marked(node.value)) {
          rendersMarker = true;
          markerSites += 1;
        }
      });
      if (rendersMarker) renderers.push(path);
    }
    expect(renderers.sort()).toEqual(contract.renderers);
    expect(markerSites).toBe(162);
    expect(contract.subjects).toHaveLength(108);
    expect(ROUTE_STYLE_PREFIXES.some((prefix) => contract.marker.startsWith(`${prefix}-`) || contract.marker.startsWith(`${prefix}__`))).toBe(false);
  });

  it("pins the complete source declaration and byte inventories of the two ownership families", () => {
    const sheets = readRouteStyles(process.cwd());
    // Exact declaration and byte counts for the public Tasks and Kanban route sheets.
    for (const [name, bytes, declarations] of [["tasks", 19540, 330], ["kan", 9984, 282]]) {
      let count = 0;
      postcss.parse(sheets[name]).walkDecls(() => { count += 1; });
      expect(Buffer.byteLength(sheets[name]), name).toBe(bytes);
      expect(count, name).toBe(declarations);
    }
  });

  it("proves every declared selector's complete, closed JSX subject inventory", () => {
    const selectors = new Set();
    postcss.parse(readFileSync("src/styles.css", "utf8")).walkRules((rule) => rule.selectors.forEach((selector) => selectors.add(selector)));
    const unique = new Set();
    for (const subject of contract.subjects) {
      expect(selectors.has(subject.selector), subject.selector).toBe(true);
      expect(unique.has(subject.selector)).toBe(false);
      unique.add(subject.selector);
      const ancestor = new RegExp(`\\.${subject.root}(?![\\w-])`).exec(subject.selector)?.index ?? -1;
      expect(ancestor, subject.selector).toBeGreaterThanOrEqual(0);
      expect(subject.selector.slice(0, ancestor), subject.selector).not.toContain("(");
      // The pinned root must be an actual ancestor, not a sibling or a class
      // named only in :not/:has. Subject-level :is(p,li) is still supported.
      expect(subject.selector.slice(ancestor + subject.root.length + 1), subject.selector)
        .toMatch(/^(?:\.[\w-]+|#[\w-]+|:[\w-]+|\[[^\]]*\])*(?:\s+|>)/);
      const original = subjectOf(subject.selector);
      expect(original.alternatives.map((alternative) => alternative.element), subject.selector).toEqual(subject.types);
      expect(original.alternatives.every((alternative) => !alternative.classes.length)).toBe(true);
      const pattern = new RegExp(`(?<![\\w-])${subject.root}(?![\\w-])`);
      expect([...files].filter(([, text]) => pattern.test(text)).map(([path]) => path).sort(), subject.root).toEqual([...subject.renderers].sort());
      const allClasses = new Set();
      for (const path of subject.renderers) {
        const ctx = contexts.get(path), roots = ctx.roots.get(subject.root);
        expect(roots?.length, `${path} ${subject.root}`).toBeGreaterThan(0);
        let count = 0;
        const classes = new Set();
        for (const root of roots) {
          try { count += inspectSubjects(root, ctx, subject.types, new Set(), classes); }
          catch (error) { throw new Error(`${path} ${subject.selector}: ${error.message}`, { cause: error }); }
        }
        expect(count, `${path} ${subject.selector}`).toBeGreaterThan(0);
        // The manifest is a conservative union across its pinned renderers.
        classes.forEach((name) => allClasses.add(name));
      }
      expect(subject.classes, subject.selector).toEqual([...allClasses].sort());
    }
    expect(unique.size).toBe(contract.subjects.length);
  });

  it("uses the audited class inventory only to rule out impossible subject classes", () => {
    const source = ".kan-card p { color: red; } p.outside { color: blue; }";
    const sources = ['"kan-card task-owned outside"'];
    expect(splitRouteStyles(source, { sources }).kan).toBe("");
    expect(splitRouteStyles(source, { sources, ownedSubjects: { ".kan-card p": contract.marker } }).kan).toBe("");
    const ownedSubjects = { ".kan-card p": { marker: contract.marker, classes: [contract.marker] } };
    expect(splitRouteStyles(source, { sources, ownedSubjects }).kan).toContain("color: red;");
    ownedSubjects[".kan-card p"].classes.push("outside");
    expect(splitRouteStyles(source, { sources, ownedSubjects }).kan).toBe("");
  });

  it("does not unlock an unproved family by narrowing one of its critical rivals", () => {
    const source = "p.voice-card { padding: 8px; } .kan-card p { padding: 9px; }";
    // Equal specificity for the classed route rule and the anonymous rival.
    const sources = ['"voice-card"', '"kan-card task-owned"'];
    const ownedSubjects = { ".kan-card p": { marker: contract.marker, classes: [contract.marker] } };
    expect(splitRouteStyles(source, { sources, ownedSubjects }).voice).toBe("");
  });

  it("keeps undeclared anonymous subjects conservative and still retains real rivals", () => {
    const source = ".kan-card p { color: red; display: block; } .other-child > p { color: blue; }";
    const sources = ['"kan-card task-owned"', '"other-child"'];
    expect(splitRouteStyles(source, { sources }).kan).toBe("");
    const ownedSubjects = { ".kan-card p": contract.marker };
    expect(splitRouteStyles(source, { sources, ownedSubjects }).kan).toContain("color: red;");
    const competing = splitRouteStyles(source, { sources: ['"kan-card task-owned other-child"'], ownedSubjects });
    expect(competing.critical).toContain("color: red;");
    expect(competing.kan).toContain("display: block;");
  });
});
