import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  resolveMobileReleaseIdentity,
  sha256Hex,
  validateReleaseAuthorizationManifest,
  verifyMobileReleaseFoundationPolicy,
} from "./lib/mobile-release-foundation-policy.mjs";

// The gate for .github/workflows/mobile-ios-eas.yml (docs/contracts/mobile-release.md).
// A dispatch either builds or uploads, never both: a build dispatch takes no
// build id and the build job has no submit step; a submit dispatch uploads one
// finished store build of the authorized commit and builds nothing.

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const BUILD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export const RELEASE_OPERATIONS = Object.freeze(["build", "submit"]);
export const RELEASE_ENVIRONMENT = "mobile-ios-release";
export const STORE_UPLOAD_MARKER = "mobile-ios-store-upload";
// App Store "What's New" and TestFlight "What to test" carry one general line.
export const STORE_WHAT_TO_TEST = "General updates and improvements";

export function authorizationReceiptName(digest) {
  if (!DIGEST_PATTERN.test(digest ?? "")) throw new Error("authorization receipt digest is invalid");
  return `mobile-release-authorization-${digest}`;
}

export function validateAuthorizationUnused(artifacts) {
  if (!Number.isInteger(artifacts?.total_count) || !Array.isArray(artifacts?.artifacts)) {
    throw new Error("GitHub authorization-receipt inventory is invalid");
  }
  if (artifacts.total_count !== 0 || artifacts.artifacts.length !== 0) {
    throw new Error("release authorization was already reserved; a retry requires fresh written authorization");
  }
}

// The release identity comes from the repository variables EXPO_OWNER,
// EAS_PROJECT_ID and MOBILE_APPLICATION_ID (over the placeholder defaults in
// config/mobile-release-foundation.json). The workflow skips every job when
// they are unset; this refuses a dispatch whose identity is still incomplete.
export function releaseIdentity(policy, env = process.env) {
  const identity = resolveMobileReleaseIdentity(policy, env);
  if (!identity.configured) {
    throw new Error("the release identity is not configured: set the EXPO_OWNER, EAS_PROJECT_ID and MOBILE_APPLICATION_ID repository variables");
  }
  return identity;
}

export function validateIdentity({ expoOwner, easProjectId, applicationId }, expected) {
  const errors = [];
  if (expoOwner !== expected.expoOwner) errors.push(`Expo owner must be ${expected.expoOwner}, not ${expoOwner}`);
  if (easProjectId !== expected.easProjectId) errors.push(`EAS project must be ${expected.easProjectId}, not ${easProjectId}`);
  if (applicationId !== expected.applicationId) errors.push(`application id must be ${expected.applicationId}, not ${applicationId}`);
  return errors;
}

export function validateDispatch({
  expectedSha,
  eventSha,
  ref,
  defaultBranch,
  operation,
  profile,
  buildId = "",
  authorizationManifest,
  authorizationDigest,
  easConfig,
  policy,
  now = new Date(),
}) {
  const errors = [];
  if (!SHA_PATTERN.test(expectedSha ?? "")) {
    errors.push("commit_sha must be a lowercase 40-character Git SHA");
  }
  if (expectedSha !== eventSha) {
    errors.push("commit_sha must equal the immutable workflow event SHA");
  }
  if (ref !== `refs/heads/${defaultBranch}`) {
    errors.push("the iOS release workflow may only be dispatched from the default branch");
  }
  if (!RELEASE_OPERATIONS.includes(operation)) {
    errors.push("operation must be build or submit");
  }
  const scope = policy?.protectedBuildScopes?.find((entry) => entry.platform === "ios" && entry.profile === profile);
  if (!scope) errors.push(`profile ${profile} is not a source-approved iOS build scope`);
  if (operation === "build" && buildId) {
    errors.push("a build dispatch takes no build_id; uploading is a separate submit dispatch");
  }
  if (operation === "submit") {
    if (scope && scope.distributionTarget !== "app-store-connect") {
      errors.push(`profile ${profile} never reaches a store; only an app-store-connect authorization can submit`);
    }
    if (!BUILD_ID_PATTERN.test(buildId ?? "")) {
      errors.push("a submit needs the EAS build id of the finished store build it uploads; it never builds");
    }
    if (!/^[0-9]+$/.test(easConfig?.submit?.production?.ios?.ascAppId ?? "")) {
      errors.push("apps/mobile/eas.json needs submit.production.ios.ascAppId before a non-interactive iOS submit can run");
    }
  }
  if (!DIGEST_PATTERN.test(authorizationDigest ?? "")) {
    errors.push("authorization_sha256 must be a lowercase SHA-256 digest");
  }
  if (!authorizationManifest) {
    errors.push("the owner's written release authorization manifest is required");
  } else if (DIGEST_PATTERN.test(authorizationDigest ?? "")
    && sha256Hex(Buffer.from(authorizationManifest)) !== authorizationDigest) {
    errors.push("release authorization checksum mismatch");
  } else if (scope) {
    try {
      validateReleaseAuthorizationManifest(JSON.parse(authorizationManifest), {
        expectedSha,
        expectedPlatform: "ios",
        expectedProfile: profile,
        policy,
        now,
      });
    } catch (error) {
      errors.push(error?.message ?? String(error));
    }
  }
  return errors;
}

