// @vitest-environment node
//
// REQ-UG-PLATFORM-RELEASE-HOLD-ON-ORGANIZATION-SWITCHES-20261112 (#8436).
//
// Offline half: the migration's pins, and a guard over the whole migration
// chain: every function whose NEWEST definition reads
// public.organization_setting_values or a definition's default_value directly
// must check the hold (release_at) or sit on the reviewed allowlist below with
// a reason. Live half (disposable loopback only): a held switch is off for
// every reader, invisible to the admin list, refused by every writer like an
// unknown key, and back to today's behavior once its release time passes.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { RELEASE_CALENDAR_HELD_KEYS } from "./helpers/release-calendar-holds.js";

const MIGRATION = "supabase/migrations/20261112061000_platform_setting_release_hold.sql";
const sql = readFileSync(MIGRATION, "utf8");
const code = stripComments(sql).replace(/\s+/g, " ");

const CALENDAR_HOLD = "hold_release_calendar_switches";
// The switches the release calendar migration holds (#8579), sorted.
const CALENDAR_KEYS = RELEASE_CALENDAR_HELD_KEYS;
// Every held key on Main: the calendar switches and the two provider buttons (#8483).
const HELD_ON_MAIN = [...CALENDAR_KEYS, "features.identity_providers.apple", "features.identity_providers.google",
  // Held from its creation (REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112, #8581).
  "features.guidance_onboarding.learning_period",
  // Held from its creation (REQ-UG-PER-UNIT-SETTINGS-20261109, #7667).
  "features.governance.per_unit_settings",
  // Held from their creation (REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117, #9038).
  "features.public_pages.sign_in_design_2", "features.public_pages.sign_in_design_3",
  "features.public_pages.sign_in_design_4", "features.public_pages.unions_map_3d",
  // Held with single sign-on (REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117, #9037).
  "features.integrations.scim",
  // Held from its creation (REQ-UG-TIME-ZONES-PER-GROUP-20261122, #9446).
  "features.governance.group_time_zones"].sort();

// Functions whose newest definition reads the stored values or the default
// directly but can never meet a held switch. `pins` must stay in the body, so
// a rewrite that changes what the function reads has to come back here.
const ALLOWLIST = {
  "private.urgent_a_setting_integer": { reason: "integer settings only; only a boolean can be held", pins: ["d.value_kind = 'integer'"] },
  "private.urgent_b_setting_limit": { reason: "integer settings only; refuses any other kind", pins: ["definition.value_kind <> 'integer'"] },
  "private.lock_lifecycle_telemetry": { reason: "reads the integer failed sign-in retention only", pins: ["d.key='security.failed_login_retention_days'"] },
  "public.list_failed_login_operations_inbox": { reason: "reads the integer alert threshold only", pins: ["d.key = 'security.failed_login_alert_threshold'"] },
  "public.record_failed_login_attempt": { reason: "reads the integer failed sign-in retention only", pins: ["d.key = 'security.failed_login_retention_days'"] },
  "public.record_member_pin_failure": { reason: "reads the integer failed sign-in retention only", pins: ["d.key = 'security.failed_login_retention_days'"] },
  "private.demo_seed_apply_auth_operations": { reason: "writes the SAMPLE auth-operations seed rows; no effective read", pins: ["insert into public.organization_setting_values"] },
  "private.demo_seed_auth_operations_status": { reason: "checks the SAMPLE seed rows are stored; no effective read", pins: ["passkey_ready"] },
  "private.demo_seed_remove_auth_operations": { reason: "deletes the SAMPLE seed rows", pins: ["delete from public.organization_setting_values"] },
  "private.learning_membership_state": { reason: "journals the stored row as an Undo before-image; no effective read", pins: ["'overridden', v.organization_id is not null"] },
  "private.production_residue_check_references": { reason: "names the table in the residue reference census", pins: ["'public.organization_setting_values'"] },
  "public.production_residue_remove_batch": { reason: "deletes residue rows of a removed organization", pins: ["delete from public.organization_setting_values r"] },
};

