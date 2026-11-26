// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import pg from "pg";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { runFinanceProof } from "./helpers/chapter-finance-proof.mjs";

const directory = new URL("../supabase/migrations/", import.meta.url);
const file = readdirSync(directory).find(name => name.endsWith("_chapter_treasurer_financial_duties.sql"));
const migration = readFileSync(new URL(file, directory), "utf8");
describe("Treasurer financial authority", () => {
  it("keeps finance private, atomic, and separate from money movement", () => {
    expect(migration).toContain("begin;");
    expect(migration.trimEnd()).toBeTruthy();
    expect(migration.trimEnd().endsWith("commit;")).toBe(true);
    for (const table of ["chapter_financial_documents", "chapter_financial_requests"]) {
      expect(migration).toContain(`alter table private.${table} force row level security`);
    }
    expect(migration).toContain("private.chapter_finance_can");
    expect(migration).toContain("financial publication access required");
    expect(migration).not.toMatch(/(?:stripe|plaid|create_payment|transfer_funds)/i);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("Treasurer on a disposable database", () => {
  it("proves roles, grants, publication, requests, denials, revocation and invitation acceptance", async () => {
    const db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-treasurer-proof" });
    await db.connect();
    await db.query("begin");
    try {
      const passed = await runFinanceProof(db);
      console.info("Treasurer live checks:", passed);
      expect(passed).toBeGreaterThanOrEqual(65);
    } finally {
      await db.query("rollback");
      await db.end();
    }
  }, 120000);
});
