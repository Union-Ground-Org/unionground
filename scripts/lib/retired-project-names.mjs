import { createHash } from "node:crypto";

// The digest keeps the retired spelling out of distributed source. The
// candidate shape keeps the bundle scan cheap even inside long identifiers.
const retiredNames = new Set([
  "dcc45bd619ad9e9eee634bdbfaac84ec095ed1965d9d8951706c39d917508212",
]);

/** @param {string} text @param {ReadonlySet<string>} [digests] */
export function hasRetiredProjectName(text, digests = retiredNames) {
  for (const [, candidate] of text.matchAll(/(?=(p[a-z]{2}(?:[\s_-]|&nbsp;)?[a-z]{5}))/gi)) {
    const normalized = candidate.replace(/[\s_-]|&nbsp;/gi, "").toLowerCase();
    if (digests.has(createHash("sha256").update(normalized).digest("hex"))) return true;
  }
  return false;
}
