// @vitest-environment node
// Offline pins for 20261003061000_end_member_auth_sessions.sql
// (BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003). The live behaviour
// is proved by tests/end-member-auth-sessions-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { foreignKeyRelevance, helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "_end_member_auth_sessions.sql";
const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("end_member_auth_sessions migration (static)", () => {
  const name = findMigrationName(MIGRATION);
  const sql = loadMigrationSql(MIGRATION);
  const code = stripComments(sql);
  const functions = parseFunctions(sql, name);

  it("is one short transaction that adds one function and no foreign key", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(foreignKeyRelevance(sql)).toBeNull();
    expect(functions.map((fn) => fn.name)).toEqual(["public.end_member_auth_sessions"]);
    expect(code).toContain("notify pgrst, 'reload schema';");
  });

  it("takes the graph gate and then the exclusive Auth bookkeeping lock before anything else", () => {
    const source = functions[0].source;
    expect(helperFirst(source)).toBe(true);
    expect(source).toMatch(/^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n {2}perform pg_catalog\.pg_advisory_xact_lock\(509, 701\);\n/);
    expect(source.indexOf("service_role")).toBeGreaterThan(source.indexOf("pg_advisory_xact_lock(509, 701)"));
    expect(source).toContain("delete from auth.sessions s where s.user_id = p_user_id;");
  });

  it("lets only the service role call it", () => {
    expect(code).toContain("revoke all on function public.end_member_auth_sessions(uuid)\n  from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.end_member_auth_sessions(uuid) to service_role;");
    expect(code).not.toMatch(/to (anon|authenticated)\s*;/);
  });

  it("is reviewed as an explicit-exclusive Auth bookkeeping writer and recorded in the database contract", () => {
    const review = json("../scripts/account-case-graph-review.json").auth_bookkeeping_exemptions.reviewed_gated_auth_functions;
    expect(review["public.end_member_auth_sessions"]).toMatchObject({ tables: ["auth.sessions"], mode: "explicit-exclusive" });
    const entry = json("../scripts/db-contract.json").functions.find((fn) => fn.sig === "public.end_member_auth_sessions(p_user_id uuid)");
    expect(entry).toMatchObject({ secdef: true, exec: "service_role" });
  });

  it("is what the recovery routes call to end sessions", () => {
    const helper = readFileSync(new URL("../api/_lib/memberSigninRecovery.js", import.meta.url), "utf8");
    expect(helper).toContain('"end_member_auth_sessions", { p_user_id: userId }');
    const reset = readFileSync(new URL("../api/admin-mfa-reset.js", import.meta.url), "utf8");
    expect(reset).toContain("revoked = await logoutAuthUser(supabaseUrl, serviceRoleKey, userId);");
  });
});
