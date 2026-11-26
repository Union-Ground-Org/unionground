// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("assurance_synthetic_account_lookup");
const code = stripComments(sql);
const body = stripComments(fnBody(sql, "public.list_stale_assurance_accounts"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("deployed legacy assurance-account ownership registry", () => {
  it("maintains a private ownership registry for only the two owned identity shapes", () => {
    expect(code).toContain("create table if not exists private.assurance_synthetic_accounts");
    expect(code).toContain("user_id uuid primary key references auth.users(id) on delete cascade");
    expect(code).toContain("create index if not exists assurance_synthetic_accounts_stale_idx");
    expect(code).toContain("on private.assurance_synthetic_accounts (created_at, user_id)");
    expect(code).toContain("email like 'assurance-browserbase-%@example.test'");
    expect(code).toContain("email ~ '^browserbase-[a-f0-9]{16}@example[.]test$'");
    expect(code).toContain("after insert or update of email on auth.users");
    expect(code).toContain("execute function private.capture_assurance_synthetic_account()");
  });

  it("returns only UUID/timestamp cursor data from an indexed, bounded query", () => {
    expect(body).toContain("from private.assurance_synthetic_accounts a");
    expect(body).toContain("(a.created_at, a.user_id) > (p_after_created_at, p_after_id)");
    expect(body).toContain("limit p_limit + 1");
    expect(body).toContain("p_limit > 100");
    expect(body).toContain("'id', candidate.user_id");
    expect(body).toContain("'createdAt', pg_catalog.to_char");
    expect(body).not.toContain("'email',");
  });

  it("is fail-closed and callable only by service_role", () => {
    expect(body).toContain("is distinct from 'service_role'");
    expect(body).toContain("set search_path = ''");
    expect(code).toContain(
      "revoke all on function public.list_stale_assurance_accounts(timestamptz, timestamptz, uuid, integer)",
    );
    expect(code).toContain(
      "grant execute on function public.list_stale_assurance_accounts(timestamptz, timestamptz, uuid, integer)",
    );
    expect(code).toContain("to service_role");
  });

  it("is wired into the live database contract", () => {
    const fn = contract.functions.find((entry) => entry.sig.startsWith("public.list_stale_assurance_accounts("));
    expect(fn?.exec).toBe("service_role");
    expect(fn?.secdef).toBe(true);
    expect(fn?.bodyContains).toContain("limit p_limit + 1");
  });
});
