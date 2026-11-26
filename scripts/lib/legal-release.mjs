// One legal release folds every content/legal/pending file. A pull request
// declares its change there and does not claim the next version or edit a
// published surface. This module assigns versions, regenerates derived
// copies and writes the legal-pack migration only when a release is cut.
import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pinName } from "./source-pins.mjs";
import { TELEMETRY_PINS, stagedTelemetryConfigPins, stagedTelemetryPins, stagedWriterGroup, stagedWriterSources, telemetryFileWrites, telemetryKeySourcePin, telemetrySourcePin } from "./telemetry-disclosure-sources.mjs";
import { validLegalReleaseStamp } from "../../src/lib/legalReleaseGate.js";
import {
  REGISTER_END, REGISTER_POLICY_DOCUMENTS, REGISTER_SOURCE, REGISTER_START, registerCopies, spliceRegisterBlock,
} from "../../src/lib/subprocessorRegisterMarkdown.js";

export { REGISTER_SOURCE };

export const GENERATOR_VERSION = "legal-release-1";
export const PENDING_DIR = "content/legal/pending";
export const STAMP_PATH = "content/legal/release-stamp.json";
export const PIN_DIR = "config/legal-catalogue-pins";
export const MIGRATIONS_DIR = "supabase/migrations";
// The generator writes exactly this name. Other migrations are product SQL.
export const LEGAL_PACK_MIGRATION_NAME = /^\d{14}_legal_pack_release\.sql$/;
export const INSTRUMENT_ORDER = Object.freeze([
  "privacy-policy", "terms-of-use", "accessibility-statement", "ai-disclosure", "retention-schedule",
]);
export const PATH_KINDS = Object.freeze(["collection", "use", "sharing", "retention"]);
export const FILE_SURFACES = Object.freeze([
  "src/lib/legalInstruments.js",
  "src/lib/legalContent.js",
  "apps/mobile/src/lib/legalInstrumentText.ts",
  "apps/mobile/src/lib/legalDocuments.ts",
  "src/data/telemetryDisclosure.json",
  "docs/legal/telemetry-disclosure-20261010.md",
  "docs/legal/data-policy-20261009.md",
  "docs/legal/data-policy-20261009-es.md",
]);
export const TELEMETRY_DOCS = Object.freeze([
  "docs/legal/telemetry-disclosure-20261010.md",
  "docs/legal/data-policy-20261009.md",
  "docs/legal/data-policy-20261009-es.md",
]);
const TELEMETRY_START = "<!-- BEGIN GENERATED TELEMETRY -->";
const TELEMETRY_END = "<!-- END GENERATED TELEMETRY -->";

export function isLegalPackMigrationPath(filePath) {
  const name = String(filePath).split("/").pop();
  return LEGAL_PACK_MIGRATION_NAME.test(name);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const md5 = (text) => createHash("md5").update(text).digest("hex");
const stable = (value) => JSON.stringify(value);

export function bumpLegalVersion(version, material) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (!match) throw new Error(`invalid legal version ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return material ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

// Parse complete modules so comments, JSX text and template quasis never
// masquerade as JavaScript string delimiters. Keep offsets for minimal edits.
function sourceSyntax(source) {
  return parse(source, { sourceType: "module", plugins: ["typescript", "jsx", "importAttributes"], tokens: true });
}

function visitSyntax(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) visitSyntax(child, visit, parent);
    return;
  }
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (!["tokens", "comments", "leadingComments", "trailingComments", "innerComments", "loc", "extra"].includes(key)) visitSyntax(child, visit, node);
  }
}

function literalValue(node) {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function propertyKey(node) {
  return node.key?.type === "Identifier" && !node.computed ? node.key.name : literalValue(node.key);
}

function namedCall(ast, callee, key, message) {
  const matches = [];
  visitSyntax(ast, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === callee && literalValue(node.arguments[0]) === key) matches.push(node);
  });
  if (matches.length !== 1) throw new Error(matches.length ? `ambiguous ${message}` : `missing ${message}`);
  return matches[0];
}

function trailingSeparator(ast, items, end) {
  const last = items.filter(Boolean).at(-1);
  return last && !ast.tokens.some((token) => token.type?.label === "," && token.start >= last.end && token.end < end) ? "," : "";
}

function keyedProperty(ast, key) {
  const matches = [];
  visitSyntax(ast, (node) => {
    if (node.type === "ObjectProperty" && propertyKey(node) === key) matches.push(node);
  });
  if (matches.length > 1) throw new Error(`ambiguous catalogue key ${key}`);
  return matches[0] || null;
}

function replaceProperty(source, property, key, next, prior) {
  const current = literalValue(property.value);
  if (typeof current !== "string") throw new Error(`unreadable catalogue value ${key}`);
  if (prior !== undefined && prior !== null && current !== prior) throw new Error(`prior mismatch for ${key}`);
  const quote = source[property.value.start] === "'" ? "'" : '"';
  return source.slice(0, property.value.start) + writeJsString(next, quote) + source.slice(property.value.end);
}

function insertCatalogueProperty(source, ast, key, next) {
  const anchors = [];
  visitSyntax(ast, (node, parent) => {
    if (node.type === "ObjectProperty" && propertyKey(node)?.startsWith("legal.") && parent.type === "ObjectExpression") anchors.push({ property: node, object: parent });
  });
  const containers = new Set(anchors.map((anchor) => anchor.object));
  if (containers.size !== 1) throw new Error(`${containers.size ? "ambiguous" : "no"} legal catalogue anchor for ${key}`);
  const { property, object } = anchors.at(-1);
  const lineStart = source.lastIndexOf("\n", property.start) + 1;
  const prefix = source.slice(lineStart, property.start);
  const indent = /^\s*$/.test(prefix) ? prefix : "  ";
  const close = object.end - 1;
  const closePrefix = source.slice(source.lastIndexOf("\n", close) + 1, close);
  const closeIndent = /^\s*$/.test(closePrefix) ? closePrefix : "";
  const quote = source[property.key.start] === "'" ? "'" : '"';
  const separator = trailingSeparator(ast, object.properties, object.end);
  const insertion = `${separator}\n${indent}${writeJsString(key, quote)}: ${writeJsString(next, quote)},\n${closeIndent}`;
  return source.slice(0, close) + insertion + source.slice(close);
}

export function writeJsString(value, quote) {
  const escaped = JSON.stringify(String(value)).slice(1, -1).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return quote === "'" ? `'${escaped.replace(/'/g, "\\'")}'` : `"${escaped}"`;
}

export function instrumentBlock(source, key) {
  const node = namedCall(sourceSyntax(source), "instrument", key, `instrument ${key}`);
  const end = source[node.end] === "," ? node.end + 1 : node.end;
  return { start: node.start, end, block: source.slice(node.start, end) };
}

export function lastDeclaredVersion(block) {
  const ast = sourceSyntax(`${block.replace(/,\s*$/, "")};`);
  const call = ast.program.body[0]?.expression;
  const changes = call?.arguments?.at(-1);
  if (changes?.type !== "ArrayExpression") throw new Error("instrument has no changelog");
  for (const entry of [...changes.elements].reverse()) {
    if (entry?.type === "ObjectExpression") {
      const version = entry.properties.find((property) => property.type === "ObjectProperty" && propertyKey(property) === "version");
      if (version) return literalValue(version.value);
    }
    if (entry?.type === "Identifier" && entry.name === "FIRST_OPERATIVE") return "1.0.0";
  }
  throw new Error("instrument has no version");
}

export function insertInstrumentChange(source, key, entryLiteral) {
  const ast = sourceSyntax(source);
  const changes = namedCall(ast, "instrument", key, `instrument ${key}`).arguments.at(-1);
  if (changes?.type !== "ArrayExpression") throw new Error(`no changelog close for ${key}`);
  const close = changes.end - 1;
  return source.slice(0, close) + trailingSeparator(ast, changes.elements, changes.end) + entryLiteral + source.slice(close);
}

