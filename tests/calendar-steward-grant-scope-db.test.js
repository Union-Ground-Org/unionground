// @vitest-environment node
//
// SEC-UG-CALENDAR-CONNECTION-STEWARD-GRANT-SCOPE-20260920
// The daily calendar sync iterates public.list_steward_calendar_oauth_tokens.
// This proof executes it on a disposable catalog: a connection stays in the
// inventory only while its owner holds an active, membership-backed steward
// grant (organization grant, chapter grant), leaves it when the grant or the
// membership behind it lapses, and the former steward can still remove their
// own connection through public.remove_calendar_connection.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const repairSql = stripComments(loadMigrationSql("calendar_sync_steward_grant_scope")).replace(/\s+/g, " ");

describe("calendar sync steward grant scope (offline pins)", () => {
  it("gates the inventory on a live grant and drops the steward gate on owner removal", () => {
    expect(repairSql).toContain("where private.calendar_steward_grant_active(token.steward_id)");
    expect(repairSql).toContain("revoke all on function private.calendar_steward_grant_active(uuid) from public, anon, authenticated, service_role;");
    const removal = repairSql.slice(repairSql.indexOf("create or replace function public.remove_calendar_connection"));
    expect(removal).not.toContain("member_has_role");
    expect(removal).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("calendar sync inventory follows the steward grant over a disposable database", () => {
  let client;
  const world = {};

  async function person(label) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, world.chapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, world.chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, id]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    await client.query(
      "insert into public.member_calendar_connections(steward_id,provider,status) values ($1,'google','active')",
      [id],
    );
    await client.query(
      "insert into private.steward_calendar_oauth_tokens(steward_id,provider,refresh_token_ciphertext,scopes) values ($1,'google',repeat('g',40),'https://www.googleapis.com/auth/calendar.freebusy')",
      [id],
    );
    return { id, session };
  }

  async function asPostgres() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function inventory() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    await client.query("set local role service_role");
    const { rows } = await client.query("select public.list_steward_calendar_oauth_tokens() as value");
    await asPostgres();
    const mine = new Set([world.orgSteward.id, world.chapterSteward.id, world.memberOnly.id]);
    return rows[0].value.filter((row) => mine.has(row.stewardId)).map((row) => row.stewardId).sort();
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "calendar-steward-grant-scope-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");

    world.org = randomUUID();
    world.chapter = `cal-${world.org.slice(0, 8)}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97433)", [world.chapter, world.org]);

    world.orgSteward = await person("org-steward");
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'steward',$2)", [world.org, world.orgSteward.id]);
    world.chapterSteward = await person("chapter-steward");
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [world.chapterSteward.id, world.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [world.chapterSteward.id, world.chapter]);
    // A connection whose owner never held a steward grant.
    world.memberOnly = await person("member");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("lists only connections whose owner holds an active steward grant", async () => {
    expect(await inventory()).toEqual([world.orgSteward.id, world.chapterSteward.id].sort());
  });

  it("drops a connection when the grant or the membership behind it lapses, and restores it with the grant", async () => {
    await client.query("delete from public.member_role_chapters where user_id=$1", [world.chapterSteward.id]);
    expect(await inventory()).toEqual([world.orgSteward.id]);

    await client.query(
      "update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2",
      [world.org, world.orgSteward.id],
    );
    expect(await inventory()).toEqual([]);

    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [world.chapterSteward.id, world.chapter]);
    expect(await inventory()).toEqual([world.chapterSteward.id]);
  });

  it("lets a person whose grant lapsed remove their own connection and token custody", async () => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: world.orgSteward.id,
      role: "authenticated",
      aal: "aal2",
      session_id: world.orgSteward.session,
    })]);
    await client.query("set local role authenticated");
    const { rows } = await client.query("select public.remove_calendar_connection('google') as value");
    expect(rows[0].value).toEqual({ provider: "google", removed: true });
    await asPostgres();
    const left = (await client.query(
      `select (select count(*) from public.member_calendar_connections where steward_id=$1)::int
            + (select count(*) from private.steward_calendar_oauth_tokens where steward_id=$1)::int as n`,
      [world.orgSteward.id],
    )).rows[0].n;
    expect(left).toBe(0);
    // Only the caller's own rows were touched.
    const others = (await client.query(
      "select count(*)::int as n from private.steward_calendar_oauth_tokens where steward_id = any($1::uuid[])",
      [[world.chapterSteward.id, world.memberOnly.id]],
    )).rows[0].n;
    expect(others).toBe(2);
  });
});
