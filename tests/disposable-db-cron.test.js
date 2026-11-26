// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replayWithCronPaused } from "../scripts/lib/disposable-db-cron.mjs";
import { startDisposableDbStack } from "../scripts/start-disposable-db-stack.mjs";
import { startPreparedSensitiveProofStack } from "../scripts/start-sensitive-proof-stack.mjs";

const project = "unionground-lab-ci-0123456789ab";
const container = "a".repeat(64);
const config = `project_id = "${project}"\n[db.migrations]\n# Keep original bytes\nenabled = true\nschema_paths = []\n[db.seed]\nenabled = false\n`;

function fixture({ failAt, launcherStillOn = false, wrongContainer = false, extensionFails = false } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "cron-replay-"));
  mkdirSync(join(workdir, "supabase"));
  const path = join(workdir, "supabase/config.toml");
  writeFileSync(path, config);
  const events = [];
  let paused = false;
  let autovacuum = "on";
  let pgNetReady = false;
  const run = vi.fn((binary, args) => {
    const operation = binary === "docker" ? args[0] : args[2];
    events.push(operation);
    if (operation === "start") {
      // The first process must not apply even the earliest migration.
      expect(readFileSync(path, "utf8")).toContain("enabled = false\nschema_paths");
    } else expect(readFileSync(path, "utf8")).toBe(config);
    if (operation === failAt) return { status: 1, stderr: "injected failure" };
    if (operation === "inspect") return { status: 0, stdout: `"${container}" {"com.supabase.cli.project":"${wrongContainer ? "other" : project}"}` };
    if (operation === "exec") {
      expect(args[1]).toBe(container);
      const sql = args.at(-1);
      if (sql === "CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions") {
        if (extensionFails) return { status: 1, stderr: "extension installation failed" };
        pgNetReady = true;
      }
      if (sql.startsWith("ALTER SYSTEM SET cron")) paused = !launcherStillOn;
      if (sql === "ALTER SYSTEM SET autovacuum = off") autovacuum = "off";
      if (sql === "ALTER SYSTEM RESET autovacuum") autovacuum = "on";
      if (sql.includes("current_setting") && !paused) return { status: 1, stderr: "cron launcher is not paused" };
      if (sql.includes("autovacuum is not paused") && autovacuum !== "off") return { status: 1, stderr: "autovacuum is not paused" };
      if (sql.includes("autovacuum was not restored") && autovacuum !== "on") return { status: 1, stderr: "autovacuum was not restored" };
    }
    if (operation === "migration") {
      expect(pgNetReady, "pg_net must be installed outside public before replay").toBe(true);
      expect(paused, "no migration may run while the scheduler is enabled").toBe(true);
      expect(autovacuum, "no migration may run while autovacuum can analyze the catalogs").toBe("off");
      expect(args.slice(2)).toEqual(["migration", "up", "--local"]);
    }
    return { status: 0, stdout: "", stderr: "" };
  });
  return { workdir, path, run, events, autovacuum: () => autovacuum, close: () => rmSync(workdir, { recursive: true, force: true }) };
}

