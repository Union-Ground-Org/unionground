import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DISPOSABLE_DB_START_BUDGET_MS, START_DEADLINE_ENV } from "./lib/disposable-db-start-admission.mjs";
import { changedMigrations } from "./lib/public-table-grant-probe.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OFFSETS = [0, 1, 2, 3, 4, 7, 9];

function setTomlValue(source, section, key, value) {
  const lines = source.split("\n");
  let current = "";
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const sectionMatch = lines[index].match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      continue;
    }
    if (current === section && new RegExp(`^${key}\\s*=`).test(lines[index])) {
      lines[index] = `${key} = ${value}`;
      changed = true;
      break;
    }
  }
  if (!changed) throw new Error(`Missing ${section || "root"}.${key} in Supabase config`);
  return lines.join("\n");
}

export function rewriteSupabaseConfig(source, { projectId, basePort }) {
  let output = setTomlValue(source, "", "project_id", JSON.stringify(projectId));
  for (const [section, key, offset] of [
    ["api", "port", 1],
    ["db", "port", 2],
    ["db", "shadow_port", 0],
    ["db.pooler", "port", 9],
    ["studio", "port", 3],
    ["local_smtp", "port", 4],
    ["analytics", "port", 7],
  ]) output = setTomlValue(output, section, key, String(basePort + offset));
  output = setTomlValue(output, "db.seed", "enabled", "false");
  // Disposable proof stacks never run `db diff`, `db pull` or a declarative
  // sync. With pg-delta on, `supabase start` exports a migrations catalog
  // after the replay (about 6 silent minutes on the 8-vCPU runner, in a
  // one-shot edge-runtime container that `--exclude edge-runtime` does not
  // skip). That export pushed the sensitive-rollout proof's second stack past
  // its 25-minute window on Main run 37281296278 (4:03 AM ET, October 5, 2026).
  return setTomlValue(output, "experimental.pgdelta", "enabled", "false");
}

export function candidateBasePort(runKey) {
  const digest = createHash("sha256").update(runKey).digest();
  return 55000 + (digest.readUInt16BE(0) % 500) * 10;
}

function portIsFreeOn(host, port) {
  return new Promise((resolvePort) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolvePort(true));
    });
  });
}

// Docker publishes the Supabase ports on the wildcard address, so a port held
// on any host address (not only loopback) fails the publish. Probe both.
async function portIsFree(port) {
  return (await portIsFreeOn("127.0.0.1", port)) && (await portIsFreeOn("0.0.0.0", port));
}

async function chooseBasePort(runKey, reserved = new Set()) {
  const initial = candidateBasePort(runKey);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const basePort = 55000 + (((initial - 55000) / 10 + attempt) % 500) * 10;
    if (reserved.has(basePort)) continue;
    const free = await Promise.all(OFFSETS.map((offset) => portIsFree(basePort + offset)));
    if (free.every(Boolean)) return basePort;
  }
  throw new Error("No free disposable Supabase port block in 55000-59999");
}

// Every disposable block sits in 55000-59999, inside Linux's default
// ephemeral range (32768-60999). Any outbound connection on the runner (the
// parallel parent replay opens them throughout) can take a chosen host port
// after the free check above, and Docker then cannot publish it ("failed to bind host
// port ... address already in use": Main run 38048798397 and PR run
// 38127157230, where both sensitive-stack attempts lost 0.0.0.0:55982 and
// 0.0.0.0:57812 within five seconds). CI reserves the range from automatic
// ephemeral allocation before this script runs, and this check refuses a
// block the kernel could still hand to an outbound socket. Explicit binds,
// which is how Docker publishes the ports, are unaffected by the reservation.
function parsePortList(text) {
  return String(text).trim().split(",").filter(Boolean).map((part) => {
    const [low, high = low] = part.trim().split("-").map(Number);
    return { low, high };
  });
}

export function ephemerallyAllocatablePorts(ports, { portRange, reservedPorts }) {
  const [low, high] = String(portRange).trim().split(/\s+/).map(Number);
  if (!Number.isInteger(low) || !Number.isInteger(high)) throw new Error(`Unreadable ip_local_port_range: ${JSON.stringify(portRange)}`);
  const reserved = parsePortList(reservedPorts);
  return ports.filter((port) => port >= low && port <= high
    && !reserved.some((range) => port >= range.low && port <= range.high));
}