// Longest prefix wins so legal.instrument.aiDisclosure is not stored under legal.aiDisclosure.
const SECTION_PREFIXES = Object.freeze([
  ["privacy-policy", ["legal.instrument.privacy"]],
  ["terms-of-use", ["legal.instrument.terms"]],
  ["accessibility-statement", ["legal.accessibilityStatement"]],
  ["ai-disclosure", ["legal.instrument.aiDisclosure", "legal.aiDisclosure"]],
  ["retention-schedule", ["legal.instrument.retention"]],
]);

export function sectionPrefixFor(instrumentKey, identity) {
  const prefixes = SECTION_PREFIXES.find(([key]) => key === instrumentKey)?.[1] || [];
  const match = prefixes
    .filter((prefix) => identity === prefix || identity.startsWith(`${prefix}.`))
    .sort((left, right) => right.length - left.length)[0];
  if (!match) throw new Error(`no section list for ${identity}`);
  return match;
}

export function insertSectionId(source, prefix, sectionId) {
  const ast = sourceSyntax(source);
  const list = namedCall(ast, "sectionKeys", prefix, `section list ${prefix}`).arguments[1];
  if (list?.type !== "ArrayExpression") throw new Error(`section list ${prefix} does not close`);
  if (list.elements.some((element) => literalValue(element) === sectionId)) return source;
  const close = list.end - 1;
  const separator = trailingSeparator(ast, list.elements, list.end);
  const insertion = source.slice(list.start, list.end).includes("\n")
    ? `${separator}\n  ${JSON.stringify(sectionId)},\n`
    : `${separator} ${JSON.stringify(sectionId)}`;
  return source.slice(0, close) + insertion + source.slice(close);
}

export function upsertCatalogueValue(source, key, next, prior) {
  const ast = sourceSyntax(source);
  const property = keyedProperty(ast, key);
  if (property) return replaceProperty(source, property, key, next, prior);
  if (prior !== undefined && prior !== null) throw new Error(`missing catalogue key ${key}`);
  return insertCatalogueProperty(source, ast, key, next);
}

export function upsertNativeValue(source, key, next, prior) {
  const ast = sourceSyntax(source);
  const property = keyedProperty(ast, key);
  if (property) return { source: replaceProperty(source, property, key, next, prior), found: true };
  if (prior !== undefined && prior !== null) return { source, found: false };
  return { source: insertCatalogueProperty(source, ast, key, next), found: true };
}

// A catalogue string marks interpolation with {name}; the native mirror may
// write the same text as a template literal whose ${...} expressions sit in
// those slots, in order. Split a catalogue string into its text and slots.
const SLOT = /\{([A-Za-z_][\w.]*)\}/g;
function slotParts(text) {
  const names = [...text.matchAll(SLOT)].map((match) => match[1]);
  return { names, quasis: text.split(SLOT).filter((_, index) => index % 2 === 0) };
}

function writeTemplateText(value) {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function templateMatches(node, prior) {
  if (node?.type !== "TemplateLiteral" || node.expressions.length === 0) return false;
  const { names, quasis } = slotParts(prior);
  return names.length === node.expressions.length
    && node.quasis.every((quasi, index) => quasi.value.cooked === quasis[index]);
}

export function replaceDecodedLiteral(source, prior, next, label) {
  if (prior === undefined || prior === null || prior === next) return { source, found: false };
  const hits = [];
  visitSyntax(sourceSyntax(source), (node, parent) => {
    if (!parent || (parent.key === node) || (parent.source === node) || parent.type === "JSXAttribute" || parent.type === "TSLiteralType" || parent.type === "TaggedTemplateExpression") return;
    if (literalValue(node) === prior || templateMatches(node, prior)) hits.push(node);
  });
  if (hits.length === 0) return { source, found: false };
  if (hits.length !== 1) throw new Error(`${label} contains ${hits.length} copies of the prior text`);
  const hit = hits[0];
  if (hit.type === "TemplateLiteral" && hit.expressions.length > 0) {
    const before = slotParts(prior);
    const after = slotParts(next);
    if (after.names.join("\n") !== before.names.join("\n")) {
      throw new Error(`${label} template slots differ: {${before.names.join("}, {")}} became {${after.names.join("}, {")}}`);
    }
    const body = after.quasis.map((text, index) => writeTemplateText(text)
      + (index < hit.expressions.length ? `\${${source.slice(hit.expressions[index].start, hit.expressions[index].end)}}` : "")).join("");
    return { source: `${source.slice(0, hit.start)}\`${body}\`${source.slice(hit.end)}`, found: true };
  }
  const quote = source[hit.start] === "'" ? "'" : '"';
  return { source: source.slice(0, hit.start) + writeJsString(next, quote) + source.slice(hit.end), found: true };
}

// A present catalogue key is the native mirror. An escaped literal is the
// other mirror. A string that is in neither place is web-only: the native
// reader looks up LEGAL_INSTRUMENT_TEXT by key and does not invent a copy.
export function updateMirroredText(source, key, next, prior, label) {
  const keyed = upsertNativeValue(source, key, next, prior);
  if (keyed.found) return keyed.source;
  const decoded = replaceDecodedLiteral(source, prior, next, label);
  if (decoded.found) return decoded.source;
  return source;
}

// A summary heading (legal.<page>.title) is written twice in the native
// LEGAL_DOCUMENTS entry: as its title and as its instrumentReference label.
// Both copies belong to that one key, so update them in place by entry.
function nativeSummaryEntry(ast, key) {
  const page = /^legal\.([A-Za-z]+)\.title$/u.exec(key)?.[1].replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  if (!page) return null;
  const entries = [];
  visitSyntax(ast, (node) => {
    if (node.type === "ObjectExpression" && node.properties.some((property) => propertyKey(property) === "key" && literalValue(property.value) === page)) entries.push(node);
  });
  if (entries.length > 1) throw new Error(`ambiguous native summary entry ${page}`);
  return entries[0] || null;
}

export function updateNativeSummary(source, key, next, prior, label) {
  const entry = prior === undefined || prior === null ? null : nativeSummaryEntry(sourceSyntax(source), key);
  if (!entry) return updateMirroredText(source, key, next, prior, label);
  const copies = [];
  for (const property of entry.properties) {
    const name = propertyKey(property);
    if (name === "title") copies.push(property.value);
    if (name === "instrument" && property.value.type === "CallExpression" && property.value.callee.name === "instrumentReference") copies.push(property.value.arguments[1]);
  }
  const stale = copies.filter((node) => literalValue(node) !== prior);
  if (!copies.length || stale.length) throw new Error(`${label} heading for ${key} does not match the prior text`);
  return copies.sort((a, b) => b.start - a.start).reduce((text, node) => {
    const quote = text[node.start] === "'" ? "'" : '"';
    return text.slice(0, node.start) + writeJsString(next, quote) + text.slice(node.end);
  }, source);
}

export function replaceExportString(source, name, value) {
  const pattern = new RegExp(`export const ${name} = "[^"]*";`);
  if (!pattern.test(source)) throw new Error(`missing export ${name}`);
  return source.replace(pattern, `export const ${name} = "${value}";`);
}

function legalCopyEntries(source) {
  const entries = [];
  visitSyntax(sourceSyntax(source), (node) => {
    if (node.type !== "ObjectProperty" && node.type !== "ObjectMethod") return;
    const key = propertyKey(node);
    if (!/^(legal\..+|landing\.interestConsent|landing\.aiDisclosure)$/.test(key || "")) return;
    const value = literalValue(node.value);
    if (typeof value !== "string") throw new Error(`unreadable legal catalogue value ${key}`);
    const start = source.lastIndexOf("\n", node.start) + 1;
    const end = source.indexOf("\n", node.end);
    // Preserve existing one-line bytes (including commas/comments) so the
    // published baseline hashes stay stable; include every line of new forms.
    entries.push({ key, value, text: source.slice(start, end < 0 ? source.length : end).trim() });
  });
  return entries;
}

export function legalCopyLines(source) {
  return legalCopyEntries(source).map((entry) => entry.text);
}

export function legalCopyFingerprint(enSource, esSource) {
  return createHash("sha256").update([...legalCopyLines(enSource), ...legalCopyLines(esSource)].join("\n")).digest("hex").slice(0, 16);
}

export function replaceExactText(source, prior, next, label) {
  if (prior === next) return source;
  const count = source.split(prior).length - 1;
  if (count !== 1) throw new Error(`${label} contains ${prior === undefined ? "no" : count} copies of the prior text`);
  return source.replace(prior, next);
}

// Document edits (#9518, a review note): published prose outside the
// catalogues that a declaration may correct by exact text when a release
// folds it. A document edit is an instrument edit of kind "document", so it
// is released with that instrument's change, and a generator that predates
// the kind treats it as a catalogue string with no such key and refuses the
// whole release ("missing catalogue key") instead of dropping it. The data
// policy's English and Spanish documents are edited only outside their
// generated telemetry and register blocks; the telemetry disclosure copy is
// edited before the telemetry documents are rendered.
const DOCUMENT_SURFACES = Object.freeze({
  "data-policy": Object.freeze({ en: "docs/legal/data-policy-20261009.md", es: "docs/legal/data-policy-20261009-es.md" }),
  "telemetry-copy": null,
});

// Every start of prior in source, overlapping ones included ("aa" starts
// twice in "aaa").
function occurrences(source, prior) {
  const starts = [];
  for (let at = source.indexOf(prior); at >= 0; at = source.indexOf(prior, at + 1)) starts.push(at);
  return starts;
}

function generatedRanges(source) {
  const ranges = [];
  for (const [start, end] of [[TELEMETRY_START, TELEMETRY_END], [REGISTER_START, REGISTER_END]]) {
    const from = source.indexOf(start);
    const to = source.indexOf(end);
    if (from >= 0 && to > from) ranges.push([from, to + end.length]);
  }
  return ranges;
}

// Applies a batch of { identity, prior, next } to one text. Every anchor is
// resolved against the unchanged text first, so no edit can find text another
// edit wrote, and the two languages of one edit always correct the passage
// that stood in the published text. Each anchor must start exactly once; two
// anchors may not overlap; none may touch a protected (generated) range.
// Only then is the batch applied, from the end of the text backward. A
// language whose prior equals its next still claims its range.
function applyTextEdits(source, edits, label, protectedRanges = []) {
  const resolved = edits.map((edit) => {
    const starts = occurrences(source, edit.prior);
    if (starts.length !== 1) throw new Error(`${label} contains ${starts.length} copies of the prior text of ${edit.identity}`);
    const range = [starts[0], starts[0] + edit.prior.length];
    if (protectedRanges.some(([from, to]) => range[0] < to && range[1] > from)) {
      throw new Error(`${label}: the prior text of ${edit.identity} is inside a generated block`);
    }
    return { ...edit, range };
  }).sort((left, right) => left.range[0] - right.range[0]);
  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index].range[0] < resolved[index - 1].range[1]) {
      throw new Error(`${label}: the prior texts of ${resolved[index - 1].identity} and ${resolved[index].identity} overlap`);
    }
  }
  let output = source;
  for (const edit of [...resolved].reverse()) output = `${output.slice(0, edit.range[0])}${edit.next}${output.slice(edit.range[1])}`;
  return output;
}

