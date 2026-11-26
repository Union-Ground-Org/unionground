// Curated public profiles for the directory. Each link would be the
// organization's own page and would say nothing about product adoption.
// Document links are for members: a resource here is a local page or a
// leadership page, never a contract, agreement, salary chart, bylaws or form
// page. An entry gains `catalogKey` and `identitySource` only once its filing
// identity is verified. This edition features no union: a deployment adds its
// own entries here (tests/helpers/featuredUnionFixture.js shows the shape).
export const FEATURED_UNIONS = Object.freeze([]);

export function featuredUnion(key) {
  if (typeof key !== "string") return null;
  return FEATURED_UNIONS.find((union) => union.key === key || union.catalogKey === key) ?? null;
}
