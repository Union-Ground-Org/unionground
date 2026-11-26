// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// BUG-UG-SHARED-DEMO-ADMIN-LOCKS-OUT-LATER-VISITORS-20261107 (#7386;
// gate r6s1 on #7375). Every SAMPLE visitor shares the seven persona accounts,
// the Admin persona included, so a request from a persona session may not
// change who can enter or use a hat: the organization two-step policy, any
// persona's roles and memberships, or a SCIM token whose deprovisioning would
// revoke one. Bot and staff accounts managed from the Admin hat keep today's
// behaviour. Each case runs in one transaction that is rolled back.
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PERSONAS = {
  admin: "rosa.martinez@example.invalid",
  member: "darnell.foster@example.invalid",
  steward: "maya.thompson@example.invalid",
};

live("shared demo persona access guard on a disposable database", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "shared-demo-persona-access-guard" });
    await c.connect();
    await c.query("set statement_timeout = '20s'");
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
      await c.query("select set_config('request.jwt.claims', '', true)");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, hint: error.hint, message: error.message };
    }
  }
  const ok = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  };
  const refused = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: "42501", hint: "shared-demo-account" });
  };
  const q = async (text, values = []) => (await c.query(text, values)).rows;

  // A persona's factor is seed state, written under the operator override as
  // 20261107120000 requires; everything else is written without claims, as
  // the seed writes it.
  async function person(email, chapters, { orgRoles = [], chapterRoles = [] } = {}) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, email]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.org, user.id]);
    for (const chapter of chapters) {
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapter]);
    }
    await c.query("update public.member_profiles set chapter_id=$2, full_name='Proof Person', language='en' where id=$1", [user.id, chapters[0] ?? null]);
    for (const role of orgRoles) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [w.org, user.id, role]);
    }
    for (const [role, chapter] of chapterRoles) {
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, chapter]);
      await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [user.id, role, chapter]);
    }
    if (orgRoles.length || chapterRoles.length) {
      await c.query("savepoint factor");
      await c.query("set local union_ground.shared_demo_persona_maintenance = 'on'");
      await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
      await c.query("release savepoint factor");
      await c.query("set local union_ground.shared_demo_persona_maintenance = 'off'");
    }
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    const suffix = randomUUID().slice(0, 8);
    w = { org: randomUUID(), a: `persona-access-a-${suffix}`, b: `persona-access-b-${suffix}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [w.org, `persona-access-${suffix}`]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$3,98417), ($2,$2,$2,$3,98418)", [w.a, w.b, w.org]);
    w.admin = await person(PERSONAS.admin, [w.a], { orgRoles: ["admin"], chapterRoles: [["admin", w.a]] });
    w.member = await person(PERSONAS.member, [w.a]);
    w.steward = await person(PERSONAS.steward, [w.a], { chapterRoles: [["steward", w.a]] });
    w.realAdmin = await person(`${randomUUID()}@example.invalid`, [w.a], { orgRoles: ["admin"], chapterRoles: [["admin", w.a]] });
    w.bot = await person(`${randomUUID()}@example.invalid`, [w.a]);
  });
  afterEach(async () => { await c.query("rollback"); });

  const memberMfaRequired = async () => (await q("select require_member_mfa from public.org_security_policy where organization_id = $1", [w.org]))[0]?.require_member_mfa ?? false;
  const orgRole = async (user, role) => (await q("select count(*)::int as n from public.organization_role_grants where organization_id = $1 and user_id = $2 and role = $3", [w.org, user.id, role]))[0].n === 1;
  const chapterRole = async (user, role, chapter) => (await q("select count(*)::int as n from public.member_role_chapters where user_id = $1 and role = $2 and chapter_id = $3", [user.id, role, chapter]))[0].n === 1;
  const membership = async (user, chapter) => (await q("select status, pinned, display_title from public.member_chapter_memberships where user_id = $1 and chapter_id = $2", [user.id, chapter]))[0] ?? null;

  // Gate r6s1: the shared Admin hat cannot wall the Member persona behind an
  // enrolment it is not allowed to complete.
  it("refuses the organization two-step policy from the shared Admin persona and keeps it for a real administrator", async () => {
    await refused("select public.set_member_mfa_policy(true) as r", [], w.admin);
    await refused("select public.set_staff_mfa_policy(true) as r", [], w.admin);
    expect(await memberMfaRequired()).toBe(false);
    expect(await ok("select (public.set_member_mfa_policy(true)) ->> 'changed' as r", [], w.realAdmin)).toBe("true");
    expect(await memberMfaRequired()).toBe(true);
    await refused("select public.set_member_mfa_policy(false) as r", [], w.admin);
    expect(await memberMfaRequired()).toBe(true);
  });

  it("refuses granting, revoking or moving any persona's organization or chapter role from a persona session", async () => {
    await refused("select public.set_member_organization_role($1, 'admin', false) as r", [w.admin.id], w.admin);
    // Use supported organization and unit-steward
    // grant shapes, retaining the exact persona access refusal for both.
    await refused("select public.set_member_organization_role($1, 'coordinator', true) as r", [w.member.id], w.admin);
    await refused("select public.set_member_access_role($1,$2,'steward',true,((public.get_chapter_access_workspace($2)->'units')->0->>'id')::uuid,null) as r", [w.member.id,w.a], w.admin);
    await refused("select public.set_member_chapter_role($1, $2, 'steward', false) as r", [w.steward.id, w.a], w.admin);
    await refused("select public.set_member_chapter_role($1, $2, 'coordinator', true) as r", [w.member.id, w.a], w.admin);
    expect(await orgRole(w.admin, "admin")).toBe(true);
    expect(await orgRole(w.member, "steward")).toBe(false);
    expect(await chapterRole(w.steward, "steward", w.a)).toBe(true);
    expect(await chapterRole(w.member, "coordinator", w.a)).toBe(false);
  });

  it("refuses adding, revoking or moving a persona's membership but lets its pin and display title change", async () => {
    await refused("select public.revoke_member_chapter_membership($1, $2) as r", [w.member.id, w.a], w.admin);
    await refused("select public.grant_member_chapter_membership($1, $2) as r", [w.member.id, w.b], w.admin);
    expect(await membership(w.member, w.a)).toMatchObject({ status: "active" });
    expect(await membership(w.member, w.b)).toBeNull();
    await ok("select public.set_my_chapter_pin($1, true) as r", [w.a], w.member);
    expect(await membership(w.member, w.a)).toMatchObject({ status: "active", pinned: true });
    await ok("select public.set_member_chapter_display_title($1, $2, 'Shop floor') as r", [w.member.id, w.a], w.admin);
    expect(await membership(w.member, w.a)).toMatchObject({ display_title: "Shop floor" });
  });

  // Gate r1s1 on #7395: Add chapter from the Admin hat writes the creator's
  // membership in the new chapter. That additive row passes; revoking or
  // moving it afterwards is still refused.
  it("lets the shared Admin persona add a chapter while its membership there still cannot be revoked or moved", async () => {
    const created = `persona-new-${randomUUID().slice(0, 8)}`;
    expect(await ok("select (public.create_admin_chapter($1, 'Night Shift Chapter')) ->> 'created' as r", [created], w.admin)).toBe("true");
    expect(await membership(w.admin, created)).toMatchObject({ status: "active" });
    await refused("select public.revoke_member_chapter_membership($1, $2) as r", [w.admin.id, created], w.admin);
    const asPersona = JSON.stringify({ role: "authenticated", sub: w.admin.id, session_id: w.admin.session, aal: "aal2" });
    for (const text of [
      "update public.member_chapter_memberships set status = 'revoked', revoked_at = now() where user_id = $1 and chapter_id = $2",
      `update public.member_chapter_memberships set chapter_id = '${w.b}' where user_id = $1 and chapter_id = $2`,
      "delete from public.member_chapter_memberships where user_id = $1 and chapter_id = $2",
    ]) {
      await c.query("savepoint direct");
      await c.query("select set_config('request.jwt.claims', $1, true)", [asPersona]);
      const error = await c.query(text, [w.admin.id, created]).then(() => null, (failure) => failure);
      await c.query("rollback to savepoint direct");
      expect(error?.code, text).toBe("42501");
      expect(error?.hint).toBe("shared-demo-account");
    }
    expect(await membership(w.admin, created)).toMatchObject({ status: "active" });
    // The exception is only for the caller's own row in an empty chapter: the
    // Admin hat still cannot place another persona there.
    await refused("select public.grant_member_chapter_membership($1, $2) as r", [w.member.id, created], w.admin);
  });

  it("refuses the same writes at the table, whatever function a persona session reaches them through", async () => {
    const asPersona = { role: "authenticated", sub: w.admin.id, session_id: w.admin.session, aal: "aal2" };
    const direct = async (text, values) => {
      await c.query("savepoint direct");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(asPersona)]);
      try {
        await c.query(text, values);
        throw new Error(`Expected the guard to refuse: ${text}`);
      } catch (error) {
        expect(error.code, error.message).toBe("42501");
        expect(error.hint).toBe("shared-demo-account");
      } finally {
        await c.query("rollback to savepoint direct");
      }
    };
    await direct("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [w.org, w.member.id]);
    await direct("delete from public.member_roles where user_id = $1", [w.steward.id]);
    await direct("insert into public.org_security_policy(id, organization_id, require_staff_mfa, require_member_mfa) values (true, $1, true, true)", [w.org]);
    await direct("insert into public.scim_tokens(organization_id, token_hash, label, token_prefix, expires_at) values ($1, repeat('a', 64), 'visitor', 'ug_scim_abcd', now() + interval '1 day')", [w.org]);
    await c.query("select set_config('request.jwt.claims', '', true)");
  });

  it("leaves staff and bot accounts managed from the Admin hat, seed writes and the operator override alone", async () => {
    // The ordinary-bot organization control uses coordinator.
    expect(await ok("select (public.set_member_organization_role($1, 'coordinator', true)) ->> 'changed' as r", [w.bot.id], w.admin)).toBe("true");
    // Assert the actual supported grant above.
    expect(await orgRole(w.bot, "coordinator")).toBe(true);
    await ok("select public.revoke_member_chapter_membership($1, $2) as r", [w.bot.id, w.a], w.admin);
    expect(await membership(w.bot, w.a)).toMatchObject({ status: "revoked" });
    expect(await ok("select (public.set_member_organization_role($1, 'coordinator', true)) ->> 'changed' as r", [w.member.id], w.realAdmin)).toBe("true");
    // No persona session (the seed and the service role) and the operator
    // override both still write persona rows.
    expect((await c.query("update public.organization_role_grants set granted_by = granted_by where user_id = $1", [w.admin.id])).rowCount).toBe(1);
    await c.query("savepoint maintenance");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: w.admin.id, session_id: w.admin.session, aal: "aal2" })]);
    await c.query("set local union_ground.shared_demo_persona_maintenance = 'on'");
    expect((await c.query("delete from public.member_role_chapters where user_id = $1 and role = 'steward'", [w.steward.id])).rowCount).toBe(1);
    await c.query("rollback to savepoint maintenance");
    await c.query("set local union_ground.shared_demo_persona_maintenance = 'off'");
    await c.query("select set_config('request.jwt.claims', '', true)");
  });
});
