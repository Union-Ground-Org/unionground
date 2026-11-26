// @vitest-environment node
// REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113 (#8627): a chapter's
// notices glow in a colour the chapter picks (green, blue, gold or violet;
// amber and red are kept for due soon and urgent). public.chapters.notice_glow
// stores it, public.set_chapter_notice_glow is the one write path for the
// roles that can publish that chapter's announcements, and
// public.get_chapter_notice_glow tells the settings control whether to offer
// itself. Static pins on the migration text, then the live proof on an owned
// disposable database inside one rolled-back transaction.
import { readdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migrationName = readdirSync("supabase/migrations").find((name) => name.endsWith("_chapter_notice_glow.sql"));
const sql = readFileSync(`supabase/migrations/${migrationName}`, "utf8");

describe("chapter notice glow migration (static)", () => {
  it("is one atomic migration that adds the column with a green default and a four-name check", () => {
    expect(sql).toMatch(/^begin;$/mu);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("add column notice_glow text not null default 'green'");
    expect(sql).toContain("constraint chapters_notice_glow_choice check (notice_glow in ('green', 'blue', 'gold', 'violet'))");
    // Amber and red are never a chapter's choice.
    expect(sql).not.toMatch(/notice_glow in \([^)]*'(amber|red)'/u);
  });

  it("grants both functions to authenticated only and adds no write grant on chapters", () => {
    for (const fn of ["set_chapter_notice_glow(text, text)", "get_chapter_notice_glow(text)"]) {
      expect(sql).toContain(`revoke all on function public.${fn} from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant execute on function public.${fn} to authenticated;`);
    }
    expect(sql).not.toMatch(/grant [a-z, ]*(insert|update)[a-z, ]* on (table )?public\.chapters/iu);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter notice glow on an owned disposable database", () => {
  let db, f;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  async function as(who, query, params = [], aal = "aal2") {
    await owner();
    await db.query("savepoint glow_call");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: who.id, session_id: who.session, aal, role: "authenticated" })]);
      await db.query("set local role authenticated");
      const result = await db.query(query, params);
      await db.query("release savepoint glow_call");
      return { code: "", rows: result.rows, value: result.rows[0]?.value };
    } catch (error) {
      await db.query("rollback to savepoint glow_call");
      return { code: error.code, message: error.message };
    } finally {
      await owner();
    }
  }
  const setGlow = (who, chapter, colour, aal) => as(who, "select public.set_chapter_notice_glow($1,$2) value", [chapter, colour], aal);
  const getGlow = (who, chapter) => as(who, "select public.get_chapter_notice_glow($1) value", [chapter]);
  const stored = async (chapter) => (await db.query("select notice_glow from public.chapters where id=$1", [chapter])).rows[0].notice_glow;

  async function person(chapter, org, role = null) {
    const value = { id: randomUUID(), session: randomUUID() };
    await db.query("insert into auth.users(id,email) values($1,$2)", [value.id, `${value.id}@notice-glow.invalid`]);
    await db.query("update public.member_profiles set chapter_id=$2,full_name='Fictional glow member' where id=$1", [value.id, chapter]);
    await db.query("insert into public.organization_memberships(user_id,organization_id,status) values($1,$2,'active')", [value.id, org]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [value.id, chapter]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [value.session, value.id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), value.id]);
    if (role) {
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [value.id, role, chapter]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [value.id, role, chapter]);
    }
    return value;
  }

  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-notice-glow-rollback" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout='120s'");
    await db.query("set local lock_timeout='15s'");
    f = { org: randomUUID(), other: randomUUID() };
    f.cedar = `glow-cedar-${f.org.slice(0, 8)}`; f.birch = `glow-birch-${f.org.slice(0, 8)}`; f.harbor = `glow-harbor-${f.other.slice(0, 8)}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Tamarack Valley'),($2::uuid,$2::text,'Fictional Harbor')", [f.org, f.other]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Cedar chapter',$1,$4,9971),($2,'Birch chapter',$2,$4,9972),($3,'Harbor chapter',$3,$5,9973)",
      [f.cedar, f.birch, f.harbor, f.org, f.other]);
    f.steward = await person(f.cedar, f.org, "steward");
    f.secretary = await person(f.cedar, f.org, "secretary");
    f.member = await person(f.cedar, f.org);
    f.birchSteward = await person(f.birch, f.org, "steward");
    f.harborSteward = await person(f.harbor, f.other, "steward");
  }, 60000);
  afterEach(async () => { if (db) { await db.query("rollback").catch(() => {}); await db.end(); } });

  it("shows green for a chapter that has not chosen, and refuses any other name in the table", async () => {
    expect(await stored(f.cedar)).toBe("green");
    for (const colour of ["red", "amber", "purple", ""]) {
      await db.query("savepoint bad_colour");
      await expect(db.query("update public.chapters set notice_glow=$2 where id=$1", [f.cedar, colour])).rejects.toMatchObject({ code: "23514" });
      await db.query("rollback to savepoint bad_colour");
    }
  });

  it("lets a chapter steward and a secretary whose office posts notices choose the colour", async () => {
    const steward = await setGlow(f.steward, f.cedar, "blue");
    expect(steward.code, steward.message).toBe("");
    expect(steward.value).toBe("blue");
    expect(await getGlow(f.steward, f.cedar)).toMatchObject({ code: "", value: { chapterId: f.cedar, glow: "blue", canChange: true } });
    // Trimmed and lower-cased before the check.
    const secretary = await setGlow(f.secretary, f.cedar, "  Violet ");
    expect(secretary.code, secretary.message).toBe("");
    expect(await stored(f.cedar)).toBe("violet");
    // Every member of the organization reads the colour with the chapter's name.
    expect((await as(f.member, "select name, notice_glow from public.chapters where id=$1", [f.cedar])).rows).toEqual([{ name: "Cedar chapter", notice_glow: "violet" }]);
  });

  it("stops offering the control and refuses the save once the secretary's office no longer posts notices", async () => {
    await db.query("insert into private.chapter_role_settings(chapter_id,role,capability,enabled) values($1,'secretary','notices',false)", [f.cedar]);
    expect(await getGlow(f.secretary, f.cedar)).toMatchObject({ code: "", value: { canChange: false } });
    expect(await setGlow(f.secretary, f.cedar, "gold")).toMatchObject({ code: "42501" });
    expect(await stored(f.cedar)).toBe("green");
  });

  it("refuses red, amber and unknown names with the same answer, and stores nothing", async () => {
    for (const colour of ["red", "amber", "purple", "", null]) {
      expect(await setGlow(f.steward, f.cedar, colour)).toMatchObject({ code: "22023", message: "notice glow must be green, blue, gold or violet" });
    }
    expect(await stored(f.cedar)).toBe("green");
  });

  it("refuses a member, a steward of another chapter and a session without the second step", async () => {
    expect(await getGlow(f.member, f.cedar)).toMatchObject({ code: "", value: { glow: "green", canChange: false } });
    expect(await setGlow(f.member, f.cedar, "gold")).toMatchObject({ code: "42501" });
    expect(await getGlow(f.birchSteward, f.cedar)).toMatchObject({ code: "", value: { canChange: false } });
    expect(await setGlow(f.birchSteward, f.cedar, "gold")).toMatchObject({ code: "42501" });
    expect(await setGlow(f.steward, f.cedar, "gold", "aal1")).toMatchObject({ code: "42501" });
    expect(await stored(f.cedar)).toBe("green");
  });

  it("gives another organization's steward the same refusal as a missing chapter, and no row to read", async () => {
    const foreign = await setGlow(f.harborSteward, f.cedar, "gold");
    const missing = await setGlow(f.harborSteward, `${f.cedar}-missing`, "gold");
    expect(foreign).toMatchObject({ code: "42501", message: "chapter notice role required" });
    expect(missing).toMatchObject({ code: foreign.code, message: foreign.message });
    expect(await getGlow(f.harborSteward, f.cedar)).toMatchObject({ code: "42501", message: "chapter notice role required" });
    expect((await as(f.harborSteward, "select notice_glow from public.chapters where id=$1", [f.cedar])).rows).toEqual([]);
    expect(await stored(f.cedar)).toBe("green");
  });

  it("allows no direct write to the column and keeps both functions to authenticated", async () => {
    const direct = await as(f.steward, "update public.chapters set notice_glow='gold' where id=$1 returning id", [f.cedar]);
    expect(direct.code).toBe("42501");
    const acl = (await db.query(`
      select p.proname, r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        cross join (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
       where n.nspname = 'public' and p.proname in ('set_chapter_notice_glow', 'get_chapter_notice_glow')
         and has_function_privilege(r.rolname, p.oid, 'execute') order by 1, 2`)).rows;
    expect(acl).toEqual([{ proname: "get_chapter_notice_glow", rolname: "authenticated" }, { proname: "set_chapter_notice_glow", rolname: "authenticated" }]);
  });
});
