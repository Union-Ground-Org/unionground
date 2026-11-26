// @vitest-environment node
//
// BUG-UG-WEB-COORDINATION-LEADERBOARDS-UNBOUNDED-20261002
//
// 20261003047000 re-emits get_organization_coordination_snapshot with each
// mission leaderboard carrying the mission status and the participant total,
// active missions first, so the Missions tab can show active boards and fold
// completed ones away. Static pins: only the leaderboard projection changes.
// Union Ground has no points economy, so
// 20261015150000 removes the leaderboards from the installed snapshot. The
// static pins above still describe the Union Ground re-emit as it shipped; the
// live proof below runs the installed function (one rolled-back transaction)
// over the same fixture and proves that no board, participant point, ranking
// alias or participant total leaves the database, for either organization.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("coordination_leaderboard_status_and_totals"));
const previous = stripComments(loadMigrationSql("20260921221000_organization_coordination_caller_completion_projection"));
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

function withoutLeaderboards(body) {
  const start = body.indexOf("'leaderboards', coalesce((");
  const end = body.indexOf("'messages', coalesce((", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return (body.slice(0, start) + body.slice(end)).replace(/\s+/g, " ");
}

describe("coordination leaderboard status and totals (static)", () => {
  const body = fnBody(sql, "public.get_organization_coordination_snapshot");

  it("adds the mission status and participant total and puts active boards first", () => {
    expect(body).toContain("'missionId', r.id, 'title', r.title, 'status', r.status,");
    expect(body).toMatch(/'participantCount', \(\s+select pg_catalog\.count\(\*\)\s+from public\.organization_coordination_user_participants counted\s+where counted\.record_id = r\.id and counted\.status in \('active', 'completed'\)/);
    expect(body).toContain("case r.status when 'active' then 0 else 1 end as status_rank");
    expect(body).toContain("pg_catalog.jsonb_agg(board.payload order by board.status_rank, board.title, board.id)");
    // The listed rows keep their cap and privacy aliases.
    expect(body).toContain("order by p.points desc, p.privacy_alias limit 100");
    expect(body).toContain("'alias', ranked.privacy_alias");
    expect(body).toContain("where r.kind = 'mission' and r.status in ('active', 'completed')");
  });

  it("changes nothing else in the snapshot", () => {
    expect(withoutLeaderboards(body)).toBe(withoutLeaderboards(fnBody(previous, "public.get_organization_coordination_snapshot")));
    expect(sql).toContain("revoke all on function public.get_organization_coordination_snapshot()\n  from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_organization_coordination_snapshot()\n  to authenticated;");
  });
});

live("coordination leaderboard status and totals on a disposable database", () => {
  let client;
  const ids = { orgA: randomUUID(), orgB: randomUUID(), staffA: randomUUID(), staffB: randomUUID() };
  const suffix = ids.orgA.slice(0, 8);
  ids.chapterA = `board-a-${suffix}`;
  ids.chapterB = `board-b-${suffix}`;
  const sessions = new Map();
  const missions = {};

  async function as(user, statement) {
    await client.query("savepoint proof");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: "authenticated", aal: "aal2", session_id: sessions.get(user) })]);
      await client.query("set local role authenticated");
      const { rows } = await client.query(statement);
      await client.query("release savepoint proof");
      return { value: rows[0]?.value };
    } catch (error) {
      await client.query("rollback to savepoint proof");
      return { code: error.code, message: error.message };
    } finally {
      await client.query("reset role");
    }
  }

  async function staff(user, org, chapter) {
    const session = randomUUID();
    sessions.set(user, session);
    await client.query("insert into auth.users(id,email) values ($1,$2)", [user, `${user}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'admin',$2),($1,$2,'coordinator',$2) on conflict do nothing", [org, user]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, user]);
  }

  async function mission(title, status) {
    const id = randomUUID();
    await client.query(
      `insert into public.organization_coordination_records (id, organization_id, kind, title, summary, status, visibility, config, created_by, idempotency_key)
       values ($1, $2, 'mission', $3, '', $4, 'members', '{}', $5, gen_random_uuid())`,
      [id, ids.orgA, title, status, ids.staffA],
    );
    missions[title] = id;
    return id;
  }

  async function participants(missionId, count, status = "active") {
    await client.query(
      `with people as (
         insert into auth.users(id, email)
         select gen_random_uuid(), 'board-' || gen_random_uuid() || '@example.invalid' from generate_series(1, $2)
         returning id
       ), numbered as (select id, row_number() over (order by id) n from people)
       insert into public.organization_coordination_user_participants (record_id, organization_id, user_id, role, status, points, privacy_alias)
       select $1, $3, id, 'participant', $4, n::integer, 'Member ' || substr(md5(id::text), 1, 6) from numbered`,
      [missionId, count, ids.orgA, status],
    );
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "coordination-leaderboard-status-proof" });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2),($3,$4,$4)", [ids.orgA, `board-a-${suffix}`, ids.orgB, `board-b-${suffix}`]);
    for (const [chapter, org, order] of [[ids.chapterA, ids.orgA, 9981], [ids.chapterB, ids.orgB, 9982]]) {
      await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,$3)", [chapter, org, order]);
    }
    await staff(ids.staffA, ids.orgA, ids.chapterA);
    await staff(ids.staffB, ids.orgB, ids.chapterB);
    // Transaction-only fixture: participants are written directly, with the
    // badge and inheritance row triggers off.
    await client.query("set local session_replication_role = replica");
    await participants(await mission("Zeta drive", "active"), 105);
    await participants(await mission("Alpha finished", "completed"), 3, "completed");
    const beta = await mission("Beta drive", "active");
    await participants(beta, 2);
    await participants(beta, 4, "declined");
    await mission("Gamma draft", "draft");
    await client.query("set local session_replication_role = origin");
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("returns the missions as records but no leaderboards, points, aliases or participant totals", async () => {
    const { value, code, message } = await as(ids.staffA, "select public.get_organization_coordination_snapshot() as value");
    expect(code, message).toBeUndefined();
    expect(value.state).toBe("ready");
    expect(Object.keys(value)).not.toContain("leaderboards");
    const listed = value.records.filter((record) => Object.values(missions).includes(record.id));
    expect(listed.map((record) => record.title).sort()).toEqual(["Alpha finished", "Beta drive", "Gamma draft", "Zeta drive"]);
    const text = JSON.stringify(value);
    expect(text).not.toMatch(/"points"|"participantCount"|"alias"|Member [0-9a-f]{6}/);
  });

  it("keeps the leaderboards out for another organization's staff too", async () => {
    const { value, code, message } = await as(ids.staffB, "select public.get_organization_coordination_snapshot() as value");
    expect(code, message).toBeUndefined();
    expect(Object.keys(value)).not.toContain("leaderboards");
    expect(value.records.some((record) => Object.values(missions).includes(record.id))).toBe(false);
  });
});
