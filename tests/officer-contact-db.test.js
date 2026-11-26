// @vitest-environment node
//
// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030 (#6564)
//
// 20261030203100 lets a member open a private two-person conversation with a
// listed officer or administrator of their own chapter (no contact code, no
// reward), reports who they may message on the leadership list, and lets a
// listed officer share an email or phone with members. Two fictional tenants;
// every refusal has an allowed control; every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261030203100_member_officer_contact";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("officer contact (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));
  const start = stripComments(fnBody(sql, "public.start_officer_conversation(p_officer_user_id uuid, p_body text)"));
  const leadership = stripComments(fnBody(sql, "public.get_chapter_leadership()"));

  it("is one transaction guarded against an unreviewed predecessor", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("'public.get_chapter_leadership()'::regprocedure");
    expect(sql).toContain("'public.set_my_steward_contact_visibility(boolean,boolean,text,text)'::regprocedure");
    // The steward conversation's readers are not touched.
    expect(sql).not.toMatch(/member_conversations|member_messages\b|create policy|drop policy/i);
  });

  it("opens a conversation only with a contactable officer, through the one peer message writer", () => {
    expect(start).toContain("security definer");
    expect(start).toContain("set search_path = ''");
    expect(start).toContain("private.lock_case_graph(array[auth.uid(), p_officer_user_id], array[]::uuid[])");
    expect(start).toMatch(/private\.lock_case_graph\(array\[auth\.uid\(\), p_officer_user_id\], array\[\]::uuid\[\]\);\s+perform private\.member_pin_require_full_session\(\);/);
    expect(start).toContain("from private.member_contactable_officer_ids() as reachable(id)");
    expect(start).toContain("public.send_reward_peer_message(conversation_id_value, clean_body)");
    // Never a code or a reward check: the officer route needs neither.
    expect(start).not.toMatch(/member_reward_effect_enabled|code_digest/);
    expect(sql).toContain("revoke all on function public.start_officer_conversation(uuid, text)\n  from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.start_officer_conversation(uuid, text) to authenticated;");
  });

  it("publishes a shared channel only for people of the caller's own chapter", () => {
    expect(leadership).toContain("perform private.member_pin_require_full_session();");
    expect(leadership).toContain("case when ranked.chapter_member and coalesce(pref.share_email, false) then pref.contact_email end");
    expect(leadership).toContain("case when ranked.chapter_member and coalesce(pref.share_phone, false) then pref.contact_phone end");
    expect(leadership).not.toContain("member_profile_details");
  });

  it("pins every new function in the database contract", () => {
    const sig = (value) => contract.functions.find((row) => row.sig === value);
    expect(sig("public.start_officer_conversation(p_officer_user_id uuid, p_body text)")).toMatchObject({ secdef: true, exec: "authenticated" });
    for (const name of ["private.chapter_leadership_people(p_org uuid, p_chapter text)", "private.member_contactable_officer_ids()", "private.caller_is_chapter_leader()"]) {
      expect(sig(name), name).toMatchObject({ secdef: true, exec: "" });
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("officer contact on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "officer-contact-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const main = `mwh-main-${orgA}`;
    const east = `mwh-east-${orgA}`;
    const other = `pkt-${orgB}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `mwh-${orgA}`, `Millrace Warehouse Workers ${orgA}`, orgB, `pkt-${orgB}`, `Port Kinsey Transit ${orgB}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Main Floor',$1,'proof',$4,9971), ($2,'East Dock',$2,'proof',$4,9972), ($3,'Depot',$3,'proof',$5,9973)`,
      [main, east, other, orgA, orgB]);
    return { orgA, orgB, main, east, other };
  }

  async function person(t, chapter, { organization = t.orgA, role = null, name = null, title = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, chapter, name ?? `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [organization, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,display_title) values ($1,$2,'active',$3) on conflict do nothing", [id, chapter, title]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, chapter]);
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

  async function capture(statement, args = []) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "", detail: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "", detail: error.detail || "" };
    }
  }

  const as = async (userId, statement, args = []) => {
    await actAs(userId);
    const result = await capture(statement, args);
    await asOwner();
    return result;
  };
  const start = (memberId, officerId, body) => as(memberId, "select public.start_officer_conversation($1, $2) as v", [officerId, body]);
  const peerList = (userId) => as(userId, "select public.list_reward_peer_contact() as v");
  const leadership = (userId) => as(userId, "select public.get_chapter_leadership() as v");

  it("delivers a member's first message to a listed officer, readable by the two of them only", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const president = await person(t, t.main, { role: "vp", name: "Ruthie Calloway" });
      const steward = await person(t, t.main, { role: "steward", name: "Kyle Dunmore" });
      const member = await person(t, t.main, { name: "Leon Haskett" });

      const sent = await start(member, president, "  A private question about the schedule.  ");
      expect(sent.ok, sent.message).toBe(true);
      expect(sent.value).toMatchObject({
        created: true,
        conversation: { peerName: "Ruthie Calloway", peerInitials: expect.any(String) },
        message: { sentByMe: true, body: "A private question about the schedule." },
      });
      const conversationId = sent.value.conversation.id;

      const request = await client.query(
        "select status, officer_contact, staff_authorized, responded_at is not null as responded from public.member_peer_contact_requests where requester_id=$1 and recipient_id=$2",
        [member, president]);
      expect(request.rows).toEqual([{ status: "accepted", officer_contact: true, staff_authorized: false, responded: true }]);

      // Both participants see it in their own member-contact projection.
      const officerView = await peerList(president);
      expect(officerView.value.conversations.map((row) => row.id)).toEqual([conversationId]);
      expect(officerView.value.conversations[0]).toMatchObject({ peerName: "Leon Haskett", messages: [{ sentByMe: false, body: "A private question about the schedule." }] });
      expect((await peerList(member)).value.conversations.map((row) => row.id)).toEqual([conversationId]);

      // A steward of the same chapter reads none of it, through the table or the projection.
      // The table has no client grant at all; the participant policy is defense in depth.
      const stewardRows = await as(steward, "select count(*)::int as v from public.member_peer_messages where conversation_id=$1", [conversationId]);
      expect(stewardRows).toMatchObject({ ok: false, code: "42501" });
      expect((await peerList(steward)).value.conversations).toEqual([]);

      // A second message reuses the same conversation and mints no new request.
      const again = await start(member, president, "Following up.");
      expect(again.value).toMatchObject({ created: false, conversation: { id: conversationId } });
      const requests = await client.query("select count(*)::int as n from public.member_peer_contact_requests where requester_id=$1", [member]);
      expect(requests.rows[0].n).toBe(1);
      // The officer answers through the existing peer writer.
      const reply = await as(president, "select public.send_reward_peer_message($1, 'Thanks, Leon.') as v", [conversationId]);
      expect(reply.ok, reply.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("reaches an organization administrator from another chapter, and refuses everyone the member may not contact", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await person(t, t.east, { name: "Nadia Farouk" });
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, orgAdmin]);
      const steward = await person(t, t.main, { role: "steward", name: "Pete Halvorsen" });
      const peer = await person(t, t.main, { name: "Another Member" });
      const eastOfficer = await person(t, t.east, { name: "East Officer", title: "Trustee" });
      const foreignAdmin = await person(t, t.other, { organization: t.orgB, role: "admin", name: "Foreign Admin" });
      const member = await person(t, t.main, { name: "Imani Clarke" });

      const allowed = await start(member, orgAdmin, "Hello from Main Floor.");
      expect(allowed.ok, allowed.message).toBe(true);
      expect((await peerList(orgAdmin)).value.conversations.map((row) => row.id)).toEqual([allowed.value.conversation.id]);

      for (const target of [steward, peer, eastOfficer, foreignAdmin, member, randomUUID()]) {
        const refused = await start(member, target, "Hello?");
        expect(refused, target).toMatchObject({ ok: false, code: "42501", detail: "officer_unavailable" });
      }
      const refusedNull = await start(member, null, "Hello?");
      expect(refusedNull).toMatchObject({ ok: false, code: "42501" });

      // A deleted or banned officer account is not reachable.
      const president = await person(t, t.main, { role: "vp", name: "Banned President" });
      await client.query("update auth.users set banned_until = now() + interval '1 day' where id=$1", [president]);
      expect(await start(member, president, "Hello?")).toMatchObject({ ok: false, detail: "officer_unavailable" });

      // An empty or oversized body stores nothing.
      const chapterAdmin = await person(t, t.main, { role: "admin", name: "Callum Reyes" });
      expect(await start(member, chapterAdmin, "   ")).toMatchObject({ ok: false, code: "22023" });
      expect(await start(member, chapterAdmin, "x".repeat(4001))).toMatchObject({ ok: false, code: "22023" });
      const stored = await client.query("select count(*)::int as n from public.member_peer_conversations where user_low=least($1::uuid,$2::uuid) and user_high=greatest($1::uuid,$2::uuid)", [member, chapterAdmin]);
      expect(stored.rows[0].n).toBe(0);

      // A restricted PIN session steps up before messaging an officer or
      // publishing contact details (gate r2s1).
      const pinSession = randomUUID();
      await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [pinSession, member]);
      await client.query("insert into private.member_pin_sessions(session_id,user_id) values ($1,$2)", [pinSession, member]);
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: member, role: "authenticated", aal: "aal2", session_id: pinSession })]);
      await client.query("set local role authenticated");
      const pinStart = await capture("select public.start_officer_conversation($1, 'From a PIN session') as v", [chapterAdmin]);
      const pinShare = await capture("select public.set_my_steward_contact_visibility(false, false, null, null) as v");
      await asOwner();
      expect(pinStart).toMatchObject({ ok: false, code: "42501", message: "step-up required" });
      expect(pinShare).toMatchObject({ ok: false, code: "42501", message: "step-up required" });
      const pinStored = await client.query("select count(*)::int as n from public.member_peer_conversations where user_low=least($1::uuid,$2::uuid) and user_high=greatest($1::uuid,$2::uuid)", [member, chapterAdmin]);
      expect(pinStored.rows[0].n).toBe(0);
      // The same member in a full session is not refused.
      expect((await start(member, chapterAdmin, "From a full session")).ok).toBe(true);

      await client.query("set local role anon");
      const anonymous = await capture("select public.start_officer_conversation($1, 'hi') as v", [orgAdmin]);
      await asOwner();
      expect(anonymous.ok).toBe(false);
    } finally {
      await client.query("rollback");
    }
  });

  it("counts new officer conversations toward the daily contact-request limit", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const officers = [];
      for (const title of ["Secretary", "Treasurer", "Trustee", "Recording Secretary"]) {
        officers.push(await person(t, t.main, { name: title, title }));
      }
      const member = await person(t, t.main, { name: "Imani Clarke" });
      for (const officer of officers.slice(0, 3)) expect((await start(member, officer, "Hello.")).ok).toBe(true);
      expect(await start(member, officers[3], "Hello.")).toMatchObject({ ok: false, code: "22023", detail: "officer_contact_limit" });
      // An existing conversation is still open to the member.
      expect((await start(member, officers[0], "Again.")).ok).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("reports canMessage and shows only the channels an officer of the member's chapter shared", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const officer = await person(t, t.main, { name: "Samuel Adeyemi", title: "Secretary-Treasurer" });
      const orgAdmin = await person(t, t.east, { name: "Nadia Farouk" });
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, orgAdmin]);
      const member = await person(t, t.main, { name: "Imani Clarke" });

      // A listed officer who is not a steward may now share; a plain member may not.
      const shared = await as(officer, "select public.set_my_steward_contact_visibility(true, false, 'sam@example.invalid', '555-0100') as v");
      expect(shared.ok, shared.message).toBe(true);
      expect(shared.value).toMatchObject({ shareEmail: true, sharePhone: false });
      expect(await as(member, "select public.set_my_steward_contact_visibility(true, false, 'me@example.invalid', null) as v")).toMatchObject({ ok: false, code: "42501" });
      // The organization administrator shares too, but belongs to East Dock.
      expect((await as(orgAdmin, "select public.set_my_steward_contact_visibility(true, true, 'nadia@example.invalid', '555-0101') as v")).ok).toBe(true);

      const roster = await leadership(member);
      expect(roster.ok, roster.message).toBe(true);
      const byId = new Map(roster.value.people.map((row) => [row.id, row]));
      expect(byId.get(officer)).toMatchObject({ canMessage: true, contact: { email: "sam@example.invalid", phone: null } });
      expect(byId.get(orgAdmin)).toMatchObject({ canMessage: true, contact: { email: null, phone: null } });

      // East Dock's members do see the administrator's shared channels.
      const eastMember = await person(t, t.east, { name: "East Member" });
      const east = await leadership(eastMember);
      expect(east.value.people.find((row) => row.id === orgAdmin)).toMatchObject({ contact: { email: "nadia@example.invalid", phone: "555-0101" } });

      // The officer reading their own chapter's list cannot message themselves.
      const own = await leadership(officer);
      expect(own.value.people.find((row) => row.id === officer)).toMatchObject({ canMessage: false });

      // Withdrawal hides the channel at once.
      expect((await as(officer, "select public.set_my_steward_contact_visibility(false, false, null, null) as v")).ok).toBe(true);
      expect((await leadership(member)).value.people.find((row) => row.id === officer).contact).toEqual({ email: null, phone: null });
    } finally {
      await client.query("rollback");
    }
  });
});
