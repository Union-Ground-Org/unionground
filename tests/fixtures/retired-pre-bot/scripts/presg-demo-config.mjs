import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
// Plan resolution for the Pre Solid Ground SAMPLE demo seed.
//
// Pre Solid Ground is a FICTIONAL pre-unionization workplace: one potential
// chapter, a bargaining-unit-sized roster of employees who are organizing but
// are NOT union members, and a small organizing committee who carry the
// steward-equivalent role so the steward surfaces light up. Everything the
// seed writes lives only in the isolated SAMPLE Supabase project. The SAMPLE
// origin is the boundary; realistic fictional rows do not carry UI suffixes.
//
// The shape mirrors scripts/member-stress-config.mjs deliberately: a
// deterministic run id derived from the checked-in config, deterministic
// per-ordinal user ids and emails so the database RPCs and this driver agree
// about every synthetic identity without exchanging state.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSampleTarget, functionParity, pageDepth } from "../../../../scripts/demo-seed-contract.mjs";

const configPath = fileURLToPath(new URL("../stress/presg-demo-config.json", import.meta.url));
export const presgConfig = Object.freeze(JSON.parse(readFileSync(configPath, "utf8")));

function uuidFromHex(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function deterministicUuid(value) {
  return uuidFromHex(createHash("md5").update(value).digest("hex"));
}

export function resolvePresgPlan({ targetName = "local", profileName = "smoke" } = {}) {
  const target = presgConfig.targets[targetName];
  const profile = presgConfig.profiles[profileName];
  if (!target) throw new Error(`Unknown target: ${targetName}`);
  if (!profile) throw new Error(`Unknown profile: ${profileName}`);
  if (profile.committeeCount > profile.memberCount) throw new Error("committeeCount cannot exceed memberCount");
  if (profile.loginCount > profile.memberCount) throw new Error("loginCount cannot exceed memberCount");
  if (profile.memberCount < pageDepth.surfaces.adminMemberDirectory.minimumRows) {
    throw new Error("memberCount cannot satisfy the two-page member directory contract");
  }

  const runSeed = [
    presgConfig.datasetVersion,
    targetName,
    profile.memberCount,
    profile.committeeCount,
    profile.loginCount
  ].join(":");
  const runId = deterministicUuid(`unionground-presg-demo:run:${runSeed}`);
  const configHash = createHash("sha256")
    .update(JSON.stringify({ datasetVersion: presgConfig.datasetVersion, targetName, target, profile }))
    .digest("hex");

  return Object.freeze({ targetName, profileName, target, profile, runId, configHash });
}

export function presgUserId(runId, ordinal) {
  return deterministicUuid(`${runId}:presg:user:${ordinal}`);
}

export function presgEmail(runId, ordinal) {
  return `presg-${runId.replaceAll("-", "").slice(0, 8)}-${String(ordinal).padStart(4, "0")}@${presgConfig.emailDomain}`;
}

export function assertExactTarget(plan, suppliedUrl, options = {}) {
  const origin = assertSampleTarget({
    target: plan.target,
    actualUrl: suppliedUrl,
    targetName: plan.targetName,
    disposableConfirm: options.disposableConfirm,
  });
  const actual = new URL(origin);
  if (presgConfig.forbiddenProjectRefs.some((ref) => actual.hostname.includes(ref))) {
    throw new Error("Forbidden Supabase project");
  }
  return origin;
}

export function publicPlan(plan) {
  return {
    datasetVersion: presgConfig.datasetVersion,
    target: plan.targetName,
    projectRef: plan.target.projectRef,
    profile: plan.profileName,
    runId: plan.runId,
    configHash: plan.configHash,
    chapterId: presgConfig.chapterId,
    functionCount: functionParity.functionCount,
    pageDepthVersion: pageDepth.version,
    ...plan.profile,
    firstUserId: presgUserId(plan.runId, 1),
    firstEmail: presgEmail(plan.runId, 1),
    lastUserId: presgUserId(plan.runId, plan.profile.memberCount),
    lastEmail: presgEmail(plan.runId, plan.profile.memberCount)
  };
}