describe("cron isolation during disposable replay", () => {
  it("verifies the launcher pause on an empty physical restore target", () => {
    const f = fixture();
    try {
      const status = startDisposableDbStack({
        CI_DB_WORKDIR: f.workdir, CI_DB_START_DEADLINE_EPOCH_MS: String(Date.now() + 60_000),
      }, { supabase: "/fake/supabase", run: f.run, log: vi.fn(), write: vi.fn(), bootstrapOnly: true });
      expect(status).toBe(0);
      expect(f.events).toEqual(["start", "inspect", "exec", "exec", "exec"]);
      const statements = f.run.mock.calls.filter(([, args]) => args[0] === "exec").map(([, args]) => args.at(-1));
      expect(statements[0]).toBe("ALTER SYSTEM SET cron.launch_active_jobs = off");
      expect(statements[1]).toBe("SELECT pg_reload_conf()");
      expect(statements[2]).toContain("cron launcher is not paused");
      expect(statements[2]).not.toContain("cron.job_run_details");
      expect(f.autovacuum()).toBe("on");
    } finally { f.close(); }
  });

  it.each(["shared", "sensitive"])("keeps all migrations behind the cron pause in the %s entry point", (target) => {
    const f = fixture();
    try {
      const env = {
        CI_DB_WORKDIR: target === "shared" ? f.workdir : "/other/shared",
        SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55002/postgres",
        SENSITIVE_PROOF_CI_DB_WORKDIR: f.workdir,
        SENSITIVE_PROOF_SUPABASE_DB_URL: "postgresql://postgres:postgres@127.0.0.1:55012/postgres",
        CI_DB_START_DEADLINE_EPOCH_MS: String(Date.now() + 60_000),
      };
      const options = { supabase: "/fake/supabase", run: f.run, log: vi.fn(), write: vi.fn() };
      if (target === "shared") expect(startDisposableDbStack(env, options)).toBe(0);
      else expect(startPreparedSensitiveProofStack(env, options).at(-1).status).toBe(0);
      expect(f.events).toEqual(["start", "inspect", "exec", "exec", "exec", "exec", "exec", "migration", "exec", "exec", "exec"]);
      expect(f.run.mock.calls.at(-1)[1].at(-1)).toContain("cron.job_run_details");
      // Autovacuum is off for the replay only and restored before any proof.
      expect(f.autovacuum()).toBe("on");
      const statements = f.run.mock.calls.filter(([, args]) => args[0] === "exec").map(([, args]) => args.at(-1));
      expect(statements.indexOf("ALTER SYSTEM SET autovacuum = off")).toBeLessThan(statements.indexOf("ALTER SYSTEM RESET autovacuum"));
      expect(readFileSync(f.path, "utf8")).toBe(config);
    } finally { f.close(); }
  });

  it("refuses migration replay when the reviewed extension installation fails", () => {
    const f = fixture({ extensionFails: true });
    try {
      const result = replayWithCronPaused({ workdir: f.workdir, run: f.run,
        invoke: (args, timeout) => f.run("/fake/supabase", ["--workdir", f.workdir, ...args], { timeout }),
        startArgs: ["start"], timeout: 60_000 });
      expect(result.status).toBe(1);
      expect(f.events).not.toContain("migration");
      expect(readFileSync(f.path, "utf8")).toBe(config);
    } finally { f.close(); }
  });

  it.each(["start", "inspect", "exec", "migration"])("fails closed and restores config after %s fails", (failAt) => {
    const f = fixture({ failAt });
    try {
      const result = replayWithCronPaused({ workdir: f.workdir, run: f.run,
        invoke: (args, timeout) => f.run("/fake/supabase", ["--workdir", f.workdir, ...args], { timeout }),
        startArgs: ["start"], timeout: 60_000 });
      expect(result.status).toBe(1);
      expect(readFileSync(f.path, "utf8")).toBe(config);
      if (failAt !== "migration") expect(f.events).not.toContain("migration");
    } finally { f.close(); }
  });

  it("refuses to replay when a successful reload has not disabled the launcher", () => {
    const f = fixture({ launcherStillOn: true });
    try {
      const result = replayWithCronPaused({ workdir: f.workdir, run: f.run,
        invoke: (args, timeout) => f.run("/fake/supabase", ["--workdir", f.workdir, ...args], { timeout }),
        startArgs: ["start"], timeout: 60_000 });
      expect(result.status).toBe(1);
      expect(f.events).not.toContain("migration");
    } finally { f.close(); }
  });

  it("does not configure a container whose project label differs", () => {
    const f = fixture({ wrongContainer: true });
    try {
      const result = replayWithCronPaused({ workdir: f.workdir, run: f.run,
        invoke: (args, timeout) => f.run("/fake/supabase", ["--workdir", f.workdir, ...args], { timeout }),
        startArgs: ["start"], timeout: 60_000 });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("container-identity-mismatch");
      expect(f.events).toEqual(["start", "inspect"]);
    } finally { f.close(); }
  });

  it("does not give migration replay a fresh budget after bootstrapping", () => {
    const f = fixture();
    try {
      let elapsed = 0;
      const result = replayWithCronPaused({ workdir: f.workdir, run: f.run,
        invoke: (args, timeout) => {
          expect(timeout).toBe(60_000);
          elapsed = 60_000;
          return f.run("/fake/supabase", ["--workdir", f.workdir, ...args], { timeout });
        }, startArgs: ["start"], timeout: 60_000, now: () => elapsed });
      expect(result.error.code).toBe("ETIMEDOUT");
      expect(f.events).toEqual(["start"]);
      expect(readFileSync(f.path, "utf8")).toBe(config);
    } finally { f.close(); }
  });

  it("stops the bootstrapped shared stack when its deadline expires between phases", () => {
    const f = fixture();
    try {
      let elapsed = 0;
      const run = (...args) => {
        const result = f.run(...args);
        if (args[1][2] === "start") elapsed = 60_000;
        return result;
      };
      expect(startDisposableDbStack({ CI_DB_WORKDIR: f.workdir, CI_DB_START_DEADLINE_EPOCH_MS: "60000" }, {
        supabase: "/fake/supabase", run, wallNow: () => elapsed, log: vi.fn(), write: vi.fn(),
        replay: (options) => replayWithCronPaused({ ...options, now: () => elapsed }),
      })).toBe(1);
      expect(f.events).toEqual(["start", "stop"]);
    } finally { f.close(); }
  });
});
