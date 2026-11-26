// @vitest-environment node
//
// REQ-UG-LEARNING-PERIOD-MEMBERSHIP-ROLES-SETTINGS-20261103 (#6946),
// slice 7 of #6805: role, membership, settings and own-preference changes
// during the learning period are journalled once and undone by the person who
// made them, with today's permission rechecked; a role undo re-grants only
// what the person could grant today; excluded security controls are never
// journalled or offered Undo; organization_audit_events only grows; sessions a
// staff grant ended are not revived.
import { migrateLegacyStewardFixtures, scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { releaseLearningPeriodHold } from "./helpers/learningPeriodHold.js";

const FILE = "20261104113000_learning_period_membership_roles_settings.sql";
const RECONCILE_FILE = "20261112214950_president_case_review_selected_workspace.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);
const WRITERS = {
  "public.set_member_organization_role": ["organization_role_grant", "organization_role_revoke"],
  "public.set_member_chapter_role": ["chapter_role_grant", "chapter_role_revoke"],
  "public.set_member_access_role": ["chapter_role_grant", "chapter_role_revoke", "chapter_role_scope"],
  "public.grant_member_chapter_membership": ["chapter_membership_grant"],
  "public.revoke_member_chapter_membership": ["chapter_membership_revoke"],
  "public.set_member_chapter_display_title": ["chapter_display_title_change"],
  "public.set_chapter_budget_office": ["chapter_budget_office_change"],
  "public.set_my_chapter_pin": ["own_chapter_pin"],
  "private.write_organization_setting": ["organization_setting_change", "organization_setting_reset"],
  "public.upsert_organization_network_profile": ["network_profile_change"],
  "public.set_my_profile_details": ["own_profile_details_update"],
  "public.set_my_profile_details_v2": ["own_profile_details_update"],
  "public.set_my_form_autofill_preference": ["own_profile_details_update"],
  "public.update_my_member_profile": ["own_profile_update", "own_settings_update"],
};
const EXCLUDED = ["staff_mfa_policy_change", "member_mfa_policy_change", "organization_security_setting_change",
  "retention_policy_change", "organization_merge", "sso_change", "scim_change", "membership_accept"];
// The excluded controls' current definitions, none of which may journal.
const EXCLUDED_RPCS = ["public.set_staff_mfa_policy", "public.set_member_mfa_policy", "public.upsert_organization_retention_policy",
  "public.authorize_organization_retention_run", "public.execute_organization_retention_run", "public.review_organization_merge_match",
  "public.execute_organization_merge_plan", "public.save_sso_connection", "public.add_sso_domain", "public.remove_sso_domain",
  "public.save_scim_settings", "public.issue_scim_token", "public.revoke_scim_token", "public.set_scim_group_role"];

function latestDefinitions() {
  const latest = new Map();
  for (const file of readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort()) {
    for (const fn of parseFunctions(readFileSync(`supabase/migrations/${file}`, "utf8"))) latest.set(fn.name, fn.source);
  }
  return latest;
}

describe("learning period membership, roles and settings migration (offline)", () => {
  it("journals every writer after its write, with the graph lock first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const [name, kinds] of Object.entries(WRITERS)) {
      const source = functions.find((fn) => fn.name === name).source;
      expect(helperFirst(source), name).toBe(true);
      for (const kind of kinds) expect(source, `${name} ${kind}`).toContain(`private.learning_membership_journal('${kind}'`);
    }
    expect(functions.find((fn) => fn.name === "public.revoke_member_chapter_membership").source)
      .toContain("private.learning_journal_append('chapter_membership_revoke_final'");
    for (const fn of functions.filter((item) => item.name.startsWith("private.learning_undo_") || item.name === "private.learning_membership_journal")) {
      expect(helperFirst(fn.source), fn.name).toBe(true);
    }
  });

  it("registers the excluded controls with no table or handler, and none of them journals", () => {
    for (const kind of EXCLUDED) expect(code).toMatch(new RegExp(`\\('${kind}', '[a-z]+', 'excluded', null, false, null,`));
    const latest = latestDefinitions();
    for (const name of EXCLUDED_RPCS) {
      expect(latest.has(name), name).toBe(true);
      expect(latest.get(name), name).not.toMatch(/private\.learning_[a-z_]*journal/);
    }
  });

  it("lists only its own handlers and hands every other one to the dispatcher it found installed", () => {
    const dispatch = parseFunctions(sql).find((fn) => fn.name === "private.learning_dispatch").source;
    const own = new Set([...code.matchAll(/'(private\.learning_undo_[a-z_]+)'/g)].map((match) => match[1]));
    expect(own.size).toBe(7);
    for (const handler of own) expect(dispatch, handler).toContain(`when '${handler}' then return ${handler}(p_mode, p_entry);`);
    expect(dispatch).toContain("else return private.learning_dispatch_before_membership(p_handler, p_mode, p_entry);");
    expect(dispatch).not.toContain("private.learning_undo_task");
    expect(code).toContain("alter function private.learning_dispatch(text, text, jsonb) rename to learning_dispatch_before_membership;");
    expect(code).toContain("$assert_learning_dispatch_complete$");
  });

  it("takes a granted chapter back with the forward revoke's role cleanup (20261106031000, #8311)", () => {
    const fix = readFileSync("supabase/migrations/20261106031000_learning_period_membership_grant_undo_removes_roles.sql", "utf8");
    expect(stripComments(fix).trim()).toMatch(/^begin;[\s\S]*commit;$/);
    // #8311 moved both the forward revoke and this take-back onto the shared
    // legacy role reconcile; they stay defined together there.
    const reconcile = readFileSync(`supabase/migrations/${RECONCILE_FILE}`, "utf8");
    const latest = latestDefinitions();
    const revoke = parseFunctions(reconcile).find((fn) => fn.name === "public.revoke_member_chapter_membership").source;
    expect(latest.get("public.revoke_member_chapter_membership")).toBe(revoke);
    const undo = latest.get("private.learning_undo_chapter_membership");
    expect(undo).toBe(parseFunctions(reconcile).find((fn) => fn.name === "private.learning_undo_chapter_membership").source);
    expect(helperFirst(undo)).toBe(true);
    const flat = (text) => text.replace(/\s+/g, " ");
    const cleanup = [/delete from public\.member_role_chapters\b[^;]*;/, /perform private\.reconcile_legacy_member_roles\([^;]*;/]
      .map((pattern) => flat(revoke.match(pattern)[0]).replaceAll("p_user_id", "member").replaceAll("p_chapter_id", "chapter"));
    const takeBack = flat(undo.slice(undo.indexOf("elsif part = 'm' then"), undo.indexOf("elsif part = 'p' then")));
    for (const statement of cleanup) expect(takeBack).toContain(statement);
  });

  it("never rewrites an audit row and never deletes a membership or profile", () => {
    expect(code).not.toMatch(/(update|delete from)\s+public\.(organization_audit_ledger|organization_audit_events|member_admin_audit|organization_configuration_audit)\b/);
    expect(code).not.toMatch(/delete from public\.(member_chapter_memberships|member_profiles|member_profile_details|organization_network_directory_profiles|organization_memberships)\b/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("learning period membership, roles and settings on a disposable database", () => {
  let c;
  let w;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "learning-period-membership-proof" });
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
  const one = async (...args) => {
    const result = await call(...args);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    return result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  };
  const q = async (text, values = []) => (await c.query(text, values)).rows;

  async function person(chapters, { orgRoles = [], chapterRoles = [] } = {}) {
    const user = { id: randomUUID(), session: randomUUID() };
    await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
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
    await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    // Retain this historical broad fixture grant.
    if (orgRoles.includes("steward") || chapterRoles.some(([role]) => role === "steward")) await migrateLegacyStewardFixtures(c);
    return user;
  }

  beforeEach(async () => {
    await c.query("begin");
    await releaseLearningPeriodHold(c);
    const suffix = randomUUID().slice(0, 8);
    w = { org: randomUUID(), a: `learning-roles-a-${suffix}`, b: `learning-roles-b-${suffix}` };
    await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [w.org, `learning-roles-${suffix}`]);
    await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$3,98317), ($2,$2,$2,$3,98318)", [w.a, w.b, w.org]);
    w.admin = await person([w.a], { orgRoles: ["admin"], chapterRoles: [["admin", w.a]] });
    w.admin2 = await person([w.a], { orgRoles: ["admin"], chapterRoles: [["admin", w.a]] });
    w.chapterAdmin = await person([w.a], { chapterRoles: [["admin", w.a]] });
    w.member = await person([w.a]);
    w.both = await person([w.a, w.b], { orgRoles: ["coordinator"], chapterRoles: [["steward", w.b]] });
    // Compare scope IDs to the actual default-unit fixture.
    w.requiredDefaultA=(await c.query("select id from private.chapter_units where chapter_id=$1 and is_default",[w.a])).rows[0].id;
    w.requiredDefaultB=(await c.query("select id from private.chapter_units where chapter_id=$1 and is_default",[w.b])).rows[0].id;
    w.unit = (await q("insert into private.chapter_units(organization_id,chapter_id,name) values ($1,$2,'Night shift') returning id", [w.org, w.a]))[0].id;
  });
  afterEach(async () => { await c.query("rollback"); });

  const start = () => one("select public.start_organization_learning_period() as r", [], w.admin);
  const entries = async (table, target) => q("select id, action_kind, state, version, actor_user_id from private.learning_action_journal where target_table = $1 and target_id = $2 order by created_at, id", [table, target]);
  const undo = (user, entry, version = 1) => call("select public.undo_my_learning_action($1, $2) as r", [entry, version], user);
  const orgRole = async (user, role) => (await q("select count(*)::int as n from public.organization_role_grants where organization_id = $1 and user_id = $2 and role = $3", [w.org, user.id, role]))[0].n === 1;
  const chapterRole = async (user, role, chapter) => (await q("select rc.role, s.unit_id from public.member_role_chapters rc left join private.chapter_role_scopes s using (user_id, chapter_id, role) where rc.user_id = $1 and rc.role = $2 and rc.chapter_id = $3", [user.id, role, chapter]))[0] ?? null;
  const membership = async (user, chapter) => (await q("select status, pinned, display_title, budget_office from public.member_chapter_memberships where user_id = $1 and chapter_id = $2", [user.id, chapter]))[0];
  const auditEvents = () => q("select id, event_type, actor_user_id, metadata from public.organization_audit_events where organization_id = $1 order by created_at, id", [w.org]);

  it("journals an organization role grant and undoes it, with its own audit event, earlier events untouched", async () => {
    // Pure organization-role journalling uses
    // coordinator; a new steward is granted only with a chapter and unit.

    await start();
    expect(await one("select (public.set_member_organization_role($1, 'coordinator', true)) ->> 'changed' as r", [w.member.id], w.admin)).toBe("true");
    const target = `${w.org}:${w.member.id}:coordinator`;
    const [entry] = await entries("public.organization_role_grants", target);
    expect(entry).toMatchObject({ action_kind: "organization_role_grant", state: "active", actor_user_id: w.admin.id });
    const before = await auditEvents();
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect(await orgRole(w.member, "coordinator")).toBe(false);
    expect((await entries("public.organization_role_grants", target))[0].state).toBe("undone");
    const after = await auditEvents();
    const kept = new Set(before.map((event) => event.id));
    expect(after.filter((event) => kept.has(event.id))).toEqual(before);
    expect(after.filter((event) => !kept.has(event.id))).toEqual([expect.objectContaining({ event_type: "organization_role_revoked", actor_user_id: w.admin.id,
      metadata: expect.objectContaining({ userId: w.member.id, role: "coordinator", action: "learning_undo", entityId: entry.id }) })]);
    // Repeat undo changes nothing.
    expect((await undo(w.admin, entry.id, 2)).rows[0].r).toMatchObject({ status: "already_undone" });
    expect(await auditEvents()).toEqual(after);
  });

  it("re-grants a revoked organization role only while the person may still grant it", async () => {
    await start();
    await one("select public.set_member_organization_role($1, 'coordinator', false) as r", [w.both.id], w.admin);
    const [entry] = await entries("public.organization_role_grants", `${w.org}:${w.both.id}:coordinator`);
    expect(entry.action_kind).toBe("organization_role_revoke");
    // Another administrator takes away the first one's administrator role.
    await one("select public.set_member_organization_role($1, 'admin', false) as r", [w.admin.id], w.admin2);
    const refused = await undo(w.admin, entry.id);
    expect(refused).toMatchObject({ ok: false, code: "42501" });
    expect(await orgRole(w.both, "coordinator")).toBe(false);
    expect((await entries("public.organization_role_grants", `${w.org}:${w.both.id}:coordinator`))[0]).toMatchObject({ state: "active", version: 1 });
  });

  it("undoes a scoped chapter role revoke with its unit scope, and refuses once the person may no longer grant it", async () => {
    await start();
    await one("select public.set_member_access_role($1, $2, 'steward', true, $3) as r", [w.member.id, w.a, w.unit], w.chapterAdmin);
    const target = `${w.member.id}:steward:${w.a}`;
    expect((await entries("public.member_role_chapters", target)).map((entry) => entry.action_kind)).toEqual(["chapter_role_grant"]);
    await one("select public.set_member_access_role($1, $2, 'steward', false) as r", [w.member.id, w.a], w.chapterAdmin);
    const [, revoke] = await entries("public.member_role_chapters", target);
    expect(revoke.action_kind).toBe("chapter_role_revoke");
    expect(await chapterRole(w.member, "steward", w.a)).toBeNull();
    expect(await undo(w.chapterAdmin, revoke.id)).toMatchObject({ ok: true });
    // Put back exactly as it was: scoped to the unit, never chapter-wide.
    expect(await chapterRole(w.member, "steward", w.a)).toEqual({ role: "steward", unit_id: w.unit });
    // The org administrator removes the chapter administrator's role; their
    // earlier grant can no longer be undone by them.
    await one("select public.set_member_chapter_role($1, $2, 'admin', false) as r", [w.chapterAdmin.id, w.a], w.admin);
    const [grant] = await entries("public.member_role_chapters", target);
    expect(await undo(w.chapterAdmin, grant.id)).toMatchObject({ ok: false, code: "42501" });
    expect(await chapterRole(w.member, "steward", w.a)).toEqual({ role: "steward", unit_id: w.unit });
  });

  // #8589 gate round 1: an undo never puts back a steward without a unit.
  it("refuses to undo an organization-wide steward removal, which today's rule never grants", async () => {
    const orgSteward = await person([w.a], { orgRoles: ["steward"] });
    await start();
    expect(await one("select (public.set_member_organization_role($1, 'steward', false)) ->> 'changed' as r", [orgSteward.id], w.admin)).toBe("true");
    const [entry] = await entries("public.organization_role_grants", `${w.org}:${orgSteward.id}:steward`);
    expect(entry.action_kind).toBe("organization_role_revoke");
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: false, code: "22023", message: "steward access requires a chapter and unit" });
    expect(await orgRole(orgSteward, "steward")).toBe(false);
    expect((await entries("public.organization_role_grants", `${w.org}:${orgSteward.id}:steward`))[0]).toMatchObject({ state: "active", version: 1 });
  });

  it("refuses to restore a chapter steward from a before-image recorded with no unit", async () => {
    await start();
    await one("select public.set_member_access_role($1, $2, 'steward', true, $3) as r", [w.member.id, w.a, w.unit], w.chapterAdmin);
    await one("select public.set_member_access_role($1, $2, 'steward', false) as r", [w.member.id, w.a], w.chapterAdmin);
    const target = `${w.member.id}:steward:${w.a}`;
    const [, revoke] = await entries("public.member_role_chapters", target);
    // Model an entry journalled before #7663, when a steward could hold no unit.
    await c.query("set local session_replication_role = replica");
    await c.query("update private.learning_action_journal set before_image = jsonb_set(before_image, '{unit_id}', 'null') where id = $1", [revoke.id]);
    await c.query("set local session_replication_role = origin");
    expect(await undo(w.chapterAdmin, revoke.id)).toMatchObject({ ok: false, code: "22023", message: "steward access requires a chapter and unit" });
    expect(await chapterRole(w.member, "steward", w.a)).toBeNull();
  });

  it("undoes a chapter removal with the roles it removed, and keeps a last-chapter removal as permanent", async () => {
    await start();
    await one("select public.revoke_member_chapter_membership($1, $2) as r", [w.both.id, w.b], w.admin);
    const [entry] = await entries("public.member_chapter_memberships", `m:${w.both.id}:${w.b}`);
    expect(entry.action_kind).toBe("chapter_membership_revoke");
    expect(await chapterRole(w.both, "steward", w.b)).toBeNull();
    const events = new Set((await auditEvents()).map((event) => event.id));
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect((await membership(w.both, w.b)).status).toBe("active");
    // The existing assignment has its default unit.
    expect(await chapterRole(w.both, "steward", w.b)).toEqual({ role: "steward", unit_id: w.requiredDefaultB });
    expect((await auditEvents()).filter((event) => !events.has(event.id)).map((event) => event.event_type)).toEqual(["organization_membership_granted"]);

    await one("select public.revoke_member_chapter_membership($1, $2) as r", [w.member.id, w.a], w.admin);
    const [final] = await entries("public.member_chapter_memberships", `m:${w.member.id}:${w.a}`);
    expect(final).toMatchObject({ action_kind: "chapter_membership_revoke_final", state: "kept" });
    expect(await undo(w.admin, final.id)).toMatchObject({ ok: false, code: "55000" });
    const history = await one("select public.list_my_learning_history() as r", [], w.admin);
    expect(history.entries.find((item) => item.id === final.id)).toMatchObject({ sent: true, undoable: false });
    expect((await q("select status from public.organization_memberships where organization_id = $1 and user_id = $2", [w.org, w.member.id]))[0].status).toBe("revoked");
  });

  it("undoes a chapter grant by removing the chapter again, never the row", async () => {
    await start();
    await one("select public.grant_member_chapter_membership($1, $2) as r", [w.member.id, w.b], w.admin);
    const [entry] = await entries("public.member_chapter_memberships", `m:${w.member.id}:${w.b}`);
    expect(entry.action_kind).toBe("chapter_membership_grant");
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect((await membership(w.member, w.b)).status).toBe("revoked");
  });

  it("undoes a chapter grant with no chapter role rows left behind, roles elsewhere kept (#6946)", async () => {
    // Role rows an earlier removal left on the revoked membership come back
    // with the grant; taking the chapter back removes them as a removal does.
    await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status,revoked_at) values ($1,$2,'revoked',now())", [w.member.id, w.b]);
    await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2), ($1,'treasurer',$3)", [w.member.id, w.a, w.b]);
    await c.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2), ($1,'steward',$3), ($1,'treasurer',$3)", [w.member.id, w.a, w.b]);
    // Both raw fixture grants have real units.
    await scopeFixtureSteward(c,w.member.id,w.a,w.requiredDefaultA);
    await scopeFixtureSteward(c,w.member.id,w.b,w.requiredDefaultB);
    await start();
    await one("select public.grant_member_chapter_membership($1, $2) as r", [w.member.id, w.b], w.admin);
    const [entry] = await entries("public.member_chapter_memberships", `m:${w.member.id}:${w.b}`);
    expect(entry.action_kind).toBe("chapter_membership_grant");
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect((await membership(w.member, w.b)).status).toBe("revoked");
    expect(await q("select role, chapter_id from public.member_role_chapters where user_id = $1 order by role, chapter_id", [w.member.id]))
      .toEqual([{ role: "steward", chapter_id: w.a }]);
    expect(await q("select role, chapter_id from public.member_roles where user_id = $1 order by role", [w.member.id]))
      .toEqual([{ role: "steward", chapter_id: w.a }]);
  });

  it("still refuses a chapter grant's undo after a later role write in that chapter (#6946)", async () => {
    await start();
    await one("select public.grant_member_chapter_membership($1, $2) as r", [w.member.id, w.b], w.admin);
    const [entry] = await entries("public.member_chapter_memberships", `m:${w.member.id}:${w.b}`);
    // The new grant explicitly selects the chapter's unit.
    await one("select public.set_member_access_role($1, $2, 'steward', true, $3, null) as r", [w.member.id, w.b,w.requiredDefaultB], w.admin);
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: false, code: "PT409" });
    expect((await membership(w.member, w.b)).status).toBe("active");
    // A new assignment retains its selected unit.
    expect(await chapterRole(w.member, "steward", w.b)).toEqual({ role: "steward", unit_id: w.requiredDefaultB });
    expect((await entries("public.member_chapter_memberships", `m:${w.member.id}:${w.b}`))[0]).toMatchObject({ state: "active", version: 1 });
  });

  it("never revives a session a staff grant ended", async () => {
    // Pure organization-role journalling uses
    // coordinator; a new steward is granted only with a chapter and unit.

    await start();
    const pinSession = randomUUID();
    await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',now(),now())", [pinSession, w.member.id]);
    await c.query("insert into private.member_pin_sessions(session_id,user_id) values ($1,$2)", [pinSession, w.member.id]);
    await c.query("insert into private.member_pin_credentials(user_id,pin_hash) values ($1,$2)", [w.member.id, `$2a$12$${"a".repeat(53)}`]);
    const sessions = async () => (await q("select id from auth.sessions where user_id = $1 order by id", [w.member.id])).map((row) => row.id);
    await one("select public.set_member_organization_role($1, 'coordinator', true) as r", [w.member.id], w.admin);
    const afterGrant = await sessions();
    expect(afterGrant).not.toContain(pinSession);
    const [entry] = await entries("public.organization_role_grants", `${w.org}:${w.member.id}:coordinator`);
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect(await orgRole(w.member, "coordinator")).toBe(false);
    expect(await sessions()).toEqual(afterGrant);
    expect(await q("select 1 from private.member_pin_sessions where user_id = $1", [w.member.id])).toEqual([]);
    expect(await q("select 1 from private.member_pin_credentials where user_id = $1", [w.member.id])).toEqual([]);
  });

  it("never journals an excluded control and never offers it Undo", async () => {
    await start();
    const count = async () => (await q("select count(*)::int as n from private.learning_action_journal where organization_id = $1", [w.org]))[0].n;
    // The engine's append, called the way a domain RPC calls it (as the
    // definer, with the administrator's claims), journals none of them.
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: w.admin.id, session_id: w.admin.session, aal: "aal2" })]);
    for (const kind of EXCLUDED) {
      expect((await q("select private.learning_journal_append($1, null, $2) as r", [kind, w.org]))[0].r, kind).toBeNull();
    }
    expect(await q("select action_kind from private.learning_action_kinds where action_kind = any($1) and (target_table is not null or handler is not null)", [EXCLUDED])).toEqual([]);
    await one("select public.set_staff_mfa_policy(true) as r", [], w.admin);
    await one("select public.set_member_mfa_policy(true) as r", [], w.admin);
    const securityKey = (await q("select key from public.platform_setting_definitions where organization_editable and value_kind = 'boolean' and private.learning_setting_excluded(key) order by key limit 1"))[0].key;
    await one("select public.update_organization_setting($1, 'false'::jsonb) as r", [securityKey], w.admin);
    expect(await count()).toBe(0);
    expect((await one("select public.list_my_learning_history() as r", [], w.admin)).entries).toEqual([]);
  });

  it("undoes an ordinary setting change, refused while someone else's later change stands", async () => {
    await start();
    const key = (await q("select key from public.platform_setting_definitions where organization_editable and value_kind = 'boolean' and not private.learning_setting_excluded(key) order by key limit 1"))[0].key;
    const value = async () => (await q("select value from public.organization_setting_values where organization_id = $1 and setting_key = $2", [w.org, key]))[0]?.value ?? null;
    await one("select public.update_organization_setting($1, 'false'::jsonb) as r", [key], w.admin);
    await one("select public.update_organization_setting($1, 'true'::jsonb) as r", [key], w.admin2);
    const target = `${w.org}:${key}`;
    const [mine, theirs] = await entries("public.organization_setting_values", target);
    expect([mine.action_kind, theirs.action_kind]).toEqual(["organization_setting_change", "organization_setting_change"]);
    expect(await undo(w.admin, mine.id)).toMatchObject({ ok: false, code: "PT409" });
    expect(await value()).toBe(true);
    expect(await undo(w.admin2, theirs.id)).toMatchObject({ ok: true });
    expect(await undo(w.admin, mine.id)).toMatchObject({ ok: true });
    expect(await value()).toBeNull();
    expect((await q("select action from public.organization_configuration_audit where organization_id = $1 and item_key = $2 order by created_at", [w.org, key])).map((row) => row.action))
      .toEqual(["setting_updated", "setting_updated", "setting_updated", "setting_reset"]);
  });

  it("undoes a new network profile by hiding it, never deleting it", async () => {
    await start();
    await one("select public.upsert_organization_network_profile('Proof Local', 'Practice summary', 'private') as r", [], w.admin);
    const [entry] = await entries("public.organization_network_directory_profiles", w.org);
    expect(entry.action_kind).toBe("network_profile_change");
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect(await q("select visibility, contact_mode from public.organization_network_directory_profiles where organization_id = $1", [w.org]))
      .toEqual([{ visibility: "private", contact_mode: "disabled" }]);
  });

  it("undoes your own settings, profile details and chapter pin, and nobody else can", async () => {
    await start();
    await one("select public.update_my_member_profile($1, '{\"language\": \"es\", \"dnd_enabled\": true}'::jsonb) as r", [w.member.id], w.member);
    const [settings] = await entries("public.member_profiles", w.member.id);
    expect(settings.action_kind).toBe("own_settings_update");
    expect(await undo(w.admin, settings.id)).toMatchObject({ ok: false, code: "P0002" });
    expect(await undo(w.member, settings.id)).toMatchObject({ ok: true });
    expect((await q("select language, dnd_enabled from public.member_profiles where id = $1", [w.member.id]))[0]).toMatchObject({ language: "en", dnd_enabled: false });

    await one("select public.set_my_profile_details_v2('{\"pronouns\": \"they/them\", \"shift\": \"Nights\"}'::jsonb) as r", [], w.member);
    const details = await entries("public.member_profile_details", w.member.id);
    expect(details.map((entry) => entry.action_kind)).toEqual(["own_profile_details_update"]);
    expect(await undo(w.member, details[0].id)).toMatchObject({ ok: true });
    expect((await q("select pronouns, shift, details_visibility from public.member_profile_details where user_id = $1", [w.member.id]))[0])
      .toEqual({ pronouns: null, shift: null, details_visibility: "only_me" });

    await one("select public.set_my_chapter_pin($1, true) as r", [w.a], w.member);
    const [pin] = await entries("public.member_chapter_memberships", `p:${w.member.id}:${w.a}`);
    expect(await undo(w.member, pin.id)).toMatchObject({ ok: true });
    expect((await membership(w.member, w.a)).pinned).toBe(false);
  });

  it("undoes a display title and a budget office", async () => {
    await start();
    await one("select public.set_member_chapter_display_title($1, $2, 'Practice Captain') as r", [w.member.id, w.a], w.admin);
    const [title] = await entries("public.member_chapter_memberships", `t:${w.member.id}:${w.a}`);
    expect(await undo(w.admin, title.id)).toMatchObject({ ok: true });
    await one("select public.set_chapter_budget_office($1, $2, $3, 'treasurer') as r", [w.org, w.a, w.member.id], w.admin);
    const [office] = await entries("public.member_chapter_memberships", `o:${w.member.id}:${w.a}`);
    expect(await undo(w.admin, office.id)).toMatchObject({ ok: true });
    expect(await membership(w.member, w.a)).toMatchObject({ display_title: null, budget_office: null });
  });
  // Round 1 repairs (#7026): each case below failed on the round 1 head.
  it("refuses to undo a chapter grant that is the member's only chapter (s1)", async () => {
    const chapterless = await person([]);
    await start();
    await one("select public.grant_member_chapter_membership($1, $2) as r", [chapterless.id, w.b], w.admin);
    const [entry] = await entries("public.member_chapter_memberships", `m:${chapterless.id}:${w.b}`);
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: false, code: "22023" });
    expect((await membership(chapterless, w.b)).status).toBe("active");
    expect((await entries("public.member_chapter_memberships", `m:${chapterless.id}:${w.b}`))[0]).toMatchObject({ state: "active", version: 1 });
  });

  it("puts back the pin and budget office a chapter removal cleared (s2)", async () => {
    await one("select public.set_chapter_budget_office($1, $2, $3, 'treasurer') as r", [w.org, w.a, w.both.id], w.admin);
    await c.query("update public.member_chapter_memberships set pinned = true where user_id = $1 and chapter_id = $2", [w.both.id, w.a]);
    await start();
    await one("select public.revoke_member_chapter_membership($1, $2) as r", [w.both.id, w.a], w.admin);
    expect(await membership(w.both, w.a)).toMatchObject({ status: "revoked", pinned: false, budget_office: null });
    const [entry] = await entries("public.member_chapter_memberships", `m:${w.both.id}:${w.a}`);
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect(await membership(w.both, w.a)).toMatchObject({ status: "active", pinned: true, budget_office: "treasurer" });
  });

  it("restores an email choice that was unset before the practice change (s3)", async () => {
    const prefs = async () => (await q("select notification_prefs from public.member_profiles where id = $1", [w.member.id]))[0].notification_prefs;
    const original = await prefs();
    expect(original).not.toHaveProperty("announcements");
    await start();
    await one("select public.update_my_member_profile($1, $2::jsonb) as r", [w.member.id, JSON.stringify({ notification_prefs: { ...original, announcements: false } })], w.member);
    expect((await prefs()).announcements).toBe(false);
    const [entry] = await entries("public.member_profiles", w.member.id);
    expect(await undo(w.member, entry.id)).toMatchObject({ ok: true });
    expect(await prefs()).toEqual(original);
    // An ordinary partial write still keeps a stored choice it did not send,
    // the onboarding reminder choice (20261104090000) included.
    await c.query("update public.member_profiles set notification_prefs = notification_prefs || '{\"surveys\": false, \"onboarding\": false}' where id = $1", [w.member.id]);
    await c.query("update public.member_profiles set notification_prefs = $2 where id = $1", [w.member.id, JSON.stringify(original)]);
    expect(await prefs()).toMatchObject({ surveys: false, onboarding: false });
  });

  it("does not refuse a save whose before-image is over the journal bound (s4)", async () => {
    await start();
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: w.admin.id, session_id: w.admin.session, aal: "aal2" })]);
    // Over the bound installed today (16,384 bytes) and the 32,768 bytes slice 5 raises it to.
    const big = { overridden: true, value: "x".repeat(40000) };
    const result = await q("select private.learning_membership_journal('organization_setting_change', 'public.organization_setting_values', $1, $2::jsonb) as r",
      [`${w.org}:features.ai_assistant.action_offers`, JSON.stringify(big)]);
    expect(result[0].r).toBeNull();
  });

  it("keeps a permanent entry when an administrator removes their own last chapter (s5)", async () => {
    await start();
    await one("select public.revoke_member_chapter_membership($1, $2) as r", [w.admin.id, w.a], w.admin);
    expect(await entries("public.member_chapter_memberships", `m:${w.admin.id}:${w.a}`)).toEqual([
      expect.objectContaining({ action_kind: "chapter_membership_revoke_final", state: "kept", actor_user_id: w.admin.id }),
    ]);
  });
  it("still undoes an earlier slice's action through the hand-off to the installed dispatcher", async () => {
    // A later slice may hand off in front of this one (20261104120000 moves it
    // to private.learning_dispatch_before_case_access), so find slice 7's
    // dispatcher in the chain by its own branch.
    const chain = await q("select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'learning\\_dispatch%'");
    const own = chain.map((fn) => fn.d).find((d) => d.includes("when 'private.learning_undo_own_profile' then")) ?? "";
    expect(own).not.toContain("private.learning_undo_task");
    expect(own).toContain("private.learning_dispatch_before_membership(p_handler, p_mode, p_entry)");
    await c.query("insert into public.chapter_workstreams(chapter_id,name) values ($1,'General') on conflict do nothing", [w.a]);
    await start();
    const task = (await call("select * from public.create_chapter_task($1::jsonb)", [JSON.stringify({ title: "Practice task" })], w.admin)).rows[0];
    const [entry] = await entries("public.chapter_tasks", task.id);
    expect(entry.action_kind).toBe("task_create");
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect((await q("select deleted_at is not null as deleted from public.chapter_tasks where id = $1", [task.id]))[0].deleted).toBe(true);
  });
  // Round 2 repairs (#7026): each case below failed on the round 2 head.
  it("lets an organization administrator with no chapter undo their own chapter grant (r2s1)", async () => {
    const chapterlessAdmin = await person([], { orgRoles: ["admin"] });
    await start();
    await one("select public.grant_member_chapter_membership($1, $2) as r", [w.member.id, w.b], chapterlessAdmin);
    const [entry] = await entries("public.member_chapter_memberships", `m:${w.member.id}:${w.b}`);
    expect(entry).toMatchObject({ action_kind: "chapter_membership_grant", actor_user_id: chapterlessAdmin.id });
    expect(await undo(chapterlessAdmin, entry.id)).toMatchObject({ ok: true });
    expect((await membership(w.member, w.b)).status).toBe("revoked");
    expect((await q("select organization_id from public.member_admin_audit where actor = $1 and action = 'revoke_chapter_membership'", [chapterlessAdmin.id]))).toEqual([{ organization_id: null }]);
  });

  it("restores a budget office the removal cleared in a chapter the administrator has not selected (r2g1)", async () => {
    await c.query("update public.member_chapter_memberships set budget_office = 'treasurer' where user_id = $1 and chapter_id = $2", [w.both.id, w.b]);
    await start();
    await one("select public.revoke_member_chapter_membership($1, $2) as r", [w.both.id, w.b], w.admin);
    const [entry] = await entries("public.member_chapter_memberships", `m:${w.both.id}:${w.b}`);
    expect(await undo(w.admin, entry.id)).toMatchObject({ ok: true });
    expect(await membership(w.both, w.b)).toMatchObject({ status: "active", budget_office: "treasurer" });
  });

  it("refuses a profile save for an account the session no longer belongs to (r2s2)", async () => {
    const before = (await q("select full_name, language from public.member_profiles where id = $1", [w.admin.id]))[0];
    expect(await call("select public.update_my_member_profile($1, '{\"full_name\": \"Account A\", \"language\": \"es\"}'::jsonb) as r", [w.member.id], w.admin))
      .toMatchObject({ ok: false, code: "42501" });
    expect((await q("select full_name, language from public.member_profiles where id = $1", [w.admin.id]))[0]).toEqual(before);
  });
});