function validateDocumentEdit(edit, name) {
  if (!Object.hasOwn(DOCUMENT_SURFACES, edit.surface)) throw new Error(`${name} ${edit.identity} names unknown document surface ${edit.surface}`);
  if (edit.surface === "telemetry-copy" ? typeof edit.field !== "string" || !edit.field : edit.field !== undefined) {
    throw new Error(edit.surface === "telemetry-copy" ? `${name} ${edit.identity} needs a telemetry copy field` : `${name} ${edit.identity} names a field for a data-policy edit`);
  }
  pair(edit.prior, `${name} ${edit.identity} prior`);
  if (edit.prior.en === edit.next.en && edit.prior.es === edit.next.es) throw new Error(`${name} ${edit.identity} changes neither language`);
  return edit;
}

function pair(value, label) {
  if (!value || typeof value.en !== "string" || typeof value.es !== "string" || !value.en || !value.es) {
    throw new Error(`${label} needs a complete English and Spanish pair`);
  }
  return value;
}

export function validatePendingFile(file, name) {
  if (!file || file.schema !== 1) throw new Error(`${name} schema must be 1`);
  const recordId = name.replace(/\.json$/, "");
  if (file.recordId !== recordId) throw new Error(`${name} recordId must match its file name`);
  if (!file.instruments || typeof file.instruments !== "object" || Array.isArray(file.instruments)) {
    throw new Error(`${name} keys changes by instrument`);
  }
  const identities = [];
  for (const [key, change] of Object.entries(file.instruments)) {
    if (!INSTRUMENT_ORDER.includes(key)) throw new Error(`${name} names unknown instrument ${key}`);
    if (typeof change.material !== "boolean") throw new Error(`${name} ${key} must state material`);
    if (!/^\d+\.\d+\.\d+$/.test(change.priorVersion || "")) throw new Error(`${name} ${key} needs priorVersion`);
    pair(change.note, `${name} ${key} note`);
    for (const edit of change.edits || []) {
      if (!edit.identity || !edit.kind) throw new Error(`${name} edit needs an identity and a kind`);
      pair(edit.next, `${name} ${edit.identity}`);
      if (edit.kind === "section") {
        if (edit.body !== undefined) pair(edit.body, `${name} ${edit.identity} body`);
        if (edit.prior !== null && edit.prior !== undefined) pair(edit.prior, `${name} ${edit.identity} prior`);
      } else if (edit.kind === "document") {
        validateDocumentEdit(edit, name);
      } else {
        pair(edit.prior, `${name} ${edit.identity} prior`);
      }
      identities.push({ key, ...edit, recordId });
    }
  }
  for (const path of file.paths || []) {
    if (!path.id || !PATH_KINDS.includes(path.kind) || !path.release) {
      throw new Error(`${name} path needs an id, a collection/use/sharing/retention kind, and a release`);
    }
  }
  for (const writer of file.telemetryWriters || []) {
    if (writer.exempt === true || writer.all === true) throw new Error(`${name} cannot blanket-exempt telemetry writers`);
    // A storage row is identified by id. A cookie row names the cookie, the
    // writer's own file (the published row and the pin must name one file),
    // an optional lifetime and a required English and Spanish purpose: the
    // published page has no generic wording that fits every cookie.
    const cookie = stagedWriterGroup(writer) === "cookieWrites";
    if (!writer.identity || !writer.source || !writer.pin || !writer.release
      || (cookie ? typeof writer.row?.key !== "string" || !writer.row.key || typeof writer.row.source !== "string" || !writer.row.source : !writer.row?.id)) {
      throw new Error(`${name} staged telemetry writer is incomplete`);
    }
    if (cookie && writer.row.maxAgeSeconds !== undefined && !(Number.isInteger(writer.row.maxAgeSeconds) && writer.row.maxAgeSeconds > 0)) {
      throw new Error(`${name} staged telemetry cookie lifetime is invalid`);
    }
    if (cookie && writer.row.source !== writer.source) throw new Error(`${name} staged telemetry cookie row must name the writer's own file`);
    if (cookie) pair(writer.row.purpose, `${name} ${writer.row.key} purpose`);
    stagedTelemetryConfigPins(writer);
  }
  // Document edits live in an instrument's edits so that an older generator
  // refuses them; a top-level list would be ignored there and lost.
  if (file.documentEdits !== undefined) throw new Error(`${name} puts document edits in an instrument's edits as kind "document", not in a top-level documentEdits list`);
  const telemetryPins = stagedTelemetryPins(file);
  if (Object.keys(file.instruments).length === 0 && (file.telemetryWriters || []).length === 0 && telemetryPins.length === 0) {
    throw new Error(`${name} declares no instrument, staged writer, staged telemetry pin or document edit`);
  }
  return { ...file, name, identities };
}

