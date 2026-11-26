// A fictional featured local with a verified filing identity. No real featured
// entry carries one today, so tests mock featuredUnions.js with this fixture to
// keep the featured-alias-to-catalog join covered:
//
//   vi.mock("../src/features/unionCatalog/featuredUnions.js", async (importOriginal) => {
//     const { withFeaturedUnionFixture } = await import("./helpers/featuredUnionFixture.js");
//     return withFeaturedUnionFixture(await importOriginal());
//   });
//
// Copy keys that miss the catalogue render verbatim, so the fixture's detail
// and sector lines read as plain text.
export const FEATURED_FIXTURE = Object.freeze({
  key: "test-featured-local",
  name: "Example Featured Local",
  family: "EXW",
  detailKey: "Example featured local detail.",
  sectorKey: "Example featured local sector.",
  profileAnchor: "test-featured-local",
  website: "https://www.example.invalid/",
  catalogKey: "olms-900000077",
  identitySource: Object.freeze({ href: "https://olmsapps.dol.gov/olpdr/", fileNumber: "900000077" }),
  resources: Object.freeze([
    Object.freeze({ labelKey: "unions.featuredLocalPage", href: "https://www.example.invalid/local" }),
  ]),
});

// A fictional featured local whose filing identity is not verified: it stays
// an unlisted parent and never borrows a catalog key.
export const UNLISTED_FEATURED_FIXTURE = Object.freeze({
  key: "test-unlisted-local",
  name: "Example Unlisted Local",
  family: "EXW",
  detailKey: "Example unlisted local detail.",
  sectorKey: "Example unlisted local sector.",
  profileAnchor: "test-unlisted-local",
  website: "https://www.example.invalid/unlisted",
  resources: Object.freeze([
    Object.freeze({ labelKey: "unions.featuredLocalPage", href: "https://www.example.invalid/unlisted" }),
  ]),
});

export function withFeaturedUnionFixture(actual) {
  return {
    ...actual,
    FEATURED_UNIONS: Object.freeze([...actual.FEATURED_UNIONS, FEATURED_FIXTURE, UNLISTED_FEATURED_FIXTURE]),
    featuredUnion: (key) => actual.featuredUnion(key)
      ?? (key === FEATURED_FIXTURE.key || key === FEATURED_FIXTURE.catalogKey ? FEATURED_FIXTURE : null)
      ?? (key === UNLISTED_FEATURED_FIXTURE.key ? UNLISTED_FEATURED_FIXTURE : null),
  };
}
