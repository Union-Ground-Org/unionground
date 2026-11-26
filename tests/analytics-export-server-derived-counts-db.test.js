// @vitest-environment node
//
// SEC-UG-ANALYTICS-EXPORT-SERVER-DERIVED-COUNTS-20260921
// request_organization_analytics_export used to write its receipt and audit
// event from caller-supplied row and suppression counts. It now takes the id of
// a snapshot that get_organization_analytics_snapshot issued to the same caller
// in the same organization within 24 hours, and copies the counts the server
// derived for that snapshot. This proof checks the derivation against the
// returned snapshot, that the receipt and audit event carry those counts, that
// the count-carrying signature is gone, and that foreign, unknown, expired and
// cross-organization snapshot ids are refused.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const repairSql = stripComments(loadMigrationSql("analytics_export_server_derived_counts")).replace(/\s+/g, " ");
const ROW_ARRAYS = ["chapters", "cases", "series", "heatmapPoints", "engagementCounts", "attendanceEvents"];

describe("analytics export server-derived counts (offline pins)", () => {
  it("drops the count-carrying signature and reads counts from the caller's issued snapshot", () => {
    expect(repairSql).toContain("drop function if exists public.request_organization_analytics_export(text, integer, integer);");
    expect(repairSql).toContain("e.actor_user_id = caller");
    expect(repairSql).toContain("e.metadata ->> 'entityId' = p_snapshot_id::text");
    expect(repairSql).toContain("e.created_at >= pg_catalog.now() - interval '24 hours'");
    expect(repairSql).not.toMatch(/p_row_count|p_suppressed_count/);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("analytics export receipts over a disposable database", () => {
  let client;
  const world = {};

  async function actor(label, chapter, org) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [org, id]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return { id, session };
  }

  async function grantRole(person, role, chapter, org) {
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [person.id, role, chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [person.id, role, chapter]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [org, person.id, role]);
  }

  async function become(person) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person.id,
      role: "authenticated",
      aal: "aal2",
      session_id: person.session,
    })]);
    await client.query("set local role authenticated");
  }

  async function asPostgres() {
    await client.query("reset role");
  }

  async function snapshot(person) {
    await become(person);
    const { rows } = await client.query("select public.get_organization_analytics_snapshot() as value");
    await asPostgres();
    return rows[0].value;
  }

  async function requestExport(person, format, snapshotId) {
    await become(person);
    await client.query("savepoint export_attempt");
    try {
      const { rows } = await client.query("select public.request_organization_analytics_export($1, $2::uuid) as value", [format, snapshotId]);
      await client.query("release savepoint export_attempt");
      return { value: rows[0].value };
    } catch (error) {
      await client.query("rollback to savepoint export_attempt");
      return { code: error.code, message: error.message };
    } finally {
      await asPostgres();
    }
  }

  function derive(value) {
    const rows = ROW_ARRAYS.flatMap((key) => value[key] || []);
    return {
      rowCount: rows.length,
      suppressedCount: rows.filter((row) => Object.values(row).some((field) => field === null)).length,
    };
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "analytics-export-server-derived-counts-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    for (const key of ["A", "B"]) {
      world[`org${key}`] = randomUUID();
      world[`chapter${key}`] = `ax-${key.toLowerCase()}-${world[`org${key}`].slice(0, 8)}`;
      await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world[`org${key}`], world[`chapter${key}`]]);
      await client.query(
        "insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97451)",
        [world[`chapter${key}`], world[`org${key}`]],
      );
    }
    world.coordinator = await actor("coordinator", world.chapterA, world.orgA);
    world.steward = await actor("steward", world.chapterA, world.orgA);
    await grantRole(world.coordinator, "coordinator", world.chapterA, world.orgA);
    await grantRole(world.steward, "steward", world.chapterA, world.orgA);

    // 25 distinct people with one engagement event publish one engagement
    // row with no withheld measure; the small chapter row and series row are
    // withheld. The derived counts therefore separate rows from suppressions.
    await client.query(`
      with people as (
        insert into auth.users(id,email)
        select gen_random_uuid(), 'ax-engaged-' || n || '-' || $2 || '@example.invalid'
        from pg_catalog.generate_series(1, 25) n
        returning id
      )
      insert into public.organization_engagement_events(organization_id,user_id,chapter_id,event_type,source_id)
      select $1, people.id, $3, 'qa_contribution', 'ax-' || people.id
      from people
    `, [world.orgA, world.orgA.slice(0, 8), world.chapterA]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("issues a snapshot id whose audit event carries the server-derived counts", async () => {
    const value = await snapshot(world.coordinator);
    world.snapshot = value;
    expect(value.snapshotId).toMatch(/^[0-9a-f-]{36}$/);
    const expected = derive(value);
    expect(expected.rowCount).toBeGreaterThan(expected.suppressedCount);
    expect(expected.suppressedCount).toBeGreaterThan(0);
    const { rows } = await client.query(
      `select metadata from public.organization_audit_events
       where organization_id=$1 and actor_user_id=$2 and event_type='analytics_snapshot_read'
         and metadata->>'entityId'=$3`,
      [world.orgA, world.coordinator.id, value.snapshotId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject(expected);
  });

  it("writes the receipt and export audit event from the snapshot, not the request", async () => {
    const expected = derive(world.snapshot);
    const result = await requestExport(world.coordinator, "csv", world.snapshot.snapshotId);
    expect(result.code).toBeUndefined();
    expect(result.value).toMatchObject({ ...expected, format: "csv", snapshotId: world.snapshot.snapshotId, organizationId: world.orgA });
    const receipt = await client.query("select row_count, suppressed_count, created_by from public.organization_analytics_exports where id=$1", [result.value.id]);
    expect(receipt.rows[0]).toEqual({ row_count: expected.rowCount, suppressed_count: expected.suppressedCount, created_by: world.coordinator.id });
    const audit = await client.query(
      `select metadata from public.organization_audit_events
       where organization_id=$1 and event_type='analytics_export_requested' and metadata->>'entityId'=$2`,
      [world.orgA, world.snapshot.snapshotId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).toMatchObject({ ...expected, exportFormat: "csv" });
  });

  it("no longer accepts caller-supplied counts", async () => {
    const { rows } = await client.query(
      "select pg_catalog.to_regprocedure('public.request_organization_analytics_export(text,integer,integer)') as legacy, pg_catalog.to_regprocedure('public.request_organization_analytics_export(text,uuid)') as current",
    );
    expect(rows[0].legacy).toBeNull();
    expect(rows[0].current).not.toBeNull();
  });

  it("refuses a snapshot issued to another caller, an unknown id and an expired snapshot", async () => {
    const stewardSnapshot = await snapshot(world.steward);
    expect(await requestExport(world.coordinator, "json", stewardSnapshot.snapshotId)).toMatchObject({ code: "22023" });
    expect(await requestExport(world.coordinator, "json", randomUUID())).toMatchObject({ code: "22023" });
    const expired = randomUUID();
    await client.query(
      `insert into public.organization_audit_events(organization_id,event_type,actor_user_id,idempotency_key,metadata,created_at)
       values ($1,'analytics_snapshot_read',$2,gen_random_uuid(),$3::jsonb,now() - interval '25 hours')`,
      [world.orgA, world.coordinator.id, JSON.stringify({ organizationId: world.orgA, surface: "organization_analytics_snapshot", entityId: expired, rowCount: 5000, suppressedCount: 0 })],
    );
    expect(await requestExport(world.coordinator, "json", expired)).toMatchObject({ code: "22023" });
    // A steward cannot export at all, whatever snapshot it names.
    expect(await requestExport(world.steward, "csv", stewardSnapshot.snapshotId)).toMatchObject({ code: "42501" });
  });

  it("refuses a snapshot issued in another organization after the caller switches", async () => {
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [world.coordinator.id, world.chapterB]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.orgB, world.coordinator.id]);
    await grantRole(world.coordinator, "coordinator", world.chapterB, world.orgB);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [world.coordinator.id, world.chapterB]);
    const orgA = world.snapshot.snapshotId;
    expect(await requestExport(world.coordinator, "csv", orgA)).toMatchObject({ code: "22023" });
    const orgBSnapshot = await snapshot(world.coordinator);
    expect(orgBSnapshot.organizationId).toBe(world.orgB);
    const result = await requestExport(world.coordinator, "csv", orgBSnapshot.snapshotId);
    expect(result.value).toMatchObject({ organizationId: world.orgB, ...derive(orgBSnapshot) });
  });
});
