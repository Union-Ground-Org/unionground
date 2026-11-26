// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

// BUG-UG-SHARED-DEMO-PERSONA-CAN-START-DEMO-LEARNING-PERIOD-20261108
// (#7557). Every SAMPLE visitor shares the seven persona accounts, and the staff
// personas hold aal2 sessions, so the Admin persona passed the start and
// end-early checks. An organization gets one learning period and ending it is
// final, so a persona session may neither start nor end it, from any client.
// A real administrator of the same organization still does both, and the
// personas still read the period. Each case runs in one transaction that is
// rolled back.
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const PERSONAS = {
  admin: "rosa.martinez@example.invalid",
  member: "darnell.foster@example.invalid",
};

live("shared demo persona learning-period guard on a disposable database", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "shared-demo-persona-learning-period" });
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

  // The same seed shape as the persona access guard proof: a persona's factor
  // is seed state written under the operator override.
  async function person(email, chapter, { admin = false } = {}) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, email]);
    await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.org, user.id]);
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, chapter]);
    await c.query("update public.member_profiles set chapter_id=$2, full_name='Proof Person', language='en' where id=$1", [user.id, chapter]);
    if (admin) {
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [w.org, user.id]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2) on conflict do nothing", [user.id, chapter]);
      await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [user.id, chapter]);
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
    await releaseLearningPeriodHold(c);
    const suffix = randomUUID().slice(0, 8);
    w = { org: randomUUID(), chapter: `persona-learning-${suffix}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [w.org, `persona-learning-${suffix}`]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98419)", [w.chapter, w.org]);
    w.persona = await person(PERSONAS.admin, w.chapter, { admin: true });
    w.member = await person(PERSONAS.member, w.chapter);
    w.realAdmin = await person(`${randomUUID()}@example.invalid`, w.chapter, { admin: true });
  });
  afterEach(async () => { await c.query("rollback"); });

  const period = async () => (await q("select length_days, ended_early_at, ended_early_by from private.organization_learning_periods where organization_id = $1", [w.org]))[0] ?? null;

  it("refuses the shared Admin persona a start and an end, and keeps both for a real administrator", async () => {
    await refused("select public.start_organization_learning_period(14) as r", [], w.persona);
    await refused("select public.start_organization_learning_period(7) as r", [], w.persona);
    expect(await period()).toBeNull();

    expect(await ok("select (public.start_organization_learning_period(7)) ->> 'running' as r", [], w.realAdmin)).toBe("true");
    expect(await period()).toMatchObject({ length_days: 7, ended_early_at: null });

    await refused("select public.end_organization_learning_period_early() as r", [], w.persona);
    expect(await period()).toMatchObject({ ended_early_at: null });

    await ok("select public.end_organization_learning_period_early() as r", [], w.realAdmin);
    const ended = await period();
    expect(ended.ended_early_at).not.toBeNull();
    expect(ended.ended_early_by).toBe(w.realAdmin.id);
  });

  it("keeps the period readable to the personas", async () => {
    await ok("select public.start_organization_learning_period(14) as r", [], w.realAdmin);
    expect(await ok("select (public.get_organization_learning_period()) ->> 'running' as r", [], w.persona)).toBe("true");
    expect(await ok("select (public.get_organization_learning_period()) ->> 'running' as r", [], w.member)).toBe("true");
  });

  it("refuses a persona without the admin role as before, not as a demo account", async () => {
    const result = await call("select public.start_organization_learning_period(14) as r", [], w.member);
    expect(result).toMatchObject({ ok: false, code: "42501" });
    expect(result.hint).not.toBe("shared-demo-account");
  });

  it("lets the operator maintenance override through for one transaction", async () => {
    await c.query("set local union_ground.shared_demo_persona_maintenance = 'on'");
    expect(await ok("select (public.start_organization_learning_period(14)) ->> 'running' as r", [], w.persona)).toBe("true");
    await ok("select public.end_organization_learning_period_early() as r", [], w.persona);
    await c.query("set local union_ground.shared_demo_persona_maintenance = 'off'");
    expect((await period()).ended_early_by).toBe(w.persona.id);
  });
});