export function validatePendingSet(files) {
  const parsed = files.map((entry) => validatePendingFile(entry.file, entry.name));
  const byIdentity = new Map();
  for (const file of parsed) {
    for (const edit of file.identities) {
      const slot = byIdentity.get(edit.identity) || [];
      slot.push(edit);
      byIdentity.set(edit.identity, slot);
    }
    for (const key of Object.keys(file.instruments)) {
      const versions = parsed.flatMap((other) => other.instruments[key] ? [other.instruments[key].priorVersion] : []);
      if (new Set(versions).size > 1) throw new Error(`${key} pending files disagree on priorVersion`);
    }
  }
  for (const [identity, edits] of byIdentity) {
    const nexts = new Set(edits.map((edit) => stable({ key: edit.key, kind: edit.kind, next: edit.next, body: edit.body ?? null, sectionId: edit.sectionId ?? null, surface: edit.surface ?? null, field: edit.field ?? null })));
    const priors = new Set(edits.map((edit) => stable(edit.prior ?? null)));
    if (nexts.size > 1 || priors.size > 1) {
      throw new Error(`incompatible pending edits for ${identity}`);
    }
  }
  return parsed;
}

function reviewedDate(source) {
  const match = source.match(/export const LEGAL_CONTENT_LAST_REVIEWED = "(\d{4}-\d{2}-\d{2})";/);
  if (!match) throw new Error("missing review date");
  return match[1];
}

function privacyEffective(source) {
  const match = source.match(/export const PRIVACY_EFFECTIVE_DATE = "(\d{4}-\d{2}-\d{2})";/);
  if (!match) throw new Error("missing privacy effective date");
  return match[1];
}

export function assertReleaseDate(current, releaseDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) || new Date(`${releaseDate}T12:00:00Z`).toISOString().slice(0, 10) !== releaseDate) throw new Error("release date must be an Eastern YYYY-MM-DD");
  if (releaseDate < current) throw new Error(`review date cannot move backward from ${current} to ${releaseDate}`);
  return releaseDate;
}

export function spliceTelemetryDocuments(tree, markdown) {
  const next = { ...tree };
  const header = "<!-- Generated by node scripts/render-telemetry-disclosure.mjs. Review both languages before updating. -->\n\n";
  const disclosure = `${header}${markdown.en}\n\n---\n\n${markdown.es}\n`;
  next["docs/legal/telemetry-disclosure-20261010.md"] = disclosure;
  for (const [path, copy] of [
    ["docs/legal/data-policy-20261009.md", disclosure],
    ["docs/legal/data-policy-20261009-es.md", `${header}${markdown.es}\n`],
  ]) {
    const draft = tree[path];
    if (typeof draft !== "string" || !draft.includes(TELEMETRY_START) || !draft.includes(TELEMETRY_END)) {
      throw new Error(`missing telemetry boundaries in ${path}`);
    }
    const start = draft.indexOf(TELEMETRY_START);
    const end = draft.indexOf(TELEMETRY_END);
    next[path] = `${draft.slice(0, start)}${TELEMETRY_START}\n${copy}\n${TELEMETRY_END}${draft.slice(end + TELEMETRY_END.length)}`;
  }
  return next;
}

// The register block in both data-policy documents is release output too. A
// release re-renders it from the register source in the same tree, so a
// register change reaches the policies only through a release. A tree whose
// policies carry the block must also carry the source.
export function spliceRegisterDocuments(tree) {
  if (!REGISTER_POLICY_DOCUMENTS.some((path) => typeof tree[path] === "string" && tree[path].includes(REGISTER_START))) return tree;
  if (typeof tree[REGISTER_SOURCE] !== "string") throw new Error(`missing ${REGISTER_SOURCE} for the data-policy register block`);
  const copies = registerCopies(JSON.parse(tree[REGISTER_SOURCE]));
  const next = { ...tree };
  for (const path of REGISTER_POLICY_DOCUMENTS) next[path] = spliceRegisterBlock(tree[path], copies[path], path);
  return next;
}

function updatePins(tree, enSource, esSource) {
  const next = { ...tree };
  const values = new Map();
  for (const [language, source, file] of [["en", enSource, "src/lib/i18n.js"], ["es", esSource, "src/lib/i18n/es.js"]]) {
    for (const { key, value } of legalCopyEntries(source)) {
      values.set(`${file}#${language}:${key}`, value);
    }
  }
  const seen = new Set();
  for (const [path, text] of Object.entries(tree)) {
    if (!path.startsWith(`${PIN_DIR}/`) || !path.endsWith(".json")) continue;
    const row = JSON.parse(text);
    seen.add(row.key);
    if (!values.has(row.key) || values.get(row.key) === row.value) continue;
    next[path] = `${JSON.stringify({ key: row.key, value: values.get(row.key) }, null, 2)}\n`;
  }
  for (const [key, value] of values) {
    if (seen.has(key)) continue;
    next[`${PIN_DIR}/${pinName(key)}`] = `${JSON.stringify({ key, value }, null, 2)}\n`;
  }
  return next;
}

export function latestValidatorExtraction(files) {
  const names = Object.keys(files).filter((path) => path.startsWith(`${MIGRATIONS_DIR}/`) && path.endsWith(".sql")).sort();
  let found = null;
  for (const path of names) {
    if (files[path].includes("function private.legal_acceptance_versions")) found = path;
  }
  if (!found) throw new Error("no legal acceptance validator");
  const sql = files[found];
  const marker = "as $function$";
  const start = sql.lastIndexOf(marker);
  const end = sql.indexOf("$function$;", start);
  if (start < 0 || end < 0) throw new Error("validator body markers missing");
  const body = sql.slice(start + marker.length, end);
  const header = sql.slice(Math.max(0, sql.lastIndexOf("create or replace function private.legal_acceptance_versions", start)), start);
  const volatile = /\bimmutable\b/i.test(header) ? "i" : (/\bstable\b/i.test(header) ? "s" : "v");
  const secdef = /\bsecurity definer\b/i.test(header);
  return { path: found, body, volatile, secdef, sql };
}

export function renderLegalPackMigration({ body, md5Hash, volatile, secdef, versions, migrationId }) {
  const packed = stable(Object.fromEntries(INSTRUMENT_ORDER.filter((key) => versions[key]).map((key) => [key, versions[key]])));
  const pattern = /'\{[^{}]*"privacy-policy"[^{}]*\}'::jsonb/g;
  const matches = [...body.matchAll(pattern)];
  if (matches.length === 0) throw new Error("validator body has no published version literal");
  for (const match of matches) JSON.parse(match[0].slice(1, match[0].indexOf("'::jsonb")));
  const replaced = body.replace(pattern, `'${packed}'::jsonb`);
  const security = secdef ? "p.prosecdef" : "not p.prosecdef";
  return `begin;\n\n-- Legal pack ${migrationId}. Generated by ${GENERATOR_VERSION}.\n-- One transactional migration for the folded pending files. Historical SQL stays untouched.\ndo $legal_release_predecessor$\nbegin\n  if not exists (\n    select 1 from pg_catalog.pg_proc p\n    where p.oid = pg_catalog.to_regprocedure('private.legal_acceptance_versions(jsonb)')\n      and pg_catalog.md5(p.prosrc) = '${md5Hash}'\n      and ${security}\n      and p.provolatile = '${volatile}'\n  ) then\n    raise exception 'legal pack release ${migrationId} requires the reviewed predecessor validator' using errcode = '55000';\n  end if;\nend;\n$legal_release_predecessor$;\n\ncreate or replace function private.legal_acceptance_versions(p_versions jsonb)\nreturns jsonb\nlanguage plpgsql\n${volatile === "i" ? "immutable" : volatile === "s" ? "stable" : "volatile"}\n${secdef ? "security definer\n" : ""}set search_path = ''\nas $function$${replaced}$function$;\n\nrevoke all on function private.legal_acceptance_versions(jsonb)\n  from public, anon, authenticated, service_role;\n\nnotify pgrst, 'reload schema';\n\ncommit;\n`;
}

