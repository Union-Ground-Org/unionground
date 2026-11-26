// Fails on a new catch that swallows an error: an empty catch block, a catch
// whose whole body returns or sets state to an empty value ([], {}, null,
// undefined, "", 0, false), or a promise .catch whose handler does only
// that. A failed read then looks like "nothing here" to the person and to
// monitoring. Keep the
// failure (readResult in src/lib/readResult.js) or report it before falling
// back (withReportedFallback in api/_lib/reportedFallback.js); a catch that
// may stay silent says why with a "swallow-ok:" comment on its line
// (SYS-UG-SHARED-SWALLOWED-ERROR-GUARD-20261113).
//
// config/swallowed-error-known.json lists the files that did this on Nov 13,
// 2026, with their counts. The list only shrinks.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KNOWN_PATH = "config/swallowed-error-known.json";
const SCOPE = /^(?:src|api|workers|apps\/mobile\/src)\/.+\.(?:[cm]?js|jsx|ts|tsx)$/u;
const TEST_FILE = /(?:\.test\.|\.spec\.|\/__tests__\/|\/fixtures\/)/u;
const EMPTY = String.raw`(?:\[\s*\]|\{\s*\}|null|undefined|""|''|0|false)`;
const SWALLOWS = [
  // try { … } catch (error) { }  /  catch { return []; }  /  catch { setRows([]); }
  new RegExp(String.raw`\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:return(?:\s+${EMPTY})?\s*;?\s*|set[A-Z][\w$]*\(\s*${EMPTY}\s*\)\s*;?\s*)?\}`, "gu"),
  // promise.catch(() => [])  /  .catch(() => {})  /  .catch(() => ({}))
  new RegExp(String.raw`\.catch\(\s*(?:\([^()]*\)|[\w$]+)\s*=>\s*(?:${EMPTY}|\(\s*${EMPTY}\s*\)|\{\s*(?:return(?:\s+${EMPTY})?\s*;?\s*)?\})\s*\)`, "gu"),
];
const REASON = /swallow-ok:/u;

export function countSwallowedErrors(text) {
  const source = String(text);
  let count = 0;
  for (const pattern of SWALLOWS) {
    for (const match of source.matchAll(pattern)) {
      const lineStart = source.lastIndexOf("\n", match.index) + 1;
      const lineEnd = source.indexOf("\n", match.index + match[0].length);
      if (!REASON.test(source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd))) count += 1;
    }
  }
  return count;
}

export function inScope(path) {
  return SCOPE.test(path) && !TEST_FILE.test(path);
}

export function swallowedErrorFindings(counts, known) {
  const failures = [];
  for (const [path, count] of Object.entries(counts)) {
    const allowed = known[path] ?? 0;
    if (count > allowed) {
      failures.push(`${path}: ${count} catch(es) that swallow the error (known ${allowed}); keep the failure with readResult (src/lib/readResult.js), report it with withReportedFallback (api/_lib/reportedFallback.js), or say why with "swallow-ok:"`);
    }
  }
  for (const [path, allowed] of Object.entries(known)) {
    const count = counts[path] ?? 0;
    if (count < allowed) failures.push(`${KNOWN_PATH}: ${path} now has ${count} swallowing catch(es); lower its known count from ${allowed} to ${count}`);
  }
  return failures;
}

export function checkSwallowedErrors(root, fail) {
  let paths;
  try {
    paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
      .split("\0").filter(inScope);
  } catch (error) {
    fail(`swallowed error scan: cannot list tracked files (${String(error.stderr || error.message).trim().split("\n")[0]})`);
    return {};
  }
  const counts = {};
  for (const path of paths) {
    if (!existsSync(join(root, path))) continue;
    const count = countSwallowedErrors(readFileSync(join(root, path), "utf8"));
    if (count) counts[path] = count;
  }
  const known = existsSync(join(root, KNOWN_PATH)) ? JSON.parse(readFileSync(join(root, KNOWN_PATH), "utf8")).files ?? {} : {};
  for (const message of swallowedErrorFindings(counts, known)) fail(message);
  return counts;
}