// The protected environment that holds EXPO_TOKEN. This repository has one
// developer, so the owner is the required reviewer of their own dispatch:
// self-review stays allowed, unlike a two-person release.
export function validateEnvironment(environment, branchPolicies, defaultBranch) {
  const errors = [];
  const reviewerRule = environment?.protection_rules?.find(
    (rule) => rule.type === "required_reviewers",
  );
  if (!reviewerRule?.reviewers?.length) {
    errors.push(`${RELEASE_ENVIRONMENT} must require at least one reviewer`);
  }
  if (environment?.can_admins_bypass !== false) {
    errors.push(`${RELEASE_ENVIRONMENT} must disable administrator bypass`);
  }
  if (
    environment?.deployment_branch_policy?.custom_branch_policies !== true ||
    environment?.deployment_branch_policy?.protected_branches !== false
  ) {
    errors.push(`${RELEASE_ENVIRONMENT} must use a custom default-branch-only policy`);
  }
  const names = (branchPolicies ?? []).map((policy) => policy.name).sort();
  if (names.length !== 1 || names[0] !== defaultBranch) {
    errors.push(`${RELEASE_ENVIRONMENT} must allow exactly the default branch`);
  }
  return errors;
}

// One build as `eas build --json` or `eas build:view --json` reports it.
export function validateEasBuild(build, { expectedSha, profile, identity, finished = true }) {
  const errors = validateIdentity({
    expoOwner: build?.app?.ownerAccount?.name,
    easProjectId: build?.app?.id,
    applicationId: build?.appIdentifier,
  }, identity);
  if (build?.platform !== "IOS") errors.push("the build is not an iOS build");
  if (build?.buildProfile !== profile) errors.push(`the build used profile ${build?.buildProfile}, not ${profile}`);
  if (build?.gitCommitHash !== expectedSha) errors.push("the build was not made from commit_sha");
  if (finished && build?.status !== "FINISHED") errors.push(`the build is ${build?.status}, not FINISHED`);
  if (profile === "production" && build?.distribution !== "STORE") errors.push("the build is not a store build");
  return errors;
}

// At most one App Store upload in any 7 days. Each submit run keeps a marker
// artifact for 14 days; an upload that failed still counts.
export function validateStoreRhythm(artifacts, now = new Date()) {
  if (!Number.isInteger(artifacts?.total_count) || !Array.isArray(artifacts?.artifacts)) {
    throw new Error("GitHub store-upload inventory is invalid");
  }
  const recent = artifacts.artifacts
    .filter((artifact) => artifact.name === STORE_UPLOAD_MARKER && !artifact.expired)
    .filter((artifact) => now.valueOf() - new Date(artifact.created_at).valueOf() < STORE_WINDOW_MS);
  if (recent.length) {
    throw new Error(`an App Store upload was reserved at ${recent[0].created_at}; at most one store upload in any 7 days`);
  }
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub verification failed with HTTP ${response.status}`);
  }
  return response.json();
}

function githubContext() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN ?? "";
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  if (!repository || !token) throw new Error("GitHub dispatch provenance inputs are incomplete");
  return { repository, token, apiUrl };
}

async function checkStoreRhythm() {
  const { repository, token, apiUrl } = githubContext();
  const artifacts = await githubJson(
    `${apiUrl}/repos/${repository}/actions/artifacts?name=${STORE_UPLOAD_MARKER}&per_page=100`,
    token,
  );
  validateStoreRhythm(artifacts);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function checkBuildFile() {
  const reported = JSON.parse(readFileSync(argument("--check-build"), "utf8"));
  const builds = Array.isArray(reported) ? reported : [reported];
  if (builds.length !== 1) throw new Error(`expected exactly one EAS build, found ${builds.length}`);
  const [build] = builds;
  const errors = validateEasBuild(build, {
    expectedSha: argument("--sha"),
    profile: argument("--profile"),
    // The build steps run in apps/mobile, so the source defaults are read
    // beside this script rather than from the working directory.
    identity: releaseIdentity(JSON.parse(readFileSync(new URL("../config/mobile-release-foundation.json", import.meta.url), "utf8"))),
  });
  if (errors.length) throw new Error(errors.join("; "));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build_id=${build.id}\n`);
  console.log(`Verified EAS build ${build.id} (${build.buildProfile}, ${build.appVersion} (${build.appBuildVersion})) at ${build.gitCommitHash}.`);
}

