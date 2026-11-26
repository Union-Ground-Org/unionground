// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ backend: "local", events: [], paths: [], calls: [], refused: "", stopFails: false, statFails: false }));
const socketPathByteLimit = ["darwin", "freebsd", "openbsd", "netbsd"].includes(process.platform) ? 103 : 107;
vi.mock("node:os", () => ({ tmpdir: () => "/tmp" }));
vi.mock("node:fs", () => ({
  existsSync: () => state.backend === "local",
  readdirSync: () => ["18"],
  mkdtempSync: prefix => { const path = `${prefix}fixture`; state.paths.push(path); return path; },
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  lstatSync: () => {
    if (state.statFails) throw Object.assign(new Error("owner unavailable"), { code: "EACCES" });
    return { uid: 107 };
  },
  rmSync: path => {
    state.events.push(`remove:${path}`);
    if (state.refused && path.includes(state.refused)) throw Object.assign(new Error("removal refused"), { code: "EPERM" });
  },
}));
vi.mock("node:child_process", () => ({
  execFileSync: (file, args) => {
    state.calls.push([file, args]);
    if (args.includes("stop")) {
      state.events.push("stop");
      if (state.stopFails) throw new Error("server did not stop");
    }
    if (file === "docker" && args[0] === "image") return "image-id";
    if (file === "docker" && args[0] === "run") return "container-id";
    if (file === "docker" && args[0] === "logs") return "PostgreSQL init process complete; ready for start up.";
    return "";
  },
}));
vi.mock("pg", () => ({ default: { Client: class {
  async connect() { state.events.push("connect"); }
  async end() { state.events.push("disconnect"); }
} } }));

