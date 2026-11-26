import { createHash } from "node:crypto";

// Deny lists by digest. The sibling product's Supabase projects, application
// hosts and account identifiers stay refused, but this repository does not
// spell them out: config/sample-backend.json and scripts/db-contract.json keep
// only the SHA-256 of each value (lower-cased, behind DENY_DIGEST_PREFIX), and
// the checks below hash what they inspect and compare. Node only: nothing the
// browser or the native app bundles imports this module.
//
// To add an entry: node scripts/lib/denied-identity.mjs <value>
export const DENY_DIGEST_PREFIX = "union-ground/deny-list/v1:";
export const DENY_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** @param {string} value */
export function denyDigest(value) {
  return createHash("sha256").update(`${DENY_DIGEST_PREFIX}${String(value).trim().toLowerCase()}`).digest("hex");
}

/**
 * @param {readonly string[] | undefined} digests
 * @returns {ReadonlySet<string>}
 */
export function digestSet(digests) {
  const values = [...(digests ?? [])].map((digest) => String(digest).trim().toLowerCase());
  for (const digest of values) {
    if (!DENY_DIGEST_PATTERN.test(digest)) throw new Error(`deny-list entry is not a SHA-256 digest: ${digest}`);
  }
  return Object.freeze(new Set(values));
}

/**
 * @param {string} value
 * @param {ReadonlySet<string>} digests
 */
export function isDeniedValue(value, digests) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return Boolean(normalized) && digests.has(denyDigest(normalized));
}

/**
 * The host itself or any parent domain of it is on the list (a denied host is
 * refused with all of its subdomains). A trailing DNS dot is ignored.
 *
 * @param {string} hostname
 * @param {ReadonlySet<string>} digests
 * @returns {string | null} the denied host or parent domain, or null
 */
export function deniedHostOf(hostname, digests) {
  const labels = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start, labels.length).join(".");
    if (digests.has(denyDigest(candidate))) return candidate;
  }
  return null;
}

// A host as it appears in text: labels joined by dots, ending where a label
// character or a dot followed by one would continue it.
const HOST_IN_TEXT = /(?<![a-z0-9-])[a-z0-9-]+(?:\.[a-z0-9-]+)+(?![a-z0-9-]|\.[a-z0-9-])/g;

/**
 * Every denied host the (already lower-cased) text names, as itself or as a
 * subdomain. A host only counts where it ends: `<denied>.example.org` names a
 * different host, and so does `x<denied>`.
 *
 * @param {string} text
 * @param {ReadonlySet<string>} digests
 * @returns {string[]}
 */
export function deniedHostsIn(text, digests) {
  if (digests.size === 0) return [];
  const found = new Set();
  for (const match of String(text).matchAll(HOST_IN_TEXT)) {
    const denied = deniedHostOf(match[0], digests);
    if (denied) found.add(denied);
  }
  return [...found];
}

// Up to this many words joined by single "-", ".", "_" or space characters
// form one candidate token ("spark-node", "db.abc", "two words").
const MAX_TOKEN_WORDS = 4;
const WORD = /[a-z0-9]+/g;
const JOINERS = new Set(["-", ".", "_", " "]);

/**
 * Every denied token the (already lower-cased) text contains as whole words:
 * a Supabase project ref inside a host name, a numeric account id, a
 * hyphenated host label, or a short phrase.
 *
 * @param {string} text
 * @param {ReadonlySet<string>} digests
 * @returns {string[]}
 */
export function deniedTokensIn(text, digests) {
  if (digests.size === 0) return [];
  const source = String(text);
  const words = [...source.matchAll(WORD)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const found = new Set();
  for (let first = 0; first < words.length; first += 1) {
    // A token does not start inside a hyphenated or underscored name
    // ("REQ-<name>-USAGE" is a record id, not the name); a dot or any other
    // separator on its left is a boundary ("db.<ref>", "postgres.<ref>").
    const before = words[first].start;
    if (before >= 2 && (source[before - 1] === "-" || source[before - 1] === "_") && /[a-z0-9]/.test(source[before - 2])) continue;
    for (let last = first; last < Math.min(words.length, first + MAX_TOKEN_WORDS); last += 1) {
      if (last > first) {
        const gapStart = words[last - 1].end;
        if (words[last].start - gapStart !== 1 || !JOINERS.has(source[gapStart])) break;
      }
      const candidate = source.slice(words[first].start, words[last].end);
      if (digests.has(denyDigest(candidate))) found.add(candidate);
    }
  }
  return [...found];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const values = process.argv.slice(2);
  if (values.length === 0) throw new Error("Pass one or more values to digest.");
  for (const value of values) console.log(denyDigest(value));
}
