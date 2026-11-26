// @vitest-environment node
// #7034: exports with no run row still belong to their caller's practice
// history. Every fixture is fictional, local and rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { learningKinds } from "../scripts/lib/learning-period-parity.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261105030000_learning_period_export_calls.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const TARGET = "private.learning_export_calls";
const EXPORTS = [
  { name: "member directory CSV", fn: "export_member_directory_csv", kind: "member_directory_export_request",
    query: "select public.export_member_directory_csv($1,$2,'en') r", args: (w) => [w.org, w.chapter] },
  { name: "survey results", fn: "export_organization_survey_results", kind: "survey_export_request",
    query: "select public.export_organization_survey_results($1) r", args: (w) => [w.survey] },
  { name: "survey date window", fn: "export_organization_survey_window", kind: "survey_export_request",
    query: "select public.export_organization_survey_window($1,null,null,'json') r", args: (w) => [w.survey] },
  { name: "ballot nominations", fn: "export_ballot_nominations", kind: "ballot_nominations_export_request",
    query: "select public.export_ballot_nominations($1) r", args: (w) => [w.ballot] },
  { name: "case export record", fn: "casework_record_case_export", kind: "case_export_request",
    query: "select public.casework_record_case_export($1,'selection','{}') r", args: (w) => [[w.case]] },
];

