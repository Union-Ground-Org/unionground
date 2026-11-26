// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import {
  RELEASE_ENVIRONMENT,
  STORE_UPLOAD_MARKER,
  STORE_WHAT_TO_TEST,
  authorizationReceiptName,
  validateAuthorizationUnused,
  validateDispatch,
  validateEasBuild,
  validateEnvironment,
  releaseIdentity,
  validateIdentity,
  validateStoreRhythm,
} from "../scripts/verify-mobile-ios-eas-dispatch.mjs";
import { sha256Hex, verifyMobileReleaseFoundationPolicy } from "../scripts/lib/mobile-release-foundation-policy.mjs";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

// The hand-dispatched iOS release workflow and its gate
// (docs/contracts/mobile-release.md).

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflowSource = read(".github/workflows/mobile-ios-eas.yml");
const workflow = (() => {
  const document = parseDocument(workflowSource);
  expect(document.errors).toEqual([]);
  return document.toJS();
})();
const easConfig = JSON.parse(read("apps/mobile/eas.json"));
const policy = verifyMobileReleaseFoundationPolicy();

// A fictional self-hosted release identity, as the repository variables set it.
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER = "tamarack-organizing";
const APPLICATION_ID = "org.tamarack.organizing";
const identityEnv = { EXPO_OWNER: OWNER, EAS_PROJECT_ID: PROJECT_ID, MOBILE_APPLICATION_ID: APPLICATION_ID };
const identity = releaseIdentity(policy, identityEnv);
const sha = "a".repeat(40);
const buildId = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const now = new Date("2026-09-01T16:00:00.000Z");
const withAscAppId = { ...easConfig, submit: { production: { ios: { ascAppId: "1234567890" } } } };

function manifest(overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    authorizationId: "MOBILE-REL-2026-09-01-01",
    mode: "sole-owner",
    sourceSha: sha,
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
  });
}
const storeManifest = manifest({ profile: "production", distributionTarget: "app-store-connect", versionCounterAction: "increment" });

function dispatch(overrides = {}) {
  const authorizationManifest = overrides.authorizationManifest ?? manifest();
  return validateDispatch({
    expectedSha: sha,
    eventSha: sha,
    ref: "refs/heads/main",
    defaultBranch: "main",
    operation: "build",
    profile: "ci-ios-simulator",
    buildId: "",
    authorizationManifest,
    authorizationDigest: sha256Hex(Buffer.from(authorizationManifest)),
    easConfig,
    policy,
    now,
    ...overrides,
  });
}
const submit = (overrides = {}) => dispatch({
  operation: "submit", profile: "production", buildId, authorizationManifest: storeManifest, easConfig: withAscAppId, ...overrides,
});

function easBuild(overrides = {}) {
  return {
    id: buildId,
    status: "FINISHED",
    platform: "IOS",
    distribution: "STORE",
    buildProfile: "production",
    appIdentifier: APPLICATION_ID,
    gitCommitHash: sha,
    app: { id: PROJECT_ID, ownerAccount: { name: OWNER } },
    ...overrides,
  };
}

