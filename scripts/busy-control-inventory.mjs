#!/usr/bin/env node
// Read-only candidate inventory for #8435. This is a heuristic, not proof
// that a handler writes or that its synchronous re-entry guard is correct.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

// A state name (or a string a state is compared with, such as
// phase === "creating") that says a write or a read is in flight. Reads are
// counted too, so a reviewer decides each one; they go on the exemption list.
// #9914 (carved from #8435): opening and checking were missing, which hid the
// Open task button and both ballot receipt lookups.
// #9927 (carved from #8435): paging, reading, retrying and searching
// hid load-more, retry and search buttons that disabled themselves.
const busyName = /busy|saving|pending|submitting|working|inFlight|creating|sending|adding|deleting|removing|publishing|uploading|posting|requesting|exporting|importing|running|loading|opening|checking|paging|reading|retrying|searching|refreshing|applying|deciding|dismissing|granting|hiding|restoring|minting|wording|verifying|reviewing/i;
const pendingControls = new Set(["BusyButton", "BusyInput", "BusySelect", "BusyTextarea", "BusyFieldset", "BusyRegion", "Button", "Switch"]);
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.type) visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "extra", "comments", "tokens"].includes(key)) continue;
    for (const child of Array.isArray(value) ? value : [value]) if (child && typeof child === "object") walk(child, visit);
  }
}
const tagName = node => node?.type === "JSXIdentifier" ? node.name : node?.type === "JSXMemberExpression" ? `${tagName(node.object)}.${tagName(node.property)}` : "unknown";
function identifiers(node) { const found = []; walk(node, part => { if (part.type === "Identifier") found.push(part.name); }); return found; }
function literals(node) {
  const found = [];
  walk(node, part => {
    if (part.type === "StringLiteral") found.push(part.value);
    else if (part.type === "TemplateElement") found.push(part.value.cooked ?? part.value.raw);
  });
  return found;
}
const nativeTag = tag => /^[a-z]/.test(tag);
const formControl = tag => ["button", "input", "select", "textarea", "fieldset"].includes(tag);

