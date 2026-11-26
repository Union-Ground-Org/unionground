#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  sha256Hex,
  validateReleaseAuthorizationManifest,
  verifyMobileReleaseFoundationPolicy,
} from "./lib/mobile-release-foundation-policy.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function outsideRepository(pathname) {
  const rel = relative(repositoryRoot, pathname);
  return rel.startsWith("..") || isAbsolute(rel);
}

function exactCheckoutSha() {
  const sha = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync(
    "git",
    ["-C", repositoryRoot, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8" },
  ).trim();
  if (dirty) fail("release preflight requires a clean checkout");
  return sha;
}

try {
  const policy = verifyMobileReleaseFoundationPolicy();
  const manifestInput = argument("--authorization-manifest");
  const digest = argument("--authorization-sha256");
  const expectedSha = argument("--expected-sha");
  const platform = argument("--platform");
  const profile = argument("--profile");
  const authorizationRequested = [manifestInput, digest, expectedSha, platform, profile].some(Boolean);

  if (!authorizationRequested) {
    console.log("Verified fail-closed mobile release-foundation policy; no build authorization was inferred.");
    process.exit(0);
  }
  if (![manifestInput, digest, expectedSha, platform, profile].every(Boolean)) {
    fail("authorized preflight requires manifest, digest, expected SHA, platform, and profile together");
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) fail("authorization SHA-256 digest is invalid");
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) fail("expected SHA must be an exact lowercase commit SHA");

  const manifestPath = realpathSync(resolve(manifestInput));
  if (!outsideRepository(manifestPath)) fail("the authorization manifest must live outside the repository");
  const bytes = readFileSync(manifestPath);
  if (sha256Hex(bytes) !== digest) fail("authorization manifest checksum mismatch");
  if (exactCheckoutSha() !== expectedSha) fail("expected SHA does not match the executing checkout");
  execFileSync("git", ["-C", repositoryRoot, "merge-base", "--is-ancestor", expectedSha, "origin/main"]);

  const manifest = validateReleaseAuthorizationManifest(JSON.parse(bytes.toString("utf8")), {
    expectedSha,
    expectedPlatform: platform,
    expectedProfile: profile,
    policy,
  });
  console.log(`Verified ${manifest.authorizationId} for one ${platform}/${profile} build at ${expectedSha}.`);
} catch (error) {
  fail(error?.message ?? String(error));
}
