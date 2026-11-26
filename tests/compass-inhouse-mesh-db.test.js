// @vitest-environment node
//
// REQ-UG-AI-PROVIDER-INHOUSE-MESH-20260912 and
// REQ-UG-MESH-ANONYMIZATION-STANDARD-20260912.
// Static half: pins the migration text. Live half (SUPABASE_DB_URL on the
// disposable loopback target): the widened policy CHECKs, connector routing in
// reserve/authorize, the resolve RPC, the k > 100 aggregate floor, and the
// same-transaction removal when an organization is archived.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("compass_inhouse_mesh_provider"));
const MESH = "union-ground-mesh";
const ALIAS = "union-ground/compass-mesh:v1";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ids = {
  member: "50916230-0000-4000-8000-000000000001",
  organization: "50916230-0000-4000-8000-000000000101",
  chapter: "compass-mesh-proof",
  session: "50916230-0000-4000-8000-000000000201",
  factor: "50916230-0000-4000-8000-000000000301",
};

describe("Compass in-house mesh migration (static)", () => {
  it("sorts after the pg_net tick request-id migration it was written against and re-pins the policy singleton to the mesh", () => {
    expect(findMigrationName("compass_inhouse_mesh_provider") > "20260915180000_pg_net_tick_request_id_idempotency.sql").toBe(true);
    expect(sql).toContain("drop constraint compass_ai_policy_gateway_check");
    expect(sql).toContain("check (gateway = 'union-ground-mesh')");
    expect(sql).toContain("check (model ~ '^union-ground/compass-mesh:v[0-9]+$')");
    expect(sql).toMatch(/update public\.compass_ai_policy\s+set gateway = 'union-ground-mesh',\s+model = 'union-ground\/compass-mesh:v1'/);
    expect(sql).not.toMatch(/insert into public\.compass_ai_provider_attestations/);
    expect(sql).not.toMatch(/set enabled = true/);
  });

  it("adds the three agency connectors with one-connected-per-organization and Vault-only keys", () => {
    expect(sql).toContain("'ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt'");
    expect(sql).toContain("constraint organization_integrations_ai_connector_rules");
    expect(sql).toContain("create unique index organization_integrations_one_connected_ai_connector_idx");
    expect(sql).toContain("vault.create_secret(");
    expect(sql).toContain("from vault.decrypted_secrets s");
    expect(sql).toContain("grant execute on function public.resolve_compass_ai_provider(uuid) to service_role");
    expect(sql).not.toMatch(/grant execute on function public\.resolve_compass_ai_provider\(uuid\) to authenticated/);
  });

  it("routes both governance RPCs through the provider permission check and caps the live reserve by strictest role and the shared ceiling", () => {
    for (const fn of ["reserve_compass_ai_request", "authorize_compass_ai_dispatch"]) {
      const body = sql.split(`create or replace function public.${fn}(`)[1].split("$$;")[0];
      expect(body).toContain("private.compass_ai_provider_permitted(p_user_id, p_gateway, p_model, policy.gateway, policy.model)");
      expect(body).toContain("pg_advisory_xact_lock");
      expect(body).toContain("latest_attestation.status = 'verified'");
    }
    expect(sql).toContain("'evidence_ref', latest_attestation.evidence_ref");

    // TEST-UG-LIVE-COMPASS-RESERVE-ROLE-CAP-COVERAGE-20260920: the older
    // governance suite reads the retired 20260812113000 text, so the quota math
    // of the definition that actually runs was unpinned. Read the last
    // definition in apply order (20260925250000 at the time of writing).
    const reserve = stripComments(latestFnBody("reserve_compass_ai_request")).replace(/\s+/g, " ");
    // Every privileged role held in the quota organization needs a configured
    // limit, and an unroled member needs exactly one 'member' row; otherwise
    // the reservation is refused rather than taking a looser cap.
    expect(reserve).toContain("select pg_catalog.count(*)::integer into assigned_role_count from public.organization_role_grants r where r.user_id = p_user_id and r.organization_id = quota_organization and r.role in ('steward', 'coordinator', 'advisor', 'admin', 'vp');");
    expect(reserve).toContain("where l.role = 'member'; configured_role_count := case when found then 1 else 0 end; if configured_role_count <> 1 then return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');");
    expect(reserve).toContain("if configured_role_count <> assigned_role_count then return pg_catalog.jsonb_build_object('id', null, 'cause', 'role_unconfigured');");
    // The strictest role wins by the lowest configured hourly limit; the 1..5
    // tiebreak names every privileged role so equal limits resolve the same way.
    expect(reserve).toContain("order by l.hourly_limit asc, case l.role when 'steward' then 1 when 'coordinator' then 2 when 'advisor' then 3 when 'admin' then 4 else 5 end limit 1;");
    // The reward bonus may raise the platform allowance, never past 200 or the
    // organization cap (SEC-UG-COMPASS-ORG-POLICY-ENFORCEMENT-20261002).
    expect(reserve).toContain("effective_limit := least( 200, effective_limit + private.compass_ai_reward_quota_bonus(p_user_id), organization_cap );");
    // Per-user limit over this member's last hour, refused as 'role'.
    expect(reserve).toContain("select pg_catalog.count(*)::integer into recent_user_count from public.member_ai_requests where user_id = p_user_id and created_at >= now() - interval '1 hour'; if recent_user_count >= effective_limit then perform private.mesh_usage_bump(p_user_id, 'compass_rate_limited'); return pg_catalog.jsonb_build_object('id', null, 'cause', 'role', 'role', effective_role, 'limit', effective_limit); end if;");
    // Shared limit over every member's last hour, refused as 'shared'.
    expect(reserve).toContain("select pg_catalog.count(*)::integer into recent_global_count from public.member_ai_requests where created_at >= now() - interval '1 hour'; if recent_global_count >= 200 then perform private.mesh_usage_bump(p_user_id, 'compass_rate_limited'); return pg_catalog.jsonb_build_object('id', null, 'cause', 'shared'); end if;");
  });

  it("defines the aggregation standard: weekly org-level rows, allowlisted metrics, user_count > 100, lifecycle removal", () => {
    expect(sql).toContain("create table private.mesh_agency_usage_counters");
    expect(sql).toContain("create table public.mesh_agency_usage_aggregates");
    expect(sql).toContain("constraint mesh_agency_usage_aggregates_floor_check check (user_count > 100)");
    expect(sql).toMatch(/period_start = \(pg_catalog\.date_trunc\('week', period_start::timestamp\)\)::date/);
    expect(sql).not.toMatch(/mesh_agency_usage_(counters|aggregates) \([^;]*(user_id|member_id|device|session|email|ip_address)/);
    expect(sql).toContain("after update of status on public.organizations");
    expect(sql).toContain("delete from public.mesh_agency_usage_aggregates where organization_id = new.id");
    expect(sql).toContain("having pg_catalog.count(*) > 100");
    expect(sql).toContain("'mesh-agency-usage-aggregate-tick'");
    expect(sql).toContain("alter table public.mesh_agency_usage_aggregates force row level security");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("Compass in-house mesh migration (disposable database)", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "compass-mesh-proof",
    });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  async function inTransaction(run) {
    await client.query("begin");
    try {
      await run();
    } finally {
      await client.query("rollback");
    }
  }

  async function seedOrganization({ extraMembers = 0 } = {}) {
    await client.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'compass-mesh-proof@example.invalid', '{}'::jsonb)`, [ids.member]);
    await client.query(`insert into public.organizations (id, slug, name, created_by) values ($1, 'compass-mesh-proof', 'Compass Mesh Proof', $2)`, [ids.organization, ids.member]);
    await client.query(`insert into public.chapters (id, name, slug, is_default, order_index, organization_id) values ($1, 'Compass Mesh Proof', $1, false, 9901, $2)`, [ids.chapter, ids.organization]);
    await client.query(`insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')`, [ids.organization, ids.member]);
    await client.query(`insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')`, [ids.member, ids.chapter]);
    await client.query(`update public.member_profiles set chapter_id = $1 where id = $2`, [ids.chapter, ids.member]);
    if (extraMembers > 0) {
      await client.query(`
        insert into auth.users (id, email, raw_user_meta_data)
        select ('50916230-0000-4000-8000-1' || lpad(n::text, 11, '0'))::uuid, 'compass-mesh-proof-' || n || '@example.invalid', '{}'::jsonb
        from generate_series(1, $1::int) n
      `, [extraMembers]);
      await client.query(`
        insert into public.organization_memberships (organization_id, user_id, status)
        select $1, ('50916230-0000-4000-8000-1' || lpad(n::text, 11, '0'))::uuid, 'active'
        from generate_series(1, $2::int) n
      `, [ids.organization, extraMembers]);
    }
  }

  async function enableMeshPolicy() {
    await client.query(`update public.compass_ai_policy set enabled = true where id = true`);
    await client.query(`
      insert into public.compass_ai_provider_attestations
        (status, gateway, model, zero_data_retention, disallow_prompt_training, evidence_ref, expires_at, attested_by)
      values ('verified', $1, $2, true, true, $3, pg_catalog.now() + interval '1 day', $4)
    `, [MESH, ALIAS, `${DIGEST} https://mesh.example.org`, ids.member]);
  }

  const PROOF_CONNECTOR_SECRET = ["agency", "proof", "credential"].join("-") + "-0123456789";

  async function connectGpt(apiKey = PROOF_CONNECTOR_SECRET) {
    const { rows: [{ id }] } = await client.query(`select vault.create_secret($1, 'compass-mesh-proof-secret', 'proof') as id`, [apiKey]);
    await client.query(`
      insert into public.organization_integrations
        (organization_id, provider, status, account_owner, allow_chapter_overrides, allow_chapter_owned_accounts, default_settings, credential_ref)
      values ($1, 'ai_connector_gpt', 'connected', 'organization', false, false, $2::jsonb, $3)
    `, [ids.organization, JSON.stringify({ model: "gpt-5-mini", enabledAt: new Date().toISOString(), enabledBy: ids.member, termsAcknowledged: true, attestation: "agency" }), id]);
    return id;
  }

  // The seeded member becomes the organization's MFA-verified integration
  // admin: an active organization role grant, a security policy that does not
  // demand a staff second factor, and an aal2 session the JWT claims name.
  async function seedIntegrationAdmin() {
    await client.query("insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)", [ids.organization, ids.member]);
    await client.query("insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by) values (true, $1, false, $2)", [ids.organization, ids.member]);
    await client.query("insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [ids.session, ids.member]);
  }

  async function asRole(role, claims) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : null]);
    if (role) await client.query(`set local role ${role}`);
  }
  const asMember = (aal = "aal2") => asRole("authenticated", { sub: ids.member, session_id: ids.session, role: "authenticated", aal });
  const asServiceRole = () => asRole("service_role", { role: "service_role" });
  const asOwner = () => asRole(null, null);

  async function connectorSecrets() {
    return (await client.query("select decrypted_secret from vault.decrypted_secrets where name like 'ai-connector-%' order by created_at")).rows.map((row) => row.decrypted_secret);
  }

  it("keeps the policy singleton on the mesh and makes the retired route unrepresentable", async () => {
    await inTransaction(async () => {
      const { rows: [policy] } = await client.query("select enabled, gateway, model from public.compass_ai_policy where id = true");
      expect(policy).toEqual({ enabled: false, gateway: MESH, model: ALIAS });
      await expect(client.query("update public.compass_ai_policy set gateway = 'vercel-ai-gateway' where id = true")).rejects.toThrow(/compass_ai_policy_gateway_check/);
    });
    await inTransaction(async () => {
      await expect(client.query("update public.compass_ai_policy set model = 'google/gemini-3-flash' where id = true")).rejects.toThrow(/compass_ai_policy_model_check/);
    });
    await inTransaction(async () => {
      await client.query("update public.compass_ai_policy set model = 'union-ground/compass-mesh:v2' where id = true");
      await expect(client.query("update public.compass_ai_policy set model = 'other/model:v1' where id = true")).rejects.toThrow(/compass_ai_policy_model_check/);
    });
  });

  it("keeps mesh primary even when a historical organization connector remains", async () => {
    await inTransaction(async () => {
      await seedOrganization(); await enableMeshPolicy(); await connectGpt();
      expect((await client.query("select public.resolve_compass_ai_provider($1) as r", [ids.member])).rows[0].r).toEqual({ gateway: MESH, model: ALIAS });
      const args = [ids.member, MESH, ALIAS, true, true];
      const r = (await client.query("select public.reserve_compass_ai_request($1,$2,$3,$4,$5) as r", args)).rows[0].r;
      expect(r.id).toEqual(expect.any(String));
      expect((await client.query("select public.authorize_compass_ai_dispatch($1,$2,$3,$4,$5,$6) as r", [r.id, ...args])).rows[0].r).toMatchObject({ authorized: true, evidence_ref: `${DIGEST} https://mesh.example.org` });
      expect((await client.query("select public.reserve_compass_ai_request($1,'ai_connector_gpt','gpt-5-mini',true,true) as r", [ids.member])).rows[0].r).toEqual({ id: null, cause: "config" });
    });
  });

  it("refuses tenant Fireworks activation now that platform operators own failover", async () => {
    await inTransaction(async () => {
      await seedOrganization(); await seedIntegrationAdmin(); await asMember();
      await client.query("savepoint activation");
      await expect(client.query("select public.enable_organization_ai_connector('ai_connector_fireworks','accounts/fireworks/models/muse-spark-open',$1)", [PROOF_CONNECTOR_SECRET])).rejects.toThrow(/managed centrally/);
      await client.query("rollback to savepoint activation"); await asOwner();
      expect(await connectorSecrets()).toEqual([]);
    });
  });

  it("does not let a missing historical tenant credential disable the platform mesh", async () => {
    await inTransaction(async () => {
      await seedOrganization(); await enableMeshPolicy();
      const secret = await connectGpt(); await client.query("delete from vault.secrets where id=$1", [secret]);
      expect((await client.query("select public.resolve_compass_ai_provider($1) as r", [ids.member])).rows[0].r).toEqual({ gateway: MESH, model: ALIAS });
      expect((await client.query("select public.reserve_compass_ai_request($1,$2,$3,true,true) as r", [ids.member,MESH,ALIAS])).rows[0].r.id).toEqual(expect.any(String));
    });
  });

  it("retains secure retirement of historical keys and refuses generic connector writes", async () => {
    await inTransaction(async () => {
      await seedOrganization(); await seedIntegrationAdmin(); await connectGpt(); await asMember();
      await client.query("savepoint generic_write");
      await expect(client.query("select public.upsert_organization_integration('ai_connector_gpt','connected','organization',false,false,'{}'::text[],'{}'::jsonb,'ref')")).rejects.toThrow(/enabled through enable_organization_ai_connector/);
      await client.query("rollback to savepoint generic_write");
      expect((await client.query("select public.disable_organization_ai_connector('ai_connector_gpt') as r")).rows[0].r).toEqual({ provider: "ai_connector_gpt", status: "disabled" });
      await asOwner(); expect(await connectorSecrets()).toEqual([]);
    });
  });

  it("restarts counting from the first full week after reactivation", async () => {
    await inTransaction(async () => {
      await seedOrganization();
      await client.query("update public.organizations set status = 'suspended' where id = $1", [ids.organization]);
      await client.query("update public.organizations set status = 'active' where id = $1", [ids.organization]);
      const { rows: [{ counting_from: from, week }] } = await client.query(
        "select s.counting_from, (pg_catalog.date_trunc('week', pg_catalog.now()::timestamp))::date as week from private.mesh_agency_usage_start s where s.organization_id = $1",
        [ids.organization],
      );
      expect(new Date(from) > new Date(week)).toBe(true);
      await client.query("select private.mesh_usage_bump($1, 'compass_requests')", [ids.member]);
      expect((await client.query("select count(*)::int as n from private.mesh_agency_usage_counters where organization_id = $1", [ids.organization])).rows[0].n).toBe(0);
    });
  });

  it("applies the kill switch and attestation to mesh despite a historical connector", async () => {
    await inTransaction(async () => {
      await seedOrganization();
      await connectGpt();
      const args = [ids.member, MESH, ALIAS, true, true];
      const { rows: [{ r: disabled }] } = await client.query("select public.reserve_compass_ai_request($1, $2, $3, $4, $5) as r", args);
      expect(disabled).toEqual({ id: null, cause: "disabled" });
      await client.query("update public.compass_ai_policy set enabled = true where id = true");
      const { rows: [{ r: unattested }] } = await client.query("select public.reserve_compass_ai_request($1, $2, $3, $4, $5) as r", args);
      expect(unattested).toEqual({ id: null, cause: "unattested" });
    });
  });

  it("refuses a second connected connector, a connected row without a key, and chapter overrides", async () => {
    await inTransaction(async () => {
      await seedOrganization();
      await connectGpt();
      const settings = JSON.stringify({ model: "gemini-2.5-flash", enabledAt: new Date().toISOString(), enabledBy: ids.member, termsAcknowledged: true, attestation: "agency" });
      await expect(client.query(`
        insert into public.organization_integrations (organization_id, provider, status, default_settings, credential_ref)
        values ($1, 'ai_connector_gemini', 'connected', $2::jsonb, 'ref')
      `, [ids.organization, settings])).rejects.toThrow(/organization_integrations_one_connected_ai_connector_idx/);
    });
    await inTransaction(async () => {
      await seedOrganization();
      await client.query("savepoint rules");
      await expect(client.query(`
        insert into public.organization_integrations (organization_id, provider, status, default_settings)
        values ($1, 'ai_connector_claude', 'connected', '{"model":"claude-sonnet-5"}'::jsonb)
      `, [ids.organization])).rejects.toThrow(/organization_integrations_ai_connector_rules/);
      await client.query("rollback to savepoint rules");
      await expect(client.query(`
        insert into public.organization_integrations (organization_id, provider, status, allow_chapter_overrides)
        values ($1, 'ai_connector_claude', 'disabled', true)
      `, [ids.organization])).rejects.toThrow(/organization_integrations_ai_connector_rules/);
      await client.query("rollback to savepoint rules");
      await client.query(`
        insert into public.organization_integrations (organization_id, provider, status)
        values ($1, 'ai_connector_claude', 'disabled')
      `, [ids.organization]);
    });
  });

  it("suppresses every aggregate at or below 100 users, reports above it, and removes rows when the organization is archived", async () => {
    await inTransaction(async () => {
      await seedOrganization({ extraMembers: 99 });
      const { rows: [{ week }] } = await client.query("select (pg_catalog.date_trunc('week', pg_catalog.now()::timestamp))::date as week");
      await client.query("select private.mesh_usage_bump($1, 'compass_requests')", [ids.member]);
      await client.query("select private.mesh_usage_bump($1, 'compass_requests')", [ids.member]);
      await client.query("select private.mesh_usage_bump($1, 'compass_answered')", [ids.member]);
      const { rows: counters } = await client.query("select metric, value::int as value, period_start from private.mesh_agency_usage_counters where organization_id = $1 order by metric", [ids.organization]);
      expect(counters).toEqual([
        { metric: "compass_answered", value: 1, period_start: week },
        { metric: "compass_requests", value: 2, period_start: week },
      ]);

      // Exactly 100 active users: nothing is written and nothing is reported.
      const { rows: [{ written: none }] } = await client.query("select private.compute_mesh_agency_usage_aggregates($1) as written", [week]);
      expect(none).toBe(0);
      expect((await client.query("select count(*)::int as n from public.mesh_agency_usage_aggregates where organization_id = $1", [ids.organization])).rows[0].n).toBe(0);

      // 101 active users: rows appear with the group size recorded.
      await client.query(`insert into auth.users (id, email, raw_user_meta_data) values ('50916230-0000-4000-8000-200000000001', 'compass-mesh-proof-101@example.invalid', '{}'::jsonb)`);
      await client.query(`insert into public.organization_memberships (organization_id, user_id, status) values ($1, '50916230-0000-4000-8000-200000000001', 'active')`, [ids.organization]);
      const { rows: [{ written }] } = await client.query("select private.compute_mesh_agency_usage_aggregates($1) as written", [week]);
      expect(written).toBe(3);
      const { rows: aggregates } = await client.query("select metric, value::int as value, user_count from public.mesh_agency_usage_aggregates where organization_id = $1 order by metric", [ids.organization]);
      expect(aggregates).toEqual([
        { metric: "active_users", value: 101, user_count: 101 },
        { metric: "compass_answered", value: 1, user_count: 101 },
        { metric: "compass_requests", value: 2, user_count: 101 },
      ]);

      // The schema itself refuses the floor, an unknown metric, and a finer period.
      await client.query("savepoint floor");
      await expect(client.query("insert into public.mesh_agency_usage_aggregates (organization_id, period_start, metric, value, user_count) values ($1, $2, 'compass_requests', 1, 100)", [ids.organization, week])).rejects.toThrow(/mesh_agency_usage_aggregates_floor_check/);
      await client.query("rollback to savepoint floor");
      await expect(client.query("insert into public.mesh_agency_usage_aggregates (organization_id, period_start, metric, value, user_count) values ($1, $2, 'member_email', 1, 101)", [ids.organization, week])).rejects.toThrow(/mesh_agency_usage_aggregates_metric_check/);
      await client.query("rollback to savepoint floor");
      await expect(client.query("insert into public.mesh_agency_usage_aggregates (organization_id, period_start, metric, value, user_count) values ($1, $2::date + 1, 'compass_requests', 1, 101)", [ids.organization, week])).rejects.toThrow(/mesh_agency_usage_aggregates_weekly_check/);
      await client.query("rollback to savepoint floor");

      // Archiving removes everything in the same transaction and blocks new rows.
      await client.query("update public.organizations set status = 'archived' where id = $1", [ids.organization]);
      expect((await client.query("select count(*)::int as n from public.mesh_agency_usage_aggregates where organization_id = $1", [ids.organization])).rows[0].n).toBe(0);
      expect((await client.query("select count(*)::int as n from private.mesh_agency_usage_counters where organization_id = $1", [ids.organization])).rows[0].n).toBe(0);
      await client.query("savepoint archived");
      await expect(client.query("insert into public.mesh_agency_usage_aggregates (organization_id, period_start, metric, value, user_count) values ($1, $2, 'compass_requests', 1, 101)", [ids.organization, week])).rejects.toThrow(/active organization/);
      await client.query("rollback to savepoint archived");
      // Bumping for an archived organization is a silent no-op, never an error.
      await client.query("select private.mesh_usage_bump($1, 'compass_requests')", [ids.member]);
      expect((await client.query("select count(*)::int as n from private.mesh_agency_usage_counters where organization_id = $1", [ids.organization])).rows[0].n).toBe(0);
    });
  });
});