async function attest() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const defaultBranch = event.repository?.default_branch;
  const { repository, token, apiUrl } = githubContext();
  const expectedSha = process.env.EXPECTED_SHA ?? "";
  const operation = process.env.RELEASE_OPERATION ?? "";
  const profile = process.env.RELEASE_PROFILE ?? "";
  const buildId = process.env.RELEASE_BUILD_ID ?? "";
  const authorizationManifest = process.env.RELEASE_AUTHORIZATION_MANIFEST ?? "";
  const authorizationDigest = process.env.RELEASE_AUTHORIZATION_SHA256 ?? "";
  if (!defaultBranch) throw new Error("GitHub dispatch provenance inputs are incomplete");

  const policy = verifyMobileReleaseFoundationPolicy();
  const identity = releaseIdentity(policy);

  const dispatchErrors = validateDispatch({
    expectedSha,
    eventSha: process.env.GITHUB_SHA ?? "",
    ref: process.env.GITHUB_REF,
    defaultBranch,
    operation,
    profile,
    buildId,
    authorizationManifest,
    authorizationDigest,
    easConfig: JSON.parse(readFileSync("apps/mobile/eas.json", "utf8")),
    policy,
  });
  if (dispatchErrors.length) throw new Error(dispatchErrors.join("; "));

  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== expectedSha) {
    throw new Error("checked-out commit does not equal commit_sha");
  }
  execFileSync("git", ["merge-base", "--is-ancestor", expectedSha, `origin/${defaultBranch}`]);

  const environment = await githubJson(`${apiUrl}/repos/${repository}/environments/${RELEASE_ENVIRONMENT}`, token);
  let branchPolicies = [];
  if (environment.deployment_branch_policy?.custom_branch_policies) {
    const response = await githubJson(
      `${apiUrl}/repos/${repository}/environments/${RELEASE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
      token,
    );
    branchPolicies = response.branch_policies ?? [];
  }
  const environmentErrors = validateEnvironment(environment, branchPolicies, defaultBranch);
  if (environmentErrors.length) throw new Error(environmentErrors.join("; "));

  const output = [
    `sha=${expectedSha}`,
    `operation=${operation}`,
    `profile=${profile}`,
    `build_id=${buildId}`,
    `expo_owner=${identity.expoOwner}`,
    `eas_project_id=${identity.easProjectId}`,
    `application_id=${identity.applicationId}`,
  ];
  if (operation === "submit") {
    await checkStoreRhythm();
  } else {
    // A build spends its authorization: the receipt artifact makes it single-use.
    const artifacts = await githubJson(
      `${apiUrl}/repos/${repository}/actions/artifacts?name=${authorizationReceiptName(authorizationDigest)}&per_page=100`,
      token,
    );
    validateAuthorizationUnused(artifacts);
    const manifest = JSON.parse(authorizationManifest);
    const receiptPath = join(process.env.RUNNER_TEMP, "mobile-release-authorization-receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      authorizationId: manifest.authorizationId,
      authorizationSha256: authorizationDigest,
      sourceSha: expectedSha,
      platform: manifest.platform,
      profile: manifest.profile,
      buildCount: manifest.buildCount,
      distributionTarget: manifest.distributionTarget,
      credentialActions: manifest.credentialActions,
      versionCounterAction: manifest.versionCounterAction,
      issuedAt: manifest.issuedAt,
      expiresAt: manifest.expiresAt,
      reservedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    output.push(`authorization_receipt=${receiptPath}`);
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `${output.join("\n")}\n`);
  console.log(`Verified the ${RELEASE_ENVIRONMENT} gate for one iOS ${profile} ${operation} at ${expectedSha}.`);
}

// Marks this run's App Store upload before it starts, after the rhythm check.
async function reserveStoreUpload() {
  await checkStoreRhythm();
  const markerPath = join(process.env.RUNNER_TEMP, `${STORE_UPLOAD_MARKER}.json`);
  writeFileSync(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    sourceSha: argument("--sha"),
    buildId: argument("--build-id"),
    reservedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  appendFileSync(process.env.GITHUB_OUTPUT, `marker=${markerPath}\n`);
  console.log("No App Store upload in the last 7 days; this upload is reserved.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const run = process.argv.includes("--check-build")
    ? async () => checkBuildFile()
    : process.argv.includes("--reserve-store-upload") ? reserveStoreUpload : attest;
  run().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
