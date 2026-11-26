#!/usr/bin/env node
// Own a local database proof from preparation through teardown.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ephemerallyAllocatablePorts, prepareTargets } from "./prepare-ci-disposable-db.mjs";
import { validateScanTarget } from "./lib/database-assurance-policy.mjs";
import { DISPOSABLE_DB_START_BUDGET_MS, START_DEADLINE_ENV, supabaseCliBinary } from "./lib/disposable-db-start-admission.mjs";

const START = fileURLToPath(new URL("./start-disposable-db-stack.mjs", import.meta.url));
const interruptedStatus = (signal) => ({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 })[signal] ?? 1;
const ownsTarget = (target, root) => /^unionground-lab-ci-[a-f0-9]{12}$/.test(target.CI_DB_PROJECT_ID ?? "")
  && resolve(target.CI_DB_WORKDIR ?? "").startsWith(`${resolve(root)}/`);

async function stopOwnedTarget(target, root, cli, execute, env) {
  if (!ownsTarget(target, root)) throw new Error("refusing cleanup of an unowned database target");
  const stopped = await execute(cli, ["--workdir", target.CI_DB_WORKDIR, "stop", "--project-id", target.CI_DB_PROJECT_ID, "--no-backup"], { env, timeout: 180_000, killAfter: 15_000 });
  if (stopped.status !== 0) throw new Error(`stop exited ${stopped.status ?? stopped.signal ?? "without status"}`);
  const remaining = await execute("docker", ["ps", "-aq", "--filter", `label=com.supabase.cli.project=${target.CI_DB_PROJECT_ID}`], { env, timeout: 15_000, capture: true });
  if (remaining.status !== 0 || remaining.stdout?.trim()) throw new Error("owned containers remain or could not be checked after stop");
}

export function assertLocalPortsReserved(target) {
  if (process.platform !== "linux") return;
  const port = Number(new URL(target.SUPABASE_DB_URL).port);
  const exposed = ephemerallyAllocatablePorts(Array.from({ length: 10 }, (_, n) => port - 2 + n), {
    portRange: readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8"),
    reservedPorts: readFileSync("/proc/sys/net/ipv4/ip_local_reserved_ports", "utf8"),
  });
  if (exposed.length) throw new Error("Reserve 55000-59999 in net.ipv4.ip_local_reserved_ports before starting a local proof");
}

