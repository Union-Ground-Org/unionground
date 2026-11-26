// @brand-literal
// The product's name and mark, decided once for every surface: the web build
// (scripts/lib/brand-vite-plugin.mjs), the server functions (api/_lib/brand.js)
// and the phone app (apps/mobile/app.config.ts and its Babel plugin).
//
// The code is AGPL and anyone may run a copy, but the Union Ground name, mark
// and app icon are trademarks of Union Ground LLC (TRADEMARKS.md, and the
// section 7 term in NOTICE). So there are two modes, after Mozilla's
// browser/branding/official model:
//
// - Unbranded, the default for every build: the product name is the
//   operator's own (VITE_BRAND_NAME on the web, BRAND_NAME on the phone), the
//   mark is a plain rounded square with the name's initial, and the icons are
//   neutral placeholders. A production build without a name, or with the
//   Union Ground name, fails with a message for the operator. Development and
//   tests fall back to DEVELOPMENT_BRAND_NAME.
// - Official, only for Union Ground LLC's own builds: VITE_OFFICIAL_BRANDING=1
//   (phone: OFFICIAL_BRANDING=1) and the files in branding/official/, which are
//   not covered by the AGPL (branding/official/LICENSE.md).
//
// The "@brand-literal" line above keeps the build-time name substitution out
// of this file: these strings must stay exactly as written.

export const UNION_GROUND_NAME = "Union Ground";
export const DEVELOPMENT_BRAND_NAME = "Union workspace (development build)";
export const BRAND_LITERAL_DIRECTIVE = "@brand-literal";

// NOTICE, section 7 (b): every modified version keeps this line, verbatim, on
// its about or legal screen.
export const ATTRIBUTION_NOTICE = "Based on Union Ground (https://unionground.org)";
export const UPSTREAM_URL = "https://unionground.org";
export const DEFAULT_SOURCE_CODE_URL = "https://github.com/Union-Ground-Org/unionground";
export const OFFICIAL_SERVICE_LABEL = {
  en: "Official Union Ground service",
  es: "Servicio oficial de Union Ground",
};

// Letters, marks, digits, spaces and . , & ( ) \u2019 -, 2 to 60 characters,
// starting with a letter or digit. No quotes, backslashes, angle brackets,
// dollar signs or backticks: the name is written into JavaScript strings,
// JSX text and HTML at build time without escaping.
const BRAND_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&()\u2019-]{1,59}$/u;

export class BrandConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BrandConfigurationError";
  }
}

