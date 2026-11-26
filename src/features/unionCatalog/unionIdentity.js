import { CATALOG_KEY_PATTERN } from "./catalogSearch.js";
import { featuredUnion } from "./featuredUnions.js";

// Union identity is shared by resources and campaign setup. Union Ground
// has no public union catalog page, so nothing here links to one. Only
// reviewed exact aliases can join profiles; names, local numbers and family
// codes are never sufficient to identify a local or confer affiliation.
export function resolveUnionProfileKey(key) {
  if (typeof key !== "string") return null;
  const featured = featuredUnion(key);
  if (featured) return featured.catalogKey ?? featured.key;
  return CATALOG_KEY_PATTERN.test(key) ? key : null;
}

export function featuredUnionForKey(key) {
  return typeof key === "string" ? featuredUnion(key) : null;
}

// A public selection is a proposed setup parent, never an enrollment, claim,
// verified affiliation or permission to create a chapter. A featured alias
// without a catalog match remains an explicitly unlisted parent suggestion.
export function unionSetupHref(key) {
  const resolved = resolveUnionProfileKey(key);
  return resolved
    ? `/m/admin/setup-review?union=${encodeURIComponent(resolved)}&build=chapter`
    : "/m/admin/setup-review?build=chapter";
}
