// @vitest-environment node
//
// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001
// REQ-UG-CONFIGURABLE-THRESHOLDS-20261001
//
// Offline half: the pinned registry contract other lanes code against.
// Live half (disposable loopback only): defaults, organization overrides,
// bounds, admin-only writes, tenant isolation, audit values, the optimistic
// version check, the member-safe projection, the service read, the management
// behavior category migration and the configurable due-soon lookahead.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";

const MIGRATION = "supabase/migrations/20261002017000_feature_switches_and_limits.sql";
const sql = readFileSync(MIGRATION, "utf8");
const code = stripComments(sql).replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");

const CATEGORIES = [
  "general", "security", "engagement_voice", "guidance_onboarding", "home",
  "casework", "intelligence", "automation", "messaging", "governance",
  "integrations", "ai_assistant", "notifications", "data_retention",
  "analytics", "labels",
];
const HELPERS = [
  ["private.organization_feature_enabled", "boolean"],
  ["private.organization_limit", "integer"],
  ["private.organization_setting_text", "text"],
  ["private.organization_setting_text_list", "text[]"],
];

describe("feature switches registry contract (offline)", () => {
  it("is one atomic migration", () => {
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("adds the pinned columns, category list and text_list kind", () => {
    expect(code).toContain("add column category text not null default 'general'");
    expect(code).toContain("add column member_visible boolean not null default false");
    expect(code).toContain(`check (category in (${CATEGORIES.map((item) => `'${item}'`).join(", ")}))`);
    expect(code).toContain("check (value_kind in ('boolean', 'integer', 'text', 'text_list'))");
    expect(code).toContain("pg_catalog.jsonb_array_length(p_value) > 50");
    expect(code).toContain("pg_catalog.char_length(item) not between 1 and 80");
  });

  it("declares the four helpers with the pinned signatures, definer, empty search path, revoked", () => {
    for (const [name, returns] of HELPERS) {
      expect(code).toContain(`create function ${name}(p_organization_id uuid, p_key text) returns ${returns} language plpgsql stable security definer set search_path = ''`);
      expect(code).toContain(`revoke all on function ${name}(uuid, text) from public, anon, authenticated, service_role;`);
    }
    expect(code).toContain("raise exception 'unknown organization setting: %', p_key using errcode = '22023'");
  });

  it("keeps every writer behind the case-graph gate and admin role", () => {
    const functions = parseFunctions(sql);
    for (const name of ["private.write_organization_setting", "public.set_organization_setting", "public.reset_organization_setting", "public.update_organization_setting", "public.casework_log_management_behavior"]) {
      const fn = functions.find((entry) => entry.name === name);
      expect(fn, name).toBeDefined();
      expect(helperFirst(fn.source), name).toBe(true);
    }
    expect(code).toContain("if org_id is null or not private.has_organization_role(org_id, array['admin']) then raise exception 'admin role required' using errcode = '42501'");
    expect(code).toContain("grant execute on function public.get_organization_settings_for_service(uuid, text[]) to service_role;");
    expect(code).not.toMatch(/grant execute on function public\.get_organization_settings_for_service[^;]*authenticated/);
    expect(code).not.toMatch(/grant (select|insert|update|delete|all)[^;]* on (table )?public\.(platform_setting_definitions|organization_setting_values|organization_configuration_audit)/i);
  });

  it("seeds record 2 thresholds with the old app's defaults", () => {
    for (const [key, value] of [
      ["limits.casework.deadline_red_days", "'5'"],
      ["limits.casework.deadline_amber_days", "'14'"],
      ["limits.casework.deadline_risk_critical_days", "'0'"],
      ["limits.casework.deadline_risk_high_days", "'7'"],
      ["limits.casework.deadline_risk_medium_days", "'14'"],
      ["limits.casework.deadline_lookahead_days", "'7'"],
      ["limits.casework.management_behavior_window_days", "'90'"],
      ["limits.analytics.health_critical_max", "'24'"],
      ["limits.analytics.health_concerning_max", "'44'"],
      ["limits.analytics.health_moderate_max", "'64'"],
      ["limits.analytics.health_healthy_max", "'84'"],
    ]) {
      const row = code.slice(code.indexOf(`('${key}'`));
      expect(row.slice(0, 400), key).toContain(value);
    }
    expect(code).toContain(`'["Verbal threat","Intimidation","Policy change (unilateral)","Weingarten denial","Retaliation","Discrimination","Other"]'`);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

// [name, organization roles, home organization]
const ACTORS = [
  ["adminA", ["admin"], "orgA"],
  ["stewardA", ["steward"], "orgA"],
  ["memberA", [], "orgA"],
  ["adminB", ["admin"], "orgB"],
  ["memberB", [], "orgB"],
];

live("the live feature switches registry", () => {
  let client;
  const ids = Object.fromEntries(["orgA", "orgB", "caseA", "deadlineSoon", "deadlineLater", ...ACTORS.flatMap(([name]) => [name, `${name}Session`])]
    .map((key) => [key, randomUUID()]));
  const chapter = { orgA: `switches-a-${ids.orgA.slice(0, 8)}`, orgB: `switches-b-${ids.orgB.slice(0, 8)}` };
  let savepoint = 0;

  async function as(name, role = "authenticated") {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(
      role === "service_role" ? { role } : { sub: ids[name], role, session_id: ids[`${name}Session`], aal: "aal2" },
    )]);
    await client.query(`set local role ${role}`);
  }

  async function attempt(text, values = []) {
    const label = `switches_${++savepoint}`;
    await client.query(`savepoint ${label}`);
    try {
      const { rows } = await client.query(text, values);
      await client.query(`release savepoint ${label}`);
      return { ok: true, rows, code: null };
    } catch (error) {
      await client.query(`rollback to savepoint ${label}`);
      await client.query(`release savepoint ${label}`);
      return { ok: false, rows: [], code: error.code, message: error.message };
    }
  }

  async function asPostgres(text, values = []) {
    await client.query("reset role");
    return (await client.query(text, values)).rows;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "feature-switches-and-limits-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    for (const [name] of ACTORS) {
      await client.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, '{}')", [ids[name], `${ids[name]}@example.invalid`]);
    }
    for (const [org, owner] of [["orgA", "adminA"], ["orgB", "adminB"]]) {
      await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [ids[org], chapter[org], ids[owner]]);
      await client.query(
        "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9907)",
        [chapter[org], ids[org]],
      );
      await client.query("insert into public.org_security_policy (id, organization_id, require_staff_mfa) values (true, $1, true)", [ids[org]]);
    }
    for (const [name, orgRoles, org] of ACTORS) {
      const user = ids[name];
      await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [ids[`${name}Session`], user]);
      await client.query(
        "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Switches factor', 'totp', 'verified', now(), now())",
        [randomUUID(), user],
      );
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [ids[org], user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter[org]]);
      await client.query("update public.member_profiles set chapter_id = $2, full_name = $3 where id = $1", [user, chapter[org], `Proof ${name}`]);
      for (const role of orgRoles) {
        await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, $3, $2)", [ids[org], user, role]);
        await client.query("insert into public.member_roles (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter[org]]);
        await client.query("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, $2, $3) on conflict do nothing", [user, role, chapter[org]]);
      }
    }
    await client.query(
      `insert into public.member_cases(id,user_id,reference,title,case_type,step,status,steward_user_id)
       values($1,$2,'SW-PROOF-1','Switches proof case','other','Intake','active',$3)`,
      [ids.caseA, ids.memberA, ids.stewardA],
    );
  }, 60_000);

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("installs the helpers as postgres-owned definers no client role can execute", async () => {
    const rows = await asPostgres(
      `select p.oid::regprocedure::text signature, p.prosecdef, r.rolname owner,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
         has_function_privilege('anon', p.oid, 'EXECUTE') anon,
         has_function_privilege('service_role', p.oid, 'EXECUTE') service_role
       from pg_catalog.pg_proc p join pg_catalog.pg_roles r on r.oid = p.proowner
       where p.oid = any($1::regprocedure[]) order by 1`,
      [HELPERS.map(([name]) => `${name}(uuid,text)`)],
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ prosecdef: true, owner: "postgres", authenticated: false, anon: false, service_role: false });
  });

  it("returns definition defaults, refuses unknown keys and kind mismatches", async () => {
    const [row] = await asPostgres(
      `select private.organization_feature_enabled($1, 'features.passkey_enrollment') passkey,
              private.organization_limit($1, 'limits.casework.deadline_red_days') red,
              private.organization_limit(null, 'limits.casework.deadline_amber_days') amber_null_org,
              private.organization_setting_text_list($1, 'lists.casework.management_behavior_categories') categories`,
      [ids.orgA],
    );
    expect(row).toEqual({
      passkey: true, red: 5, amber_null_org: 14,
      categories: ["Verbal threat", "Intimidation", "Policy change (unilateral)", "Weingarten denial", "Retaliation", "Discrimination", "Other"],
    });
    expect(await attempt("select private.organization_limit($1, 'limits.casework.no_such_key')", [ids.orgA])).toMatchObject({ ok: false, code: "22023" });
    expect(await attempt("select private.organization_feature_enabled($1, 'limits.casework.deadline_red_days')", [ids.orgA])).toMatchObject({ ok: false, code: "22023" });
    expect(await attempt("select private.organization_setting_text($1, 'features.passkey_enrollment')", [ids.orgA])).toMatchObject({ ok: false, code: "22023" });
  });

  it("accepts a lane definition with the pinned insert and refuses an invalid default", async () => {
    await client.query("reset role");
    const insert = `insert into public.platform_setting_definitions
      (key, value_kind, label, description, default_value, minimum, maximum, allowed_values, sort_order, category, member_visible)
      values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::text[], 10, $9, $10) on conflict (key) do nothing`;
    expect(await attempt(insert, ["limits.proof.mode", "text", "Proof mode", "Enum proof", '"steady"', null, null, ["steady", "fast"], "general", true])).toMatchObject({ ok: true });
    expect(await attempt(insert, ["limits.proof.mode", "text", "Proof mode", "Enum proof", '"steady"', null, null, ["steady", "fast"], "general", true])).toMatchObject({ ok: true });
    expect(await attempt(insert, ["features.proof.toggle", "boolean", "Proof toggle", "Toggle proof", "false", null, null, null, "engagement_voice", true])).toMatchObject({ ok: true });
    expect(await attempt(insert, ["limits.proof.bad_default", "integer", "Bad default", "Out of bounds", "500", 1, 10, null, "general", false])).toMatchObject({ ok: false, code: "23514" });
    expect(await attempt(insert, ["limits.proof.bad_category", "integer", "Bad category", "Unknown group", "5", 1, 10, null, "nonsense", false])).toMatchObject({ ok: false, code: "23514" });
    expect(await attempt(insert, ["lists.proof.bad_list", "text_list", "Bad list", "Duplicates", '["a","A"]', null, null, null, "general", false])).toMatchObject({ ok: false, code: "23514" });
  });

  it("lets an organization admin set, version-check, reset and audit a setting", async () => {
    await as("adminA");
    const before = (await client.query("select public.get_admin_organization_configuration() c")).rows[0].c;
    const red = before.settings.find((item) => item.key === "limits.casework.deadline_red_days");
    expect(red).toMatchObject({ category: "casework", memberVisible: true, value: 5, defaultValue: 5, overridden: false, updatedAt: null, lastChange: null });
    expect(before.categories).toEqual(CATEGORIES);

    const saved = (await client.query("select public.set_organization_setting('limits.casework.deadline_red_days', '3'::jsonb, null) r")).rows[0].r;
    expect(saved).toMatchObject({ key: "limits.casework.deadline_red_days", value: 3, overridden: true, updated: true });
    expect(await attempt("select public.set_organization_setting('limits.casework.deadline_red_days', '4'::jsonb, null)")).toMatchObject({ ok: false, code: "PT409" });
    const versioned = await attempt("select public.set_organization_setting('limits.casework.deadline_red_days', '4'::jsonb, $1::timestamptz) r", [saved.updatedAt]);
    expect(versioned).toMatchObject({ ok: true });
    const current = versioned.rows[0].r;

    const after = (await client.query("select public.get_admin_organization_configuration() c")).rows[0].c
      .settings.find((item) => item.key === "limits.casework.deadline_red_days");
    expect(after).toMatchObject({ value: 4, overridden: true, updatedAt: current.updatedAt, lastChange: { action: "setting_updated", actorName: "Proof adminA" } });

    expect(await attempt("select public.reset_organization_setting('limits.casework.deadline_red_days', $1::timestamptz)", [saved.updatedAt])).toMatchObject({ ok: false, code: "PT409" });
    const reset = (await client.query("select public.reset_organization_setting('limits.casework.deadline_red_days', $1::timestamptz) r", [current.updatedAt])).rows[0].r;
    expect(reset).toMatchObject({ value: 5, overridden: false, updatedAt: null });

    const audit = (await client.query("select public.list_organization_configuration_audit('limits.casework.deadline_red_days', 10) a")).rows[0].a.items;
    expect(audit.map(({ action, previousValue, newValue, actorName }) => ({ action, previousValue, newValue, actorName }))).toEqual([
      { action: "setting_reset", previousValue: 4, newValue: 5, actorName: "Proof adminA" },
      { action: "setting_updated", previousValue: 3, newValue: 4, actorName: "Proof adminA" },
      { action: "setting_updated", previousValue: 5, newValue: 3, actorName: "Proof adminA" },
    ]);

    // The original RPC keeps its signature and shape, and is audited with values.
    const legacy = (await client.query("select public.update_organization_setting('security.failed_login_alert_threshold', '9'::jsonb) r")).rows[0].r;
    expect(legacy).toEqual({ key: "security.failed_login_alert_threshold", value: 9, updated: true });
    const legacyAudit = (await client.query("select public.list_organization_configuration_audit('security.failed_login_alert_threshold', 1) a")).rows[0].a.items[0];
    expect(legacyAudit).toMatchObject({ action: "setting_updated", previousValue: 5, newValue: 9 });
  });

  it("rejects out-of-bounds, malformed list and enum values", async () => {
    await as("adminA");
    const set = "select public.set_organization_setting($1, $2::jsonb, null)";
    for (const [key, value] of [
      ["limits.casework.deadline_red_days", "91"],
      ["limits.casework.deadline_red_days", "-1"],
      ["limits.casework.deadline_red_days", "2.5"],
      ["limits.casework.deadline_red_days", '"5"'],
      ["limits.casework.deadline_lookahead_days", "99999999999"],
      ["lists.casework.management_behavior_categories", "[]"],
      ["lists.casework.management_behavior_categories", '["Same","same"]'],
      ["lists.casework.management_behavior_categories", '[" padded"]'],
      ["lists.casework.management_behavior_categories", '["<b>bold</b>"]'],
      ["lists.casework.management_behavior_categories", '[1, 2]'],
      ["lists.casework.management_behavior_categories", JSON.stringify(["x".repeat(81)])],
      ["lists.casework.management_behavior_categories", JSON.stringify(Array.from({ length: 51 }, (_, index) => `Item ${index}`))],
      ["features.passkey_enrollment", '"yes"'],
      ["limits.proof.mode", '"slow"'],
      ["no.such.key", "1"],
    ]) {
      expect(await attempt(set, [key, value]), `${key}=${value}`).toMatchObject({ ok: false, code: "22023" });
    }
    expect(await attempt(set, ["limits.proof.mode", '"fast"'])).toMatchObject({ ok: true });
    expect(await attempt(set, ["lists.casework.management_behavior_categories", JSON.stringify(Array.from({ length: 50 }, (_, index) => `Item ${index}`))])).toMatchObject({ ok: true });
    expect(await attempt("select public.set_organization_setting('features.passkey_enrollment', null, null)")).toMatchObject({ ok: false, code: "22023" });
  });

  it("refuses every non-admin and keeps each tenant's values apart", async () => {
    for (const name of ["stewardA", "memberA"]) {
      await as(name);
      expect(await attempt("select public.set_organization_setting('limits.casework.deadline_amber_days', '20'::jsonb, null)"), name).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt("select public.reset_organization_setting('limits.casework.deadline_amber_days', null)"), name).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt("select public.update_organization_setting('limits.casework.deadline_amber_days', '20'::jsonb)"), name).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt("select public.get_admin_organization_configuration()"), name).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt("select public.list_organization_configuration_audit(null, 10)"), name).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt("select public.get_organization_settings_for_service($1, array['limits.casework.deadline_amber_days'])", [ids.orgA]), name).toMatchObject({ ok: false, code: "42501" });
      expect(await attempt("select private.organization_limit($1, 'limits.casework.deadline_amber_days')", [ids.orgA]), name).toMatchObject({ ok: false, code: "42501" });
    }

    await as("adminB");
    await client.query("select public.set_organization_setting('limits.casework.deadline_amber_days', '30'::jsonb, null)");
    const bAudit = (await client.query("select public.list_organization_configuration_audit(null, 100) a")).rows[0].a.items;
    expect(bAudit.every((item) => item.key === "limits.casework.deadline_amber_days")).toBe(true);
    const bAdmin = (await client.query("select public.get_admin_organization_configuration() c")).rows[0].c;
    expect(bAdmin.organizationId).toBe(ids.orgB);
    expect(bAdmin.settings.find((item) => item.key === "limits.proof.mode").value).toBe("steady");

    const [values] = await asPostgres(
      "select private.organization_limit($1, 'limits.casework.deadline_amber_days') a, private.organization_limit($2, 'limits.casework.deadline_amber_days') b",
      [ids.orgA, ids.orgB],
    );
    expect(values).toEqual({ a: 14, b: 30 });

    await as("memberA");
    const memberA = (await client.query("select public.get_member_organization_configuration() c")).rows[0].c;
    await as("memberB");
    const memberB = (await client.query("select public.get_member_organization_configuration() c")).rows[0].c;
    expect(memberA.switches["limits.casework.deadline_amber_days"]).toBe(14);
    expect(memberB.switches["limits.casework.deadline_amber_days"]).toBe(30);
    expect(memberA.switches["limits.proof.mode"]).toBe("fast");
    expect(memberB.switches["limits.proof.mode"]).toBe("steady");
    // Existing fields are unchanged and admin-only definitions stay out.
    expect(memberA).toMatchObject({ available: true, organizationId: ids.orgA, passkeyEnrollmentEnabled: true, recoveryCodeEnrollmentEnabled: true, labelOverrides: {} });
    expect(memberA.switches["features.passkey_enrollment"]).toBe(true);
    expect(memberA.switches["features.proof.toggle"]).toBe(false);
    expect(Object.keys(memberA.switches).some((key) => key.startsWith("security."))).toBe(false);
  });

  it("serves exact keys to the service role only, for an existing organization", async () => {
    await as(null, "service_role");
    const result = (await client.query(
      "select public.get_organization_settings_for_service($1, array['limits.casework.deadline_amber_days','features.passkey_enrollment']) r",
      [ids.orgB],
    )).rows[0].r;
    expect(result).toEqual({ "limits.casework.deadline_amber_days": 30, "features.passkey_enrollment": true });
    expect(await attempt("select public.get_organization_settings_for_service($1, array['no.such.key'])", [ids.orgB])).toMatchObject({ ok: false, code: "22023" });
    expect(await attempt("select public.get_organization_settings_for_service($1, array['features.passkey_enrollment'])", [randomUUID()])).toMatchObject({ ok: false, code: "P0002" });
  });

  it("keeps legacy management categories valid and enforces the organization list for new entries", async () => {
    await client.query("reset role");
    // A pre-migration row with one of the six original tokens remains valid.
    const person = (await client.query(
      "insert into public.casework_management_people(organization_id, chapter_id, display_name, created_by) values ($1, $2, 'Legacy Manager', $3) returning id",
      [ids.orgA, chapter.orgA, ids.adminA],
    )).rows[0].id;
    expect(await attempt(
      "insert into public.casework_management_entries(management_person_id, case_id, organization_id, chapter_id, occurred_at, category, summary, created_by) values ($1, $2, $3, $4, now(), 'discipline', 'A legacy observation recorded before categories became editable.', $5)",
      [person, ids.caseA, ids.orgA, chapter.orgA, ids.adminA],
    )).toMatchObject({ ok: true });
    expect(await attempt(
      "insert into public.casework_management_entries(management_person_id, case_id, organization_id, chapter_id, occurred_at, category, summary, created_by) values ($1, $2, $3, $4, now(), ' padded', 'An observation whose category is not trimmed text.', $5)",
      [person, ids.caseA, ids.orgA, chapter.orgA, ids.adminA],
    )).toMatchObject({ ok: false, code: "23514" });

    await as("adminA");
    const log = "select category from public.casework_log_management_behavior($1, 'Manager Proof', null, null, now(), $2, 'The manager denied a representation request during a meeting.')";
    expect(await attempt(log, [ids.caseA, "Item 3"])).toMatchObject({ ok: true, rows: [{ category: "Item 3" }] });
    expect(await attempt(log, [ids.caseA, "Weingarten denial"])).toMatchObject({ ok: false, code: "22023" });
    // The admin has no table access; the admin read carries the version token.
    const token = (await client.query("select public.get_admin_organization_configuration() c")).rows[0].c
      .settings.find((item) => item.key === "lists.casework.management_behavior_categories").updatedAt;
    await client.query("select public.reset_organization_setting('lists.casework.management_behavior_categories', $1::timestamptz)", [token]);
    expect(await attempt(log, [ids.caseA, "Weingarten denial"])).toMatchObject({ ok: true, rows: [{ category: "Weingarten denial" }] });
    expect(await attempt(log, [ids.caseA, "discipline"])).toMatchObject({ ok: false, code: "22023" });
  });

  it("looks ahead the organization's configured number of days on the due-soon tile", async () => {
    await client.query("reset role");
    await client.query(
      `insert into public.casework_deadlines(id, case_id, organization_id, chapter_id, kind, label, due_at, status, created_by)
       values ($1, $3, $4, $5, 'response', 'Soon', now() + interval '3 days 1 hour', 'active', $6),
              ($2, $3, $4, $5, 'response', 'Later', now() + interval '10 days 1 hour', 'active', $6)`,
      [ids.deadlineSoon, ids.deadlineLater, ids.caseA, ids.orgA, chapter.orgA, ids.adminA],
    );
    await as("adminA");
    const buckets = async () => (await client.query("select days_out, deadline_count::int from public.casework_dashboard_deadlines_due_soon() order by days_out")).rows;
    expect(await buckets()).toEqual([{ days_out: 3, deadline_count: 1 }]);
    await client.query("select public.set_organization_setting('limits.casework.deadline_lookahead_days', '14'::jsonb, null)");
    expect(await buckets()).toEqual([{ days_out: 3, deadline_count: 1 }, { days_out: 10, deadline_count: 1 }]);
  });
});