function assertReservedFromEphemeralAllocation(basePorts) {
  const read = (path) => readFileSync(path, "utf8");
  const ports = basePorts.flatMap((basePort) => OFFSETS.map((offset) => basePort + offset));
  const exposed = ephemerallyAllocatablePorts(ports, {
    portRange: read("/proc/sys/net/ipv4/ip_local_port_range"),
    reservedPorts: read("/proc/sys/net/ipv4/ip_local_reserved_ports"),
  });
  if (exposed.length > 0) {
    throw new Error(`Disposable Supabase ports ${exposed.join(",")} are still in the kernel ephemeral range and not reserved (net.ipv4.ip_local_reserved_ports)`);
  }
}

function exportEnvironment(entries) {
  const body = Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, body);
  process.stdout.write(body);
}

// The sensitive-rollout proof needs its own empty project replayed from zero,
// never the shared proof stack. CI_DB_SENSITIVE_PROOF_TARGET=1 prepares that
// project in the same call, on a distinct port block. The start step replays
// both histories before the proofs, admitting one startup/retry/cleanup at a
// time on their shared runner and Docker daemon, inside the one start
// deadline exported here (DISPOSABLE_DB_START_BUDGET_MS).
export const SENSITIVE_PROOF_ENV_PREFIX = "SENSITIVE_PROOF_";

async function prepareTarget(tempRoot, runKey, reserved) {
  const basePort = await chooseBasePort(runKey, reserved);
  const workdir = mkdtempSync(join(tempRoot, "unionground-lab-ci-"));
  cpSync(join(ROOT, "supabase"), join(workdir, "supabase"), { recursive: true });
  // Reproduce Supabase's October 30, 2026 behaviour for the tables this change
  // adds (docs/conventions/public-table-grants.md). The start step holds the
  // added migrations back, revokes the stock default table privileges,
  // applies them unchanged and restores the defaults. An unresolvable base is
  // reported, and the grant proof then fails closed.
  const changed = changedMigrations(ROOT, process.env.CI_BASE_SHA || process.env.WORKLIST_BASE_REF || "origin/Main");
  const grantProbe = changed === null ? "unresolved" : changed.added.length ? "applied" : "none";

  // Every disposable stack this repository starts is a unionground-lab-*
  // project (README, scripts/verify-unionground-db.mjs), so its containers
  // carry the lab name and label. The assurance runner and the automation
  // concurrency proof refuse any other identity.
  const suffix = createHash("sha256").update(runKey).digest("hex").slice(0, 12);
  const projectId = `unionground-lab-ci-${suffix}`;
  const configPath = join(workdir, "supabase", "config.toml");
  const config = rewriteSupabaseConfig(readFileSync(configPath, "utf8"), { projectId, basePort });
  writeFileSync(configPath, config);

  return {
    CI_DB_WORKDIR: workdir,
    CI_DB_PROJECT_ID: projectId,
    CI_DB_BASE_PORT: String(basePort),
    SUPABASE_DB_URL: `postgresql://postgres:postgres@127.0.0.1:${basePort + 2}/postgres`,
    CI_DB_GRANT_PROBE: grantProbe,
    CI_DB_GRANT_PROBE_ADDED: (changed?.added ?? []).join(","),
    CI_DB_GRANT_PROBE_EDITED: (changed?.edited ?? []).join(","),
  };
}

export async function prepareTargets({ tempRoot, runKey, sensitiveProofTarget = false }) {
  const shared = await prepareTarget(tempRoot, runKey, new Set());
  if (!sensitiveProofTarget) return shared;
  const sensitive = await prepareTarget(tempRoot, `${runKey}:sensitive-proof`, new Set([Number(shared.CI_DB_BASE_PORT)]));
  return {
    ...shared,
    ...Object.fromEntries(Object.entries(sensitive).map(([key, value]) => [`${SENSITIVE_PROOF_ENV_PREFIX}${key}`, value])),
  };
}

async function main() {
  const tempRoot = process.env.CI_DB_TEMP_ROOT;
  const runKey = process.env.CI_DB_RUN_KEY;
  if (!tempRoot || !isAbsolute(tempRoot)) throw new Error("CI_DB_TEMP_ROOT must be an absolute runner-owned directory");
  if (!runKey) throw new Error("CI_DB_RUN_KEY is required");
  const targets = await prepareTargets({
    tempRoot,
    runKey,
    sensitiveProofTarget: process.env.CI_DB_SENSITIVE_PROOF_TARGET === "1",
  });
  if (process.env.CI_DB_REQUIRE_RESERVED_PORTS === "1") {
    assertReservedFromEphemeralAllocation([targets.CI_DB_BASE_PORT, targets[`${SENSITIVE_PROOF_ENV_PREFIX}CI_DB_BASE_PORT`]]
      .filter(Boolean).map(Number));
  }
  exportEnvironment({ ...targets, [START_DEADLINE_ENV]: String(Date.now() + DISPOSABLE_DB_START_BUDGET_MS) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
