// @vitest-environment node
//
// BUG-UG-PAST-EVENT-RSVP-POINTS-MINT-20260921
// rsvp_to_event checked only scope and cancellation, so a member could RSVP
// 'going' to every historical event in scope and mint the rsvp points for each.
// It now refuses once starts_at has passed, before any RSVP or action_log
// write. This proof drives the RPC as a chapter member against a past and a
// future event in the member's own chapter.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("event_rsvp_time_window")).replace(/\s+/g, " ");

describe("event RSVP time window (offline pins)", () => {
  it("refuses a past event before the RSVP and action_log writes, inside the case-graph gate", () => {
    expect(sql).toContain("begin perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
    const guard = sql.indexOf("if ev.starts_at < now() then");
    expect(guard).toBeGreaterThan(sql.indexOf("if ev.cancelled_at is not null then"));
    expect(guard).toBeLessThan(sql.indexOf("insert into public.member_event_rsvps"));
    expect(sql).toContain("detail = 'event_past'");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("rsvp_to_event over a disposable database", () => {
  let client;
  const world = {};

  async function asMember() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: world.member, role: "authenticated", aal: "aal2", session_id: world.session,
    })]);
    await client.query("set local role authenticated");
  }

  async function rsvp(eventId, status) {
    await asMember();
    await client.query("savepoint rsvp_attempt");
    try {
      const { rows } = await client.query("select public.rsvp_to_event($1, $2) as value", [eventId, status]);
      await client.query("release savepoint rsvp_attempt");
      return { value: rows[0].value };
    } catch (error) {
      await client.query("rollback to savepoint rsvp_attempt");
      return { code: error.code, detail: error.detail };
    } finally {
      await client.query("reset role");
    }
  }

  async function writes(eventId) {
    const rsvps = await client.query("select count(*)::int n from public.member_event_rsvps where event_id=$1 and user_id=$2", [eventId, world.member]);
    const log = await client.query("select count(*)::int n from public.member_action_log where user_id=$1 and action_key=$2", [world.member, `rsvp-${eventId}`]);
    return { rsvps: rsvps.rows[0].n, actionLog: log.rows[0].n };
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "event-rsvp-time-window-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");

    world.org = randomUUID();
    world.chapter = `rsvp-${world.org.slice(0, 8)}`;
    world.member = randomUUID();
    world.session = randomUUID();
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97471)", [world.chapter, world.org]);
    await client.query("insert into auth.users(id,email) values ($1,$2)", [world.member, `${world.member}-rsvp@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [world.session, world.member]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [world.member, world.chapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [world.member, world.chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, world.member]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), world.member]);

    world.past = `rsvp-past-${world.org.slice(0, 8)}`;
    world.future = `rsvp-future-${world.org.slice(0, 8)}`;
    await client.query(`
      insert into public.member_events
        (id, title, starts_at, location, summary, check_in_code, order_index, chapter_id, is_public, is_public_across_agencies)
      values
        ($1, 'Past meeting', now() - interval '3 days', 'Hall', 'Already happened', 'SG-P100', 97471, $3, false, false),
        ($2, 'Next meeting', now() + interval '3 days', 'Hall', 'Coming up', 'SG-F100', 97472, $3, false, false)
    `, [world.past, world.future, world.chapter]);
    world.rulePoints = (await client.query("select points from public.member_point_rules where action_kind='rsvp'")).rows[0]?.points ?? 0;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses 'going' on a past event and writes no RSVP or rsvp action_log row", async () => {
    expect(await rsvp(world.past, "going")).toEqual({ code: "22023", detail: "event_past" });
    expect(await writes(world.past)).toEqual({ rsvps: 0, actionLog: 0 });
  });

  it("refuses 'not_going' on a past event too", async () => {
    expect(await rsvp(world.past, "not_going")).toEqual({ code: "22023", detail: "event_past" });
    expect(await writes(world.past)).toEqual({ rsvps: 0, actionLog: 0 });
  });

  it("still records a future RSVP and awards the rsvp points once", async () => {
    const first = await rsvp(world.future, "going");
    expect(first.value).toEqual({ status: "going", awardedPoints: world.rulePoints });
    expect(await rsvp(world.future, "going")).toEqual({ value: { status: "going", awardedPoints: 0 } });
    expect(await writes(world.future)).toEqual({ rsvps: 1, actionLog: 1 });
  });
});
