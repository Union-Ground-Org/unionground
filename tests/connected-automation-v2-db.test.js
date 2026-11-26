// @vitest-environment node
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;
live("connected automation database behavior", () => {
  it("executes all fourteen predicates, four actions, privacy, permissions, retries and undo", () => {
    const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    const result = execFileSync(process.execPath, ["scripts/verify-connected-automation-v2-local.mjs"], {
      encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, SUPABASE_DB_URL: databaseUrl },
    });
    expect(JSON.parse(result.trim()).status).toBe("passed");
  }, 190000);
});
