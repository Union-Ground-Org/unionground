// @vitest-environment node
// SEC-UG-PRESIDENT-CASE-REVIEW-USES-STALE-LEGACY-CHAPTER-20261111 (#8311):
// public.member_roles keeps one legacy row per person and role (the first
// chapter granted), and the revoke paths left it naming a chapter the person
// no longer held. mark_vp_case_reviewed and list_vp_case_reviews took their
// chapter from it, and the intake, mention and steward readers tested "is
// staff" on it. Each is run here as the people the audit named.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("President case review and staff readers use the selected workspace (#8311)", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "president-case-review-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values = [], user = null) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "anon" })]);
      await c.query(user ? "set local role authenticated" : "set local role anon");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint call");
      return { ok: true, rows, value: rows[0] ? Object.values(rows[0])[0] : undefined };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const one = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.value;
  };
  const q = async (text, values = []) => (await c.query(text, values)).rows;

  async function person(chapters, { orgRoles = [], chapterRoles = [], selected = chapters[0] } = {}) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.org, user.id]);
    for (const chapter of chapters) {
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapter]);
    }
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3, language='en' where id=$1", [user.id, selected ?? null, `Proof ${user.id.slice(0, 6)}`]);
    for (const role of orgRoles) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [w.org, user.id, role]);
    }
    // The legacy row names the FIRST chapter granted, as set_member_chapter_role leaves it.
    for (const [role, chapter] of chapterRoles) {
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapter]);
      await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [user.id, role, chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }
  const select = (user, chapter) => c.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, chapter]);
  async function overdueCase(owner, chapter) {
    const id = randomUUID();
    await c.query(`insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id,step,articles,status,deadline)
      values ($1,$2,$3,'Overdue practice case','other',$4,$5,'Step 2','Article 5','active',current_date-3)`, [id, owner.id, `PRES-${id.slice(0, 8)}`, w.org, chapter]);
    return id;
  }
  const legacy = async (user, role) => (await q("select chapter_id from public.member_roles where user_id=$1 and role=$2", [user.id, role])).map((row) => row.chapter_id);

  beforeEach(async () => {
    await c.query("begin");
    const suffix = randomUUID().slice(0, 8);
    w = { org: randomUUID(), a: `pres-review-a-${suffix}`, b: `pres-review-b-${suffix}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,'Fictional Cedar union')", [w.org, `pres-review-${suffix}`]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$3,98411), ($2,$2,$2,$3,98412)", [w.a, w.b, w.org]);
    w.admin = await person([w.a, w.b], { orgRoles: ["admin"], chapterRoles: [["admin", w.a], ["admin", w.b]] });
    // A President of both chapters; the legacy row names chapter A.
    w.president = await person([w.a, w.b], { chapterRoles: [["vp", w.a], ["vp", w.b]] });
    w.otherPresidentA = await person([w.a], { chapterRoles: [["vp", w.a]] });
    w.memberA = await person([w.a]);
    w.memberB = await person([w.b]);
    w.caseA = await overdueCase(w.memberA, w.a);
    w.caseB = await overdueCase(w.memberB, w.b);
  });
  afterEach(async () => { await c.query("rollback"); });

  describe("mark_vp_case_reviewed and list_vp_case_reviews", () => {
    it("refuses the old chapter's case to a President removed from it, with the same answer as an unknown id", async () => {
      await one("select public.revoke_member_chapter_membership($1, $2) as r", [w.president.id, w.a], w.admin);
      await select(w.president, w.b);
      const old = await call("select public.mark_vp_case_reviewed($1) as r", [w.caseA], w.president);
      const unknown = await call("select public.mark_vp_case_reviewed($1) as r", [randomUUID()], w.president);
      expect(old).toMatchObject({ ok: false, code: "P0002", message: "attention case not found" });
      expect(unknown).toMatchObject({ ok: false, code: old.code, message: old.message });
      expect(await q("select count(*)::int n from public.member_vp_case_reviews where case_id=$1", [w.caseA])).toEqual([{ n: 0 }]);
      // The President's own chapter still works, and the review is written there.
      expect(await one("select public.mark_vp_case_reviewed($1) as r", [w.caseB], w.president)).toMatchObject({ caseId: w.caseB });
      expect(await q("select chapter_id from public.member_vp_case_reviews where case_id=$1", [w.caseB])).toEqual([{ chapter_id: w.b }]);
    });

    it("works in the chapter the President has selected, and only there, before any removal", async () => {
      await select(w.president, w.b);
      expect(await call("select public.mark_vp_case_reviewed($1) as r", [w.caseA], w.president)).toMatchObject({ ok: false, code: "P0002" });
      expect(await one("select public.mark_vp_case_reviewed($1) as r", [w.caseB], w.president)).toMatchObject({ caseId: w.caseB });
      await select(w.president, w.a);
      expect(await one("select public.mark_vp_case_reviewed($1) as r", [w.caseA], w.president)).toMatchObject({ caseId: w.caseA });
    });

    it("matches the case's stored chapter, not the chapter its owner has selected since", async () => {
      // The owner of chapter A's case switches to chapter B; the case stays A's.
      await select(w.memberA, w.b);
      await select(w.president, w.b);
      expect(await call("select public.mark_vp_case_reviewed($1) as r", [w.caseA], w.president))
        .toMatchObject({ ok: false, code: "P0002", message: "attention case not found" });
      expect(await one("select public.mark_vp_case_reviewed($1) as r", [w.caseA], w.otherPresidentA)).toMatchObject({ caseId: w.caseA });
      expect(await q("select chapter_id from public.member_vp_case_reviews where case_id=$1", [w.caseA])).toEqual([{ chapter_id: w.a }]);
    });

    it("lists only the selected chapter's reviews for staff of two chapters of one organization", async () => {
      // The list is read on staff desks; a coordinator of both chapters reads
      // both chapters' cases, and the legacy row names chapter A.
      const lister = await person([w.a, w.b], { chapterRoles: [["coordinator", w.a], ["coordinator", w.b]], selected: w.b });
      await one("select public.mark_vp_case_reviewed($1) as r", [w.caseA], w.otherPresidentA);
      await select(w.president, w.b);
      await one("select public.mark_vp_case_reviewed($1) as r", [w.caseB], w.president);
      expect(await legacy(lister, "coordinator")).toEqual([w.a]);
      const listed = await one("select public.list_vp_case_reviews() as r", [], lister);
      expect(listed.map((row) => row.caseId)).toEqual([w.caseB]);
      await select(lister, w.a);
      expect((await one("select public.list_vp_case_reviews() as r", [], lister)).map((row) => row.caseId)).toEqual([w.caseA]);
    });
  });

  describe("revoke paths repoint or drop a stale legacy row", () => {
    it("repoints the row when a chapter membership is revoked and the role remains elsewhere", async () => {
      expect(await legacy(w.president, "vp")).toEqual([w.a]);
      await one("select public.revoke_member_chapter_membership($1, $2) as r", [w.president.id, w.a], w.admin);
      expect(await legacy(w.president, "vp")).toEqual([w.b]);
    });

    it("repoints the row when one chapter role is revoked, and drops it with the last one", async () => {
      await one("select public.set_member_chapter_role($1, $2, 'vp', false) as r", [w.president.id, w.a], w.admin);
      expect(await legacy(w.president, "vp")).toEqual([w.b]);
      await one("select public.set_member_chapter_role($1, $2, 'vp', false) as r", [w.president.id, w.b], w.admin);
      expect(await legacy(w.president, "vp")).toEqual([]);
    });

    it("repoints the row when a learning-period undo takes back one chapter role", async () => {
      expect(await legacy(w.president, "vp")).toEqual([w.a]);
      // The undo of a grant, applied as the dispatcher does once its check passed.
      const entry = { id: randomUUID(), target_id: `${w.president.id}:vp:${w.a}`, before_image: { granted: false } };
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: w.admin.id, session_id: w.admin.session, aal: "aal2" })]);
      await c.query("select private.learning_undo_chapter_role('apply', $1::jsonb)", [JSON.stringify(entry)]);
      expect(await q("select chapter_id from public.member_role_chapters where user_id=$1 and role='vp'", [w.president.id])).toEqual([{ chapter_id: w.b }]);
      expect(await legacy(w.president, "vp")).toEqual([w.b]);
    });

    it("repoints the row when SCIM deprovisions the person from the organization (no role left: dropped)", async () => {
      await c.query("select private.scim_revoke_organization_membership($1, $2)", [w.org, w.president.id]);
      expect(await legacy(w.president, "vp")).toEqual([]);
      expect(await q("select count(*)::int n from public.member_role_chapters where user_id=$1", [w.president.id])).toEqual([{ n: 0 }]);
    });
  });

  describe("other readers of the legacy chapter", () => {
    // A steward of chapter A who has chapter B selected as a plain member, and a
    // steward removed from chapter A whose legacy row still names it.
    beforeEach(async () => {
      w.stewardA = await person([w.a, w.b], { chapterRoles: [["steward", w.a]], selected: w.b });
      w.departed = await person([w.a, w.b], { chapterRoles: [["steward", w.a]], selected: w.b });
      await c.query("delete from public.member_role_chapters where user_id=$1", [w.departed.id]);
      await c.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [w.departed.id, w.a]);
      w.stewardB = await person([w.b], { chapterRoles: [["steward", w.b]] });
      w.stewardBOnA = await person([w.a, w.b], { chapterRoles: [["steward", w.b]], selected: w.a });
      w.coordinatorA = await person([w.a], { chapterRoles: [["coordinator", w.a]] });
    });

    it("offers as intake owners only staff of the caller's chapter, and refuses others as owner", async () => {
      const owners = await one("select coalesce(jsonb_agg(o.user_id order by o.user_id), '[]'::jsonb) as r from public.list_intake_triage_owners() o", [], w.stewardB);
      expect(owners).toContain(w.stewardB.id);
      expect(owners).not.toContain(w.stewardA.id);
      expect(owners).not.toContain(w.departed.id);
      const report = randomUUID();
      await c.query("insert into public.member_intake_reports(id,chapter_id,reporter_id,category,title,details,status) values ($1,$2,$3,'safety','Proof report','Proof details','new')", [report, w.b, w.memberB.id]);
      expect(await call("select public.triage_member_intake_report($1, 'triaged', $2) as r", [report, w.stewardA.id], w.stewardB))
        .toMatchObject({ ok: false, message: "intake owner must be same-chapter staff" });
      expect(await call("select public.triage_member_intake_report($1, 'triaged', $2) as r", [report, w.stewardB.id], w.stewardB)).toMatchObject({ ok: true });
    });

    it("lists only the case chapter's current staff as mention candidates, and refuses a stale steward", async () => {
      const candidates = await one("select public.list_case_note_mention_candidates($1) as r", [w.caseA], w.coordinatorA);
      const ids = candidates.map((row) => row.userId);
      expect(ids).toContain(w.stewardA.id);
      expect(ids).not.toContain(w.departed.id);
      expect(ids).not.toContain(w.stewardB.id);
      expect(ids).not.toContain(w.stewardBOnA.id);
      expect(candidates.find((row) => row.userId === w.stewardA.id).roles).toEqual(["steward"]);
      expect(await call("select public.casework_add_case_note($1, 'Proof note', $2) as r", [w.caseA, [w.departed.id]], w.coordinatorA))
        .toMatchObject({ ok: false, code: "23514" });
      expect(await call("select public.casework_add_case_note($1, 'Proof note', $2) as r", [w.caseA, [w.stewardA.id]], w.coordinatorA)).toMatchObject({ ok: true });
    });

    it("takes the mention audience from the case's stored chapter after its owner moves to another chapter", async () => {
      // Chapter A's case owner selects chapter B; the case and its mentions stay A's.
      await select(w.memberA, w.b);
      const ids = (await one("select public.list_case_note_mention_candidates($1) as r", [w.caseA], w.coordinatorA)).map((row) => row.userId);
      expect(ids).toContain(w.stewardA.id);
      expect(ids).not.toContain(w.stewardB.id);
      // A coordinator of chapter B now reaches the case through its owner, but
      // the mentions it may make stay chapter A's.
      const coordinatorB = await person([w.b], { chapterRoles: [["coordinator", w.b]] });
      expect(await call("select public.casework_add_case_note($1, 'Proof note', $2) as r", [w.caseA, [w.stewardB.id]], coordinatorB))
        .toMatchObject({ ok: false, code: "23514", message: "mentioned person is outside the case chapter" });
      expect(await call("select public.casework_add_case_note($1, 'Proof note', $2) as r", [w.caseA, [w.stewardA.id]], coordinatorB)).toMatchObject({ ok: true });
    });

    it("drops a steward whose organization membership was revoked, though the chapter membership and role remain", async () => {
      await c.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [w.org, w.stewardA.id]);
      expect((await q("select private.chapter_staff_roles($1, $2) as r", [w.stewardA.id, w.a]))[0].r).toEqual([]);
      const stewards = (await q("select steward_id from private.member_stewards_for_chapter($1)", [w.a])).map((row) => row.steward_id);
      expect(stewards).not.toContain(w.stewardA.id);
    });

    it("finds a chapter's stewards from current roles only (the steward-request notice reads this list)", async () => {
      const stewards = (await q("select steward_id from private.member_stewards_for_chapter($1)", [w.a])).map((row) => row.steward_id);
      expect(stewards).toContain(w.stewardA.id);
      expect(stewards).not.toContain(w.departed.id);
      expect(stewards).not.toContain(w.stewardBOnA.id);
      expect(stewards).not.toContain(w.stewardB.id);
    });
  });
});
