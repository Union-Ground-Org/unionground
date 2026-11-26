import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// The native application id in source: config/mobile-release-foundation.json
// (a placeholder until a self-hoster sets their own; apps/mobile/app.config.ts
// reads the same file). The app-link documents are published from
// config/mobile-app-links.json and must name this same id. The app-link domains
// mirror apps/mobile/src/lib/appLinkHosts.ts: none until a dedicated domain is
// approved, so the association documents stay fail closed. A sibling product's
// host, app or signing identity is never accepted here.
export function mobileApplicationId() {
  return readJson("config/mobile-release-foundation.json").applicationId;
}
export const MOBILE_APP_LINK_DOMAINS = Object.freeze([]);

// Vercel serves an existing static file before evaluating rewrites, so neither
// association path may exist as a file: the rewrite to the generated document
// must win. Union Ground publishes no credential (password autofill or
// passkey) association; store-account, passkey and SSO sign-in are left out.
export const ASSOCIATION_ROUTES = [
  { path: "/.well-known/apple-app-site-association", file: "apple-app-site-association.json" },
  { path: "/.well-known/assetlinks.json", file: "assetlinks.json" },
];

export function expectedAssociationRewrites() {
  return ASSOCIATION_ROUTES.map(({ path, file }) => ({ source: path, destination: `/native-links/${file}` }));
}

const appleAppIDPattern = /^[A-Z0-9]{10}\.[a-zA-Z0-9.-]+$/;
const androidFingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

export function validateMobileAppLinkPolicy(policy) {
  assert.equal(typeof policy, "object", "mobile app-link policy must be an object");
  assert.deepEqual(
    Object.keys(policy).sort(),
    ["androidCertFingerprints", "appleAppIDs", "applicationId", "domains", "enabled"].sort(),
    "mobile app-link policy has an unknown or missing field",
  );
  const applicationId = mobileApplicationId();
  assert.equal(policy.applicationId, applicationId, "mobile app-link policy applicationId drifted");
  assert.deepEqual(policy.domains, MOBILE_APP_LINK_DOMAINS, "mobile app-link domains must stay exact and ordered");
  assert.equal(typeof policy.enabled, "boolean", "mobile app-link enabled must be boolean");
  assert.ok(Array.isArray(policy.appleAppIDs), "mobile app-link appleAppIDs must be an array");
  assert.ok(Array.isArray(policy.androidCertFingerprints), "mobile app-link Android fingerprints must be an array");
  assert.ok(policy.domains.every((domain) => typeof domain === "string"), "mobile app-link domains must be strings");

  for (const appID of policy.appleAppIDs) {
    assert.match(appID, appleAppIDPattern, `invalid Apple application identifier: ${appID}`);
    assert.ok(appID.endsWith(`.${applicationId}`), `Apple application identifier must end in .${applicationId}`);
  }
  for (const fingerprint of policy.androidCertFingerprints) {
    assert.match(fingerprint, androidFingerprintPattern, `invalid uppercase Android SHA-256 fingerprint: ${fingerprint}`);
  }
  assert.equal(new Set(policy.appleAppIDs).size, policy.appleAppIDs.length, "Apple application identifiers must be unique");
  assert.equal(new Set(policy.androidCertFingerprints).size, policy.androidCertFingerprints.length, "Android fingerprints must be unique");

  if (policy.enabled) {
    assert.ok(policy.appleAppIDs.length > 0, "enabled app links require an approved Apple application identifier");
    assert.ok(policy.androidCertFingerprints.length > 0, "enabled app links require an approved Android signing fingerprint");
  } else {
    assert.deepEqual(policy.appleAppIDs, [], "disabled app links must not publish an Apple identity");
    assert.deepEqual(policy.androidCertFingerprints, [], "disabled app links must not publish an Android identity");
  }
  return policy;
}

export function expectedAssociationDocuments(policy) {
  validateMobileAppLinkPolicy(policy);
  return {
    apple: {
      applinks: {
        details: policy.enabled ? [{
          appIDs: policy.appleAppIDs,
          components: [{ "/": "/app/*", comment: "Union Ground native routes only" }],
        }] : [],
      },
    },
    android: policy.enabled ? [{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: policy.applicationId,
        sha256_cert_fingerprints: [...new Set(policy.androidCertFingerprints)],
      },
    }] : [],
  };
}

export function verifyMobileAppLinkArtifacts({ root = "public", includeVercel = true } = {}) {
  const policy = validateMobileAppLinkPolicy(readJson("config/mobile-app-links.json"));
  const expected = expectedAssociationDocuments(policy);
  assert.deepEqual(readJson(`${root}/native-links/apple-app-site-association.json`), expected.apple, `${root} AASA does not match the source policy`);
  assert.deepEqual(readJson(`${root}/native-links/assetlinks.json`), expected.android, `${root} assetlinks.json does not match the source policy`);
  assert.equal(existsSync(resolve(process.cwd(), `${root}/native-credentials`)), false,
    `${root}/native-credentials must not exist: Union Ground publishes no credential association`);
  for (const { path } of ASSOCIATION_ROUTES) {
    assert.equal(existsSync(resolve(process.cwd(), `${root}${path}`)), false,
      `${root}${path} must not exist as a static file; it would be served before the association rewrite`);
  }

  if (includeVercel) {
    const vercel = readJson("vercel.json");
    const rewrites = expectedAssociationRewrites();
    assert.deepEqual(vercel.rewrites.slice(0, rewrites.length), rewrites,
      "association rewrites must lead the rewrite list");
    for (const { path } of ASSOCIATION_ROUTES) {
      assert.equal(vercel.redirects.some((entry) => entry.source === path), false, `${path} must never redirect`);
      assert.equal(vercel.rewrites.filter((entry) => entry.source === path).length, 1, `${path} permits only its exact association rewrite`);
      const headerRule = vercel.headers.find((entry) => entry.source === path && !entry.has && !entry.missing);
      assert.ok(headerRule, `${path} needs an unconditional exact header rule`);
      const headers = Object.fromEntries(headerRule.headers.map(({ key, value }) => [key.toLowerCase(), value]));
      assert.equal(headers["content-type"], "application/json; charset=utf-8", `${path} must be JSON`);
      assert.equal(headers["x-content-type-options"], "nosniff", `${path} must disable MIME sniffing`);
    }
  }
  return policy;
}
