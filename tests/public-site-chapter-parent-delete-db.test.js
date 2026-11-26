// @vitest-environment node
//
// SEC-UG-PUBLIC-SITE-CHAPTER-PARENT-DELETE-CASCADES-MICROSITE-20260920
//
// Staff DELETE remains available for non-chapter public records, but a chapter
// parent cannot be deleted through RLS and therefore cannot cascade away its
// microsite hierarchy or takeover evidence.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migration = readFileSync(
  new URL("../supabase/migrations/20260920012000_public_site_chapter_parent_delete_guard.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("public-site chapter parent delete guard (static)", () => {
  it("narrows only the authenticated parent DELETE policy and pins the chapter exclusion", () => {
    expect(migration).toContain("create or replace function private.public_site_records_preserve_chapter_kind()");
    expect(migration).toContain("and current_user = 'authenticated'");
    expect(migration).toContain("before update of kind on public.public_site_records");
    expect(migration).toContain("comment on function private.public_site_records_preserve_chapter_kind()");
    expect(migration).toContain("comment on trigger public_site_records_preserve_chapter_kind on public.public_site_records");
    expect(migration).toContain("insert into private.account_lifecycle_trigger_review");
    expect(migration).toContain("d6dd00b63149dba6f72095ce699143c2");
    expect(migration).toContain("e4beecbc062b3eeb255039ffe3640ea1");
    expect(migration).toContain("private.account_lifecycle_referential_action_trigger_issues()");
    expect(migration).toContain("alter policy public_site_records_staff_delete on public.public_site_records");
    expect(migration).toContain("kind <> 'chapter'");
    expect(migration).toContain("comment on policy public_site_records_staff_delete on public.public_site_records");
    expect(migration).not.toMatch(/revoke\s+delete/i);
    expect(contract.policies).toContainEqual(expect.objectContaining({
      table: "public_site_records",
      name: "public_site_records_staff_delete",
      cmd: "d",
      roles: "authenticated",
      qualContains: expect.arrayContaining([
        "kind <> 'chapter'::text",
        "organization_id IS NOT NULL",
      ]),
    }));
  });
});

