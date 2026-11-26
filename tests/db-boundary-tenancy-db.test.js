// @vitest-environment node
//
// TEST-UG-DB-BOUNDARY-PROOF-REPLAYS-SUPERSEDED-MIGRATION-20260921: the
// required DB lane runs scripts/verify-db-boundary-tenancy.mjs against its
// fully migrated disposable stack. The proof refuses a stack whose recorded
// migrations differ from supabase/migrations, applies no migration itself and
// rolls every fixture back, so it can share the lane's schema.
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const databaseIt = process.env.RUN_DB_BOUNDARY_TENANCY_DB_TESTS === "1" ? it : it.skip;

databaseIt("proves the chapter-record and broadcast tenant boundaries on the migrated stack", () => {
  const databaseUrl = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const output = execFileSync(process.execPath, ["scripts/verify-db-boundary-tenancy.mjs"], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, SUPABASE_DB_URL: databaseUrl, DB_BOUNDARY_DB_URL: "" },
  });
  expect(output).toMatch(/^PASS: \d+ two-organization boundary checks, with every fixture rolled back\.$/m);
}, 130000);
