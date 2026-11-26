import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import * as policyModule from "../scripts/lib/mobile-app-link-policy.mjs";
import {
  ASSOCIATION_ROUTES,
  mobileApplicationId,
  expectedAssociationDocuments,
  expectedAssociationRewrites,
  validateMobileAppLinkPolicy,
  verifyMobileAppLinkArtifacts,
} from "../scripts/lib/mobile-app-link-policy.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const releaseFingerprint = "AA:".repeat(31) + "AA";
// A fictional Apple team prefix on Union Ground's own application id.
const MOBILE_APPLICATION_ID = mobileApplicationId();
const fixtureAppleAppID = `ABCDE12345.${MOBILE_APPLICATION_ID}`;

// Union Ground has no approved domain or signing identity yet, so the
// committed policy is fail closed:
// the association documents publish nothing, and no credential (password
// autofill or passkey) association exists, because store-account, passkey and
// SSO sign-in are left out.
describe("native website association policy", () => {
  it("ships the fail-closed policy and association documents derived only from it", () => {
    const policy = verifyMobileAppLinkArtifacts();

    expect(policy).toEqual({
      enabled: false,
      applicationId: "org.example.unionground",
      domains: [],
      appleAppIDs: [],
      androidCertFingerprints: [],
    });
    expect(readJson("public/native-links/apple-app-site-association.json")).toEqual(expectedAssociationDocuments(policy).apple);
    expect(readJson("public/native-links/assetlinks.json")).toEqual(expectedAssociationDocuments(policy).android);
    expect(readJson("public/native-links/apple-app-site-association.json")).toEqual({ applinks: { details: [] } });
    expect(readJson("public/native-links/assetlinks.json")).toEqual([]);
    expect(readJson("public/native-links/apple-app-site-association.json")).not.toHaveProperty("webcredentials");
    // No credential association and no dedicated QA signer.
    expect(existsSync("public/native-credentials")).toBe(false);
    expect(existsSync("config/mobile-native-qa-signers.json")).toBe(false);
    expect(policyModule).not.toHaveProperty("validateNativeQaSignerPolicy");
  });

  // Vercel serves a file that exists at the request path before it evaluates
  // rewrites, so a static /.well-known document would hide the generated one.
  it("serves the well-known paths only through the leading rewrites", () => {
    const vercel = readJson("vercel.json");
    for (const { path } of ASSOCIATION_ROUTES) expect(existsSync(`public${path}`)).toBe(false);
    expect(vercel.rewrites.slice(0, ASSOCIATION_ROUTES.length)).toEqual(expectedAssociationRewrites());
    expect(expectedAssociationRewrites()).toEqual([
      { source: "/.well-known/apple-app-site-association", destination: "/native-links/apple-app-site-association.json" },
      { source: "/.well-known/assetlinks.json", destination: "/native-links/assetlinks.json" },
    ]);
    // One rewrite per path and no host-conditioned variant: there is no
    // second product host to route a credential document to.
    for (const { path } of ASSOCIATION_ROUTES) {
      expect(vercel.rewrites.filter((entry) => entry.source === path)).toHaveLength(1);
    }
    expect(vercel.rewrites.some((entry) => entry.source.startsWith("/.well-known/") && entry.has)).toBe(false);
  });

  it("refuses a sibling product's application, domain or Apple identity", () => {
    const base = {
      enabled: true,
      applicationId: MOBILE_APPLICATION_ID,
      domains: [],
      appleAppIDs: [fixtureAppleAppID],
      androidCertFingerprints: [releaseFingerprint],
    };
    assert.doesNotThrow(() => validateMobileAppLinkPolicy(base));
    expect(() => validateMobileAppLinkPolicy({ ...base, applicationId: "org.example.storefixture" })).toThrow(/applicationId drifted/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, domains: ["sibling-saas.example"] })).toThrow(/domains must stay exact/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, domains: ["unionground.invalid"] })).toThrow(/domains must stay exact/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, appleAppIDs: ["ABCDE12345.net.sibling.app"] })).toThrow(/must end in/i);
    // A disabled policy may not publish an identity at all.
    expect(() => validateMobileAppLinkPolicy({ ...base, enabled: false })).toThrow(/disabled app links must not publish an Apple identity/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, enabled: false, appleAppIDs: [] }))
      .toThrow(/disabled app links must not publish an Android identity/i);
  });

  it("derives minimal exact documents only from approved source identities", () => {
    const policy = {
      enabled: true,
      applicationId: MOBILE_APPLICATION_ID,
      domains: [],
      appleAppIDs: [fixtureAppleAppID],
      androidCertFingerprints: [releaseFingerprint],
    };

    expect(expectedAssociationDocuments(policy)).toEqual({
      apple: {
        applinks: {
          details: [{
            appIDs: [fixtureAppleAppID],
            components: [{ "/": "/app/*", comment: "Union Ground native routes only" }],
          }],
        },
      },
      android: [{
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: MOBILE_APPLICATION_ID,
          sha256_cert_fingerprints: [releaseFingerprint],
        },
      }],
    });
    // Never a credential-sharing relation or a webcredentials block.
    const documents = expectedAssociationDocuments(policy);
    expect(documents.apple).not.toHaveProperty("webcredentials");
    expect(documents.android[0].relation).not.toContain("delegate_permission/common.get_login_creds");
  });

  it("rejects partial, malformed, and cross-application activation", () => {
    const base = {
      enabled: true,
      applicationId: MOBILE_APPLICATION_ID,
      domains: [],
      appleAppIDs: [fixtureAppleAppID],
      androidCertFingerprints: [releaseFingerprint],
    };

    expect(() => validateMobileAppLinkPolicy({ ...base, appleAppIDs: [] })).toThrow(/require an approved Apple/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, androidCertFingerprints: [] })).toThrow(/require an approved Android/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, androidCertFingerprints: [releaseFingerprint.toLowerCase()] })).toThrow(/uppercase Android/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, appleAppIDs: ["ABCDE12345.example.other"] })).toThrow(/must end in/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, applicationId: "example.other" })).toThrow(/applicationId drifted/i);
    expect(() => validateMobileAppLinkPolicy({ ...base, unexpected: true })).toThrow(/unknown or missing field/i);
    assert.doesNotThrow(() => validateMobileAppLinkPolicy(base));
  });
});

