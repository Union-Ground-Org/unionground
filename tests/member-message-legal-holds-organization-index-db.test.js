// @vitest-environment node
//
// PERF-UG-MESSAGE-LEGAL-HOLDS-ORG-INDEX-MISSING-20260921.
//
// public.member_message_legal_holds is keyed on conversation_id, and its
// organization_id foreign key to public.organizations went unindexed from the
// day the table was created. The offline half pins the migration text and the
// contract entry (scripts/db-contract.json #indexes is where verify:db asserts
// it). The live half (disposable loopback only) reads pg_indexes and EXPLAINs
// the admin list's organization predicate.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const INDEX = "member_message_legal_holds_organization_idx";
const allMigrations = migrationNames();
const migrationName = findMigrationName("member_message_legal_holds_organization_index");
const sql = loadMigrationSql("member_message_legal_holds_organization_index");
// The header explains why the index is not partial, so every pin below runs
// against executable SQL only.
const statements = stripComments(sql).replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member_message_legal_holds organization index migration", () => {
  it("is ordered after the migrations that create the table and its reader", () => {
    expect(migrationName).toMatch(/^\d{14}_member_message_legal_holds_organization_index\.sql$/);
    for (const fragment of [
      "20260907121000_member_message_body_lifecycle", // creates the table and the FK
      "20260917120000_admin_mfa_reset_notice_and_legal_hold_surface", // list_member_message_legal_holds
    ]) {
      const dependency = allMigrations.find((entry) => entry.includes(fragment));
      expect(dependency, `dependency migration "${fragment}"`).toBeDefined();
      expect(
        migrationName.localeCompare(dependency),
        `${migrationName} must sort after ${dependency}`,
      ).toBeGreaterThan(0);
    }
  });

  it("carries the reference tag and is one atomic apply", () => {
    expect(sql).toContain("PERF-UG-MESSAGE-LEGAL-HOLDS-ORG-INDEX-MISSING-20260921");
    expect(statements.startsWith("begin;")).toBe(true);
    expect(statements.endsWith("commit;")).toBe(true);
  });

  it("creates the index idempotently, schema-qualified, on the unindexed foreign key", () => {
    expect(statements).toContain(
      `create index if not exists ${INDEX} on public.member_message_legal_holds (organization_id);`,
    );
    const created = statements.match(/create index[^;]*;/g) ?? [];
    expect(created).toHaveLength(1);
  });

  it("indexes the whole column, so the foreign key's own checks can use it", () => {
    // A partial index on `released_at is null` is the tighter fit for the admin
    // list, and it is what a reader optimizing only that query would reach for.
    // PostgreSQL's referential-integrity checks cannot use a partial index, so
    // the partial form would leave the ON UPDATE CASCADE / ON DELETE RESTRICT
    // walk exactly as uncovered as it was. The full column is the point.
    const created = (statements.match(/create index[^;]*;/g) ?? [])[0] ?? "";
    expect(created).not.toMatch(/\bwhere\b/i);
    expect(sql).toContain("referential");
  });

  it("follows the plain-CREATE-INDEX precedent and documents the caveat", () => {
    // CONCURRENTLY cannot run inside a transaction block and this repository
    // applies migrations through the single-transaction path.
    expect(statements).not.toMatch(/concurrently/i);
    expect(sql).toContain("CONCURRENTLY cannot run inside a transaction block");
  });

  it("stays additive: no grant, policy, constraint, function or row is touched", () => {
    expect(statements).not.toMatch(/grant |revoke /i);
    expect(statements).not.toMatch(/create policy|drop policy|alter policy/i);
    expect(statements).not.toMatch(/alter table|drop index|drop table/i);
    expect(statements).not.toMatch(/create (or replace )?function|create trigger/i);
    expect(statements).not.toMatch(/insert into|update |delete from/i);
  });

  it("names no message content in the index comment, like the table it covers", () => {
    expect(statements).toContain(`comment on index public.${INDEX} is`);
    expect(statements).not.toMatch(/\bbody\b/i);
  });
});

describe("the legal-hold table is no longer indexed by its primary key alone", () => {
  it("has exactly one index statement across every migration, and it is this one", () => {
    const creators = allMigrations.filter((name) => {
      const executable = stripComments(loadMigrationSql(name));
      return /create\s+(?:unique\s+)?index[^;]*\bon\s+(?:public\.)?member_message_legal_holds\b/i.test(executable);
    });
    expect(creators).toEqual([migrationName]);
  });

  it("records the index in the contract so verify:db asserts it against the catalog", () => {
    const entry = contract.indexes.find((row) => row.name === INDEX);
    expect(entry, "an index the contract does not list is never checked").toBeTruthy();
    // verify-db-contract.mjs projects a public index's table bare.
    expect(entry.table).toBe("member_message_legal_holds");
    expect(entry.defContains).toContain("USING btree (organization_id)");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("the live legal-hold admin list plans an organization_id index condition", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-message-legal-holds-organization-index-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    // enable_seqscan=off asks whether an organization_id index path EXISTS;
    // before the repair the plan keeps a bare Filter on organization_id.
    await client.query("set local enable_seqscan = off");
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("installs the full-column index on the live catalogue", async () => {
    const { rows } = await client.query(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = $1",
      [INDEX],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("USING btree (organization_id)");
    expect(rows[0].indexdef).not.toContain("WHERE");
  });

  it("serves list_member_message_legal_holds' predicate from the index", async () => {
    const { rows } = await client.query(
      `explain (costs off) select h.conversation_id from public.member_message_legal_holds h
        where h.organization_id = $1 and h.released_at is null
        order by h.placed_at desc limit 100`,
      ["00000000-0000-4000-8000-0000000c0de1"],
    );
    const text = rows.map((row) => row["QUERY PLAN"]).join("\n");
    expect(text).toContain(INDEX);
    expect(text).toMatch(/Index Cond: \(organization_id = /);
  });
});
