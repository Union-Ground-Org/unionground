// @vitest-environment node
//
// SEC-UG-CI-DRIFT-READER-CRON-READ-VIEW-20261109 (#7872): source pins over the
// migration that makes the Production drift login a reader. The behavior is proven
// on a disposable database (PR #8002); these pins keep the reviewed shape.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceTransactionProblem } from "../scripts/hosted-migration-apply-runner.mjs";

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20261110021827_ci_drift_reader_least_privilege.sql");
const code = migration.replace(/--[^\n]*/gu, "");
const definition = code.slice(code.indexOf("create or replace function private.ci_drift_cron_jobs()"), code.indexOf("$fn$;") + 5);
const body = definition.slice(definition.indexOf("as $fn$") + 7, definition.lastIndexOf("$fn$"));

describe("ci_drift_reader least-privilege migration", () => {
  it("passes the hosted apply runner's transaction guard", () => {
    expect(sourceTransactionProblem(migration)).toBeNull();
  });

  it("names no type in the definer body and resolves its return types schema-qualified (gate r1s1)", () => {
    // With search_path = '' an unqualified type still resolves in pg_temp first,
    // where a TEMP holder could plant a domain whose CHECK runs as the owner.
    expect(body).not.toContain("::");
    expect(body.replace(/\s+/gu, " ").trim()).toBe("select j.jobname, j.schedule, j.active, j.command from cron.job j order by j.jobname, j.jobid");
    expect(definition).toContain("returns table (jobname pg_catalog.text, schedule pg_catalog.text, active pg_catalog.bool, command pg_catalog.text)");
    expect(definition).toMatch(/security definer\s+set search_path = ''\s+as \$fn\$/u);
    expect(definition).toContain("language sql");
  });

  it("revokes client EXECUTE from the drift read and from both definer functions the reader could reach (K3-SOL-1)", () => {
    for (const fn of ["private.ci_drift_cron_jobs()", "private.award_member_points()", "private.member_receipt_code()"]) {
      expect(code).toContain(`revoke all on function ${fn} from public, anon, authenticated, service_role;`);
    }
  });

  it("changes the role only where it exists and refuses to commit a reader that is not one", () => {
    const block = code.slice(code.indexOf("do $drift_reader$"), code.indexOf("$drift_reader$;"));
    expect(block).toContain("if not exists (select 1 from pg_catalog.pg_roles where rolname = 'ci_drift_reader') then\n    return;");
    for (const statement of [
      "alter role ci_drift_reader nobypassrls;",
      "revoke usage on schema cron from ci_drift_reader;",
      "revoke authenticated from ci_drift_reader;",
      "grant all on function private.ci_drift_cron_jobs() to ci_drift_reader;",
    ]) expect(block).toContain(statement);
    for (const refusal of [
      "ci_drift_reader still has BYPASSRLS",
      "ci_drift_reader still has USAGE on schema cron",
      "ci_drift_reader is still a member of another role",
      "ci_drift_reader cannot execute private.ci_drift_cron_jobs()",
      "ci_drift_reader can still execute a SECURITY DEFINER function other than private.ci_drift_cron_jobs()",
    ]) expect(block).toContain(`raise exception '${refusal}'`);
  });

  it("lets the contract check read cron through the function only when this login may execute it (gate r1g1)", () => {
    const verifier = read("scripts/verify-db-contract.mjs");
    expect(verifier).toContain("pg_catalog.has_function_privilege(current_user, pg_catalog.to_regprocedure('private.ci_drift_cron_jobs()'), 'EXECUTE')");
    expect(verifier).toContain("pg_catalog.has_schema_privilege(current_user, 'private', 'USAGE')");
    expect(verifier).toContain('"select jobname, schedule, active, command from cron.job"');
  });

  it("pins the function in the contract with no client EXECUTE and no cast", () => {
    const contract = JSON.parse(read("scripts/db-contract.json"));
    const entry = contract.functions.find((candidate) => candidate.sig === "private.ci_drift_cron_jobs()");
    expect(entry).toMatchObject({ secdef: true, exec: "", volatility: "s" });
    expect(entry.bodyForbids).toEqual(expect.arrayContaining(["cron.schedule", "::"]));
    expect(contract.functions.find((candidate) => candidate.sig === "private.member_receipt_code()").exec).toBe("");
    // This edition has no points economy: the award function is dropped outright.
    expect(contract.functions.find((candidate) => candidate.sig === "private.award_member_points()")).toBeUndefined();
    expect(contract.functionsAbsent.map((candidate) => candidate.sig)).toContain("private.award_member_points()");
    for (const sig of ["private.award_member_points()", "private.member_receipt_code()"]) {
      expect(contract.knownGaps.publicExecuteOnPrivateFunctions.entries).not.toContain(sig);
    }
  });
});