describe("mobile-ios-eas.yml", () => {
  const { attest } = workflow.jobs;
  const build = workflow.jobs["ios-build"];
  const upload = workflow.jobs["ios-submit"];
  const steps = (job) => job.steps ?? [];
  const step = (job, name) => steps(job).find((entry) => entry.name === name);

  it("runs only when dispatched by hand, on GitHub's standard runner, with SHA-pinned actions", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const { inputs } = workflow.on.workflow_dispatch;
    expect(inputs.operation).toMatchObject({ type: "choice", options: ["build", "submit"], default: "build" });
    expect(inputs.profile).toMatchObject({ type: "choice", options: ["ci-ios-simulator", "production"] });
    expect(inputs.authorization_manifest).toMatchObject({ required: true, type: "string" });
    expect(inputs.authorization_sha256).toMatchObject({ required: true, type: "string" });
    expect(workflow.permissions).toEqual({ actions: "read", contents: "read", deployments: "read" });
    expect(workflow.concurrency).toEqual({
      group: "mobile-ios-eas-${{ inputs.operation == 'submit' && 'store-upload' || inputs.authorization_sha256 }}",
      "cancel-in-progress": false,
    });
    for (const job of Object.values(workflow.jobs)) {
      expect(job["runs-on"]).toBe("ubuntu-24.04");
      for (const entry of steps(job)) {
        if (entry.uses) expect(entry.uses).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
        if (entry.uses?.startsWith("actions/checkout@")) expect(entry.with["persist-credentials"]).toBe(false);
      }
    }
  });

  it("attests the dispatch with no secret and no environment, and spends a build authorization once", () => {
    expect(attest.environment).toBeUndefined();
    expect(JSON.stringify(attest)).not.toContain("secrets.");
    const provenance = steps(attest).find((entry) => entry.id === "provenance");
    expect(provenance.run).toBe("node scripts/verify-mobile-ios-eas-dispatch.mjs");
    expect(provenance.env).toMatchObject({
      EXPECTED_SHA: "${{ inputs.commit_sha }}",
      RELEASE_OPERATION: "${{ inputs.operation }}",
      RELEASE_PROFILE: "${{ inputs.profile }}",
      RELEASE_BUILD_ID: "${{ inputs.build_id }}",
      GITHUB_TOKEN: "${{ github.token }}",
      RELEASE_AUTHORIZATION_MANIFEST: "${{ inputs.authorization_manifest }}",
      RELEASE_AUTHORIZATION_SHA256: "${{ inputs.authorization_sha256 }}",
    });
    const reservation = step(attest, "Reserve single-use release authorization");
    expect(reservation.if).toBe("steps.provenance.outputs.operation == 'build'");
    expect(reservation.with).toMatchObject({
      name: "mobile-release-authorization-${{ inputs.authorization_sha256 }}",
      path: "${{ steps.provenance.outputs.authorization_receipt }}",
      "retention-days": 14,
    });
  });

  it("never puts an input straight into a shell script", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const entry of steps(job)) {
        if (entry.run) expect(entry.run, entry.name).not.toContain("${{");
      }
    }
  });

  it("keeps building apart from uploading", () => {
    expect(build.needs).toBe("attest");
    expect(build.if).toBe("needs.attest.outputs.operation == 'build'");
    expect(upload.needs).toBe("attest");
    expect(upload.if).toBe("needs.attest.outputs.operation == 'submit' && needs.attest.outputs.profile == 'production'");
    const buildStep = step(build, "Build the iOS application on EAS without submitting it");
    expect(buildStep.run.trim().split("\n").at(-1)).toBe(
      '"$RUNNER_TEMP/eas-cli/node_modules/.bin/eas" build --platform ios --profile "$RELEASE_PROFILE" --non-interactive --freeze-credentials --wait --json > "$RUNNER_TEMP/eas-build.json"',
    );
    // No job but the submit job can reach a store.
    const buildText = JSON.stringify(build);
    expect(buildText).not.toMatch(/\bsubmit\b|auto-submit| -s\b|--latest/);
    expect(JSON.stringify(attest)).not.toMatch(/eas-cli|\.bin\/eas/);
    const uploadText = JSON.stringify(upload);
    expect(uploadText).not.toMatch(/ eas" build |auto-submit|--latest|--path|--url/);
    expect(step(build, "Verify the finished build").run).toBe(
      'node ../../scripts/verify-mobile-ios-eas-dispatch.mjs --check-build "$RUNNER_TEMP/eas-build.json" --profile "$RELEASE_PROFILE" --sha "$RELEASE_SHA"',
    );
  });

  it("uploads one verified store build, after the 7-day rhythm check, with one general line", () => {
    const names = steps(upload).map((entry) => entry.name).filter(Boolean);
    const order = ["Read the store build to upload", "Verify the store build", "Keep the 7-day store rhythm", "Record this store upload",
      "Upload the store build to App Store Connect"];
    expect(order.map((name) => names.indexOf(name))).toEqual([...order.map((name) => names.indexOf(name))].sort((a, b) => a - b));
    expect(step(upload, "Verify the store build").run).toContain("--check-build \"$RUNNER_TEMP/store-build.json\" --profile production --sha \"$RELEASE_SHA\"");
    expect(step(upload, "Keep the 7-day store rhythm").env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
    expect(step(upload, "Record this store upload").with).toMatchObject({ name: STORE_UPLOAD_MARKER, "retention-days": 14 });
    expect(step(upload, "Upload the store build to App Store Connect").run.trim().split("\n").at(-1)).toBe(
      `"$RUNNER_TEMP/eas-cli/node_modules/.bin/eas" submit --platform ios --profile production --id "$RELEASE_BUILD_ID" --what-to-test "${STORE_WHAT_TO_TEST}" --no-auto-testflight-setup --non-interactive --wait`,
    );
  });

  it("takes the release identity from the repository variables and skips cleanly without them", () => {
    const configured = "vars.EXPO_OWNER != '' && vars.EAS_PROJECT_ID != '' && vars.MOBILE_APPLICATION_ID != ''";
    expect(attest.if).toBe(configured);
    const notConfigured = workflow.jobs["not-configured"];
    expect(notConfigured.if).toBe("vars.EXPO_OWNER == '' || vars.EAS_PROJECT_ID == '' || vars.MOBILE_APPLICATION_ID == ''");
    expect(JSON.stringify(notConfigured)).not.toMatch(/secrets\.|eas-cli|environment/);
    expect(steps(attest).find((entry) => entry.id === "provenance").env).toMatchObject({
      EXPO_OWNER: "${{ vars.EXPO_OWNER }}",
      EAS_PROJECT_ID: "${{ vars.EAS_PROJECT_ID }}",
      MOBILE_APPLICATION_ID: "${{ vars.MOBILE_APPLICATION_ID }}",
    });
    for (const job of [build, upload]) {
      expect(job.needs).toBe("attest");
      expect(job.environment).toBe(RELEASE_ENVIRONMENT);
      expect(job.env).toMatchObject({
        EAS_PROJECT_ID: "${{ needs.attest.outputs.eas_project_id }}",
        EXPO_OWNER: "${{ needs.attest.outputs.expo_owner }}",
        MOBILE_APPLICATION_ID: "${{ needs.attest.outputs.application_id }}",
      });
      expect(job.steps[0].with.ref).toBe("${{ needs.attest.outputs.sha }}");
      const check = step(job, "Require the configured EAS identity");
      expect(check.env).toEqual({
        CONFIGURED_EAS_PROJECT_ID: "${{ vars.EAS_PROJECT_ID }}",
        CONFIGURED_EXPO_OWNER: "${{ vars.EXPO_OWNER }}",
        CONFIGURED_APPLICATION_ID: "${{ vars.MOBILE_APPLICATION_ID }}",
      });
      expect(check.run).toContain('[[ -z "$EAS_PROJECT_ID" || "$EAS_PROJECT_ID" != "$CONFIGURED_EAS_PROJECT_ID" ]]');
      expect(check.run).toContain('[[ -z "$EXPO_OWNER" || "$EXPO_OWNER" != "$CONFIGURED_EXPO_OWNER" ]]');
      expect(check.run).toContain('[[ -z "$MOBILE_APPLICATION_ID" || "$MOBILE_APPLICATION_ID" != "$CONFIGURED_APPLICATION_ID" ]]');
      const install = step(job, "Install pinned EAS CLI without release credentials");
      expect(install.run).toContain(`eas-cli@${easConfig.cli.version}`);
      expect(install.env).toBeUndefined();
    }
  });

  it("gives EXPO_TOKEN only to the steps that talk to EAS", () => {
    const carriers = Object.entries(workflow.jobs).flatMap(([id, job]) => steps(job)
      .filter((entry) => JSON.stringify(entry).includes("secrets."))
      .map((entry) => `${id}: ${entry.name}`));
    expect(carriers).toEqual([
      "ios-build: Build the iOS application on EAS without submitting it",
      "ios-submit: Read the store build to upload",
      "ios-submit: Upload the store build to App Store Connect",
    ]);
    expect([...new Set(workflowSource.match(/secrets\.[A-Za-z0-9_]+/g))]).toEqual(["secrets.EXPO_TOKEN"]);
    for (const job of [build, upload]) {
      expect(job.env.EXPO_TOKEN).toBeUndefined();
      for (const entry of steps(job).filter((candidate) => candidate.env?.EXPO_TOKEN)) {
        expect(entry.env).toEqual({ EXPO_TOKEN: "${{ secrets.EXPO_TOKEN }}" });
        expect(entry.run).toContain('[[ -z "$EXPO_TOKEN" ]]');
        expect(entry.run).not.toMatch(/echo[^\n]*\$EXPO_TOKEN|set -x|\bnpx\b|\bnpm\b/);
      }
    }
  });
});

