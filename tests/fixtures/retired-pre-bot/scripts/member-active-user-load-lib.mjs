import { pathToFileURL as retiredPathToURL } from 'node:url';
if (process.argv[1] && import.meta.url === retiredPathToURL(process.argv[1]).href) throw new Error('Retired fixture: direct execution forbidden');
// Isolated regression fixture for retired pre-bot behavior. Never imported by product code.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveStressPlan } from "./member-stress-config.mjs";

const configPath = fileURLToPath(new URL("../../../../stress/active-user-config.json", import.meta.url));
export const activeUserConfig = Object.freeze(JSON.parse(readFileSync(configPath, "utf8")));
export const AI_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
export const AI_RESERVATION_CLOCK_SKEW_MS = 60 * 1000;

const integerFlags = new Map([
  ["--vus", "virtualUsers"],
  ["--ramp-seconds", "rampSeconds"],
  ["--duration-seconds", "durationSeconds"],
  ["--think-min-ms", "thinkMinMs"],
  ["--think-max-ms", "thinkMaxMs"],
  ["--max-ai-calls", "maxAiCalls"],
  ["--ai-concurrency", "aiConcurrency"],
  ["--max-p95-ms", "maxP95Ms"],
  ["--max-ai-p95-ms", "maxAiP95Ms"],
]);

const decimalFlags = new Map([
  ["--ai-percent", "aiPercent"],
  ["--max-error-rate", "maxErrorRate"],
]);

function numeric(value, name, { integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"}`);
  }
  return parsed;
}

