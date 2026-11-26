// The web app's product name and mark, fixed at build time by
// scripts/lib/brand-vite-plugin.mjs from VITE_BRAND_NAME and
// VITE_OFFICIAL_BRANDING (the rules are in ./shared-core/brand.js). Code that
// prints the name reads BRAND_NAME; copy that says "Union Ground" in the
// source is rewritten to the build's own name by the same plugin.
import {
  ATTRIBUTION_NOTICE,
  DEFAULT_SOURCE_CODE_URL,
  DEVELOPMENT_BRAND_NAME,
  brandInitial,
  showsOfficialServiceMark,
} from "./shared-core/brand.js";

const injected = typeof __UNIONGROUND_BRAND__ === "undefined" ? null : __UNIONGROUND_BRAND__;
const injectedMark = typeof __UNIONGROUND_OFFICIAL_MARK__ === "undefined" ? null : __UNIONGROUND_OFFICIAL_MARK__;
const injectedHosts = typeof __UNIONGROUND_OFFICIAL_HOSTS__ === "undefined" ? [] : __UNIONGROUND_OFFICIAL_HOSTS__;

export const BRAND = Object.freeze({
  name: injected?.name || DEVELOPMENT_BRAND_NAME,
  official: injected?.official === true,
  initial: injected?.initial || brandInitial(injected?.name || DEVELOPMENT_BRAND_NAME),
  sourceCodeUrl: injected?.sourceCodeUrl || DEFAULT_SOURCE_CODE_URL,
});

export const BRAND_NAME = BRAND.name;
const OFFICIAL_BRANDING = BRAND.official;

// Data URLs of the official mark files (branding/official/), present only in
// an official build: an unbranded bundle carries no Union Ground artwork.
export const OFFICIAL_MARK = OFFICIAL_BRANDING && injectedMark ? Object.freeze({ ...injectedMark }) : null;

export { ATTRIBUTION_NOTICE };

// The "Official Union Ground service" mark: an official build served from one
// of the LLC's own hosts (config/official-domains.json, exact match, handed to
// official builds only). A copy of an official build on any other host shows
// no mark.
const OFFICIAL_HOSTS = Object.freeze(Array.isArray(injectedHosts) ? [...injectedHosts] : []);

export function officialServiceMarkShown(hostname = globalThis.location?.hostname) {
  return showsOfficialServiceMark({ official: OFFICIAL_BRANDING, hostname, officialHosts: OFFICIAL_HOSTS });
}
