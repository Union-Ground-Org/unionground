import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// TEST-UG-MEMBERSHIP-CARD-TEST-TITLE-EMBEDS-CLOCK-20261110 (#7990): the
// merge-group retry matches a failed test by suite path, name and occurrence
// (#7946), so a test whose title differs between two runs of the same file is
// never found on the rerun and keeps the shard failed. A title differs between
// runs when it prints a value read from the clock or a random source: an
// it.each/test.each/describe.each table holding such a call with a title that
// prints values (%s, %d, %i, %f, %j, %o, %O or $name; %# is the stable case
// index), or a template-literal title that interpolates one.

// Calls that answer differently on every run. A Date built from a fixed time
// (new Date(now), new Date("2026-...")) is stable and not listed.
const VOLATILE = /\b(?:Date\.now|performance\.now|Math\.random|randomUUID|getRandomValues)\s*\(|\bnew Date\s*\(\s*\)/;
const PRINTS_VALUE = /^\s*\(\s*(["'`])(?:(?!\1).)*?(?:%[sdifjoO]|\$[A-Za-z_])/s;
const EACH = /\b(?:it|test|describe)(?:\.(?:only|skip|concurrent|sequential|fails))*\.each\s*\(/g;
const TEMPLATE_TITLE = /\b(?:it|test|describe)(?:\.(?:only|skip|concurrent|sequential|fails|todo))*\s*\(\s*`([^`]*)`/g;

function matchingClose(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// A table's arrow functions run inside the test, after the titles are built,
// so a clock read there never reaches a title: drop each arrow's body (up to
// the next comma or closing bracket at its own depth) before looking.
function withoutArrowBodies(table) {
  let out = "";
  for (let index = 0; index < table.length; index += 1) {
    if (table[index] === "=" && table[index + 1] === ">") {
      let depth = 0;
      let end = index + 2;
      for (; end < table.length; end += 1) {
        const char = table[end];
        if (char === "(" || char === "[" || char === "{") depth += 1;
        else if (char === ")" || char === "]" || char === "}") {
          if (depth === 0) break;
          depth -= 1;
        } else if (char === "," && depth === 0) break;
      }
      out += "=> 0";
      index = end - 1;
    } else {
      out += table[index];
    }
  }
  return out;
}

/** The lines of one test source whose titles change between runs. */
export function unstableTitleLines(source) {
  const lines = [];
  for (const match of source.matchAll(EACH)) {
    const open = match.index + match[0].length - 1;
    const close = matchingClose(source, open);
    if (close < 0) continue;
    if (VOLATILE.test(withoutArrowBodies(source.slice(open, close + 1))) && PRINTS_VALUE.test(source.slice(close + 1, close + 400))) lines.push(lineOf(source, match.index));
  }
  for (const match of source.matchAll(TEMPLATE_TITLE)) {
    if ([...match[1].matchAll(/\$\{([^}]*)\}/g)].some((part) => VOLATILE.test(part[1]))) lines.push(lineOf(source, match.index));
  }
  return lines;
}

function* testFiles(directory) {
  for (const name of readdirSync(directory)) {
    if (name === "node_modules" || name === "fixtures" || name.startsWith(".")) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* testFiles(path);
    else if (/\.test\.[cm]?[jt]sx?$/.test(name)) yield path;
  }
}

/** Every `file:line` under the roots whose test title changes between runs. */
export function unstableTestTitles(roots, { ignore = [] } = {}) {
  const found = [];
  for (const root of roots) {
    for (const file of testFiles(root)) {
      if (ignore.includes(file)) continue;
      for (const line of unstableTitleLines(readFileSync(file, "utf8"))) found.push(`${file}:${line}`);
    }
  }
  return found;
}
