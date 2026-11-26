// @vitest-environment node
// BUG-UG-POSTGRES-SCRATCH-SOCKET-QUOTING-20261027 (#6185): pg_ctl splices
// its -o string into a /bin/sh command, so an unquoted socket directory under
// a scratch parent with an apostrophe broke local DB test startup (#6145,
// verdict 6436683731). The directory is now one shell word holding one
// double-quoted PostgreSQL directory-list element.
import { afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { localPostgresBin, offlinePostgres, pgCtlServerOptions } from "./tamarack-postgres-helper.mjs";

// The verdict's exact parent: 72 characters, so its socket pathname is 103 bytes.
const VERDICT_PARENT = `/tmp/${"a".repeat(66)}'`;
const parent = name => {
  if (name === "verdict") { mkdirSync(VERDICT_PARENT, { recursive: true }); return VERDICT_PARENT; }
  return mkdtempSync("/tmp/o'brien scratch-café-");
};
// The words /bin/sh hands postgres for one -o string, NUL-separated so an
// empty or space-holding word is visible.
const shellWords = options => execFileSync("sh", ["-c", `printf '%s\\0' ${options}`], { encoding: "utf8" }).split("\0").slice(0, -1);
const created = [];
afterAll(() => {
  for (const parent of created) {
    if (parent === VERDICT_PARENT) { try { rmdirSync(parent); } catch { /* another run may still use it */ } }
    else rmSync(parent, { recursive: true, force: true });
  }
});

describe("pg_ctl's -o string quotes the socket directory", () => {
  it.each([
    "/tmp/o'brien scratch-café/pr3802pg-abc123",
    `${VERDICT_PARENT}/pr3802pg-abc123`,
    "/tmp/a,b \"quoted\" $HOME `id` \\ tab\there/pr3802pg-abc123",
  ])("round-trips %j through sh -c as one -k word postgres reads as one directory", socket => {
    const words = shellWords(pgCtlServerOptions(socket));
    expect(words).toEqual(["-k", `"${socket.replaceAll('"', '""')}"`, "-h", "", "-p", "55492"]);
    // PostgreSQL's directory-list reading of that element: one quoted name.
    expect(words[1].slice(1, -1).replaceAll('""', '"')).toBe(socket);
    expect(shellWords(pgCtlServerOptions(socket, { durable: false })).slice(6))
      .toEqual(["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"]);
  });

  it("keeps the verdict's newly admitted parent instead of relying on a whitespace rule", () => {
    expect(VERDICT_PARENT).toHaveLength(72);
    expect(Buffer.byteLength(`${VERDICT_PARENT}/pr3802pg-abc123/.s.PGSQL.55492`)).toBe(103);
  });

  // Where a local PostgreSQL server install exists (the CI runners), the
  // helper must start on, and connect through, a socket under each parent.
  it.runIf(Boolean(localPostgresBin)).each(["apostrophe, space and Unicode", "verdict"])("starts and connects with a socket under the %s parent", async name => {
    const root = parent(name);
    created.push(root);
    vi.stubEnv("RUNNER_TEMP", root);
    try {
      const db = await offlinePostgres({ durable: false });
      try {
        expect(db.client.host.startsWith(`${root}/pr3802pg-`)).toBe(true);
        expect((await db.client.query("select 1 as ok")).rows).toEqual([{ ok: 1 }]);
      } finally { await db.close(); }
    } finally { vi.unstubAllEnvs(); }
  }, 120_000);
});
