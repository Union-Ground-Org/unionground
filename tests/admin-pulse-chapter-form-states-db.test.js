// @vitest-environment node
//
// BUG-UG-ADMIN-PULSE-FORMS-CARD-NEVER-SHOWS-FOR-ADMIN-ONLY-20261110 (#7981):
// the native Pulse Forms card for an account whose only role is admin reads
// public.get_admin_chapter_form_states. It checks admin authority over the
// named chapter, counts the latest 100 forms of the chapter's members by
// state, withholds the whole result when any state has fewer different people
// than the organization privacy floor (ten until #8768, never below 25 since:
// 20261113135500_native_leader_gates_follow_organization_floor.sql), and
// returns states, counts and the floor it applied (privacyFloor
// only). Row access on member_profiles and
// member_forms is not widened.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const FILE = readdirSync("supabase/migrations").filter((name) => name.endsWith("_admin_pulse_chapter_form_states.sql")).sort().at(-1);
const code = stripComments(readFileSync(`supabase/migrations/${FILE}`, "utf8"));
// The live definition is the newest migration that (re)defines the function.
const LATEST = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()
  .filter((name) => /function public\.get_admin_chapter_form_states\(p_chapter_id text\)/.test(readFileSync(`supabase/migrations/${name}`, "utf8"))).at(-1);
