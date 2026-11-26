// @vitest-environment node
// #9277: whole refusals and stored import errors, on an owned disposable DB.
import assert from "node:assert/strict";
import { randomUUID as uuid } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("inaccessible request, chapter, coalition and import targets (#9277)", () => {
  let db;
  const orgs = [uuid(), uuid()];
  const chapters = ["refusal-pine", "refusal-elm", "refusal-cedar"];
  const users = Array.from({ length: 6 }, uuid);
  const [admin, member, foreignAdmin, foreignMember, chapterAdmin, siblingMember] = users;
  const sessions = {};
  const q = async (sql, args = []) => (await db.query(sql, args)).rows;
  const one = async (sql, args = []) => (await q(sql, args))[0];
  async function seed(table, data) {
    const columns = Object.keys(data);
    await q("set local session_replication_role=replica");
    try {
      return await one(`insert into ${table} (${columns.join(",")}) values (${columns.map((_, i) => `$${i + 1}`).join(",")}) returning *`, Object.values(data));
    } finally { await q("set local session_replication_role=origin"); }
  }
  async function act(user, sql, args, inspect) {
    await q("savepoint rpc");
    let result;
    try {
      await q("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: sessions[user] })]);
      await q("set local role authenticated");
      result = { ok: true, value: (await one(`select ${sql} as value`, args)).value };
      if (inspect) result.workspace = (await one("select public.get_member_import_workspace() as value")).value;
      await q("reset role");
      if (inspect) result.effect = await inspect();
    } catch (error) {
      result = { ok: false, code: error.code, message: error.message, detail: error.detail ?? null, hint: error.hint ?? null };
    } finally { await q("rollback to savepoint rpc"); }
    return result;
  }
  function success(result) { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
  async function snapshot() {
    const tables = ["chapters", "member_requests", "member_invitations", "member_admin_audit", "member_cases",
      "organization_coalition_decisions", "organization_coalition_decision_votes", "organization_coordination_records", "organization_coordination_events"];
    const result = {};
    for (const table of tables) result[table] = (await one(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as rows from public.${table} t`)).rows;
    return result;
  }
  async function pair(user, sql, args, table, column, id, code, message) {
    const before = await snapshot();
    const present = await act(user, sql, args);
    assert.deepEqual(await snapshot(), before, "inaccessible target changed rows");
    await q("savepoint missing_target");
    await q("set local session_replication_role=replica");
    await q(`delete from ${table} where ${column}=$1`, [id]);
    await q("set local session_replication_role=origin");
    const absentBefore = await snapshot();
    const missing = await act(user, sql, args);
    assert.deepEqual(await snapshot(), absentBefore, "missing target changed rows");
    await q("rollback to savepoint missing_target");
    assert.deepEqual(missing, { ok: false, code, message, detail: null, hint: null });
    assert.deepEqual(present, missing, "foreign-present and missing refusals differ");
  }
  async function scenario(run) {
    await q("savepoint scenario");
    try { await run(); } finally { await q("rollback to savepoint scenario"); }
  }
  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false });
    await db.connect();
    await q("begin");
    await q("set local statement_timeout='30s'");
    for (const [i, org] of orgs.entries()) await q("insert into public.organizations(id,slug,name) values($1,$2,$3)", [org, `refusal-fictional-${i}`, `Fictional refusal organization ${i}`]);
    for (const [i, chapter] of chapters.entries()) await q("insert into public.chapters(id,slug,name,region,organization_id,order_index) values($1,$1,$2,'proof',$3,$4)", [chapter, `Fictional refusal chapter ${i}`, orgs[i === 2 ? 1 : 0], 9980 + i]);
    for (const [i, user] of users.entries()) {
      const chapter = i === 2 || i === 3 ? chapters[2] : i === 5 ? chapters[1] : chapters[0];
      const org = orgs[i === 2 || i === 3 ? 1 : 0];
      await q("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())", [user, `refusal-${i}@example.invalid`]);
      await q("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [user, chapter, `Fictional refusal person ${i}`]);
      await q("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active') on conflict do nothing", [org, user]);
      await q("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) values($1,$2,'active',true,now()) on conflict do nothing", [user, chapter]);
      sessions[user] = uuid();
      await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [sessions[user], user]);
      await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [uuid(), user]);
      if ([admin, foreignAdmin, chapterAdmin].includes(user)) {
        await q("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2)", [user, chapter]);
        await q("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2)", [user, chapter]);
      }
      if ([admin, foreignAdmin].includes(user)) for (const role of ["admin", "coordinator", "vp", "steward", "advisor"]) await q("insert into public.organization_role_grants(user_id,organization_id,role) values($1,$2,$3)", [user, org, role]);
    }
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned) values($1,$2,'active',false)", [admin, chapters[1]]);
  }, 60_000);
  afterAll(async () => { await db?.query("rollback"); await db?.end(); });

  for (const arity of [2, 3]) it(`decide_member_request/${arity}: own and organization-wide access, sibling/foreign/missing equality`, () => scenario(async () => {
    const request = (chapter, org, user) => seed("public.member_requests", { organization_id: org, chapter_id: chapter, requester_user_id: user, kind: "access_request", requested_role: "advisor" });
    const own = await request(chapters[0], orgs[0], member);
    const sql = `public.decide_member_request($1,'declined'${arity === 3 ? ",null::uuid" : ""})`;
    assert.equal(success(await act(chapterAdmin, sql, [own.id])).status, "declined");
    for (const [chapter, org, user] of [[chapters[1], orgs[0], siblingMember], [chapters[2], orgs[1], foreignMember]]) {
      const target = await request(chapter, org, user);
      if (org === orgs[0]) assert.equal(success(await act(admin, sql, [target.id])).status, "declined");
      await pair(chapterAdmin, sql, [target.id], "public.member_requests", "id", target.id, "P0002", "request not found");
    }
  }));

  it("approve_member_request_invitation: own and organization-wide invitation, sibling/foreign/missing equality", () => scenario(async () => {
    const email = "fictional-refusal-invite@example.invalid";
    const request = (chapter, org, user) => seed("public.member_requests", { organization_id: org, chapter_id: chapter, requester_user_id: user, kind: "invitation_suggestion", invitee_name: "Fictional Invitee", invitee_email: email });
    const own = await request(chapters[0], orgs[0], member);
    const sql = "public.approve_member_request_invitation($1,$2,'en',$3)";
    const args = [own.id, email, "cd".repeat(32)];
    assert.equal(success(await act(chapterAdmin, sql, args)).send, true);
    for (const [chapter, org, user] of [[chapters[1], orgs[0], siblingMember], [chapters[2], orgs[1], foreignMember]]) {
      const target = await request(chapter, org, user);
      if (org === orgs[0]) assert.equal(success(await act(admin, sql, [target.id, ...args.slice(1)])).send, true);
      await pair(chapterAdmin, sql, [target.id, ...args.slice(1)], "public.member_requests", "id", target.id, "22023", "request not found");
    }
  }));

  it("update_admin_chapter: own and organization-wide administration, sibling/foreign/missing equality", () => scenario(async () => {
    const sql = "public.update_admin_chapter($1,'Fictional renamed chapter','proof',$2)";
    assert.equal(success(await act(chapterAdmin, sql, [chapters[0], 9980])).updated, true);
    assert.equal(success(await act(admin, sql, [chapters[1], 9981])).updated, true);
    const structure = await act(chapterAdmin, "public.update_admin_chapter($1,'Fictional renamed chapter','changed',9980)", [chapters[0]]);
    assert.equal(structure.code, "42501");
    assert.equal(structure.message, "organization admin required for chapter structure");
    for (const chapter of chapters.slice(1)) await pair(chapterAdmin, sql, [chapter, 9980], "public.chapters", "id", chapter, "22023", "chapter unavailable");
    await q("delete from public.member_role_chapters where user_id=$1 and role='admin'", [chapterAdmin]);
    await q("delete from public.member_roles where user_id=$1 and role='admin'", [chapterAdmin]);
    const revokedBefore = await snapshot();
    assert.deepEqual(await act(chapterAdmin, sql, [chapters[0], 9980]), {
      ok: false, code: "22023", message: "chapter unavailable", detail: null, hint: null,
    });
    assert.deepEqual(await snapshot(), revokedBefore, "revoked administrator changed rows");
  }));

  it("vote_organization_coalition_decision: own and authorized participant votes, inaccessible/missing equality", () => scenario(async () => {
    const decision = async (org, user) => {
      const campaign = await seed("public.organization_coordination_records", { organization_id: org, created_by: user, kind: "coalition_campaign", title: "Fictional coalition", status: "active", idempotency_key: uuid() });
      const work = await seed("public.organization_coordination_records", { organization_id: org, created_by: user, kind: "coalition_work_item", parent_id: campaign.id, title: "Fictional work", status: "active", idempotency_key: uuid() });
      await seed("public.organization_coordination_organization_participants", { record_id: campaign.id, organization_id: org, role: "owner", status: "active" });
      return seed("public.organization_coalition_decisions", { campaign_id: campaign.id, subject_record_id: work.id, proposing_organization_id: org, title: "Fictional decision", action: "authorize_work", required_approvals: 1, proposed_by: user, idempotency_key: uuid() });
    };
    const own = await decision(orgs[0], admin);
    const foreign = await decision(orgs[1], foreignAdmin);
    const sql = "public.vote_organization_coalition_decision($1,'abstain','',$2)";
    assert.equal(success(await act(admin, sql, [own.id, uuid()])).decisionId, own.id);
    const key = uuid();
    await pair(admin, sql, [foreign.id, key], "public.organization_coalition_decisions", "id", foreign.id, "22023", "open coalition decision unavailable");
    await seed("public.organization_coordination_organization_participants", { record_id: foreign.campaign_id, organization_id: orgs[0], role: "partner", status: "active" });
    assert.equal(success(await act(admin, sql, [foreign.id, key])).decisionId, foreign.id);
    await q("update public.organization_coordination_organization_participants set status='revoked' where record_id=$1 and organization_id=$2", [foreign.campaign_id, orgs[0]]);
    await pair(admin, sql, [foreign.id, key], "public.organization_coalition_decisions", "id", foreign.id, "22023", "open coalition decision unavailable");
  }));

  it("validate_member_operations_import: own validation, foreign/missing member errors and workspace equality", () => scenario(async () => {
    const batch = await seed("public.organization_import_batches", { organization_id: orgs[0], kind: "grievance", filename: "fictional.csv", row_count: 1, created_by: admin });
    await seed("public.organization_import_rows", { organization_id: orgs[0], batch_id: batch.id, row_number: 1, normalized_data: JSON.stringify({ member_id: member, chapter_id: chapters[0], title: "Fictional case", reference: "REFUSAL-FOREIGN" }) });
    const sql = "public.validate_member_operations_import($1,$2)";
    const args = [batch.id, uuid()];
    const inspect = () => one("select normalized_data,validation_errors from public.organization_import_rows where batch_id=$1", [batch.id]);
    const validate = async () => {
      const before = await snapshot();
      return act(admin, sql, args, async () => {
        assert.deepEqual(await snapshot(), before, "import changed foreign records before rollback");
        return inspect();
      });
    };
    assert.equal(success(await validate()).validCount, 1);
    await seed("public.member_cases", { user_id: foreignMember, organization_id: orgs[1], chapter_id: chapters[2], reference: "REFUSAL-FOREIGN", title: "Fictional foreign case", case_type: "other" });
    for (const chapter of [chapters[2], chapters[0]]) {
      await q("update public.organization_import_rows set normalized_data=$2::jsonb where batch_id=$1", [batch.id, JSON.stringify({ member_id: foreignMember, chapter_id: chapter, title: "Fictional case", reference: "REFUSAL-FOREIGN" })]);
      const present = await validate();
      success(present);
      await q("savepoint missing_member");
      await q("set local session_replication_role=replica");
      await q("delete from public.member_cases where user_id=$1", [foreignMember]);
      await q("delete from public.member_profiles where id=$1", [foreignMember]);
      await q("delete from public.organization_memberships where user_id=$1", [foreignMember]);
      await q("delete from auth.users where id=$1", [foreignMember]);
      await q("set local session_replication_role=origin");
      const missing = await validate();
      await q("rollback to savepoint missing_member");
      success(missing);
      assert.deepEqual(present, missing, "foreign member changed validation, resolution or workspace");
      assert.equal(present.effect.normalized_data._resolved_member_id, null);
      assert.equal(present.effect.validation_errors.some((error) => error.code === "duplicate"), false);
      assert.equal(present.effect.validation_errors.some((error) => error.code === "member_not_found"), true);
    }
  }));
});
