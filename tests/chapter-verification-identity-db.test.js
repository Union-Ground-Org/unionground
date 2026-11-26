// @vitest-environment node
//
// REQ-UG-DORMANT-64-CHAPTER-LIFECYCLE-FLOWS-20260917, review finding 2.
//
// The two chapter verification RPCs run under the service role — a machine
// credential that names nobody. Static SQL pins can show that
// 20260917141000_chapter_verification_identity adds p_verified_by; only a live
// apply shows that the binding row, the readiness row and the append-only
// tenant ledger really carry the reviewer afterwards, that the ledger row
// survives the table's closed domain/action/entity_type/metadata-key
// vocabularies without widening any of them, and that a service-role caller
// who omits the verifier is refused before the row moves. The static half below
// keeps the migration and the db-contract needles pinned without a database.
//
// Everything in the live half runs inside one transaction that is rolled back,
// against fixtures this proof creates itself, so the shared disposable
// catalogue keeps no synthetic organization, chapter, binding or audit row.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const IDS = {
  org: "50906400-0000-4000-8000-000000000001",
  reviewer: "50906400-0000-4000-8000-000000000101",
  requester: "50906400-0000-4000-8000-000000000102",
  stranger: "50906400-0000-4000-8000-0000000001ff",
};
const CHAPTER = "verification-identity-proof";
const UNION_ORG = "509-verification-identity-fixture";

