// #9485 part A: a reporting tool for rule (a) of
// docs/contracts/visible-control-honesty.md. It lists buttons blocked for a
// cause other than busy with no `disabledReason` (#9474). It enforces nothing:
// no test or CI step fails on what it finds (enforcement is #9485 part B).
// Run: node scripts/lib/blocked-control-scan.mjs --list
// A hint, not a verdict: it decides busy by how a gate's names are spelled, it
// misses a `disabled` passed in a spread or forwarded through a wrapper not
// named like a button, and it counts button markup inside a string.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONTRACT_PATH = "docs/contracts/visible-control-honesty.md";

// The trees it reads and the prop each shared button takes for a reason. The
// phone joins when its shared button has one (#9481).
export const SURFACES = Object.freeze([Object.freeze({ name: "web", tree: "src/", reasonProp: "disabledReason" })]);
const SOURCE_FILE = /\.(?:jsx|js|tsx|ts)$/u;
const TEST_FILE = /(?:\.test\.|\.spec\.|\/__tests__\/|\/testing\/)/u;
// A native <button> or any component whose name ends in Button.
const BUTTON_TAG = /<(button|(?:[A-Z][\w.]*)?Button)(?=[\s/>])/gu;

// Busy when the first word (after "is") or the last names work in flight:
// savingId, loadingMore, historyLoading; not hasPendingChanges.
const BUSY_WORDS = new Set(("busy pending loading saving submitting sending working deleting removing uploading processing "
  + "running refreshing exporting importing generating publishing joining leaving accepting declining approving rejecting "
  + "archiving restoring resending retrying canceling cancelling verifying connecting disconnecting syncing creating updating "
  + "claiming releasing confirming redeeming fetching searching downloading signing").split(" "));

function busyName(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_$]+/gu, " ").toLowerCase().split(" ").filter(Boolean);
  if (words[0] === "is") words.shift();
  if (words[0] === "in" && words[1] === "flight") return true;
  return words.length > 0 && (BUSY_WORDS.has(words[0]) || BUSY_WORDS.has(words[words.length - 1]));
}

// One opening tag to its closing `>`, past braces and quotes: where each
// top-level attribute starts and whether it spreads props. A top-level `<`
// means the tag never closed: null, so no later `disabled` attaches to it.
function readTag(source, start) {
  const names = new Map();
  let depth = 0;
  let quote = null;
  let spreads = false;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = null;
    } else if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "{") {
      if (depth === 0 && source.startsWith("...", cursor + 1)) spreads = true;
      depth += 1;
    } else if (character === "}") depth -= 1;
    else if (depth === 0 && character === "<") return null;
    else if (depth === 0 && character === ">" && source[cursor - 1] !== "=") return { text: source.slice(start, cursor + 1), names, spreads };
    else if (depth === 0 && /\s/u.test(character)) {
      const name = /^[\w-]+/u.exec(source.slice(cursor + 1, cursor + 80))?.[0];
      if (name && !names.has(name)) names.set(name, cursor + 1 - start);
    }
  }
  return null;
}

