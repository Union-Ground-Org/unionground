// @vitest-environment node
//
// BUG-UG-STAFF-MESSAGES-TO-CHAPTER-STEWARD-UNDELIVERED-20261003
//
// A "Chapter steward" conversation has no bound steward and is readable only
// by a steward of the member's chapter or an organization-wide steward. When
// nobody could read it, 20261006030000 refuses the message up front instead of
// storing it as sent (owner ruling, October 5, 2026, 4:52 PM ET: option 1, refuse). Who
// may read steward-addressed messages is unchanged. Fictional tenants; every
// refusal has an allowed control; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261006030000_chapter_steward_message_requires_reader";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("chapter steward message reader (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("refuses an unreadable steward message in the one member message writer, lock first", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const writer = stripComments(fnBody(sql, "public.send_member_message(p_conversation_id uuid, p_body text)"));
    expect(writer).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/);
    expect(writer).toContain("select c.id, c.user_id, c.steward_user_id into conv");
    expect(writer).toContain("if conv.steward_user_id is null and not private.chapter_steward_reader_exists(caller) then\n    raise exception 'no steward assigned' using errcode = '22023', detail = 'no_steward_assigned';");
    // The refusal sits before anything is written.
    expect(writer.indexOf("no steward assigned")).toBeLessThan(writer.indexOf("insert into public.member_messages"));
    // Readership is not widened: the select policy is untouched.
    expect(sql).not.toMatch(/\b(create|alter|drop)\s+policy\b/i);
  });

  it("pins the reader check and the refusal in the database contract", () => {
    const writer = contract.functions.find((row) => row.sig === "public.send_member_message(p_conversation_id uuid, p_body text)");
    expect(writer.bodyContains).toEqual(expect.arrayContaining(["private.chapter_steward_reader_exists(caller)", "'no steward assigned'"]));
    expect(contract.functions.find((row) => row.sig === "private.chapter_steward_reader_exists(p_member uuid)")).toMatchObject({ secdef: true, exec: "" });
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter steward message reader on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "chapter-steward-message-reader-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const local = `hbl-local-${orgA}`;
    const hhs = `hbl-hhs-${orgA}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [orgA, `hbl-${orgA}`, `Harrow Bay Local ${orgA}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Harrow Bay Local',$1,'proof',$3,9981), ($2,'HHS Chapter',$2,'proof',$3,9982)`,
      [local, hhs, orgA]);
    return { orgA, local, hhs };
  }

  async function person(t, chapter, { chapterRole = null, organizationRole = null, memberOf = [chapter], secondFactor = true } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.orgA, id]);
    for (const membership of memberOf) {
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, membership]);
    }
    if (secondFactor) {
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    if (chapterRole) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, chapterRole, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, chapterRole, chapter]);
    }
    if (organizationRole) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)", [t.orgA, id, organizationRole]);
    }
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
    await client.query("set local role authenticated");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "", detail: error.detail || "" };
    }
  }

  const start = (body) => capture("select public.start_member_conversation($1) as v", [body]);
  const stored = async (member) => (await client.query(
    `select (select pg_catalog.count(*) from public.member_conversations where user_id=$1)::int as conversations,
            (select pg_catalog.count(*) from public.member_messages where user_id=$1)::int as messages`, [member])).rows[0];

  it("refuses a chapter steward message nobody could read and stores nothing, even with officers in the chapter", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await person(t, t.local, { chapterRole: "admin", organizationRole: "admin" });
      await person(t, t.local, { chapterRole: "vp" });
      await person(t, t.hhs, { chapterRole: "steward" }); // another chapter's steward
      const member = await person(t, t.local);

      await actAs(member);
      const first = await start("Fall goals for the chapter");
      await asOwner();
      expect(first).toMatchObject({ ok: false, code: "22023", message: "no steward assigned", detail: "no_steward_assigned" });
      expect(await stored(member)).toEqual({ conversations: 0, messages: 0 });

      // A follow-up into an existing "Chapter steward" conversation is refused too.
      const conversation = (await client.query(
        "insert into public.member_conversations(user_id,title,initials) values ($1,'Chapter steward','CS') returning id", [member])).rows[0].id;
      await actAs(member);
      const followUp = await capture("select public.send_member_message($1,$2) as v", [conversation, "Following up"]);
      await asOwner();
      expect(followUp).toMatchObject({ ok: false, code: "22023", message: "no steward assigned" });
      expect((await stored(member)).messages).toBe(0);

      // The chapter's only steward writing to "Chapter steward" would reach only themselves.
      const onlySteward = await person(t, t.local, { chapterRole: "steward" });
      await actAs(onlySteward);
      const self = await start("Is anyone there?");
      await asOwner();
      expect(self).toMatchObject({ ok: false, message: "no steward assigned" });
    } finally {
      await client.query("rollback");
    }
  });

  it("delivers when the chapter has a steward or the organization has one, and that steward can read it", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, t.local, { chapterRole: "steward" });
      const member = await person(t, t.local);

      await actAs(member);
      const sent = await start("Fall goals for the chapter");
      await asOwner();
      expect(sent.ok, sent.message).toBe(true);
      expect(await stored(member)).toEqual({ conversations: 1, messages: 1 });

      await actAs(steward);
      const visible = await capture("select pg_catalog.count(*)::int as v from public.member_conversations where user_id=$1", [member]);
      await asOwner();
      expect(visible.value).toBe(1);

      // An organization-wide steward with no membership in the member's chapter also reads it.
      const t2 = await tenants();
      await person(t2, t2.hhs, { organizationRole: "steward", memberOf: [t2.hhs] });
      const member2 = await person(t2, t2.local);
      await actAs(member2);
      const viaOrganization = await start("Hello");
      await asOwner();
      expect(viaOrganization.ok, viaOrganization.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  // Review round 1: a steward counts only if the read policy would show them
  // the conversation, so the check and member_conversations_select_steward
  // agree for each of these stewards.
  it("refuses when the only steward could not open the conversation", async () => {
    await client.query("begin");
    try {
      const cases = [
        // Organization-wide steward with no active membership in their own profile chapter.
        (t) => person(t, t.hhs, { organizationRole: "steward", memberOf: [] }),
        // The chapter's steward without the second factor staff need.
        (t) => person(t, t.local, { chapterRole: "steward", secondFactor: false }),
      ];
      for (const makeSteward of cases) {
        const t = await tenants();
        const steward = await makeSteward(t);
        const member = await person(t, t.local);
        const existing = (await client.query(
          "insert into public.member_conversations(user_id,title,initials) values ($1,'Chapter steward','CS') returning id", [member])).rows[0].id;

        await actAs(steward);
        const seen = await capture("select pg_catalog.count(*)::int as v from public.member_conversations where id=$1", [existing]);
        await asOwner();
        expect(seen.ok, seen.message).toBe(true);
        expect(seen.value).toBe(0);

        await actAs(member);
        const refused = await capture("select public.send_member_message($1,$2) as v", [existing, "Fall goals for the chapter"]);
        await asOwner();
        expect(refused).toMatchObject({ ok: false, message: "no steward assigned", detail: "no_steward_assigned" });
        expect((await stored(member)).messages).toBe(0);
      }
    } finally {
      await client.query("rollback");
    }
  });

  // Review round 2: a reply and a scheduled message reach the same conversation
  // without send_member_message, and a steward under MFA recovery reads nothing.
  it("refuses a member reply or schedule, and fails a due scheduled message, when nobody could read it", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, t.local, { chapterRole: "steward" });
      const member = await person(t, t.local);
      await actAs(member);
      const opened = await start("Fall goals for the chapter");
      await asOwner();
      expect(opened.ok, opened.message).toBe(true);
      const conversation = (await client.query("select id from public.member_conversations where user_id=$1", [member])).rows[0].id;
      const first = (await client.query("select id from public.member_messages where conversation_id=$1", [conversation])).rows[0].id;
      await actAs(member);
      const due = await capture("select public.schedule_member_message($1,$2,now()+interval '1 day') as v", [conversation, "Scheduled while a steward could read"]);
      await asOwner();
      expect(due.ok, due.message).toBe(true);

      // Review round 3: a banned steward (an interrupted password reissue) cannot
      // sign in, so a message is refused until the ban ends.
      await client.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [steward]);
      await actAs(member);
      const whileBanned = await capture("select public.send_member_message($1,$2) as v", [conversation, "While banned"]);
      await asOwner();
      expect(whileBanned).toMatchObject({ ok: false, message: "no steward assigned" });
      await client.query("update auth.users set banned_until=null where id=$1", [steward]);

      // The chapter's only steward begins MFA recovery: nobody can read it now.
      await client.query("insert into private.member_mfa_recovery_locks(user_id,claim_token_hash) values ($1,repeat('a',64))", [steward]);

      await actAs(member);
      const reply = await capture("select public.reply_to_member_message('private',$1,$2) as v", [first, "Replying"]);
      const later = await capture("select public.schedule_member_message($1,$2,now()+interval '1 day') as v", [conversation, "Later"]);
      await asOwner();
      expect(reply).toMatchObject({ ok: false, message: "no steward assigned", detail: "no_steward_assigned" });
      expect(later).toMatchObject({ ok: false, message: "no steward assigned", detail: "no_steward_assigned" });

      await client.query("update public.member_scheduled_messages set scheduled_for=now()-interval '1 minute' where id=$1", [due.value.id]);
      await client.query("select private.dispatch_due_member_messaging(500)");
      expect((await client.query("select status,failure_reason,sent_message_id from public.member_scheduled_messages where id=$1", [due.value.id])).rows[0])
        .toEqual({ status: "failed", failure_reason: "authorization-revoked", sent_message_id: null });
      expect((await stored(member)).messages).toBe(1);
      // The inbox lists only pending schedules, so the member is told.
      expect((await client.query("select kind from public.member_notifications where user_id=$1 and title='Scheduled message not sent'", [member])).rows)
        .toEqual([{ kind: "messages" }]);
    } finally {
      await client.query("rollback");
    }
  });
});
