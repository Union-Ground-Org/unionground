// @vitest-environment node
// REQ-UG-PRIVACY-FLOOR-25-SERVER-SIDE-20261104 (#7010): the server
// holds the aggregate privacy floor at 25. The organization setting refuses
// 24 at the RPC and at the table, stored values under 25 are raised by the
// migration, the floor helper returns 25 whatever is stored, and one dataset
// (analytics workspace chapter health trend), one chart (Pulse preview) and
// one export (Pulse CSV read) are each proved at 24 and at 25 people. A
// chapter health snapshot recorded at 24 people stays dark after the
// chapter grows to 25; only a snapshot recorded at 25 is shown.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20261104073000_privacy_floor_25_server_side.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const ANONYMITY = "limits.analytics.anonymity_floor";
const HEALTH = "limits.analytics.chapter_health_cohort_floor";
const statement = (start, end) => {
  const from = migration.indexOf(start);
  const to = migration.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`migration statement not found: ${start}`);
  return migration.slice(from, to + end.length);
};
const RAISE = statement("with previous as (", "from raised r;");
const CONSTRAINT = statement("alter table public.organization_setting_values\n  add constraint organization_setting_values_privacy_floor_25", "  );");

describe("privacy floor 25 migration (static)", () => {
  it("is one transaction with a top-level search_path, a header note on raised rows, and the floor in one helper", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(migration).toContain("\nset local search_path = pg_catalog;\n");
    expect(migration).not.toMatch(/set_config\(\s*'search_path'/);
    expect(migration).toContain("EXISTING ROWS RAISED");
    expect(migration).toContain("return greatest(configured, 25);");
    expect(migration).not.toMatch(/members >= 10|scored_members >= 10|'floor', 10/);
  });
});

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;
const base = { version: 1, measure: "published_actions", breakdown: "month", period: "3m", form: "bars" };

