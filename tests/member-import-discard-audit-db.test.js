// @vitest-environment node
//
// SEC-UG-MEMBER-IMPORT-DISCARD-AUDIT-20260921
//
// public.discard_member_operations_import deleted a staged batch's rows with
// no organization audit event, while the commit path records one.
// 20260925550000 admits member_operations_import_discarded and appends one
// content-free event (batch id, import kind, deleted row count) per discard.
//
// The offline half pins the migration text and the db-contract entry. The
// live half (disposable loopback only) discards a staged batch through the
// real RPC as an MFA-verified admin and reads the tenant audit table.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("member_import_discard_tenant_audit"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member import discard audit migration", () => {
  it("sorts after the engagement taxonomy vocabulary, inside one bounded transaction", () => {
    const name = findMigrationName("member_import_discard_tenant_audit");
    expect(name).toBe("20260925550000_member_import_discard_tenant_audit.sql");
    expect(name > "20260925120000_engagement_audit_event_taxonomy.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("keeps the case-graph entry lock first and audits after the counted delete", () => {
    const body = squash(fnBody(sql, "public.discard_member_operations_import"));
    expect(body).toContain("as $function$ begin perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]); declare org uuid");
    const refused = body.indexOf("raise exception 'batch is not discardable'");
    const deleted = body.indexOf("delete from public.organization_import_rows");
    const counted = body.indexOf("get diagnostics discarded = row_count;");
    const audited = body.indexOf("perform private.mi1_w2_write_audit(org, 'member_operations_import_discarded'");
    const receipt = body.indexOf("perform private.member_operations_store_receipt(");
    expect(refused).toBeGreaterThan(-1);
    expect(deleted).toBeGreaterThan(refused);
    expect(counted).toBeGreaterThan(deleted);
    expect(audited).toBeGreaterThan(counted);
    expect(receipt).toBeGreaterThan(audited);
    expect(body).toContain("'organizationId', org, 'batchId', p_batch_id, 'kind', batch_kind, 'count', discarded");
    expect(body).not.toMatch(/normalized_data|validation_errors|filename/);
  });

  it("pins the discard body and the widened event-type check in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.discard_member_operations_import(p_batch_id uuid, p_idempotency_key uuid)");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "get diagnostics discarded = row_count",
      "private.mi1_w2_write_audit(org, 'member_operations_import_discarded'",
    ]));
    const check = contract.constraints.find((row) => row.name === "organization_audit_events_event_type_check");
    expect(check.defContains).toEqual(expect.arrayContaining(["member_operations_import_discarded", "live_poll_transitioned"]));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("discarding a staged import appends one content-free tenant audit event", () => {
  let client;
  const id = Object.fromEntries([
    "admin", "adminSession", "org", "batch", "committedBatch", "discardKey",
  ].map((key) => [key, randomUUID()]));
  const chapter = `mida-${id.org}`;

  const discard = async (batch, key = randomUUID()) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: id.admin, session_id: id.adminSession, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
    try {
      const result = await client.query("select public.discard_member_operations_import($1,$2) as out", [batch, key]);
      return result.rows[0].out;
    } finally {
      // After a refusal the transaction is aborted until the caller rolls
      // back to its savepoint; keep the refusal as the thrown error.
      await client.query("reset role").catch(() => {});
    }
  };

  const events = async () => (await client.query(
    "select event_type, actor_user_id, metadata from public.organization_audit_events where organization_id=$1 and event_type='member_operations_import_discarded' order by created_at, id",
    [id.org],
  )).rows;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-import-discard-audit-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"full_name\":\"Synthetic Admin\"}')", [id.admin, `${id.admin}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [id.adminSession, id.admin]);
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic discard factor','totp','verified',now(),now())", [randomUUID(), id.admin]);
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `mida-${id.org}`, id.admin]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9951)", [chapter, id.org]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapter, id.admin]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, id.admin]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id.admin, chapter]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id.admin, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.org, id.admin]);

    for (const [batch, state] of [[id.batch, "validated"], [id.committedBatch, "committed"]]) {
      await client.query(
        "insert into public.organization_import_batches(id,organization_id,kind,filename,state,row_count,created_by) values($1,$2,'grievance','synthetic.csv',$3,3,$4)",
        [batch, id.org, state, id.admin],
      );
      for (const row of [1, 2, 3]) {
        await client.query(
          "insert into public.organization_import_rows(organization_id,batch_id,row_number,normalized_data) values($1,$2,$3,jsonb_build_object('email',$4::text))",
          [id.org, batch, row, `staged-${row}@example.invalid`],
        );
      }
    }
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("deletes the staged rows and records the actor, batch, kind and count only", async () => {
    expect(await discard(id.batch, id.discardKey)).toEqual({ id: id.batch, state: "discarded" });
    const remaining = await client.query("select count(*)::int as n from public.organization_import_rows where batch_id=$1", [id.batch]);
    expect(remaining.rows[0].n).toBe(0);
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBe(id.admin);
    expect(rows[0].metadata).toEqual({ organizationId: id.org, batchId: id.batch, kind: "grievance", count: 3 });
    expect(JSON.stringify(rows[0].metadata)).not.toContain("example.invalid");
  });

  it("appends nothing on an idempotent replay of the same discard", async () => {
    expect(await discard(id.batch, id.discardKey)).toEqual({ id: id.batch, state: "discarded" });
    expect(await events()).toHaveLength(1);
  });

  it("refuses a batch that is not discardable and appends no event", async () => {
    await client.query("savepoint refused");
    await expect(discard(id.committedBatch)).rejects.toMatchObject({ code: "55000" });
    await client.query("rollback to savepoint refused");
    const remaining = await client.query("select count(*)::int as n from public.organization_import_rows where batch_id=$1", [id.committedBatch]);
    expect(remaining.rows[0].n).toBe(3);
    expect(await events()).toHaveLength(1);
  });
});
