import sampleBackend from "../../config/sample-backend.json" with { type: "json" };
import { deniedHostsIn, deniedTokensIn, digestSet } from "./denied-identity.mjs";

// The sibling product's Supabase projects, application hosts and account
// identifiers, read as digests from the one maintained deny list in
// config/sample-backend.json (scripts/lib/denied-identity.mjs), for the
// built-bundle identity scanners (scripts/verify-web-bundle-identity.mjs and
// apps/mobile/scripts/verify-bundle-identity.mjs) and the local proof
// scripts. Build tooling only: nothing the browser or the native app bundles
// imports this module.

export const FORBIDDEN_SUPABASE_REF_DIGESTS = digestSet(sampleBackend.forbiddenSupabaseRefSha256);
export const FORBIDDEN_APP_HOST_DIGESTS = digestSet(sampleBackend.forbiddenAppHostSha256);
export const FORBIDDEN_IDENTITY_TOKEN_DIGESTS = digestSet(sampleBackend.forbiddenIdentityTokenSha256);

// A host counts only as itself or a subdomain of it, in any case, with an
// optional trailing DNS dot: www.<denied>, <DENIED> and <denied>. match.
// Union Ground's own org.unionground.app does not match a denied host it
// merely ends with (a label character on the left), and neither does an
// unrelated host that merely starts with a denied name, <denied>.example.org
// (a label after it).

// The text as a URL parser reads a host: a percent-escape of a hostname
// character is decoded (https://%73... names the same host as https://s...),
// compatibility forms such as full-width letters are folded (NFKC) and IDNA's
// other full stops become dots, all in lower case. Decoding every such escape,
// not only those inside a URL authority, can only add matches that spell a
// denied name. The scanners check the raw text and this form.
/**
 * @param {string} text
 * @returns {string}
 */
export function normalizedIdentityText(text) {
  const decoded = String(text).replace(/%([0-9A-Fa-f]{2})/g, (escape, hex) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return /[A-Za-z0-9.-]/.test(character) ? character : escape;
  });
  return decoded.normalize("NFKC").replace(/[\u3002\uFF0E\uFF61]/g, ".").toLowerCase();
}

/**
 * @param {string} text
 * @returns {string[]} every forbidden application host the text names, raw or normalized
 */
export function forbiddenAppHostsIn(text) {
  const raw = String(text).toLowerCase();
  return [...new Set([...deniedHostsIn(raw, FORBIDDEN_APP_HOST_DIGESTS), ...deniedHostsIn(normalizedIdentityText(text), FORBIDDEN_APP_HOST_DIGESTS)])];
}

/**
 * @param {string} text
 * @returns {string[]} every forbidden Supabase project the text names, in any case or percent-encoding
 */
export function forbiddenSupabaseRefsIn(text) {
  return deniedTokensIn(normalizedIdentityText(text), FORBIDDEN_SUPABASE_REF_DIGESTS);
}

/**
 * @param {string} text
 * @returns {string[]} every forbidden account identifier, mesh host or name the text contains as whole words
 */
export function forbiddenIdentityTokensIn(text) {
  return deniedTokensIn(normalizedIdentityText(text), FORBIDDEN_IDENTITY_TOKEN_DIGESTS);
}

/**
 * @param {string} text
 * @returns {string[]} every sibling Supabase project, application host and identifier the text names
 */
export function siblingIdentityIn(text) {
  return [...forbiddenSupabaseRefsIn(text), ...forbiddenAppHostsIn(text), ...forbiddenIdentityTokensIn(text)];
}
