// @vitest-environment node
// The cold start path of the public-table grant probe
// (SYS-UG-REQUIRE-EXPLICIT-GRANTS-IN-MIGRATIONS-CREATING-PUBLIC-TABLES-20261022):
// the change's added migrations stay out of the replay, then the defaults are
// revoked, the migrations are applied unchanged and the defaults restored.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startDisposableDbStack } from "../scripts/start-disposable-db-stack.mjs";

const ADDED = "20261022110000_added.sql";
const BYTES = "create table public.added_rows (id int);\n";

function fixture({ failStep = null } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "grant-probe-start-"));
  mkdirSync(join(workdir, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(workdir, "supabase", "migrations", "20260901000000_base.sql"), "select 1;\n");
  writeFileSync(join(workdir, "supabase", "migrations", ADDED), BYTES);
  const events = [];
  const present = () => existsSync(join(workdir, "supabase", "migrations", ADDED));
  const run = (command, args) => {
    let event;
    if (basename(command) === "supabase") event = args.slice(2).join(" ");
    else event = `probe ${args[1]}${args[2] ? ` ${args[2]}` : ""}`;
    events.push({ event, added: present() });
    const failed = failStep && event === failStep;
    return { status: failed ? 1 : 0, stdout: "", stderr: failed ? "refused" : "" };
  };
  const replay = ({ invoke, startArgs, timeout }) => invoke(startArgs, timeout);
  const env = { CI_DB_WORKDIR: workdir, CI_DB_START_DEADLINE_EPOCH_MS: String(Date.now() + 3_600_000), CI_DB_GRANT_PROBE_ADDED: ADDED };
  return { workdir, events, run, replay, env, close: () => rmSync(workdir, { recursive: true, force: true }) };
}

describe("cold start with the public-table grant probe", () => {
  it("replays without the added migration, then revokes, applies it unchanged and restores", () => {
    const f = fixture();
    try {
      expect(startDisposableDbStack(f.env, { supabase: "/fake/supabase", run: f.run, replay: f.replay, log: vi.fn(), write: vi.fn() })).toBe(0);
      const events = f.events.map(({ event }) => event);
      expect(events[0]).toMatch(/^start --exclude /);
      expect(events.slice(1)).toEqual(["probe revoke", `probe hosted ${ADDED}`, "migration up --local", "probe restore"]);
      expect(f.events[0].added).toBe(false);
      expect(f.events[1].added).toBe(false);
      expect(f.events[2].added).toBe(false);
      expect(f.events[3].added).toBe(true);
      expect(readFileSync(join(f.workdir, "supabase", "migrations", ADDED), "utf8")).toBe(BYTES);
    } finally { f.close(); }
  });

  it("fails and stops the stack when the revoke step fails, never applying the change with the defaults in place", () => {
    const f = fixture({ failStep: "probe revoke" });
    try {
      expect(startDisposableDbStack(f.env, { supabase: "/fake/supabase", run: f.run, replay: f.replay, log: vi.fn(), write: vi.fn() })).toBe(1);
      const events = f.events.map(({ event }) => event);
      expect(events).not.toContain("migration up --local");
      expect(events.at(-1)).toBe("stop --no-backup");
    } finally { f.close(); }
  });

  it("fails and stops before applying a file that fails the hosted rehearsal", () => {
    const f = fixture({ failStep: `probe hosted ${ADDED}` });
    try {
      expect(startDisposableDbStack(f.env, { supabase: "/fake/supabase", run: f.run, replay: f.replay, log: vi.fn(), write: vi.fn() })).toBe(1);
      expect(f.events.map(({ event }) => event)).toEqual([expect.stringMatching(/^start /), "probe revoke", `probe hosted ${ADDED}`, "stop --no-backup"]);
    } finally { f.close(); }
  });

  it("rehearses and applies dependent files one at a time in version order", () => {
    const f = fixture();
    const second = "20261022120000_second.sql";
    writeFileSync(join(f.workdir, "supabase/migrations", second), "select 2;");
    try {
      expect(startDisposableDbStack({ ...f.env, CI_DB_GRANT_PROBE_ADDED: `${second},${ADDED}` },
        { supabase: "/fake/supabase", run: f.run, replay: f.replay, log: vi.fn(), write: vi.fn() })).toBe(0);
      expect(f.events.slice(1).map(({ event }) => event)).toEqual(["probe revoke", `probe hosted ${ADDED}`, "migration up --local", `probe hosted ${second}`, "migration up --local", "probe restore"]);
    } finally { f.close(); }
  });

  it("changes nothing when the change adds no migration", () => {
    const f = fixture();
    try {
      expect(startDisposableDbStack({ ...f.env, CI_DB_GRANT_PROBE_ADDED: "" },
        { supabase: "/fake/supabase", run: f.run, replay: f.replay, log: vi.fn(), write: vi.fn() })).toBe(0);
      expect(f.events).toHaveLength(1);
      expect(f.events[0].added).toBe(true);
    } finally { f.close(); }
  });

});