const ID = {
  org: "50902001-0000-4000-8000-000000000001",
  staff: "50902001-0000-4000-8000-000000000101",
  session: "50902001-0000-4000-8000-000000000201",
};
const CHAPTER = "parent-delete-proof";
const WIN = "parent-delete-win";
const MEETING = "parent-delete-meeting";
const STAFF_ROLES = ["steward", "coordinator", "advisor", "admin", "vp"];
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("public-site chapter parent delete guard on a disposable database", () => {
  let db;

  async function asStaff(statement, values = []) {
    await db.query("savepoint parent_delete_guard");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: ID.staff,
        role: "authenticated",
        session_id: ID.session,
        aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint parent_delete_guard");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint parent_delete_guard");
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }

  async function setStaffRole(role) {
    await db.query(
      "update public.organization_role_grants set role=$3 where organization_id=$1 and user_id=$2",
      [ID.org, ID.staff, role],
    );
  }

  async function prepareChapter(id, populated) {
    await db.query("delete from public.public_site_records where id=$1", [id]);
    await setStaffRole("admin");
    await db.query(
      `insert into public.public_site_records(
         id,kind,title_en,title_es,body_en,body_es,region_en,region_es,
         is_published,published_at,created_by,organization_id
       ) values($1,'chapter','Kind guard proof','Prueba del tipo','Public body','Contenido público',
         'Proof region','Región de prueba',true,now(),$2,$3)`,
      [id, ID.staff, ID.org],
    );
    if (!populated) return;
    expect((await asStaff(
      "select public.upsert_public_chapter_microsite_section($1,'member-help','Member help','Ayuda','Published help','Ayuda publicada',0,true)",
      [id],
    )).code).toBe("");
    expect((await asStaff(
      "select public.upsert_public_chapter_microsite_page($1,'member-help','office-hours','Office hours','Horario','Weekly hours','Horario semanal',0,true)",
      [id],
    )).code).toBe("");
    expect((await asStaff(
      "select public.take_over_public_chapter_page($1,'member-help','office-hours','Preserve this takeover evidence',$2)",
      [id, randomUUID()],
    )).code).toBe("");
  }

  async function chapterCounts(id) {
    return (await db.query(`
      select
        (select count(*)::int from public.public_site_records where id=$1) parents,
        (select count(*)::int from public.public_chapter_sections where chapter_code=$1) sections,
        (select count(*)::int from public.public_chapter_pages where chapter_code=$1) pages,
        (select count(*)::int from public.public_chapter_page_takeovers where chapter_code=$1) takeovers
    `, [id])).rows[0];
  }

  async function attemptKindRewrite(id, targetKind) {
    if (targetKind === "win") {
      return asStaff(
        `update public.public_site_records
         set kind='win', region_en=null, region_es=null, occurred_on=current_date,
             starts_at=null, ends_at=null, location_en=null, location_es=null
         where id=$1 returning id,kind`,
        [id],
      );
    }
    return asStaff(
      `update public.public_site_records
       set kind='meeting', region_en=null, region_es=null, occurred_on=null,
           starts_at=now() + interval '1 day', ends_at=now() + interval '2 days',
           location_en='Proof hall', location_es='Salón de prueba'
       where id=$1 returning id,kind`,
      [id],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "public-site-chapter-parent-delete-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '30s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("insert into auth.users(id,email) values($1,'parent-delete-staff@example.invalid')", [ID.staff]);
    await db.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,'parent-delete-org','Parent delete proof',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9920)",
      [CHAPTER, ID.org],
    );
    await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ID.org]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, ID.staff]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ID.staff, CHAPTER]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [ID.staff, CHAPTER]);
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
      [ID.org, ID.staff],
    );
    await db.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",
      [ID.session, ID.staff],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       values(gen_random_uuid(),$1,'parent-delete-totp','totp','verified',now(),now())`,
      [ID.staff],
    );
    await db.query(
      `insert into public.public_site_records(
         id,kind,title_en,title_es,body_en,body_es,occurred_on,region_en,region_es,
         is_published,published_at,created_by,organization_id
       ) values($1,'chapter','Parent delete proof','Prueba de borrado','Public body','Contenido público',
         null,'Proof region','Región de prueba',true,now(),$2,$3),
        ($4,'win','A public win','Una victoria','Public win body','Contenido de victoria',
         current_date,null,null,true,now(),$2,$3)`,
      [CHAPTER, ID.staff, ID.org, WIN],
    );
    await db.query(
      `insert into public.public_site_records(
         id,kind,title_en,title_es,body_en,body_es,starts_at,ends_at,location_en,location_es,
         is_published,published_at,created_by,organization_id
       ) values($1,'meeting','A public meeting','Una reunión','Public meeting body','Contenido de reunión',
         now() + interval '1 day',now() + interval '2 days','Proof hall','Salón de prueba',
         true,now(),$2,$3)`,
      [MEETING, ID.staff, ID.org],
    );
    expect((await asStaff(
      "select public.upsert_public_chapter_microsite_section($1,'member-help','Member help','Ayuda','Published help','Ayuda publicada',0,true)",
      [CHAPTER],
    )).code).toBe("");
    expect((await asStaff(
      "select public.upsert_public_chapter_microsite_page($1,'member-help','office-hours','Office hours','Horario','Weekly hours','Horario semanal',0,true)",
      [CHAPTER],
    )).code).toBe("");
    expect((await asStaff(
      "select public.take_over_public_chapter_page($1,'member-help','office-hours','Preserve this takeover evidence',$2)",
      [CHAPTER, randomUUID()],
    )).code).toBe("");
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("denies a staff chapter-parent DELETE and preserves every cascading child layer", async () => {
    const deleted = await asStaff("delete from public.public_site_records where id=$1 returning id", [CHAPTER]);
    expect(deleted, deleted.message).toEqual({ code: "", rows: [], message: "" });
    const counts = (await db.query(`
      select
        (select count(*)::int from public.public_site_records where id=$1) parents,
        (select count(*)::int from public.public_chapter_sections where chapter_code=$1) sections,
        (select count(*)::int from public.public_chapter_pages where chapter_code=$1) pages,
        (select count(*)::int from public.public_chapter_page_takeovers where chapter_code=$1) takeovers
    `, [CHAPTER])).rows[0];
    expect(counts).toEqual({ parents: 1, sections: 1, pages: 1, takeovers: 1 });
  });

  it("keeps a non-chapter public record deletable by the same staff role", async () => {
    const deleted = await asStaff("delete from public.public_site_records where id=$1 returning id,kind", [WIN]);
    expect(deleted, deleted.message).toEqual({ code: "", rows: [{ id: WIN, kind: "win" }], message: "" });
    expect((await db.query("select count(*)::int count from public.public_site_records where id=$1", [WIN])).rows)
      .toEqual([{ count: 0 }]);
  });

  it("keeps a meeting public record deletable by the same staff role", async () => {
    const deleted = await asStaff("delete from public.public_site_records where id=$1 returning id,kind", [MEETING]);
    expect(deleted, deleted.message).toEqual({ code: "", rows: [{ id: MEETING, kind: "meeting" }], message: "" });
    expect((await db.query("select count(*)::int count from public.public_site_records where id=$1", [MEETING])).rows)
      .toEqual([{ count: 0 }]);
  });

  it.each(STAFF_ROLES)("denies the %s kind-change then DELETE bypass for populated and empty chapters", async (role) => {
    for (const [state, populated] of [["populated", true], ["empty", false]]) {
      for (const targetKind of ["win", "meeting"]) {
        const id = `parent-guard-${role}-${state}-${targetKind}`;
        await prepareChapter(id, populated);
        await setStaffRole(role);

        const rewritten = await attemptKindRewrite(id, targetKind);
        expect(rewritten.code, `${role} rewrote ${state} chapter ${id} to ${targetKind}`).toBe("42501");
        // 20260924070200 revokes direct authenticated UPDATE, so the privilege
        // check refuses the rewrite before the kind-transition trigger runs.
        expect(rewritten.message).toContain("permission denied for table public_site_records");

        const deleted = await asStaff("delete from public.public_site_records where id=$1 returning id,kind", [id]);
        expect(deleted, deleted.message).toEqual({ code: "", rows: [], message: "" });
        expect(await chapterCounts(id)).toEqual({
          parents: 1,
          sections: populated ? 1 : 0,
          pages: populated ? 1 : 0,
          takeovers: populated ? 1 : 0,
        });
      }
    }
  });
});