export function inventorySource(source, file) {
  // A declaration file (src/lib/shared-core/*.d.ts) is parsed as one: its
  // initializer-less `export const NAME: string;` lines are valid there.
  const plugins = /\.d\.ts$/.test(file) ? [["typescript", { dts: true }]] : ["jsx", ...(/\.tsx?$/.test(file) ? ["typescript"] : [])];
  const ast = parse(source, { sourceType: "module", plugins });
  const declarations = [];
  const aliases = new Set();
  walk(ast, node => { if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) declarations.push(node); });
  // File-level aliases catch canSubmit/locked predicates without pretending
  // this is a complete scope or data-flow analysis. Cycles terminate.
  for (let pass = 0; pass < declarations.length; pass += 1) {
    let added = false;
    for (const node of declarations) if (!aliases.has(node.id.name) && identifiers(node.init).some(name => busyName.test(name) || aliases.has(name))) {
      aliases.add(node.id.name); added = true;
    }
    if (!added) break;
  }
  // Rest parameters (and whole props objects) a component spreads onto a
  // native control can carry its caller's disabled; spreading them is a
  // pass-through the inventory cannot see into.
  const passedProps = new Set();
  walk(ast, node => {
    if (!/Function|ArrowFunction/.test(node.type) || !node.params) return;
    for (const param of node.params) {
      if (param.type === "Identifier" && /^(props|rest|others)$/.test(param.name)) passedProps.add(param.name);
      if (param.type === "ObjectPattern") for (const property of param.properties) if (property.type === "RestElement" && property.argument.type === "Identifier") passedProps.add(property.argument.name);
    }
  });
  const busyLike = node => identifiers(node).some(name => busyName.test(name) || aliases.has(name)) || literals(node).some(value => busyName.test(value));
  // Whether a spread's object can carry disabled, so a reviewer need not open
  // the file. "yes" or "no" only when the spread resolves to object literals in
  // this file: inline, a local variable's initializer, a conditional or logical
  // choice between them, or what a local function returns. Anything else (a
  // member expression, an import, a prop, a call the file does not define) is
  // "unknown", so "no" can be trusted to skip a row (ledger 372).
  const localDeclaration = name => {
    const variable = declarations.find(node => node.id.name === name);
    if (variable) return variable.init;
    let found = null;
    walk(ast, node => { if (!found && node.type === "FunctionDeclaration" && node.id?.name === name) found = node; });
    return found;
  };
  // One property of an object literal: a plain or statically known computed
  // key is yes or no; a computed key the file does not fix, or a nested spread
  // that cannot be resolved, is unknown. A definite disabled key wins.
  // The visited set travels into nested spreads, so a helper that spreads its
  // own call (props() -> { ...props(0) }) resolves once and ends (ledger 391).
  const keyCarries = (property, seen) => {
    if (property.type === "SpreadElement") return resolveCarries(property.argument, seen);
    const key = property.key;
    if (!property.computed) return key?.name === "disabled" || key?.value === "disabled" ? "yes" : "no";
    const literal = key?.type === "StringLiteral" ? key.value
      : key?.type === "TemplateLiteral" && key.expressions.length === 0 ? key.quasis[0].value.cooked : null;
    if (literal === null) return "unknown";
    return literal === "disabled" ? "yes" : "no";
  };
  const objectCarries = (object, seen) => {
    const answers = object.properties.map(property => keyCarries(property, seen));
    return answers.includes("yes") ? "yes" : answers.includes("unknown") ? "unknown" : "no";
  };
  const combine = answers => answers.includes("unknown") ? "unknown" : answers.includes("yes") ? "yes" : "no";
  const returnedValues = fn => {
    if (fn.body.type !== "BlockStatement") return [fn.body];
    const values = [];
    walk(fn.body, node => { if (node.type === "ReturnStatement") values.push(node.argument); });
    return values;
  };
  function resolveCarries(node, seen) {
    if (!node) return "unknown";
    if (node.type === "ObjectExpression") return objectCarries(node, seen);
    if (node.type === "ConditionalExpression") return combine([resolveCarries(node.consequent, seen), resolveCarries(node.alternate, seen)]);
    if (node.type === "LogicalExpression") return combine([resolveCarries(node.left, seen), resolveCarries(node.right, seen)]);
    if (node.type === "Identifier" || (node.type === "CallExpression" && node.callee.type === "Identifier")) {
      const name = node.type === "Identifier" ? node.name : node.callee.name;
      if (seen.has(name) || passedProps.has(name)) return "unknown";
      const declaration = localDeclaration(name);
      if (!declaration) return "unknown";
      const next = new Set(seen).add(name);
      if (node.type === "Identifier") return /Function/.test(declaration.type) ? "unknown" : resolveCarries(declaration, next);
      if (!/Function/.test(declaration.type)) return "unknown";
      const values = returnedValues(declaration);
      return values.length ? combine(values.map(value => resolveCarries(value, next))) : "unknown";
    }
    return "unknown";
  }
  const carriesDisabled = argument => resolveCarries(argument, new Set());
  const nativeDisabled = [], pending = [], uncounted = [];
  walk(ast, node => {
    if (node.type !== "JSXOpeningElement") return;
    const attribute = name => node.attributes.find(item => item.type === "JSXAttribute" && item.name.name === name);
    const expression = attr => attr?.value?.type === "JSXExpressionContainer" ? source.slice(attr.value.expression.start, attr.value.expression.end) : attr ? "true" : null;
    const tag = tagName(node.name);
    const row = { file, line: node.loc.start.line, tag };
    const disabled = attribute("disabled");
    const disabledExpression = disabled?.value?.expression;
    const before = nativeDisabled.length;
    if (disabledExpression && disabledExpression.type !== "JSXEmptyExpression" && busyLike(disabledExpression)) nativeDisabled.push({ ...row, expression: expression(disabled) });
    // disabled={disabled}: a native control that takes its caller's disabled.
    // Its callers are listed on their own rows; this row is converted with
    // them (the prop renamed to pending) or listed with a reason.
    else if (disabledExpression && nativeTag(tag) && (disabledExpression.type === "Identifier" ? disabledExpression.name === "disabled" : disabledExpression.type === "MemberExpression" && !disabledExpression.computed && disabledExpression.property.name === "disabled")) {
      nativeDisabled.push({ ...row, expression: expression(disabled), kind: "pass-through" });
    }
    // Every disabled the rule above does not count, on any tag (wrappers such
    // as BusyButton render a native disabled too), so a reviewer can read the
    // finite rest instead of trusting the name list (--uncounted).
    if (disabled && nativeDisabled.length === before) uncounted.push({ ...row, expression: expression(disabled) });
    // Spreads onto a form control or a Busy* wrapper can carry disabled. Only a
    // spread onto a native form control with no disabled= of its own is
    // counted; a spread beside its own disabled= (which may override it) and a
    // spread onto a wrapper are listed with the uncounted rows, so every way a
    // control gets disabled is in one list or the other (ledger 362).
    const wrapper = /^Busy/.test(tag.split(".").at(-1));
    if (formControl(tag) || wrapper) for (const item of node.attributes) {
      if (item.type !== "JSXSpreadAttribute") continue;
      const names = identifiers(item.argument);
      const carries = carriesDisabled(item.argument);
      const spread = { ...row, expression: `{...${source.slice(item.argument.start, item.argument.end)}}`, kind: "spread", carriesDisabled: carries };
      // A spread the rule does not count (its value names no busy state) can
      // still carry disabled, so it is listed with the uncounted rows.
      if (!disabled && formControl(tag) && (names.some(name => passedProps.has(name)) || busyLike(item.argument))) nativeDisabled.push(spread);
      else uncounted.push(spread);
    }
    const busy = attribute("pending");
    if (busy && pendingControls.has(tag.split(".").at(-1))) pending.push({ ...row, expression: expression(busy) });
  });
  return { nativeDisabled, pending, uncounted };
}

