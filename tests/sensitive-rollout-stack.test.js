// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { createSensitiveProofStack, preStartedSensitiveProofStack, repositoryMigrationVersions, sensitiveProofLimits } from "./helpers/sensitive-rollout-stack.mjs";

const replay = ({ invoke, startArgs, timeout }) => invoke(startArgs, timeout);
const minute = 60_000;
const SENSITIVE_PROOF_LIMITS = sensitiveProofLimits(undefined);
function harness(outcomes, limits = SENSITIVE_PROOF_LIMITS) {
  let elapsed = 0;
  const run = vi.fn((_binary, args, options) => {
    const next = outcomes.shift();
    expect(next, `Unexpected command: ${args[2]}`).toBeDefined();
    expect(args[2]).toBe(next.command);
    elapsed += next.elapsed ?? 0;
    return { status: next.status, signal: next.signal ?? null, ...(next.error ? { error: next.error } : {}) };
  });
  return { stack: createSensitiveProofStack("/owned/supabase", "/owned/disposable", { replay, run, limits, now: () => elapsed, networkId: "" }), run };
}

describe("isolated sensitive proof stack startup", () => {
  it("sizes the window from the parent's measured replay with a bounded load margin", () => {
    expect(sensitiveProofLimits(undefined)).toMatchObject({ startupMs: 25 * minute, minimumRetryMs: 20 * minute });
    expect(sensitiveProofLimits("not-a-number").startupMs).toBe(25 * minute);
    expect(sensitiveProofLimits(String(10 * minute))).toMatchObject({ startupMs: 25 * minute, minimumRetryMs: 20 * minute });
    expect(sensitiveProofLimits(String(30 * minute))).toMatchObject({ startupMs: 45 * minute, minimumRetryMs: 30 * minute });
    expect(sensitiveProofLimits(String(40 * minute))).toMatchObject({ startupMs: 50 * minute, minimumRetryMs: 40 * minute });
    for (const parent of [undefined, 20 * minute, 30 * minute, 60 * minute]) {
      const limits = sensitiveProofLimits(parent);
      expect(limits.testMs).toBeGreaterThanOrEqual(limits.prepareMs + limits.startupMs + 2 * limits.commandMs + limits.assertionsMs);
    }
  });

  it("lets a loaded runner finish the 30-minute replay that the fixed window cut off", () => {
    const { stack, run } = harness([{ command: "start", elapsed: 30 * minute, status: 0 }], sensitiveProofLimits(28 * minute));
    expect(stack.start().result.status).toBe(0);
    expect(run.mock.calls[0][2].timeout).toBe(42 * minute);
  });

  it("uses an explicitly supplied Docker network when the default pool is exhausted", () => {
    const run = vi.fn(() => ({ status: 0, signal: null }));
    const stack = createSensitiveProofStack("/owned/supabase", "/owned/disposable", {
      replay, run,
      now: () => 0,
      networkId: "owned-network",
    });
    expect(stack.start().result.status).toBe(0);
    expect(run.mock.calls[0][1]).toEqual([
      "--workdir", "/owned/disposable", "start", "--network-id", "owned-network",
      "--exclude", "studio,imgproxy,mailpit,edge-runtime,logflare,vector",
    ]);
  });

  it("allows the observed full replay duration while keeping the API and Storage services", () => {
    const { stack, run } = harness([{ command: "start", elapsed: 16.5 * minute, status: 0 }]);
    expect(stack.start().result.status).toBe(0);
    expect(run).toHaveBeenCalledExactlyOnceWith("/owned/supabase", [
      "--workdir", "/owned/disposable", "start", "--exclude",
      "studio,imgproxy,mailpit,edge-runtime,logflare,vector",
    ], expect.objectContaining({ timeout: 25 * minute }));
  });

  it("subtracts both the failed attempt and cleanup from the retry timeout", () => {
    const { stack, run } = harness([
      { command: "start", elapsed: 2 * minute, status: 1 },
      { command: "stop", elapsed: minute, status: 0 },
      { command: "start", elapsed: 16.5 * minute, status: 0 },
    ]);
    const { result, attempts } = stack.start();
    expect(result.status).toBe(0);
    expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([25 * minute, minute, 22 * minute]);
    expect(attempts).toEqual([
      { status: 1, signal: null, errorCode: null, timeoutMs: 25 * minute, elapsedMs: 2 * minute },
      { status: 0, signal: null, errorCode: null, timeoutMs: 22 * minute, elapsedMs: 19.5 * minute },
    ]);
  });

  it("permits the retry at exactly the minimum remaining replay budget", () => {
    const { stack, run } = harness([
      { command: "start", elapsed: 4 * minute, status: 1 },
      { command: "stop", elapsed: minute, status: 0 },
      { command: "start", elapsed: 16.5 * minute, status: 0 },
    ]);
    expect(stack.start().result.status).toBe(0);
    expect(run.mock.calls[2][2].timeout).toBe(20 * minute);
  });

  it("refuses another cold replay when cleanup leaves too little budget", () => {
    const { stack, run } = harness([
      { command: "start", elapsed: 4 * minute + 1, status: 1 },
      { command: "stop", elapsed: minute, status: 0 },
    ]);
    const { result, attempts } = stack.start();
    expect(result.status).toBe(1);
    expect(attempts).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops the failed stack after a startup timeout and never resets the exhausted budget", () => {
    const { stack, run } = harness([
      { command: "start", elapsed: 25 * minute, status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } },
      { command: "stop", elapsed: minute, status: 0 },
    ]);
    const { result, attempts } = stack.start();
    expect(result.status).toBeNull();
    expect(attempts[0]).toMatchObject({ signal: "SIGTERM", errorCode: "ETIMEDOUT" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not launch a process if the startup window expires before launch", () => {
    const run = vi.fn();
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(25 * minute);
    const stack = createSensitiveProofStack("/owned/supabase", "/owned/disposable", { replay, run, limits: SENSITIVE_PROOF_LIMITS, now });
    expect(stack.start()).toEqual({
      result: { status: null, signal: null, error: { code: "STARTUP_BUDGET_EXHAUSTED" } },
      attempts: [],
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("retains both failed outcomes and never starts a third attempt", () => {
    const { stack, run } = harness([
      { command: "start", elapsed: minute, status: 1 },
      { command: "stop", status: 0 },
      { command: "start", elapsed: minute, status: 2 },
      { command: "stop", status: 0 },
    ]);
    const { result, attempts } = stack.start();
    expect(result.status).toBe(2);
    expect(attempts.map(({ status }) => status)).toEqual([1, 2]);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("refuses a retry when the first stack cannot be stopped", () => {
    const { stack, run } = harness([
      { command: "start", status: 1 },
      { command: "stop", elapsed: minute, status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } },
    ]);
    expect(() => stack.start()).toThrow(/retry-cleanup-failed: .*ETIMEDOUT/);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("bounds status and final cleanup independently of migration startup", () => {
    const { stack, run } = harness([{ command: "status", status: 0 }, { command: "stop", status: 0 }]);
    stack.command("status", "-o", "json");
    stack.command("stop", "--no-backup");
    expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([minute, minute]);
    expect(SENSITIVE_PROOF_LIMITS.testMs).toBeGreaterThanOrEqual(
      SENSITIVE_PROOF_LIMITS.prepareMs + SENSITIVE_PROOF_LIMITS.startupMs
      + 2 * SENSITIVE_PROOF_LIMITS.commandMs + SENSITIVE_PROOF_LIMITS.assertionsMs,
    );
  });
});

describe("pre-started sensitive proof stack", () => {
  const shared = "postgresql://postgres:postgres@127.0.0.1:55672/postgres";
  const own = "postgresql://postgres:postgres@127.0.0.1:55682/postgres";
  const handed = {
    SUPABASE_DB_URL: shared,
    CI_DB_WORKDIR: "/runner/_temp/mi1-xdb-ci-shared",
    SENSITIVE_PROOF_STACK_STARTED: "1",
    SENSITIVE_PROOF_CI_DB_WORKDIR: "/runner/_temp/mi1-xdb-ci-own",
    SENSITIVE_PROOF_SUPABASE_DB_URL: own,
  };

  it("self-starts unless the start step declared a successful pre-start", () => {
    const { SENSITIVE_PROOF_STACK_STARTED: _started, ...prepared } = handed;
    expect(preStartedSensitiveProofStack(prepared)).toBeNull();
    expect(preStartedSensitiveProofStack({ ...handed, SENSITIVE_PROOF_STACK_STARTED: "true" })).toBeNull();
    expect(preStartedSensitiveProofStack({ SUPABASE_DB_URL: shared })).toBeNull();
  });

  it("hands over the declared stack's own workdir and URL", () => {
    expect(preStartedSensitiveProofStack(handed)).toEqual({ workdir: "/runner/_temp/mi1-xdb-ci-own", url: own });
  });

  it("refuses a partial handover instead of replacing it", () => {
    expect(() => preStartedSensitiveProofStack({ ...handed, SENSITIVE_PROOF_CI_DB_WORKDIR: "" })).toThrow("sensitive-proof-stack-workdir-missing");
    expect(() => preStartedSensitiveProofStack({ ...handed, SENSITIVE_PROOF_CI_DB_WORKDIR: "relative/workdir" })).toThrow("sensitive-proof-stack-workdir-missing");
    expect(() => preStartedSensitiveProofStack({ ...handed, SENSITIVE_PROOF_SUPABASE_DB_URL: "" })).toThrow(/SUPABASE_DB_URL is required/);
  });

  it("refuses the shared proof stack or any non-disposable target", () => {
    expect(() => preStartedSensitiveProofStack({ ...handed, SENSITIVE_PROOF_SUPABASE_DB_URL: shared })).toThrow("sensitive-proof-stack-is-the-shared-stack");
    expect(() => preStartedSensitiveProofStack({ ...handed, SENSITIVE_PROOF_CI_DB_WORKDIR: handed.CI_DB_WORKDIR })).toThrow("sensitive-proof-stack-is-the-shared-stack");
    for (const url of [
      "postgresql://postgres:postgres@db.example.supabase.co:55682/postgres",
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
      "postgresql://postgres:postgres@127.0.0.1:55682/postgres?host=db.example.supabase.co",
    ]) {
      expect(() => preStartedSensitiveProofStack({ ...handed, SENSITIVE_PROOF_SUPABASE_DB_URL: url })).toThrow(/DB repair proofs/);
    }
    expect(() => preStartedSensitiveProofStack({ ...handed, SUPABASE_DB_URL: "" })).toThrow(/SUPABASE_DB_URL is required/);
  });

  it("expects every repository migration version in order", () => {
    const files = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
    const versions = repositoryMigrationVersions();
    expect(versions).toHaveLength(files.length);
    expect(versions.length).toBeGreaterThan(500);
    expect(versions.every((version) => /^\d{14}$/.test(version))).toBe(true);
    expect([...versions].sort()).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
