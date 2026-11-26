// @vitest-environment node
// REQ-UG-NEURO-MAP-ORGANIZATION-SWITCH-20261112 (#8437) on an owned
// disposable database: the organization switch features.intelligence.neuro_map
// (default on, organization-editable) withholds the Neuro Map's relationship
// graph and topic progress from the server reads, and makes its two add-ons
// read as off whatever their stored values. Fixture rows are written by the
// table owner inside one rolled-back transaction; every product read runs as
// `authenticated` with a JWT claim set.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const NEURO_MAP = "features.intelligence.neuro_map";

live("Neuro Map organization switch on an owned disposable database", () => {
  let db;
  const ids = Object.fromEntries(["org", "admin", "adminSession", "steward", "stewardSession"].map((key) => [key, randomUUID()]));
  const prefix = `neuro-switch-${ids.org.slice(0, 8)}`;
  const chapter = `${prefix}-a`;
  const people = [];
  let lesson;

  async function as(user, session, sql, params = []) {
    await db.query("savepoint neuro_switch_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", session_id: session, aal: "aal2" })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, params);
      await db.query("reset role");
      await db.query("release savepoint neuro_switch_call");
      return { code: "", data: result.rows[0]?.data };
    } catch (error) {
      await db.query("rollback to savepoint neuro_switch_call");
      await db.query("release savepoint neuro_switch_call");
      return { code: error.code, message: error.message };
    }
  }
  const setting = (key, value) => db.query(
    "insert into public.organization_setting_values(organization_id, setting_key, value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
    [ids.org, key, JSON.stringify(value)],
  );
  const snapshot = () => as(ids.admin, ids.adminSession, "select public.get_organization_intelligence_snapshot('admin') data");
  const graph = () => as(ids.admin, ids.adminSession, "select public.get_organization_derived_graph('admin') data");

  async function account(id, { session = null, roles = [] } = {}) {
    await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [ids.org, id]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapter]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    if (session) await db.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values ($1,$2,now(),now(),'aal2')", [session, id]);
    if (roles.length) {
      await db.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values ($1,$2,'Neuro switch proof','totp','verified',now(),now())", [randomUUID(), id]);
      for (const role of roles) await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [ids.org, id, role]);
    }
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "neuro-map-switch-proof" });
    await db.connect();
    await db.query("begin");
    await releaseCalendarHolds(db);
    await db.query("set local statement_timeout='120s'");
    await db.query("set local lock_timeout='15s'");
    const creator = randomUUID();
    await db.query("insert into auth.users(id,email) values ($1,$2)", [creator, `${creator}@example.invalid`]);
    await db.query("insert into public.organizations(id,slug,name,created_by) values ($1,$2,$2,$3)", [ids.org, `${prefix}-org`, creator]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values ($1,$1,$1,$2,false,9961)", [chapter, ids.org]);
    await account(ids.admin, { session: ids.adminSession, roles: ["admin"] });
    await account(ids.steward, { session: ids.stewardSession, roles: ["steward"] });
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      await account(id);
      people.push(id);
    }
    // One hand-entered relationship and one topic progress row.
    await db.query("insert into public.organization_relationships(organization_id,source_user_id,target_user_id,relationship_kind,strength,created_by,updated_by) values ($1,$2,$3,'works_with',4,$4,$4)", [ids.org, ids.steward, people[0], ids.admin]);
    await db.query("insert into public.organization_topic_progress(organization_id,member_user_id,topic_key,topic_label,progress_state,progress,updated_by) values ($1,$2,'workplace_mapping','Workplace mapping','developing',65,$3)", [ids.org, people[0], ids.admin]);
    // A steward's case for a derived "represents" edge, and five members'
    // lesson progress for automatic readiness above the floor of 5.
    await db.query(
      "insert into public.member_cases(user_id,reference,title,case_type,organization_id,chapter_id,steward_user_id,status) values ($1,$2,'Narrative','Discipline',$3,$4,$5,'active')",
      [people[1], `${prefix}-case`, ids.org, chapter, ids.steward],
    );
    lesson = `${prefix}-lesson`;
    await db.query("insert into public.member_rights_lessons(id,label,title,description,steps,script,order_index,title_es,description_es,steps_es,script_es) values ($1,$1,'Proof lesson','Proof','[\"a\",\"b\"]','Proof',99961,'Prueba','Prueba','[\"a\",\"b\"]','Prueba')", [lesson]);
    for (const id of people) await db.query("insert into public.member_rights_progress(lesson_id,user_id,completed_steps) values ($1,$2,$3)", [lesson, id, [0, 1]]);
    await setting("features.intelligence.neuro_map_derived_graph", true);
    await setting("features.intelligence.neuro_map_auto_progress", true);
  }, 120000);
  beforeEach(async () => { await db.query("savepoint neuro_switch_test"); });
  afterEach(async () => { await db.query("rollback to savepoint neuro_switch_test"); });
  afterAll(async () => { await db?.query("rollback").catch(() => {}); await db?.end(); });

  it("defines the switch as a member-visible, organization-editable boolean that defaults on", async () => {
    const row = (await db.query(
      "select value_kind, default_value, category, member_visible, organization_editable, label, sort_order from public.platform_setting_definitions where key = $1",
      [NEURO_MAP],
    )).rows[0];
    expect(row).toMatchObject({ value_kind: "boolean", default_value: true, category: "intelligence", member_visible: true, organization_editable: true, label: "Neuro Map" });
    const addOns = (await db.query("select min(sort_order) s from public.platform_setting_definitions where key in ('features.intelligence.neuro_map_derived_graph','features.intelligence.neuro_map_auto_progress')")).rows[0].s;
    expect(row.sort_order).toBeLessThan(addOns);
    // Members read it through the member-safe switches map, on by default.
    const switches = (await db.query("select private.organization_member_switches($1) s", [ids.org])).rows[0].s;
    expect(switches[NEURO_MAP]).toBe(true);
  });

  it("returns the relationship graph, topic progress and both add-ons with the switch on", async () => {
    const read = await snapshot();
    expect(read.code, read.message).toBe("");
    expect(read.data.neuroMapEnabled).toBe(true);
    expect(read.data.relationships).toEqual([expect.objectContaining({ sourceId: ids.steward, targetId: people[0], kind: "works_with", strength: 4 })]);
    expect(read.data.topicProgress).toEqual([expect.objectContaining({ memberId: people[0], topicKey: "workplace_mapping", progress: 65 })]);
    expect(read.data.relationshipNodes.map((node) => node.id)).toEqual(expect.arrayContaining([ids.steward, ...people]));
    const derived = await graph();
    expect(derived.code, derived.message).toBe("");
    expect(derived.data).toMatchObject({ neuroMapEnabled: true, derivedEnabled: true, autoProgressEnabled: true });
    expect(derived.data.edges.map((edge) => `${edge.kind}:${edge.sourceId}:${edge.targetId}`)).toContain(`represents:${ids.steward}:${people[1]}`);
    expect(derived.data.topicReadiness.find((row) => row.topicLabel === lesson)).toMatchObject({ members: 5, ready: 5 });
  });

  it("withholds the relationship graph and topic progress with the switch off, and reads both add-ons as off", async () => {
    await setting(NEURO_MAP, false);
    const read = await snapshot();
    expect(read.code, read.message).toBe("");
    expect(read.data).toMatchObject({ neuroMapEnabled: false, relationshipNodes: [], relationships: [], topicProgress: [] });
    // The rest of the organization map is unchanged.
    expect(read.data).toHaveProperty("chartNodes");
    expect(read.data).toHaveProperty("timeline");
    const derived = await graph();
    expect(derived.code, derived.message).toBe("");
    expect(derived.data).toMatchObject({ neuroMapEnabled: false, derivedEnabled: false, autoProgressEnabled: false, edges: [], topicReadiness: [] });
    // The stored add-on values are untouched; turning the map back on restores them.
    await setting(NEURO_MAP, true);
    expect((await graph()).data).toMatchObject({ derivedEnabled: true, autoProgressEnabled: true });
  });

  it("lets an organization administrator turn it off", async () => {
    const saved = await as(ids.admin, ids.adminSession, "select public.update_organization_setting($1, 'false'::jsonb) data", [NEURO_MAP]);
    expect(saved.code, saved.message).toBe("");
    expect((await snapshot()).data).toMatchObject({ neuroMapEnabled: false, relationships: [] });
  });
});
