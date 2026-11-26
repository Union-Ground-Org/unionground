// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { FEATURED_UNIONS } from "../src/features/unionCatalog/featuredUnions.js";
import * as unionIdentity from "../src/features/unionCatalog/unionIdentity.js";
import { featuredUnionForKey, resolveUnionProfileKey, unionSetupHref } from "../src/features/unionCatalog/unionIdentity.js";

vi.mock("../src/features/unionCatalog/featuredUnions.js", async (importOriginal) => {
  const { withFeaturedUnionFixture } = await import("./helpers/featuredUnionFixture.js");
  return withFeaturedUnionFixture(await importOriginal());
});

describe("shared public union identity", () => {
  it("joins only the verified featured alias to its filer profile", () => {
    expect(resolveUnionProfileKey("test-featured-local")).toBe("olms-900000077");
    expect(unionSetupHref("test-featured-local")).toBe(unionSetupHref("olms-900000077"));
    expect(featuredUnionForKey("olms-900000077")).toBe(featuredUnionForKey("test-featured-local"));
    expect(featuredUnionForKey("olms-900000077").identitySource.fileNumber).toBe("900000077");
  });

  it("opens every filing key as an ordinary catalog entry without a featured overlay", () => {
    for (const key of ["olms-511865", "olms-15540", "olms-21694", "olms-36315", "olms-545862", "olms-137", "olms-500001"]) {
      expect(featuredUnionForKey(key)).toBeNull();
      expect(resolveUnionProfileKey(key)).toBe(key);
    }
  });

  it("features no real union in this edition (only the test fixtures)", () => {
    expect(FEATURED_UNIONS.map((union) => union.key)).toEqual(["test-featured-local", "test-unlisted-local"]);
  });

  it("keeps an unverified featured local distinct instead of guessing a filing identity", () => {
    const key = "test-unlisted-local";
    expect(resolveUnionProfileKey(key)).toBe(key);
    expect(featuredUnionForKey(key).catalogKey).toBeUndefined();
    expect(unionSetupHref(key)).toBe(`/m/admin/setup-review?union=${key}&build=chapter`);
  });

  it("carries the selected canonical identity to chapter setup", () => {
    expect(unionSetupHref("test-featured-local")).toBe("/m/admin/setup-review?union=olms-900000077&build=chapter");
    expect(unionSetupHref("olms-511865")).toBe("/m/admin/setup-review?union=olms-511865&build=chapter");
    expect(unionSetupHref("ug-0123456789")).toBe("/m/admin/setup-review?union=ug-0123456789&build=chapter");
    expect(unionSetupHref(null)).toBe("/m/admin/setup-review?build=chapter");
  });

  it.each([null, undefined, "", "509", "SEIU Local 509", "featured-seiu-509", "featured-nage-999", "olms-1;drop", "https://example.invalid/", { key: "olms-511865" }])("refuses unknown or malformed identity %j", (key) => {
    expect(resolveUnionProfileKey(key)).toBeNull();
    expect(unionSetupHref(key)).toBe("/m/admin/setup-review?build=chapter");
    expect(featuredUnionForKey(key)).toBeNull();
  });

  it("keeps every featured union resolvable to in-app campaign setup", () => {
    expect(FEATURED_UNIONS.length).toBeGreaterThan(0);
    for (const union of FEATURED_UNIONS) {
      const resolved = resolveUnionProfileKey(union.key);
      expect(featuredUnionForKey(resolved)).toBe(union);
      expect(unionSetupHref(union.key)).toBe(`/m/admin/setup-review?union=${encodeURIComponent(resolved)}&build=chapter`);
    }
  });

  it("offers no public union catalog profile link", () => {
    expect(unionIdentity).not.toHaveProperty("publicUnionProfileHref");
    for (const union of FEATURED_UNIONS) {
      expect(unionSetupHref(union.key)).not.toMatch(/^\/(unions|orgs)\b/);
    }
  });
});