describe("Compass Fireworks connector migration (static)", () => {
  const fireworks = stripComments(loadMigrationSql("compass_fireworks_connector"));
  const FOUR = "'ai_connector_gemini', 'ai_connector_claude', 'ai_connector_gpt', 'ai_connector_fireworks'";
  const RULE = "'^accounts/fireworks/models/[a-z0-9.-]{1,80}$'";

  it("sorts after the mesh provider migration and admits exactly one more connector with a bounded model rule", () => {
    expect(findMigrationName("compass_fireworks_connector") > findMigrationName("compass_inhouse_mesh_provider")).toBe(true);
    expect(fireworks).toContain("drop constraint organization_integrations_provider_check");
    expect(fireworks).toContain(`${FOUR}\n  ));`);
    expect(fireworks).toContain("drop constraint organization_integrations_ai_connector_rules");
    expect(fireworks).toContain(`or (provider = 'ai_connector_fireworks' and (default_settings ->> 'model') ~ ${RULE})`);
    expect(fireworks).not.toContain("create unique index");
  });

  it("leaves the policy singleton, attestations and every organization row alone", () => {
    expect(fireworks).not.toMatch(/compass_ai_policy|compass_ai_provider_attestations/);
    // Only the three function bodies name the integrations table; no statement
    // outside a function touches a row.
    const outsideFunctions = fireworks.split(/create or replace function[\s\S]*?\$\$;/).join("\n");
    expect(outsideFunctions).not.toMatch(/insert into|update public|delete from|vault\./);
  });

  it("retains historical migration rules while the live platform contract supersedes tenant routing", () => {
    expect(stripComments(latestFnBody("enable_organization_ai_connector"))).toContain("managed centrally by Union Ground");
    const permitted = stripComments(latestFnBody("private.compass_ai_provider_permitted"));
    expect(permitted).toContain("p_gateway = 'union-ground-mesh'");
    expect(permitted).not.toContain("organization_integrations");
    expect(stripComments(latestFnBody("disable_organization_ai_connector")).replace(/\s+/g, " ")).toContain(FOUR);
  });
});