describe("verify-mobile-ios-eas-dispatch", () => {
  it("accepts an exact build dispatch and an exact submit dispatch", () => {
    expect(dispatch()).toEqual([]);
    expect(dispatch({ profile: "production", authorizationManifest: storeManifest })).toEqual([]);
    expect(submit()).toEqual([]);
  });

  it.each([
    ["no authorization", { authorizationManifest: "", authorizationDigest: "" }, [/SHA-256 digest/, /written release authorization/]],
    ["a digest of other text", { authorizationDigest: sha256Hex("something else") }, [/checksum mismatch/]],
    ["an authorization for another commit", { authorizationManifest: manifest({ sourceSha: "b".repeat(40) }) }, [/source SHA/]],
    ["an expired authorization", { now: new Date("2026-09-03T00:00:00.000Z") }, [/not currently valid/]],
    ["a credential action", { authorizationManifest: manifest({ credentialActions: ["create-distribution-certificate"] }) }, [/credential action/]],
    ["a simulator authorization used for the store profile", { profile: "production" }, [/requested profile/]],
    ["a branch other than main", { ref: "refs/heads/feature" }, [/default branch/]],
    ["a commit other than the event", { eventSha: "b".repeat(40) }, [/event SHA/]],
    ["an unknown operation", { operation: "release" }, [/build or submit/]],
    ["an unreviewed profile", { profile: "staging" }, [/not a source-approved/]],
    ["a build that names a build id", { buildId }, [/takes no build_id/]],
  ])("refuses a build dispatch with %s", (_label, overrides, messages) => {
    const errors = dispatch(overrides);
    expect(errors).toHaveLength(messages.length);
    messages.forEach((message, index) => expect(errors[index]).toMatch(message));
  });

  it.each([
    ["no build to upload (submit without a build)", { buildId: "" }, [/needs the EAS build id/]],
    ["a build id that is not one", { buildId: "latest" }, [/needs the EAS build id/]],
    ["a simulator scope", { profile: "ci-ios-simulator", authorizationManifest: manifest() }, [/never reaches a store/]],
    ["no App Store Connect app id in eas.json", { easConfig }, [/ascAppId/]],
    ["no typed authorization", { authorizationManifest: "", authorizationDigest: "" }, [/SHA-256 digest/, /written release authorization/]],
  ])("refuses a submit with %s", (_label, overrides, messages) => {
    const errors = submit(overrides);
    expect(errors).toHaveLength(messages.length);
    messages.forEach((message, index) => expect(errors[index]).toMatch(message));
  });

  it("refuses a wrong Expo owner, EAS project or application id", () => {
    expect(validateIdentity(identity, identity)).toEqual([]);
    expect(validateIdentity({ ...identity, expoOwner: "someone-else" }, identity))
      .toEqual([expect.stringMatching(new RegExp(`Expo owner must be ${OWNER}`))]);
    expect(validateIdentity({ ...identity, easProjectId: "00000000-0000-4000-8000-000000000000" }, identity))
      .toEqual([expect.stringMatching(new RegExp(`EAS project must be ${PROJECT_ID}`))]);
    expect(validateIdentity({ ...identity, applicationId: "com.example.app" }, identity)).toEqual([expect.stringMatching(/application id/)]);
  });

  it("refuses a dispatch until the repository sets its own release identity", () => {
    expect(() => releaseIdentity(policy, {})).toThrow(/release identity is not configured/);
    expect(() => releaseIdentity(policy, { ...identityEnv, EXPO_OWNER: "" })).toThrow(/not configured/);
    expect(() => releaseIdentity(policy, { ...identityEnv, MOBILE_APPLICATION_ID: "" })).toThrow(/not configured/);
    expect(identity).toMatchObject({ expoOwner: OWNER, easProjectId: PROJECT_ID, applicationId: APPLICATION_ID, configured: true });
  });

  it("refuses an EAS build of another project, commit, profile or state", () => {
    const options = { expectedSha: sha, profile: "production", identity };
    expect(validateEasBuild(easBuild(), options)).toEqual([]);
    expect(validateEasBuild(easBuild({ app: { id: "00000000-0000-4000-8000-000000000000", ownerAccount: { name: "other" } } }), options))
      .toEqual([expect.stringMatching(/Expo owner/), expect.stringMatching(/EAS project/)]);
    expect(validateEasBuild(easBuild({ gitCommitHash: "b".repeat(40) }), options)).toEqual([expect.stringMatching(/commit_sha/)]);
    expect(validateEasBuild(easBuild({ buildProfile: "preview" }), options)).toEqual([expect.stringMatching(/profile preview/)]);
    expect(validateEasBuild(easBuild({ status: "ERRORED" }), options)).toEqual([expect.stringMatching(/ERRORED/)]);
    expect(validateEasBuild(easBuild({ distribution: "INTERNAL" }), options)).toEqual([expect.stringMatching(/not a store build/)]);
    expect(validateEasBuild(easBuild({ platform: "ANDROID" }), options)).toEqual([expect.stringMatching(/not an iOS build/)]);
    expect(validateEasBuild(easBuild({ buildProfile: "ci-ios-simulator", distribution: "SIMULATOR" }), {
      expectedSha: sha, profile: "ci-ios-simulator", identity,
    })).toEqual([]);
  });

  it("requires a reviewer, no administrator bypass, and main only on the release environment", () => {
    const protectedEnvironment = {
      protection_rules: [{ type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User" }] }],
      can_admins_bypass: false,
      deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    };
    expect(validateEnvironment(protectedEnvironment, [{ name: "main" }], "main")).toEqual([]);
    expect(validateEnvironment({ protection_rules: [], can_admins_bypass: true }, [{ name: "feature/*" }], "main")).toHaveLength(4);
    expect(validateEnvironment(undefined, [], "main")).toHaveLength(4);
  });

  it("makes each build authorization single-use", () => {
    const digest = "a".repeat(64);
    expect(authorizationReceiptName(digest)).toBe(`mobile-release-authorization-${digest}`);
    expect(() => validateAuthorizationUnused({ total_count: 0, artifacts: [] })).not.toThrow();
    expect(() => validateAuthorizationUnused({ total_count: 1, artifacts: [{ name: authorizationReceiptName(digest) }] }))
      .toThrow(/fresh written authorization/);
    expect(() => authorizationReceiptName("not-a-digest")).toThrow(/digest is invalid/);
  });

  it("allows at most one App Store upload in any 7 days", () => {
    const marker = (createdAt, expired = false) => ({ name: STORE_UPLOAD_MARKER, created_at: createdAt, expired });
    expect(() => validateStoreRhythm({ total_count: 0, artifacts: [] }, now)).not.toThrow();
    expect(() => validateStoreRhythm({ total_count: 1, artifacts: [marker("2026-08-25T15:59:00.000Z")] }, now)).not.toThrow();
    expect(() => validateStoreRhythm({ total_count: 1, artifacts: [marker("2026-08-28T12:00:00.000Z")] }, now))
      .toThrow(/at most one store upload in any 7 days/);
    expect(() => validateStoreRhythm({ total_count: 1, artifacts: [marker("2026-08-28T12:00:00.000Z", true)] }, now)).not.toThrow();
    expect(() => validateStoreRhythm(null, now)).toThrow(/inventory is invalid/);
  });

  it("carries none of the sibling product's account, project, application id, secret or record ids", () => {
    const ported = [
      ".github/workflows/mobile-ios-eas.yml",
      "scripts/verify-mobile-ios-eas-dispatch.mjs",
      "tests/mobile-ios-eas-dispatch.test.js",
      "docs/contracts/mobile-release.md",
    ];
    // Assembled so this file does not match itself.
    const anyCase = [
      ["union", "ground"].join(""), ["union", "base"].join(""), ["509", "dds"].join(""),
    ];
    const exactCase = [
      ["vars", "MOBILE_EAS"].join("."), ["mobile-ios", "-build"].join(""), ["refs/heads", "Main"].join("/"),
      ["origin", "Main"].join("/"), ["UG", "_"].join(""),
    ];
    const allowedSecrets = new Set(["secrets.EXPO_TOKEN", "EXPO_TOKEN", "GITHUB_TOKEN"]);
    for (const path of ported) {
      const text = read(path);
      for (const term of anyCase) expect(text.toLowerCase(), `${path} names ${term}`).not.toContain(term);
      // Supabase projects, the EAS project and account ids, by digest.
      expect(siblingIdentityIn(text), `${path} names a sibling target`).toEqual([]);
      for (const term of exactCase) expect(text, `${path} names ${term}`).not.toContain(term);
      expect(text, `${path} carries a record id`).not.toMatch(/\b(?:OPS|REQ|SEC|TEST)-[A-Z0-9]+-[A-Z0-9-]+-20\d{6}\b/);
      const secretNames = text.match(/secrets\.[A-Za-z0-9_]+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:TOKEN|SECRET|KEY)\b/g) ?? [];
      expect(secretNames.filter((name) => !allowedSecrets.has(name)), path).toEqual([]);
    }
  });
});
