// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260919013000_mi1_dues_oauth_ready_connection_audit";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const predecessorSql = loadMigrationSql("20260918080000_mi1_dues_oauth_recovery_lease_release");

function replacedBody(source, file = `${NAME}.sql`) {
  const fn = parseFunctions(source, file)
    .find((entry) => entry.name === "public.get_pending_dues_stripe_oauth_exchange");
  expect(fn).toBeTruthy();
  return fn;
}

describe("Dues OAuth ready-connection recovery audit migration", () => {
  it("runs as one forward-only transaction after the body it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260919012000_mi1_dues_oauth_recovery_account_check").toBe(true);
    expect(NAME > "20260918080000_mi1_dues_oauth_recovery_lease_release").toBe(true);
  });

  it("admits only the reviewed 20260918080000 body as its predecessor", () => {
    expect(sql).toContain(
      "if digest is distinct from '7caa2b9f9eaf09432f9bb239785438a9e741edce042121447cbbc120bfbb21bd' then",
    );
    expect(replacedBody(predecessorSql, "20260918080000.sql").sourceSha256)
      .toBe("7caa2b9f9eaf09432f9bb239785438a9e741edce042121447cbbc120bfbb21bd");
  });

  it("keeps the installation lock wrapper as the first statement of the replaced body", () => {
    expect(replacedBody(sql).source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("audits a ready-connection quarantine only when the UPDATE matched a row", () => {
    const source = stripComments(replacedBody(sql).source);
    expect(source).toContain("if found then");
    expect(source).toContain("'dues_stripe_oauth_recovery_required'");
    expect(source).toContain("'superseded_by_ready_connection'");
    expect(source).toContain("'recorded_exchange_ambiguous'");
    expect(source).toContain("jsonb_build_object('state', 'none')");
    // The predecessor wrote no ready-connection audit.
    expect(stripComments(replacedBody(predecessorSql, "20260918080000.sql").source))
      .not.toContain("superseded_by_ready_connection");
  });

  it("re-derives the live source digest from the replaced body and pins it", () => {
    const fn = replacedBody(sql);
    expect(createHash("sha256").update(fn.source).digest("hex")).toBe(fn.sourceSha256);
    expect(fn.sourceSha256).toBe("0dd809feef3c32f2ea88877bd5498e1875004368d9512f5499e76d4852867ee7");
    expect(sql).toContain(
      "if digest is distinct from '0dd809feef3c32f2ea88877bd5498e1875004368d9512f5499e76d4852867ee7' then",
    );
  });

  it("changes nothing but that one function", () => {
    expect(code).not.toMatch(/\balter table\b/i);
    expect(code).not.toMatch(/\bcreate (?:table|policy|index|trigger)\b/i);
    expect(code).not.toMatch(/\bdrop constraint\b/i);
    expect(parseFunctions(sql, `${NAME}.sql`).map((entry) => entry.name))
      .toEqual(["public.get_pending_dues_stripe_oauth_exchange"]);
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });
});
