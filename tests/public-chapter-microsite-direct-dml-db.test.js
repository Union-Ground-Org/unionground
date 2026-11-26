// @vitest-environment node
//
// SEC-UG-PUBLIC-CHAPTER-MICROSITE-DIRECT-DML-20260919
//
// Direct authenticated writes are gone. The definer editor routines keep the
// only staff save/takeover paths, preserve direct staff reads, and retain the
// takeover ledger.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migration = readFileSync(
  new URL("../supabase/migrations/20260920010000_public_chapter_microsite_rpc_only_writes.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("public chapter microsite RPC-only writes (static)", () => {
  it("revokes direct writes and removes every authenticated write policy", () => {
    for (const table of ["public_chapter_sections", "public_chapter_pages"]) {
      expect(migration).toContain(`revoke insert, update, delete on public.${table} from authenticated`);
      for (const action of ["create", "update", "delete"]) {
        expect(migration).toContain(`drop policy if exists ${table}_staff_${action} on public.${table}`);
      }
    }
    expect(migration).not.toMatch(/drop policy if exists public_chapter_(sections|pages)_staff_read/i);
  });

  it("pins SELECT-only table grants and no remaining write policies", () => {
    for (const table of ["public_chapter_sections", "public_chapter_pages"]) {
      expect(contract.tableGrants).toContainEqual({
        table: `public.${table}`,
        role: "authenticated",
        privileges: "SELECT",
      });
      expect(contract.policies.filter((entry) => entry.table === table).map((entry) => entry.name).sort())
        .toEqual(["mfa_assurance", `${table}_staff_read`].sort());
    }
  });
});

