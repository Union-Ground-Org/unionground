// Fails on a new operation key minted where the write is sent: a property,
// variable or default parameter named idempotency key or operation key whose
// value calls randomUUID(). Each call then carries a fresh key, so the retry
// after a lost response is a second write the server cannot recognise. Keep
// the key with the intent instead (src/lib/operationKey.js;
// SYS-UG-SHARED-RETRY-IDEMPOTENCY-GUARD-20261113).
//
// config/inline-operation-key-known.json lists the files that did this on
// Nov 13, 2026, with their counts. The list only shrinks: a count above the
// listed one fails, and so does a listed count the file no longer reaches.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KNOWN_PATH = "config/inline-operation-key-known.json";
const SCOPE = /^(?:src|api|workers|apps\/mobile\/src)\/.+\.(?:[cm]?js|jsx|ts|tsx)$/u;
const TEST_FILE = /(?:\.test\.|\.spec\.|\/__tests__\/|\/fixtures\/)/u;
const INLINE_KEY = /(?<![\w$])(?:p_)?(?:idempotency|operation)_?key\s*(?::|=(?!=|>)|\|\|=|\?\?=)\s*[^,;\n]*?\brandomUUID\s*\(/giu;

export function inScope(path) {
  return SCOPE.test(path) && !TEST_FILE.test(path);
}

export function countInlineOperationKeys(text) {
  return [...String(text).matchAll(INLINE_KEY)].length;
}

export function inlineOperationKeyFindings(counts, known) {
  const failures = [];
  for (const [path, count] of Object.entries(counts)) {
    const allowed = known[path] ?? 0;
    if (count > allowed) {
      failures.push(`${path}: ${count} operation key(s) minted at the call (known ${allowed}); keep one key per intent with createOperationKeys from src/lib/operationKey.js`);
    }
  }
  for (const [path, allowed] of Object.entries(known)) {
    const count = counts[path] ?? 0;
    if (count < allowed) failures.push(`${KNOWN_PATH}: ${path} now has ${count} inline operation key(s); lower its known count from ${allowed} to ${count}`);
  }
  return failures;
}

export function checkInlineOperationKeys(root, fail) {
  const known = existsSync(join(root, KNOWN_PATH)) ? JSON.parse(readFileSync(join(root, KNOWN_PATH), "utf8")).files ?? {} : {};
  let paths;
  try {
    paths = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
      .split("\0").filter(inScope);
  } catch (error) {
    fail(`inline operation key scan: cannot list tracked files (${String(error.stderr || error.message).trim().split("\n")[0]})`);
    return {};
  }
  const counts = {};
  for (const path of paths) {
    if (!existsSync(join(root, path))) continue;
    const count = countInlineOperationKeys(readFileSync(join(root, path), "utf8"));
    if (count) counts[path] = count;
  }
  for (const message of inlineOperationKeyFindings(counts, known)) fail(message);
  return counts;
}
