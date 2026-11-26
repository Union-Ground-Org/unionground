// @vitest-environment node
//
// REQ-UG-POMS-FUNCTION-REMOVAL-20261003
//
// Owner decision, October 3, 2026: "yes delete it all. everything poms needs
// to go." 20261003070000 drops the three POMS tables (with every stored row)
// and the six POMS RPCs, deletes the POMS action history, retires the 'poms'
// library category and the SAMPLE demo-seed function CR-070, and keeps Field
// Notes and Action Lab working. These cases prove the end state on the fully
// migrated disposable database. The seed-then-migrate deletion count was
// proved once by hand on a disposable stack (PR body); a migrated database has
// no POMS rows left to count.
//
// Fictional tenant only (Example Workers Local 1); every row is rolled back.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "poms_function_removal";
const POMS_TABLES = ["organization_poms_sources", "organization_poms_ingest_chunks", "organization_poms_evidence"];
const POMS_RPCS = [
  "public.save_poms_source(text,text,text,text)",
  "public.update_poms_source(uuid,timestamptz,text,text,text,text)",
  "public.authorize_poms_ingestion(uuid,text)",
  "public.complete_poms_ingestion(uuid,uuid,uuid,timestamptz,text,text,text,jsonb,text)",
  "public.reconcile_poms_ingestion_completion(uuid,uuid,uuid,timestamptz,text,text)",
  "public.add_poms_evidence(uuid,timestamptz,text,text,text)",
];