export function inventoryDirectory(root = process.cwd()) {
  const result = { schema: "busy-control-inventory/1", heuristic: true, nativeDisabled: [], pending: [], uncounted: [] };
  const scan = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name)) {
        const rows = inventorySource(readFileSync(path, "utf8"), relative(root, path).replaceAll("\\", "/"));
        result.nativeDisabled.push(...rows.nativeDisabled); result.pending.push(...rows.pending); result.uncounted.push(...rows.uncounted);
      }
    }
  };
  scan(join(root, "src"));
  result.counts = { nativeDisabledCandidates: result.nativeDisabled.length, candidateFiles: new Set(result.nativeDisabled.map(row => row.file)).size, pendingControls: result.pending.length, uncountedDisabled: result.uncounted.length };
  result.note = "Candidates may include reads and draft controls. Review each owner; pending props alone do not prove focus or re-entry safety.";
  return result;
}

// The reviewed exemption list (#8435's closing check). Each entry names one
// native-disabled control the inventory finds that stays native on purpose:
// the file, the tag, the exact disabled expression, how many such controls
// the file holds, why, and the pull request whose review accepted it. A
// count keeps a new identical control from hiding under an old entry.
export const EXEMPTIONS_FILE = "config/busy-control-exemptions.json";
// The kind is part of the key, so a pass-through entry (disabled) cannot go on
// matching once the same file aliases disabled to a busy value.
const kinds = ["expression", "pass-through", "spread"];
const keyOf = row => `${row.file}\u0000${row.tag}\u0000${row.kind ?? "expression"}\u0000${row.expression}`;

export function parseExemptions(text) {
  const data = JSON.parse(text);
  if (data?.schema !== "busy-control-exemptions/1" || !Array.isArray(data.entries)) throw new Error("busy-control exemptions: schema busy-control-exemptions/1 with an entries array is required");
  const seen = new Set();
  for (const [index, entry] of data.entries.entries()) {
    for (const field of ["file", "tag", "expression", "reason", "reviewedIn"]) {
      if (typeof entry?.[field] !== "string" || !entry[field].trim()) throw new Error(`busy-control exemptions: entry ${index} needs a non-empty ${field}`);
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) throw new Error(`busy-control exemptions: entry ${index} needs a positive whole count`);
    if (entry.kind !== undefined && !kinds.includes(entry.kind)) throw new Error(`busy-control exemptions: entry ${index} has an unknown kind ${entry.kind}`);
    const key = keyOf(entry);
    if (seen.has(key)) throw new Error(`busy-control exemptions: entry ${index} repeats ${entry.file} <${entry.tag}> disabled={${entry.expression}}`);
    seen.add(key);
  }
  return data.entries;
}

