// @vitest-environment node
//
// REQ-UG-AUTOMATION-RECIPE-DEFAULTS-20261001 (CR-108)
//
// The old app shipped four automation recipes switched on
// (de7df4b57c^:lib/crm/automation-recipes.ts:47-54), ran them daily, and routed
// an in-app notice through alert_routing_rules (0529). 20261003030000 restores
// them inside the CR-108 engine: default definitions seeded once per
// organization behind features.automation.default_recipes, a
// stale_member_contact trigger, and organization routing rules behind
// features.automation.alert_routing. The static half pins the migration's
// shape; the live half runs the real hourly dispatcher with no JWT, as
// pg_cron does, on a disposable database inside one rolled-back transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const MIGRATION = "supabase/migrations/20261003030000_automation_recipe_defaults.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");

describe("automation recipe defaults (static)", () => {
  it("registers both switches default ON with old-app citations", () => {
    expect(migration).toContain("('features.automation.default_recipes', 'boolean', 'Default automation recipes',");
    expect(migration).toContain("('features.automation.alert_routing', 'boolean', 'Automation alert routing',");
    expect(migration).toContain("0577_automation_safety.sql:96-104");
    expect(migration).toContain("0529_alert_routing_rules.sql:105-139");
    expect(migration.match(/'true', null, null, null, \d+, 'automation', false\)/g)).toHaveLength(2);
  });

  it("guards every re-declared engine function behind a reviewed predecessor digest", () => {
    const guard = migration.slice(migration.indexOf("do $predecessor$"), migration.indexOf("$predecessor$;"));
    for (const signature of [
      "private.automation_v2_candidates(uuid, boolean)",
      "private.automation_v2_validate(uuid, jsonb)",
      "private.automation_v2_execute(uuid)",
      "private.run_due_organization_automations(integer)",
      "private.automation_v3_definition_json(public.organization_automation_definitions, uuid, uuid, boolean)",
      "public.mi1_get_automation_workspace()",
    ]) expect(guard).toMatch(new RegExp(`\\('${signature.replace(/[().]/g, "\\$&")}', '[0-9a-f]{64}'\\)`));
    expect(migration.indexOf("do $predecessor$")).toBeLessThan(migration.indexOf("create or replace function"));
  });

  it("offers inactive drafts only after an admin action and keeps execution under a live approver", () => {
    expect(migration).toContain("add column provenance text not null default 'organization'");
    expect(migration).toContain("'draft', null, null, recipe.recipe_key, 'system', null, null");
    expect(migration).toContain("private.automation_v3_require_approver() = new.organization_id");
    expect(migration).not.toContain("automation_seed_due_default_recipes");
    expect(migration).not.toContain("r.initiated_by is null and d.updated_by is null and d.recipe_key is not null");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("automation recipe defaults on a disposable database", () => {
  let db;
  const f = {
    org: randomUUID(), otherOrg: randomUUID(),
    admin: randomUUID(), coordinator: randomUUID(), steward: randomUUID(),
    quiet: randomUUID(), contacted: randomUUID(), restricted: randomUUID(), otherAdmin: randomUUID(),
  };
  f.chapter = `recipe-defaults-${f.org.slice(0, 8)}`;
  f.otherChapter = `recipe-defaults-${f.otherOrg.slice(0, 8)}`;
  f.overdueTask = randomUUID();
  f.quietCase = randomUUID(); f.contactedCase = randomUUID(); f.restrictedCase = randomUUID();
  const sessions = new Map();

  async function as(userId, statement, values = []) {
    await db.query("savepoint recipe_defaults");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessions.get(userId), aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(statement, values);
      await db.query("reset role");
      await db.query("release savepoint recipe_defaults");
      return { code: "", rows: result.rows, message: "" };
    } catch (error) {
      await db.query("rollback to savepoint recipe_defaults");
      await db.query("reset role").catch(() => {});
      return { code: error.code || "?", rows: [], message: error.message || "" };
    }
  }
  async function ok(userId, statement, values = []) {
    const result = await as(userId, statement, values);
    expect(result, result.message).toMatchObject({ code: "" });
    return result.rows[0]?.v;
  }
  async function asCron(statement, values = []) {
    await db.query("select set_config('request.jwt.claims','',true)");
    return db.query(statement, values);
  }
  async function recipes(org = f.org) {
    return (await db.query(
      "select recipe_key, name, trigger_kind, threshold_days, task_priority, status, review_status, review_version, version, updated_by from public.organization_automation_definitions where organization_id=$1 and recipe_key is not null order by recipe_key",
      [org],
    )).rows;
  }
  async function setSwitch(org, key, value) {
    await db.query(
      "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value=excluded.value",
      [org, key, JSON.stringify(value)],
    );
  }
  async function tick() {
    await db.query("update public.organization_automation_definitions set next_run_at = now() - interval '1 minute' where organization_id = any($1::uuid[]) and status='active'", [[f.org, f.otherOrg]]);
    await asCron("select private.run_due_organization_automations(50)");
  }
  async function effects() {
    return (await db.query(
      "select d.recipe_key, e.source_kind, e.source_id, e.status, e.task_id from public.organization_automation_effects e join public.organization_automation_definitions d on d.id=e.definition_id where e.organization_id=$1 order by d.recipe_key, e.source_id",
      [f.org],
    )).rows;
  }
  async function notices(userId) {
    return (await db.query(
      "select title, kind from public.member_notifications where user_id=$1 and title in ('An automation needs your attention','Una automatización necesita tu atención')",
      [userId],
    )).rows;
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "automation-recipe-defaults-proof" });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout = '120s'");
    await db.query("set local lock_timeout = '15s'");
    const people = [f.admin, f.coordinator, f.steward, f.quiet, f.contacted, f.restricted, f.otherAdmin];
    for (const id of people) await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    for (const [org, chapter, owner, slug] of [[f.org, f.chapter, f.admin, "a"], [f.otherOrg, f.otherChapter, f.otherAdmin, "b"]]) {
      await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$2,'Recipe defaults proof org ' || $2,$3)", [org, `recipe-defaults-${slug}-${org.slice(0, 8)}`, owner]);
      await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,$3)", [chapter, org, slug === "a" ? 92601 : 92602]);
    }
    const memberOf = [[f.org, f.chapter, [f.admin, f.coordinator, f.steward, f.quiet, f.contacted, f.restricted]], [f.otherOrg, f.otherChapter, [f.otherAdmin]]];
    for (const [org, chapter, ids] of memberOf) for (const id of ids) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapter]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    }
    for (const id of [f.admin, f.coordinator, f.steward, f.otherAdmin]) {
      const session = randomUUID();
      sessions.set(id, session);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    for (const [org, id, role, by] of [[f.org, f.admin, "admin", f.admin], [f.org, f.coordinator, "coordinator", f.admin], [f.org, f.steward, "steward", f.admin], [f.otherOrg, f.otherAdmin, "admin", f.otherAdmin]]) {
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$4)", [org, id, role, by]);
    }
    // An overdue task assigned to the steward (prepare_chapter_task stamps the
    // caller's chapter, so it is written under the admin's claims).
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: f.admin, session_id: sessions.get(f.admin), aal: "aal2" })]);
    // The chapter has only an 'Organizing' workstream, like every chapter
    // created after 20260728221223: the engine must add 'General' itself.
    await db.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values ($1,'Organizing',$2)", [f.chapter, f.admin]);
    await db.query("insert into public.chapter_tasks(id,chapter_id,title,created_by,updated_by,workstream,status,priority,due_date,assignee_id) values ($1,$2,'Synthetic overdue task',$3,$3,'Organizing','to_do','medium',current_date-3,$4)", [f.overdueTask, f.chapter, f.admin, f.steward]);
    // Three active cases created 30 days ago: one quiet, one with a recent
    // contact-log entry, one restricted. None has a steward or coordinator.
    for (const [id, member, restricted] of [[f.quietCase, f.quiet, false], [f.contactedCase, f.contacted, false], [f.restrictedCase, f.restricted, true]]) {
      await db.query(
        "insert into public.member_cases(id,user_id,organization_id,chapter_id,reference,title,case_type,step,status,created_at,is_restricted,restriction_reason,restricted_at,restricted_by) values ($1,$2,$3,$4,$5,'Synthetic recipe case','Grievance','intake','active',now()-interval '30 days',$6,$7,case when $6 then now() else null end,case when $6 then $8::uuid else null end)",
        [id, member, f.org, f.chapter, `RECIPE-${id.slice(0, 6)}`, restricted, restricted ? "Restricted proof case" : null, f.admin],
      );
    }
    await db.query(
      "insert into public.chapter_contact_log(organization_id,chapter_id,subject_user_id,contact_kind,channel,purpose,summary,occurred_at,created_by) values ($1,$2,$3,'member','phone','Check in','Synthetic recent contact',now()-interval '2 days',$4)",
      [f.org, f.chapter, f.contacted, f.admin],
    );
    // The second organization switched default recipes off before seeding.
    await setSwitch(f.otherOrg, "features.automation.default_recipes", false);
  }, 120_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("offers four unapproved drafts only when an admin enables automation, then requires approval", async () => {
    expect(await recipes()).toEqual([]);
    expect((await db.query("select enabled from public.organization_automation_settings where organization_id=$1", [f.org])).rows).toEqual([]);
    await ok(f.admin, "select public.set_organization_automation_enabled(true,'ENABLE AUTOMATION') v");
    expect(await recipes()).toEqual([
      expect.objectContaining({ recipe_key: "deadline_risk_alert", trigger_kind: "case_deadline", threshold_days: 7, task_priority: "high" }),
      expect.objectContaining({ recipe_key: "overdue_task_escalation", trigger_kind: "overdue_task", threshold_days: 1, task_priority: "high" }),
      expect.objectContaining({ recipe_key: "stale_contact_followup", trigger_kind: "stale_member_contact", threshold_days: 14, task_priority: "medium" }),
      expect.objectContaining({ recipe_key: "unassigned_case_assignment", trigger_kind: "unassigned_case", threshold_days: 0, task_priority: "medium" }),
    ]);
    for (const row of await recipes()) expect(row).toMatchObject({ status: "draft", review_status: "draft", review_version: null, version: 1, updated_by: null });
    const settings = (await db.query("select enabled from public.organization_automation_settings where organization_id=$1", [f.org])).rows;
    expect(settings).toEqual([{ enabled: true }]);
    const rules = (await db.query("select name, event_kind, route_to, match_priorities, is_default from public.organization_automation_routing_rules where organization_id=$1 order by sort_order", [f.org])).rows;
    expect(rules.map((row) => [row.event_kind, row.route_to])).toEqual([["case_deadline", "chapter_admins"], ["unassigned_case", "coordinators"], ["overdue_task", "source_owner"]]);
    expect(rules.every((row) => row.is_default)).toBe(true);
    await tick();
    expect(await effects()).toEqual([]);
    const definitions = (await db.query("select id, version from public.organization_automation_definitions where organization_id=$1 and recipe_key is not null", [f.org])).rows;
    for (const row of definitions) {
      await ok(f.admin, "select public.mi1_submit_automation_definition($1,$2) v", [row.id, row.version]);
      await ok(f.admin, "select public.mi1_review_automation_definition($1,$2,'approve') v", [row.id, row.version]);
      await ok(f.admin, "select public.set_organization_automation_definition_status($1,'active',$2) v", [row.id, row.version]);
    }
    expect((await db.query("select distinct provenance from public.organization_automation_definitions where organization_id=$1 and recipe_key is not null", [f.org])).rows).toEqual([{ provenance: "organization" }]);
    await ok(f.admin, "select public.set_organization_automation_enabled(false,'PAUSE AUTOMATION') v");
    await ok(f.admin, "select public.set_organization_automation_enabled(true,'ENABLE AUTOMATION') v");
    expect(await recipes()).toHaveLength(4);
  });

  it("does not seed an organization whose default-recipes switch is off", async () => {
    expect(await recipes(f.otherOrg)).toEqual([]);
    expect((await db.query("select 1 from public.organization_automation_settings where organization_id=$1", [f.otherOrg])).rows).toEqual([]);
  });

  it("runs the defaults on the hourly tick: overdue task, unowned cases and quiet member contact, never a restricted case", async () => {
    await db.query("savepoint first_tick");
    await tick();
    const rows = await effects();
    const byRecipe = (key) => rows.filter((row) => row.recipe_key === key);
    expect(byRecipe("overdue_task_escalation")).toEqual([expect.objectContaining({ source_kind: "task", source_id: f.overdueTask, status: "created" })]);
    expect(byRecipe("stale_contact_followup").map((row) => row.source_id)).toEqual([f.quietCase]);
    expect(byRecipe("unassigned_case_assignment").map((row) => row.source_id).sort()).toEqual([f.contactedCase, f.quietCase].sort());
    expect(rows.some((row) => row.source_id === f.restrictedCase)).toBe(false);
    const runs = (await db.query("select r.mode, r.status, r.failure_code from public.organization_automation_runs r join public.organization_automation_definitions d on d.id=r.definition_id where d.organization_id=$1 and d.recipe_key is not null", [f.org])).rows;
    expect(runs.length).toBe(4);
    expect(runs.every((run) => run.mode === "scheduled" && run.failure_code === null)).toBe(true);
    const tasks = (await db.query("select t.title, t.priority, t.chapter_id, t.description from public.chapter_tasks t join public.organization_automation_effects e on e.task_id=t.id where e.organization_id=$1", [f.org])).rows;
    expect(tasks.length).toBe(rows.length);
    expect(tasks.every((task) => task.chapter_id === f.chapter && task.description === "")).toBe(true);
    expect(tasks.map((task) => task.title)).toContain("Review overdue work");
    expect((await db.query("select name from public.chapter_workstreams where chapter_id=$1 order by name", [f.chapter])).rows.map((row) => row.name)).toEqual(["General", "Organizing"]);
    await db.query("rollback to savepoint first_tick");
  });

  it("routes a notice to the overdue task's assignee and to coordinators for unowned cases, in-app only", async () => {
    await db.query("savepoint routing_tick");
    await tick();
    expect(await notices(f.steward)).toEqual([{ title: "An automation needs your attention", kind: "general" }]);
    // Two unowned cases, one notice each; the coordinator can open both.
    expect(await notices(f.coordinator)).toHaveLength(2);
    // Deadline-risk rule targets chapter admins, but nothing is due: no notice.
    expect(await notices(f.admin)).toEqual([]);
    expect(await notices(f.quiet)).toEqual([]);
    await db.query("rollback to savepoint routing_tick");
  });

  it("sends no routed notice while alert routing is switched off", async () => {
    await db.query("savepoint routing_off");
    await setSwitch(f.org, "features.automation.alert_routing", false);
    await tick();
    expect((await effects()).length).toBeGreaterThan(0);
    expect(await notices(f.steward)).toEqual([]);
    expect(await notices(f.coordinator)).toEqual([]);
    await db.query("rollback to savepoint routing_off");
  });

  it("stops every default recipe while the default-recipes switch is off", async () => {
    await db.query("savepoint recipes_off");
    await setSwitch(f.org, "features.automation.default_recipes", false);
    await tick();
    expect(await effects()).toEqual([]);
    const workspace = await ok(f.admin, "select public.mi1_get_automation_workspace() v");
    expect(workspace.defaultRecipes).toEqual({ enabled: false, alertRoutingEnabled: true });
    const recipe = workspace.definitions.find((row) => row.recipeKey === "overdue_task_escalation");
    expect(recipe).toMatchObject({ scheduledAuthority: "approver", dependencyReady: true });
    await db.query("rollback to savepoint recipes_off");
  });

  it("shows approved defaults with their human execution authority", async () => {
    const workspace = await ok(f.admin, "select public.mi1_get_automation_workspace() v");
    expect(workspace.capabilities.triggers).toContain("stale_member_contact");
    expect(workspace.defaultRecipes).toEqual({ enabled: true, alertRoutingEnabled: true });
    const keyed = workspace.definitions.filter((row) => row.recipeKey);
    expect(keyed).toHaveLength(4);
    for (const row of keyed) expect(row).toMatchObject({ scheduledAuthority: "approver", dependencyReady: true, canEdit: true, canActivate: true, reviewStatus: "approved" });
  });

  it("an approver who pauses a default recipe becomes its authority; an archived recipe is never re-created", async () => {
    await db.query("savepoint pause_recipe");
    const id = (await db.query("select id, version from public.organization_automation_definitions where organization_id=$1 and recipe_key='stale_contact_followup'", [f.org])).rows[0];
    await ok(f.admin, "select public.set_organization_automation_definition_status($1,'paused',$2) v", [id.id, id.version]);
    const workspace = await ok(f.admin, "select public.mi1_get_automation_workspace() v");
    expect(workspace.definitions.find((row) => row.id === id.id)).toMatchObject({ status: "paused", scheduledAuthority: "approver" });
    await ok(f.admin, "select public.set_organization_automation_definition_status($1,'archived',$2) v", [id.id, id.version]);
    await ok(f.admin, "select public.set_organization_automation_enabled(false,'PAUSE AUTOMATION') v");
    await ok(f.admin, "select public.set_organization_automation_enabled(true,'ENABLE AUTOMATION') v");
    expect((await recipes()).filter((row) => row.recipe_key === "stale_contact_followup")).toEqual([expect.objectContaining({ status: "archived" })]);
    await db.query("rollback to savepoint pause_recipe");
  });

  it("validates the stale_member_contact trigger: at least one day", async () => {
    const spec = (thresholdDays) => JSON.stringify({ schemaVersion: 2, name: `Quiet contact ${thresholdDays}`, triggerKind: "stale_member_contact", thresholdDays, taskPriority: "medium", cadence: "daily", conditions: {}, actionKind: "create_standard_task", actionConfig: {} });
    expect(await as(f.admin, "select public.mi1_save_automation_definition_v2($1::jsonb) v", [spec(0)])).toMatchObject({ code: "22023" });
    const saved = await as(f.admin, "select public.mi1_save_automation_definition_v2($1::jsonb) v", [spec(21)]);
    expect(saved, saved.message).toMatchObject({ code: "" });
    expect(saved.rows[0].v).toMatchObject({ triggerKind: "stale_member_contact", thresholdDays: 21 });
  });

  it("lets every automation author read routing rules and only approvers change them", async () => {
    const read = await ok(f.steward, "select public.mi1_get_automation_routing_rules() v");
    expect(read).toMatchObject({ organizationId: f.org, enabled: true, canManage: false });
    expect(read.rules).toHaveLength(3);
    const rule = { name: "Quiet contact to stewards", eventKind: "stale_member_contact", routeTo: "chapter_stewards", enabled: true, priorities: null };
    expect(await as(f.steward, "select public.mi1_save_automation_routing_rule($1::jsonb) v", [JSON.stringify(rule)])).toMatchObject({ code: "42501" });
    const saved = await ok(f.admin, "select public.mi1_save_automation_routing_rule($1::jsonb) v", [JSON.stringify(rule)]);
    expect(saved).toMatchObject({ organizationId: f.org, name: rule.name, isDefault: false, enabled: true });
    const toggled = await ok(f.admin, "select public.mi1_save_automation_routing_rule($1::jsonb) v", [JSON.stringify({ ...rule, id: saved.id, enabled: false })]);
    expect(toggled).toMatchObject({ id: saved.id, enabled: false });
    expect(await as(f.admin, "select public.mi1_save_automation_routing_rule($1::jsonb) v", [JSON.stringify({ ...rule, name: "Bad", routeTo: "everyone" })])).toMatchObject({ code: "22023" });
    expect(await as(f.admin, "select public.mi1_save_automation_routing_rule($1::jsonb) v", [JSON.stringify({ ...rule, name: "Foreign chapter", chapterId: f.otherChapter })])).toMatchObject({ code: "42501" });
    // Another organization's approver cannot see or delete this rule.
    expect((await ok(f.otherAdmin, "select public.mi1_get_automation_routing_rules() v")).rules).toEqual([]);
    expect(await as(f.otherAdmin, "select public.mi1_delete_automation_routing_rule($1) v", [saved.id])).toMatchObject({ code: "22023" });
    expect(await ok(f.admin, "select public.mi1_delete_automation_routing_rule($1) v", [saved.id])).toMatchObject({ deleted: true });
    expect(await as(f.steward, "select * from public.organization_automation_routing_rules")).toMatchObject({ code: "42501" });
    const audit = (await db.query("select event_type, action, actor_user_id from public.organization_audit_ledger where organization_id=$1 and entity_type='automation_routing_rule' and entity_id=$2", [f.org, saved.id])).rows;
    expect(audit.map((row) => `${row.action}:${row.event_type}`).sort()).toEqual([
      "create:automation_routing_rule_saved", "delete:automation_routing_rule_deleted", "update:automation_routing_rule_saved",
    ]);
    expect(audit.every((row) => row.actor_user_id === f.admin)).toBe(true);
  });

  // REQ-UG-HOLD-RELEASE-CALENDAR-SWITCHES-20261112 (#8579): held for
  // its release date, the feature shows nothing: no defaultRecipes block, no
  // recipe definitions in the workspace, list or detail, and no recipe runs.
  // Turned off by the organization but released, everything shows as before.
  it("hides the default recipes, their definitions and their runs only while the switch is held", async () => {
    await db.query("savepoint recipes_held");
    try {
      // One hourly tick while released leaves a run of each active recipe.
      await tick();
      const recipeIds = (await db.query("select id from public.organization_automation_definitions where organization_id=$1 and recipe_key is not null order by id", [f.org])).rows.map((row) => row.id);
      const recipeRun = (await db.query(
        "select r.id from public.organization_automation_runs r join public.organization_automation_definitions d on d.id=r.definition_id where r.organization_id=$1 and d.recipe_key is not null order by r.id limit 1",
        [f.org],
      )).rows[0]?.id;
      expect(recipeIds.length).toBeGreaterThan(0);
      expect(recipeRun).toBeTruthy();
      const isRecipe = (id) => recipeIds.includes(id);
      const view = async () => {
        const workspace = await ok(f.admin, "select public.mi1_get_automation_workspace() v");
        const list = await ok(f.admin, "select public.mi1_get_automation_definitions(1,50,'',null) v");
        const runs = await ok(f.admin, "select public.mi1_get_automation_runs(1,50,null,null,null,null) v");
        const detail = await as(f.admin, "select public.mi1_get_automation_definition($1) v", [recipeIds[0]]);
        const run = await as(f.admin, "select public.mi1_get_automation_run($1,1,20) v", [recipeRun]);
        const runsOfRecipe = await as(f.admin, "select public.mi1_get_automation_runs(1,50,$1,null,null,null) v", [recipeIds[0]]);
        return {
          defaultRecipes: workspace.defaultRecipes ?? null,
          workspaceRecipes: workspace.definitions.filter((row) => isRecipe(row.id)).length,
          workspaceRecipeRuns: workspace.runs.some((row) => isRecipe(row.definitionId)),
          listRecipes: list.rows.filter((row) => isRecipe(row.id)).length,
          listedRecipeRuns: runs.rows.some((row) => isRecipe(row.definitionId)) || runs.total !== runs.rows.length,
          detail: detail.code || "shown",
          run: run.code || "shown",
          runsOfRecipe: runsOfRecipe.code || "shown",
        };
      };
      // Released and switched off by the organization: today's behavior.
      await setSwitch(f.org, "features.automation.default_recipes", false);
      expect(await view()).toEqual({
        defaultRecipes: { enabled: false, alertRoutingEnabled: expect.any(Boolean) },
        workspaceRecipes: recipeIds.length,
        workspaceRecipeRuns: true,
        listRecipes: recipeIds.length,
        listedRecipeRuns: true,
        detail: "shown",
        run: "shown",
        runsOfRecipe: "shown",
      });
      // Held: nothing of the feature shows, and every row stays stored.
      await db.query("update public.platform_setting_definitions set release_at = 'infinity' where key = 'features.automation.default_recipes'");
      expect(await view()).toEqual({
        defaultRecipes: null,
        workspaceRecipes: 0,
        workspaceRecipeRuns: false,
        listRecipes: 0,
        listedRecipeRuns: false,
        detail: "42501",
        run: "42501",
        runsOfRecipe: "42501",
      });
      expect((await db.query("select count(*)::int n from public.organization_automation_definitions where organization_id=$1 and recipe_key is not null", [f.org])).rows[0].n).toBe(recipeIds.length);
    } finally {
      await db.query("rollback to savepoint recipes_held");
    }
  });

  // #8579, gate round 2 advisory: held recipe runs are removed before the
  // workspace's 50-run window, so they can never crowd out a custom
  // automation's run history. Released, the window is unchanged.
  it("keeps a custom automation's run in the workspace when more than 50 newer recipe runs are held", async () => {
    await db.query("savepoint recipe_window");
    try {
      await tick();
      const recipeRun = (await db.query(
        "select r.id from public.organization_automation_runs r join public.organization_automation_definitions d on d.id=r.definition_id where r.organization_id=$1 and d.recipe_key is not null order by r.id limit 1",
        [f.org],
      )).rows[0].id;
      const custom = (await db.query(
        `insert into public.organization_automation_definitions
         select (pg_catalog.jsonb_populate_record(null::public.organization_automation_definitions,
           pg_catalog.to_jsonb(d) || pg_catalog.jsonb_build_object('id', gen_random_uuid(), 'name', 'Custom window proof', 'recipe_key', null))).*
         from public.organization_automation_definitions d
         join public.organization_automation_runs r on r.definition_id = d.id
         where r.id = $1
         returning id`,
        [recipeRun],
      )).rows[0].id;
      const copyRun = (definition, createdAt) => db.query(
        `insert into public.organization_automation_runs
         select (pg_catalog.jsonb_populate_record(null::public.organization_automation_runs,
           pg_catalog.to_jsonb(r) || pg_catalog.jsonb_build_object('id', gen_random_uuid(), 'definition_id', $2::uuid, 'created_at', $3::timestamptz))).*
         from public.organization_automation_runs r where r.id = $1
         returning id`,
        [recipeRun, definition, createdAt],
      );
      const customRun = (await copyRun(custom, "2000-01-01T00:00:00Z")).rows[0].id;
      const recipeDefinition = (await db.query("select definition_id from public.organization_automation_runs where id=$1", [recipeRun])).rows[0].definition_id;
      for (let i = 0; i < 55; i += 1) await copyRun(recipeDefinition, new Date(Date.UTC(2030, 0, 1, 0, i)).toISOString());
      const workspaceRuns = async () => (await ok(f.admin, "select public.mi1_get_automation_workspace() v")).runs;

      // Released: the 50 newest runs, all of them recipe runs, as before.
      const released = await workspaceRuns();
      expect(released).toHaveLength(50);
      expect(released.every((row) => row.definitionId === recipeDefinition)).toBe(true);
      expect(released.some((row) => row.id === customRun)).toBe(false);

      // Held: every recipe run leaves the window and the custom run shows.
      await db.query("update public.platform_setting_definitions set release_at = 'infinity' where key = 'features.automation.default_recipes'");
      const held = await workspaceRuns();
      expect(held.some((row) => row.id === customRun)).toBe(true);
      expect(held.filter((row) => row.definitionId === recipeDefinition)).toEqual([]);
    } finally {
      await db.query("rollback to savepoint recipe_window");
    }
  });
});
