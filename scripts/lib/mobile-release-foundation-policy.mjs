import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { MOBILE_APP_LINK_DOMAINS, verifyMobileAppLinkArtifacts } from "./mobile-app-link-policy.mjs";
import { deniedTokensIn, digestSet } from "./denied-identity.mjs";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const AUTHORIZATION_ID_PATTERN = /^[A-Z0-9][A-Z0-9._:-]{5,127}$/;
const MAX_AUTHORIZATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

function exactKeys(value, expected, label) {
  assert.equal(typeof value, "object", `${label} must be an object`);
  assert.ok(value !== null && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has an unknown or missing field`);
}

// The native release identity. config/mobile-release-foundation.json carries
// placeholder defaults (an org.example application id, no Expo owner, no EAS
// project); whoever runs a release sets their own, either in that file or as
// the environment/repository variables MOBILE_APPLICATION_ID, EXPO_OWNER and
// EAS_PROJECT_ID (docs/contracts/mobile-release.md). apps/mobile/app.config.ts
// applies the same rules. A store build needs all three set to real values.
export const MOBILE_NATIVE_SCHEME = "unionground";
export const APPLICATION_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
export const EXPO_OWNER_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
export const EAS_PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PLACEHOLDER_APPLICATION_ID_PATTERN = /^(?:org|com|net)\.example\./;

function identityValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function assertIdentityShape({ applicationId, expoOwner, easProjectId }, label) {
  assert.match(applicationId, APPLICATION_ID_PATTERN, `${label} application id must be a reverse-DNS identifier`);
  if (expoOwner) assert.match(expoOwner, EXPO_OWNER_PATTERN, `${label} Expo owner is not an Expo account name`);
  if (easProjectId) assert.match(easProjectId, EAS_PROJECT_ID_PATTERN, `${label} EAS project ID must be a lowercase UUID`);
}

// The identity a release uses: each environment value, when set, replaces the
// source default. `configured` is true only when an Expo owner and EAS project
// are set and the application id is not the example placeholder.
export function resolveMobileReleaseIdentity(policy, env = process.env) {
  const identity = {
    applicationId: identityValue(env.MOBILE_APPLICATION_ID) || policy.applicationId,
    expoOwner: identityValue(env.EXPO_OWNER) || policy.expoOwner,
    easProjectId: identityValue(env.EAS_PROJECT_ID) || policy.easProjectId,
  };
  assertIdentityShape(identity, "release");
  return {
    ...identity,
    configured: Boolean(identity.expoOwner && identity.easProjectId
      && !PLACEHOLDER_APPLICATION_ID_PATTERN.test(identity.applicationId)),
  };
}

function approvedSampleOrigin(sampleBackend) {
  return sampleBackend.sampleSupabaseOrigin.trim()
    || `https://${sampleBackend.sampleSupabaseRef.trim()}.supabase.co`;
}

// The Supabase redirect allow list follows config/sample-backend.json, the one
// provider source. With no provisioned backend it must be empty; once the owner
// pins a dedicated project, exactly that project and its portal may appear.
function expectedSupabaseRedirects(sampleBackend) {
  const ref = sampleBackend.sampleSupabaseRef.trim();
  if (!ref) return {};
  const portal = sampleBackend.samplePortalOrigin.trim();
  return {
    sample: {
      projectRef: ref,
      siteUrl: portal,
      redirectUrls: [`${portal}/**`, `${MOBILE_NATIVE_SCHEME}://auth/callback`],
    },
  };
}

function resolvedEasProfileValue(easConfig, profileName, key, seen = new Set()) {
  assert.equal(typeof profileName, "string", "EAS profile name must be a string");
  assert.ok(!seen.has(profileName), `EAS profile ${profileName} has a cyclic extends chain`);
  seen.add(profileName);
  const profile = easConfig.build?.[profileName];
  assert.equal(typeof profile, "object", `EAS profile ${profileName} is missing`);
  assert.ok(profile !== null && !Array.isArray(profile), `EAS profile ${profileName} is missing`);
  if (Object.prototype.hasOwnProperty.call(profile, key)) {
    return profile[key];
  }
  if (typeof profile.extends === "string") {
    return resolvedEasProfileValue(easConfig, profile.extends, key, seen);
  }
  return undefined;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Every source-approved build scope, in order. A scope only makes a build
// dispatchable; each build still needs its own written authorization
// (docs/contracts/mobile-release.md). The simulator build never reaches a
// store. The store build is the only scope the release workflow may upload,
// and only through a separate submit dispatch.
const REVIEWED_BUILD_SCOPES = Object.freeze([
  {
    platform: "ios",
    profile: "ci-ios-simulator",
    distributionTarget: "ios-simulator-internal",
    buildCount: 1,
    requiresPaidUsageAuthorization: true,
    allowedCredentialActions: [],
    allowedVersionCounterActions: ["none"],
  },
  {
    platform: "ios",
    profile: "production",
    distributionTarget: "app-store-connect",
    buildCount: 1,
    requiresPaidUsageAuthorization: true,
    allowedCredentialActions: [],
    allowedVersionCounterActions: ["increment"],
  },
]);

const REVIEWED_EAS_PROFILES = Object.freeze({
  "ci-ios-simulator": {
    extends: "preview",
    environment: "preview",
    channel: "ci-ios-simulator",
    autoIncrement: false,
    env: { MOBILE_BUILD_PROFILE: "ci-ios-simulator" },
    ios: { simulator: true },
  },
  production: {
    distribution: "store",
    environment: "production",
    // Each profile reads only its own over-the-air update channel.
    channel: "production",
    autoIncrement: true,
    env: {
      MOBILE_BUILD_PROFILE: "production",
      MOBILE_RELEASE_ENV: "production",
      EXPO_PUBLIC_PREVIEW_ENABLED: "1",
    },
  },
});

export function validateMobileReleaseFoundationPolicy(policy, { sampleBackend, easConfig } = {}) {
  exactKeys(policy, [
    "schemaVersion",
    "applicationId",
    "expoOwner",
    "easProjectId",
    "supabaseRedirects",
    "protectedBuildScopes",
  ], "mobile release-foundation policy");
  assert.equal(policy.schemaVersion, 1, "mobile release-foundation schemaVersion must be 1");
  for (const key of ["applicationId", "expoOwner", "easProjectId"]) {
    assert.equal(typeof policy[key], "string", `mobile release-foundation ${key} must be a string`);
  }
  assertIdentityShape(policy, "mobile release-foundation");

  assert.equal(typeof policy.supabaseRedirects, "object", "Supabase redirect policy must be an object");
  assert.ok(policy.supabaseRedirects !== null && !Array.isArray(policy.supabaseRedirects), "Supabase redirect policy must be an object");
  for (const [name, entry] of Object.entries(policy.supabaseRedirects)) {
    exactKeys(entry, ["projectRef", "siteUrl", "redirectUrls"], `Supabase redirect policy ${name}`);
    assert.ok(Array.isArray(entry.redirectUrls) && entry.redirectUrls.every((url) => typeof url === "string"),
      `Supabase redirect policy ${name} redirectUrls must be strings`);
  }

  assert.ok(Array.isArray(policy.protectedBuildScopes), "protectedBuildScopes must be an array");
  assert.equal(
    policy.protectedBuildScopes.length,
    REVIEWED_BUILD_SCOPES.length,
    "protected build scopes must change only through reviewed policy",
  );
  policy.protectedBuildScopes.forEach((scope, index) => {
    exactKeys(scope, [
      "platform",
      "profile",
      "distributionTarget",
      "buildCount",
      "requiresPaidUsageAuthorization",
      "allowedCredentialActions",
      "allowedVersionCounterActions",
    ], "protected build scope");
    assert.deepEqual(scope, REVIEWED_BUILD_SCOPES[index], `protected ${scope.platform} ${scope.profile} build scope drifted`);
  });

  if (sampleBackend) {
    assert.deepEqual(
      deniedTokensIn(JSON.stringify(policy.supabaseRedirects).toLowerCase(), digestSet(sampleBackend.forbiddenSupabaseRefSha256)),
      [],
      "Supabase redirect policy names a forbidden sibling project",
    );
    assert.deepEqual(policy.supabaseRedirects, expectedSupabaseRedirects(sampleBackend),
      "Supabase redirect policy drifted from config/sample-backend.json");
    if (sampleBackend.sampleSupabaseRef.trim()) {
      assert.equal(
        approvedSampleOrigin(sampleBackend),
        `https://${policy.supabaseRedirects.sample.projectRef}.supabase.co`,
        "SAMPLE Supabase origin drifted",
      );
    }
  }

  if (easConfig) {
    assert.equal(easConfig.cli?.requireCommit, true, "EAS builds must require a commit");
    assert.equal(easConfig.cli?.appVersionSource, "remote", "EAS build versions must use the controlled remote source");
    for (const scope of policy.protectedBuildScopes) {
      const counterActions = scope.allowedVersionCounterActions;
      if (counterActions.includes("none") && !counterActions.includes("increment")) {
        assert.equal(
          resolvedEasProfileValue(easConfig, scope.profile, "autoIncrement"),
          false,
          "protected EAS profile must not auto-increment when the approved scope only allows versionCounterAction none",
        );
      }
      if (counterActions.includes("increment") && !counterActions.includes("none")) {
        assert.equal(
          resolvedEasProfileValue(easConfig, scope.profile, "autoIncrement"),
          true,
          "protected EAS store profile must auto-increment when the approved scope only allows versionCounterAction increment",
        );
      }
      assert.deepEqual(easConfig.build?.[scope.profile], REVIEWED_EAS_PROFILES[scope.profile], "protected EAS profile drifted");
    }
    assert.doesNotMatch(
      JSON.stringify(easConfig),
      /EXPO_TOKEN|SERVICE_ROLE|PRIVATE_KEY|APNS_|FCM_SERVICE_ACCOUNT|SUPABASE_(?:URL|PUBLISHABLE_KEY)/,
      "eas.json must not carry credentials or backend values",
    );
  }
  return policy;
}

export function verifyMobileReleaseFoundationPolicy() {
  const policy = validateMobileReleaseFoundationPolicy(
    readJson("config/mobile-release-foundation.json"),
    {
      sampleBackend: readJson("config/sample-backend.json"),
      easConfig: readJson("apps/mobile/eas.json"),
    },
  );
  const appLinks = verifyMobileAppLinkArtifacts();
  assert.equal(appLinks.applicationId, policy.applicationId, "app-link application identifier drifted from release policy");
  assert.deepEqual(appLinks.domains, [...MOBILE_APP_LINK_DOMAINS], "app-link domains drifted from release policy");
  return policy;
}

export function validateReleaseAuthorizationManifest(manifest, {
  expectedSha,
  expectedPlatform,
  expectedProfile,
  now = new Date(),
  policy,
} = {}) {
  exactKeys(manifest, [
    "schemaVersion",
    "authorizationId",
    "mode",
    "sourceSha",
    "platform",
    "profile",
    "buildCount",
    "paidUsageAuthorized",
    "credentialActions",
    "versionCounterAction",
    "distributionTarget",
    "issuedAt",
    "expiresAt",
  ], "mobile release authorization");
  assert.equal(manifest.schemaVersion, 1, "release authorization schemaVersion must be 1");
  assert.match(manifest.authorizationId, AUTHORIZATION_ID_PATTERN, "release authorization ID is invalid");
  assert.ok(["sole-owner", "two-person"].includes(manifest.mode), "release authorization mode is invalid");
  assert.match(manifest.sourceSha, SHA_PATTERN, "release authorization sourceSha must be an exact lowercase commit SHA");
  assert.equal(manifest.sourceSha, expectedSha, "release authorization does not cover the requested source SHA");
  assert.equal(manifest.platform, expectedPlatform, "release authorization does not cover the requested platform");
  assert.equal(manifest.profile, expectedProfile, "release authorization does not cover the requested profile");

  const effectivePolicy = policy ?? verifyMobileReleaseFoundationPolicy();
  const scope = effectivePolicy.protectedBuildScopes.find(
    (entry) => entry.platform === expectedPlatform && entry.profile === expectedProfile,
  );
  assert.ok(scope, "requested build scope is not source-approved");
  assert.equal(manifest.buildCount, scope.buildCount, "release authorization build count exceeds the approved scope");
  assert.equal(manifest.distributionTarget, scope.distributionTarget, "release authorization distribution target drifted");
  assert.deepEqual(manifest.credentialActions, scope.allowedCredentialActions, "release authorization requests an unapproved credential action");
  assert.ok(scope.allowedVersionCounterActions.includes(manifest.versionCounterAction), "release authorization requests an unapproved version-counter action");
  if (scope.requiresPaidUsageAuthorization) {
    assert.equal(manifest.paidUsageAuthorized, true, "possible paid build usage requires explicit authorization");
  } else {
    assert.equal(typeof manifest.paidUsageAuthorized, "boolean", "paidUsageAuthorized must be explicit");
  }

  const issuedAt = new Date(manifest.issuedAt);
  const expiresAt = new Date(manifest.expiresAt);
  assert.ok(Number.isFinite(issuedAt.valueOf()), "release authorization issuedAt is invalid");
  assert.ok(Number.isFinite(expiresAt.valueOf()), "release authorization expiresAt is invalid");
  assert.ok(expiresAt > issuedAt, "release authorization must expire after it is issued");
  assert.ok(expiresAt.valueOf() - issuedAt.valueOf() <= MAX_AUTHORIZATION_WINDOW_MS, "release authorization window must not exceed seven days");
  assert.ok(now >= issuedAt && now <= expiresAt, "release authorization is not currently valid");
  return manifest;
}