export function parseActiveUserArgs(argv) {
  const args = {
    mode: argv[0] && !argv[0].startsWith("--") ? argv[0] : "dry-run",
    targetName: "production",
    profileName: "light",
    aiMode: "real",
    reportDir: "reports/stress",
    manifestPath: null,
    overrides: {},
  };
  const start = args.mode === "dry-run" && argv[0]?.startsWith("--") ? 0 : 1;
  for (let index = start; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Unknown or incomplete argument: ${flag}`);
    if (flag === "--target") args.targetName = value;
    else if (flag === "--profile") args.profileName = value;
    else if (flag === "--ai-mode") args.aiMode = value;
    else if (flag === "--report-dir") args.reportDir = value;
    else if (flag === "--manifest") args.manifestPath = value;
    else if (integerFlags.has(flag)) args.overrides[integerFlags.get(flag)] = numeric(value, flag, { integer: true });
    else if (decimalFlags.has(flag)) args.overrides[decimalFlags.get(flag)] = numeric(value, flag);
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
  }
  if (!new Set(["dry-run", "run", "cleanup"]).has(args.mode)) throw new Error(`Unknown mode: ${args.mode}`);
  if (args.mode === "cleanup" && !args.manifestPath) throw new Error("cleanup mode requires --manifest");
  if (!new Set(["off", "real"]).has(args.aiMode)) throw new Error("--ai-mode must be off or real");
  return args;
}

function requireRange(value, name, minimum, maximum) {
  if (value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
}

export function minimumProductionRampSeconds(virtualUsers) {
  if (virtualUsers <= 30) return 0;
  return Math.ceil((virtualUsers - 30) / 0.45);
}

export function resolveActiveUserPlan(args, { runId = randomUUID() } = {}) {
  const target = activeUserConfig.targets[args.targetName];
  const profile = activeUserConfig.profiles[args.profileName];
  if (!target) throw new Error(`Unknown target: ${args.targetName}`);
  if (!profile) throw new Error(`Unknown profile: ${args.profileName}`);

  const values = { ...profile, ...args.overrides };
  if (args.aiMode === "off") {
    values.aiPercent = 0;
    values.maxAiCalls = 0;
  }

  for (const name of ["virtualUsers", "rampSeconds", "durationSeconds", "thinkMinMs", "thinkMaxMs", "maxAiCalls", "aiConcurrency", "maxP95Ms", "maxAiP95Ms"]) {
    if (!Number.isInteger(values[name])) throw new Error(`${name} must be an integer`);
  }
  requireRange(values.virtualUsers, "virtualUsers", 1, target.maxVirtualUsers);
  requireRange(values.rampSeconds, "rampSeconds", 0, 86400);
  requireRange(values.durationSeconds, "durationSeconds", 1, 86400);
  requireRange(values.thinkMinMs, "thinkMinMs", 0, 60000);
  requireRange(values.thinkMaxMs, "thinkMaxMs", values.thinkMinMs, 60000);
  requireRange(values.aiPercent, "aiPercent", 0, 100);
  requireRange(values.maxAiCalls, "maxAiCalls", 0, target.maxAiCalls);
  requireRange(values.aiConcurrency, "aiConcurrency", 1, target.maxAiConcurrency);
  requireRange(values.maxErrorRate, "maxErrorRate", 0, 1);
  requireRange(values.maxP95Ms, "maxP95Ms", 1, 120000);
  requireRange(values.maxAiP95Ms, "maxAiP95Ms", 1, 120000);

  const seedPlan = resolveStressPlan({ targetName: target.memberTarget, profileName: target.memberProfile });
  if (values.virtualUsers > seedPlan.profile.loginCount) {
    throw new Error(`virtualUsers exceeds ${seedPlan.profile.loginCount} login-capable seeded accounts`);
  }
  if (args.targetName === "production") {
    const minimumRamp = minimumProductionRampSeconds(values.virtualUsers);
    if (values.rampSeconds < minimumRamp) {
      throw new Error(`rampSeconds must be at least ${minimumRamp} for ${values.virtualUsers} production logins from one controller`);
    }
  }

  return Object.freeze({
    runId,
    mode: args.mode,
    targetName: args.targetName,
    profileName: args.profileName,
    aiMode: args.aiMode,
    reportDir: args.reportDir,
    datasetVersion: activeUserConfig.datasetVersion,
    target,
    seedPlan,
    values: Object.freeze(values),
  });
}

export function publicActiveUserPlan(plan) {
  return {
    runId: plan.runId,
    mode: plan.mode,
    target: plan.targetName,
    profile: plan.profileName,
    aiMode: plan.aiMode,
    datasetVersion: plan.datasetVersion,
    appUrl: plan.target.appUrl,
    supabaseProjectRef: plan.seedPlan.target.projectRef,
    stressDatasetRunId: plan.seedPlan.runId,
    loginCapableAccounts: plan.seedPlan.profile.loginCount,
    ...plan.values,
  };
}

export function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))].toFixed(1));
}

export function summarizeOperation(samples = []) {
  const latencies = samples.map((sample) => sample.ms).filter(Number.isFinite).sort((a, b) => a - b);
  const statuses = {};
  let passed = 0;
  for (const sample of samples) {
    const key = String(sample.status ?? "error");
    statuses[key] = (statuses[key] || 0) + 1;
    if (sample.ok) passed += 1;
  }
  return {
    requests: samples.length,
    passed,
    failed: samples.length - passed,
    statuses,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: latencies.length ? Number(latencies.at(-1).toFixed(1)) : null,
    },
  };
}

export function normalizeGatewayUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens);
  if (![promptTokens, completionTokens, totalTokens].every(Number.isFinite)) return null;
  return { promptTokens, completionTokens, totalTokens };
}

export function estimateUsageCost(usage, pricing) {
  if (!usage || !pricing) return null;
  const input = Number(pricing.input);
  const output = Number(pricing.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return Number((usage.promptTokens * input + usage.completionTokens * output).toFixed(8));
}

export function validateOwnedGuideThreads(locatedRows, expectedThreads) {
  if (locatedRows.length !== expectedThreads.size) throw new Error("guide thread cleanup preflight count mismatch");
  for (const row of locatedRows) {
    const expected = expectedThreads.get(row.id);
    const titleMatches = expected?.titlePrefix
      ? row.title === expected.titlePrefix
      : expected?.titleHash === stressTitleHash(row.title);
    if (!expected || row.user_id !== expected.userId || !titleMatches) {
      throw new Error("guide thread cleanup ownership mismatch");
    }
  }
  return locatedRows.map((row) => row.id);
}

export function stressTitleHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function reservationDelta(baseline, current) {
  return [...current.keys()].filter((id) => !baseline.has(id));
}

export function reservationUserId(value) {
  return value && typeof value === "object" ? value.userId : value;
}

export function expectedReservationBaseline(baseline, cleanupTimeMs = Date.now(), ttlMs = AI_RESERVATION_TTL_MS, clockSkewMs = AI_RESERVATION_CLOCK_SKEW_MS) {
  const cutoff = cleanupTimeMs - ttlMs + clockSkewMs;
  return new Map([...baseline.entries()].filter(([, value]) => {
    const createdAt = value && typeof value === "object" ? Date.parse(value.createdAt) : Number.NaN;
    return !Number.isFinite(createdAt) || createdAt >= cutoff;
  }));
}

const sensitiveKey = /(authorization|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|answer|question|email)/i;
const sensitiveValue = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{10,}|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

export function sanitizeReport(value, key = "") {
  if (sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string" && sensitiveValue.test(value)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => sanitizeReport(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitizeReport(entryValue, entryKey)]));
  }
  return value;
}

export function markdownReport(result) {
  const rows = Object.entries(result.operations).map(([name, summary]) =>
    `| ${name} | ${summary.requests} | ${summary.failed} | ${summary.latencyMs.p50 ?? "n/a"} | ${summary.latencyMs.p95 ?? "n/a"} | ${summary.latencyMs.p99 ?? "n/a"} |`
  ).join("\n");
  return `# Union Base active-user stress result\n\n` +
    `- Outcome: **${result.outcome}**\n` +
    `- Run: \`${result.runId}\`\n` +
    `- Target: \`${result.plan.target}\`\n` +
    `- Profile: \`${result.plan.profile}\`\n` +
    `- Production SHA: \`${result.production.commitSha || "unavailable"}\`\n` +
    `- Planned / peak users: ${result.plan.virtualUsers} / ${result.stats.peakActiveUsers}\n` +
    `- Operations / throughput: ${result.stats.operations} / ${result.stats.throughputPerSecond} per second\n` +
    `- AI calls / quota stop: ${result.ai.calls} / ${result.ai.quotaStopped}\n` +
    `- AI tokens / estimated cost: ${result.ai.usage.totalTokens} / ${result.ai.estimatedCostUsd ?? "unavailable"}\n` +
    `- Cleanup: ${result.cleanup.ok ? "PASS" : "FAIL"}\n` +
    `- Stop reason: ${result.stopReason || "completed"}\n\n` +
    `| Operation | Requests | Failed | p50 ms | p95 ms | p99 ms |\n|---|---:|---:|---:|---:|---:|\n${rows}\n`;
}
