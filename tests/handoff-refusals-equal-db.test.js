// @vitest-environment node
// SEC-UG-HANDOFF-RESOLVE-REVEALS-ANOTHER-CHAPTERS-HANDOFF-20261115 (#8914).
// Acknowledging, declining or cancelling a member handoff must refuse
// another chapter's or another unit's live handoff exactly as it refuses an
// id that does not exist (same SQLSTATE and message), for a member, steward,
// coordinator and president of another chapter and for a steward limited to
// another unit, when the handoff has no previous steward (from_steward_id
// null). The handoff's own receiving steward still acknowledges it. Every
// row is fictional and every write rolls back on the runner-owned database.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

describe("handoff refusal migration", () => {
  it("guards both predecessor bodies, never lets visibility be NULL, and checks before the lock", () => {
    const SQL = loadMigrationSql("handoff_refusal_equal_for_missing_and_invisible");
    expect(SQL).toContain("unreviewed predecessor: private.mi1_w2_handoff_visible");
    expect(SQL).toContain("unreviewed predecessor: private.mi1_w2_resolve_handoff");
    expect(SQL).toContain("select coalesce(p_handoff.organization_id = p_org");
    expect(SQL).toMatch(/^CREATE OR REPLACE FUNCTION private\.mi1_w2_handoff_visible\(p_org uuid, p_handoff public\.member_handoffs\)/m);
    expect(SQL).toContain("pg_catalog.to_regprocedure('private.mi1_w2_handoff_visible(uuid, public.member_handoffs)')");
    const unlocked = SQL.indexOf("select * into handoff from public.member_handoffs where id = p_handoff_id;");
    const refused = SQL.indexOf("raise exception 'not found' using errcode = 'P0002';", unlocked);
    const locked = SQL.indexOf("select * into handoff from public.member_handoffs where id = p_handoff_id for update;");
    expect(unlocked).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(unlocked);
    expect(refused).toBeLessThan(locked);
    expect(locked).toBeGreaterThan(unlocked);
  });
});

const ACTIONS = Object.freeze({
  acknowledge: "select public.acknowledge_member_handoff($1)",
  decline: "select public.decline_member_handoff($1)",
  cancel: "select public.cancel_member_handoff($1)",
});
// Every role of the first chapter, and a steward limited to its first unit.
const ROLES = Object.freeze(["member", "steward", "coordinator", "vp", "unitSteward"]);

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("handoff refusals are the same for a missing id and another chapter's or unit's handoff (#8914)", () => {
  let db;
  const f = { org: randomUUID(), unitOne: randomUUID(), unitTwo: randomUUID(), people: {}, handoffs: {} };
  const owner = async () => {
    await db.query("reset role");
    await db.query("select set_config('request.jwt.claims','',true)");
  };
  const as = async (name) => {
    await owner();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: f.people[name].id, session_id: f.people[name].session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  };
  const attempt = async (sql, args) => {
    await db.query("savepoint handoff_refusal");
    try {
      await db.query(sql, args);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint handoff_refusal");
      await db.query("release savepoint handoff_refusal");
    }
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "handoff-refusals-equal-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    f.home = `handoff-home-${f.org}`;
    f.other = `handoff-other-${f.org}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Union')", [f.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$3,9989),($2,$2,$2,$3,9990)", [f.home, f.other, f.org]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values ($1,$3,$4,'Fictional Unit One'),($2,$3,$4,'Fictional Unit Two')",
      [f.unitOne, f.unitTwo, f.org, f.home]);
    const chapterOf = { otherMember: f.other, otherSteward: f.other };
    for (const name of [...ROLES, "unitTwoMember", "unitTwoSteward", "otherMember", "otherSteward"]) {
      const id = randomUUID();
      const session = randomUUID();
      const chapter = chapterOf[name] ?? f.home;
      f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, `Fictional ${name}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      const role = { steward: "steward", coordinator: "coordinator", vp: "vp", unitSteward: "steward", unitTwoSteward: "steward", otherSteward: "steward" }[name];
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
      }
    }
    for (const [name, unit] of [["unitSteward", f.unitOne], ["unitTwoSteward", f.unitTwo], ["unitTwoMember", f.unitTwo]]) {
      await db.query("insert into private.chapter_unit_members(unit_id,chapter_id,user_id) values ($1,$2,$3)", [unit, f.home, f.people[name].id]);
    }
    for (const [name, unit] of [["unitSteward", f.unitOne], ["unitTwoSteward", f.unitTwo]]) {
      await db.query("insert into private.chapter_role_scopes(user_id,chapter_id,role,unit_id) values ($1,$2,'steward',$3)", [f.people[name].id, f.home, unit]);
    }
    // Handoffs with no previous steward, each to and by its own steward.
    // Resolve the extra foreign row before creating its pending counterpart,
    // preserving the one-pending-handoff constraint for that member.
    const handoff = async (chapter, member, steward) => (await db.query(`insert into public.member_handoffs(organization_id,chapter_id,member_user_id,
        to_steward_id,initiated_by,idempotency_key)
      values ($1,$2,$3,$4,$4,$5) returning id`, [f.org, chapter, f.people[member].id, f.people[steward].id, randomUUID()])).rows[0].id;
    f.handoffs.nonPendingOtherChapter = await handoff(f.other, "otherMember", "otherSteward");
    await db.query("update public.member_handoffs set status='declined', resolved_at=now() where id=$1", [f.handoffs.nonPendingOtherChapter]);
    f.handoffs.otherChapter = await handoff(f.other, "otherMember", "otherSteward");
    f.handoffs.otherUnit = await handoff(f.home, "unitTwoMember", "unitTwoSteward");
  });
  afterAll(async () => {
    if (db) {
      await db.query("rollback");
      await db.end();
    }
  });

  it.each(Object.keys(ACTIONS))("%s: every role gets the same refusal for a missing handoff, another chapter's and another unit's", async (action) => {
    for (const role of ROLES) {
      await as(role);
      const missing = await attempt(ACTIONS[action], [randomUUID()]);
      expect(missing, `${action} ${role} missing`).toEqual({ ok: false, code: "P0002", message: "not found" });
      expect(await attempt(ACTIONS[action], [f.handoffs.otherChapter]), `${action} ${role} other chapter`).toEqual(missing);
      expect(await attempt(ACTIONS[action], [f.handoffs.otherUnit]), `${action} ${role} other unit`).toEqual(missing);
    }
    await owner();
  });

  it("refuses a non-pending other-chapter handoff as missing before status or row-lock checks", async () => {
    for (const action of Object.keys(ACTIONS)) {
      for (const role of ROLES) {
        await as(role);
        const missing = await attempt(ACTIONS[action], [randomUUID()]);
        expect(missing, `${action} ${role} missing`).toEqual({ ok: false, code: "P0002", message: "not found" });
        expect(await attempt(ACTIONS[action], [f.handoffs.nonPendingOtherChapter]), `${action} ${role} non-pending other chapter`).toEqual(missing);
      }
    }
    await owner();
  });

  it("lets the handoff's own receiving steward acknowledge it", async () => {
    await as("otherSteward");
    expect(await attempt(ACTIONS.acknowledge, [f.handoffs.otherChapter])).toEqual({ ok: true });
    await owner();
  });
});
