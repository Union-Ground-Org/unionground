// @vitest-environment node
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

// OPS-UG-ANALYTICS-READ-SIDE-SHIPPED-BUT-NOTHING-IN-PRODUCTION-WRITES-ORGANIZATION-ENGAGEMENT-EVENTS-20260921
// ( AUTHENTICATED PAGE-VIEW PRODUCER). Only a live
// apply proves the producer and the tiles together: two members record three
// pages each and a repeat inside the minute is a no-op; the Usage tiles'
// reader publishes Views / DAU / WAU / MAU as floored person cohorts and
// withholds a page a small cohort viewed; the per-person minute bound refuses
// the excess; a different organization, a non-member and an anonymous caller
// are refused; the page key and the hat are validated; and no browser role
// can write either table directly. Every case runs in one transaction that
// rolls back.
const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

live("organization page-view producer (live)", () => {
  let client;
  const world = {};

  async function actor(label, chapter, org, { mfa = true } = {}) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, id]);
    if (mfa) await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return { id, session };
  }

  async function grantRole(person, role, chapter, org) {
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [person.id, role, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [person.id, role, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, person.id, role]);
  }

  async function become(person, role = "authenticated") {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify(person
      ? { sub: person.id, role, aal: "aal2", session_id: person.session }
      : { role })]);
    await client.query(`set local role ${role}`);
  }

  async function asPostgres() {
    await client.query("reset role");
  }

  async function record(person, page, hat = "member", organizationId = null) {
    await become(person);
    await client.query("savepoint page_view");
    try {
      const { rows } = await client.query(
        "select public.record_workspace_page_view($1, $2, $3::uuid) as value",
        [page, hat, organizationId],
      );
      await client.query("release savepoint page_view");
      return { value: rows[0].value };
    } catch (error) {
      await client.query("rollback to savepoint page_view");
      return { code: error.code, message: error.message };
    } finally {
      await asPostgres();
    }
  }

  async function snapshot(person) {
    await become(person);
    const { rows } = await client.query("select public.get_organization_analytics_snapshot() as value");
    await asPostgres();
    return rows[0].value;
  }

  async function counts(org) {
    const { rows } = await client.query(`
      select
        (select count(*)::int from public.organization_engagement_events where organization_id = $1 and event_type = 'page_view') as events,
        (select coalesce(sum(view_count), 0)::int from public.organization_page_views where organization_id = $1) as views
    `, [org]);
    return rows[0];
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "organization-page-view-producer-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    for (const key of ["A", "B"]) {
      world[`org${key}`] = randomUUID();
      world[`chapter${key}`] = `pv-${key.toLowerCase()}-${world[`org${key}`].slice(0, 8)}`;
      await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world[`org${key}`], world[`chapter${key}`]]);
      await client.query(
        "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97452)",
        [world[`chapter${key}`], world[`org${key}`]],
      );
    }
    world.memberOne = await actor("member-one", world.chapterA, world.orgA);
    world.memberTwo = await actor("member-two", world.chapterA, world.orgA);
    world.steward = await actor("steward", world.chapterA, world.orgA);
    await grantRole(world.steward, "steward", world.chapterA, world.orgA);
    world.outsider = await actor("outsider", world.chapterB, world.orgB);
    // A person floor of 25 needs cohorts: 25 people who viewed /m today,
    // 25 more active four days ago, 25 more active twenty days ago.
    for (const [label, offset, page] of [["today", "0 hours", "/m"], ["week", "4 days", "/m/events"], ["month", "20 days", "/m/voice"]]) {
      await client.query(`
        with people as (
          insert into auth.users(id,email)
          select gen_random_uuid(), 'pv-${label}-' || n || '-' || $2 || '@example.invalid'
          from pg_catalog.generate_series(1, 25) n
          returning id
        )
        insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id,occurred_at)
        select $1, people.id, $3, 'page_view', $4 || '|' || to_char((now() - interval '${offset}') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI'), now() - interval '${offset}'
        from people
      `, [world.orgA, world.orgA.slice(0, 8), world.chapterA, page]);
      await client.query(`
        insert into public.organization_page_views(organization_id,path,hat,day,view_count)
        values ($1, $2, 'member', ((now() - interval '${offset}') at time zone 'UTC')::date, 25)
        on conflict (organization_id, path, hat, day) do update set view_count = public.organization_page_views.view_count + 25
      `, [world.orgA, page]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("records one page_view event and one view per member, page and minute, and repeats inside the minute are no-ops", async () => {
    const before = await counts(world.orgA);
    for (const person of [world.memberOne, world.memberTwo]) {
      for (const page of ["/m", "/m/voting", "/m/events"]) {
        expect(await record(person, page)).toEqual({ value: { recorded: true } });
      }
    }
    expect(await record(world.memberOne, "/m")).toEqual({ value: { recorded: false } });
    expect(await record(world.memberTwo, "/m/events")).toEqual({ value: { recorded: false } });
    const after = await counts(world.orgA);
    expect(after.events - before.events).toBe(6);
    expect(after.views - before.views).toBe(6);
    const { rows } = await client.query(
      "select source_id, chapter_id from public.organization_engagement_events where organization_id = $1 and user_id = $2 and event_type = 'page_view' order by source_id",
      [world.orgA, world.memberOne.id],
    );
    expect(rows.map((row) => row.chapter_id)).toEqual([world.chapterA, world.chapterA, world.chapterA]);
    expect(rows.map((row) => row.source_id.split("|")[0]).sort()).toEqual(["/m", "/m/events", "/m/voting"]);
    for (const row of rows) expect(row.source_id).toMatch(/\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    // Steward hat recorded only when held; a member claiming it is recorded as a member.
    expect(await record(world.steward, "/m/steward", "steward")).toEqual({ value: { recorded: true } });
    expect(await record(world.memberOne, "/m/steward", "steward")).toEqual({ value: { recorded: true } });
    const hats = await client.query(
      "select hat, view_count from public.organization_page_views where organization_id = $1 and path = '/m/steward' order by hat",
      [world.orgA],
    );
    expect(hats.rows).toEqual([{ hat: "member", view_count: 1 }, { hat: "steward", view_count: 1 }]);
  });

  it("publishes floored Views / DAU / WAU / MAU from real page views and withholds small cohorts", async () => {
    const value = await snapshot(world.steward);
    const today = new Date().toISOString().slice(0, 10);
    const published = value.usageViews.filter((row) => row.day === today);
    // 25 seeded people + 2 members viewed /m today (27 -> 25); the four
    // members' /m/voting, /m/events and /m/steward views today are cohorts
    // below the floor and stay unpublished.
    expect(published).toEqual([{ organizationId: world.orgA, path: "/m", hat: "member", day: today, count: 25 }]);
    expect(value.usageViews.map((row) => row.path).sort()).toEqual(["/m", "/m/events", "/m/voice"]);
    // dau 28 (25 + 3 members) -> 25; wau adds 25 -> 53 -> 50; mau adds 25 -> 78 -> 75.
    expect(value.usageWindows).toEqual({
      organizationId: world.orgA,
      dau: 25,
      wau: 50,
      mau: 75,
      suppressed: { dau: false, wau: false, mau: false },
    });
    expect(value.engagementCounts.map((row) => row.eventType)).not.toContain("page_view");
  });

  it("applies the complement rule: a window that adds fewer than the floor over the nearest published inner window is withheld", async () => {
    await client.query("savepoint complement");
    try {
      await client.query(
        "delete from public.organization_engagement_events where organization_id = $1 and event_type = 'page_view' and occurred_at < now() - interval '2 days' and occurred_at > now() - interval '10 days'",
        [world.orgA],
      );
      const value = await snapshot(world.steward);
      // wau (28) adds only 3 people over the published dau and is withheld;
      // mau (53) is then measured against dau, adds 28 and publishes as 50.
      expect(value.usageWindows).toMatchObject({ dau: 25, wau: null, mau: 50, suppressed: { dau: false, wau: true, mau: false } });
    } finally {
      await client.query("rollback to savepoint complement");
    }
  });

  it("bounds recorded page views to 30 per person per minute and answers the excess without an error", async () => {
    const burst = await actor("burst", world.chapterA, world.orgA);
    for (let n = 0; n < 30; n += 1) {
      expect(await record(burst, `/m/burst/${n}`)).toEqual({ value: { recorded: true } });
    }
    expect(await record(burst, "/m/burst/30")).toEqual({ value: { recorded: false, refusal: "rate-limited" } });
    expect(await record(burst, "/m/burst/31")).toEqual({ value: { recorded: false, refusal: "rate-limited" } });
    const { rows } = await client.query(
      "select count(*)::int as n from public.organization_engagement_events where user_id = $1 and event_type = 'page_view'",
      [burst.id],
    );
    expect(rows[0].n).toBe(30);
  });

  it("refuses a different organization, a non-member, an anonymous caller, a malformed page key and a claimed hat it cannot verify", async () => {
    expect(await record(world.memberOne, "/m", "member", world.orgB)).toMatchObject({ code: "42501" });
    expect(await record(world.outsider, "/m", "member", world.orgA)).toMatchObject({ code: "42501" });
    const nobody = { id: randomUUID(), session: randomUUID() };
    await client.query("insert into auth.users(id,email) values ($1,$2)", [nobody.id, `${nobody.id}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [nobody.session, nobody.id]);
    expect(await record(nobody, "/m")).toMatchObject({ code: "42501" });
    expect(await record(world.memberOne, "javascript:alert(1)")).toMatchObject({ code: "22023" });
    expect(await record(world.memberOne, "")).toMatchObject({ code: "22023" });
    expect(await record(world.memberOne, `/m/${"x".repeat(120)}`)).toMatchObject({ code: "22023" });
    await become(null, "anon");
    await client.query("savepoint anon_call");
    await expect(client.query("select public.record_workspace_page_view('/m', 'member', null)")).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint anon_call");
    await asPostgres();
    const outsiderRows = await client.query(
      "select count(*)::int as n from public.organization_engagement_events where user_id in ($1, $2)",
      [world.outsider.id, nobody.id],
    );
    expect(outsiderRows.rows[0].n).toBe(0);
  });

  it("keeps both tables closed to direct browser-role writes and reads", async () => {
    await become(world.memberOne);
    for (const statement of [
      ["insert into public.organization_engagement_events(organization_id,user_id,event_type,source_id) values ($1,$2,'page_view','direct')", [world.orgA, world.memberOne.id]],
      ["insert into public.organization_page_views(organization_id,path,hat,day,view_count) values ($1,'/direct','member',current_date,1)", [world.orgA]],
      ["select count(*) from public.organization_engagement_events", []],
      ["select count(*) from public.organization_page_views", []],
    ]) {
      await client.query("savepoint direct_write");
      await expect(client.query(statement[0], statement[1])).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint direct_write");
    }
    await asPostgres();
  });
});
