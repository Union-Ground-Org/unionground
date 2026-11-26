// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Union Ground's destructive local RLS verifier (scripts/verify-local-rls.mjs)
// is not carried: Union Ground removed it on 2026-07-26 and `npm run
// test:rls` runs a refusal stub instead (README.md). This suite pins that
// boundary: the destructive script stays absent, and the entry point refuses
// before it can reach any database, whatever target the environment names.
describe("destructive RLS proof target boundary", () => {
  it("keeps the destructive verifier out of the tree and test:rls on the refusal stub", () => {
    expect(existsSync("scripts/verify-local-rls.mjs")).toBe(false);
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8"));
    expect(scripts["test:rls"]).toBe("node scripts/unionground-legacy-rls-disabled.mjs");
    const stub = readFileSync("scripts/unionground-legacy-rls-disabled.mjs", "utf8");
    // A refusal stub imports nothing, so it cannot construct a client.
    expect(stub).not.toMatch(/\bimport\b|\brequire\(/);
  });

  it.each([
    ["an outside tenant-fixture database", { SUPABASE_URL: "http://127.0.0.1:59551", SUPABASE_DB_URL: "postgresql://postgres:fixture@outside.example:59552/postgres" }],
    ["the shared local database", { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_DB_URL: "postgresql://postgres:fixture@127.0.0.1:54322/postgres" }],
    ["a hosted project", { SUPABASE_URL: "https://psgfixtureproject.supabase.co" }],
    ["a credential-bearing outside URL", { SUPABASE_URL: "http://127.0.0.1:59551@outside.example" }],
  ])("refuses %s before any database work", (_label, target) => {
    const result = spawnSync(process.execPath, ["scripts/unionground-legacy-rls-disabled.mjs"], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SUPABASE_ANON_KEY: "fixture-anon",
        SUPABASE_SERVICE_ROLE_KEY: "fixture-service",
        RLS_DISPOSABLE_CONFIRM: "owned-ci-database",
        ...target,
      },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ event: "blocked", blocker: "TEST" });
  });

  it.each([
    { SUPABASE_URL: "https://psgfixtureproject.supabase.co", SUPABASE_DB_URL: "postgresql://postgres:fixture@outside.example:59552/postgres" },
    { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_DB_URL: "postgresql://postgres:fixture@127.0.0.1:54322/postgres" },
    { SUPABASE_URL: "http://127.0.0.1:59551", SUPABASE_DB_URL: "postgresql://postgres:fixture@127.0.0.1:59554/postgres" },
  ])("refuses a hosted, shared or mismatched disposable proof target", (target) => {
    const result = spawnSync(process.execPath, ["scripts/verify-disposable-rls.mjs"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SUPABASE_ANON_KEY: "fixture-anon",
        SUPABASE_SERVICE_ROLE_KEY: "fixture-service", RLS_DISPOSABLE_CONFIRM: "owned-ci-database", ...target },
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/explicitly confirmed owned disposable|same loopback stack/);
  });
});
