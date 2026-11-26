// @vitest-environment node
// CONTENT-UG-JOIN-FORM-SALES-TONE-20261018: offline pins for the
// migration that makes organization size and state optional on Request to
// join. The live proof is the size/state case in tests/request-to-join-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const NAME = "20261021044810_request_to_join_optional_size_state";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
const SIGNATURE = "(text, text, text, text, text, text, text, text, text, text, text)";

function submitBody() {
  const entry = parseFunctions(sql, `${NAME}.sql`).find((row) => row.name === "public.submit_join_request");
  expect(entry).toBeTruthy();
  return stripComments(entry.source);
}

describe("request-to-join optional size and state migration", () => {
  it("runs after the intake migration as one forward-only transaction", () => {
    const names = migrationNames();
    expect(names.indexOf(`${NAME}.sql`)).toBeGreaterThan(names.indexOf("20261017224500_request_to_join_intake.sql"));
    expect(names.indexOf("20261017224500_request_to_join_intake.sql")).toBeGreaterThan(-1);
    expect(code.trim().startsWith("begin;")).toBe(true);
    expect(code.trim().endsWith("commit;")).toBe(true);
    expect(code).toContain("notify pgrst, 'reload schema';");
    expect(code).not.toMatch(/\bdrop\s+(table|function|column)\b/i);
  });

  it("lets a request-to-join row carry no size or state while a given one must still be listed", () => {
    expect(code).toContain("drop constraint public_interest_submissions_request_to_join_shape;");
    expect(code).toContain("add constraint public_interest_submissions_request_to_join_shape check (");
    expect(code).toMatch(/and \(size_band is null\s+or size_band in \('under-100', '100-499', '500-1999', '2000-9999', '10000-plus'\)\)/);
    expect(code).toContain("and (state is null or state ~ '^[A-Z]{2}$' or state = 'outside-us')");
    // A landing row still carries none of the organization fields.
    expect(code).toMatch(/else\s+interest <> 'request_to_join'\s+and organization_name is null\s+and role is null\s+and size_band is null\s+and state is null/);
  });

  it("replaces submit_join_request with the same signature, grants and contract pins, optional size and state", () => {
    expect(code).toContain("create or replace function public.submit_join_request(");
    const body = submitBody();
    const entry = contract.functions.find((candidate) => candidate.sig.startsWith("public.submit_join_request("));
    for (const needle of entry.bodyContains) expect(body, needle).toContain(needle);
    for (const needle of entry.bodyForbids ?? []) expect(body, needle).not.toContain(needle);
    expect(body).toContain("size_band_value text := nullif(pg_catalog.btrim(coalesce(p_size_band, '')), '');");
    expect(body).toContain("state_value text := nullif(pg_catalog.btrim(coalesce(p_state, '')), '');");
    expect(body).toMatch(/or \(size_band_value is not null\s+and size_band_value not in \('under-100'/);
    expect(body).toMatch(/or \(state_value is not null and state_value <> all \(array\[/);
    expect(body).not.toMatch(/p_size_band is null|p_state is null/);
    expect(body).toContain("organization_name, p_role, size_band_value, state_value, phone, note, campaign_code");
    expect(code).toContain(`revoke all on function public.submit_join_request${SIGNATURE}\n  from public, anon, authenticated, service_role;`);
    expect(code).toContain(`grant execute on function public.submit_join_request${SIGNATURE}\n  to service_role;`);
    expect(code).not.toMatch(/grant\s+execute[^;]*to\s+[^;]*(anon|authenticated|public)/i);
  });
});
