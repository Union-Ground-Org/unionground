// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { parseFunctions, helperFirst } from "../scripts/account-case-graph-inventory.mjs";
import { defaultWorkloadDefinition } from "../src/lib/workloadConfiguration.js";
import { fictionalWorkloadConfigurations, largeWorkloadDefinition } from "./fixtures/workloadConfigurations.js";

const migrationStamp = "20261105192000";
const sql = readFileSync(`supabase/migrations/${migrationStamp}_organization_workload_configuration.sql`, "utf8");
describe("organization workload configuration migration", () => {
  it("sorts after 20261104123000 without requiring the last migration slot", () => {
    expect(migrationStamp > "20261104123000").toBe(true);
  });
  it("sorts after the reserved 190000 and 191000 lanes without requiring the last slot", () => {
    expect(migrationStamp > "20261105190000").toBe(true);
    expect(migrationStamp > "20261105191000").toBe(true);
  });
  it("pins the same usable default on the server and web", () => {
    const literal = sql.match(/result jsonb := '([^']+)'::jsonb/)[1];
    expect(JSON.parse(literal)).toEqual(defaultWorkloadDefinition());
  });
  it("admits every new writer through the account graph before declarations", () => {
    for (const name of ["public.save_organization_workload_configuration", "public.save_configured_workload_log", "private.stamp_workload_configuration"]) {
      expect(helperFirst(parseFunctions(sql).find((f) => f.name === name).source), name).toBe(true);
    }
    expect(sql).toContain("force row level security");
    expect(sql).toContain("revoke all on table private.organization_workload_configuration_versions from public, anon, authenticated, service_role");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("organization workload configuration on an owned disposable database", () => {
  let c; let world;
  beforeAll(async () => { c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) }); await c.connect(); });
  afterAll(async () => { await c?.end(); });
  async function call(text, values = [], user = null, aal = "aal2") {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user ? { role: "authenticated", sub: user.id, session_id: user.session, aal } : { role: "anon" })]);
      await c.query(user ? "set local role authenticated" : "set local role anon");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role"); await c.query("release savepoint call"); return { ok: true, rows };
    } catch (e) { await c.query("rollback to savepoint call"); await c.query("release savepoint call"); return { ok: false, code: e.code, message: e.message, details: e.detail }; }
  }
  const read = (u) => call("select public.get_organization_workload_configuration() result", [], u);
  const save = (u, d, v = 0) => call("select public.save_organization_workload_configuration($1,$2,$3) result", [d, v, u?.orgId || null], u);
  const entry = (u, values, status = "complete", version = 1, id = null) => call("select public.save_configured_workload_log($1,$2,$3,$4,$5) result", [id, version, values, status, u?.orgId || null], u);
  beforeEach(async () => {
    await c.query("begin"); world = {};
    for (const [index, fixture] of fictionalWorkloadConfigurations().entries()) {
      const org = { id: randomUUID(), chapter: `test-workload-${randomUUID()}`, definition: fixture.definition };
      world[index === 0 ? "a" : "b"] = org;
      await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org.id, org.chapter, fixture.name]);
      await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98191)", [org.chapter, org.id]);
      for (const role of ["admin", "member", "steward"]) {
        const u = { id: randomUUID(), session: randomUUID(), orgId: org.id }; org[role] = u;
        await c.query("insert into auth.users(id,email) values ($1,$2)", [u.id, `${u.id}@example.invalid`]);
        await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [org.id, u.id]);
        await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [u.id, org.chapter]);
        await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [u.id, org.chapter]);
        if (role !== "member") {
          await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org.id, u.id, role]);
          await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [u.id, role, org.chapter]);
        }
        await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), u.id]);
        await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [u.session, u.id]);
      }
    }
  });
  afterEach(async () => { await c.query("rollback"); });
  async function configure() {
    for (const org of [world.a, world.b]) {
      const result = await save(org.admin, org.definition);
      expect(result).toMatchObject({ ok: true });
      expect(result.rows[0].result).toMatchObject({ organizationId: org.id, version: 1, definition: org.definition });
    }
  }
  it("keeps defaults and organization category labels until the first apply", async () => {
    expect((await read(world.a.member)).rows[0].result).toMatchObject({ version: 0, canEdit: false, definition: defaultWorkloadDefinition(), history: [] });
    expect(await call("select public.update_organization_label('workload.cat.priority','Urgent work')", [], world.a.admin)).toMatchObject({ ok: true });
    expect((await read(world.a.member)).rows[0].result.definition.fields[0].label).toBe("Urgent work");
    expect((await read(world.b.member)).rows[0].result.definition.fields[0].label).toBe("workload.cat.priority");
  });
  it("audits bounded version references while retaining full large definitions across applies", async () => {
    const large = largeWorkloadDefinition();
    const bytes = (await c.query('select octet_length($1::jsonb::text) n', [large])).rows[0].n;
    expect(bytes).toBeGreaterThan(16384); expect(bytes).toBeLessThan(32768);
    expect(await save(world.a.admin, large)).toMatchObject({ ok: true });
    const second = { ...large, title: 'Fictional large report revision' };
    expect(await save(world.a.admin, second, 1)).toMatchObject({ ok: true });
    const history = (await read(world.a.admin)).rows[0].result.history;
    expect(history.map(row => row.definition)).toEqual([second, large]);
    const audits = (await c.query("select previous_value,new_value from public.organization_configuration_audit where organization_id=$1 and item_key='workload.configuration' order by (new_value->>'version')::int", [world.a.id])).rows;
    expect(audits).toEqual([1, 2].map(version => ({ previous_value: { organizationId: world.a.id, version: version - 1 }, new_value: { organizationId: world.a.id, version } })));
    for (const row of audits) expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(512);
  });
  it("isolates materially different definitions and denies non-admin writes and weak sessions", async () => {
    await configure();
    expect((await read(world.a.member)).rows[0].result.definition).toEqual(world.a.definition);
    expect((await read(world.b.member)).rows[0].result.definition).toEqual(world.b.definition);
    for (const u of [world.a.member, world.a.steward, null]) expect(await save(u, world.a.definition, 1)).toMatchObject({ ok: false, code: "42501" });
    expect(await read(null)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.get_organization_workload_configuration()", [], world.a.admin, "aal1")).toMatchObject({ ok: false, code: "42501" });
    expect((await read(world.a.admin)).rows[0].result.history).toHaveLength(1);
    expect((await read(world.b.admin)).rows[0].result.history[0].definition.title).toBe("Park maintenance log");
    expect(await call("select public.save_organization_workload_configuration($1,1,$2)", [world.a.definition, world.b.id], world.a.admin)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.save_configured_workload_log(null,1,$1,'complete',$2)", [{ visits: 2, shift: "morning" }, world.b.id], world.a.member)).toMatchObject({ ok: false, code: "42501" });
  });
  it("denies direct storage reads and mutations to clients", async () => {
    for (const u of [world.a.admin, world.b.admin, null]) {
      expect(await call("select * from private.organization_workload_configuration_versions", [], u)).toMatchObject({ ok: false, code: "42501" });
      expect(await call("delete from private.organization_workload_configuration_versions", [], u)).toMatchObject({ ok: false, code: "42501" });
      expect(await call("update public.member_workload_logs set workload_values='{}'", [], u)).toMatchObject({ ok: false, code: "42501" });
    }
  });
  it("validates create/edit flows and keeps the original snapshot after retirement", async () => {
    await configure();
    const created = await entry(world.a.member, { visits: 7, shift: "morning", hoursWorked: 4 }); expect(created).toMatchObject({ ok: true });
    const id = created.rows[0].result.id;
    expect(await entry(world.b.member, { visits: 8, shift: "evening" }, "complete", 1, id)).toMatchObject({ ok: false, code: "42501" });
    const updated = structuredClone(world.a.definition);
    updated.fields.find((f) => f.key === "visits").retired = true; updated.fields.find((f) => f.key === "visits").required = false;
    updated.fields.find((f) => f.key === "hoursWorked").label = "Time on duty";
    expect(await save(world.a.admin, updated, 1)).toMatchObject({ ok: true });
    expect(await entry(world.a.member, { visits: 9, shift: "evening", hoursWorked: 5 }, "complete", 1, id)).toMatchObject({ ok: true });
    const row = (await call("select workload_configuration, workload_values, sub_details from public.member_workload_logs where id=$1", [id], world.a.member)).rows[0];
    expect(row.workload_configuration.version).toBe(1);
    expect(row.workload_configuration.definition).toEqual(world.a.definition);
    expect(row.workload_values.visits).toBe(9);
    expect(row.sub_details.configuration.definition).toEqual(world.a.definition);
    expect(row.sub_details.values.visits).toBe(9);
    expect((await call("select id from public.member_workload_logs where id=$1", [id], world.b.admin)).rows).toEqual([]);
    expect(await entry(world.a.member, { visits: 9, shift: "evening" }, "complete", 2)).toMatchObject({ ok: false, code: "22023" });
  });
  it("supports the second organization's typed fields and refuses the first organization's values", async () => {
    await configure();
    expect(await entry(world.b.member, { distance: 5.5, equipmentChecked: false, location: "North meadow" }, "done")).toMatchObject({ ok: true });
    expect(await entry(world.b.member, { visits: 5, shift: "morning" }, "done")).toMatchObject({ ok: false, code: "22023" });
    expect(await entry(world.a.member, { visits: 5, shift: "morning" }, "done")).toMatchObject({ ok: false, code: "22023" });
  });
  it("rejects missing fields, wrong types, unknown fields and invalid dates without consuming quota", async () => {
    await configure();
    for (const values of [{ visits: 2 }, { visits: "2", shift: "morning" }, { visits: 2, shift: "night" }, { visits: -1, shift: "morning" }, { visits: 2, shift: "morning", hidden: 1 }, { visits: 2, shift: "morning", workedOn: "2026-02-30" }, { visits: 2, shift: "morning", hoursWorked: 1.1 }]) {
      expect(await entry(world.a.member, values), JSON.stringify(values)).toMatchObject({ ok: false, code: "22023" });
    }
    expect((await c.query("select count(*)::int n from public.member_workload_logs where user_id=$1", [world.a.member.id])).rows[0].n).toBe(0);
    expect(await entry(world.a.member, { visits: 2, shift: "morning" })).toMatchObject({ ok: true });
  });
  it("rejects stale applies, malformed definitions, field deletion and retired key reuse", async () => {
    await configure();
    expect(await save(world.a.admin, world.a.definition, 0)).toMatchObject({ ok: false, code: "PT409" });
    for (const patch of [{ statuses: [] }, { fields: [] }, { title: "<script>" }, { period: "arbitrary" }, { fields: world.a.definition.fields.slice(1) }]) {
      expect(await save(world.a.admin, { ...world.a.definition, ...patch }, 1)).toMatchObject({ ok: false, code: "22023" });
    }
    for (const [key, patch] of [["employment", { options: ["unexpected"] }], ["priority", { unit: "hours" }]]) {
      const invalid = structuredClone(world.a.definition); Object.assign(invalid.fields.find((f) => f.key === key), patch);
      expect(await save(world.a.admin, invalid, 1)).toMatchObject({ ok: false, code: "22023" });
    }
    const retired = structuredClone(world.a.definition); Object.assign(retired.fields.at(-1), { retired: true, required: false });
    expect(await save(world.a.admin, retired, 1)).toMatchObject({ ok: true });
    expect(await save(world.a.admin, world.a.definition, 2)).toMatchObject({ ok: false, code: "22023" });
  });
  it("preserves the three-per-day limit and never awards points for edits", async () => {
    await configure();
    const values = { visits: 2, shift: "morning" };
    const first = await entry(world.a.member, values); const id = first.rows[0].result.id;
    expect((await entry(world.a.member, values, "complete", 1, id)).rows[0].result.awardedPoints).toBe(0);
    expect(await entry(world.a.member, values)).toMatchObject({ ok: true }); expect(await entry(world.a.member, values)).toMatchObject({ ok: true });
    expect(await entry(world.a.member, values)).toMatchObject({ ok: false, code: "22023", details: "workload_daily_limit" });
  });
  it("A preserves unrelated metadata and refreshes all stored value aliases on edit", async () => {
    await configure();
    const result = await entry(world.a.member, { visits: 7, shift: "morning", hoursWorked: 4 });
    const id = result.rows[0].result.id;
    await c.query("update public.member_workload_logs set sub_details=sub_details || $2::jsonb where id=$1", [id, { source: "shift-import", imported: { batch: "fictional-batch" } }]);
    expect(await entry(world.a.member, { visits: 9, shift: "evening", hoursWorked: 5 }, "complete", 1, id)).toMatchObject({ ok: true });
    const row = (await c.query("select sub_details from public.member_workload_logs where id=$1", [id])).rows[0];
    expect(row.sub_details).toMatchObject({ source: "shift-import", imported: { batch: "fictional-batch" }, workloadVersion: 1, workloadValues: { visits: 9, shift: "evening", hoursWorked: 5 }, workloadStatus: "complete", values: { visits: 9 } });
    const exported = await call("select public.get_member_data_export() result", [], world.a.member);
    expect(exported).toMatchObject({ ok: true });
    expect(JSON.stringify(exported.rows[0].result)).toContain("shift-import");
    expect(JSON.stringify(exported.rows[0].result)).toContain("fictional-batch");
  });
  it("B stores omitted original measurements as unknown, including in account exports", async () => {
    await configure();
    const result = await entry(world.a.member, { visits: 7, shift: "morning" });
    const row = (await c.query("select priority,employment,on_plan,ot_worked,ot_hours,weekly_assigned,workload_values from public.member_workload_logs where id=$1", [result.rows[0].result.id])).rows[0];
    expect(row).toMatchObject({ priority: null, employment: null, on_plan: null, ot_worked: null, ot_hours: null, weekly_assigned: null, workload_values: { visits: 7, shift: "morning" } });
    const exported = await call("select public.get_member_data_export() result", [], world.a.member);
    expect(exported).toMatchObject({ ok: true });
    expect(JSON.stringify(exported.rows[0].result)).toContain('"priority":null');
  });
  async function cohortRows(users, custom, later = false) {
    await read(world.a.admin);
    for (const id of users) {
      const details = custom ? { workloadVersion: 1, workloadValues: { visits: 7, shift: "morning" }, workloadStatus: "complete" } : {};
      // Previous completed quarter and two completed weeks exercise all five
      // aggregate queries, including both contributor-floor computations.
      for (const period of ["date_trunc('quarter', now()) - interval '2 months'", "date_trunc('week', now()) - interval '2 weeks'", "date_trunc('week', now()) - interval '1 week'"]) {
        await c.query(`insert into public.member_workload_logs(user_id,receipt_code,priority,pending,unread_docs,todos,referrals,ce_activities,assistance_requests,aged_cases,sub_details,created_at)
          values ($1,$2,${custom ? '0,0,0,0,0,0,0,0' : '7,7,7,7,7,7,7,7'},$3,${period} + interval '${later ? 2 : 1} hours')`, [id, randomUUID().replaceAll("-", "").slice(0, 8), details]);
      }
    }
  }
  async function cohortUsers(count = 25) {
    const ids = Array.from({ length: count }, () => randomUUID());
    for (const id of ids) {
      await c.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
      await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, world.a.chapter]);
    }
    return ids;
  }
  const measuredCounts = count => Object.fromEntries(defaultWorkloadDefinition().fields.filter(f => f.kind === 'category').map(f => [f.key, count]));
  function hiddenDefinition(keys, retired = false) {
    const d = defaultWorkloadDefinition();
    for (const key of keys) Object.assign(d.fields.find(f => f.key === key), retired ? { retired: true, required: false } : { visible: false, required: false });
    return d;
  }
  async function configuredCohort(users, values, version = 1, offset = 2) {
    await read(world.a.admin);
    for (const id of users) for (const period of ["date_trunc('quarter', now()) - interval '2 months'", "date_trunc('week', now()) - interval '2 weeks'", "date_trunc('week', now()) - interval '1 week'"]) {
      await c.query(`insert into public.member_workload_logs(user_id,receipt_code,sub_details,created_at) values ($1,$2,$3,${period} + interval '${offset} hours')`, [id, randomUUID().slice(0,8), { workloadVersion: version, workloadValues: values, workloadStatus: 'logged' }]);
    }
  }
  async function collectiveReports() {
    const stats = await call('select public.get_workload_stats() result', [], world.a.admin);
    const trends = await call('select public.get_steward_workload_intelligence(12) result', [], world.a.admin);
    expect(stats).toMatchObject({ ok: true }); expect(trends).toMatchObject({ ok: true });
    return { stats: stats.rows[0].result, trends: trends.rows[0].result };
  }
  it.each([
    ['overtime', false, ['otWorked', 'otHours']], ['employment', false, ['employment', 'ptHours']],
    ['both', false, ['employment', 'ptHours', 'otWorked', 'otHours']],
    ['overtime', true, ['otWorked', 'otHours']], ['employment', true, ['employment', 'ptHours']],
  ])("keeps hidden or retired %s measurements in both cohorts (retired=%s)", async (_name, retired, keys) => {
    const ids = await cohortUsers();
    expect(await save(world.a.admin, hiddenDefinition(keys, retired))).toMatchObject({ ok: true });
    const values = { ...measuredCounts(9), ...(!keys.includes('employment') ? { employment: 'full_time' } : {}), ...(!keys.includes('otHours') ? { otWorked: false } : {}) };
    await configuredCohort(ids, values);
    const { stats, trends } = await collectiveReports();
    expect(stats).toMatchObject({ enoughData: true, tiles: { pctFullTime: keys.includes('employment') ? null : 100, pctPartTime: keys.includes('employment') ? null : 0, avgOtHours: keys.includes('otHours') ? null : 0 } });
    for (const category of stats.categories) expect(category).toMatchObject({ avg: 9, median: 9, p90: 9 });
    expect(trends).toMatchObject({ available: true, eligibleWeeks: 2 });
    for (const category of trends.categories) expect(category).toMatchObject({ latest: 9, slope: 0 });
    const stored = (await c.query('select employment,ot_hours from public.member_workload_logs where user_id=$1 limit 1', [ids[0]])).rows[0];
    expect(stored).toEqual({ employment: keys.includes('employment') ? null : 'full_time', ot_hours: keys.includes('otHours') ? null : 0 });
  });
  it.each([{ employment: 'full_time' }, { otWorked: false }, {}])("excludes unknown visible measurements consistently: %j", async answers => {
    const ids = await cohortUsers();
    expect(await save(world.a.admin, defaultWorkloadDefinition())).toMatchObject({ ok: true });
    await configuredCohort(ids, { ...measuredCounts(9), ...answers });
    const { stats, trends } = await collectiveReports();
    expect(stats).toMatchObject({ enoughData: false, reason: 'anonymity_floor' });
    expect(trends).toMatchObject({ available: false, reason: 'anonymity_floor', eligibleWeeks: 0 });
  });
  // #7180: a hidden, retired or skipped original category is stored as unknown.
  // The entry still counts for what it measured; each category is published
  // only over measured values with its own 25-contributor floor.
  const categoryKeys = () => defaultWorkloadDefinition().fields.filter(f => f.kind === 'category').map(f => f.key);
  it.each([false, true])("keeps counting entries when an original category is hidden or retired (retired=%s)", async retired => {
    const ids = await cohortUsers();
    expect(await save(world.a.admin, hiddenDefinition(['aged_cases'], retired))).toMatchObject({ ok: true });
    const { aged_cases: _hidden, ...answered } = measuredCounts(9);
    await configuredCohort(ids, { ...answered, employment: 'full_time', otWorked: false });
    expect((await c.query('select aged_cases from public.member_workload_logs where user_id=$1 limit 1', [ids[0]])).rows[0].aged_cases).toBeNull();
    const { stats, trends } = await collectiveReports();
    expect(stats).toMatchObject({ enoughData: true, submittersBand: '25-49', tiles: { pctFullTime: 100, avgOtHours: 0 } });
    expect(stats.categories.map(category => category.key)).toEqual(categoryKeys().filter(key => key !== 'aged_cases'));
    for (const category of stats.categories) expect(category).toMatchObject({ avg: 9, median: 9, p90: 9 });
    expect(trends).toMatchObject({ available: true, eligibleWeeks: 2 });
    expect(trends.categories.map(category => category.key)).toEqual(categoryKeys().filter(key => key !== 'aged_cases'));
    for (const category of trends.categories) expect(category).toMatchObject({ latest: 9, slope: 0, points: 2 });
  });
  it.each([[25, true], [24, false]])("aggregates a skipped visible category only over measured values (%s measured)", async (measured, shown) => {
    const ids = await cohortUsers(30);
    expect(await save(world.a.admin, defaultWorkloadDefinition())).toMatchObject({ ok: true });
    const { todos: _skipped, ...answered } = measuredCounts(9);
    const values = { ...answered, employment: 'full_time', otWorked: false };
    await configuredCohort(ids.slice(0, measured), { ...values, todos: 9 });
    await configuredCohort(ids.slice(measured), values);
    const { stats, trends } = await collectiveReports();
    expect(stats).toMatchObject({ enoughData: true, submittersBand: '25-49' });
    expect(trends).toMatchObject({ available: true, eligibleWeeks: 2 });
    const expected = categoryKeys().filter(key => shown || key !== 'todos');
    expect(stats.categories.map(category => category.key)).toEqual(expected);
    expect(trends.categories.map(category => category.key)).toEqual(expected);
    // Unknown values never enter the 150 cap or count as zero.
    for (const category of stats.categories) expect(category).toMatchObject({ avg: 9, median: 9, p90: 9 });
    for (const category of trends.categories) expect(category).toMatchObject({ latest: 9, slope: 0 });
  });
  it("reports too few weeks when no category has two publishable weekly points", async () => {
    const ids = await cohortUsers();
    expect(await save(world.a.admin, defaultWorkloadDefinition())).toMatchObject({ ok: true });
    await read(world.a.admin);
    for (const id of ids) for (const [period, measured] of [["date_trunc('week', now()) - interval '2 weeks'", { priority: 9 }], ["date_trunc('week', now()) - interval '1 week'", { pending: 9 }]]) {
      await c.query(`insert into public.member_workload_logs(user_id,receipt_code,sub_details,created_at) values ($1,$2,$3,${period} + interval '2 hours')`,
        [id, randomUUID().slice(0,8), { workloadVersion: 1, workloadValues: { ...measured, employment: 'full_time', otWorked: false }, workloadStatus: 'logged' }]);
    }
    const { trends } = await collectiveReports();
    expect(trends).toMatchObject({ available: false, reason: 'insufficient_weeks', eligibleWeeks: 2, categories: [] });
  });
  it("uses each saved snapshot before latest-row selection and never the active definition", async () => {
    const ids = await cohortUsers(), hidden = hiddenDefinition(['employment', 'ptHours', 'otWorked', 'otHours']);
    expect(await save(world.a.admin, hidden)).toMatchObject({ ok: true });
    await configuredCohort(ids, measuredCounts(9));
    expect(await save(world.a.admin, defaultWorkloadDefinition(), 1)).toMatchObject({ ok: true });
    await configuredCohort(ids, measuredCounts(50), 2, 3);
    for (const version of [2, 3]) {
      if (version === 3) expect(await save(world.a.admin, hidden, 2)).toMatchObject({ ok: true });
      const { stats, trends } = await collectiveReports();
      expect(stats).toMatchObject({ enoughData: true });
      for (const category of stats.categories) expect(category.avg).toBe(9);
      expect(trends).toMatchObject({ available: true, eligibleWeeks: 2 });
      for (const category of trends.categories) expect(category.latest).toBe(9);
    }
  });
  it.each([1, 24])("withholds individual tiles when their measured contributor set is below the privacy floor (%s hidden)", async hiddenCount => {
    const ids = await cohortUsers(); await cohortRows(ids, false);
    expect(await save(world.a.admin, hiddenDefinition(['employment', 'ptHours', 'otWorked', 'otHours']))).toMatchObject({ ok: true });
    await configuredCohort(ids.slice(0, hiddenCount), measuredCounts(9));
    const { stats, trends } = await collectiveReports();
    expect(stats).toMatchObject({ enoughData: true, tiles: { pctFullTime: null, pctPartTime: null, avgOtHours: null } });
    expect(trends).toMatchObject({ available: true, eligibleWeeks: 2 });
  });
  it("never exempts a legacy null snapshot using the current hidden definition", async () => {
    const ids = await cohortUsers();
    expect(await save(world.a.admin, hiddenDefinition(['employment', 'ptHours', 'otWorked', 'otHours']))).toMatchObject({ ok: true });
    await c.query("select set_config('request.jwt.claims','{}',true)");
    for (const id of ids) for (const period of ["date_trunc('quarter', now()) - interval '2 months'", "date_trunc('week', now()) - interval '2 weeks'", "date_trunc('week', now()) - interval '1 week'"]) {
      await c.query(`insert into public.member_workload_logs(user_id,receipt_code,priority,pending,unread_docs,todos,referrals,ce_activities,assistance_requests,aged_cases,employment,ot_hours,created_at) values ($1,$2,9,9,9,9,9,9,9,9,null,null,${period})`, [id, randomUUID().slice(0,8)]);
    }
    const { stats, trends } = await collectiveReports();
    expect(stats).toMatchObject({ enoughData: false, reason: 'anonymity_floor' });
    expect(trends).toMatchObject({ available: false, eligibleWeeks: 0 });
  });
  it("B excludes custom-only logs from both quarterly and weekly privacy floors", async () => {
    const ids = await cohortUsers(); await configure(); await cohortRows(ids, true);
    const stats = await call("select public.get_workload_stats() result", [], world.a.admin);
    expect(stats).toMatchObject({ ok: true });
    expect(stats.rows[0].result).toMatchObject({ enoughData: false, reason: "anonymity_floor" });
    const trends = await call("select public.get_steward_workload_intelligence(12) result", [], world.a.admin);
    expect(trends).toMatchObject({ ok: true });
    expect(trends.rows[0].result).toMatchObject({ available: false, eligibleWeeks: 0, categories: [] });
  });
  it("B selects the latest qualifying measurement before computing floors, categories and tiles", async () => {
    const ids = await cohortUsers(); await cohortRows(ids, false);
    await configure(); await cohortRows(ids, true, true);
    const stats = await call("select public.get_workload_stats() result", [], world.a.admin);
    expect(stats).toMatchObject({ ok: true });
    expect(stats.rows[0].result).toMatchObject({ enoughData: true, tiles: { pctFullTime: 100, avgOtHours: 0 } });
    expect(stats.rows[0].result.categories).toHaveLength(8);
    for (const category of stats.rows[0].result.categories) expect(category).toMatchObject({ avg: 7, median: 7, p90: 7 });
    const trends = await call("select public.get_steward_workload_intelligence(12) result", [], world.a.admin);
    expect(trends).toMatchObject({ ok: true });
    expect(trends.rows[0].result).toMatchObject({ available: true, eligibleWeeks: 2 });
    for (const category of trends.rows[0].result.categories) expect(category).toMatchObject({ latest: 7, slope: 0 });
  });
  it("C rejects contradictory overtime before either create or edit can split the stored representations", async () => {
    const d = defaultWorkloadDefinition();
    expect(await save(world.a.admin, d)).toMatchObject({ ok: true });
    expect(await entry(world.a.member, { otWorked: true, otHours: 0 }, "logged")).toMatchObject({ ok: false, code: "22023" });
    const created = await entry(world.a.member, { otWorked: true, otHours: 2 }, "logged");
    expect(created).toMatchObject({ ok: true });
    const id = created.rows[0].result.id;
    expect(await entry(world.a.member, { otWorked: true, otHours: 0 }, "logged", 1, id)).toMatchObject({ ok: false, code: "22023" });
    expect(await entry(world.a.member, { otWorked: true, otHours: 3 }, "logged", 1, id)).toMatchObject({ ok: true });
    const row = (await c.query("select ot_hours,workload_values,sub_details from public.member_workload_logs where id=$1", [id])).rows[0];
    expect(row.ot_hours).toBe(3);
    expect(row.workload_values.otHours).toBe(3);
    expect(row.sub_details.values.otHours).toBe(3);
  });
  it("B/C applies the same projection and validation to configured transport through the legacy RPC", async () => {
    expect(await save(world.a.admin, defaultWorkloadDefinition())).toMatchObject({ ok: true });
    const submit = (values) => call("select public.submit_workload_log(99,99,99,99,99,99,99,99,99,'full_time',null,false,false,0,null,null,false,false,null,$1) result",
      [{ workloadVersion: 1, workloadValues: values, workloadStatus: "logged" }], world.a.member);
    expect(await submit({ otWorked: true, otHours: 0 })).toMatchObject({ ok: false, code: "22023" });
    expect(await submit({ employment: "part_time" })).toMatchObject({ ok: false, code: "22023" });
    expect(await submit({ leaveType: "sick_leave" })).toMatchObject({ ok: false, code: "22023" });
    const result = await submit({ otWorked: true, otHours: 2 });
    expect(result).toMatchObject({ ok: true });
    const row = (await c.query("select priority,employment,ot_worked,ot_hours,workload_values from public.member_workload_logs where id=$1", [result.rows[0].result.id])).rows[0];
    expect(row).toEqual({ priority: null, employment: null, ot_worked: true, ot_hours: 2, workload_values: { otWorked: true, otHours: 2 } });
  });
  it("keeps legacy defaults and overtime normalization unchanged before any configuration is applied", async () => {
    const result = await call("select public.submit_workload_log(null,null,null,null,null,null,null,null,null,null,null,null,true,0,null,null,null,null,null,null) result", [], world.a.member);
    expect(result).toMatchObject({ ok: true });
    const row = (await c.query("select priority,weekly_assigned,employment,on_plan,ot_worked,ot_hours,workload_values from public.member_workload_logs where id=$1", [result.rows[0].result.id])).rows[0];
    expect(row).toMatchObject({ priority: 0, weekly_assigned: 15, employment: "full_time", on_plan: false, ot_worked: true, ot_hours: 1, workload_values: { otWorked: true, otHours: 1 } });
  });
  it.each([['employment', 'ptHours'], ['otWorked', 'otHours'], ['leaveType', 'leaveTiming']])("rejects unavailable %s dependencies, including hidden and retired answers", async (controller, dependent) => {
    for (const state of ['hidden', 'retired']) {
      const d = defaultWorkloadDefinition();
      Object.assign(d.fields.find(f => f.key === dependent), state === 'hidden' ? { visible: false } : { retired: true });
      if (controller === 'employment') Object.assign(d.fields.find(f => f.key === controller), { required: true, options: ['part_time'] });
      expect(await save(world.a.admin, d)).toMatchObject({ ok: false, code: '22023' });
      Object.assign(d.fields.find(f => f.key === controller), { visible: false, required: false });
      await c.query('select private.validate_workload_definition($1)', [d]);
    }
    const fullTime = defaultWorkloadDefinition();
    fullTime.fields.find(f => f.key === 'employment').options = ['full_time'];
    fullTime.fields.find(f => f.key === 'ptHours').visible = false;
    await c.query('select private.validate_workload_definition($1)', [fullTime]);
  });
  it.each([undefined, null, ''])("canonicalizes explicit no overtime with absent hours %j on create, edit and export", async hours => {
    const d = defaultWorkloadDefinition();
    d.fields.find(f => f.key === 'otHours').required = true;
    expect(await save(world.a.admin, d)).toMatchObject({ ok: true });
    const values = { otWorked: false, ...(hours === undefined ? {} : { otHours: hours }) };
    const created = await entry(world.a.member, values, 'logged');
    expect(created).toMatchObject({ ok: true });
    const id = created.rows[0].result.id;
    for (const edit of [false, true]) {
      if (edit) expect(await entry(world.a.member, values, 'logged', 1, id)).toMatchObject({ ok: true });
      const row = (await c.query('select ot_worked,ot_hours,workload_values,sub_details from public.member_workload_logs where id=$1', [id])).rows[0];
      expect(row).toMatchObject({ ot_worked: false, ot_hours: 0, workload_values: { otWorked: false, otHours: 0 }, sub_details: { values: { otHours: 0 }, workloadValues: { otHours: 0 } } });
    }
    const exported = await call('select public.get_member_data_export() result', [], world.a.member);
    expect(exported).toMatchObject({ ok: true });
    expect(exported.rows[0].result.activity.workload).toEqual([expect.objectContaining({ overtimeHours: 0, subDetails: expect.objectContaining({ values: expect.objectContaining({ otHours: 0 }), workloadValues: expect.objectContaining({ otHours: 0 }) }) })]);
  });
  it.each([undefined, null, ''])("canonicalizes no overtime through the configured legacy transport %j", async hours => {
    expect(await save(world.a.admin, defaultWorkloadDefinition())).toMatchObject({ ok: true });
    const values = { otWorked: false, ...(hours === undefined ? {} : { otHours: hours }) };
    const created = await call("select public.submit_workload_log(99,99,99,99,99,99,99,99,99,'full_time',null,false,false,0,null,null,false,false,null,$1) result", [{ workloadVersion: 1, workloadValues: values, workloadStatus: 'logged' }], world.a.member);
    expect(created).toMatchObject({ ok: true });
    expect((await c.query('select ot_hours,workload_values,sub_details from public.member_workload_logs where id=$1', [created.rows[0].result.id])).rows[0]).toMatchObject({ ot_hours: 0, workload_values: { otWorked: false, otHours: 0 }, sub_details: { values: { otHours: 0 }, workloadValues: { otHours: 0 } } });
  });
  it("keeps unanswered overtime unknown and rejects hidden, contradictory and blank dependent answers", async () => {
    expect(await save(world.a.admin, defaultWorkloadDefinition())).toMatchObject({ ok: true });
    for (const values of [{ otWorked: false, otHours: 2 }, { otWorked: true }, { employment: 'part_time', ptHours: '' }, { leaveType: 'sick_leave', leaveTiming: '' }, { unexpected: null }]) {
      expect(await entry(world.a.member, values, 'logged')).toMatchObject({ ok: false, code: '22023' });
    }
    const created = await entry(world.a.member, {}, 'logged');
    expect(created).toMatchObject({ ok: true });
    const row = (await c.query('select ot_worked,ot_hours,workload_values from public.member_workload_logs where id=$1', [created.rows[0].result.id])).rows[0];
    expect(row).toEqual({ ot_worked: null, ot_hours: null, workload_values: {} });
  });
  it("includes the latest explicit no-overtime answer in quarterly and weekly cohorts", async () => {
    const ids = await cohortUsers(); await cohortRows(ids, false);
    expect(await save(world.a.admin, defaultWorkloadDefinition())).toMatchObject({ ok: true });
    await read(world.a.admin);
    const values = Object.fromEntries(defaultWorkloadDefinition().fields.filter(f => f.kind === 'category').map(f => [f.key, 9]));
    Object.assign(values, { employment: 'full_time', otWorked: false });
    for (const id of ids) for (const period of ["date_trunc('quarter', now()) - interval '2 months'", "date_trunc('week', now()) - interval '2 weeks'", "date_trunc('week', now()) - interval '1 week'"]) {
      await c.query(`insert into public.member_workload_logs(user_id,receipt_code,sub_details,created_at) values ($1,$2,$3,${period} + interval '2 hours')`, [id, randomUUID().slice(0,8), { workloadVersion: 1, workloadValues: values, workloadStatus: 'logged' }]);
    }
    const stats = (await call('select public.get_workload_stats() result', [], world.a.admin)).rows[0].result;
    expect(stats).toMatchObject({ enoughData: true, tiles: { avgOtHours: 0 } });
    for (const category of stats.categories) expect(category).toMatchObject({ avg: 9, median: 9, p90: 9 });
    const trends = (await call('select public.get_steward_workload_intelligence(12) result', [], world.a.admin)).rows[0].result;
    expect(trends).toMatchObject({ available: true, eligibleWeeks: 2 });
    for (const category of trends.categories) expect(category).toMatchObject({ latest: 9, slope: 0 });
  });
  it("keeps a legacy version-zero note and import metadata editable after the first apply", async () => {
    const raw = { source: "legacy-import", workedOn: "2026-11-01" };
    const result = await call("select public.submit_workload_log(1,2,3,4,5,6,7,8,15,'full_time',null,false,false,0,null,null,false,false,$1,$2) result", ["n".repeat(501), raw], world.a.member);
    expect(result).toMatchObject({ ok: true });
    const id = result.rows[0].result.id;
    const old = (await c.query("select workload_values from public.member_workload_logs where id=$1", [id])).rows[0].workload_values;
    await configure();
    expect(await entry(world.a.member, { ...old, priority: 9 }, "logged", 0, id)).toMatchObject({ ok: true });
    const row = (await c.query("select note,priority,sub_details from public.member_workload_logs where id=$1", [id])).rows[0];
    expect(row.note).toHaveLength(501); expect(row.priority).toBe(9); expect(row.sub_details.source).toBe("legacy-import");
  });
});
