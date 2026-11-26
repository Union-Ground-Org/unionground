// @vitest-environment node
// #7634: the member's latest notice follows a learning-period case reopening.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

describe("learning outcome undo notice contract", () => {
  it("pins the existing authority, immutable reopening version and content-free correcting notice", () => {
    const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
    const handler = contract.functions.find((f) => f.sig === "private.learning_undo_case_outcome(p_mode text, p_entry jsonb)");
    expect(handler).toMatchObject({ secdef: true, exec: "" });
    const body = latestFnBody("private.learning_undo_case_outcome").replace(/\s+/g, " ");
    for (const pin of handler.bodyContains) expect(body).toContain(pin);
    expect(handler.bodyContains).toContain("n.created_at = (v.new_row ->> 'updated_at')::timestamptz");
    expect(handler.bodyContains).toContain("private.notify_member(recipient, 'case.reopened', '{}'::jsonb, 'cases')");
    expect(handler.bodyContains).toContain("p_entry -> 'final_projected' -> ('public.member_cases:' || target::text) ->> 'status' = 'active'");
    expect(body).not.toMatch(/(?:delete from|update) public\.member_notifications/);
  });

  it("only adds the final chain projection to the current engine's apply payload", () => {
    const squash = (sql) => stripComments(sql).replace(/\s+/g, " ").trim();
    const predecessor = squash(fnBody(loadMigrationSql("20261106220000_conflict_refusals_not_retried"), "public.undo_my_learning_action"));
    const engine = squash(latestFnBody("public.undo_my_learning_action"));
    const payload = "pg_catalog.to_jsonb(item) || pg_catalog.jsonb_build_object('final_projected', projected, 'chain_entry_ids', chain_ids)";
    expect(engine).toContain(`private.learning_dispatch(item.handler, 'apply', ${payload})`);
    expect(engine.replace(payload, "pg_catalog.to_jsonb(item)")).toBe(predecessor);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("learning outcome undo corrects a sent resolution notice", () => {
  let db;
  let w;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
    await db.connect();
  });
  afterAll(async () => { await db?.end(); });
  afterEach(async () => { await db.query("rollback"); });
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows;
  const root = () => db.query("reset role");
  async function rpc(sql, params = [], actor = w.staff) {
    await root();
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      role: "authenticated", sub: actor.id, session_id: actor.session, aal: "aal2",
    })]);
    await db.query("set local role authenticated");
    const result = await rows(sql, params);
    await root();
    return result[0]?.r;
  }
  async function person(role) {
    const user = { id: randomUUID(), session: randomUUID() };
    await db.query("insert into auth.users(id,email) values($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [user.session, user.id]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [w.org, user.id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user.id, w.chapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, w.chapter]);
    if (role) await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)", [w.org, user.id, role]);
    return user;
  }
  beforeEach(async () => {
    await db.query("begin");
    await releaseLearningPeriodHold(db);
    w = { org: randomUUID(), chapter: `tamarack-undo-${randomUUID()}`, case: randomUUID() };
    await db.query("insert into public.organizations(id,slug,name) values($1,$2,'Tamarack notice proof')", [w.org, w.chapter]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Tamarack notice proof',$1,$2,98931)", [w.chapter, w.org]);
    w.admin = await person("admin");
    w.staff = await person("coordinator");
    w.member = await person();
    await db.query("insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,status) values($1,$2,$3,$4,'NOTICE-PRIVATE','Fictional private title','other','active')", [w.case, w.member.id, w.org, w.chapter]);
    await rpc("select public.start_organization_learning_period() as r", [], w.admin);
  });
  const record = (summary = "Fictional private settlement") => rpc("select public.coordinator_record_case_outcome($1,'settled',$2) as r", [w.case, summary]);
  const entries = () => rows("select id,version,parent_entry_id from private.learning_action_journal where target_id=$1 and action_kind='case_outcome' order by created_at,id", [w.case]);
  const undo = (entry) => rpc("select public.undo_my_learning_action($1,$2) as r", [entry.id, entry.version]);
  const notices = () => rows("select * from public.member_notifications where user_id=$1 and copy_key in ('case.resolved','case.reopened') order by created_at,id", [w.member.id]);
  async function expectReopened(count = 1) {
    expect(await rows("select status from public.member_cases where id=$1", [w.case])).toEqual([{ status: "active" }]);
    const corrections = (await notices()).filter((n) => n.copy_key === "case.reopened");
    expect(corrections).toHaveLength(count);
    for (const n of corrections) {
      expect(n).toMatchObject({ kind: "cases", source_chapter_id: w.chapter, read_at: null });
      expect(`${n.title} ${n.body}`).not.toMatch(/NOTICE-PRIVATE|Fictional|settled|private title/);
    }
    expect(await rows("select id from public.member_notifications where user_id=$1 and copy_key='case.reopened'", [w.staff.id])).toEqual([]);
    return corrections;
  }

  it.each(["en", "es"])("corrects the reopening in %s, preserves the read resolution, and makes retries silent", async (language) => {
    await db.query("update public.member_profiles set language=$2 where id=$1", [w.member.id, language]);
    await record();
    await db.query("update public.member_notifications set read_at=now() where user_id=$1", [w.member.id]);
    const before = await notices();
    expect(before).toHaveLength(1);
    const [entry] = await entries();
    expect(await undo(entry)).toMatchObject({ status: "undone" });
    const [correction] = await expectReopened();
    expect(correction.title).toBe(language === "es" ? "Tu caso se reabrió" : "Your case was reopened");
    expect(await rows("select * from public.member_case_outcomes where case_id=$1", [w.case])).toEqual([]);
    expect((await notices()).filter((n) => n.copy_key === "case.resolved")).toEqual(before);
    expect(await undo(entry)).toMatchObject({ status: "already_undone" });
    expect(await expectReopened()).toHaveLength(1);
  });

  it("does not invent a correction when no resolution notice was sent, even with an older resolution notice", async () => {
    await record();
    // Model a pre-notification action; an unrelated old notice is insufficient.
    await db.query("update public.member_notifications set created_at=created_at-interval '1 day' where user_id=$1 and copy_key='case.resolved'", [w.member.id]);
    const [entry] = await entries();
    expect(await undo(entry)).toMatchObject({ status: "undone" });
    await expectReopened(0);
  });

  it("does not call an unchanged retry or an earlier still-resolved outcome a reopening", async () => {
    await record();
    await record();
    let journal = await entries();
    expect(journal).toHaveLength(2);
    expect(journal[1].parent_entry_id).toBeNull();
    expect(await undo(journal[1])).toMatchObject({ status: "undone" });
    expect((await notices()).map((n) => n.copy_key)).toEqual(["case.resolved"]);
    await record("A different fictional settlement");
    journal = await entries();
    expect(await undo(journal.at(-1))).toMatchObject({ status: "undone" });
    expect(await rows("select status from public.member_cases where id=$1", [w.case])).toEqual([{ status: "resolved" }]);
    expect((await notices()).filter((n) => n.copy_key === "case.reopened")).toEqual([]);
    expect(await rows("select summary from public.member_case_outcomes where case_id=$1", [w.case])).toEqual([{ summary: "Fictional private settlement" }]);
  });

  it("corrects a re-resolution even when the earlier outcome already existed and was identical", async () => {
    await record();
    await rpc("select public.update_my_member_case($1,'active',null) as r", [w.case], w.member);
    await record();
    const journal = await entries();
    expect(await undo(journal.at(-1))).toMatchObject({ status: "undone" });
    await expectReopened();
    expect(await rows("select summary from public.member_case_outcomes where case_id=$1", [w.case])).toEqual([{ summary: "Fictional private settlement" }]);
  });

  it("corrects the original reopening across a chain of later outcome edits", async () => {
    await record();
    const [entry] = await entries();
    await record("A later fictional settlement");
    expect(await undo(entry)).toMatchObject({ status: "undone" });
    await expectReopened();
    expect((await entries()).length).toBe(2);
  });

  it("does not announce an intermediate reopening when undoing the first reopening commits resolved", async () => {
    await record();
    await rpc("select public.coordinator_update_case(p_case_id=>$1,p_status=>'active',p_reason=>'Fictional reopening') as r", [w.case]);
    const [firstReopening] = await rows("select id,version from private.learning_action_journal where target_id=$1 and action_kind='case_edit' order by created_at desc,id desc limit 1", [w.case]);
    await record("A later fictional settlement");
    const before = await notices();
    expect(await undo(firstReopening)).toMatchObject({ status: "undone", undoneCount: 3 });
    expect(await rows("select status from public.member_cases where id=$1", [w.case])).toEqual([{ status: "resolved" }]);
    expect((await notices()).filter((n) => n.copy_key === "case.reopened")).toHaveLength(0);
    expect(await notices()).toEqual(before);
    expect(await rows("select summary from public.member_case_outcomes where case_id=$1", [w.case])).toEqual([{ summary: "Fictional private settlement" }]);
    expect(await undo(firstReopening)).toMatchObject({ status: "already_undone" });
    expect(await notices()).toEqual(before);
  });

  it("sends only one correction for multiple intermediate resolutions in a chain ending active", async () => {
    await record();
    const [firstOutcome] = await entries();
    await rpc("select public.coordinator_update_case(p_case_id=>$1,p_status=>'active',p_reason=>'Fictional reopening') as r", [w.case]);
    await record("A later fictional settlement");
    expect(await undo(firstOutcome)).toMatchObject({ status: "undone", undoneCount: 5 });
    await expectReopened();
    expect(await rows("select case_id from public.member_case_outcomes where case_id=$1", [w.case])).toEqual([]);
    expect(await undo(firstOutcome)).toMatchObject({ status: "already_undone" });
    await expectReopened();
  });
});
