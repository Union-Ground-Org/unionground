// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  resolveMobileReleaseIdentity,
  sha256Hex,
  validateMobileReleaseFoundationPolicy,
  validateReleaseAuthorizationManifest,
  verifyMobileReleaseFoundationPolicy,
} from "../scripts/lib/mobile-release-foundation-policy.mjs";

const easConfig = JSON.parse(
  readFileSync(new URL("../apps/mobile/eas.json", import.meta.url), "utf8"),
);

const sourceSha = "a".repeat(40);
const now = new Date("2026-09-01T16:00:00.000Z");

function authorization(overrides = {}) {
  return {
    schemaVersion: 1,
    authorizationId: "MOBILE-REL-2026-09-01-01",
    mode: "sole-owner",
    sourceSha,
    platform: "ios",
    profile: "ci-ios-simulator",
    buildCount: 1,
    paidUsageAuthorized: true,
    credentialActions: [],
    versionCounterAction: "none",
    distributionTarget: "ios-simulator-internal",
    issuedAt: "2026-09-01T15:00:00.000Z",
    expiresAt: "2026-09-02T15:00:00.000Z",
    ...overrides,
  };
}

describe("mobile release-foundation policy", () => {
  it("pins identity, origin isolation, redirect allowlists, and the protected build scope", () => {
    const policy = verifyMobileReleaseFoundationPolicy();
    // Union Ground has no provisioned backend: config/sample-backend.json
    // pins no project, so the redirect allow list is empty, and no sibling
    // product's host or URL scheme may appear in it.
    // The committed identity is a placeholder; a release sets its own.
    expect(policy).toMatchObject({ applicationId: "org.example.unionground", expoOwner: "", easProjectId: "" });
    expect(policy.supabaseRedirects).toEqual({});
    const serialized = JSON.stringify(policy);
    for (const sibling of ["sibling-product.example", "sibling-saas.example", "net.unionground", "unionbase://"]) {
      expect(serialized, sibling).not.toContain(sibling);
    }
    expect(policy.protectedBuildScopes).toEqual([
      expect.objectContaining({
        platform: "ios",
        profile: "ci-ios-simulator",
        distributionTarget: "ios-simulator-internal",
        requiresPaidUsageAuthorization: true,
        allowedCredentialActions: [],
        allowedVersionCounterActions: ["none"],
      }),
      expect.objectContaining({
        platform: "ios",
        profile: "production",
        distributionTarget: "app-store-connect",
        requiresPaidUsageAuthorization: true,
        allowedCredentialActions: [],
        allowedVersionCounterActions: ["increment"],
      }),
    ]);
  });

  it("resolves the release identity from the environment over the placeholders", () => {
    const policy = verifyMobileReleaseFoundationPolicy();
    expect(resolveMobileReleaseIdentity(policy, {})).toEqual({
      applicationId: "org.example.unionground", expoOwner: "", easProjectId: "", configured: false,
    });
    const own = {
      MOBILE_APPLICATION_ID: "org.tamarack.organizing",
      EXPO_OWNER: "tamarack-organizing",
      EAS_PROJECT_ID: "00000000-0000-4000-8000-000000000001",
    };
    expect(resolveMobileReleaseIdentity(policy, own)).toEqual({
      applicationId: "org.tamarack.organizing",
      expoOwner: "tamarack-organizing",
      easProjectId: "00000000-0000-4000-8000-000000000001",
      configured: true,
    });
    // The example application id never counts as configured.
    expect(resolveMobileReleaseIdentity(policy, { ...own, MOBILE_APPLICATION_ID: "" }).configured).toBe(false);
    expect(() => resolveMobileReleaseIdentity(policy, { ...own, MOBILE_APPLICATION_ID: "Not An Id" })).toThrow(/reverse-DNS/);
    expect(() => resolveMobileReleaseIdentity(policy, { ...own, EAS_PROJECT_ID: "project" })).toThrow(/UUID/);
    expect(() => resolveMobileReleaseIdentity(policy, { ...own, EXPO_OWNER: "Owner Name" })).toThrow(/Expo account/);
    expect(() => validateMobileReleaseFoundationPolicy({ ...policy, easProjectId: "not-a-uuid" })).toThrow(/UUID/);
  });

  it("refuses a redirect policy that names a sibling project on the digest deny list", () => {
    const policy = verifyMobileReleaseFoundationPolicy();
    const sampleBackend = JSON.parse(readFileSync(new URL("../config/sample-backend.json", import.meta.url), "utf8"));
    const named = { ...structuredClone(policy), supabaseRedirects: {
      sample: { projectRef: "productionprojectref", siteUrl: "https://app.example.org", redirectUrls: [] },
    } };
    expect(() => validateMobileReleaseFoundationPolicy(named, { sampleBackend })).toThrow(/forbidden sibling project/);
  });

  it("refuses a scope added or changed outside reviewed policy", () => {
    const policy = verifyMobileReleaseFoundationPolicy();
    const extra = structuredClone(policy);
    extra.protectedBuildScopes.push({ ...extra.protectedBuildScopes[1], platform: "android" });
    expect(() => validateMobileReleaseFoundationPolicy(extra)).toThrow(/reviewed policy/);
    const widened = structuredClone(policy);
    widened.protectedBuildScopes[1].allowedCredentialActions = ["create-distribution-certificate"];
    expect(() => validateMobileReleaseFoundationPolicy(widened)).toThrow(/production build scope drifted/);
  });

  it("keeps the store profile on the remote counter and unchanged", () => {
    const policy = verifyMobileReleaseFoundationPolicy();
    const frozen = structuredClone(easConfig);
    frozen.build.production.autoIncrement = false;
    expect(() => validateMobileReleaseFoundationPolicy(policy, { easConfig: frozen }))
      .toThrow(/must auto-increment/);
    const internal = structuredClone(easConfig);
    internal.build.production.distribution = "internal";
    expect(() => validateMobileReleaseFoundationPolicy(policy, { easConfig: internal }))
      .toThrow(/protected EAS profile drifted/);
  });

  it("accepts a store authorization only for one build that increments the counter", () => {
    const store = authorization({ profile: "production", distributionTarget: "app-store-connect", versionCounterAction: "increment" });
    const options = { expectedSha: sourceSha, expectedPlatform: "ios", expectedProfile: "production", now };
    expect(validateReleaseAuthorizationManifest(store, options)).toEqual(store);
    expect(() => validateReleaseAuthorizationManifest({ ...store, versionCounterAction: "none" }, options))
      .toThrow(/version-counter action/);
    expect(() => validateReleaseAuthorizationManifest({ ...store, distributionTarget: "ios-simulator-internal" }, options))
      .toThrow(/distribution target/);
  });

  it("accepts only an exact, current, sanitized authorization", () => {
    expect(validateReleaseAuthorizationManifest(authorization(), {
      expectedSha: sourceSha,
      expectedPlatform: "ios",
      expectedProfile: "ci-ios-simulator",
      now,
    })).toEqual(authorization());
    expect(sha256Hex(Buffer.from("authorization"))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a protected simulator profile that would increment the remote counter", () => {
    const policy = verifyMobileReleaseFoundationPolicy();
    expect(easConfig.build["ci-ios-simulator"].autoIncrement).toBe(false);

    const inherited = structuredClone(easConfig);
    delete inherited.build["ci-ios-simulator"].autoIncrement;
    expect(() => validateMobileReleaseFoundationPolicy(policy, { easConfig: inherited }))
      .toThrow(/must not auto-increment/);

    const incremented = structuredClone(easConfig);
    incremented.build["ci-ios-simulator"].autoIncrement = true;
    expect(() => validateMobileReleaseFoundationPolicy(policy, { easConfig: incremented }))
      .toThrow(/must not auto-increment/);
  });

  it.each([
    ["a different SHA", { sourceSha: "b".repeat(40) }, /source SHA/],
    ["an expired window", { expiresAt: "2026-09-01T15:30:00.000Z" }, /not currently valid/],
    ["a long-lived window", { expiresAt: "2026-09-10T15:00:00.000Z" }, /seven days/],
    ["implicit paid usage", { paidUsageAuthorized: false }, /paid build usage/],
    ["credential creation", { credentialActions: ["create-signing-key"] }, /credential action/],
    ["a counter change", { versionCounterAction: "increment" }, /version-counter action/],
    ["a second build", { buildCount: 2 }, /build count/],
    ["an unknown field", { notes: "looks harmless" }, /unknown or missing field/],
  ])("rejects %s", (_label, override, error) => {
    expect(() => validateReleaseAuthorizationManifest(authorization(override), {
      expectedSha: sourceSha,
      expectedPlatform: "ios",
      expectedProfile: "ci-ios-simulator",
      now,
    })).toThrow(error);
  });
});