export function loadExemptions(root = process.cwd()) {
  return parseExemptions(readFileSync(join(root, EXEMPTIONS_FILE), "utf8"));
}

// A candidate passes only when an entry lists its file, tag and expression and
// the file holds exactly the listed number of them. More of them than listed
// are unlisted; fewer, or none, make the entry stale. Either fails the check.
export function checkInventory(report, entries) {
  const groups = new Map();
  for (const row of report.nativeDisabled) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const unlisted = [], stale = [];
  const listed = new Map(entries.map(entry => [keyOf(entry), entry]));
  for (const [key, rows] of groups) {
    const entry = listed.get(key);
    if (!entry) unlisted.push(...rows);
    else if (rows.length > entry.count) unlisted.push(...rows.map(row => ({ ...row, listedCount: entry.count, foundCount: rows.length })));
    else if (rows.length < entry.count) stale.push({ ...entry, foundCount: rows.length });
  }
  for (const [key, entry] of listed) if (!groups.has(key)) stale.push({ ...entry, foundCount: 0 });
  return { ok: unlisted.length === 0 && stale.length === 0, unlisted, stale };
}

const usage = "Read-only #8435 inventory: node scripts/busy-control-inventory.mjs [--json | --check | --uncounted]\n  --check fails when a control natively disables for its own write and is neither converted nor listed in " + EXEMPTIONS_FILE + "\n  --uncounted lists every disabled= under src/ (any tag, and spreads onto form controls and Busy* wrappers) that the rule does not count; apps/mobile is not scanned";

// A spread row says whether its object can carry disabled: yes, no, or unknown.
const carriesText = row => row.carriesDisabled ? ` carries-disabled=${row.carriesDisabled}` : "";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !["--json", "--help", "--check", "--uncounted"].includes(args[0]))) throw new Error("Use --json, --check, --uncounted or --help");
  if (args[0] === "--help") console.log(usage);
  else if (args[0] === "--uncounted") {
    const { uncounted } = inventoryDirectory();
    for (const row of uncounted) console.log(`UNCOUNTED ${row.file}:${row.line} <${row.tag}> disabled={${row.expression}}${row.kind ? ` kind=${row.kind}` : ""}${carriesText(row)}`);
    console.log(`BUSY_CONTROL_UNCOUNTED scope=src/ total=${uncounted.length} files=${new Set(uncounted.map(row => row.file)).size}`);
  } else if (args[0] === "--check") {
    const result = checkInventory(inventoryDirectory(), loadExemptions());
    for (const row of result.unlisted) console.log(`UNLISTED ${row.file}:${row.line} <${row.tag}> disabled={${row.expression}}${row.kind ? ` kind=${row.kind}` : ""}${carriesText(row)}${row.listedCount ? ` (${row.foundCount} found, ${row.listedCount} listed)` : ""}`);
    for (const entry of result.stale) console.log(`STALE ${entry.file} <${entry.tag}> disabled={${entry.expression}}${entry.kind ? ` kind=${entry.kind}` : ""} (${entry.foundCount} found, ${entry.count} listed)`);
    if (result.ok) console.log("BUSY_CONTROL_INVENTORY_CLEAN");
    else { console.log(`BUSY_CONTROL_INVENTORY_FAILED unlisted=${result.unlisted.length} stale=${result.stale.length}`); process.exitCode = 1; }
  } else {
    const report = inventoryDirectory();
    if (args[0] === "--json") console.log(JSON.stringify(report, null, 2));
    else { console.log(JSON.stringify(report.counts)); console.log(report.note); for (const row of report.nativeDisabled) console.log(`${row.file}:${row.line} <${row.tag}> disabled={${row.expression}}`); }
  }
}