beforeEach(() => {
  vi.resetModules();
  Object.assign(state, { backend: "local", events: [], paths: [], calls: [], refused: "", stopFails: false, statFails: false });
  vi.stubEnv("RUNNER_TEMP", "/runner/temp");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("offline PostgreSQL scratch lifecycle", () => {
  it("uses RUNNER_TEMP for data and short socket roots", async () => {
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    expect(state.paths).toEqual(["/runner/temp/tvpg-fixture", "/runner/temp/pr3802pg-fixture"]);
    await db.close();
    expect(state.events.indexOf("stop")).toBeGreaterThan(state.events.indexOf("disconnect"));
    expect(state.events.indexOf("remove:/runner/temp/tvpg-fixture")).toBeGreaterThan(state.events.indexOf("stop"));
  });

  it("falls back to os.tmpdir without RUNNER_TEMP", async () => {
    vi.stubEnv("RUNNER_TEMP", "");
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    expect(state.paths).toEqual(["/tmp/tvpg-fixture", "/tmp/pr3802pg-fixture"]);
    await db.close();
  });

  it("keeps data in a long runner root while using a short socket path", async () => {
    const root = `/runner/${"long".repeat(25)}`;
    vi.stubEnv("RUNNER_TEMP", root);
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    expect(state.paths).toEqual([`${root}/tvpg-fixture`, "/tmp/pr3802pg-fixture"]);
    await db.close();
  });

  it.each(["local", "docker"])("uses a shorter socket path for a multibyte runner root with %s PostgreSQL", async backend => {
    state.backend = backend;
    const root = `/runner/${"é".repeat(50)}`;
    expect(root.length).toBeLessThan(70);
    expect(Buffer.byteLength(`${root}/pr3802pg-fixture/.s.PGSQL.55492`)).toBeGreaterThan(107);
    vi.stubEnv("RUNNER_TEMP", root);
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    expect(state.paths).toEqual([`${root}/tvpg-fixture`, "/tmp/pr3802pg-fixture"]);
    await db.close();
    expect(state.events).toContain(`remove:${root}/tvpg-fixture`);
    expect(state.events).toContain("remove:/tmp/pr3802pg-fixture");
  });

  it("keeps a valid short multibyte runner socket path", async () => {
    const root = `/runner/${"é".repeat(8)}`;
    vi.stubEnv("RUNNER_TEMP", root);
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    expect(state.paths).toEqual([`${root}/tvpg-fixture`, `${root}/pr3802pg-fixture`]);
    await db.close();
  });

  it("accepts the last usable Unix pathname byte including the socket name", async () => {
    const root = `/${"a".repeat(socketPathByteLimit - 33)}`;
    expect(Buffer.byteLength(`${root}/pr3802pg-fixture/.s.PGSQL.55492`)).toBe(socketPathByteLimit);
    vi.stubEnv("RUNNER_TEMP", root);
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    expect(state.paths).toEqual([`${root}/tvpg-fixture`, `${root}/pr3802pg-fixture`]);
    await db.close();
  });

  it("checks the actual generated suffix and removes an oversized candidate before falling back", async () => {
    // The mock's seven-character suffix also exercises a platform generating
    // more than the six characters promised by the ordinary mkdtemp estimate.
    const root = `/${"a".repeat(socketPathByteLimit - 32)}`;
    expect(Buffer.byteLength(`${root}/pr3802pg-fixture/.s.PGSQL.55492`)).toBe(socketPathByteLimit + 1);
    vi.stubEnv("RUNNER_TEMP", root);
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    expect(state.paths.at(-1)).toBe("/tmp/pr3802pg-fixture");
    expect(state.events).toContain(`remove:${root}/pr3802pg-fixture`);
    await db.close();
  });

  // #6185: the parent check no longer refuses shell metacharacters; pg_ctl's
  // -o string quotes the directory instead (tamarack-postgres-socket-quoting).
  // Each parent's socket path fits Darwin/BSD's 103 bytes too, so the helper
  // keeps it on every platform: 66 'a's made 104 bytes and failed on macOS
  // (BUG-UG-POSTGRES-HELPER-TEST-DARWIN-VERDICT-PARENT-BYTE-20261027).
  it.each([["an apostrophe, a space and Unicode", "/tmp/o'brien scratch-café"], ["the #6145 verdict's", `/tmp/${"a".repeat(65)}'`]])(
    "keeps a runner socket parent with %s and hands pg_ctl its quoted directory", async (_name, root) => {
      expect(Buffer.byteLength(`${root}/pr3802pg-fixture/.s.PGSQL.55492`)).toBeLessThanOrEqual(103);
      vi.stubEnv("RUNNER_TEMP", root);
      const { offlinePostgres, pgCtlServerOptions } = await import("./tamarack-postgres-helper.mjs");
      const db = await offlinePostgres();
      expect(state.paths).toEqual([`${root}/tvpg-fixture`, `${root}/pr3802pg-fixture`]);
      const start = state.calls.find(([file, args]) => file.endsWith("/pg_ctl") && args.includes("start"))[1];
      expect(start[start.indexOf("-o") + 1]).toBe(pgCtlServerOptions(`${root}/pr3802pg-fixture`));
      await db.close();
    });

  it.each(["local", "docker"])("warns on refused removal after stopping %s PostgreSQL", async backend => {
    state.backend = backend;
    state.refused = "pr3802pg-";
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    await expect(db.close()).resolves.toBeUndefined();
    expect(state.events).toContain("stop");
    expect(state.events.indexOf("remove:/runner/temp/pr3802pg-fixture")).toBeGreaterThan(state.events.indexOf("stop"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("EPERM"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("owner_uid=107"));
  });

  it("warns without failing cleanup when the refused directory owner is unreadable", async () => {
    state.refused = "pr3802pg-";
    state.statFails = true;
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    await expect(db.close()).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("owner_uid=unknown"));
  });

  it("still cleans the socket when data removal is refused", async () => {
    state.refused = "tvpg-";
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    await expect(db.close()).resolves.toBeUndefined();
    expect(state.events).toContain("remove:/runner/temp/pr3802pg-fixture");
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("tvpg-fixture"));
  });

  it("does not remove a running server's scratch or hide shutdown failure", async () => {
    state.stopFails = true;
    const { offlinePostgres } = await import("./tamarack-postgres-helper.mjs");
    const db = await offlinePostgres();
    await expect(db.close()).rejects.toThrow("server did not stop");
    expect(state.events.filter(event => event.startsWith("remove:"))).toEqual([]);
  });
});
