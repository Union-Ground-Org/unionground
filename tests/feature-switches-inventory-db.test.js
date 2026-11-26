// @vitest-environment node
//
// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001 (PR 2: inventory).
//
// Offline half: the migration's pins. Live half (disposable loopback only):
// platform-only definitions, the provider status RPC, the organization Compass
// switch and per-role caps, and the dues reminder planner switch and delay.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";

const sql = readFileSync("supabase/migrations/20261002022000_feature_switches_inventory.sql", "utf8");
const code = stripComments(sql).replace(/\s+/g, " ");
const mesh = "union-ground-mesh";
const model = "union-ground/compass-mesh:v1";

describe("feature switches inventory migration (offline)", () => {
  it("is one atomic migration whose writers take the case-graph gate first", () => {
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const name of ["public.set_organization_integration_status", "public.reserve_compass_ai_request", "private.write_organization_setting"]) {
      expect(helperFirst(functions.find((fn) => fn.name === name).source), name).toBe(true);
    }
  });

  it("registers the inventory settings with today's behavior as the default", () => {
    for (const [key, value] of [
      ["features.ai_assistant.enabled", "'true'"],
      ["features.notifications.dues_reminders", "'true'"],
      ["limits.notifications.dues_reminder_days_past_due", "'1'"],
      ["limits.ai_assistant.hourly_member", "'200'"],
      ["limits.intelligence.connection_weight_issues", "'25'"],
    ]) expect(code.slice(code.indexOf(`('${key}'`)).slice(0, 400), key).toContain(value);
    expect(code).toContain("add column organization_editable boolean not null default true");
    expect(code).toContain("update public.platform_setting_definitions set organization_editable = false where key in ('limits.security.signin_attempts_per_email_hour', 'limits.security.signin_attempts_per_ip_hour');");
  });

  it("keeps the platform kill switch and attestation ahead of the organization switch", () => {
    const reserve = parseFunctions(sql).find((fn) => fn.name === "public.reserve_compass_ai_request").source;
    const platformGate = reserve.indexOf("if policy.enabled is not true");
    const organizationGate = reserve.indexOf("'features.ai_assistant.enabled'");
    expect(platformGate).toBeGreaterThan(-1);
    expect(organizationGate).toBeGreaterThan(platformGate);
    expect(reserve).toContain("effective_limit := least(effective_limit, coalesce((");
    expect(reserve).toContain("effective_limit := least(\n    200,");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("feature switches inventory on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "feature-switches-inventory-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values = [], user = null) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "service_role" })]);
      await c.query(user ? "set local role authenticated" : "set local role service_role");
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

  beforeEach(async () => {
    await c.query("begin");
    world = {};
    for (const [label, role] of [["a", "admin"], ["steward", "steward"], ["b", "admin"]]) {
      const org = label === "b" ? "orgB" : "orgA";
      if (!world[org]) {
        world[org] = { id: randomUUID(), chapter: `inventory-${label}-${randomUUID().slice(0, 8)}` };
        await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world[org].id, world[org].chapter]);
        await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98311)", [world[org].chapter, world[org].id]);
      }
      const user = { id: randomUUID(), session: randomUUID(), org: world[org] };
      world[label] = user;
      await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
      await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [user.org.id, user.id]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, user.org.chapter]);
      await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, user.org.chapter]);
      await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [user.org.id, user.id, role]);
      await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, user.org.chapter]);
      await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    }
    for (const org of [world.orgA, world.orgB]) {
      await c.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values (true,$1,true) on conflict do nothing", [org.id]);
    }
  });
  afterEach(async () => { await c.query("rollback"); });

  it("keeps the platform-wide sign-in limits read-only for every organization", async () => {
    // 20261002015000 (#3747) inserted these definitions before this migration.
    const flag = (await c.query("select organization_editable from public.platform_setting_definitions where key = 'limits.security.signin_attempts_per_email_hour'")).rows[0];
    expect(flag).toEqual({ organization_editable: false });
    const write = await call("select public.set_organization_setting('limits.security.signin_attempts_per_email_hour', '9'::jsonb, null)", [], world.a);
    expect(write).toMatchObject({ ok: false, code: "42501" });
    const legacy = await call("select public.update_organization_setting('limits.security.signin_attempts_per_email_hour', '9'::jsonb)", [], world.a);
    expect(legacy).toMatchObject({ ok: false, code: "42501" });
    // 20261002015000's check constraint refuses a stored organization value outright.
    await c.query("savepoint stored");
    await expect(c.query("insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,'limits.security.signin_attempts_per_email_hour','9')", [world.orgA.id]))
      .rejects.toMatchObject({ code: "23514" });
    await c.query("rollback to savepoint stored");
    expect((await c.query("select private.organization_limit($1, 'limits.security.signin_attempts_per_email_hour') v", [world.orgA.id])).rows[0].v).toBe(5);
    const admin = (await call("select public.get_admin_organization_configuration() c", [], world.a)).rows[0].c;
    expect(admin.settings.find((item) => item.key === "limits.security.signin_attempts_per_email_hour"))
      .toMatchObject({ organizationEditable: false, value: 5, overridden: false });
    const service = (await call("select public.get_organization_settings_for_service($1, array['limits.security.signin_attempts_per_email_hour']) r", [world.orgA.id])).rows[0].r;
    expect(service).toEqual({ "limits.security.signin_attempts_per_email_hour": 5 });
  });

  it("lets an organization admin turn a provider off and request it again without touching its other fields", async () => {
    await c.query(`insert into public.organization_integrations
      (organization_id, provider, status, allow_chapter_overrides, allowed_chapter_override_keys, default_settings, credential_ref)
      values ($1, 'twilio', 'connected', true, array['fromNumber'], '{"region":"us"}', 'vault:twilio-proof')`, [world.orgA.id]);
    const off = await call("select public.set_organization_integration_status('twilio', 'disabled') r", [], world.a);
    expect(off).toMatchObject({ ok: true });
    const row = (await c.query("select status, allow_chapter_overrides, allowed_chapter_override_keys, default_settings, credential_ref from public.organization_integrations where organization_id = $1 and provider = 'twilio'", [world.orgA.id])).rows[0];
    expect(row).toEqual({ status: "disabled", allow_chapter_overrides: true, allowed_chapter_override_keys: ["fromNumber"], default_settings: { region: "us" }, credential_ref: "vault:twilio-proof" });
    expect(await call("select public.set_organization_integration_status('twilio', 'requested')", [], world.a)).toMatchObject({ ok: true });
    expect(await call("select public.set_organization_integration_status('twilio', 'connected')", [], world.a)).toMatchObject({ ok: false, code: "22023" });
    expect(await call("select public.set_organization_integration_status('constant_contact', 'disabled')", [], world.a)).toMatchObject({ ok: false, code: "P0002" });
    expect(await call("select public.set_organization_integration_status('twilio', 'disabled')", [], world.steward)).toMatchObject({ ok: false, code: "42501" });
    // Organization B's admin cannot reach organization A's provider.
    expect(await call("select public.set_organization_integration_status('twilio', 'disabled')", [], world.b)).toMatchObject({ ok: false, code: "P0002" });
    expect((await c.query("select status from public.organization_integrations where organization_id = $1 and provider = 'twilio'", [world.orgA.id])).rows[0].status).toBe("requested");
  });

  it("refuses Compass for an organization that turned it off and applies its role caps under the platform limit", async () => {
    await call("select public.set_compass_platform_operator($1,true,'Disposable inventory proof')", [world.a.id]);
    await c.query("update public.compass_ai_policy set enabled=true, gateway=$1, model=$2 where id", [mesh, model]);
    await c.query("insert into public.compass_ai_provider_attestations(status,gateway,model,zero_data_retention,disallow_prompt_training,evidence_ref,expires_at,attested_by) values ('verified',$1,$2,true,true,$3,now()+interval '1 day',$4)", [mesh, model, `sha256:${"b".repeat(64)}`, world.a.id]);
    const reserve = async (user) => (await call("select public.reserve_compass_ai_request($1,$2,$3,true,true) r", [user.id, mesh, model])).rows[0].r;

    // Default: on, as Compass works today under the platform policy alone.
    const first = await reserve(world.a);
    expect(first).toMatchObject({ id: expect.any(String), cause: null, role: "admin" });
    // Organization B turns Compass off; organization A stays on.
    await c.query("insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,'features.ai_assistant.enabled','false')", [world.orgB.id]);
    expect(await reserve(world.b)).toEqual({ id: null, cause: "disabled" });

    // An organization cap lowers the limit; it can never raise the platform's.
    await c.query("insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,'limits.ai_assistant.hourly_admin','1')", [world.orgA.id]);
    expect(await reserve(world.a)).toMatchObject({ id: null, cause: "role", role: "admin", limit: 1 });
    // The platform kill switch still wins over an organization that is on.
    await c.query("update public.compass_ai_policy set enabled=false where id");
    expect(await reserve(world.steward)).toEqual({ id: null, cause: "disabled" });
  });

  it("plans dues reminders unless the organization turned them off, after its delay", async () => {
    const batch = randomUUID();
    const subject = randomUUID();
    const obligation = randomUUID();
    await c.query("insert into public.dues_member_subjects(id, organization_id, user_id) values ($1, $2, $3) on conflict (organization_id, user_id) do nothing", [subject, world.orgA.id, world.steward.id]);
    const subjectId = (await c.query("select id from public.dues_member_subjects where organization_id = $1 and user_id = $2", [world.orgA.id, world.steward.id])).rows[0].id;
    await c.query(`insert into public.dues_assessment_batches(id, organization_id, title, scope_kind, amount_cents, due_on, eligibility_fingerprint, idempotency_key, created_by)
      values ($1, $2, 'Inventory proof dues', 'organization', 2500, current_date - 3, $3, $4, $5)`, [batch, world.orgA.id, "c".repeat(64), `inventory-proof-${batch}`, world.a.id]);
    await c.query("insert into public.dues_obligations(id, organization_id, batch_id, member_subject_id, issued_cents, due_on) values ($1, $2, $3, $4, 2500, current_date - 3)", [obligation, world.orgA.id, batch, subjectId]);
    const plan = async () => (await call("select public.plan_dues_reminder_attempts(500, current_date) n")).rows[0].n;
    const planned = async () => Number((await c.query("select count(*) n from public.dues_reminder_attempts where obligation_id = $1", [obligation])).rows[0].n);

    const setting = (key, value) => c.query(`insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,$2,$3)
      on conflict (organization_id, setting_key) do update set value = excluded.value`, [world.orgA.id, key, value]);

    // Turned off: nothing is planned.
    await setting("features.notifications.dues_reminders", "false");
    await plan();
    expect(await planned()).toBe(0);
    // On, but three days past due is inside a five-day delay.
    await setting("features.notifications.dues_reminders", "true");
    await setting("limits.notifications.dues_reminder_days_past_due", "5");
    await plan();
    expect(await planned()).toBe(0);
    // Defaults (on, one day past due) plan it, as the planner did before the switch.
    await c.query("delete from public.organization_setting_values where organization_id = $1 and setting_key in ('features.notifications.dues_reminders', 'limits.notifications.dues_reminder_days_past_due')", [world.orgA.id]);
    await plan();
    expect(await planned()).toBe(1);
  });
});
