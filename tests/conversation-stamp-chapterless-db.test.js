// @vitest-environment node
//
// BUG-UG-CONVERSATION-STAMP-CHAPTERLESS-SOLE-MEMBERSHIP-20261013. A
// new conversation whose creator has no selected chapter is stamped with the
// creator's sole active organization membership, the way
// private.mi1_w2_selected_organization() resolves it, so it can take over Home
// and resolve in the Compass source scope. Two or more memberships, no
// membership and existing null rows stay null and refused; chaptered creators
// and updates are unchanged.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readMigrationFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "20261014223000_conversation_stamp_chapterless_sole_membership.sql";
const migration = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8");
const md5 = (value) => createHash("md5").update(value).digest("hex");

describe("chapterless conversation stamp migration (static)", () => {
  const latest = new Map(readMigrationFunctions("supabase/migrations").map((fn) => [fn.name, fn]));
  const body = migration.split("as $function$")[1].split("$function$")[0];

  it("is the current definition of the stamp trigger function and the contract pins its body", () => {
    expect(latest.get("private.stamp_member_conversation_organization")?.file).toBe(MIGRATION);
    const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
    expect(contract.functions.find((row) => row.sig === "private.stamp_member_conversation_organization()"))
      .toMatchObject({ secdef: true, exec: "", sourceMd5: md5(body) });
  });

  it("falls back to the sole membership only for a chapterless creator on insert and keeps updates", () => {
    const insert = body.split("if tg_op = 'INSERT' then")[1].split("else\n    new.organization_id := old.organization_id;")[0];
    expect(body.indexOf("if (select auth.uid()) is null then\n    return new;")).toBeGreaterThan(-1);
    expect(insert.indexOf("new.organization_id := private.current_member_organization();"))
      .toBeLessThan(insert.indexOf("new.organization_id is null and not exists ("));
    expect(insert).toContain("and profile.chapter_id is not null");
    expect(insert).toContain("when pg_catalog.count(distinct membership.organization_id) = 1");
    expect(insert).toContain("and organization.status = 'active'");
    expect(insert).toContain("and membership.status = 'active';");
    expect(body).toContain("else\n    new.organization_id := old.organization_id;");
    const code = stripComments(migration);
    expect(code).toMatch(/create or replace function private\.stamp_member_conversation_organization\(\)\nreturns trigger\nlanguage plpgsql\nsecurity definer\nset search_path = ''/);
    expect(code).toContain("revoke all on function private.stamp_member_conversation_organization() from public, anon, authenticated, service_role;");
    expect(code).toContain("('trigger', 'public', 'member_conversations', 'b10_member_conversations_organization')");
    expect(code).toContain("private.account_lifecycle_referential_action_trigger_issues()");
    // No backfill, no trigger change, no table change.
    expect(code).not.toMatch(/create trigger|drop trigger|alter table|update public\.member_conversations/i);
  });

  it("re-emits the Home reader from its newest definition with only the organization resolver changed", () => {
    // 20261104111500 (learning period, slice 6) re-emits it again with one
    // more predicate: a message whose own-message removal is held is skipped.
    const newest = latest.get("public.get_member_home_takeover");
    expect([MIGRATION, "20261104111500_learning_period_messages_notices_invites_exports.sql"]).toContain(newest?.file);
    const extract = (sql) => sql.slice(sql.lastIndexOf("create or replace function public.get_member_home_takeover()"))
      .split("\n$function$;")[0];
    const previous = extract(readFileSync(new URL("../supabase/migrations/20261003040000_member_pin_signin.sql", import.meta.url), "utf8"));
    expect(extract(migration)).toBe(previous.replace(
      "org := private.current_member_organization();",
      "org := private.current_mobile_staff_organization();",
    ));
    const code = stripComments(migration);
    expect(code).toContain("revoke all on function public.get_member_home_takeover() from public, anon, authenticated, service_role;\ngrant execute on function public.get_member_home_takeover() to authenticated;");
    expect((code.match(/grant execute/g) ?? []).length).toBe(1);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapterless conversation stamp on a disposable database", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "conversation-stamp-chapterless-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  const claims = (user) => JSON.stringify({ role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" });
  async function as(user, sql, values = []) {
    await c.query("savepoint stamp_call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [claims(user)]);
      await c.query("set local role authenticated");
      const rows = (await c.query(sql, values)).rows;
      await c.query("reset role");
      await c.query("select set_config('request.jwt.claims', '', true)");
      await c.query("release savepoint stamp_call");
      return rows;
    } catch (error) {
      await c.query("rollback to savepoint stamp_call");
      await c.query("release savepoint stamp_call");
      throw error;
    }
  }
  // The creation write itself, with the creator signed in (the trigger reads
  // auth.uid() from the request claims), whatever organization the row carried.
  async function create(user, claimed = null) {
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims(user)]);
    const id = (await c.query(
      "insert into public.member_conversations(user_id,title,initials,organization_id) values ($1,'Chapter steward','CS',$2) returning id",
      [user.id, claimed],
    )).rows[0].id;
    await c.query("select set_config('request.jwt.claims', '', true)");
    return id;
  }
  const stamp = async (id) => (await c.query("select organization_id from public.member_conversations where id=$1", [id])).rows[0].organization_id;
  const inScope = async (id, org) => (await c.query("select private.compass_source_in_organization('private',$1,$2) as v", [id, org])).rows[0].v;
  const briefing = (user, id) => as(user, "select public.get_compass_ai_context('briefing', $1) as v", [JSON.stringify({ p_source_kind: "private", p_target_id: id })]);

  async function person(label, { chapter = null, orgs = [] } = {}) {
    const user = { id: randomUUID(), session: randomUUID(), label };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    for (const org of orgs) {
      await c.query("insert into public.organization_memberships(organization_id,user_id,status,created_at) values ($1,$2,'active',now() - interval '1 hour')", [w[org].org, user.id]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, w[org].chapter]);
    }
    await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, chapter ? w[chapter].chapter : null]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    w = {};
    for (const label of ["a", "b"]) {
      const org = randomUUID();
      const chapter = `stamp-chapterless-${label}-${org.slice(0, 8)}`;
      w[label] = { org, chapter };
      await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org, chapter]);
      await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98275)", [chapter, org]);
      await c.query(
        `insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,'features.ai_assistant.enabled','true'::jsonb)
         on conflict (organization_id, setting_key) do update set value = excluded.value`, [org]);
    }
    w.sole = await person("sole", { orgs: ["a"] });
    w.two = await person("two", { orgs: ["a", "b"] });
    w.chaptered = await person("chaptered", { chapter: "b", orgs: ["a", "b"] });
    w.none = await person("none");
    // A pre-fix conversation of the sole member that recorded no organization.
    w.historical = randomUUID();
    await c.query("insert into public.member_conversations(id,user_id,title,initials) values ($1,$2,'Chapter steward','CS')", [w.historical, w.sole.id]);
    await c.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'member','Proof','Historical detail')", [randomUUID(), w.historical, w.sole.id]);
  });
  afterEach(async () => { await c.query("rollback"); });

  it("stamps a chapterless creator's new conversation with their sole organization, and Compass resolves it there", async () => {
    expect((await c.query("select chapter_id from public.member_profiles where id=$1", [w.sole.id])).rows[0].chapter_id).toBeNull();
    const id = await create(w.sole, w.b.org);
    expect(await stamp(id)).toBe(w.a.org);
    expect(await inScope(id, w.a.org)).toBe(true);
    expect(await inScope(id, w.b.org)).toBe(false);
    await c.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'member','Proof','Sole membership detail')", [randomUUID(), id, w.sole.id]);
    const [{ v: context }] = await briefing(w.sole, id);
    expect(context.organization_id).toBe(w.a.org);
    expect(context.data.messages.map((message) => message.body)).toEqual(["Sole membership detail"]);
  });

  it("shows a chapterless sole member's unread steward message on Home, and still refuses two memberships", async () => {
    const home = async (user) => (await as(user, "select public.get_member_home_takeover() as v"))[0].v;
    const id = await create(w.sole);
    await c.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'steward','Dana Whitfield','Please call me about Step 2.')", [randomUUID(), id, w.sole.id]);
    await c.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'steward','Dana Whitfield','Organization unknown')", [randomUUID(), w.historical, w.sole.id]);
    const result = await home(w.sole);
    expect(result.enabled).toBe(true);
    expect(result.message).toMatchObject({ conversationId: id, body: "Please call me about Step 2." });
    await expect(home(w.two)).rejects.toMatchObject({ code: "42501" });
    await expect(home(w.none)).rejects.toMatchObject({ code: "42501" });
    // A chaptered member of A and B with B selected stays in B.
    const own = await create(w.chaptered);
    await c.query("insert into public.member_messages(id,conversation_id,user_id,sender_kind,sender_name,body) values ($1,$2,$3,'steward','Dana Whitfield','Sent in B')", [randomUUID(), own, w.chaptered.id]);
    expect((await home(w.chaptered)).message).toMatchObject({ conversationId: own, body: "Sent in B" });
  });

  it("ignores an inactive organization or a revoked membership when finding the sole organization", async () => {
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.b.org, w.sole.id]);
    await c.query("update public.organizations set status='suspended' where id=$1", [w.b.org]);
    expect(await stamp(await create(w.sole))).toBe(w.a.org);
    await c.query("update public.organizations set status='active' where id=$1", [w.b.org]);
    await c.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [w.b.org, w.sole.id]);
    expect(await stamp(await create(w.sole))).toBe(w.a.org);
  });

  it("leaves a chapterless creator with two memberships, or none, unstamped and refused", async () => {
    for (const [user, claimed] of [[w.two, w.a.org], [w.none, w.b.org]]) {
      const id = await create(user, claimed);
      expect(await stamp(id), user.label).toBeNull();
      expect(await inScope(id, w.a.org), user.label).toBe(false);
      expect(await inScope(id, w.b.org), user.label).toBe(false);
    }
  });

  it("stamps a chaptered creator with the selected chapter's organization, as before", async () => {
    const id = await create(w.chaptered, w.a.org);
    expect(await stamp(id)).toBe(w.b.org);
    // A selected chapter that no longer resolves stays null rather than
    // falling back, as mi1_w2_selected_organization() refuses it.
    await c.query("update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1 and chapter_id=$2", [w.chaptered.id, w.b.chapter]);
    expect(await stamp(await create(w.chaptered, w.a.org))).toBeNull();
  });

  it("keeps an existing null row null on update, and Compass still refuses it", async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims(w.sole)]);
    await c.query("update public.member_conversations set organization_id=$2, title='Renamed' where id=$1", [w.historical, w.a.org]);
    await c.query("select set_config('request.jwt.claims', '', true)");
    expect(await stamp(w.historical)).toBeNull();
    expect(await inScope(w.historical, w.a.org)).toBe(false);
    await expect(briefing(w.sole, w.historical)).rejects.toMatchObject({ code: "P0002" });
  });

  it("keeps the original stamp when a signed-in caller updates it, even after memberships change", async () => {
    const id = await create(w.sole);
    expect(await stamp(id)).toBe(w.a.org);
    await c.query("update public.organization_memberships set status='revoked', revoked_at=now() where user_id=$1", [w.sole.id]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.b.org, w.sole.id]);
    await c.query("select set_config('request.jwt.claims', $1, true)", [claims(w.sole)]);
    await c.query("update public.member_conversations set organization_id=$2 where id=$1", [id, w.b.org]);
    await c.query("update public.member_conversations set organization_id=null where id=$1", [id]);
    await c.query("select set_config('request.jwt.claims', '', true)");
    expect(await stamp(id)).toBe(w.a.org);
  });

  it("stays a non-executable SECURITY DEFINER trigger function with an empty search_path and a reviewed lifecycle surface", async () => {
    const fn = (await c.query(`select p.prosecdef, p.proconfig,
        pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authed,
        pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_catalog.pg_proc p where p.oid = 'private.stamp_member_conversation_organization()'::regprocedure`)).rows[0];
    expect(fn).toEqual({ prosecdef: true, proconfig: ['search_path=""'], anon: false, authed: false, service: false });
    const trigger = (await c.query(`select t.tgname, t.tgenabled from pg_catalog.pg_trigger t
      where t.tgrelid = 'public.member_conversations'::regclass and t.tgfoid = 'private.stamp_member_conversation_organization()'::regprocedure`)).rows;
    expect(trigger).toEqual([{ tgname: "b10_member_conversations_organization", tgenabled: "O" }]);
    expect((await c.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
  }, 120000);
});