describe("POMS removal migration (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("ships one atomic, lock-bounded forward migration", () => {
    expect(findMigrationName(MIGRATION)).toBe("20261003070000_poms_function_removal.sql");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    expect(sql).toContain("set local statement_timeout = '120s';");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("POMS removal on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "poms-removal-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query("begin");
  });

  afterEach(async () => {
    await client.query("rollback");
  });

  async function capture(statement, args) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, row: result.rows[0], code: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, row: null, code: error.code || "" };
    }
  }

  async function mfaAdmin() {
    const org = randomUUID();
    const chapter = `ewl1-${org}`;
    const admin = randomUUID();
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `ewl1-${org}`, `Example Workers Local 1 ${org}`]);
    await client.query(
      "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9961)",
      [chapter, org],
    );
    await client.query("insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())", [admin, `admin-${admin.slice(0, 8)}@ewl1.example`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [admin, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, admin]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [admin, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [org, admin]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), admin]);
    return { org, chapter, admin };
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  it("leaves no POMS table, RPC, policy, constraint value or routine text behind", async () => {
    for (const table of POMS_TABLES) {
      expect((await client.query("select to_regclass($1) as r", [`public.${table}`])).rows[0].r, table).toBeNull();
    }
    for (const signature of POMS_RPCS) {
      expect((await client.query("select to_regprocedure($1) as r", [signature])).rows[0].r, signature).toBeNull();
    }
    const residue = await client.query(`
      select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public','private') and p.prosrc ~* 'poms')::int as routines,
             (select count(*) from pg_policies where tablename ~* 'poms')::int as policies,
             (select count(*) from pg_constraint where pg_get_constraintdef(oid) ~* 'poms')::int as constraints`);
    expect(residue.rows[0]).toEqual({ routines: 0, policies: 0, constraints: 0 });
  });

  it("refuses a POMS action-history row and still records a Field Notes one", async () => {
    const { org } = await mfaAdmin();
    const insert = "insert into public.organization_object_action_runs(organization_id,target_kind,target_id,target_label,action_key,previous_state,resulting_state) values ($1,$2,$3,'Proof target',$4,'{}'::jsonb,'{}'::jsonb)";
    expect((await capture(insert, [org, "poms_source", randomUUID(), "mark_ready"])).code).toBe("23514");
    expect((await capture(insert, [org, "field_note_block", randomUUID(), "include"])).ok).toBe(true);
  });

  it("serves the evidence desk without POMS keys and runs Field Notes actions through the reusable action", async () => {
    const { admin } = await mfaAdmin();
    await actAs(admin);
    const note = await capture("select public.add_field_note_evidence('Listening session','interview','Recorded with consent','staffing','Overnight vacancies remain open.','') as v");
    expect(note.ok).toBe(true);
    const desk = (await capture("select public.get_administrative_evidence_desk(0) as v")).row.v;
    expect(Object.keys(desk).sort()).toEqual(["actionTargets", "actions", "fieldNoteBlocks", "hasNext", "history", "packets", "page", "pageSize"]);
    expect(Object.keys(desk.hasNext).sort()).toEqual(["actions", "notes"]);
    expect(desk.actions.map((action) => action.targetKind)).not.toContain("poms_source");
    expect(desk.fieldNoteBlocks).toHaveLength(1);
    expect((await capture("select public.get_administrative_evidence_desk(0, $1) as v", ["x".repeat(201)])).code).toBe("22023");
    expect((await capture("select public.execute_administrative_object_action('poms_source',$1,'mark_ready','') as v", [randomUUID()])).code).toBe("22023");
    const included = await capture("select public.execute_administrative_object_action('field_note_block',$1,'include','') as v", [note.row.v.id]);
    expect(included.ok).toBe(true);
    expect(included.row.v.targetKind).toBe("field_note_block");
  });

  it("retires the 'poms' library category everywhere a document type is checked", async () => {
    const check = await client.query("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'chapter_documents_document_type_check'");
    expect(check.rows[0].def).not.toMatch(/poms/);
    for (const kind of ["contract", "policy", "minutes", "training", "template", "other"]) expect(check.rows[0].def).toContain(`'${kind}'`);
    expect((await client.query("select count(*)::int as n from public.chapter_documents where document_type = 'poms'")).rows[0].n).toBe(0);
    const definition = (await client.query("select pg_get_functiondef('public.update_chapter_document_content(uuid,text,text,text,text,text,text)'::regprocedure) as d")).rows[0].d;
    expect(definition).toContain("p_document_type not in ('contract','policy','minutes','training','template','other')");
    expect(definition).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    expect(definition).toContain("perform private.lock_message_lifecycle();");
  });

  it("keeps the 114-function demo catalog with CR-070 owner-retired and no POMS page surfaces", async () => {
    const catalog = await client.query("select count(*)::int as n from private.demo_seed_function_catalog");
    expect(catalog.rows[0].n).toBe(114);
    const retired = await client.query("select coverage, evidence_key, gate_relation from private.demo_seed_function_catalog where function_id = 'CR-070'");
    expect(retired.rows[0]).toEqual({ coverage: "owner-retired", evidence_key: null, gate_relation: null });
    expect((await capture("update private.demo_seed_function_catalog set evidence_key = 'administrative-evidence' where function_id = 'CR-070'")).code).toBe("23514");
    const surfaces = await client.query("select count(*)::int as n from private.demo_seed_page_contract where surface ~* 'poms'");
    expect(surfaces.rows[0].n).toBe(0);
    // The immutable catalog stays as history; the pre-bot sync entry is retired.
    expect((await client.query("select to_regprocedure('private.demo_seed_sync_administrative_evidence()') as retired")).rows)
      .toEqual([{ retired: null }]);
  });

  // The trigger surface walks every application routine, so this case gets a
  // longer budget than the default.
  it("leaves the account-lifecycle trigger review and manifests complete", async () => {
    await client.query("set local statement_timeout = '110s'");
    expect((await client.query("select count(*)::int as n from private.account_lifecycle_referential_action_trigger_issues()")).rows[0].n).toBe(0);
    expect((await client.query("select count(*)::int as n from private.account_lifecycle_unmanaged_restrictive_fks()")).rows[0].n).toBe(0);
    expect((await client.query("select count(*)::int as n from private.account_lifecycle_unmanaged_export_fks()")).rows[0].n).toBe(0);
    const stale = await client.query(`
      select (select count(*) from private.account_lifecycle_manifest where table_name ~* 'poms')::int as manifest,
             (select count(*) from private.account_lifecycle_trigger_review where table_name ~* 'poms')::int as review`);
    expect(stale.rows[0]).toEqual({ manifest: 0, review: 0 });
  }, 120_000);
});