live("privacy floor 25 on an owned disposable database", () => {
  let db, org, chapter, admin, latecomer, action;
  const sessions = new Map();
  const members = [];
  async function fixture(sql, values = []) {
    await db.query("savepoint fixture_write");
    await db.query("set local session_replication_role = replica");
    try { return await db.query(sql, values); }
    catch (error) { await db.query("rollback to savepoint fixture_write"); throw error; }
    finally { await db.query("set local session_replication_role = origin"); }
  }
  async function as(user, sql, values = []) {
    await db.query("savepoint request");
    try {
      await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: sessions.get(user) })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint request");
      return { code: "", value: result.rows[0]?.v };
    } catch (error) {
      await db.query("rollback to savepoint request");
      if (error.code === "42703") throw error;
      return { code: error.code, message: error.message };
    }
  }
  async function raw(sql, values = []) {
    await db.query("savepoint raw_write");
    try {
      const result = await db.query(sql, values);
      await db.query("release savepoint raw_write");
      return { code: "", rows: result.rows };
    } catch (error) {
      await db.query("rollback to savepoint raw_write");
      return { code: error.code, constraint: error.constraint, message: error.message };
    }
  }
  const limit = async (key) => (await db.query("select private.organization_limit($1,$2) v", [org, key])).rows[0].v;
  const store = (key, value) => db.query(
    `insert into public.organization_setting_values(organization_id, setting_key, value, updated_by)
     values($1,$2,$3::jsonb,$4)
     on conflict (organization_id, setting_key) do update set value = excluded.value`,
    [org, key, JSON.stringify(value), admin],
  );
  // The 25th active chapter member, and the 25th recorded sign-up.
  async function addTwentyFifth() {
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, latecomer]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict (user_id,chapter_id) do update set status='active'", [latecomer, chapter]);
    await fixture("insert into public.digital_action_participants(organization_id,action_id,user_id,participation_kind,joined_at) values ($1,$2,$3,'signature',now())", [org, action, latecomer]);
  }
  const workspace = () => as(admin, "select public.get_organization_analytics_workspace() v");
  const preview = () => as(admin, "select public.preview_pulse_chart($1,'admin') v", [base]);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "privacy-floor-25-rollback-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    org = randomUUID(); chapter = `floor25-${org.slice(0, 8)}`; action = randomUUID();
    // The admin and 23 members are 24 active chapter members; the latecomer
    // has a profile in the chapter but no membership until a case adds it.
    const users = Array.from({ length: 25 }, () => randomUUID());
    [admin] = users; latecomer = users[24];
    members.push(...users.slice(0, 24));
    await db.query("insert into auth.users(id,email) select id,id::text || '@example.invalid' from unnest($1::uuid[]) id", [users]);
    await fixture("insert into public.organizations(id,slug,name) values ($1,$2,'Tamarack floor proof')", [org, chapter]);
    await fixture("insert into public.chapters(id,name,slug,order_index,organization_id) values ($1,'Floor proof chapter',$1,180251,$2)", [chapter, org]);
    await db.query("update public.member_profiles set chapter_id=$2, full_name='Floor proof member' where id = any($1::uuid[])", [users, chapter]);
    await fixture("insert into public.organization_memberships(organization_id,user_id,status) select $2,id,'active' from unnest($1::uuid[]) id on conflict do nothing", [members, org]);
    await fixture("insert into public.member_chapter_memberships(user_id,chapter_id,status,pinned,last_selected_at) select id,$2,'active',true,now() from unnest($1::uuid[]) id on conflict(user_id,chapter_id) do update set status='active',pinned=true,last_selected_at=now()", [members, chapter]);
    await fixture("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2)", [org, admin]);
    const session = randomUUID(); sessions.set(admin, session);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), admin]);
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, admin]);
    await fixture("insert into public.digital_actions(id,organization_id,chapter_id,action_kind,title,summary,status,published_at,created_by,updated_by) values($1,$2,$3,'petition','Floor proof action','Floor proof action','published',now(),$4,$4)", [action, org, chapter, admin]);
    await fixture("insert into public.digital_action_participants(organization_id,action_id,user_id,participation_kind,joined_at) select $1,$2,id,'signature',now() from unnest($3::uuid[]) id", [org, action, members]);
    await fixture(`insert into public.chapter_health_snapshots(chapter_id,measured_on,member_count,participation,case_timeliness,steward_capacity,training_coverage,communication_reach,governance_readiness,score,created_by)
      values($1,current_date - 7,24,60,60,60,60,60,60,61,$2)`, [chapter, admin]);
  }, 60000);
  beforeEach(async () => { await db.query("savepoint scenario"); });
  afterEach(async () => { await db.query("reset role"); await db.query("rollback to savepoint scenario"); });
  afterAll(async () => { if (db) { await db.query("rollback").catch(() => {}); await db.end(); } });

  it("registers 25 as both floors' minimum and default, and the RPC and the table refuse 24", async () => {
    const { rows } = await db.query(
      "select key, (default_value #>> '{}')::integer as fallback, minimum from public.platform_setting_definitions where key = any($1::text[]) order by key",
      [[ANONYMITY, HEALTH]],
    );
    expect(rows).toEqual([
      { key: ANONYMITY, fallback: 25, minimum: 25 },
      { key: HEALTH, fallback: 25, minimum: 25 },
    ]);
    for (const key of [ANONYMITY, HEALTH]) {
      expect(await as(admin, "select public.set_organization_setting($1,$2::jsonb,null) v", [key, "24"])).toMatchObject({ code: "22023" });
      expect(await raw("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'24'::jsonb,$3)", [org, key, admin]))
        .toMatchObject({ code: "23514", constraint: "organization_setting_values_privacy_floor_25" });
      expect(await raw("insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'\"25\"'::jsonb,$3)", [org, key, admin]))
        .toMatchObject({ code: "23514", constraint: "organization_setting_values_privacy_floor_25" });
      const saved = await as(admin, "select public.set_organization_setting($1,$2::jsonb,null) v", [key, "25"]);
      expect(saved, saved.message).toMatchObject({ code: "", value: { key, value: 25, overridden: true } });
      expect(await as(admin, "select public.update_organization_setting($1,$2::jsonb) v", [key, "10"])).toMatchObject({ code: "22023" });
      const reset = await as(admin, "select public.reset_organization_setting($1,$2::timestamptz) v", [key, saved.value.updatedAt]);
      expect(reset, reset.message).toMatchObject({ code: "", value: { value: 25, overridden: false } });
      expect(await limit(key)).toBe(25);
    }
    await store(ANONYMITY, 40);
    expect(await limit(ANONYMITY)).toBe(40);
  });

  it("raises stored values under 25 with an audit row, leaves higher values alone, and the check then validates", async () => {
    await db.query("alter table public.organization_setting_values drop constraint organization_setting_values_privacy_floor_25");
    await store(ANONYMITY, 10);
    await store(HEALTH, 40);
    await db.query(RAISE);
    const { rows } = await db.query(
      "select setting_key, value from public.organization_setting_values where organization_id=$1 and setting_key = any($2::text[]) order by setting_key",
      [org, [ANONYMITY, HEALTH]],
    );
    expect(rows).toEqual([{ setting_key: ANONYMITY, value: 25 }, { setting_key: HEALTH, value: 40 }]);
    const audit = await db.query(
      "select actor_user_id, action, previous_value, new_value from public.organization_configuration_audit where organization_id=$1 and item_key=$2",
      [org, ANONYMITY],
    );
    expect(audit.rows).toEqual([{ actor_user_id: null, action: "setting_updated", previous_value: 10, new_value: 25 }]);
    expect((await db.query("select count(*)::int n from public.organization_configuration_audit where organization_id=$1 and item_key=$2", [org, HEALTH])).rows[0].n).toBe(0);
    await db.query(CONSTRAINT);
  });

  it("answers at 25 whatever is stored or registered, and so does the floor the workspace reports", async () => {
    await db.query("alter table public.organization_setting_values drop constraint organization_setting_values_privacy_floor_25");
    await db.query("update public.platform_setting_definitions set minimum=5, default_value='10'::jsonb where key = any($1::text[])", [[ANONYMITY, HEALTH]]);
    expect(await limit(ANONYMITY)).toBe(25);
    expect(await limit(HEALTH)).toBe(25);
    await store(ANONYMITY, 10);
    await store(HEALTH, 5);
    expect(await limit(ANONYMITY)).toBe(25);
    expect(await limit(HEALTH)).toBe(25);
    const read = await workspace();
    expect(read, read.message).toMatchObject({ code: "", value: { organizationId: org, privacyThreshold: 25, chapterHealthFloor: 25 } });
    expect(await preview()).toMatchObject({ code: "", value: { withheld: true, rows: [], privacyFloor: 25 } });
  });

  it("dataset: withholds chapter health at 24 members, keeps the 24-person snapshot dark at 25, and releases a 25-person snapshot", async () => {
    const trendId = `chapter:${chapter}:health-trend`;
    const at24 = await workspace();
    expect(at24, at24.message).toMatchObject({ code: "", value: { privacyThreshold: 25, chapterHealthFloor: 25 } });
    expect(at24.value.datasets.map((dataset) => dataset.id)).not.toContain(trendId);
    expect(at24.value.datasets.find((dataset) => dataset.id === "organization:chapter-health").rows).toEqual([]);
    expect(at24.value.chapterHealth.find((row) => row.chapterId === chapter)).toMatchObject({ memberCount: 24, protected: true, score: null, drivers: null, trend: [] });

    await addTwentyFifth();
    // The chapter now has 25 members, but its only snapshot counted 24.
    const grown = await workspace();
    expect(grown.code, grown.message).toBe("");
    expect(grown.value.datasets.find((dataset) => dataset.id === trendId)).toMatchObject({ scope: "chapter", chapterId: chapter, rows: [] });
    expect(grown.value.datasets.find((dataset) => dataset.id === "organization:chapter-health").rows).toEqual([]);
    expect(grown.value.chapterHealth.find((row) => row.chapterId === chapter)).toMatchObject({ memberCount: 25, protected: true, score: null, drivers: null, trend: [] });
    expect(JSON.stringify(grown.value)).not.toContain('"value":61');

    await fixture(`insert into public.chapter_health_snapshots(chapter_id,measured_on,member_count,participation,case_timeliness,steward_capacity,training_coverage,communication_reach,governance_readiness,score,created_by)
      values($1,current_date,25,70,70,70,70,70,70,70,$2)`, [chapter, admin]);
    const at25 = await workspace();
    expect(at25.code, at25.message).toBe("");
    expect(at25.value.datasets.find((dataset) => dataset.id === trendId).rows).toEqual([expect.objectContaining({ value: 70 })]);
    expect(at25.value.datasets.find((dataset) => dataset.id === "organization:chapter-health").rows).toEqual([{ label: "Floor proof chapter", value: 70 }]);
    const health = at25.value.chapterHealth.find((row) => row.chapterId === chapter);
    expect(health).toMatchObject({ memberCount: 25, protected: false, score: 70, drivers: expect.objectContaining({ participation: 70 }) });
    expect(health.trend).toEqual([expect.objectContaining({ score: 70 })]);
  });

  it("chart: withholds a Pulse chart with 24 people in a cell and releases it at 25", async () => {
    const at24 = await preview();
    expect(at24, at24.message).toMatchObject({ code: "", value: { withheld: true, rows: [], privacyFloor: 25, person: false } });
    await addTwentyFifth();
    const at25 = await preview();
    expect(at25, at25.message).toMatchObject({ code: "", value: { withheld: false, privacyFloor: 25 } });
    expect(at25.value.rows.filter((row) => row.value !== 0)).toEqual([expect.objectContaining({ value: 25 })]);
  });

  it("export: the Pulse CSV read carries no figures at 24 people and the counted figures at 25", async () => {
    const saved = await as(admin, "select public.save_pulse_chart(null,'Recorded sign-ups',$1,'organization',false,false,'admin') v", [base]);
    expect(saved.code, saved.message).toBe("");
    const exported = () => as(admin, "select public.read_pulse_chart($1,'admin',true) v", [saved.value]);
    const at24 = await exported();
    expect(at24, at24.message).toMatchObject({ code: "", value: { scope: "organization", figures: { withheld: true, rows: [], privacyFloor: 25 } } });
    await addTwentyFifth();
    const at25 = await exported();
    expect(at25, at25.message).toMatchObject({ code: "", value: { figures: { withheld: false, privacyFloor: 25 } } });
    expect(at25.value.figures.rows.filter((row) => row.value !== 0)).toEqual([expect.objectContaining({ value: 25 })]);
  });
});