// An attribute's braced expression, quoted string, true when bare, or undefined.
export function attributeValue(tag, name) {
  const read = typeof tag === "string" ? readTag(tag, 0) : tag;
  if (!read?.names.has(name)) return undefined;
  const rest = read.text.slice(read.names.get(name) + name.length);
  const value = /^\s*=\s*(["'])((?:(?!\1)[^])*)\1|^\s*=\s*\{/u.exec(rest);
  if (!value) return true;
  if (value[1]) return value[2];
  let depth = 0;
  for (let end = value[0].length - 1; end < rest.length; end += 1) {
    if (rest[end] === "{") depth += 1;
    else if (rest[end] === "}" && --depth === 0) return rest.slice(value[0].length, end).trim();
  }
  return rest.slice(value[0].length).trim();
}

const unwrap = (value) => value.trim().replace(/^Boolean\((.*)\)$/u, "$1").replace(/^\((.*)\)$/u, "$1").trim();

// The operands of a gate's top-level `||` chain.
function operands(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if ("([{".includes(text[cursor])) depth += 1;
    else if (")]}".includes(text[cursor])) depth -= 1;
    else if (depth === 0 && text.startsWith("||", cursor)) {
      parts.push(text.slice(from, cursor));
      from = cursor + 2;
      cursor += 1;
    }
  }
  return [...parts, text.slice(from)].map((part) => part.trim());
}

// `busy`, `!!saving`, `savingId === row.id`, `state === "loading"`; an odd
// number of `!` is blocked, not busy.
function busyOperand(raw) {
  const bangs = /^(!*)/u.exec(raw)[1].length;
  if (bangs % 2 === 1) return false;
  const [subject, compared = ""] = unwrap(raw.slice(bangs)).split(/\s*(?<![!=])={2,3}\s*/u);
  if (/^["'`]\w+["'`]$/u.test(compared)) return busyName(compared.slice(1, -1));
  return /^[\w$.?[\]]+$/u.test(subject) && busyName(subject.split(/[.?[\]]+/u).filter(Boolean).pop() ?? "");
}

// Every operand is busy, or the gate only hands on a `disabled` value
// (`props.disabled`, `item.disabled`), whose reason belongs where it is set.
export function busyOnly(expression) {
  if (expression === true) return false;
  const text = String(expression).replace(/\s+/gu, " ").trim();
  if (text === "false" || text === "" || /^(?:[\w$]+\??\.)*disabled$/u.test(text)) return true;
  return operands(unwrap(text)).every(busyOperand);
}

// On a `//`, `*` or `{/*` line, or inside a block comment opened after a
// space, a brace or the line start.
function inComment(source, index) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  if (/^\s*(?:\/\/|\*|\{?\/\*)/u.test(source.slice(lineStart, index))) return true;
  for (let open = source.lastIndexOf("/*", index); open !== -1; open = source.lastIndexOf("/*", open - 1)) {
    if (open === 0 || /[\s{;(,]/u.test(source[open - 1])) {
      const close = source.indexOf("*/", open + 2);
      return close === -1 || close > index;
    }
  }
  return false;
}

// In the file that defines the shared button, its spreading tags are the
// primitive, not call sites.
const DEFINES_REASON = /function\s+\w+\s*\(\s*\{[^)]*\bdisabledReason\b/u;

export function blockedWithoutReason(source, reasonProp = "disabledReason") {
  const found = [];
  const primitive = DEFINES_REASON.test(source);
  for (const match of source.matchAll(BUTTON_TAG)) {
    if (inComment(source, match.index)) continue;
    const tag = readTag(source, match.index);
    const gate = attributeValue(tag, "disabled");
    if (gate === undefined || busyOnly(gate) || tag.names.has(reasonProp) || (primitive && tag.spreads)) continue;
    found.push({ line: source.slice(0, match.index).split("\n").length, tag: match[1], gate: gate === true ? "" : String(gate).replace(/\s+/gu, " ") });
  }
  return found;
}

// { path: [{ line, tag, gate }] } for every tracked file under a scanned tree.
export function scanBlockedControls(root, paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0").filter(Boolean).sort()) {
  const places = {};
  for (const path of paths) {
    const surface = SURFACES.find((candidate) => path.startsWith(candidate.tree));
    if (!surface || !SOURCE_FILE.test(path) || TEST_FILE.test(path) || !existsSync(join(root, path))) continue;
    const found = blockedWithoutReason(readFileSync(join(root, path), "utf8"), surface.reasonProp);
    if (found.length) places[path] = found;
  }
  return places;
}

// One line per place and a closing count, as `--list` prints them.
export function listBlockedControls(root, paths) {
  const lines = [];
  for (const [path, found] of Object.entries(scanBlockedControls(root, paths))) {
    for (const place of found) lines.push(`${path}:${place.line} <${place.tag}> disabled${place.gate ? `={${place.gate}}` : ""}`);
  }
  return [...lines, `${lines.length} place(s); see ${CONTRACT_PATH} rule (a)`];
}

if (process.argv[1]?.endsWith("blocked-control-scan.mjs") && process.argv.includes("--list")) {
  console.log(listBlockedControls(process.cwd()).join("\n"));
}
