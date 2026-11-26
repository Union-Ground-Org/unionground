// @vitest-environment node
// #9279: C300's ead7d29d submit_weekly_poll_question probe, with strict
// whole-response/row assertions and a complete departure from the old chapter.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const OPTIONS = ["Yes", "No"];
const INITIAL = "Fictional original weekly question";
const EDITED = "Fictional edited after chapter move";

live("weekly questions stay in the selected chapter (#9279)", () => {
  let db;
  let week;
  const org = randomUUID();
  const member = randomUUID();
  const other = randomUUID();
  const session = randomUUID();
  const chapters = [`weekly-move-${org}-old`, `weekly-move-${org}-current`];
  const surveys = [randomUUID(), randomUUID()];
  const rows = async () => (await db.query(
    "select to_jsonb(q) as row from public.member_weekly_questions q where chapter_id=any($1) order by chapter_id,user_id,id",
    [chapters],
  )).rows.map(({ row }) => row);
  const byId = (snapshot, id) => snapshot.find((row) => row.id === id);

  // C300's real-role/savepoint wrapper: no result/error field is normalized.
  async function act(body = INITIAL, options = OPTIONS, { user = member, aal = "aal2" } = {}) {
    await db.query("savepoint rpc");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
        sub: user, role: user ? "authenticated" : "anon", aal, session_id: session,
      })]);
      await db.query(`set local role ${user ? "authenticated" : "anon"}`);
      const result = (await db.query(
        "select public.submit_weekly_poll_question($1,$2::jsonb) as value", [body, JSON.stringify(options)],
      )).rows[0].value;
      await db.query("reset role");
      await db.query("release savepoint rpc");
      return { ok: true, value: result };
    } catch (error) {
      await db.query("rollback to savepoint rpc; release savepoint rpc");
      return { ok: false, code: error.code, message: error.message, detail: error.detail ?? null, hint: error.hint ?? null };
    }
  }

  async function seed(chapter, user = member, state = "submitted") {
    const id = randomUUID();
    await db.query(`insert into public.member_weekly_questions(id,chapter_id,user_id,week_start,body,options,editorial_state)
      values($1,$2,$3,$4,$5,$6::jsonb,'submitted')`, [id, chapter, user, week, INITIAL, JSON.stringify(OPTIONS)]);
    await setEditorialState(id, chapter, state);
    return id;
  }

  async function setEditorialState(id, chapter, state) {
    await db.query("update public.member_weekly_questions set editorial_state=$2,published_survey_id=$3 where id=$1",
      [id, state, state === "published" ? surveys[chapters.indexOf(chapter)] : null]);
  }

  async function move(depart) {
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [member, chapters[1]]);
    await db.query("update public.member_chapter_memberships set pinned=false where user_id=$1", [member]);
    await db.query(`insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at)
      values($1,$2,'active',true,now()+interval '1 minute')`, [member, chapters[1]]);
    if (depart) await db.query("delete from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [member, chapters[0]]);
    expect((await db.query("select count(*)::integer n from public.member_chapter_memberships where user_id=$1 and chapter_id=$2 and status='active'", [member, chapters[0]])).rows[0].n).toBe(depart ? 0 : 1);
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout='60s'");
    week = (await db.query("select date_trunc('week',private.eastern_day()::timestamp)::date::text week")).rows[0].week;
    await db.query("insert into auth.users(id,email) values($1,$3),($2,$4)", [member, other, `weekly-move-${member}@example.invalid`, `weekly-move-${other}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name) values($1,$2,'Fictional weekly question proof')", [org, `weekly-move-${org}`]);
    for (const [index, chapter] of chapters.entries()) {
      await db.query("insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$4,$2,$3)", [chapter, org, 99310 + index, `Fictional proof chapter ${index}`]);
      await db.query("insert into public.organization_surveys(id,organization_id,chapter_id,title,status) values($1,$2,$3,'Fictional published weekly question','closed')",
        [surveys[index], org, chapter]);
    }
    for (const user of [member, other]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned) values($1,$2,'active',true)", [user, chapters[0]]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapters[0]]);
    }
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, member]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), member]);
  }, 60_000);
  beforeEach(async () => { await db.query("savepoint scenario"); });
  afterEach(async () => { await db.query("rollback to savepoint scenario; release savepoint scenario"); });
  afterAll(async () => {
    if (db) { await db.query("rollback").catch(() => {}); await db.end(); }
  });

  it("preflights each fixture state before the behavior proof", async () => {
    for (const chapter of chapters) for (const state of ["submitted", "reserved", "published"]) {
      await db.query("savepoint fixture");
      try {
        const id = await seed(chapter, member, state);
        expect(byId(await rows(), id)).toMatchObject({ chapter_id: chapter, editorial_state: state,
          published_survey_id: state === "published" ? surveys[chapters.indexOf(chapter)] : null });
        await move(true);
      } finally {
        await db.query("rollback to savepoint fixture; release savepoint fixture");
      }
    }
  });

  it("creates once and edits that same chapter's submitted question", async () => {
    const foreignId = await seed(chapters[0], other);
    const foreign = await rows();
    const created = await act();
    expect(created).toEqual({ ok: true, value: { id: expect.any(String), created: true } });
    const id = created.value.id;
    const before = await rows();
    const saved = byId(before, id);
    expect(saved).toMatchObject({ chapter_id: chapters[0], user_id: member, week_start: week, body: INITIAL, options: OPTIONS, editorial_state: "submitted" });
    expect(await act(EDITED, ["Agree", "Disagree"])).toEqual({ ok: true, value: { id, created: false } });
    const after = await rows();
    expect(after).toHaveLength(2);
    expect(byId(after, foreignId)).toEqual(byId(foreign, foreignId));
    expect(byId(after, id)).toEqual({ ...saved, body: EDITED, options: ["Agree", "Disagree"], updated_at: expect.any(String) });
    expect(await act(EDITED, ["Agree", "Disagree"])).toEqual({ ok: true, value: { id, created: false } });
    expect(await rows()).toEqual(after);
  });

  for (const depart of [false, true]) for (const state of ["submitted", "reserved", "published"]) {
    it(`creates in the new chapter with the old question ${state}, ${depart ? "after full departure" : "after selection only"}`, async () => {
      const control = await act();
      expect(control).toEqual({ ok: true, value: { id: expect.any(String), created: true } });
      const oldId = control.value.id;
      await setEditorialState(oldId, chapters[0], state);
      await seed(chapters[0], other);
      const before = await rows();
      await move(depart);
      const moved = await act(EDITED);
      // This is the C300 reproduction: Main returns oldId, created=false (or
      // refuses the old reserved/published question) instead of inserting here.
      expect(moved).toEqual({ ok: true, value: { id: expect.any(String), created: true } });
      expect(moved.value.id).not.toBe(oldId);
      const after = await rows();
      expect(after.filter((row) => row.chapter_id === chapters[0])).toEqual(before);
      const current = after.filter((row) => row.chapter_id === chapters[1]);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({ id: moved.value.id, user_id: member, week_start: week, body: EDITED, options: OPTIONS, editorial_state: "submitted" });
      expect(await act("Fictional new chapter retry")).toEqual({ ok: true, value: { id: moved.value.id, created: false } });
      expect((await rows()).filter((row) => row.chapter_id === chapters[0])).toEqual(before);
    });
  }

  for (const state of ["submitted", "reserved", "published"]) {
    it(`compares the full current replay with the previous chapter's ${state} row absent and present`, async () => {
      await move(true);
      const ownId = await seed(chapters[1]);
      const before = await rows();
      const missing = await act(EDITED);
      expect(missing).toEqual({ ok: true, value: { id: ownId, created: false } });
      const absentAfter = await rows();
      await db.query("update public.member_weekly_questions set body=$2 where id=$1", [ownId, INITIAL]);
      const foreignId = await seed(chapters[0], member, state);
      const foreignBefore = byId(await rows(), foreignId);
      const present = await act(EDITED);
      expect(present).toEqual(missing);
      const presentAfter = await rows();
      expect(byId(presentAfter, ownId)).toEqual(byId(absentAfter, ownId));
      expect(byId(presentAfter, foreignId)).toEqual(foreignBefore);
      expect(presentAfter).toHaveLength(before.length + 1);
    });
  }

  for (const state of ["reserved", "published"]) {
    it(`preserves the ${state} protection in the current chapter even with an old submitted question`, async () => {
      await seed(chapters[0]);
      await move(true);
      await seed(chapters[1], member, state);
      const before = await rows();
      const expected = { ok: false, code: "22023", message: "reserved or published questions cannot be edited", detail: null, hint: null };
      expect(await act(EDITED)).toEqual(expected);
      expect(await act(EDITED)).toEqual(expected);
      expect(await rows()).toEqual(before);
    });
  }

  it("retains validation, MFA and anonymous refusals without changing either chapter", async () => {
    await seed(chapters[0]);
    const before = await rows();
    for (const [body, options, message] of [
      ["short", OPTIONS, "question and 2 to 8 answer options are required"],
      [INITIAL, ["Only"], "question and 2 to 8 answer options are required"],
      [INITIAL, ["Yes", "Yes"], "answer options must be unique"],
      [INITIAL, ["Yes", 3], "answer options must be plain text up to 120 characters"],
    ]) expect(await act(body, options)).toEqual({ ok: false, code: "22023", message, detail: null, hint: null });
    expect(await act(INITIAL, OPTIONS, { aal: "aal1" })).toEqual({ ok: false, code: "42501", message: "authentication required", detail: null, hint: null });
    expect(await act(INITIAL, OPTIONS, { user: null })).toEqual({ ok: false, code: "42501", message: "permission denied for function submit_weekly_poll_question", detail: null, hint: null });
    expect(await rows()).toEqual(before);
    const grants = (await db.query(`select has_function_privilege('authenticated','public.submit_weekly_question(text)','execute') legacy,
      has_function_privilege('authenticated','public.submit_weekly_poll_question(text,jsonb)','execute') current,
      has_function_privilege('anon','public.submit_weekly_poll_question(text,jsonb)','execute') anon`)).rows[0];
    expect(grants).toEqual({ legacy: false, current: true, anon: false });
  });
});
