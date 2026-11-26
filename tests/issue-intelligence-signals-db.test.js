// @vitest-environment node
// REQ-UG-ISSUE-INTELLIGENCE-SIGNALS-20261001: the issue-signal read on an
// owned disposable database. Fixture rows are written by the table owner inside
// one rolled-back transaction; every product read runs as `authenticated` with
// a real JWT claim set and a live auth session.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("issue intelligence signals on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "otherOrg", "admin", "adminSession", "member", "memberSession", "otherAdmin", "otherSession"].map((key) => [key, randomUUID()]));
  const prefix = `issue-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-a`;
  const foreign = `${prefix}-b`;
  const people = [];

  async function as(user, session, sql, params = []) {
    await db.query("savepoint issue_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint issue_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint issue_call");
      await db.query("release savepoint issue_call");
      return { code: error.code, message: error.message };
    }
  }
  const read = (user, session, hat) => as(user, session, "select public.get_issue_intelligence_signals($1) data", [hat]);
  const asAdmin = (hat = "admin") => read(ids.admin, ids.adminSession, hat);
  const asMember = (hat = "member") => read(ids.member, ids.memberSession, hat);
  const setting = (key, value, org = ids.org) => db.query(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [org, key, JSON.stringify(value)],
  );

  async function person(org, chapterId) {
    const id = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapterId]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapterId]);
    return id;
  }
  async function signedIn(user, session, org, chapterId, roles = []) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user, chapterId]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapterId]);
    await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [session, user]);
    if (roles.length) {
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Issue proof','totp','verified',now(),now())", [randomUUID(), user]);
      for (const role of roles) await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, user, role]);
    }
  }
  async function question(author, text, org = ids.org, chapterId = chapter, daysAgo = 2) {
    await db.query(
      "insert into public.member_qa_questions(organization_id,chapter_id,author_user_id,title,body,created_at,updated_at) values ($1,$2,$3,$4,$5,now() - make_interval(days => $6),now())",
      [org, chapterId, author, text.slice(0, 120), `${text} Can someone explain this please?`, daysAgo],
    );
  }
  async function memberCase(owner, fields = {}) {
    await db.query(
      "insert into public.member_cases(user_id,reference,title,case_type,articles,organization_id,chapter_id,is_restricted,restriction_reason,restricted_at,restricted_by,created_at) values ($1,$2,'Private narrative stays private',$3,$4,$5,$6,$7,$8,$9,$10,now() - interval '3 days')",
      [owner, `${prefix}-${randomUUID().slice(0, 8)}`, fields.caseType ?? "Other", fields.articles ?? "", ids.org, chapter,
        fields.restricted ?? false, fields.restricted ? "Sensitive proof case" : null, fields.restricted ? new Date() : null, fields.restricted ? ids.admin : null],
    );
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "issue-intelligence-signals-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout='120s'");
    await db.query("set local lock_timeout='15s'");
    await db.query("insert into auth.users(id,email) values ($1,$2)", [randomUUID(), `${prefix}-creator@example.invalid`]);
    const creator = (await db.query("select id from auth.users where email=$1", [`${prefix}-creator@example.invalid`])).rows[0].id;
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$3,$3,$5),($2,$4,$4,$5)", [ids.org, ids.otherOrg, `${prefix}-org`, `${prefix}-other`, creator]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$3,false,9911),($2,$2,$2,$4,false,9912)", [chapter, foreign, ids.org, ids.otherOrg]);
    await signedIn(ids.admin, ids.adminSession, ids.org, chapter, ["admin"]);
    await signedIn(ids.member, ids.memberSession, ids.org, chapter);
    await signedIn(ids.otherAdmin, ids.otherSession, ids.otherOrg, foreign, ["admin"]);
    for (let i = 0; i < 16; i += 1) people.push(await person(ids.org, chapter));
    // Contract rights: sixteen different people ask about their rights and
    // eight open cases cite contract articles -> qa + cases active.
    for (const [index, id] of people.entries()) {
      await question(id, `What are my rights under the contract article ${index + 1}?`);
      if (index < 8) await memberCase(id, { articles: "Article 12" });
    }
  }, 120000);
  beforeEach(async () => { await db.query("savepoint issue_test"); });
  afterEach(async () => { await db.query("rollback to savepoint issue_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("is not executable by anon and refuses a hat the caller does not hold", async () => {
    const grants = await db.query("select has_function_privilege('anon','public.get_issue_intelligence_signals(text)','execute') anon, has_function_privilege('authenticated','public.get_issue_intelligence_signals(text)','execute') authed");
    expect(grants.rows[0]).toEqual({ anon: false, authed: true });
    expect((await asMember("admin")).code).toBe("42501");
    expect((await asMember("steward")).code).toBe("42501");
    expect((await asMember("owner")).code).toBe("22023");
  });

  it("gives members the family only and staff confidence, evidence and trend", async () => {
    const member = await asMember();
    expect(member, member.message).toMatchObject({ code: "", data: { enabled: true, viewer: "member" } });
    expect(member.data.signals).toEqual([{ family: "contract_rights_confusion", threadKey: "contract-rights-confusion" }]);
    const staff = await asAdmin();
    expect(staff, staff.message).toMatchObject({ code: "", data: { enabled: true, viewer: "staff" } });
    expect(staff.data.signals).toEqual([{
      family: "contract_rights_confusion", threadKey: "contract-rights-confusion",
      confidence: "emerging", evidenceFamilies: ["qa", "cases"], trend: "rising",
    }]);
    // No counts, people or source text leave the database.
    expect(JSON.stringify(staff.data)).not.toMatch(/contributors|evidence"|Private narrative|Can someone explain|@example/);
  });

  it("enforces the privacy floor server-side and never lets it drop below fifteen", async () => {
    await setting("limits.intelligence.issue_signal_min_segment", 17);
    expect((await asAdmin()).data.signals).toEqual([]);
    expect((await asMember()).data.signals).toEqual([]);
    await setting("limits.intelligence.issue_signal_min_segment", 16);
    expect((await asAdmin()).data.signals).toHaveLength(1);
    // A stored value below 15 (written around the admin RPC) never lowers the
    // floor: fourteen people stay hidden.
    await setting("limits.intelligence.issue_signal_min_segment", 10);
    await db.query("delete from public.member_qa_questions where author_user_id = any($1)", [people.slice(0, 2)]);
    await db.query("delete from public.member_cases where user_id = any($1)", [people.slice(0, 2)]);
    expect((await asAdmin()).data.signals).toEqual([]);
    const refused = await as(ids.admin, ids.adminSession, "select public.update_organization_setting('limits.intelligence.issue_signal_min_segment', '14'::jsonb) data");
    expect(refused.code).toBe("22023");
  });

  it("hides a pattern carried by fewer than fifteen different people", async () => {
    // Remove two authors' questions: 14 distinct people remain.
    await db.query("delete from public.member_qa_questions where author_user_id = any($1)", [people.slice(0, 2)]);
    await db.query("delete from public.member_cases where user_id = any($1)", [people.slice(0, 2)]);
    expect((await asAdmin()).data.signals).toEqual([]);
  });

  it("honors the master switch and the contract-rights family switch", async () => {
    await setting("features.intelligence.issue_signals", false);
    expect((await asMember()).data).toEqual({ enabled: false, viewer: "member", signals: [] });
    expect((await asAdmin()).data).toMatchObject({ enabled: false, viewer: "staff" });
    await setting("features.intelligence.issue_signals", true);
    await setting("features.intelligence.issue_signals_contract_rights_family", false);
    expect((await asAdmin()).data).toMatchObject({ enabled: true, signals: [] });
  });

  it("ignores restricted cases, redacted messages and other organizations", async () => {
    await db.query("delete from public.member_cases where organization_id = $1", [ids.org]);
    for (const id of people.slice(0, 4)) await memberCase(id, { articles: "Article 9", restricted: true });
    expect((await asAdmin()).data.signals).toEqual([]);
    // Three member messages from two people about overtime: the messages
    // family; redacting them takes it away again.
    const conversations = [];
    for (const id of people.slice(0, 2)) {
      const conversation = (await db.query("insert into public.member_conversations(user_id,title,organization_id) values ($1,'Overtime rules',$2) returning id", [id, ids.org])).rows[0].id;
      conversations.push(conversation);
      await db.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,'member','Member','Is mandatory overtime allowed?'),($1,$2,'member','Member','Who decides the schedule?')", [conversation, id]);
    }
    const withMessages = await asAdmin();
    expect(withMessages.data.signals[0]).toMatchObject({ evidenceFamilies: ["qa", "messages"] });
    // A later move of the member's selected chapter does not reattribute an
    // existing conversation to the new organization.
    for (const id of people.slice(0, 2)) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ids.otherOrg, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, foreign]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, foreign]);
    }
    expect((await asAdmin()).data.signals[0]).toMatchObject({ evidenceFamilies: ["qa", "messages"] });
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query("update public.member_conversations set organization_id = null where id = any($1::uuid[])", [conversations]);
    expect((await asAdmin()).data.signals.every((signal) => !signal.evidenceFamilies.includes("messages"))).toBe(true);
    await db.query("select set_config('request.jwt.claims', '', true)");
    await db.query("update public.member_conversations set organization_id = $2 where id = any($1::uuid[])", [conversations, ids.org]);
    // Redaction goes through the only allowed path, then the rows carry no
    // text and must not count.
    const messages = (await db.query("select id from public.member_messages where conversation_id = any($1)", [conversations])).rows;
    for (const { id } of messages) await db.query("select private.redact_member_message_row($1, 'retention_expired', null)", [id]);
    expect((await db.query("select count(*)::int n from public.member_messages where conversation_id = any($1) and redacted_at is null", [conversations])).rows[0].n).toBe(0);
    expect((await asAdmin()).data.signals).toEqual([]);
    // The other organization sees nothing of this tenant's pattern.
    const other = await read(ids.otherAdmin, ids.otherSession, "admin");
    expect(other, other.message).toMatchObject({ code: "", data: { enabled: true, signals: [] } });
  });

  it("keeps the retaliation family off by default and puts it first when switched on", async () => {
    for (const id of people) {
      await db.query("insert into public.member_emergency_checklists(organization_id,member_user_id,scenario,status) values ($1,$2,'disciplinary_meeting','draft')", [ids.org, id]);
      await question(id, `I was targeted after filing a grievance, is this retaliation ${id.slice(0, 4)}?`);
    }
    const off = await asAdmin();
    expect(off.data.signals.map((signal) => signal.family)).toEqual(["contract_rights_confusion"]);
    await setting("features.intelligence.issue_signals_retaliation_family", true);
    const on = await asAdmin();
    expect(on.data.signals.map((signal) => signal.family)).toEqual(["retaliation_protected_activity_pressure", "contract_rights_confusion"]);
    expect(on.data.signals[0]).toMatchObject({ evidenceFamilies: ["kyr", "qa"], confidence: "emerging" });
    const member = await asMember();
    expect(member.data.signals[0]).toEqual({ family: "retaliation_protected_activity_pressure", threadKey: "retaliation-protected-activity-pressure" });
  });

  it("needs a direct retaliation signal, not only keyword matches", async () => {
    await setting("features.intelligence.issue_signals_retaliation_family", true);
    for (const id of people) await question(id, `Is this harassment and intimidation at work ${id.slice(0, 4)}?`);
    const result = await asAdmin();
    expect(result.data.signals.map((signal) => signal.family)).toEqual(["contract_rights_confusion"]);
  });
});