const sql = stripComments(loadMigrationSql("chapter_verification_identity"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("chapter verification identity migration", () => {
  it("sorts after the pg_net tick request-id migration it was written against and replaces both identity-less verifiers", () => {
    expect(findMigrationName("chapter_verification_identity") > "20260915180000_pg_net_tick_request_id_idempotency.sql").toBe(true);
    expect(sql).toContain("drop function public.verify_chapter_union_org_binding(text, text, boolean, text);");
    expect(sql).toContain("drop function public.verify_chapter_connection_setup(text, text, text, text);");
    expect(sql).toContain("add column verified_by uuid references auth.users(id) on delete set null");
    // Both bodies refuse a null verifier before the row moves, and the audit
    // row lands in the existing tenant ledger rather than a parallel authority.
    expect(sql.split("raise exception 'verifier identity required' using errcode = '42501'")).toHaveLength(3);
    expect(sql.split("insert into public.organization_audit_ledger")).toHaveLength(3);
  });

  it("pins the five-argument signatures and their service-role-only grants in the db contract", () => {
    for (const [sig, args] of [
      ["public.verify_chapter_union_org_binding", "text, text, boolean, text, uuid"],
      ["public.verify_chapter_connection_setup", "text, text, text, text, uuid"],
    ]) {
      const entry = contract.functions.find((candidate) => candidate.sig.startsWith(`${sig}(`));
      expect(entry?.sig, sig).toContain("p_verified_by uuid");
      expect(entry?.exec).toBe("service_role");
      expect(entry?.bodyContains).toContain("verifier identity required");
      expect(entry?.bodyContains).toContain("public.organization_audit_ledger");
      expect(contract.functionsAbsent.some((absent) => absent.sig.startsWith(`${sig}(`))).toBe(true);
      expect(sql).toContain(`grant execute on function ${sig}(${args}) to service_role;`);
    }
  });
});

const live = process.env.RUN_CHAPTER_VERIFICATION_IDENTITY_DB_TESTS === "1" ? describe : describe.skip;

async function asServiceRole(client, statement, values = []) {
  await client.query("savepoint verification_probe");
  try {
    await client.query("select set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)");
    const result = await client.query(statement, values);
    await client.query("release savepoint verification_probe");
    return { code: "", rows: result.rows };
  } catch (error) {
    await client.query("rollback to savepoint verification_probe");
    return { code: error.code || "?", message: error.message || "", rows: [] };
  }
}

live("chapter verification records the reviewer who made the decision", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapter-verification-identity-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");

    // The identity migration must be the installed generation; a four-argument
    // survivor would make every assertion below vacuous.
    const { rows } = await client.query(`
      select
        to_regprocedure('public.verify_chapter_union_org_binding(text,text,boolean,text,uuid)') is not null as binding_current,
        to_regprocedure('public.verify_chapter_connection_setup(text,text,text,text,uuid)') is not null as connection_current,
        to_regprocedure('public.verify_chapter_union_org_binding(text,text,boolean,text)') is not null as binding_legacy,
        to_regprocedure('public.verify_chapter_connection_setup(text,text,text,text)') is not null as connection_legacy
    `);
    if (!rows[0].binding_current || !rows[0].connection_current) {
      throw new Error("the disposable stack must have 20260917141000_chapter_verification_identity applied");
    }
    if (rows[0].binding_legacy || rows[0].connection_legacy) {
      throw new Error("the identity-less four-argument verifiers must be dropped, not overloaded");
    }

    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'chapter-verification-reviewer@example.test'),
       ($2, 'chapter-verification-requester@example.test')`,
      [IDS.reviewer, IDS.requester],
    );
    // Only a platform operator decides a binding
    // (SEC-UG-TENANT-SELF-VERIFIED-UNION-OFFICE-BINDINGS-20261101).
    await client.query(
      "insert into private.compass_platform_operators (user_id, granted_note) values ($1, 'verification identity proof operator')",
      [IDS.reviewer],
    );
    await client.query(
      "insert into public.organizations (id, slug, name, created_by) values ($1, 'verification-identity-org', 'Verification Identity Org', $2)",
      [IDS.org, IDS.reviewer],
    );
    // This proof owns its tenant, chapter and registry row, so it never depends
    // on — or disturbs — the shared chapters the rest of the required lane uses.
    await client.query(
      "insert into public.chapters (id, name, slug, order_index, organization_id) values ($1, 'Verification Identity Proof', $1, 9001, $2)",
      [CHAPTER, IDS.org],
    );
    await client.query(
      `insert into public.union_orgs (id, olms_file_number, name, level, enrichment_status, atlas_manifest_sha)
       values ($1, 990000509, 'Verification Identity Local', 'local', 'no_web_presence', 'fixture')`,
      [UNION_ORG],
    );
    await client.query(
      `insert into public.chapter_union_org_bindings (chapter_id, union_org_id, status, requested_by)
       values ($1, $2, 'requested', $3)`,
      [CHAPTER, UNION_ORG, IDS.requester],
    );
    await client.query(
      `insert into public.chapter_connection_readiness (chapter_id, capability, status, requested_by)
       values ($1, 'sms', 'configuring', $2)`,
      [CHAPTER, IDS.requester],
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses a service-role binding verification that names no reviewer, and leaves the request untouched", async () => {
    const omitted = await asServiceRole(
      client,
      "select public.verify_chapter_union_org_binding($1, $2, true, 'No reviewer') as result",
      [CHAPTER, UNION_ORG],
    );
    expect(omitted.code).toBe("42501");
    expect(omitted.message).toMatch(/verifier identity required/);

    const explicitNull = await asServiceRole(
      client,
      "select public.verify_chapter_union_org_binding($1, $2, true, 'No reviewer', null) as result",
      [CHAPTER, UNION_ORG],
    );
    expect(explicitNull.code).toBe("42501");

    const unknown = await asServiceRole(
      client,
      "select public.verify_chapter_union_org_binding($1, $2, true, 'Ghost', $3) as result",
      [CHAPTER, UNION_ORG, IDS.stranger],
    );
    expect(unknown.code).toBe("22023");
    expect(unknown.message).toMatch(/verifier unavailable/);

    const { rows } = await client.query(
      "select status, verified_by, verified_at from public.chapter_union_org_bindings where chapter_id = $1",
      [CHAPTER],
    );
    expect(rows[0]).toEqual({ status: "requested", verified_by: null, verified_at: null });
  });

  it("refuses a connection verification that names no reviewer", async () => {
    const omitted = await asServiceRole(
      client,
      "select public.verify_chapter_connection_setup($1, 'sms', 'active', 'Ready') as result",
      [CHAPTER],
    );
    expect(omitted.code).toBe("42501");
    expect(omitted.message).toMatch(/verifier identity required/);

    const { rows } = await client.query(
      "select status, verified_by, verified_at from public.chapter_connection_readiness where chapter_id = $1 and capability = 'sms'",
      [CHAPTER],
    );
    expect(rows[0]).toEqual({ status: "configuring", verified_by: null, verified_at: null });
  });

  it("stores the reviewer on the binding row and names them in the tenant ledger", async () => {
    const verified = await asServiceRole(
      client,
      "select public.verify_chapter_union_org_binding($1, $2, true, 'Charter on file', $3) as result",
      [CHAPTER, UNION_ORG, IDS.reviewer],
    );
    expect(verified.code).toBe("");
    expect(verified.rows[0].result).toMatchObject({ verified: true, chapterId: CHAPTER, verifiedBy: IDS.reviewer });

    const { rows } = await client.query(
      "select status, verified_by, public_note, verified_at is not null as stamped from public.chapter_union_org_bindings where chapter_id = $1",
      [CHAPTER],
    );
    expect(rows[0]).toEqual({
      status: "verified", verified_by: IDS.reviewer, public_note: "Charter on file", stamped: true,
    });

    const ledger = await client.query(
      `select organization_id, domain, action, entity_type, entity_id, actor_user_id, metadata
       from public.organization_audit_ledger
       where event_type = 'chapter_union_org_binding_verified' and organization_id = $1`,
      [IDS.org],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      organization_id: IDS.org,
      domain: "administration",
      action: "update",
      entity_type: "chapter",
      entity_id: CHAPTER,
      actor_user_id: IDS.reviewer,
    });
    expect(ledger.rows[0].metadata).toEqual({
      chapterId: CHAPTER,
      userId: IDS.reviewer,
      entityType: "union_org",
      entityId: UNION_ORG,
      fromStatus: "requested",
      toStatus: "verified",
    });
  });

  it("stores the reviewer on the readiness row and names them in the tenant ledger", async () => {
    const activated = await asServiceRole(
      client,
      "select public.verify_chapter_connection_setup($1, 'sms', 'active', 'Chapter-owned sender verified', $2) as result",
      [CHAPTER, IDS.reviewer],
    );
    expect(activated.code).toBe("");
    expect(activated.rows[0].result).toMatchObject({
      chapter_id: CHAPTER, capability: "sms", status: "active", verified_by: IDS.reviewer,
    });

    const { rows } = await client.query(
      `select status, verified_by, public_message, verified_at is not null as stamped
       from public.chapter_connection_readiness where chapter_id = $1 and capability = 'sms'`,
      [CHAPTER],
    );
    expect(rows[0]).toEqual({
      status: "active",
      verified_by: IDS.reviewer,
      public_message: "Chapter-owned sender verified",
      stamped: true,
    });

    const ledger = await client.query(
      `select actor_user_id, metadata from public.organization_audit_ledger
       where event_type = 'chapter_connection_setup_verified' and organization_id = $1`,
      [IDS.org],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].actor_user_id).toBe(IDS.reviewer);
    expect(ledger.rows[0].metadata).toEqual({
      chapterId: CHAPTER,
      userId: IDS.reviewer,
      entityType: "connection_capability",
      entityId: "sms",
      fromStatus: "configuring",
      toStatus: "active",
    });
  });

  it("keeps the audit row append-only and keeps the verifiers out of every non-service role", async () => {
    await client.query("savepoint append_only_probe");
    await expect(client.query(
      `update public.organization_audit_ledger set actor_user_id = $1
       where event_type = 'chapter_union_org_binding_verified' and organization_id = $2`,
      [IDS.requester, IDS.org],
    )).rejects.toMatchObject({ code: "55000" });
    await client.query("rollback to savepoint append_only_probe");

    const { rows } = await client.query(`
      select role,
        has_function_privilege(role, 'public.verify_chapter_union_org_binding(text,text,boolean,text,uuid)', 'execute') as binding,
        has_function_privilege(role, 'public.verify_chapter_connection_setup(text,text,text,text,uuid)', 'execute') as connection
      from unnest(array['anon','authenticated','service_role']) as role
    `);
    expect(rows).toEqual([
      { role: "anon", binding: false, connection: false },
      { role: "authenticated", binding: false, connection: false },
      { role: "service_role", binding: true, connection: true },
    ]);
  });
});
