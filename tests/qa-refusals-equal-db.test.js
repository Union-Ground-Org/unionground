// @vitest-environment node
// SEC-UG-QA-REFUSALS-REVEAL-ANOTHER-CHAPTERS-QUESTION-20261115 .
// Editing or deleting a Q&A question or reply, an official reply, and
// accepting an answer must refuse another chapter's live question or reply
// exactly as they refuse an id that does not exist (same SQLSTATE and
// message), for a member, steward, coordinator and president of another
// chapter. Accepting refuses that way for any version (none, stale, current)
// and any reply (official, follow-up, or a reply of another question), before
// its version and kind checks. The question's own
// chapter can still act on it. Every row is fictional and every write rolls
// back on the runner-owned database.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

const FUNCTIONS = Object.freeze([
  "edit_member_qa_question",
  "delete_member_qa_question",
  "edit_member_qa_reply",
  "delete_member_qa_reply",
  "reply_member_qa_official",
  "accept_member_qa_answer",
]);
const VISIBLE = "or not private.mi1_qa_can_see(question.organization_id, question.chapter_id)";

describe("Q&A refusal migration", () => {
  it("guards each predecessor body, keeps the case-graph gate first, and adds the visibility test to every not-found refusal", () => {
    const SQL = loadMigrationSql("qa_refusal_equal_for_missing_and_invisible");
    const bodies = SQL.split(/^CREATE OR REPLACE FUNCTION /mu).slice(1);
    expect(bodies.map((text) => text.slice(0, text.indexOf("("))).sort()).toEqual(FUNCTIONS.map((name) => `public.${name}`).sort());
    for (const name of FUNCTIONS) {
      expect(SQL, name).toContain(`unreviewed predecessor: public.${name}`);
      const text = bodies.find((body) => body.startsWith(`public.${name}(`));
      // The installed bodies run behind the case-graph gate; re-emitting one
      // must keep the gate as its first statement.
      expect(text.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"), name).toBeGreaterThan(0);
      expect(text.indexOf("perform private.lock_case_graph("), name).toBeLessThan(text.indexOf("declare"));
      // No row lock before the refusal: a caller must not wait on another
      // chapter's held row and then be refused (a timing difference).
      const lock = text.indexOf("for update");
      expect(text.indexOf(VISIBLE), name).toBeGreaterThan(0);
      expect(lock === -1 || text.indexOf(VISIBLE) < lock, `${name}: for update precedes the visibility test`).toBe(true);
      // A function that locks the row checks again once it holds the lock.
      expect(text.split(VISIBLE).length - 1, name).toBe(lock === -1 ? 1 : 2);
      if (lock !== -1) expect(text.lastIndexOf(VISIBLE), name).toBeGreaterThan(lock);
    }
    expect(FUNCTIONS.filter((name) => bodies.find((body) => body.startsWith(`public.${name}(`)).includes("for update")).sort())
      .toEqual(["accept_member_qa_answer", "reply_member_qa_official"]);
    // accept refuses another chapter's question before its version and kind checks.
    const accept = bodies.find((body) => body.startsWith("public.accept_member_qa_answer("));
    expect(accept.indexOf(VISIBLE)).toBeLessThan(accept.indexOf("stale question; reload required"));
    expect(accept.indexOf(VISIBLE)).toBeLessThan(accept.indexOf("only official replies can be accepted"));
  });
});

// Every role of the first chapter.
const ROLES = Object.freeze(["member", "steward", "coordinator", "vp"]);
const MISSING = Object.freeze({ ok: false, code: "P0002", message: "not found" });

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("Q&A refusals are the same for a missing id and another chapter's question or reply (#8864)", () => {
  let db;
  const f = { org: randomUUID(), people: {}, rows: {} };
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
    await db.query("savepoint qa_refusal");
    try {
      await db.query(sql, args);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: error.code, message: error.message };
    } finally {
      await db.query("rollback to savepoint qa_refusal");
      await db.query("release savepoint qa_refusal");
    }
  };
  // Runs the RPC as a person and keeps its effect (fixture setup only).
  const call = async (name, sql, args) => {
    await as(name);
    const result = (await db.query(sql, args)).rows[0];
    await owner();
    return result;
  };
  // Versions travel as text: a JavaScript Date would drop the microseconds.
  const updatedAt = async (questionId, shift = "0 seconds") => (await db.query("select (updated_at - $2::interval)::text as version from public.member_qa_questions where id = $1", [questionId, shift])).rows[0].version;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "qa-refusals-equal-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    f.home = `qa-home-${f.org}`;
    f.other = `qa-other-${f.org}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Union')", [f.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$3,9987),($2,$2,$2,$3,9988)", [f.home, f.other, f.org]);
    const chapterOf = { otherMember: f.other, otherSteward: f.other };
    for (const name of [...ROLES, "otherMember", "otherSteward"]) {
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
      const role = { steward: "steward", coordinator: "coordinator", vp: "vp", otherSteward: "steward" }[name];
      if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
      }
    }
    const ask = (name, title) => call(name, "select (public.ask_member_qa_question($1,$2,$3))->>'id' as id", [title, "Fictional question body for the refusal proof.", randomUUID()]);
    const reply = async (name, fn, questionId, body) => {
      await call(name, `select public.${fn}($1,$2,$3)`, [questionId, body, randomUUID()]);
      return (await db.query("select id from public.member_qa_replies where question_id=$1 and body=$2", [questionId, body])).rows[0].id;
    };
    // The other chapter's live question with an official and a follow-up
    // reply, and a home question with an official reply.
    f.rows.otherQuestion = (await ask("otherMember", "Fictional other chapter question")).id;
    f.rows.otherOfficial = await reply("otherSteward", "reply_member_qa_official", f.rows.otherQuestion, "Fictional official answer");
    f.rows.otherFollowUp = await reply("otherMember", "reply_member_qa_follow_up", f.rows.otherQuestion, "Fictional follow-up");
    f.rows.homeQuestion = (await ask("member", "Fictional home question")).id;
    f.rows.homeOfficial = await reply("steward", "reply_member_qa_official", f.rows.homeQuestion, "Fictional home answer");
  });
  // A failed assertion leaves the caller's role set; start each case as owner.
  beforeEach(async () => { await owner(); });
  afterAll(async () => {
    if (db) {
      await db.query("rollback");
      await db.end();
    }
  });

  const questionActions = {
    edit_member_qa_question: (id) => ["select public.edit_member_qa_question($1,$2,$3)", [id, "Fictional new title", "Fictional new body"]],
    delete_member_qa_question: (id) => ["select public.delete_member_qa_question($1)", [id]],
    reply_member_qa_official: (id) => ["select public.reply_member_qa_official($1,$2,$3)", [id, "Fictional new answer", randomUUID()]],
  };
  const replyActions = {
    edit_member_qa_reply: (id) => ["select public.edit_member_qa_reply($1,$2)", [id, "Fictional new reply body"]],
    delete_member_qa_reply: (id) => ["select public.delete_member_qa_reply($1)", [id]],
  };

  it.each(Object.keys(questionActions))("%s: every role gets the same refusal for a missing question and another chapter's", async (name) => {
    for (const role of ROLES) {
      await as(role);
      const missing = await attempt(...questionActions[name](randomUUID()));
      expect(missing, `${name} ${role} missing`).toEqual(MISSING);
      expect(await attempt(...questionActions[name](f.rows.otherQuestion)), `${name} ${role} other chapter`).toEqual(missing);
    }
    await owner();
  });

  it.each(Object.keys(replyActions))("%s: every role gets the same refusal for a missing reply and another chapter's official or follow-up reply", async (name) => {
    for (const role of ROLES) {
      await as(role);
      const missing = await attempt(...replyActions[name](randomUUID()));
      expect(missing, `${name} ${role} missing`).toEqual(MISSING);
      expect(await attempt(...replyActions[name](f.rows.otherOfficial)), `${name} ${role} other official`).toEqual(missing);
      expect(await attempt(...replyActions[name](f.rows.otherFollowUp)), `${name} ${role} other follow-up`).toEqual(missing);
    }
    await owner();
  });

  it("accept_member_qa_answer: another chapter's question is refused as missing for any version and any reply", async () => {
    const accept = "select public.accept_member_qa_answer($1,$2,true,$3)";
    const current = await updatedAt(f.rows.otherQuestion);
    const stale = await updatedAt(f.rows.otherQuestion, "1 minute");
    for (const role of ROLES) {
      await as(role);
      const missing = await attempt(accept, [randomUUID(), randomUUID(), null]);
      expect(missing, `${role} missing`).toEqual(MISSING);
      for (const [replyLabel, replyId] of [["official", f.rows.otherOfficial], ["follow-up", f.rows.otherFollowUp], ["another question's", f.rows.homeOfficial]]) {
        for (const [versionLabel, version] of [["none", null], ["stale", stale], ["current", current]]) {
          expect(await attempt(accept, [f.rows.otherQuestion, replyId, version]), `${role} ${replyLabel} reply, ${versionLabel} version`).toEqual(missing);
        }
      }
    }
    await owner();
  });

  it("lets the question's own chapter act on it", async () => {
    await as("otherSteward");
    expect(await attempt(...questionActions.edit_member_qa_question(f.rows.otherQuestion))).toEqual({ ok: true });
    expect(await attempt(...questionActions.reply_member_qa_official(f.rows.otherQuestion))).toEqual({ ok: true });
    expect(await attempt(...replyActions.edit_member_qa_reply(f.rows.otherOfficial))).toEqual({ ok: true });
    expect(await attempt(...replyActions.delete_member_qa_reply(f.rows.otherFollowUp))).toEqual({ ok: true });
    await owner();
    const version = await updatedAt(f.rows.otherQuestion);
    await as("otherMember");
    expect(await attempt("select public.accept_member_qa_answer($1,$2,true,$3)", [f.rows.otherQuestion, f.rows.otherOfficial, version])).toEqual({ ok: true });
    expect(await attempt(...questionActions.delete_member_qa_question(f.rows.otherQuestion))).toEqual({ ok: true });
    await as("member");
    expect(await attempt(...questionActions.edit_member_qa_question(f.rows.homeQuestion))).toEqual({ ok: true });
    await owner();
  });
});

// Grok pre-push read of: a function that locks the question row must
// refuse another chapter's question before it waits for that row's lock, or
// the wait tells a held row apart from a missing id. These rows must be
// committed so a second connection can hold the lock; they are removed after.
live("Q&A refusals do not wait on another chapter's held question (#8864)", () => {
  const url = () => assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
  const c = { org: randomUUID(), caller: randomUUID(), callerSession: randomUUID(), author: randomUUID(), question: randomUUID() };
  c.home = `qa-wait-home-${c.org}`;
  c.other = `qa-wait-other-${c.org}`;
  let holder;
  let caller;
  const LOCKERS = {
    reply_member_qa_official: ["select public.reply_member_qa_official($1,$2,$3)", () => [c.question, "Fictional answer", randomUUID()]],
    accept_member_qa_answer: ["select public.accept_member_qa_answer($1,$2,true,null)", () => [c.question, randomUUID()]],
  };

  beforeAll(async () => {
    holder = new pg.Client({ connectionString: url(), application_name: "qa-refusal-wait-holder" });
    caller = new pg.Client({ connectionString: url(), application_name: "qa-refusal-wait-caller" });
    await holder.connect();
    await caller.connect();
    await holder.query("begin");
    await holder.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Union')", [c.org]);
    await holder.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$3,9985),($2,$2,$2,$3,9986)", [c.home, c.other, c.org]);
    for (const [id, chapter] of [[c.caller, c.home], [c.author, c.other]]) {
      await holder.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await holder.query("update public.member_profiles set chapter_id=$2,full_name='Fictional member' where id=$1", [id, chapter]);
      await holder.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [c.org, id]);
      await holder.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
    }
    await holder.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [c.callerSession, c.caller]);
    await holder.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), c.caller]);
    await holder.query("insert into public.member_qa_questions(id,organization_id,chapter_id,author_user_id,title,body) values($1,$2,$3,$4,'Fictional held question','Fictional body')",
      [c.question, c.org, c.other, c.author]);
    await holder.query("commit");
  });
  // Removes every committed row: the fixture's own rows, then rows that
  // triggers wrote for the organization (found from the foreign keys that
  // reference it), then the organization. Run as the last case so a failure
  // shows as a failure and later proofs never meet these rows.
  const removeFixture = async () => {
    await holder.query("rollback");
    await holder.query("begin");
    await holder.query("delete from public.member_qa_questions where organization_id=$1", [c.org]);
    await holder.query("delete from auth.users where id = any($1::uuid[])", [[c.caller, c.author]]);
    await holder.query("delete from public.chapters where id = any($1::text[])", [[c.home, c.other]]);
    const references = (await holder.query(`select c.conrelid::regclass::text as relation, pg_catalog.quote_ident(a.attname) as column_name
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and c.confrelid = 'public.organizations'::regclass and pg_catalog.array_length(c.conkey, 1) = 1`)).rows;
    for (let pass = 0; pass < 5; pass += 1) {
      let blocked = 0;
      for (const { relation, column_name: column } of references) {
        await holder.query("savepoint qa_wait_cleanup");
        try {
          await holder.query(`delete from ${relation} where ${column} = $1`, [c.org]);
          await holder.query("release savepoint qa_wait_cleanup");
        } catch {
          await holder.query("rollback to savepoint qa_wait_cleanup");
          blocked += 1;
        }
      }
      if (!blocked) break;
    }
    await holder.query("delete from public.organizations where id=$1", [c.org]);
    await holder.query("commit");
    c.removed = true;
  };
  afterAll(async () => {
    try {
      if (holder && !c.removed) await removeFixture();
    } finally {
      await caller?.end();
      await holder?.end();
    }
  });

  it.each(Object.keys(LOCKERS))("%s refuses another chapter's held question at once, as a missing id", async (name) => {
    const [sql, args] = LOCKERS[name];
    const call = async (params) => {
      await caller.query("begin");
      try {
        await caller.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: c.caller, session_id: c.callerSession, role: "authenticated", aal: "aal2" })]);
        await caller.query("set local role authenticated");
        await caller.query("set local lock_timeout = '1s'");
        const started = Date.now();
        try {
          await caller.query(sql, params);
          return { result: { ok: true }, waited: Date.now() - started };
        } catch (error) {
          return { result: { ok: false, code: error.code, message: error.message }, waited: Date.now() - started };
        }
      } finally {
        await caller.query("rollback");
      }
    };
    const missing = await call([randomUUID(), ...args().slice(1)]);
    expect(missing.result).toEqual(MISSING);
    await holder.query("begin");
    try {
      await holder.query("select 1 from public.member_qa_questions where id=$1 for update", [c.question]);
      const held = await call(args());
      expect(held.result, `${name} on a held row`).toEqual(MISSING);
      expect(held.waited, `${name} waited on the held row`).toBeLessThan(500);
    } finally {
      await holder.query("rollback");
    }
  });

  it("removes every row it committed", async () => {
    await removeFixture();
    const left = (await holder.query("select count(*)::int as n from public.organizations where id=$1", [c.org])).rows[0].n;
    expect(left).toBe(0);
  });
});
