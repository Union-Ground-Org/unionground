import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("../stress/member-config.json", import.meta.url));
export const stressConfig = Object.freeze(JSON.parse(readFileSync(configPath, "utf8")));

function uuidFromHex(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function deterministicUuid(value) {
  return uuidFromHex(createHash("md5").update(value).digest("hex"));
}

export function resolveStressPlan({ targetName = "local", profileName = "smoke" } = {}) {
  const target = stressConfig.targets[targetName];
  const profile = stressConfig.profiles[profileName];
  if (!target) throw new Error(`Unknown target: ${targetName}`);
  if (!profile) throw new Error(`Unknown profile: ${profileName}`);
  if (profile.loginCount > profile.memberCount) throw new Error("loginCount cannot exceed memberCount");

  const runSeed = [stressConfig.datasetVersion, targetName, profile.memberCount, profile.loginCount].join(":");
  const runId = deterministicUuid(`unionground-member-stress:run:${runSeed}`);
  const configHash = createHash("sha256")
    .update(JSON.stringify({ datasetVersion: stressConfig.datasetVersion, targetName, target, profile }))
    .digest("hex");

  return Object.freeze({ targetName, profileName, target, profile, runId, configHash });
}

export function stressUserId(runId, ordinal) {
  return deterministicUuid(`${runId}:user:${ordinal}`);
}

export function stressEmail(runId, ordinal) {
  return `stress-${runId.replaceAll("-", "").slice(0, 8)}-${String(ordinal).padStart(6, "0")}@loadtest.example.com`;
}

export function assertExactTarget(plan, suppliedUrl) {
  if (!suppliedUrl) throw new Error("Supabase URL is required");
  const actual = new URL(suppliedUrl);
  const expected = new URL(plan.target.url);
  if (actual.username || actual.password || actual.search || actual.hash || actual.pathname !== "/") {
    throw new Error("Supabase URL must be a bare origin");
  }
  if (actual.origin !== expected.origin) {
    throw new Error(`Target mismatch: expected ${expected.origin}`);
  }
  if (stressConfig.forbiddenProjectRefs.some((ref) => actual.hostname.includes(ref))) {
    throw new Error("Forbidden legacy Supabase project");
  }
  return actual.origin;
}

export function publicPlan(plan) {
  return {
    datasetVersion: stressConfig.datasetVersion,
    target: plan.targetName,
    projectRef: plan.target.projectRef,
    profile: plan.profileName,
    runId: plan.runId,
    configHash: plan.configHash,
    ...plan.profile,
    firstUserId: stressUserId(plan.runId, 1),
    firstEmail: stressEmail(plan.runId, 1),
    lastUserId: stressUserId(plan.runId, plan.profile.memberCount),
    lastEmail: stressEmail(plan.runId, plan.profile.memberCount)
  };
}
