// @vitest-environment node
// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
// case list rows and search hits stay neutral (#7015) unless the chapter's
// leadership shows case topics for the chapter, or a case's assigned steward
// shows that case's topic in their own rows. Neither switch widens who reads
// a case, the chapter switch skips restricted cases, free text never appears,
// case notifications stay neutral, and every change is audited with its actor.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "case_row_topic_chapter_and_steward_switches";
// Words that exist only in the case topics, the description and the articles,
// so a row that carries any of them is caught by a plain substring test.
const TOPIC = "quillfeatherswitch";
const DESCRIPTION = "marrowlanternswitch";
const ARTICLES = "copperwillowswitch";

describe("case row topic switches migration", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("is one transaction with a top-level search_path and no client grant on the composers or marks", () => {
    expect(sql).toMatch(/\nbegin;\n/);
    expect(sql.trimEnd()).toMatch(/\ncommit;$/);
    expect(sql).toContain("\nset local search_path = pg_catalog;\n");
    expect(sql).not.toMatch(/set_config\(\s*'search_path'/);
    expect(sql).toContain("revoke all on function private.case_row_topic_shown(uuid) from public, anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on function private.case_row_title(uuid) from public, anon, authenticated, service_role;");
    expect(sql).toContain("revoke all on private.case_row_topic_marks from public, anon, authenticated, service_role;");
  });

  it("never reads the topic, description or articles straight into a list row", () => {
    // Only the composer reads member_cases.title; every list read passes a case id.
    const readers = sql.slice(sql.indexOf("create or replace function public.list_unassigned_chapter_cases()"));
    expect(readers).not.toMatch(/\bc\.title\b|open_case\.title|due\.title|hit\.title/);
    expect(readers).not.toMatch(/\bc\.description\b|\bc\.articles\b|hit\.articles|hit\.headline\b/);
    expect(sql).toContain("null::text, hit.step");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

function connectionUrl() {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  return url.toString();
}

function freeText(value) {
  const text = JSON.stringify(value);
  return [DESCRIPTION, ARTICLES].filter((word) => text.includes(word));
}

live("case row topic switches over a disposable database", () => {
  let client;
  const world = {};

  async function actor(email, { role = null, mfa = false } = {}) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${email}`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [id, world.chapter, `Fictional ${email}`]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, world.chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, id]);
    if (role) {
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, world.chapter]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3)", [id, role, world.chapter]);
    }
    if (mfa) {
      await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    }
    return { id, session };
  }

  async function become(person) {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person.id, role: "authenticated", aal: person.aal ?? "aal2", session_id: person.session,
    })]);
    await client.query("set local role authenticated");
  }

  async function asPostgres() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  // Runs one statement as a person; a refusal comes back as { code } instead
  // of aborting the outer transaction.
  async function as(person, text, values = []) {
    await client.query("savepoint attempt");
    await become(person);
    try {
      const { rows } = await client.query(text, values);
      await asPostgres();
      await client.query("release savepoint attempt");
      return { rows };
    } catch (error) {
      await client.query("rollback to savepoint attempt");
      await asPostgres();
      return { code: error.code, message: error.message };
    }
  }

  async function ok(person, text, values = []) {
    const result = await as(person, text, values);
    expect(result.code, result.message).toBeUndefined();
    return result.rows;
  }

  async function seedCase({ reference, topic, steward = null, restricted = false }) {
    const { rows } = await client.query(
      `insert into public.member_cases(user_id,reference,title,description,case_type,articles,step,deadline,steward_user_id,
         is_restricted,restriction_reason,restricted_at,restricted_by)
       values ($1,$2,$3,$4,'Discipline',$5,'Intake',(now() at time zone 'America/New_York')::date + 2,$6,
         $7,case when $7 then 'Proof restriction' end,case when $7 then now() end,case when $7 then $6::uuid end) returning id`,
      [world.owner.id, reference, `${TOPIC} ${topic}`, `${DESCRIPTION} statement`, `${ARTICLES} Article 9`, steward, restricted],
    );
    return rows[0].id;
  }

  // The names each reader's rows give the three cases, by case id.
  async function searchTitles(person) {
    const rows = await ok(person, "select case_id, title, topic_shown, articles, headline from public.search_member_cases($1, 50)", [TOPIC]);
    expect(freeText(rows)).toEqual([]);
    for (const row of rows) expect([row.articles, row.headline]).toEqual([null, null]);
    return Object.fromEntries(rows.map((row) => [row.case_id, { title: row.title, shown: row.topic_shown }]));
  }

  async function rowTitles(person) {
    const [{ v }] = await ok(person, "select public.list_case_row_titles($1::uuid[]) as v", [[world.assigned, world.waiting, world.restricted]]);
    expect(freeText(v)).toEqual([]);
    return Object.fromEntries(v.map((row) => [row.id, { title: row.title, shown: row.topicShown }]));
  }

  async function stewardDeadline() {
    const [{ payload }] = await ok(world.steward, "select public.list_steward_case_deadlines() as payload");
    expect(freeText(payload)).toEqual([]);
    const row = payload.rows.find((item) => item.caseId === world.assigned && item.kind === "case");
    return { title: row.title, shown: row.topicShown };
  }

  async function queueRow() {
    const [{ rows }] = await ok(world.steward, "select public.list_unassigned_chapter_cases() as rows");
    expect(freeText(rows)).toEqual([]);
    const row = rows.find((item) => item.id === world.waiting);
    return { title: row.title, shown: row.topicShown };
  }

  const NEUTRAL = { title: "Discipline · Intake", shown: false };
  const topic = (words) => ({ title: `${TOPIC} ${words}`, shown: true });

  async function audits(action) {
    const { rows } = await client.query(
      "select actor, detail from public.member_admin_audit where action = $1 and (detail->>'chapterId' = $2) order by created_at, id",
      [action, world.chapter],
    );
    return rows;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: connectionUrl(), application_name: "case-row-topic-switches-proof" });
    await client.connect();
    await client.query("set statement_timeout = '60s'");
    await client.query("begin");

    world.org = randomUUID();
    world.chapter = `t7043-${world.org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9943)", [world.chapter, world.org]);

    world.owner = await actor("owner@example.invalid");
    world.steward = await actor("steward@example.invalid", { role: "steward", mfa: true });
    world.otherSteward = await actor("other-steward@example.invalid", { role: "steward", mfa: true });
    world.vp = await actor("vp@example.invalid", { role: "vp", mfa: true });
    world.unrelated = await actor("unrelated@example.invalid");

    world.assigned = await seedCase({ reference: "TS-2026-0001", topic: "overtime withheld", steward: world.steward.id });
    world.waiting = await seedCase({ reference: "TS-2026-0002", topic: "schedule change" });
    world.restricted = await seedCase({ reference: "TS-2026-0003", topic: "medical leave", steward: world.steward.id, restricted: true });
    world.sealed = await seedCase({ reference: "TS-2026-0004", topic: "sealed grievance", steward: world.steward.id });
    await client.query("insert into private.case_identity_privacy(case_id) values ($1)", [world.sealed]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("keeps every row neutral while both switches are off (the default)", async () => {
    expect((await client.query("select case_row_topic from private.chapter_access_policies where chapter_id=$1", [world.chapter])).rows).toEqual([]);
    expect(await stewardDeadline()).toEqual(NEUTRAL);
    expect(await queueRow()).toEqual(NEUTRAL);
    for (const person of [world.owner, world.steward]) {
      const hits = await searchTitles(person);
      expect(hits[world.assigned]).toEqual(NEUTRAL);
      const names = await rowTitles(person);
      expect(names[world.assigned]).toEqual(NEUTRAL);
      expect(names[world.restricted]).toEqual(NEUTRAL);
    }
    const [setting] = await ok(world.steward, "select public.get_case_row_topic($1) as v", [world.assigned]);
    expect(setting.v).toEqual({ shown: false, chapterShown: false, canChange: true });
    const [ownerSetting] = await ok(world.owner, "select public.get_case_row_topic($1) as v", [world.assigned]);
    expect(ownerSetting.v.canChange).toBe(false);
  });

  it("lets only the assigned steward show a case's topic, in that steward's own rows only", async () => {
    for (const person of [world.owner, world.otherSteward, world.vp, world.unrelated]) {
      expect((await as(person, "select public.set_case_row_topic($1, true)", [world.assigned])).code).toBe("42501");
    }
    expect((await as(world.steward, "select public.set_case_row_topic($1, true)", [world.waiting])).code).toBe("42501");
    expect((await as(world.steward, "select public.set_case_row_topic($1, null)", [world.assigned])).code).toBe("22023");
    expect((await client.query("select count(*)::int as n from private.case_row_topic_marks where case_id = any($1::uuid[])", [[world.assigned, world.waiting]])).rows[0].n).toBe(0);

    await ok(world.steward, "select public.set_case_row_topic($1, true)", [world.assigned]);
    expect(await audits("case_row_topic_updated")).toEqual([
      { actor: world.steward.id, detail: { caseId: world.assigned, chapterId: world.chapter, shown: true } },
    ]);

    expect(await stewardDeadline()).toEqual(topic("overtime withheld"));
    expect((await searchTitles(world.steward))[world.assigned]).toEqual(topic("overtime withheld"));
    expect((await rowTitles(world.steward))[world.assigned]).toEqual(topic("overtime withheld"));
    const destinations = await ok(world.steward, "select id, title from public.list_share_case_destinations(100)");
    expect(destinations.find((row) => row.id === world.assigned).title).toBe(`${TOPIC} overtime withheld`);

    // The owner and another steward who can read the case keep the neutral line.
    expect((await searchTitles(world.owner))[world.assigned]).toEqual(NEUTRAL);
    expect((await rowTitles(world.owner))[world.assigned]).toEqual(NEUTRAL);
    const other = await rowTitles(world.otherSteward);
    expect(other[world.assigned]).toEqual(NEUTRAL);
    expect((await searchTitles(world.otherSteward))[world.assigned]).toEqual(NEUTRAL);
    expect(await queueRow()).toEqual(NEUTRAL);
  });

  it("lets only the chapter's leadership show topics to the readers who can already read each case", async () => {
    for (const person of [world.steward, world.owner, world.unrelated]) {
      expect((await as(person, "select public.set_chapter_case_row_topic($1, true)", [world.chapter])).code).toBe("42501");
      expect((await as(person, "select public.get_chapter_case_row_topic($1)", [world.chapter])).code).toBe("42501");
    }
    const [before] = await ok(world.vp, "select public.get_chapter_case_row_topic($1) as v", [world.chapter]);
    expect(before.v).toEqual({ chapterId: world.chapter, enabled: false, canChange: true });

    await ok(world.vp, "select public.set_chapter_case_row_topic($1, true)", [world.chapter]);
    expect(await audits("case_row_topic_policy_updated")).toEqual([
      { actor: world.vp.id, detail: { chapterId: world.chapter, enabled: true } },
    ]);

    expect(await queueRow()).toEqual(topic("schedule change"));
    const owner = await searchTitles(world.owner);
    expect(owner[world.assigned]).toEqual(topic("overtime withheld"));
    expect(owner[world.waiting]).toEqual(topic("schedule change"));
    const otherSteward = await rowTitles(world.otherSteward);
    expect(otherSteward[world.assigned]).toEqual(topic("overtime withheld"));
    // A restricted case keeps the neutral line under the chapter switch.
    expect((await rowTitles(world.owner))[world.restricted]).toEqual(NEUTRAL);

    // Nothing widens: an unrelated member of the chapter still reads no case.
    expect(await searchTitles(world.unrelated)).toEqual({});
    expect(await rowTitles(world.unrelated)).toEqual({});
    expect((await as(world.unrelated, "select public.get_case_row_topic($1)", [world.assigned])).code).toBe("42501");
    expect((await as(world.unrelated, "select public.list_unassigned_chapter_cases()")).code).toBe("42501");
    const unrelatedDestinations = await ok(world.unrelated, "select id from public.list_share_case_destinations(100)");
    expect(unrelatedDestinations.map((row) => row.id)).not.toContain(world.assigned);
  });

  // Gate round 1 r1g1: a definer read must not hand a restricted member PIN
  // session the topic its member_pin_step_up row policy withholds.
  it("gives a restricted PIN session and an unrelated member no topic from any row read", async () => {
    const pin = { id: world.owner.id, session: randomUUID(), aal: "aal1" };
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal1',now(),now())", [pin.session, pin.id]);
    await client.query("insert into private.member_pin_sessions(session_id,user_id) values ($1,$2)", [pin.session, pin.id]);
    expect((await ok(pin, "select private.member_pin_session_restricted() as v"))[0].v).toBe(true);
    // The row policy withholds the case itself from this session.
    expect(await ok(pin, "select title from public.member_cases where id = $1", [world.assigned])).toEqual([]);

    const titles = await as(pin, "select public.list_case_row_titles($1::uuid[]) as v", [[world.assigned, world.waiting]]);
    expect(titles.code, JSON.stringify(titles.rows)).toBe("42501");
    expect((await as(pin, "select public.get_case_row_topic($1)", [world.assigned])).code).toBe("42501");
    for (const read of ["select * from public.search_member_cases($1, 50)", "select * from public.list_share_case_destinations(50)"]) {
      const result = await as(pin, read, read.includes("$1") ? [TOPIC] : []);
      expect(JSON.stringify(result.rows ?? [])).not.toContain(TOPIC);
    }
    // The composer itself (no client grant; called here with the session's
    // claims, as a definer read would) withholds the topic from that session.
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: pin.id, role: "authenticated", aal: "aal1", session_id: pin.session })]);
    const composed = await client.query("select private.case_row_title($1) as title, private.case_row_topic_shown($1) as shown", [world.assigned]);
    await asPostgres();
    expect(composed.rows).toEqual([{ title: "Discipline · Intake", shown: false }]);

    // The same member with a full session still sees the chapter's topic, and
    // an unrelated member still reads nothing.
    expect((await rowTitles(world.owner))[world.assigned]).toEqual(topic("overtime withheld"));
    expect(await rowTitles(world.unrelated)).toEqual({});
  });

  it("keeps case notifications neutral and stored notifications untouched with the chapter switch on", async () => {
    await client.query("insert into public.member_notifications(user_id,title,body,kind) values ($1,'Earlier notice','Stored before the switch','cases')", [world.owner.id]);
    await client.query("select private.case_deadline_notice_sweep()");
    const rows = await ok(world.owner, "select title, body from public.member_notifications where user_id = auth.uid() order by created_at");
    expect(rows.length).toBeGreaterThan(1);
    expect(JSON.stringify(rows)).not.toContain(TOPIC);
    expect(rows).toContainEqual({ title: "Earlier notice", body: "Stored before the switch" });
  });

  it("returns to neutral rows when both switches are off again, auditing each change", async () => {
    await ok(world.steward, "select public.set_case_row_topic($1, false)", [world.assigned]);
    expect(await stewardDeadline()).toEqual(topic("overtime withheld"));
    await ok(world.vp, "select public.set_chapter_case_row_topic($1, false)", [world.chapter]);
    expect(await stewardDeadline()).toEqual(NEUTRAL);
    expect(await queueRow()).toEqual(NEUTRAL);
    expect((await searchTitles(world.owner))[world.assigned]).toEqual(NEUTRAL);

    // One proof transaction gives every row the same created_at, so compare as sets.
    expect((await audits("case_row_topic_updated")).map((row) => [row.actor, row.detail.shown]).sort()).toEqual([
      [world.steward.id, false], [world.steward.id, true],
    ]);
    expect((await audits("case_row_topic_policy_updated")).map((row) => [row.actor, row.detail.enabled]).sort()).toEqual([
      [world.vp.id, false], [world.vp.id, true],
    ]);
  });

  // ruling, gate round 1: restricted and identity-private cases stay
  // neutral for everyone, the assigned steward's own switch included.
  it("keeps restricted and identity-private cases neutral under the steward's own switch", async () => {
    for (const id of [world.restricted, world.sealed]) {
      await ok(world.steward, "select public.set_case_row_topic($1, true)", [id]);
    }
    await ok(world.steward, "select public.set_case_row_topic($1, true)", [world.assigned]);
    const [{ v }] = await ok(world.steward, "select public.list_case_row_titles($1::uuid[]) as v", [[world.assigned, world.restricted, world.sealed]]);
    const names = Object.fromEntries(v.map((row) => [row.id, { title: row.title, shown: row.topicShown }]));
    expect(names[world.assigned]).toEqual(topic("overtime withheld"));
    expect(names[world.restricted]).toEqual(NEUTRAL);
    expect(names[world.sealed]).toEqual(NEUTRAL);
    const [{ payload }] = await ok(world.steward, "select public.list_steward_case_deadlines() as payload");
    for (const row of payload.rows.filter((item) => [world.restricted, world.sealed].includes(item.caseId))) {
      expect({ title: row.title, shown: row.topicShown }).toEqual(NEUTRAL);
    }
    expect(JSON.stringify(payload)).not.toContain("medical leave");
    expect(JSON.stringify(payload)).not.toContain("sealed grievance");
  });
});