const ID = {
  org: "50901912-0000-4000-8000-000000000001",
  staff: "50901912-0000-4000-8000-000000000101",
  admin: "50901912-0000-4000-8000-000000000102",
  staffSession: "50901912-0000-4000-8000-000000000201",
  adminSession: "50901912-0000-4000-8000-000000000202",
};
const CHAPTER = "rls-dualwrite-chapter";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("public chapter microsite RPC-only writes on a disposable database", () => {
  let db;

  async function as(userId, sessionId, statement, values = []) {
    await db.query("savepoint microsite_direct_dml");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId,
        role: "authenticated",
        session_id: sessionId,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint microsite_direct_dml");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint microsite_direct_dml");
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "public-chapter-microsite-direct-dml-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      "insert into auth.users (id,email) values ($1,'microsite-staff@example.invalid'),($2,'microsite-admin@example.invalid')",
      [ID.staff, ID.admin],
    );
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'rls-dualwrite-org','RLS dualwrite proof',$2)",
      [ID.org, ID.admin],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9912)",
      [CHAPTER, ID.org],
    );
    await db.query(
      "insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)",
      [ID.org],
    );
    for (const userId of [ID.staff, ID.admin]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [userId, CHAPTER]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3),($1,$3,'admin',$3)",
      [ID.org, ID.staff, ID.admin],
    );
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now())",
      [ID.staffSession, ID.staff, ID.adminSession, ID.admin],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values(gen_random_uuid(),$1,'staff-totp','totp','verified',now(),now()),
             (gen_random_uuid(),$2,'admin-totp','totp','verified',now(),now())`,
      [ID.staff, ID.admin],
    );
    await db.query(
      `insert into public.public_site_records(
         id,kind,title_en,title_es,body_en,body_es,region_en,region_es,
         is_published,published_at,created_by,organization_id
       ) values('rls-proof','chapter','RLS proof','Prueba RLS','Public body','Contenido público',
         'Proof region','Región de prueba',true,now(),$1,$2)`,
      [ID.staff, ID.org],
    );
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("keeps every explicit writer SECURITY DEFINER and postgres-owned", async () => {
    const signatures = [
      "public.upsert_public_chapter_microsite_section(text,text,text,text,text,text,integer,boolean)",
      "public.upsert_public_chapter_microsite_page(text,text,text,text,text,text,text,integer,boolean)",
      "public.take_over_public_chapter_page(text,text,text,text,uuid)",
    ];
    const rows = (await db.query(
      `select p.oid::regprocedure::text signature, p.prosecdef, r.rolname owner
       from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid=p.proowner
       where p.oid = any($1::regprocedure[]) order by 1`,
      [signatures],
    )).rows;
    expect(rows).toHaveLength(signatures.length);
    expect(rows.every((row) => row.prosecdef && row.owner === "postgres")).toBe(true);
    const retired = await db.query(`select to_regprocedure('private.demo_seed_apply_organization_coordination(text,uuid)') as apply,
      to_regprocedure('private.demo_seed_remove_organization_coordination(text,uuid)') as remove`);
    expect(retired.rows).toEqual([{ apply: null, remove: null }]);
  });

  it("allows the upsert RPCs and preserves authenticated reads", async () => {
    const section = await as(
      ID.staff,
      ID.staffSession,
      "select public.upsert_public_chapter_microsite_section('rls-proof','member-help','Member help','Ayuda','Published help','Ayuda publicada',0,true) result",
    );
    expect(section, section.message).toMatchObject({ code: "" });
    const page = await as(
      ID.staff,
      ID.staffSession,
      "select public.upsert_public_chapter_microsite_page('rls-proof','member-help','office-hours','Office hours','Horario','Weekly hours','Horario semanal',0,true) result",
    );
    expect(page, page.message).toMatchObject({ code: "" });
    const reads = await as(
      ID.staff,
      ID.staffSession,
      "select (select count(*)::int from public.public_chapter_sections) sections,(select count(*)::int from public.public_chapter_pages) pages",
    );
    expect(reads.rows).toEqual([{ sections: 1, pages: 1 }]);
  });

  it("denies authenticated INSERT, UPDATE and DELETE on both hierarchy tables with 42501", async () => {
    const privileges = (await db.query(`
      select target.table_name, target.operation,
        has_table_privilege('authenticated', 'public.' || target.table_name, target.operation) allowed
      from (values
        ('public_chapter_sections', 'INSERT'),
        ('public_chapter_sections', 'UPDATE'),
        ('public_chapter_sections', 'DELETE'),
        ('public_chapter_pages', 'INSERT'),
        ('public_chapter_pages', 'UPDATE'),
        ('public_chapter_pages', 'DELETE')
      ) as target(table_name, operation)
      order by target.table_name, target.operation
    `)).rows;
    expect(privileges).toEqual([
      { table_name: "public_chapter_pages", operation: "DELETE", allowed: false },
      { table_name: "public_chapter_pages", operation: "INSERT", allowed: false },
      { table_name: "public_chapter_pages", operation: "UPDATE", allowed: false },
      { table_name: "public_chapter_sections", operation: "DELETE", allowed: false },
      { table_name: "public_chapter_sections", operation: "INSERT", allowed: false },
      { table_name: "public_chapter_sections", operation: "UPDATE", allowed: false },
    ]);
    const attempts = [
      {
        table: "public_chapter_sections",
        statement: `insert into public.public_chapter_sections(organization_id,chapter_code,slug,title_en,title_es,body_en,body_es,created_by)
          values('${ID.org}','rls-proof','direct-section','Direct','Directo','Body','Cuerpo','${ID.staff}')`,
      },
      {
        table: "public_chapter_sections",
        statement: "update public.public_chapter_sections set is_published=false where chapter_code='rls-proof' and slug='member-help'",
      },
      {
        table: "public_chapter_sections",
        statement: "delete from public.public_chapter_sections where chapter_code='rls-proof' and slug='member-help'",
      },
      {
        table: "public_chapter_pages",
        statement: `insert into public.public_chapter_pages(organization_id,chapter_code,section_slug,slug,title_en,title_es,body_en,body_es,created_by)
          values('${ID.org}','rls-proof','member-help','direct-page','Direct','Directa','Body','Cuerpo','${ID.staff}')`,
      },
      {
        table: "public_chapter_pages",
        statement: "update public.public_chapter_pages set created_by=null,is_published=false where chapter_code='rls-proof' and slug='office-hours'",
      },
      {
        table: "public_chapter_pages",
        statement: "delete from public.public_chapter_pages where chapter_code='rls-proof' and slug='office-hours'",
      },
    ];
    for (const { table, statement } of attempts) {
      const result = await as(ID.staff, ID.staffSession, statement);
      expect(result.code, `${statement}: ${result.message}`).toBe("42501");
      expect(result.message).toBe(`permission denied for table ${table}`);
    }
  });

  it("keeps takeover as the only created_by mutation and writes its ledger row", async () => {
    const key = randomUUID();
    const result = await as(
      ID.admin,
      ID.adminSession,
      "select public.take_over_public_chapter_page('rls-proof','member-help','office-hours','Reviewed owner transition',$1) result",
      [key],
    );
    expect(result, result.message).toMatchObject({ code: "" });
    const page = await db.query(
      "select created_by from public.public_chapter_pages where chapter_code='rls-proof' and section_slug='member-help' and slug='office-hours'",
    );
    expect(page.rows[0].created_by).toBe(ID.admin);
    const audit = await db.query(
      "select previous_owner_id,new_owner_id,reason from public.public_chapter_page_takeovers where idempotency_key=$1",
      [key],
    );
    expect(audit.rows).toEqual([{
      previous_owner_id: ID.staff,
      new_owner_id: ID.admin,
      reason: "Reviewed owner transition",
    }]);
  });
});