export function assertPinnedMain({ headCommit, mainCommit, headValidator, mainValidator }) {
  if (!headCommit || !mainCommit || headCommit !== mainCommit) {
    throw new Error("A legal release is cut from pinned Main. A predecessor still in flight must be on Main and applied first.");
  }
  if (headValidator !== mainValidator) {
    throw new Error("The latest validator is not Main's. Apply that predecessor on Main first.");
  }
}

export function applyLegalRelease(tree, options) {
  const releaseDate = assertReleaseDate(reviewedDate(tree["src/lib/legalContent.js"]), options.releaseDate);
  if (!/^\d{14}$/.test(String(options.migrationId || ""))) {
    throw new Error("migration id must be a 14-digit timestamp");
  }
  if (options.generatorVersion && options.generatorVersion !== GENERATOR_VERSION) {
    throw new Error(`generator ${options.generatorVersion} cannot rebuild with ${GENERATOR_VERSION}`);
  }
  const pendingNames = Object.keys(tree)
    .filter((path) => path.startsWith(`${PENDING_DIR}/`) && path.endsWith(".json"))
    .sort();
  if (pendingNames.length === 0) throw new Error("no pending legal files to release");
  const pending = validatePendingSet(pendingNames.map((path) => ({ name: path.slice(PENDING_DIR.length + 1), file: JSON.parse(tree[path]) })));
  let instruments = tree["src/lib/legalInstruments.js"];
  let english = tree["src/lib/i18n.js"];
  let spanish = tree["src/lib/i18n/es.js"];
  let nativeText = tree["apps/mobile/src/lib/legalInstrumentText.ts"];
  let nativeDocs = tree["apps/mobile/src/lib/legalDocuments.ts"];
  const versions = {};
  const material = {};
  for (const key of INSTRUMENT_ORDER) {
    versions[key] = lastDeclaredVersion(instrumentBlock(instruments, key).block);
    material[key] = false;
  }
  const notes = Object.fromEntries(INSTRUMENT_ORDER.map((key) => [key, []]));
  for (const file of pending) {
    for (const [key, change] of Object.entries(file.instruments)) {
      if (change.priorVersion !== versions[key]) {
        throw new Error(`${file.name} expected ${key} ${change.priorVersion} but the base is ${versions[key]}`);
      }
      material[key] = material[key] || change.material;
      notes[key].push(change.note);
    }
  }
  const changed = INSTRUMENT_ORDER.filter((key) => notes[key].length > 0);
  for (const key of changed) {
    versions[key] = bumpLegalVersion(versions[key], material[key]);
    const noteKey = `legal.changelog.note.release.${options.migrationId}.${key}`;
    const entry = `    { version: "${versions[key]}", date: "${releaseDate}", material: ${material[key]}, noteKey: "${noteKey}" },\n    `;
    instruments = insertInstrumentChange(instruments, key, entry);
    const text = {
      en: notes[key].map((note) => note.en).join(" "),
      es: notes[key].map((note) => note.es).join(" "),
    };
    english = upsertCatalogueValue(english, noteKey, text.en, null);
    spanish = upsertCatalogueValue(spanish, noteKey, text.es, null);
  }
  const appliedEdits = new Set();
  for (const file of pending) {
    for (const edit of file.identities) {
      if (edit.kind === "document" || appliedEdits.has(edit.identity)) continue;
      appliedEdits.add(edit.identity);
      if (edit.kind === "section") {
        const prefix = sectionPrefixFor(edit.key, edit.identity);
        instruments = insertSectionId(instruments, prefix, edit.sectionId || edit.identity.split(".").at(-1));
      }
      const titleKey = edit.kind === "section" ? `${edit.identity}.title` : edit.identity;
      const bodyKey = edit.kind === "section" ? `${edit.identity}.body` : null;
      if (edit.kind === "section") {
        english = upsertCatalogueValue(english, titleKey, edit.next.en, edit.prior?.en ?? null);
        spanish = upsertCatalogueValue(spanish, titleKey, edit.next.es, edit.prior?.es ?? null);
        nativeText = updateMirroredText(nativeText, titleKey, edit.next.en, edit.prior?.en ?? null, "native section title");
        if (edit.body) {
          english = upsertCatalogueValue(english, bodyKey, edit.body.en, null);
          spanish = upsertCatalogueValue(spanish, bodyKey, edit.body.es, null);
          nativeText = updateMirroredText(nativeText, bodyKey, edit.body.en, null, "native section body");
        }
      } else {
        english = upsertCatalogueValue(english, titleKey, edit.next.en, edit.prior.en);
        spanish = upsertCatalogueValue(spanish, titleKey, edit.next.es, edit.prior.es);
        nativeText = updateMirroredText(nativeText, titleKey, edit.next.en, edit.prior.en, "native instrument text");
        nativeDocs = updateNativeSummary(nativeDocs, titleKey, edit.next.en, edit.prior.en, "native summary");
      }
    }
  }
  let content = tree["src/lib/legalContent.js"];
  content = replaceExportString(content, "LEGAL_CONTENT_LAST_REVIEWED", releaseDate);
  if (changed.includes("privacy-policy")) content = replaceExportString(content, "PRIVACY_EFFECTIVE_DATE", releaseDate);
  content = replaceExportString(content, "LEGAL_COPY_FINGERPRINT", legalCopyFingerprint(english, spanish));
  let inventory = JSON.parse(tree["src/data/telemetryDisclosure.json"]);
  const incomingGates = [];
  for (const file of pending) {
    for (const writer of file.telemetryWriters || []) {
      const cookie = stagedWriterGroup(writer) === "cookieWrites";
      const list = cookie ? "cookies" : "storage";
      const publishedRow = (inventory[list] || []).find((row) => (cookie ? row.key === writer.row.key : row.id === writer.row.id));
      if (cookie) {
        // Checked again here, before the release writes anything: one file in
        // the row and the pin, a name not yet published, and the exact calls
        // the declaration names still present in that file.
        if (writer.row.source !== writer.source) throw new Error(`telemetry cookie ${writer.row.key} names another file than its writer`);
        if (publishedRow) throw new Error(`telemetry row ${writer.row.key} is already published`);
        if (typeof tree[writer.source] !== "string" || telemetrySourcePin(telemetryFileWrites(tree[writer.source]).cookies) !== writer.pin) {
          throw new Error(`staged telemetry cookie writer ${writer.source} does not match its source`);
        }
      }
      if (publishedRow) {
        // A forwarding seam can move an already disclosed writer without
        // collecting anything new. Promote its exact source pin at release,
        // retaining the published row only when every disclosed byte agrees.
        if (file.collectionChange !== "unchanged-or-narrower"
          || stable(publishedRow) !== stable(writer.row)
          || !publishedRow.sources?.includes(writer.source)) {
          throw new Error(`telemetry row ${writer.row.id} is already published`);
        }
        continue;
      }
      inventory = { ...inventory, [list]: [...(inventory[list] || []), writer.row] };
    }
    for (const path of file.paths || []) {
      incomingGates.push({ id: path.id, kind: path.kind, releaseId: options.migrationId });
    }
  }
  // Document edits, once per identity (validatePendingSet refused any two
  // that differ). Telemetry copy is corrected here, as one batch per field and
  // language, before the inventory is written and the telemetry documents are
  // rendered from it.
  const documentEdits = [...new Map(pending.flatMap((file) => file.identities).filter((edit) => edit.kind === "document").map((edit) => [edit.identity, edit])).values()];
  const copyEdits = documentEdits.filter((edit) => edit.surface === "telemetry-copy");
  if (copyEdits.length) {
    const copy = { ...inventory.copy };
    for (const lang of ["en", "es"]) {
      copy[lang] = { ...copy[lang] };
      for (const field of new Set(copyEdits.map((edit) => edit.field))) {
        if (typeof copy[lang][field] !== "string") throw new Error(`no telemetry copy field ${field} in ${lang}`);
        const batch = copyEdits.filter((edit) => edit.field === field).map((edit) => ({ identity: edit.identity, prior: edit.prior[lang], next: edit.next[lang] }));
        copy[lang][field] = applyTextEdits(copy[lang][field], batch, `telemetry copy ${lang}.${field}`);
      }
    }
    inventory = { ...inventory, copy };
  }
  const gatedPaths = mergeGatedPaths(gatedPathsFromStamp(tree[STAMP_PATH]), incomingGates);
  const validator = latestValidatorExtraction(tree);
  const migration = renderLegalPackMigration({
    body: validator.body,
    md5Hash: md5(validator.body),
    volatile: validator.volatile,
    secdef: validator.secdef,
    versions,
    migrationId: options.migrationId,
  });
  const migrationPath = `${MIGRATIONS_DIR}/${options.migrationId}_legal_pack_release.sql`;
  if (tree[migrationPath]) throw new Error(`migration ${options.migrationId} already exists`);
  const prefixes = Object.keys(tree)
    .filter((path) => path.startsWith(`${MIGRATIONS_DIR}/`))
    .map((path) => path.slice(MIGRATIONS_DIR.length + 1, MIGRATIONS_DIR.length + 15));
  if (prefixes.some((prefix) => prefix >= options.migrationId)) {
    throw new Error(`migration ${options.migrationId} is not after the latest migration`);
  }
  let next = {
    ...tree,
    "src/lib/legalInstruments.js": instruments,
    "src/lib/i18n.js": english,
    "src/lib/i18n/es.js": spanish,
    "src/lib/legalContent.js": content,
    "apps/mobile/src/lib/legalInstrumentText.ts": nativeText,
    "apps/mobile/src/lib/legalDocuments.ts": nativeDocs,
    "src/data/telemetryDisclosure.json": `${JSON.stringify(inventory, null, 2)}\n`,
    [migrationPath]: migration,
  };
  // One staged pin per key across the pending files, as readStagedTelemetryPins
  // reads them while staging: an identical entry in a second declaration is
  // applied once (a replacement retires its pin once), and a conflicting one
  // is refused (gate stage 203, r1s1).
  const appliedPins = new Map();
  for (const file of pending) {
    for (const writer of file.telemetryWriters || []) {
      const calls = JSON.parse(writer.pin.slice("calls:".length));
      if (!writer.pin.startsWith("calls:") || !Array.isArray(calls) || !calls.length || calls.some((call) => typeof call !== "string")) throw new Error("invalid staged telemetry pin");
      const key = `${stagedWriterGroup(writer)}/${writer.source}`;
      next[`${TELEMETRY_PINS}/${pinName(key)}`] = `${JSON.stringify({ key, value: calls }, null, 2)}\n`;
      for (const source of stagedWriterSources(writer)) {
        if (typeof tree[source] !== "string") continue;
        const value = telemetryKeySourcePin(tree[source]);
        const sourceKey = `keySources/${source}`;
        const path = `${TELEMETRY_PINS}/${pinName(sourceKey)}`;
        if (value) next[path] = `${JSON.stringify({ key: sourceKey, value }, null, 2)}\n`;
        else delete next[path];
      }
      for (const [source, pin] of stagedTelemetryConfigPins(writer)) {
        const key = `config/${source}`;
        const path = `${TELEMETRY_PINS}/${pinName(key)}`;
        if (!next[path] || JSON.parse(next[path]).key !== key || typeof tree[source] !== "string" || `sha256:${sha256(tree[source])}` !== pin) throw new Error(`staged telemetry configuration does not match ${source}`);
        next[path] = `${JSON.stringify({ key, value: pin }, null, 2)}\n`;
      }
    }
    // Staged SDK, configuration and library file pins replace a tracked pin.
    // A configuration hash must match the file the release reads. A library
    // file is re-verified whenever its bytes are in the tree: the release CLI
    // always reads them from node_modules, while a rebuild from Git cannot.
    // A replacement retires a tracked SDK pin and adds its successor's.
    for (const [key, value, retires] of stagedTelemetryPins(file)) {
      const prior = appliedPins.get(key);
      if (prior) {
        if (prior.value !== value || prior.retires !== retires) throw new Error(`conflicting staged telemetry pin ${key}`);
        continue;
      }
      appliedPins.set(key, { value, retires });
      const path = `${TELEMETRY_PINS}/${pinName(key)}`;
      if (retires) {
        const retiredPath = `${TELEMETRY_PINS}/${pinName(retires)}`;
        if (!next[retiredPath] || JSON.parse(next[retiredPath]).key !== retires) throw new Error(`staged telemetry pin replacement names an untracked key ${retires}`);
        if (next[path]) throw new Error(`staged telemetry pin replacement names a tracked key ${key}`);
        delete next[retiredPath];
        next[path] = `${JSON.stringify({ key, value }, null, 2)}\n`;
        continue;
      }
      if (!next[path] || JSON.parse(next[path]).key !== key) throw new Error(`staged telemetry pin names an untracked key ${key}`);
      const source = key.startsWith("config/") ? key.slice("config/".length) : null;
      if (source && (typeof tree[source] !== "string" || `sha256:${sha256(tree[source])}` !== value)) throw new Error(`staged telemetry configuration does not match ${source}`);
      const library = key.startsWith("sdkSources/") ? key.slice("sdkSources/".length) : null;
      if (library && typeof tree[library] === "string" && `sha256:${sha256(tree[library])}` !== value) throw new Error(`staged telemetry library file does not match ${library}`);
      next[path] = `${JSON.stringify({ key, value }, null, 2)}\n`;
    }
  }
  for (const path of pendingNames) delete next[path];
  next = updatePins(next, english, spanish);
  const catalogues = { en: english, es: spanish };
  const markdown = options.renderTelemetry
    ? options.renderTelemetry(inventory, catalogues)
    : renderReleaseTelemetry(inventory, catalogues);
  next = spliceTelemetryDocuments(next, markdown);
  next = spliceRegisterDocuments(next);
  // Data-policy prose last, as one batch per language, outside the blocks
  // just generated.
  const policyEdits = documentEdits.filter((edit) => edit.surface === "data-policy");
  if (policyEdits.length) {
    for (const lang of ["en", "es"]) {
      const path = DOCUMENT_SURFACES["data-policy"][lang];
      const batch = policyEdits.map((edit) => ({ identity: edit.identity, prior: edit.prior[lang], next: edit.next[lang] }));
      next[path] = applyTextEdits(next[path], batch, path, generatedRanges(next[path]));
    }
  }
  const consumed = pendingNames.map((path) => ({
    name: path.slice(PENDING_DIR.length + 1),
    sha256: sha256(tree[path]),
  }));
  return {
    tree: next,
    migrationPath,
    release: {
      baseCommit: options.baseCommit || null,
      date: releaseDate,
      migrationId: options.migrationId,
      generatorVersion: GENERATOR_VERSION,
      consumed,
      versions,
      material,
      gatedPaths,
      migrationSha256: sha256(migration),
      contentSha256: sha256(stable(surfaceHashesFromTree(next))),
      privacyEffective: changed.includes("privacy-policy") ? releaseDate : privacyEffective(tree["src/lib/legalContent.js"]),
    },
  };
}

