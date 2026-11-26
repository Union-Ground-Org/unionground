// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260925985000_dues_stripe_readiness_identity_gate";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const originalSql = loadMigrationSql("20260831223000_mi1_dues_exact_head_repairs");

const IDENTITY_GATE = [
  "from private.dues_financial_identity_selections selection",
  "selection.organization_id = p_organization_id",
  "selection.user_id = p_requested_by",
  "selection.selected_hat = p_selected_hat",
  "dues Stripe readiness financial identity unavailable",
];

function readinessBody(source, file = `${NAME}.sql`) {
  const fn = parseFunctions(source, file)
    .find((entry) => entry.name === "public.read_dues_stripe_account_for_test");
  expect(fn).toBeTruthy();
  return fn;
}

describe("Dues Stripe readiness financial-identity gate migration", () => {
  it("runs as one forward-only transaction after the body it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260831223000_mi1_dues_exact_head_repairs").toBe(true);
  });

  it("admits only the reviewed, unwrapped 20260831223000 body as its predecessor", () => {
    const original = readinessBody(originalSql, "20260831223000.sql");
    expect(createHash("sha256").update(original.source).digest("hex"))
      .toBe("93ca879324f5e8ed1f2ca87291625ae04f2e35b6b8c1ea1498c7a827c1d1fc92");
    expect(sql).toContain(
      "if digest is distinct from '93ca879324f5e8ed1f2ca87291625ae04f2e35b6b8c1ea1498c7a827c1d1fc92' then",
    );
  });

  it("requires the server-assigned financial identity the Main body never checked", () => {
    const repaired = stripComments(readinessBody(sql).source);
    for (const needle of IDENTITY_GATE) expect(repaired).toContain(needle);
    const original = stripComments(readinessBody(originalSql, "20260831223000.sql").source);
    expect(original).not.toContain("private.dues_financial_identity_selections");
  });

  it("keeps every authorization term the Main body already carried", () => {
    const repaired = stripComments(readinessBody(sql).source);
    for (const needle of [
      "auth.jwt() ->> 'role'",
      "p_selected_hat not in ('admin', 'vp')",
      "membership.organization_id = p_organization_id",
      "membership.user_id = p_requested_by",
      "membership.status = 'active'",
      "role_grant.role = p_selected_hat",
      "connection.state = 'ready'",
      "'^[A-Za-z0-9_:-]{3,255}$'",
    ]) expect(repaired).toContain(needle);
    expect(repaired).toContain("'accountId', account_id");
  });

  it("leaves the caller-JWT MFA predicate out of a service-role-only routine", () => {
    // private.mfa_satisfied() reads auth.uid()/session_id/aal from the CALLER's
    // JWT. Under the service-role JWT this routine demands, auth.uid() is null,
    // so the predicate would be false for every invocation and would refuse the
    // one production caller. The MFA term for the same request is enforced
    // upstream by get_dues_provider_status -> private.dues_require_financial_hat.
    expect(code).not.toContain("private.mfa_satisfied()");
    const guard = stripComments(
      loadMigrationSql("20260831170400_mi1_dues_settlement_reconciliation"),
    );
    expect(guard).toContain("if not private.mfa_satisfied() then");
  });

  it("restates the service-only boundary and re-derives the live source digest", () => {
    expect(code).toContain(
      "revoke all on function public.read_dues_stripe_account_for_test(uuid, uuid, text)\n  from public, anon, authenticated;",
    );
    expect(code).toContain(
      "grant execute on function public.read_dues_stripe_account_for_test(uuid, uuid, text) to service_role;",
    );
    expect(code).not.toMatch(/grant execute on function public\.read_dues_stripe_account_for_test\(uuid, uuid, text\) to (?:authenticated|anon)/);
    const fn = readinessBody(sql);
    expect(createHash("sha256").update(fn.source).digest("hex")).toBe(fn.sourceSha256);
    expect(fn.sourceSha256).toBe("e24b4681feab762e4e581307142a1f808a7dbbc02abadb8813bbf0cbd729db66");
    expect(sql).toContain(
      "if digest is distinct from 'e24b4681feab762e4e581307142a1f808a7dbbc02abadb8813bbf0cbd729db66' then",
    );
  });

  it("changes nothing but that one function", () => {
    expect(parseFunctions(sql, `${NAME}.sql`).map((entry) => entry.name))
      .toEqual(["public.read_dues_stripe_account_for_test"]);
    expect(code).not.toMatch(/\balter table\b/i);
    expect(code).not.toMatch(/\bcreate (?:table|policy|index|trigger)\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });
});