// Vitest runs with the repository root as cwd, the same place `npm run check` runs from.
const verifierScript = resolve("scripts/verify-mobile-app-links.mjs");
const syncScript = resolve("scripts/sync-mobile-app-links.mjs");
const runVerifier = (cwd, args) => spawnSync(process.execPath, [verifierScript, ...args], { cwd, encoding: "utf8" });
const runSync = (cwd) => spawnSync(process.execPath, [syncScript], { cwd, encoding: "utf8" });

describe("built-output association verification", () => {
  const fixtures = [];

  afterEach(() => {
    while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true });
  });

  it("regenerates the association documents and removes anything that would shadow or widen them", () => {
    const root = mkdtempSync(join(tmpdir(), "mobile-app-links-sync-"));
    fixtures.push(root);
    mkdirSync(join(root, "config"), { recursive: true });
    copyFileSync("config/mobile-app-links.json", join(root, "config/mobile-app-links.json"));
    copyFileSync("config/mobile-release-foundation.json", join(root, "config/mobile-release-foundation.json"));
    copyFileSync("vercel.json", join(root, "vercel.json"));

    const synced = runSync(root);
    expect(synced.status).toBe(0);
    expect(synced.stderr).toBe("");
    for (const path of ["native-links/apple-app-site-association.json", "native-links/assetlinks.json"]) {
      expect(readJson(join(root, "public", path))).toEqual(readJson(join("public", path)));
    }
    expect(runVerifier(root, []).status).toBe(0);

    // A stale static well-known document is removed rather than left to shadow the rewrites.
    mkdirSync(join(root, "public/.well-known"), { recursive: true });
    writeFileSync(join(root, "public/.well-known/assetlinks.json"), "[]\n");
    expect(runVerifier(root, []).status).not.toBe(0);
    // So is a credential association, which Union Ground never publishes.
    mkdirSync(join(root, "public/native-credentials"), { recursive: true });
    writeFileSync(join(root, "public/native-credentials/assetlinks.json"), "[]\n");
    expect(runVerifier(root, []).stderr).toMatch(/native-credentials must not exist/);
    expect(runSync(root).status).toBe(0);
    expect(existsSync(join(root, "public/.well-known/assetlinks.json"))).toBe(false);
    expect(existsSync(join(root, "public/native-credentials"))).toBe(false);
    expect(runVerifier(root, []).status).toBe(0);
  });

  // The --dist mode only protects the deployed files if the pipeline actually
  // runs it, and it has to run against the tree `npm run build` just produced:
  // nothing but other read-only verifiers may stand between them.
  it("runs the built-output check in `npm run check` right after the build", () => {
    const { scripts } = readJson("package.json");

    expect(scripts["verify:mobile-app-links:dist"]).toBe("node scripts/verify-mobile-app-links.mjs --dist");
    expect(scripts.check).toMatch(/npm run build(?: && npm run verify:[a-z0-9:-]+)* && npm run verify:mobile-app-links:dist(?: &&|$)/);
  });

  it("passes on a faithful build and fails when the built output diverges from public/", () => {
    const root = mkdtempSync(join(tmpdir(), "mobile-app-links-dist-"));
    fixtures.push(root);
    const defaults = join(root, "dist/native-links");
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(defaults, { recursive: true });
    copyFileSync("config/mobile-app-links.json", join(root, "config/mobile-app-links.json"));
    copyFileSync("config/mobile-release-foundation.json", join(root, "config/mobile-release-foundation.json"));
    copyFileSync("vercel.json", join(root, "vercel.json"));
    for (const name of ["apple-app-site-association.json", "assetlinks.json"]) {
      copyFileSync(`public/native-links/${name}`, join(defaults, name));
    }

    const faithful = runVerifier(root, ["--dist"]);
    expect(faithful.stderr).toBe("");
    expect(faithful.status).toBe(0);
    expect(faithful.stdout).toContain("fail-closed");
    expect(faithful.stdout).toContain("in dist");

    // A host-conditioned association rewrite is not the reviewed one.
    const vercel = readJson(join(root, "vercel.json"));
    const route = vercel.rewrites.find((entry) => entry.source === "/.well-known/assetlinks.json");
    route.has = [{ type: "host", value: "sibling-saas.example" }];
    writeFileSync(join(root, "vercel.json"), JSON.stringify(vercel));
    expect(runVerifier(root, ["--dist"]).status).not.toBe(0);
    copyFileSync("vercel.json", join(root, "vercel.json"));

    // Another rewrite placed first could answer the association paths.
    const reordered = readJson("vercel.json");
    reordered.rewrites = [...reordered.rewrites.slice(2, 4), ...reordered.rewrites.slice(0, 2), ...reordered.rewrites.slice(4)];
    writeFileSync(join(root, "vercel.json"), JSON.stringify(reordered));
    expect(runVerifier(root, ["--dist"]).status).not.toBe(0);
    copyFileSync("vercel.json", join(root, "vercel.json"));

    // A build that also emits a static well-known document shadows the rewrites.
    mkdirSync(join(root, "dist/.well-known"), { recursive: true });
    copyFileSync("public/native-links/assetlinks.json", join(root, "dist/.well-known/assetlinks.json"));
    const shadowed = runVerifier(root, ["--dist"]);
    expect(shadowed.status).not.toBe(0);
    expect(shadowed.stderr).toMatch(/must not exist as a static file/);
    rmSync(join(root, "dist/.well-known"), { recursive: true });

    // A build that ships a credential association.
    mkdirSync(join(root, "dist/native-credentials"), { recursive: true });
    const credentialed = runVerifier(root, ["--dist"]);
    expect(credentialed.status).not.toBe(0);
    expect(credentialed.stderr).toMatch(/native-credentials must not exist/);
    rmSync(join(root, "dist/native-credentials"), { recursive: true });

    // A build step that rewrites the association documents.
    writeFileSync(join(defaults, "assetlinks.json"), JSON.stringify([{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: MOBILE_APPLICATION_ID, sha256_cert_fingerprints: [releaseFingerprint] },
    }]));
    const corrupted = runVerifier(root, ["--dist"]);
    expect(corrupted.status).not.toBe(0);
    expect(corrupted.stderr).toMatch(/dist assetlinks\.json does not match the source policy/);

    // A publicDir exclusion or copy-step regression that drops the file.
    rmSync(join(defaults, "assetlinks.json"));

    const dropped = runVerifier(root, ["--dist"]);
    expect(dropped.status).not.toBe(0);
    expect(dropped.stderr).toMatch(/ENOENT/);
  });
});