export function hashPins(files, directory = PIN_DIR) {
  const rows = Object.entries(files)
    .filter(([path]) => path.startsWith(`${directory}/`) && path.endsWith(".json"))
    .sort(([left], [right]) => left.localeCompare(right));
  return sha256(rows.map(([path, text]) => `${path}\n${text}`).join("\n"));
}

export function surfaceHashesFromTree(tree) {
  const hashes = {};
  for (const path of FILE_SURFACES) hashes[path] = sha256(tree[path]);
  hashes["src/lib/i18n.js#legal-lines"] = sha256(legalCopyLines(tree["src/lib/i18n.js"]).join("\n"));
  hashes["src/lib/i18n/es.js#legal-lines"] = sha256(legalCopyLines(tree["src/lib/i18n/es.js"]).join("\n"));
  hashes[PIN_DIR] = hashPins(tree);
  hashes[TELEMETRY_PINS] = hashPins(tree, TELEMETRY_PINS);
  hashes["legal-validator"] = sha256(latestValidatorExtraction(tree).body);
  return hashes;
}

export function assertSurfacesMatchStamp(hashes, stamp) {
  const left = stable(hashes);
  const right = stable(stamp.surfaces);
  if (left !== right) throw new Error("published legal surface does not match the release stamp");
}

export function assertRebuild(baseTree, headTree, release, renderTelemetry) {
  if (!release?.migrationId || !release.date || release.generatorVersion !== GENERATOR_VERSION) {
    throw new Error("published surface edited outside a release");
  }
  const rebuilt = applyLegalRelease(baseTree, {
    releaseDate: release.date,
    migrationId: release.migrationId,
    generatorVersion: release.generatorVersion,
    baseCommit: release.baseCommit,
    renderTelemetry,
  });
  const headHashes = surfaceHashesFromTree(headTree);
  const rebuiltHashes = surfaceHashesFromTree(rebuilt.tree);
  if (stable(headHashes) !== stable(rebuiltHashes)) {
    throw new Error("release output does not rebuild from the pending files");
  }
  if (stable(rebuilt.release.consumed) !== stable(release.consumed)) {
    throw new Error("released file set does not match the consumed pending files");
  }
  if (stable(rebuilt.release) !== stable(release)) throw new Error("release metadata does not rebuild from the pending files");
  const pendingPaths = (tree) => Object.keys(tree).filter((path) => path.startsWith(`${PENDING_DIR}/`) && path.endsWith(".json")).sort();
  if (stable(pendingPaths(headTree)) !== stable(pendingPaths(rebuilt.tree))) throw new Error("release consumed file set does not rebuild");
  for (const [path, text] of Object.entries(baseTree)) {
    if ((path.startsWith(`${MIGRATIONS_DIR}/`) || path === "docs/operations/deployed-baseline-receipt.txt") && headTree[path] !== text) throw new Error(`release rewrites historical output: ${path}`);
  }
  for (const path of TELEMETRY_DOCS) {
    if (rebuilt.tree[path] !== headTree[path]) throw new Error(`telemetry document drifted: ${path}`);
  }
  if (headTree[REGISTER_SOURCE] !== baseTree[REGISTER_SOURCE]) throw new Error(`release edits its register input: ${REGISTER_SOURCE}`);
  const migrationPath = `${MIGRATIONS_DIR}/${release.migrationId}_legal_pack_release.sql`;
  if (rebuilt.tree[migrationPath] !== headTree[migrationPath]) {
    throw new Error("legal pack migration does not rebuild");
  }
  return rebuilt;
}

