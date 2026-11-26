// @vitest-environment node
//
// SEC-UG-PG-NET-PUBLIC-WRITE-TRIGGER-ESCALATION-20261110 (#8015): source pins
// over the migration that takes TEMP away from PUBLIC. Behaviour is proven on a
// disposable database by tests/public-temp-revoked-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";

const migration = readFileSync(new URL("../supabase/migrations/20261111031500_revoke_public_temp_on_database.sql", import.meta.url), "utf8");
const code = migration.replace(/--[^\n]*/gu, "");

describe("revoke PUBLIC TEMP on database postgres", () => {
  it("passes the hosted apply runner's transaction guard", () => {
    expect(sourceTransactionProblem(migration)).toBeNull();
  });

  it("revokes TEMP from PUBLIC and grants it back only by name, never to ci_drift_reader", () => {
    expect(code).toContain("revoke temporary on database postgres from public;");
    const grantees = [...code.matchAll(/grant temporary on database postgres to (\w+);/gu)].map((match) => match[1]);
    expect(grantees).toContain("postgres");
    for (const role of ["anon", "authenticated", "service_role", "authenticator"]) expect(grantees).toContain(role);
    expect(grantees).not.toContain("ci_drift_reader");
    expect(code).not.toMatch(/\bexecute\s+format/iu);
  });

  it("refuses to commit if PUBLIC keeps TEMP, a former holder loses it, or the drift reader keeps it", () => {
    for (const refusal of [
      "PUBLIC still holds TEMPORARY on database postgres",
      "these roles would lose TEMPORARY on database postgres: %",
      "ci_drift_reader still holds TEMPORARY on database postgres",
    ]) expect(code).toContain(`raise exception '${refusal}'`);
  });

  it("leaves CONNECT and every net grant alone", () => {
    expect(code).not.toMatch(/\bconnect\b/iu);
    expect(code).not.toMatch(/\bnet\./u);
  });
});