// A process group lets a signal stop a command's descendants before teardown.
// Cleanup itself is deliberately run without the cancelled signal.
export function executeOwned(command, args, { env, signal, timeout = 0, killAfter = 2000, capture = false } = {}) {
  if (signal?.aborted) return Promise.resolve({ status: null, signal: signal.reason });
  return new Promise((done) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, { env, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", detached: grouped });
    let escalation;
    let stopping = false, finished = false, closed, timedOut = false, overflow = false;
    let stdout = "";
    const kill = (kind) => {
      try { if (grouped) process.kill(-child.pid, kind); else child.kill(kind); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    };
    const stop = () => {
      if (stopping || finished) return;
      stopping = true;
      kill(signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM");
      // The leader may exit before a worker that ignores TERM. Keep escalation
      // alive and do not release the caller into teardown until it has fired.
      escalation = setTimeout(() => {
        kill("SIGKILL"); escalation = null;
        if (closed) finish(closed);
      }, killAfter);
    };
    const timer = timeout ? setTimeout(() => { timedOut = true; stop(); }, timeout) : null;
    signal?.addEventListener("abort", stop, { once: true });
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(escalation);
      signal?.removeEventListener("abort", stop);
      done({ ...result, ...(capture ? { stdout } : {}), ...(timedOut || overflow ? { status: 1 } : {}) });
    };
    if (capture) child.stdout.on("data", (chunk) => {
      if (Buffer.byteLength(stdout) + chunk.length > 1024 * 1024) { overflow = true; stop(); }
      else stdout += chunk.toString();
    });
    child.once("error", (error) => finish({ status: 1, error: error.message }));
    child.once("close", (status, killedBy) => {
      closed = { status, signal: killedBy };
      if (!escalation) finish(closed);
    });
  });
}

export async function runLocalDatabaseCommand(command, {
  env = process.env, tempRoot = env.CI_DB_TEMP_ROOT ?? env.TMPDIR,
  signal, prepare = prepareTargets, execute = executeOwned,
  checkPorts = assertLocalPortsReserved,
  cli = supabaseCliBinary(), log = console.error,
} = {}) {
  if (!command.length) throw new Error("A command after -- is required");
  if (!tempRoot || !isAbsolute(tempRoot)) throw new Error("Set TMPDIR or CI_DB_TEMP_ROOT to an absolute task scratch directory");
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(join(tempRoot, "local-db-run-"));
  let target;
  let status;
  let cleaned = true;
  try {
    target = await prepare({ tempRoot: root, runKey: root });
    if (!ownsTarget(target, root)) {
      throw new Error("Prepared database target is outside this run's ownership");
    }
    checkPorts(target);
    const childEnv = { ...env, ...target, TMPDIR: root,
      DATABASE_URL: target.SUPABASE_DB_URL, DIRECT_URL: target.SUPABASE_DB_URL,
      [START_DEADLINE_ENV]: String(Date.now() + DISPOSABLE_DB_START_BUDGET_MS) };
    // Do not pass a hosted project's API credentials into a local proof.
    for (const key of Object.keys(childEnv)) {
      if (/^(?:SAMPLE_|PRODUCTION_|VITE_SUPABASE_|NEXT_PUBLIC_SUPABASE_|E2E_SUPABASE_)/.test(key)
          || (/^SUPABASE_/.test(key) && key !== "SUPABASE_DB_URL")) delete childEnv[key];
    }
    const started = await execute(process.execPath, [START], { env: childEnv, signal });
    if (started.status !== 0) status = signal?.aborted ? interruptedStatus(signal.reason) : (started.status ?? 1);
    else {
      const local = await execute(cli, ["--workdir", target.CI_DB_WORKDIR, "status", "--output", "json"], { env: childEnv, signal, timeout: 15_000, capture: true });
      if (local.status !== 0) throw new Error("Could not read the owned local API target");
      const info = JSON.parse(local.stdout);
      validateScanTarget(target.SUPABASE_DB_URL, info);
      if (!info.JWT_SECRET) throw new Error("Owned local API target has no JWT secret");
      Object.assign(childEnv, { SUPABASE_URL: info.API_URL, SUPABASE_ANON_KEY: info.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: info.SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET: info.JWT_SECRET });
      const result = await execute(command[0], command.slice(1), { env: childEnv, signal });
      status = signal?.aborted ? interruptedStatus(signal.reason) : (result.status ?? 1);
    }
  } catch (error) {
    status = signal?.aborted ? interruptedStatus(signal.reason) : 1;
    // Name the reason (an unreserved port range, an unowned target) before cleanup.
    log(`Local database proof failed: ${error?.message ?? error}`);
    log("Local database proof failed; attempting owned-target cleanup");
  } finally {
    if (target) {
      // Never stop a target unless both its identity and directory are ours.
      try {
        await stopOwnedTarget(target, root, cli, execute, env);
      } catch (error) {
        cleaned = false;
        log(`Database cleanup failed; retained ${root}: ${error.message}`);
      }
    }
    if (cleaned) rmSync(root, { recursive: true, force: true });
  }
  return cleaned ? (signal?.aborted ? interruptedStatus(signal.reason) : status) : 1;
}

export async function withShutdownSignals(run) {
  const controller = new AbortController();
  const handlers = Object.fromEntries(["SIGHUP", "SIGINT", "SIGTERM"].map(kind => [kind, () => controller.abort(kind)]));
  for (const [kind, handler] of Object.entries(handlers)) process.on(kind, handler);
  try { return await run(controller.signal); }
  finally { for (const [kind, handler] of Object.entries(handlers)) process.off(kind, handler); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const separator = process.argv.indexOf("--");
  if (separator !== 2 || process.argv.length < 4) {
    console.error("Usage: TMPDIR=/absolute/scratch node scripts/run-local-disposable-db.mjs -- <command> [args...]");
    process.exitCode = 1;
  } else {
    try { process.exitCode = await withShutdownSignals(signal => runLocalDatabaseCommand(process.argv.slice(3), { signal })); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
