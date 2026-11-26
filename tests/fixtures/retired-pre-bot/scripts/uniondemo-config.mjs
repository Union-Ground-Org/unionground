import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
// Plan resolution for the Union Demo Org SAMPLE seed.
//
// A FICTIONAL statewide union local at real scale: 20 chapters, 30,000
// members with sign-in, 800 stewards, four years of very active history —
// seeded only into the isolated SAMPLE Supabase project. The SAMPLE origin is
// the boundary, so realistic fictional content carries no UI suffix. Rows
// derive deterministically from (run_id, ordinal), so
// the database RPCs and this driver agree about every synthetic identity
// without exchanging state.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSampleTarget, functionParity, pageDepth } from "../../../../scripts/demo-seed-contract.mjs";

const configPath = fileURLToPath(new URL("../stress/uniondemo-config.json", import.meta.url));
export const uniondemoConfig = Object.freeze(JSON.parse(readFileSync(configPath, "utf8")));

function uuidFromHex(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function deterministicUuid(value) {
  return uuidFromHex(createHash("md5").update(value).digest("hex"));
}

export function resolveUniondemoPlan({ targetName = "local", profileName = "smoke" } = {}) {
  const target = uniondemoConfig.targets[targetName];
  const profile = uniondemoConfig.profiles[profileName];
  if (!target) throw new Error(`Unknown target: ${targetName}`);
  if (!profile) throw new Error(`Unknown profile: ${profileName}`);
  if (profile.stewardCount > profile.memberCount) throw new Error("stewardCount cannot exceed memberCount");
  if (profile.stewardCount < uniondemoConfig.chapterCount * 3) {
    throw new Error("stewardCount must cover at least three stewards per chapter");
  }
  if (profile.loginCount > profile.memberCount) throw new Error("loginCount cannot exceed memberCount");
  if (profile.memberCount < pageDepth.surfaces.adminMemberDirectory.minimumRows) {
    throw new Error("memberCount cannot satisfy the two-page member directory contract");
  }

  const runSeed = [
    uniondemoConfig.datasetVersion,
    targetName,
    profile.memberCount,
    profile.stewardCount,
    profile.loginCount
  ].join(":");
  const runId = deterministicUuid(`unionground-uniondemo:run:${runSeed}`);
  const configHash = createHash("sha256")
    .update(JSON.stringify({ datasetVersion: uniondemoConfig.datasetVersion, targetName, target, profile }))
    .digest("hex");

  return Object.freeze({ targetName, profileName, target, profile, runId, configHash });
}

export function uniondemoUserId(runId, ordinal) {
  return deterministicUuid(`${runId}:ud:user:${ordinal}`);
}

export function uniondemoEmail(runId, ordinal) {
  return `ud-${runId.replaceAll("-", "").slice(0, 8)}-${String(ordinal).padStart(5, "0")}@${uniondemoConfig.emailDomain}`;
}

export function assertExactTarget(plan, suppliedUrl, options = {}) {
  const origin = assertSampleTarget({
    target: plan.target,
    actualUrl: suppliedUrl,
    targetName: plan.targetName,
    disposableConfirm: options.disposableConfirm,
  });
  const actual = new URL(origin);
  if (uniondemoConfig.forbiddenProjectRefs.some((ref) => actual.hostname.includes(ref))) {
    throw new Error("Forbidden Supabase project");
  }
  return origin;
}

export function publicPlan(plan) {
  return {
    datasetVersion: uniondemoConfig.datasetVersion,
    target: plan.targetName,
    projectRef: plan.target.projectRef,
    profile: plan.profileName,
    runId: plan.runId,
    configHash: plan.configHash,
    chapterCount: uniondemoConfig.chapterCount,
    functionCount: functionParity.functionCount,
    pageDepthVersion: pageDepth.version,
    ...plan.profile,
    firstUserId: uniondemoUserId(plan.runId, 1),
    firstEmail: uniondemoEmail(plan.runId, 1),
    lastUserId: uniondemoUserId(plan.runId, plan.profile.memberCount),
    lastEmail: uniondemoEmail(plan.runId, plan.profile.memberCount)
  };
}