// The held-aware readers this migration re-emits.
const HELD_AWARE = [
  "private.organization_setting_effective",
  "private.organization_member_switches",
  "public.get_admin_organization_configuration",
  "public.get_organization_settings_for_service",
  "private.write_organization_setting",
  "private.learning_undo_organization_setting",
  "private.auto_enroll_member_onboarding",
  "private.urgent_a_setting_enabled",
  "public.generate_mfa_recovery_codes",
];

// Newest body of every function in the chain, keyed by schema.name.
function newestDefinitions() {
  const newest = new Map();
  const declares = /create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z0-9_]+)\s*\(/gi;
  for (const { name, sql: text } of migrationFiles()) {
    const source = stripComments(text);
    for (const match of source.matchAll(declares)) {
      const rest = source.slice(match.index);
      const open = rest.match(/\bas\s+(\$[a-z_]*\$)/i);
      if (!open) throw new Error(`${match[1]} in ${name} has no dollar-quoted body`);
      const start = match.index + open.index + open[0].length;
      const end = source.indexOf(open[1], start);
      if (end === -1) throw new Error(`${match[1]} in ${name} does not terminate`);
      newest.set(match[1].toLowerCase(), { migration: name, body: source.slice(start, end).replace(/\s+/g, " ") });
    }
  }
  return newest;
}

const readsDirectly = (body) => /organization_setting_values|default_value/i.test(body);

describe("release hold migration (offline)", () => {
  it("is one atomic migration that adds a nullable, boolean-only release time and holds nothing", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("alter table public.platform_setting_definitions add column release_at timestamptz;");
    expect(code).toContain("add constraint platform_setting_definitions_release_at_boolean_only check (release_at is null or value_kind = 'boolean');");
    // No row is held here: the dates come in a later data-only migration.
    expect(code).not.toMatch(/update public\.platform_setting_definitions/i);
    expect(code).not.toMatch(/insert into public\.platform_setting_definitions/i);
  });

  it("makes this migration the newest definition of every held-aware reader", () => {
    const newest = newestDefinitions();
    for (const name of HELD_AWARE) {
      const definition = newest.get(name);
      expect(definition?.migration, name).toBe(MIGRATION.split("/").at(-1));
      expect(definition.body, name).toContain("release_at");
    }
  });

  it("refuses a new direct reader of stored values or defaults that skips the hold", () => {
    const newest = newestDefinitions();
    const unguarded = [];
    for (const [name, { migration, body }] of newest) {
      if (!readsDirectly(body) || body.includes("release_at")) continue;
      const allowed = ALLOWLIST[name];
      if (!allowed) {
        unguarded.push(`${name} (${migration})`);
        continue;
      }
      for (const pin of allowed.pins) expect(body, `${name}: ${allowed.reason}`).toContain(pin);
    }
    expect(unguarded, "check release_at, read through private.organization_setting_effective, or add a reviewed allowlist entry").toEqual([]);
  });

  it("keeps the allowlist short and current", () => {
    const newest = newestDefinitions();
    expect(Object.keys(ALLOWLIST).length).toBeLessThanOrEqual(12);
    for (const name of Object.keys(ALLOWLIST)) {
      const definition = newest.get(name);
      expect(definition, `${name} no longer exists; drop its allowlist entry`).toBeTruthy();
      expect(readsDirectly(definition.body) && !definition.body.includes("release_at"), `${name} no longer needs its allowlist entry`).toBe(true);
    }
  });
});