// Case, spacing and punctuation do not make a different name.
export function brandKey(name) {
  return String(name ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

// "Union Ground" in any case or spacing, alone or with other words
// ("Union Ground Plus", "my-union-ground") is the LLC's mark.
export function isReservedBrandName(name) {
  return brandKey(name).includes("unionground");
}

export function normalizeBrandName(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

export function parseBrandFlag(value, variable) {
  const normalized = String(value ?? "").trim();
  if (normalized === "" || normalized === "0") return false;
  if (normalized === "1") return true;
  throw new BrandConfigurationError(`${variable} must be 1 or unset (got "${normalized.slice(0, 20)}").`);
}

export function brandInitial(name) {
  const match = /[\p{L}\p{N}]/u.exec(String(name ?? ""));
  return match ? match[0].toLocaleUpperCase() : "?";
}

function brandResult(name, official, warning) {
  return Object.freeze({
    name,
    official,
    initial: brandInitial(name),
    ...(warning ? { warning } : {}),
  });
}

// Decides the product name for one build. `production` is true for a
// production web build or a store build of the phone app; anything else is a
// development or test build, which falls back instead of failing.
export function resolveBrand({
  brandName,
  officialBranding,
  officialAssetsPresent = false,
  production = false,
  nameVariable = "VITE_BRAND_NAME",
  officialVariable = "VITE_OFFICIAL_BRANDING",
} = {}) {
  const name = normalizeBrandName(brandName);
  const official = parseBrandFlag(officialBranding, officialVariable);
  const ownName = `Set ${nameVariable} to your own product name; copies of Union Ground use their own name and logo (TRADEMARKS.md).`;

  if (official) {
    if (officialAssetsPresent) {
      if (name && !isReservedBrandName(name)) {
        throw new BrandConfigurationError(`${officialVariable}=1 always uses the Union Ground name; unset ${nameVariable} or turn official branding off.`);
      }
      return brandResult(UNION_GROUND_NAME, true);
    }
    const missing = `${officialVariable}=1, but branding/official/ is missing. Official branding is only for Union Ground LLC's own builds.`;
    if (production) throw new BrandConfigurationError(`${missing} Unset ${officialVariable}. ${ownName}`);
    return brandResult(DEVELOPMENT_BRAND_NAME, false, `${missing} Using "${DEVELOPMENT_BRAND_NAME}".`);
  }

  if (!name) {
    if (production) {
      throw new BrandConfigurationError(`${nameVariable} is not set. A production build needs a product name. ${ownName}`);
    }
    return brandResult(DEVELOPMENT_BRAND_NAME, false);
  }
  if (!BRAND_NAME_PATTERN.test(name)) {
    throw new BrandConfigurationError(`${nameVariable} must be 2 to 60 letters, digits, spaces or . , & ( ) \u2019 -, starting with a letter or digit.`);
  }
  if (isReservedBrandName(name)) {
    const reserved = `${nameVariable} is "${name}". The Union Ground name is reserved for Union Ground LLC's official builds.`;
    if (production) throw new BrandConfigurationError(`${reserved} ${ownName}`);
    return brandResult(DEVELOPMENT_BRAND_NAME, false, `${reserved} Using "${DEVELOPMENT_BRAND_NAME}".`);
  }
  return brandResult(name, false);
}

// SOURCE_CODE_URL: where this build's source is offered (AGPL section 13).
// Unset means the upstream repository; an operator who modifies the code
// points it at their own. Only a plain https URL is accepted.
export function resolveSourceCodeUrl(value, variable = "SOURCE_CODE_URL") {
  const raw = String(value ?? "").trim();
  if (!raw) return DEFAULT_SOURCE_CODE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch {
    // Falls through to the refusal below.
  }
  throw new BrandConfigurationError(`${variable} must be an https URL of this build's source code.`);
}

// Puts the build's own name wherever the source says "Union Ground", except
// the two places where the words name Union Ground itself: the attribution
// notice ("Based on Union Ground") and the company ("Union Ground LLC").
// Uppercase wordmarks ("UNION GROUND", "UNION&nbsp;GROUND") follow too.
// (No lookbehind: this module also loads in the browser, and the web build
// still supports Safari 14, which cannot parse one.)
const NAME_PATTERN = /Union Ground(?! LLC)/g;
const UPPERCASE_PATTERN = /UNION( |&nbsp;)GROUND(?! LLC)/g;
const ATTRIBUTION_LEAD = "Based on ";

export function applyBrandName(text, name) {
  if (typeof text !== "string" || !name || name === UNION_GROUND_NAME) return text;
  const upper = name.toLocaleUpperCase();
  return text
    .replace(NAME_PATTERN, (match, offset, whole) => (
      whole.slice(Math.max(0, offset - ATTRIBUTION_LEAD.length), offset) === ATTRIBUTION_LEAD ? match : name
    ))
    .replace(UPPERCASE_PATTERN, (_, space) => (space === " " ? upper : upper.replaceAll(" ", "&nbsp;")));
}

// The words the substitution leaves alone, for checks that look for a
// leftover "Union Ground" in a built bundle.
export function withoutProtectedNames(text) {
  return String(text ?? "")
    .replaceAll("Based on Union Ground", "")
    .replace(/Union Ground LLC/g, "")
    .replace(/UNION GROUND LLC/g, "");
}

// Exact host match only: no suffixes, no lookalikes, no trailing dot. A
// punycode (xn--) lookalike is a different string and never matches.
export function isOfficialHost(hostname, officialHosts) {
  if (typeof hostname !== "string" || !Array.isArray(officialHosts)) return false;
  return officialHosts.includes(hostname.toLowerCase());
}

// The "Official Union Ground service" badge: official branding AND a page on
// one of the LLC's own hosts. A copy of an official build on any other host
// shows no badge.
export function showsOfficialServiceMark({ official, hostname, officialHosts }) {
  return official === true && isOfficialHost(hostname, officialHosts);
}

function exactHttpsOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

// The phone app's backend is official only when its Supabase origin is on the
// official list and its portal is one of the official hosts.
export function isOfficialBackend({ supabaseUrl, portalBaseUrl, officialHosts, officialSupabaseOrigins }) {
  const backend = exactHttpsOrigin(supabaseUrl);
  const portal = exactHttpsOrigin(portalBaseUrl);
  if (!backend || !portal || !Array.isArray(officialSupabaseOrigins)) return false;
  return officialSupabaseOrigins.includes(backend) && isOfficialHost(new URL(portal).hostname, officialHosts);
}