export function mergeGatedPaths(previous = [], incoming = []) {
  const byId = new Map();
  for (const path of previous) byId.set(path.id, { id: path.id, kind: path.kind, releaseId: path.releaseId });
  for (const path of incoming) byId.set(path.id, { id: path.id, kind: path.kind, releaseId: path.releaseId });
  return [...byId.values()];
}

export function gatedPathsFromStamp(text) {
  if (!text) return [];
  const stamp = JSON.parse(text);
  if (!validLegalReleaseStamp(stamp)) throw new Error("unreadable prior legal release stamp");
  return stamp.release?.gatedPaths || [];
}

const AI_DISCLOSURE_MARKDOWN_KEYS = Object.freeze(["route", "sent", "controls", "connector"]);

function catalogueValue(source, key) {
  return legalCopyEntries(source).find((entry) => entry.key === key)?.value ?? "";
}

// Same sentences as scripts/render-telemetry-disclosure.mjs, from the inventory
// argument and the catalogues this release just wrote. The disclosure script
// reads those files from disk after they are written.
export function renderReleaseTelemetry(inventory, catalogues) {
  const markdown = (lang) => {
    const copy = inventory.copy[lang];
    return [
      `## ${copy.title}`, "", inventory.reviewed, "", copy.intro, "", copy.analytics, "", copy.diagnostics, "", copy.relay, "", copy.optout, "",
      `### ${copy.inventory}`, "", copy.storageNote, "",
      ...inventory.storage.map((row) => `- **${row.storage}: ${row.keys.join(", ")}** — ${row.purpose[lang]}`), "",
      `### ${copy.cookies}`, "", copy.cookieNote, "",
      ...inventory.cookies.map((row) => `- **${row.key}** — ${row.purpose?.[lang] || copy.cookiePurpose}`), "",
      `### ${copy.ai}`, "", copy.attribution, "",
      ...AI_DISCLOSURE_MARKDOWN_KEYS.map((key) => `${catalogueValue(catalogues[lang], `legal.aiDisclosure.${key}.body`)}\n`),
      `[${copy.register}](/subprocessors)`,
    ].join("\n");
  };
  return { en: markdown("en"), es: markdown("es") };
}

export const CHART_VALIDATOR_MIGRATION = "20261102001534_pulse_saved_charts.sql";

export function legalAcceptanceMigrationPlan(names, chartName = CHART_VALIDATOR_MIGRATION) {
  if (!names.includes(chartName)) throw new Error(`missing historical chart validator ${chartName}`);
  return [chartName, ...names.filter((name) => LEGAL_PACK_MIGRATION_NAME.test(name)).sort()];
}

export function publishedLegalChanges(changed, baseSources = null, headSources = null) {
  return changed.filter((path) => {
    if (path.startsWith(`${MIGRATIONS_DIR}/`)) return isLegalPackMigrationPath(path);
    if (path !== "src/lib/i18n.js" && path !== "src/lib/i18n/es.js") return true;
    if (!baseSources?.[path] || !headSources?.[path]) return true;
    const baseHash = sha256(legalCopyLines(baseSources[path]).join("\n"));
    const headHash = sha256(legalCopyLines(headSources[path]).join("\n"));
    return baseHash !== headHash;
  });
}

function read(path) {
  return readFileSync(path, "utf8");
}

export function baselineStamp(root = process.cwd()) {
  return {
    schema: 1,
    generatorVersion: GENERATOR_VERSION,
    release: null,
    surfaces: collectRepoHashes(root),
  };
}

// This edition ships no docs/legal policy sources and no native operative
// instrument text (apps/mobile keeps its own non-operative documents). An
// absent surface is pinned as empty text, so adding one later changes the
// stamp and needs a release; cutting a release still needs every surface.
export function collectRepoHashes(root = process.cwd()) {
  const tree = {};
  for (const path of FILE_SURFACES) tree[path] = existsSync(join(root, path)) ? read(join(root, path)) : "";
  tree["src/lib/i18n.js"] = read(join(root, "src/lib/i18n.js"));
  tree["src/lib/i18n/es.js"] = read(join(root, "src/lib/i18n/es.js"));
  const pinRoot = join(root, PIN_DIR);
  for (const name of readdirSync(pinRoot).sort()) {
    const path = join(PIN_DIR, name);
    if (statSync(join(root, path)).isFile()) tree[path] = read(join(root, path));
  }
  if (existsSync(join(root, TELEMETRY_PINS))) {
    for (const name of readdirSync(join(root, TELEMETRY_PINS)).sort()) {
      const path = `${TELEMETRY_PINS}/${name}`;
      tree[path] = read(join(root, path));
    }
  }
  const migrationRoot = join(root, MIGRATIONS_DIR);
  for (const name of readdirSync(migrationRoot)) {
    if (name.endsWith(".sql")) tree[`${MIGRATIONS_DIR}/${name}`] = read(join(migrationRoot, name));
  }
  return surfaceHashesFromTree(tree);
}

