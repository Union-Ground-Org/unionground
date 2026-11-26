// @vitest-environment node
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { supabaseCliBinary } from "../scripts/lib/disposable-db-start-admission.mjs";
import { IMAGE_PULL_RETRY_DELAYS_MS, failedOnImagePull, startDisposableDbStack } from "../scripts/start-disposable-db-stack.mjs";
import { startPreparedSensitiveProofStack } from "../scripts/start-sensitive-proof-stack.mjs";

const replay = ({ invoke, startArgs, timeout }) => invoke(startArgs, timeout);
const minute = 60_000;
const TIMEOUT = "ERROR: canceling statement due to statement timeout (SQLSTATE 57014)";
const env = {
  CI_DB_WORKDIR: "/runner/shared",
  SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55672/postgres",
  SENSITIVE_PROOF_CI_DB_WORKDIR: "/runner/sensitive",
  SENSITIVE_PROOF_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55682/postgres",
  SENSITIVE_PROOF_NETWORK_ID: "owned-network",
  // Far enough off that only the deadline tests below reach it.
  CI_DB_START_DEADLINE_EPOCH_MS: String(200 * minute),
};
function harness(outcomes, startEnv = env) {
  let elapsed = 0;
  const run = vi.fn((_binary, args) => {
    const next = outcomes.shift();
    expect(next, `Unexpected command: ${args[2]}`).toBeDefined();
    expect(args.slice(0, 3)).toEqual(["--workdir", env.SENSITIVE_PROOF_CI_DB_WORKDIR, next.command]);
    elapsed += next.elapsed ?? 0;
    return { status: next.status, signal: null, stderr: next.stderr ?? "" };
  });
  const options = { replay, supabase: "/owned/supabase", run, now: () => elapsed, wallNow: () => elapsed, log: vi.fn() };
  return { run, options, start: () => startPreparedSensitiveProofStack(startEnv, options) };
}
const deadlineAt = (ms) => ({ ...env, CI_DB_START_DEADLINE_EPOCH_MS: String(ms) });