describe("learning export calls migration", () => {
  it("extends the permanent export kinds, gates writers first and preserves the installed dispatch chain", () => {
    const code = stripComments(sql);
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("set local search_path = pg_catalog;");
    expect(code).not.toMatch(/set_config\(\s*'search_path'/i);
    expect(code).not.toMatch(/(?:create|alter|drop).*function private\.(?:learning_dispatch|close_learning_period)/i);
    const functions = parseFunctions(sql);
    expect(functions.map((fn) => fn.name).sort()).toEqual([...EXPORTS.map((x) => `public.${x.fn}`), "public.get_ballot_nominations"].sort());
    for (const spec of EXPORTS) {
      const fn = functions.find((fn) => fn.name === `public.${spec.fn}`);
      expect(helperFirst(fn.source), spec.fn).toBe(true);
      expect(fn.source).toContain(`private.learning_journal_append('${spec.kind}'`);
      const header = sql.slice(fn.offset, sql.indexOf("$function$", fn.offset));
      // Volatility is explicit even though PostgreSQL defaults an omitted
      // declaration to VOLATILE. The live half checks the installed value.
      expect(header, spec.fn).toMatch(/\bvolatile\b/i);
    }
    expect(learningKinds([sql])).toHaveLength(4);
    for (const kind of learningKinds([sql])) expect(kind).toMatchObject({ targetTable: TARGET, disposition: "permanent", handler: null });
  });

  // Unsent broadcast drafts have no persisted storage and are not sent items,
  // so they have no journal entry; persisted drafts would be journalled as
  // Reverse.
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("learning export calls on an owned disposable database", () => {
  let c, w;
  const q = async (text, values = []) => (await c.query(text, values)).rows;
  async function call(user, text, values = []) {
    await c.query("savepoint request");
    try {
      await c.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" })]);
      await c.query("set local role authenticated");
      const rows = await q(text, values);
      await c.query("reset role");
      await c.query("release savepoint request");
      return { ok: true, value: rows[0]?.r };
    } catch (error) {
      await c.query("rollback to savepoint request");
      await c.query("release savepoint request");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  async function one(user, text, values = []) {
    const result = await call(user, text, values);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.value;
  }
  const history = (user) => one(user, "select public.list_my_learning_history(200) r");
  const run = (spec, user = w.actor) => one(user, spec.query, spec.args(w));
  const start = () => one(w.actor, "select public.start_organization_learning_period() r");
  const entries = () => q("select * from private.learning_action_journal where target_table=$1 order by created_at,id", [TARGET]);

  async function person(org, chapter, staff) {
    const user = { id: randomUUID(), session: randomUUID() };
    await q("insert into auth.users(id,email) values($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, user.id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user.id, chapter]);
    await q("update public.member_profiles set chapter_id=$2,full_name='Fictional export proof' where id=$1", [user.id, chapter]);
    if (staff) {
      await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [org, user.id]);
      await q("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [user.id, chapter]);
      await q("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [user.id, chapter]);
    }
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [user.session, user.id]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    return user;
  }

  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-export-calls-rollback-proof" });
    await c.connect();
    await q("begin");
    await releaseLearningPeriodHold(c);
    await q("set local statement_timeout = '60s'");
    w = { org: randomUUID(), chapter: `export-learn-${randomUUID().slice(0, 8)}`, survey: randomUUID(), ballot: `export-learn-${randomUUID()}`, case: randomUUID() };
    await q("insert into public.organizations(id,slug,name) values($1,$2,'Fictional export proof')", [w.org, w.chapter]);
    await q("insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,$2,98319)", [w.chapter, w.org]);
    w.actor = await person(w.org, w.chapter, true);
    w.peer = await person(w.org, w.chapter, true);
    w.unrelated = await person(w.org, w.chapter, false);
    await q("insert into public.organization_surveys(id,organization_id,chapter_id,title,status,privacy_min_responses,created_by) values($1,$2,$3,'Fictional survey','closed',3,$4)", [w.survey, w.org, w.chapter, w.actor.id]);
    const question = randomUUID();
    await q("insert into public.organization_survey_questions(id,organization_id,survey_id,sort_index,question_type,label) values($1,$2,$3,0,'yes_no','Fictional question')", [question, w.org, w.survey]);
    for (let i = 0; i < 25; i++) {
      const user = await person(w.org, w.chapter, false);
      const [session] = await q("insert into public.organization_survey_sessions(organization_id,survey_id,respondent_user_id,status,submitted_at) values($1,$2,$3,'submitted',now()) returning id", [w.org, w.survey, user.id]);
      await q("insert into public.organization_survey_answers(organization_id,session_id,question_id,value) values($1,$2,$3,'true')", [w.org, session.id, question]);
    }
    await q("insert into public.member_ballots(id,title,body,closes_at,chapter_id,organization_id,campaign_state,active,nominations_close_at,order_index) values($1,'Fictional nominations','',now()+interval '2 days',$2,$3,'draft',false,now()+interval '1 day',98319)", [w.ballot, w.chapter, w.org]);
    await q("insert into public.ballot_nominations(ballot_id,organization_id,nominee_name,statement,nominated_by) values($1,$2,'Fictional nominee','Private nomination statement',$3)", [w.ballot, w.org, w.unrelated.id]);
    await q("insert into public.member_cases(id,user_id,reference,title,case_type,step,status) values($1,$2,$3,'Private case title','other','Intake','active')", [w.case, w.unrelated.id, `EXPORT-${w.case.slice(0, 8)}`]);
    const otherOrg = randomUUID(), otherChapter = `export-other-${randomUUID().slice(0, 8)}`;
    await q("insert into public.organizations(id,slug,name) values($1,$2,$2)", [otherOrg, otherChapter]);
    await q("insert into public.chapters(id,slug,name,organization_id,order_index) values($1,$1,$1,$2,98320)", [otherChapter, otherOrg]);
    w.outsider = await person(otherOrg, otherChapter, true);
    w.otherOrg = otherOrg;
    w.otherChapter = otherChapter;
  }, 60000);
  beforeEach(async () => { await q("savepoint scenario"); });
  afterEach(async () => { await q("rollback to savepoint scenario"); });
  afterAll(async () => { if (c) { await c.query("rollback").catch(() => {}); await c.end(); } });

  for (const spec of EXPORTS) {
    it(`${spec.name}: the caller sees a unique permanent practice receipt; unrelated members cannot read or forge it`, async () => {
      await start();
      await run(spec);
      await run(spec);
      const rows = await entries();
      expect(rows).toHaveLength(2); // Fails before #7034: no export call entries.
      expect(new Set(rows.map((r) => r.target_id)).size).toBe(2);
      for (const row of rows) expect(row).toMatchObject({ organization_id: w.org, actor_user_id: w.actor.id, action_kind: spec.kind,
        state: "kept", before_image: null, before_ref: null, after_fingerprint: null, parent_entry_id: null });
      const mine = await history(w.actor);
      expect(mine.running).toBe(true);
      expect(mine.entries.filter((e) => e.actionKind === spec.kind)).toHaveLength(2);
      expect(mine.entries[0]).toMatchObject({ domain: "exports", disposition: "permanent", sent: true, undoable: false });
      expect((await history(w.unrelated)).entries).toEqual([]);
      expect((await history(w.peer)).entries).toEqual([]);
      expect((await history(w.outsider)).entries).toEqual([]);
      for (const user of [w.unrelated, w.outsider]) {
        expect(await call(user, spec.query, spec.args(w))).toMatchObject({ ok: false });
        expect(await call(user, "select public.undo_my_learning_action($1,1) r", [rows[0].id])).toMatchObject({ ok: false });
      }
      expect(await call(w.actor, "select public.undo_my_learning_action($1,1) r", [rows[0].id])).toMatchObject({ ok: false, code: "55000" });
      expect(await entries()).toHaveLength(2);
      const flags = await q("select * from private.learning_practice_flags($1,$2)", [TARGET, rows.map((r) => r.target_id)]);
      expect(flags.map((r) => r.flag)).toEqual(["practice", "practice"]);
      expect(JSON.stringify(rows)).not.toMatch(/Private nomination statement|Private case title|Fictional nominee|responses|answers/);
      await run(spec, w.peer);
      expect((await history(w.actor)).entries.filter((e) => e.actionKind === spec.kind)).toHaveLength(2);
      expect((await history(w.peer)).entries.filter((e) => e.actionKind === spec.kind)).toHaveLength(1);
    });
  }

  it("does not journal any of the five calls outside a running learning period", async () => {
    for (const spec of EXPORTS) await run(spec);
    expect(await entries()).toEqual([]);
  });

  it("refuses a cross-selected case export even when the staff caller belongs to both organizations", async () => {
    await start();
    await one(w.outsider, "select public.start_organization_learning_period() r");
    await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [w.otherOrg, w.actor.id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [w.actor.id, w.otherChapter]);
    await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [w.otherOrg, w.actor.id]);
    await q("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [w.actor.id, w.otherChapter]);
    await q("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [w.actor.id, w.otherChapter]);
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [w.actor.id, w.otherChapter]);
    const before = await q("select count(*)::int n from public.casework_audit_events where event_type='cases_exported'");
    expect(await call(w.actor, EXPORTS[4].query, EXPORTS[4].args(w))).toMatchObject({ ok: false, code: "P0002" });
    expect(await entries()).toEqual([]);
    expect(await q("select count(*)::int n from public.casework_audit_events where event_type='cases_exported'")).toEqual(before);
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [w.actor.id, w.chapter]);
    await run(EXPORTS[4]);
    expect(await entries()).toMatchObject([{ organization_id: w.org, actor_user_id: w.actor.id }]);
  });

  for (const early of [true, false]) it(`keeps every export just like existing exports on ${early ? "early" : "scheduled"} close, idempotently`, async () => {
    await start();
    for (const spec of EXPORTS) await run(spec);
    const before = await entries();
    expect(before).toHaveLength(5);
    // An existing run-row kind through the same engine provides the control.
    await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: w.actor.id, role: "authenticated", aal: "aal2", session_id: w.actor.session })]);
    await q("select private.learning_journal_append('organization_export_request','public.organization_data_export_runs',$1)", [randomUUID()]);
    if (early) await one(w.actor, "select public.end_organization_learning_period_early() r");
    else {
      // Advance the fixture's clock exactly as the engine's scheduled-close
      // proof does; the real period remains immutable to every caller.
      await q("alter table private.organization_learning_periods disable trigger b10_learning_period_guard");
      await q("update private.organization_learning_periods set starts_at=starts_at-interval '15 days',ends_at=ends_at-interval '15 days' where organization_id=$1", [w.org]);
      await q("alter table private.organization_learning_periods enable trigger b10_learning_period_guard");
      await q("select private.close_learning_period(id) from private.organization_learning_periods where organization_id=$1", [w.org]);
    }
    await q("select private.close_learning_period(id) from private.organization_learning_periods where organization_id=$1", [w.org]);
    expect(await entries()).toEqual(before);
    const mine = await history(w.actor);
    expect(mine.running).toBe(false);
    expect(mine.entries).toHaveLength(6);
    for (const entry of mine.entries) expect(entry).toMatchObject({ state: "kept", sent: true, undoable: false });
    for (const spec of EXPORTS) await run(spec);
    expect(await entries()).toHaveLength(5);
    expect((await history(w.unrelated)).entries).toEqual([]);
  });

  it("does not journal a privacy-withheld results response or a refused window export", async () => {
    await q("update public.organization_surveys set privacy_min_responses=26 where id=$1", [w.survey]);
    await start();
    const result = await run(EXPORTS[1]);
    expect(result).toMatchObject({ available: false, responses: [] });
    expect(await entries()).toHaveLength(0);
    expect(await call(w.actor, EXPORTS[2].query, EXPORTS[2].args(w))).toMatchObject({ ok: false, code: "22023" });
    expect(await entries()).toHaveLength(0);
  });

  it("installs every journalling export as a VOLATILE function", async () => {
    const rows = await q(`select p.proname, p.provolatile from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1::text[]) order by p.proname`, [EXPORTS.map((spec) => spec.fn)]);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.provolatile, row.proname).toBe("v");
  });

  it("nomination panel reads and refreshes create no receipt; each explicit export creates exactly one", async () => {
    await start();
    for (let i = 0; i < 3; i++) {
      const result = await one(w.actor, "select public.get_ballot_nominations($1) r", [w.ballot]);
      expect(result.nominations).toHaveLength(1);
    }
    expect(await entries()).toEqual([]);
    expect(await call(w.unrelated, "select public.get_ballot_nominations($1) r", [w.ballot])).toMatchObject({ ok: false, code: "42501" });
    expect(await call(w.outsider, "select public.get_ballot_nominations($1) r", [w.ballot])).toMatchObject({ ok: false });
    await run(EXPORTS[3]);
    expect(await entries()).toHaveLength(1);
    await one(w.actor, "select public.get_ballot_nominations($1) r", [w.ballot]);
    expect(await entries()).toHaveLength(1);
    const [reader] = await q("select provolatile from pg_catalog.pg_proc where oid='public.get_ballot_nominations(text)'::regprocedure");
    expect(reader.provolatile).toBe("s");
  });

  it("refuses a foreign survey before invoking the report, even if the inner report boundary weakens", async () => {
    const foreign = randomUUID();
    await q("insert into public.organization_surveys(id,organization_id,chapter_id,title,status,privacy_min_responses,created_by) values($1,$2,$3,'Foreign survey','closed',3,$4)", [foreign, w.otherOrg, w.otherChapter, w.outsider.id]);
    await start();
    expect(await call(w.actor, EXPORTS[2].query, [foreign])).toMatchObject({ ok: false, code: "P0002" });
    // This rollback-scoped fault makes the outer ownership check an
    // independent boundary rather than relying on the delegated report.
    const [reader] = await q("select pg_catalog.pg_get_functiondef('public.get_organization_survey_report_window(uuid,timestamptz,timestamptz)'::regprocedure) definition");
    const bodyStart = reader.definition.indexOf("AS $function$") + "AS $function$".length;
    const bodyEnd = reader.definition.lastIndexOf("$function$");
    await q(reader.definition.slice(0, bodyStart) + " begin return '{\"available\":true,\"questions\":[]}'::jsonb; end; " + reader.definition.slice(bodyEnd));
    expect(await call(w.actor, EXPORTS[2].query, [foreign])).toMatchObject({ ok: false, code: "P0002" });
    expect(await entries()).toEqual([]);
    await run(EXPORTS[2]);
    expect(await entries()).toHaveLength(1);
  });

  const refusedArgs = [
    (w) => [w.otherOrg, w.chapter],
    () => [randomUUID()],
    () => [randomUUID()],
    () => [`missing-${randomUUID()}`],
    () => [[]],
  ];
  for (const [index, spec] of EXPORTS.entries()) {
    it(`${spec.name}: a response withheld by authorization or an invalid target creates no receipt`, async () => {
      await start();
      expect(await call(w.unrelated, spec.query, spec.args(w))).toMatchObject({ ok: false });
      expect(await call(w.actor, spec.query, refusedArgs[index](w))).toMatchObject({ ok: false });
      expect(await entries()).toEqual([]);
      expect((await history(w.actor)).entries.filter((row) => row.targetTable === TARGET)).toEqual([]);
      await run(spec);
      expect(await entries()).toHaveLength(1);
    });

    it(`${spec.name}: a raised error after the receipt attempt rolls back the entire export`, async () => {
      await start();
      const [engine] = await q(`select pg_catalog.pg_get_functiondef(
        'private.learning_journal_append(text,text,text,uuid,text,bigint,jsonb)'::regprocedure) definition`);
      expect(engine.definition).toContain("return entry;");
      // Fault injection is confined to this proof transaction. The exception
      // occurs after INSERT, so this also proves a late error cannot commit
      // a receipt even when the caller catches the failed RPC statement.
      await q(engine.definition.replace("return entry;", "raise exception 'export receipt proof aborted' using errcode='P0001'; return entry;"));
      const before = await q(`select
        (select count(*)::int from public.organization_audit_ledger where organization_id=$1) ledger,
        (select count(*)::int from public.casework_audit_events where organization_id=$1) cases`, [w.org]);
      expect(await call(w.actor, spec.query, spec.args(w))).toMatchObject({ ok: false, code: "P0001" });
      expect(await entries()).toEqual([]);
      expect(await q(`select
        (select count(*)::int from public.organization_audit_ledger where organization_id=$1) ledger,
        (select count(*)::int from public.casework_audit_events where organization_id=$1) cases`, [w.org])).toEqual(before);
    });
  }
});