const latestCode = stripComments(readFileSync(`supabase/migrations/${LATEST}`, "utf8"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("admin Pulse chapter form states migration (offline)", () => {
  it("adds one admin-checked aggregate and widens no row access", () => {
    expect(code.match(/^begin;$/gm)).toHaveLength(1);
    expect(code.match(/^commit;$/gm)).toHaveLength(1);
    expect(code).toContain("create function public.get_admin_chapter_form_states(p_chapter_id text)");
    expect(code).toContain("grant execute on function public.get_admin_chapter_form_states(text) to authenticated;");
    expect(code).not.toMatch(/\b(create|alter|drop) policy\b|\bgrant (select|insert|update|delete)\b|\balter table\b/i);
    // Only states and counts leave: no id, name or answer is selected into the result.
    expect(code).not.toMatch(/'(userId|user_id|name|answers|id)'\s*,/);
  });

  it("is pinned in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig === "public.get_admin_chapter_form_states(p_chapter_id text)");
    expect(entry).toMatchObject({ secdef: true, exec: "authenticated" });
    const squash = (text) => text.replace(/\s+/g, " ");
    for (const needle of entry.bodyContains) expect(squash(latestCode)).toContain(squash(needle));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("admin Pulse chapter form states on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "admin-pulse-form-states-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values = [], user = null) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "anon" })]);
      await c.query(user ? "set local role authenticated" : "set local role anon");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }
  const states = (chapter, user) => call("select public.get_admin_chapter_form_states($1) as r", [chapter], user);
  const value = async (chapter, user) => {
    const result = await states(chapter, user);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0].r;
  };

  async function person(org, chapter, role = null) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [user.id, chapter, `Proof ${role || "member"} ${user.id.slice(0, 6)}`]);
    if (role) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapter]);
    }
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }
  async function forms(owners, status, perOwner = 1, minutesAgo = 60) {
    for (const [index, owner] of owners.entries()) {
      for (let n = 0; n < perOwner; n += 1) {
        await c.query("insert into public.member_forms(user_id,template_key,status,answers,updated_at,submitted_at) values ($1,'grievance',$2,'{\"what\":\"Private answer\"}'::jsonb,now() - make_interval(mins => $3),now() - make_interval(mins => $3))",
          [owner.id, status, minutesAgo + index * 10 + n]);
      }
    }
  }

  beforeEach(async () => {
    await c.query("begin");
    const tag = randomUUID().slice(0, 8);
    const orgA = { id: randomUUID(), chapter: `pulse-forms-a-${tag}`, other: `pulse-forms-a2-${tag}` };
    const orgB = { id: randomUUID(), chapter: `pulse-forms-b-${tag}` };
    for (const [org, chapters] of [[orgA, [orgA.chapter, orgA.other]], [orgB, [orgB.chapter]]]) {
      await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, `pulse-forms-${org.id}`]);
      for (const [index, chapter] of chapters.entries()) {
        await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,$3)", [chapter, org.id, 98320 + index]);
      }
      await c.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values (true,$1,true)", [org.id]);
    }
    const members = [];
    for (let index = 0; index < 30; index += 1) members.push(await person(orgA.id, orgA.chapter));
    world = {
      orgA, orgB, members,
      admin: await person(orgA.id, orgA.chapter, "admin"),
      steward: await person(orgA.id, orgA.chapter, "steward"),
      coordinator: await person(orgA.id, orgA.chapter, "coordinator"),
      foreignAdmin: await person(orgB.id, orgB.chapter, "admin"),
    };
    await c.query("select set_config('request.jwt.claims', '', true)");
  });
  afterEach(async () => { await c.query("rollback"); });

  it("gives an admin-only account the chapter's form states, counts only, with no row access widened", async () => {
    await forms(world.members.slice(0, 25), "submitted");
    await forms(world.members, "approved", 1, 600);
    const result = await value(world.orgA.chapter, world.admin);
    expect(result).toEqual({ withheld: false, states: [{ status: "approved", count: 30 }, { status: "submitted", count: 25 }], privacyFloor: 25 });
    const text = JSON.stringify(result);
    for (const member of world.members) expect(text).not.toContain(member.id);
    expect(text).not.toMatch(/Private answer|Proof/);
    // The admin's own row reads are unchanged: still no admin branch on either table.
    const profiles = await call("select count(*)::int as n from public.member_profiles where chapter_id = $1", [world.orgA.chapter], world.admin);
    expect(profiles.ok && profiles.rows[0].n).toBeLessThan(world.members.length);
    const ownForms = await call("select count(*)::int as n from public.member_forms f join public.member_profiles p on p.id = f.user_id where p.chapter_id = $1", [world.orgA.chapter], world.admin);
    expect(ownForms).toMatchObject({ ok: true, rows: [{ n: 0 }] });
  });

  it("withholds the whole result when one state has fewer different people than the floor", async () => {
    await forms(world.members.slice(0, 25), "submitted");
    await forms(world.members.slice(0, 2), "in_review", 3, 5);
    expect(await value(world.orgA.chapter, world.admin)).toEqual({ withheld: true, states: null, privacyFloor: 25 });
  });

  it("counts only the latest 100 forms and returns an empty chapter as no states", async () => {
    expect(await value(world.orgA.chapter, world.admin)).toEqual({ withheld: false, states: [], privacyFloor: 25 });
    // 30 people with four forms each: the latest 100 are the forms of 25
    // different people, which meets the floor.
    await forms(world.members, "submitted", 4);
    expect(await value(world.orgA.chapter, world.admin)).toEqual({ withheld: false, states: [{ status: "submitted", count: 100 }], privacyFloor: 25 });
  });

  it("refuses an admin of another organization, another organization's chapter, an unknown chapter and non-admin staff", async () => {
    await forms(world.members.slice(0, 25), "submitted");
    expect(await states(world.orgA.chapter, world.foreignAdmin)).toMatchObject({ ok: false, code: "42501" });
    expect(await states(world.orgB.chapter, world.admin)).toMatchObject({ ok: false, code: "42501" });
    expect(await states(`missing-${randomUUID().slice(0, 8)}`, world.admin)).toMatchObject({ ok: false, code: "42501" });
    for (const user of [world.steward, world.coordinator, world.members[0]]) {
      expect(await states(world.orgA.chapter, user)).toMatchObject({ ok: false, code: "42501" });
    }
    expect(await states(world.orgA.chapter, null)).toMatchObject({ ok: false, code: "42501" });
  });

  it("serves an organization admin every chapter of that organization, and only those", async () => {
    const other = [];
    for (let index = 0; index < 25; index += 1) other.push(await person(world.orgA.id, world.orgA.other));
    await forms(other, "approved");
    await c.query("select set_config('request.jwt.claims', '', true)");
    expect(await value(world.orgA.other, world.admin)).toEqual({ withheld: false, states: [{ status: "approved", count: 25 }], privacyFloor: 25 });
    expect(await value(world.orgA.chapter, world.admin)).toEqual({ withheld: false, states: [], privacyFloor: 25 });
  });
});
