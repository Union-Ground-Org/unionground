// @vitest-environment node
//
// BUG-UG-HOME-GUIDE-NAMES-PAUSED-STEWARD-20261103 (#6876)
//
// public.get_member_steward_message_available() tells the app ahead of time
// what send_member_message would decide: whether anyone could read the
// caller's Chapter steward message (private.chapter_steward_reader_exists).
// A chapter whose only steward has not finished two-step sign-in answers
// false, the same case the send path refuses with no_steward_assigned.
// Fictional tenants; every refusal has an allowed control; every row is
// rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261103150000_member_steward_message_available";
const SIG = "public.get_member_steward_message_available()";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member steward message availability (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("returns the send path's own reader rule behind the roster's guards, and changes nothing else", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const body = stripComments(fnBody(sql, SIG));
    expect(body).toMatch(/\$function\$\s*begin\s+perform private\.member_pin_require_full_session\(\);/);
    expect(body).toContain("if caller is null or not private.mfa_satisfied()\n     or private.current_member_organization() is null then\n    raise exception 'authentication required' using errcode = '42501';");
    expect(body).toContain("return private.chapter_steward_reader_exists(caller);");
    expect(sql).toMatch(/create function public\.get_member_steward_message_available\(\)\s+returns boolean\s+language plpgsql\s+stable\s+security definer\s+set search_path = ''/);
    // One new function; no existing function, policy or table is touched.
    expect(sql.match(/\bcreate\b(?: or replace)? function\b/gi)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(alter|drop)\s+(function|table|policy)\b|\bcreate\s+(policy|table)\b/i);
    expect(sql).toContain("revoke all on function public.get_member_steward_message_available() from public, anon, service_role;");
    expect(sql).toContain("grant execute on function public.get_member_steward_message_available() to authenticated;");
  });

  it("pins the function in the database contract", () => {
    expect(contract.functions.find((row) => row.sig === SIG)).toMatchObject({
      secdef: true,
      exec: "authenticated",
      bodyContains: expect.arrayContaining(["private.mfa_satisfied()", "errcode = '42501'", "private.member_pin_require_full_session()", "private.chapter_steward_reader_exists(caller)"]),
    });
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("member steward message availability on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "member-steward-message-available-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const local = `ash-local-${orgA}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [orgA, `ash-${orgA}`, `Ashgrove Local ${orgA}`]);
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Ashgrove Local',$1,'proof',$2,9983)`,
      [local, orgA]);
    return { orgA, local };
  }

  async function person(t, { chapterRole = null, secondFactor = true } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, t.local, `Proof ${id.slice(0, 8)}`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.orgA, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.local]);
    if (secondFactor) {
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    if (chapterRole) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, chapterRole, t.local]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, chapterRole, t.local]);
    }
    return id;
  }

  async function actAs(userId, { role = "authenticated", aal = "aal2" } = {}) {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [session, userId, aal]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role, aal, session_id: session })]);
    await client.query(`set local role ${role}`);
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
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "", detail: error.detail || "" };
    }
  }

  const available = () => capture("select public.get_member_steward_message_available() as v");
  const start = (body) => capture("select public.start_member_conversation($1) as v", [body]);

  it("answers false for a chapter whose only steward is paused, the case the send path refuses", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await person(t, { chapterRole: "steward", secondFactor: false });
      const member = await person(t);

      await actAs(member);
      const answer = await available();
      const sent = await start("Fall goals for the chapter");
      await asOwner();
      expect(answer).toMatchObject({ ok: true, value: false });
      expect(sent).toMatchObject({ ok: false, code: "22023", detail: "no_steward_assigned" });
    } finally {
      await client.query("rollback");
    }
  });

  it("answers true once the steward can read, and the send path agrees", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await person(t, { chapterRole: "steward" });
      const member = await person(t);

      await actAs(member);
      const answer = await available();
      const sent = await start("Fall goals for the chapter");
      await asOwner();
      expect(answer).toMatchObject({ ok: true, value: true });
      expect(sent.ok, sent.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  // Gate r1s2: the named-steward form's write is not refused (its conversation
  // is bound to that steward), so its warning says the message waits unread.
  it("stores a named steward's message while nobody can read it, and shows it to the steward once they can", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const steward = await person(t, { chapterRole: "steward", secondFactor: false });
      const member = await person(t);

      await actAs(member);
      const answer = await available();
      const named = await capture("select public.start_member_steward_conversation($1,$2) as v", [steward, "Fall goals for the chapter"]);
      await asOwner();
      expect(answer).toMatchObject({ ok: true, value: false });
      expect(named.ok, named.message).toBe(true);
      const bound = (await client.query("select count(*)::int as n from public.member_conversations where user_id=$1 and steward_user_id=$2", [member, steward])).rows[0].n;
      expect(bound).toBe(1);

      // The paused steward cannot open it now ...
      await actAs(steward, { aal: "aal1" });
      const now = await capture("select pg_catalog.count(*)::int as v from public.member_conversations where user_id=$1", [member]);
      await asOwner();
      expect(now).toMatchObject({ ok: true, value: 0 });

      // ... and can once two-step sign-in is finished.
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), steward]);
      await actAs(steward);
      const later = await capture("select pg_catalog.count(*)::int as v from public.member_conversations where user_id=$1", [member]);
      await asOwner();
      expect(later).toMatchObject({ ok: true, value: 1 });
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses an anonymous caller, an unfinished second factor and a member without an organization", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await person(t, { chapterRole: "steward" });
      const member = await person(t);

      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "anon" })]);
      await client.query("set local role anon");
      const anonymous = await available();
      await asOwner();
      expect(anonymous).toMatchObject({ ok: false, code: "42501" });

      // The member has a verified factor but this session is still aal1.
      await actAs(member, { aal: "aal1" });
      const aal1 = await available();
      await asOwner();
      expect(aal1).toMatchObject({ ok: false, code: "42501" });

      const outsider = randomUUID();
      await client.query("insert into auth.users(id,email) values ($1,$2)", [outsider, `${outsider}@example.invalid`]);
      await actAs(outsider);
      const noOrganization = await available();
      await asOwner();
      expect(noOrganization).toMatchObject({ ok: false, code: "42501" });

      // Allowed control: the same member at aal2.
      await actAs(member);
      const allowed = await available();
      await asOwner();
      expect(allowed).toMatchObject({ ok: true, value: true });
    } finally {
      await client.query("rollback");
    }
  });
});
