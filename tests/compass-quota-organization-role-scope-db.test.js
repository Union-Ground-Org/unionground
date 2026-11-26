// @vitest-environment node
//
// SEC-UG-COMPASS-QUOTA-ORGANIZATION-ROLE-SCOPE-20260921
// reserve_compass_ai_request and the authorize_compass_ai_dispatch recheck
// chose the Compass quota tier from account-global member_roles rows. They now
// count only organization role grants in the member's selected organization.
// This proof gives one member a coordinator grant in organization B (and a
// legacy account-global coordinator member_roles row) while organization A is
// selected, and requires the member tier in A, the coordinator tier after the
// member selects B, and a dispatch recheck that follows the same scope.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("compass_quota_organization_role_scope")).replace(/\s+/g, " ");
const MESH = "union-ground-mesh";
const ALIAS = "union-ground/compass-mesh:v1";

describe("Compass quota organization role scope (offline pins)", () => {
  it("derives quota roles from grants in the selected organization in both functions", () => {
    for (const fn of ["reserve_compass_ai_request", "authorize_compass_ai_dispatch"]) {
      const body = sql.split(`create or replace function public.${fn}(`)[1].split("$$;")[0];
      expect(body).toContain("quota_organization uuid := private.member_organization_for(p_user_id)");
      expect(body).toContain("and r.organization_id = quota_organization");
      expect(body).not.toContain("public.member_roles");
      expect(body).toContain("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("Compass quota tiers over a disposable database", () => {
  let client;
  const world = {};

  async function reserve() {
    const { rows } = await client.query("select public.reserve_compass_ai_request($1, $2, $3, true, true) as r", [world.member, MESH, ALIAS]);
    return rows[0].r;
  }

  async function dispatch(requestId) {
    const { rows } = await client.query("select public.authorize_compass_ai_dispatch($1, $2, $3, $4, true, true) as d", [requestId, world.member, MESH, ALIAS]);
    return rows[0].d;
  }

  async function select(key) {
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [world.member, world[`chapter${key}`]]);
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "compass-quota-organization-role-scope-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    world.member = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [world.member, `${world.member}-compass-quota@example.invalid`]);
    for (const key of ["A", "B"]) {
      world[`org${key}`] = randomUUID();
      world[`chapter${key}`] = `cq-${key.toLowerCase()}-${world[`org${key}`].slice(0, 8)}`;
      await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world[`org${key}`], world[`chapter${key}`]]);
      await client.query(
        "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97461)",
        [world[`chapter${key}`], world[`org${key}`]],
      );
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [world[`org${key}`], world.member]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [world.member, world[`chapter${key}`]]);
    }
    // Coordinator only in organization B, plus the legacy account-global row
    // the old derivation read.
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,'coordinator',$2)", [world.orgB, world.member]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'coordinator',$2) on conflict do nothing", [world.member, world.chapterB]);
    await client.query("update public.compass_ai_role_limits set hourly_limit = 2 where role = 'coordinator'");
    await client.query("update public.compass_ai_role_limits set hourly_limit = 20 where role = 'member'");
    await client.query("update public.compass_ai_policy set enabled = true where id = true");
    await client.query(`
      insert into public.compass_ai_provider_attestations
        (status, gateway, model, zero_data_retention, disallow_prompt_training, evidence_ref, expires_at, attested_by)
      values ('verified', $1, $2, true, true, 'sha256:${"b".repeat(64)} https://mesh.example.org', now() + interval '1 day', $3)
    `, [MESH, ALIAS, world.member]);
    await select("A");
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("gives the member tier in organization A although the member coordinates B", async () => {
    const reservation = await reserve();
    expect(reservation).toMatchObject({ cause: null, role: "member", limit: 20 });
    world.firstReservation = reservation.id;
  });

  it("keeps the dispatch recheck on organization A's tier", async () => {
    // Three reservations exceed the coordinator cap of 2 but not the member cap.
    await reserve();
    await reserve();
    expect(await dispatch(world.firstReservation)).toMatchObject({ authorized: true, cause: null });
  });

  it("applies the coordinator tier once organization B is selected, in reserve and recheck", async () => {
    await select("B");
    const pending = (await client.query(
      "select id from public.member_ai_requests where user_id=$1 and dispatch_authorized_at is null order by created_at limit 1",
      [world.member],
    )).rows[0].id;
    // The request remains bound to A; switching organizations invalidates it before quota recheck.
    expect(await dispatch(pending)).toMatchObject({ authorized: false, cause: "reservation" });
    expect(await reserve()).toMatchObject({ id: null, cause: "role", role: "coordinator", limit: 2 });
  });

  it("refuses an ambiguous organization when no chapter is selected (SEC-UG-COMPASS-ORG-POLICY-ENFORCEMENT-20261002)", async () => {
    // Two active memberships and no selected chapter: no organization policy
    // could be applied, so the reservation is refused instead of falling back
    // to the platform policy alone.
    await client.query("update public.member_profiles set chapter_id=null where id=$1", [world.member]);
    await client.query("delete from public.member_ai_requests where user_id=$1", [world.member]);
    expect(await reserve()).toEqual({ id: null, cause: "organization" });
  });
});