describe("release calendar hold migration (offline)", () => {
  const holdSql = stripComments(loadMigrationSql(CALENDAR_HOLD));
  const block = holdSql.slice(holdSql.indexOf("do $hold$"), holdSql.indexOf("$hold$;") + "$hold$;".length);

  it("is one atomic migration whose one update holds the calendar switches with no date (#8579)", () => {
    expect(findMigrationName(CALENDAR_HOLD)).toMatch(/^\d{14}_hold_release_calendar_switches\.sql$/);
    expect(holdSql.trimStart().startsWith("begin;")).toBe(true);
    expect(holdSql.trimEnd().endsWith("commit;")).toBe(true);
    expect(holdSql.match(/\bupdate public\.platform_setting_definitions\b/g)).toHaveLength(1);
    expect(block.match(/\bupdate\b/g)).toHaveLength(1);
    expect(block).toContain("set release_at = 'infinity'");
    expect([...block.matchAll(/'(features\.[a-z_]+\.[a-z_0-9]+)'/g)].map((match) => match[1])).toEqual(CALENDAR_KEYS);
    expect(block).toContain("and value_kind = 'boolean';");
    // A safety restriction that defaults on: held, it would read off for live PIN sessions.
    expect(holdSql).not.toContain("features.security.member_pin_restricted_sessions");
  });

  it("re-emits only the readers and gates that make held default recipes and single sign-on setup invisible", () => {
    expect([...holdSql.matchAll(/create or replace function ([a-z_]+\.[a-z0-9_]+)\s*\(/gi)].map((match) => match[1])).toEqual([
      "private.automation_v3_definition_visible",
      "public.mi1_get_automation_workspace",
      "public.mi1_get_automation_runs",
      "public.mi1_get_automation_run",
      "private.sso_admin_organization",
      "public.get_sso_control",
    ]);
    expect(holdSql).not.toMatch(/\b(?:drop|alter|insert|delete|truncate)\b|create function|create table/i);
    const recipesHeld = "h.key = 'features.automation.default_recipes' and h.release_at > pg_catalog.now()";
    const ssoHeld = "h.key = 'features.security.sso' and h.release_at > pg_catalog.now()";
    const newest = newestDefinitions();
    for (const name of ["private.automation_v3_definition_visible", "public.mi1_get_automation_workspace"]) {
      expect(newest.get(name).body, name).toContain(recipesHeld);
    }
    for (const name of ["public.mi1_get_automation_runs", "public.mi1_get_automation_run"]) {
      expect(newest.get(name).body.replace(/\s+/g, ""), name).toContain(recipesHeld.replace(/\s+/g, ""));
    }
    for (const name of ["private.sso_admin_organization", "public.get_sso_control"]) expect(newest.get(name).body, name).toContain(ssoHeld);
    expect(newest.get("private.sso_admin_organization").body).toContain("if p_write and exists ( select 1 from public.platform_setting_definitions h");
    expect(newest.get("public.get_sso_control").body).toContain("pg_catalog.jsonb_build_object('organizationId', org, 'released', false)");
  });

  it("refuses to finish unless every calendar switch was held", () => {
    expect(block).toMatch(new RegExp(`get diagnostics held = row_count;\\s+if held <> ${CALENDAR_KEYS.length} then\\s+raise exception 'expected to hold ${CALENDAR_KEYS.length} release calendar switches, held %', held using errcode = '55000';`));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

const DEFAULT_OFF = "features.engagement_voice.bargaining_survey_template";
const DEFAULT_ON = "features.passkey_enrollment";
const RECOVERY = "features.mfa_recovery_code_enrollment";
const AUTO_ENROLL = "features.guidance_onboarding.auto_enroll_onboarding";
const UNKNOWN = "features.release_hold_proof.no_such_switch";

live("release hold on a disposable database", () => {
  let c;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "feature-switches-release-hold-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  const q = async (text, values = []) => (await c.query(text, values)).rows;
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
  // As the definer would call a private helper, with the user's claims.
  async function definer(text, values, user) {
    await c.query("savepoint definer");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" })]);
      const rows = (await c.query(text, values)).rows;
      await c.query("release savepoint definer");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint definer");
      await c.query("release savepoint definer");
      return { ok: false, code: error.code, message: error.message };
    }
  }

  async function person(org) {
    const user = { id: randomUUID(), session: randomUUID(), org };
    await q("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
    await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, user.id]);
    await q("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, org.chapter]);
    await q("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, org.chapter]);
    await q("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org.id, user.id]);
    await q("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2) on conflict do nothing", [user.id, org.chapter]);
    await q("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await q("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    return user;
  }

  // Two organizations, each with one MFA-verified admin, in the open transaction.
  async function world() {
    const w = {};
    for (const label of ["A", "B"]) {
      const org = { id: randomUUID(), chapter: `release-hold-${label.toLowerCase()}-${randomUUID().slice(0, 8)}` };
      await q("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [org.id, org.chapter]);
      await q("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98312)", [org.chapter, org.id]);
      await q("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values (true,$1,true) on conflict do nothing", [org.id]);
      w[`org${label}`] = org;
      w[`admin${label}`] = await person(org);
    }
    return w;
  }
  const hold = (key, at) => q("update public.platform_setting_definitions set release_at = $2 where key = $1", [key, at]);
  const store = (org, key, value) => q("insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,$2,$3::jsonb)", [org.id, key, JSON.stringify(value)]);
  const stored = async (org, key) => (await q("select value from public.organization_setting_values where organization_id=$1 and setting_key=$2", [org.id, key]))[0]?.value ?? null;

  // Every read of one boolean switch for one organization, as each reader reports it.
  async function reads(w, label, key) {
    const org = w[`org${label}`];
    const admin = w[`admin${label}`];
    const member = (await call("select public.get_member_organization_configuration() c", [], admin)).rows[0].c;
    const adminList = (await call("select public.get_admin_organization_configuration() c", [], admin)).rows[0].c;
    const service = (await call("select public.get_organization_settings_for_service($1, array[$2]) r", [org.id, key])).rows[0].r;
    const row = (await q(`select private.organization_setting_effective($1,$2,'boolean') effective,
      private.organization_feature_enabled($1,$2) enabled,
      private.organization_member_switches($1) -> $2 switch,
      private.urgent_a_setting_enabled($1,$2) urgent`, [org.id, key]))[0];
    return {
      effective: row.effective,
      enabled: row.enabled,
      switchMap: row.switch,
      memberMap: member.switches[key],
      urgent: row.urgent,
      service: service[key],
      listed: adminList.settings.some((item) => item.key === key),
      ...(key === DEFAULT_ON ? { memberPasskey: member.passkeyEnrollmentEnabled } : {}),
    };
  }
  const allOff = (extra = {}) => ({ effective: false, enabled: false, switchMap: false, memberMap: false, urgent: false, service: false, listed: false, ...extra });
  const allOn = (value, extra = {}) => ({ effective: value, enabled: value, switchMap: value, memberMap: value, urgent: value, service: value, listed: true, ...extra });

  it("holds exactly the release calendar switches on Main and refuses a release time on anything but a boolean", async () => {
    // The exact list of held keys.
    expect(await q("select key, release_at::text as release_at from public.platform_setting_definitions where release_at is not null order by key")).toEqual([
      ...HELD_ON_MAIN.map((key) => ({ key, release_at: "infinity" })),
    ]);
    await c.query("begin");
    try {
      await expect(c.query("update public.platform_setting_definitions set release_at = 'infinity' where key = 'limits.casework.deadline_red_days'"))
        .rejects.toMatchObject({ code: "23514" });
    } finally {
      await c.query("rollback");
    }
  });

  it("turns a held switch off for every reader and every organization, and refuses it like a key that does not exist", async () => {
    await c.query("begin");
    try {
      // Main holds DEFAULT_OFF (#8579); release it inside this transaction.
      await hold(DEFAULT_OFF, null);
      const w = await world();
      await store(w.orgA, DEFAULT_OFF, true);
      expect(await reads(w, "A", DEFAULT_OFF)).toEqual(allOn(true));
      expect(await reads(w, "B", DEFAULT_OFF)).toEqual(allOn(false));
      // Learning-period Undo, as its check step answers for this administrator.
      const entry = (key) => JSON.stringify({ target_id: `${w.orgA.id}:${key}`, before_image: { overridden: true, value: true } });
      const undo = (key) => definer("select private.learning_undo_organization_setting('check', $1::jsonb) r", [entry(key)], w.adminA);
      expect(await undo(DEFAULT_OFF)).toEqual({ ok: true, rows: [{ r: null }] });

      await hold(DEFAULT_OFF, "infinity");
      await hold(DEFAULT_ON, "infinity");
      expect(await reads(w, "A", DEFAULT_OFF)).toEqual(allOff());
      expect(await reads(w, "B", DEFAULT_OFF)).toEqual(allOff());
      expect(await reads(w, "A", DEFAULT_ON)).toEqual(allOff({ memberPasskey: false }));
      expect(await reads(w, "B", DEFAULT_ON)).toEqual(allOff({ memberPasskey: false }));

      // The three writers refuse a held key with the unknown key's own error.
      const writes = [
        ["select public.set_organization_setting($1, 'true'::jsonb, null)"],
        ["select public.reset_organization_setting($1, null)"],
        ["select public.update_organization_setting($1, 'true'::jsonb)"],
      ];
      for (const [text] of writes) {
        const unknown = await call(text, [UNKNOWN], w.adminA);
        expect(unknown).toMatchObject({ ok: false, code: "22023", message: "invalid setting value" });
        expect(await call(text, [DEFAULT_OFF], w.adminA), text).toEqual(unknown);
        expect(await call(text, [DEFAULT_ON], w.adminB), text).toEqual(unknown);
      }
      // The service read still knows the key (it is real), and answers false.
      expect(await call("select public.get_organization_settings_for_service($1, array[$2]) r", [w.orgA.id, UNKNOWN]))
        .toMatchObject({ ok: false, code: "22023" });
      // The stored organization value is untouched.
      expect(await stored(w.orgA, DEFAULT_OFF)).toBe(true);

      // Undo now refuses the held key exactly as it refuses a missing one.
      const missing = await undo(UNKNOWN);
      expect(missing).toMatchObject({ ok: false, code: "42501", message: "setting is set for the whole platform" });
      expect(await undo(DEFAULT_OFF)).toEqual(missing);
    } finally {
      await c.query("rollback");
    }
  });

  it("does not enroll a new member or issue recovery codes while those switches are held", async () => {
    await c.query("begin");
    try {
      const w = await world();
      await q(`insert into public.organization_onboarding_steps (id, organization_id, title, position, active)
        values ($1, $2, 'Step 1', 10, true)`, [randomUUID(), w.orgA.id]);
      const join = async () => {
        const id = randomUUID();
        await q("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
        await q("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [w.orgA.id, id]);
        return (await q("select count(*)::int n from public.member_onboarding_plans where organization_id=$1 and member_user_id=$2", [w.orgA.id, id]))[0].n;
      };
      const codes = () => call("select public.generate_mfa_recovery_codes() r", [], w.adminA);

      await hold(AUTO_ENROLL, "infinity");
      await hold(RECOVERY, "infinity");
      expect(await join()).toBe(0);
      expect(await codes()).toMatchObject({ ok: false, code: "42501", message: "recovery code enrollment disabled" });

      await hold(AUTO_ENROLL, null);
      await hold(RECOVERY, null);
      expect(await join()).toBe(1);
      const issued = await codes();
      expect(issued.ok).toBe(true);
      expect(issued.rows[0].r.codes).toHaveLength(8);
    } finally {
      await c.query("rollback");
    }
  }, 30_000);

  it("releases on its own when the release time passes, with no change to the row", async () => {
    // One release time, read in two transactions: the first starts before it,
    // the second after it. Nothing is written between them.
    const releaseAt = (await q("select (clock_timestamp() + interval '1500 milliseconds')::text t"))[0].t;
    const phase = async () => {
      await c.query("begin");
      try {
        const w = await world();
        await store(w.orgB, DEFAULT_ON, false);
        await store(w.orgA, DEFAULT_OFF, true);
        await hold(DEFAULT_ON, releaseAt);
        await hold(DEFAULT_OFF, releaseAt);
        const set = await call("select public.set_organization_setting($1, 'false'::jsonb, null) r", [DEFAULT_OFF], w.adminB);
        return {
          on: { A: await reads(w, "A", DEFAULT_ON), B: await reads(w, "B", DEFAULT_ON) },
          off: { A: await reads(w, "A", DEFAULT_OFF), B: await reads(w, "B", DEFAULT_OFF) },
          set: set.ok ? "written" : set.message,
        };
      } finally {
        await c.query("rollback");
      }
    };
    const held = await phase();
    expect(held).toEqual({
      on: { A: allOff({ memberPasskey: false }), B: allOff({ memberPasskey: false }) },
      off: { A: allOff(), B: allOff() },
      set: "invalid setting value",
    });
    await new Promise((resolve) => { setTimeout(resolve, 1700); });
    const released = await phase();
    expect(released).toEqual({
      // Organization A keeps the default (on); B keeps its stored off.
      on: { A: allOn(true, { memberPasskey: true }), B: allOn(false, { memberPasskey: false }) },
      // Organization A keeps its stored on; B keeps the default (off) and may now write it.
      off: { A: allOn(true), B: allOn(false) },
      set: "written",
    });
  }, 30_000);
});