describe("prepared sensitive proof startup entry point", () => {
  it("recovers an early startup failure with bounded cleanup and a second replay", () => {
    const { start, run } = harness([
      { command: "start", status: 1, elapsed: 2 * minute },
      { command: "stop", status: 0, elapsed: minute },
      { command: "start", status: 0, elapsed: 30 * minute },
    ]);
    expect(start().map(({ status }) => status)).toEqual([1, 0]);
    expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([50 * minute, minute, 47 * minute]);
    expect(run.mock.calls[0][1]).toContain("owned-network");
    expect(env).not.toHaveProperty("SENSITIVE_PROOF_STACK_STARTED");
  });

  it("propagates failure after two attempts without a third replay", () => {
    const { start, run } = harness([
      { command: "start", status: 1 }, { command: "stop", status: 0 },
      { command: "start", status: 2 }, { command: "stop", status: 0 },
    ]);
    expect(start).toThrow(/sensitive-proof-stack-start-failed: .*"status":2/);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("never retries while the first stack has failed to stop", () => {
    const { start, run } = harness([
      { command: "start", status: 1, stderr: TIMEOUT },
      { command: "stop", status: 1, stderr: "a prune operation is already running" },
    ]);
    expect(start).toThrow(/retry-cleanup-failed: .*\nStartup stderr:\n.*SQLSTATE 57014\)\nCleanup stderr:\na prune operation is already running/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("counts cleanup against the total budget and refuses an underfunded replay", () => {
    const { start, run } = harness([
      { command: "start", status: 1, elapsed: 30 * minute },
      { command: "stop", status: 0, elapsed: minute },
    ]);
    expect(start).toThrow(/sensitive-proof-stack-start-failed/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("replays once more in a fresh window after a late migration statement timeout", () => {
    const { start, run } = harness([
      { command: "start", status: 1, elapsed: 28 * minute, stderr: TIMEOUT },
      { command: "stop", status: 0, elapsed: minute },
      { command: "start", status: 0, elapsed: 30 * minute },
    ]);
    expect(start().map(({ status }) => status)).toEqual([1, 0]);
    expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([50 * minute, minute, 50 * minute]);
  });

  it("fails a late statement timeout on the fresh replay without a third replay", () => {
    const { start, run } = harness([
      { command: "start", status: 1, elapsed: 28 * minute, stderr: TIMEOUT },
      { command: "stop", status: 0, elapsed: minute },
      { command: "start", status: 1, elapsed: 28 * minute, stderr: TIMEOUT },
      { command: "stop", status: 0, elapsed: minute },
    ]);
    expect(start).toThrow(/sensitive-proof-stack-start-failed/);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("keeps refusing an underfunded replay after any other late failure", () => {
    const { start, run } = harness([
      { command: "start", status: 1, elapsed: 30 * minute, stderr: "ERROR: relation does not exist (SQLSTATE 42P01)" },
      { command: "stop", status: 0, elapsed: minute },
    ]);
    expect(start).toThrow(/sensitive-proof-stack-start-failed/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("cuts every attempt, the fresh-window replay included, at the shared start deadline", () => {
    const { start, run } = harness([
      { command: "start", status: 1, elapsed: 28 * minute, stderr: TIMEOUT },
      { command: "stop", status: 0, elapsed: minute },
      { command: "start", status: 0, elapsed: 30 * minute },
    ], deadlineAt(65 * minute));
    expect(start().map(({ status }) => status)).toEqual([1, 0]);
    expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([50 * minute, minute, 36 * minute]);
  });

  it("refuses a replay when less than a full replay of the shared deadline remains", () => {
    const { start, run } = harness([
      { command: "start", status: 1, elapsed: 28 * minute, stderr: TIMEOUT },
      { command: "stop", status: 0, elapsed: minute },
    ], deadlineAt(45 * minute));
    expect(start).toThrow(/sensitive-proof-stack-start-failed/);
    expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([45 * minute, minute]);
  });

  it("starts nothing after the shared deadline, or without one", () => {
    const late = harness([], deadlineAt(minute));
    expect(() => startPreparedSensitiveProofStack(deadlineAt(minute), { ...late.options, wallNow: () => 2 * minute }))
      .toThrow(/sensitive-proof-stack-start-failed: .*STARTUP_BUDGET_EXHAUSTED/);
    expect(late.run).not.toHaveBeenCalled();
    const { CI_DB_START_DEADLINE_EPOCH_MS: _unset, ...missing } = env;
    const unset = harness([], missing);
    expect(unset.start).toThrow(/CI_DB_START_DEADLINE_EPOCH_MS must be the shared start deadline/);
    expect(unset.run).not.toHaveBeenCalled();
  });

  it("refuses a shared target before running any command", () => {
    const { run, options } = harness([]);
    expect(() => startPreparedSensitiveProofStack({ ...env, SENSITIVE_PROOF_SUPABASE_DB_URL: env.SUPABASE_DB_URL }, options))
      .toThrow(/sensitive-proof-stack-is-the-shared-stack/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("shared disposable stack start", () => {
  function shared(outcomes, startEnv = env) {
    let elapsed = 0;
    const run = vi.fn((_binary, args) => {
      const next = outcomes.shift();
      expect(next, `Unexpected command: ${args[2]}`).toBeDefined();
      expect(args.slice(0, 3)).toEqual(["--workdir", env.CI_DB_WORKDIR, next.command]);
      if (next.command === "start") expect(args).toContain("studio,imgproxy,mailpit,edge-runtime,logflare,vector");
      elapsed += next.elapsed ?? 0;
      return { status: next.status, signal: null, stdout: "", stderr: next.stderr ?? "", ...(next.error ? { error: next.error } : {}) };
    });
    const pause = vi.fn((ms) => { elapsed += ms; });
    const write = vi.fn();
    const options = { replay, supabase: "/owned/supabase", run, log: vi.fn(), write, wallNow: () => elapsed, pause };
    return { run, pause, write, start: () => startDisposableDbStack(startEnv, options) };
  }
  // GitHub's standard runner pulls every image cold; run 39844043581 failed
  // when all three registries refused the burst.
  const PULL = "failed to pull docker image from all registries: ghcr.io/supabase/postgrest:v14.14: toomanyrequests";

  it("stops, waits and starts again when the stack images did not pull", () => {
    const { start, run, pause } = shared([
      { command: "start", status: 1, elapsed: 4 * minute, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 1, elapsed: 2 * minute, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 0, elapsed: 20 * minute },
    ]);
    expect(start()).toBe(0);
    expect(run.mock.calls.map(([, args]) => args[2])).toEqual(["start", "stop", "start", "stop", "start"]);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual(IMAGE_PULL_RETRY_DELAYS_MS);
  });

  it("gives up on image pulls after the last wait and stops the stack", () => {
    const { start, run, write } = shared([
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
    ]);
    expect(start()).toBe(1);
    expect(run.mock.calls.map(([, args]) => args[2])).toEqual(["start", "stop", "start", "stop", "start", "stop"]);
    // Every attempt's CLI output is forwarded.
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.every(([result]) => result.stderr === PULL)).toBe(true);
  });

  it("does not retry image pulls without a full replay of deadline left after the wait", () => {
    const { start, run, pause, write } = shared([
      { command: "start", status: 1, elapsed: 75 * minute, stderr: PULL }, { command: "stop", status: 0 },
    ], deadlineAt(95 * minute));
    expect(start()).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(pause).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never retries image pulls over a stack that failed to stop", () => {
    const { start } = shared([{ command: "start", status: 1, stderr: PULL }, { command: "stop", status: 1 }]);
    expect(start).toThrow(/disposable-db-stack-pull-retry-cleanup-failed/);
  });

  it("recognizes only a failed image pull", () => {
    expect(failedOnImagePull({ status: 1, stderr: PULL })).toBe(true);
    expect(failedOnImagePull({ status: 0, stdout: PULL })).toBe(false);
    expect(failedOnImagePull({ status: 1, stderr: "ERROR: syntax error (SQLSTATE 42601)" })).toBe(false);
  });

  it("cuts both attempts at the shared start deadline", () => {
    const { start, run } = shared([
      { command: "start", status: 1, elapsed: 28 * minute, stderr: TIMEOUT },
      { command: "stop", status: 0, elapsed: minute },
      { command: "start", status: 0, elapsed: 30 * minute },
    ], deadlineAt(95 * minute));
    expect(start()).toBe(0);
    expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([95 * minute, minute, 66 * minute]);
  });

  it("does not replay when less than a full replay of the shared deadline remains", () => {
    const { start, run } = shared([
      { command: "start", status: 1, elapsed: 70 * minute, stderr: TIMEOUT },
      { command: "stop", status: 0, elapsed: minute },
    ], deadlineAt(90 * minute));
    expect(start()).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  // A start the deadline
  // cut off is stopped, bounded, before admission is released.
  it("stops a start the deadline cut off before releasing admission, and starts nothing without a deadline", () => {
    const cut = shared([
      { command: "start", status: null, elapsed: 95 * minute, error: { code: "ETIMEDOUT" } },
      { command: "stop", status: 0, elapsed: minute },
    ], deadlineAt(95 * minute));
    expect(cut.start()).toBe(1);
    expect(cut.run.mock.calls.map(([, args, options]) => [args[2], options.timeout])).toEqual([["start", 95 * minute], ["stop", minute]]);
    expect(cut.run.mock.calls[1][1]).toContain("--no-backup");
    const { CI_DB_START_DEADLINE_EPOCH_MS: _unset, ...missing } = env;
    const unset = shared([], missing);
    expect(unset.start).toThrow(/CI_DB_START_DEADLINE_EPOCH_MS must be the shared start deadline/);
    expect(unset.run).not.toHaveBeenCalled();
  });

  it("starts once when the replay succeeds", () => {
    const { start, run } = shared([{ command: "start", status: 0 }]);
    expect(start()).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops and replays once from zero after a migration statement timeout", () => {
    const { start, run } = shared([
      { command: "start", status: 1, stderr: TIMEOUT }, { command: "stop", status: 0 }, { command: "start", status: 0 },
    ]);
    expect(start()).toBe(0);
    expect(run.mock.calls[1][1]).toContain("--no-backup");
  });

  it("never replays a third time or after any other failure", () => {
    const twice = shared([
      { command: "start", status: 1, stderr: TIMEOUT }, { command: "stop", status: 0 }, { command: "start", status: 1, stderr: TIMEOUT },
      { command: "stop", status: 0 },
    ]);
    expect(twice.start()).toBe(1);
    expect(twice.run.mock.calls.map(([, args]) => args[2])).toEqual(["start", "stop", "start", "stop"]);
    const other = shared([
      { command: "start", status: 1, stderr: "ERROR: syntax error (SQLSTATE 42601)" }, { command: "stop", status: 0 },
    ]);
    expect(other.start()).toBe(1);
    expect(other.run.mock.calls.map(([, args]) => args[2])).toEqual(["start", "stop"]);
  });

  it("never replays over a stack that failed to stop", () => {
    const { start, run } = shared([{ command: "start", status: 1, stderr: TIMEOUT }, { command: "stop", status: 1 }]);
    expect(start).toThrow(/disposable-db-stack-retry-cleanup-failed/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops, waits and starts again when the stack images did not pull", () => {
    const { start, run, pause } = shared([
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 0 },
    ]);
    expect(start()).toBe(0);
    expect(run.mock.calls.map(([, args]) => args[2])).toEqual(["start", "stop", "start", "stop", "start"]);
    expect(pause.mock.calls.map(([ms]) => ms)).toEqual(IMAGE_PULL_RETRY_DELAYS_MS);
  });

  it("gives up on image pulls after the last wait and forwards every attempt's output", () => {
    const { start, run, write } = shared([
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
      { command: "start", status: 1, stderr: PULL }, { command: "stop", status: 0 },
    ]);
    expect(start()).toBe(1);
    expect(run.mock.calls.map(([, args]) => args[2])).toEqual(["start", "stop", "start", "stop", "start", "stop"]);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("never retries image pulls over a stack that failed to stop", () => {
    const { start } = shared([{ command: "start", status: 1, stderr: PULL }, { command: "stop", status: 1 }]);
    expect(start).toThrow(/disposable-db-stack-pull-retry-cleanup-failed/);
  });

  it("recognizes only a failed image pull", () => {
    expect(failedOnImagePull({ status: 1, stderr: PULL })).toBe(true);
    expect(failedOnImagePull({ status: 0, stdout: PULL })).toBe(false);
    expect(failedOnImagePull({ status: 1, stderr: TIMEOUT })).toBe(false);
  });
});

// Rounds 2 and 3 of the corresponding change: the
// deadline's spawnSync timeout must end the process doing the work. The Node
// shim and the platform launcher both run their child without forwarding
// signals. Since CLI 2.121.0 the platform package's bin/supabase is the
// process that talks to Docker (supabase-go keeps only db and functions).
describe("Supabase CLI the start helpers run", () => {
  it("is bin/supabase from the pinned platform package, and a spawnSync timeout ends it", async () => {
    const cli = supabaseCliBinary({ env: {} });
    expect(basename(cli)).toBe("supabase");
    expect(dirname(cli)).toMatch(/@supabase[\\/]cli-[^\\/]+[\\/]bin$/);
    expect(readFileSync(cli).subarray(0, 2).toString()).not.toBe("#!");
    // A Docker endpoint that accepts and never answers: the kernel completes
    // the connection while spawnSync blocks this event loop.
    const docker = net.createServer(() => {}).listen(0, "127.0.0.1");
    await once(docker, "listening");
    const root = mkdtempSync(join(tmpdir(), "supabase-cli-timeout-"));
    try {
      // `init` checks api.github.com for a newer CLI and reports telemetry
      // before it exits, so on a slow GitHub API it outlived its 30 s budget
      // (merge group 39470535005). A refused loopback proxy fails both at
      // once; Go never proxies the loopback Docker endpoint below.
      const offline = "http://127.0.0.1:9";
      const env = { ...process.env, HOME: root, DOCKER_HOST: `tcp://127.0.0.1:${docker.address().port}`,
        HTTPS_PROXY: offline, HTTP_PROXY: offline, https_proxy: offline, http_proxy: offline,
        NO_PROXY: "", no_proxy: "", DO_NOT_TRACK: "1", SUPABASE_TELEMETRY_DISABLED: "1" };
      const init = spawnSync(cli, ["--workdir", root, "init"], { env, encoding: "utf8", timeout: 30_000 });
      expect(init.status, init.stderr).toBe(0);
      const began = Date.now();
      const started = spawnSync(cli, ["--workdir", root, "start", "--exclude", "studio"], { env, encoding: "utf8", timeout: 4_000 });
      expect(started.error?.code).toBe("ETIMEDOUT");
      // 2.121.0 handles SIGTERM and exits 130 instead of dying by the signal.
      expect(started.signal ?? started.status).toBe(130);
      expect(Date.now() - began).toBeLessThan(10_000);
    } finally {
      docker.close();
      rmSync(root, { recursive: true, force: true });
    }
    expect(supabaseCliBinary({ env: { SUPABASE_CLI_BINARY_OVERRIDE: "/owned/cli" } })).toBe("/owned/cli");
    expect(() => supabaseCliBinary({ env: {}, os: "aix", cpu: "ppc64" })).toThrow(/No pinned Supabase CLI binary package/);
  }, 60_000);
});