const LOCALE_SOURCES = Object.freeze(["src/lib/i18n.js", "src/lib/i18n/es.js"]);

function releaseTreePath(path) {
  return FILE_SURFACES.includes(path)
    || LOCALE_SOURCES.includes(path)
    || path === STAMP_PATH
    || path === REGISTER_SOURCE
    || path.startsWith(`${PIN_DIR}/`)
    || path.startsWith(`${TELEMETRY_PINS}/`)
    || (path.startsWith(`${MIGRATIONS_DIR}/`) && path.endsWith(".sql"))
    || (path.startsWith(`${PENDING_DIR}/`) && path.endsWith(".json"))
    || path === "docs/operations/deployed-baseline-receipt.txt";
}

// A whole-tree listing outgrew Node's 1 MiB default output buffer (1,056,768
// bytes for Main b93456bc31 on November 12, 2026), so the first release could
// not be rebuilt (ENOBUFS); every git read gets room for the repository.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function gitText(run, root, args) {
  return run("git", args, { cwd: root, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER });
}

export const BASE_UNREADABLE = "legal release base unreadable";

// Reads stay local: a blob-filtered clone without credentials (the mobile CI
// lane) otherwise turns each missing blob into a failed promisor fetch.
function localGitText(run, root, args) {
  return run("git", args, { cwd: root, encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
}

// Fetches exactly one blob by object id, the way the mobile lane materializes
// its history blobs: one bounded fetch, the job token (when present) through
// the environment and never argv, no credential helper and no prompt.
function fetchBlob(run, root, oid) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const origin = String(localGitText(run, root, ["remote", "get-url", "origin"])).trim();
  if (origin.startsWith("https://github.com/") && process.env.GH_TOKEN) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString("base64")}`,
    });
  }
  run("git", ["fetch", "--no-tags", "--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "origin", oid], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 60_000,
  });
}

function baseLocaleSource(run, root, base, path) {
  try { return localGitText(run, root, ["show", `${base}:${path}`]); } catch { /* Not local; fetch it below. */ }
  let oid;
  try { oid = String(localGitText(run, root, ["rev-parse", "--verify", "--quiet", `${base}:${path}`])).trim(); } catch { return null; }
  if (!/^[0-9a-f]{40,64}$/.test(oid)) return null;
  try { fetchBlob(run, root, oid); } catch { /* The read below decides. */ }
  try { return localGitText(run, root, ["cat-file", "blob", oid]); } catch {
    throw new Error(`${BASE_UNREADABLE}: ${path} blob ${oid} at ${base} is not in the local object store and could not be fetched`);
  }
}

function localeSources(root, base, listed, run) {
  const locales = LOCALE_SOURCES.filter((path) => listed.includes(path));
  if (locales.length === 0) return { baseSources: null, headSources: null };
  const baseSources = {};
  const headSources = {};
  for (const path of locales) {
    // A catalogue absent from the base or the head stays absent.
    // publishedLegalChanges then keeps the path, so it counts as a legal edit.
    const baseSource = baseLocaleSource(run, root, base, path);
    if (baseSource === null) continue;
    try {
      headSources[path] = gitText(run, root, ["show", `HEAD:${path}`]);
      baseSources[path] = baseSource;
    } catch { /* See above. */ }
  }
  return { baseSources, headSources };
}

function listedTree(root, rev, run) {
  let names;
  try {
    names = String(gitText(run, root, ["ls-tree", "-r", "--name-only", rev])).split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    throw new Error("release stamp cannot be rebuilt");
  }
  const tree = {};
  for (const path of names) {
    if (!releaseTreePath(path)) continue;
    try {
      tree[path] = gitText(run, root, ["show", `${rev}:${path}`]);
    } catch {
      throw new Error("release stamp cannot be rebuilt");
    }
  }
  for (const path of Object.keys(tree).filter((path) => path.startsWith(`${PENDING_DIR}/`) && path.endsWith(".json"))) {
    const file = JSON.parse(tree[path]);
    for (const writer of file.telemetryWriters || []) {
      for (const source of new Set([...stagedWriterSources(writer), ...stagedTelemetryConfigPins(writer).map(([source]) => source)])) {
        if (names.includes(source)) tree[source] = gitText(run, root, ["show", `${rev}:${source}`]);
      }
    }
    for (const [key] of stagedTelemetryPins(file)) {
      const source = key.startsWith("config/") ? key.slice("config/".length) : null;
      if (source && names.includes(source)) tree[source] = gitText(run, root, ["show", `${rev}:${source}`]);
    }
  }
  return tree;
}

export function verifyWorkingTree(root = process.cwd(), run = execFileSync, renderTelemetry = renderReleaseTelemetry) {
  const stampPath = join(root, STAMP_PATH);
  if (!existsSync(stampPath)) throw new Error("missing legal release stamp");
  const stamp = JSON.parse(read(stampPath));
  if (!validLegalReleaseStamp(stamp)) throw new Error("unreadable legal release stamp");
  assertSurfacesMatchStamp(collectRepoHashes(root), stamp);
  if (stamp.release) {
    const migrationPath = join(root, `${MIGRATIONS_DIR}/${stamp.release.migrationId}_legal_pack_release.sql`);
    if (sha256(read(migrationPath)) !== stamp.release.migrationSha256 || sha256(stable(stamp.surfaces)) !== stamp.release.contentSha256) throw new Error("release content hashes do not match live output");
  }
  let base = process.env.CI_BASE_SHA || "";
  if (!base) {
    try { base = gitText(run, root, ["merge-base", "HEAD", "origin/Main"]).trim(); } catch { base = ""; }
  }
  if (!base) throw new Error("legal release comparison base unavailable");
  const names = [
    ...FILE_SURFACES,
    ...LOCALE_SOURCES,
    PIN_DIR,
    TELEMETRY_PINS,
    STAMP_PATH,
    ":(glob)supabase/migrations/*_legal_pack_release.sql",
  ];
  let diff;
  try {
    diff = gitText(run, root, ["diff", "--name-only", base, "HEAD", "--", ...names]);
  } catch { throw new Error("legal release diff unavailable"); }
  const listed = String(diff).split("\n").map((line) => line.trim()).filter(Boolean);
  const { baseSources, headSources } = localeSources(root, base, listed, run);
  const changed = publishedLegalChanges(listed.filter((path) => path !== STAMP_PATH), baseSources, headSources);
  let previousStamp = null;
  try { previousStamp = JSON.parse(gitText(run, root, ["show", `${base}:${STAMP_PATH}`])); } catch { /* Initial baseline has no prior stamp. */ }
  const stampChanged = listed.includes(STAMP_PATH) || stable(stamp) !== stable(previousStamp);
  if (changed.length > 0 && !stamp.release) {
    throw new Error(`published legal surface edited outside a release: ${changed.join(", ")}`);
  }
  if ((changed.length > 0 || stampChanged) && stamp.release) {
    if (stamp.release.baseCommit !== base) throw new Error("release base is not the pinned comparison commit");
    const baseTree = listedTree(root, base, run);
    const headTree = listedTree(root, "HEAD", run);
    for (const entry of stamp.release.consumed || []) {
      if (!Object.hasOwn(baseTree, `${PENDING_DIR}/${entry.name}`)) throw new Error("release stamp cannot be rebuilt");
    }
    assertRebuild(baseTree, headTree, stamp.release, renderTelemetry);
  }
  if (stampChanged && !stamp.release && previousStamp && stable(previousStamp) !== stable(stamp)) throw new Error("baseline stamp cannot be rewritten");
  return { ok: true, stamp, base, changed };
}

export function renderTelemetryWithScript(cwd = process.cwd()) {
  execFileSync(process.execPath, ["scripts/render-telemetry-disclosure.mjs", "--review-source-inventory"], { cwd, stdio: "pipe" });
}
