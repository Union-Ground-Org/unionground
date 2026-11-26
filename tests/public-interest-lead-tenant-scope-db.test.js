// @vitest-environment node
//
// SEC-UG-PUBLIC-INTEREST-LEAD-READS-ARE-NOT-TENANT-SCOPED-OR-DURABLY-AUDITED-20260921
//
// Public-interest leads were readable through a direct SELECT policy that
// tested a legacy global role, not the caller's organization, and left no
// access record. The table now has an owning tenant, no direct client access,
// and one read path, public.list_public_interest_leads, which scopes rows to
// the selected organization and writes a durable audit event per read.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { helperFirst } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("public_interest_lead_tenant_scoped_reads"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const body = squash(stripComments(fnBody(sql, "public.list_public_interest_leads")));
const prosrc = sql.slice(sql.indexOf("as $function$") + "as $function$".length, sql.lastIndexOf("$function$"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

function eventTypes(source) {
  const definitions = [...source.matchAll(
    /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
  )];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("public-interest lead tenant-scoped read migration", () => {
  it("applies after the original lead table and the current audit event CHECK", () => {
    const name = findMigrationName("public_interest_lead_tenant_scoped_reads");
    expect(name).toBe("20260924100200_public_interest_lead_tenant_scoped_reads.sql");
    expect(name > "20260917131000_mi1_dues_oauth_recovery_row_shape.sql").toBe(true);
    expect(flat.startsWith("begin;")).toBe(true);
    expect(flat).toContain("set local lock_timeout = '5s';");
  });

  it("removes every direct client read path", () => {
    expect(flat).toContain("drop policy public_interest_submissions_staff_read on public.public_interest_submissions;");
    expect(flat).toContain("revoke all on public.public_interest_submissions from public, anon, authenticated;");
    expect(flat).not.toMatch(/grant [^;]* on public\.public_interest_submissions/);
    expect(flat).toContain("alter table public.public_interest_submissions add column organization_id uuid;");
  });

  it("scopes the read RPC to the selected organization and audits each successful read", () => {
    expect(body).toContain("private.mi1_require_expected_selected_organization(p_expected_organization_id)");
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("private.has_organization_role(org, array['coordinator', 'admin', 'vp'])");
    expect(body).toContain("where s.organization_id = org");
    expect(body).toContain("private.mi1_write_tenant_audit(org, 'public_interest_leads_read'");
    const auditAt = body.indexOf("private.mi1_write_tenant_audit");
    expect(body.indexOf("raise exception 'not authorized'")).toBeLessThan(auditAt);
    expect(body.indexOf("from public.public_interest_submissions s")).toBeLessThan(auditAt);
    expect(flat).toContain("revoke all on function public.list_public_interest_leads(uuid) from public, anon, service_role;");
    expect(flat).toContain("grant execute on function public.list_public_interest_leads(uuid) to authenticated;");
  });

  it("enters through private.lock_case_graph before any declaration runs", () => {
    expect(helperFirst(prosrc)).toBe(true);
    const declarations = prosrc.slice(0, prosrc.indexOf("begin"));
    expect(declarations).not.toMatch(/:=|\bdefault\b/);
  });

  it("admits public_interest_leads_read without dropping earlier event types", () => {
    const before = eventTypes(loadMigrationSql("20260917131000_mi1_dues_oauth_recovery_row_shape"));
    const after = eventTypes(sql);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(["organization_export_completed", "public_interest_leads_read"]);
    expect(new Set(after).size).toBe(after.length);
  });

  it("pins the read path and the closed table in the database contract", () => {
    const fn = contract.functions.find((row) => row.sig === "public.list_public_interest_leads(p_expected_organization_id uuid)");
    expect(fn).toMatchObject({ secdef: true, exec: "authenticated" });
    expect(contract.policies.some((row) => row.table === "public_interest_submissions" && row.name === "public_interest_submissions_staff_read")).toBe(false);
    expect(contract.policyCoverage.noPermissivePolicies).toContain("public_interest_submissions");
    expect(contract.tableGrants.find((row) => (
      row.table === "public.public_interest_submissions" && row.role === "authenticated"
    )).privileges).toBe("");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("public-interest leads are tenant-scoped and durably audited", () => {
  let client;
  const id = Object.fromEntries([
    "coordA", "stewardA", "coordB",
    "coordASession", "stewardASession", "coordBSession",
    "orgA", "orgB", "leadA", "leadB", "leadNull",
  ].map((key) => [key, randomUUID()]));

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const attempt = async (sqlText, params = []) => {
    await client.query("savepoint public_interest_lead");
    try {
      const result = await client.query(sqlText, params);
      await client.query("release savepoint public_interest_lead");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint public_interest_lead");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const list = (organizationId) => attempt(
    "select public.list_public_interest_leads($1) as value",
    [organizationId],
  );

  const readAudits = async (organizationId) => {
    await client.query("reset role");
    return (await client.query(
      `select actor_user_id, organization_id, metadata
         from public.organization_audit_events
        where organization_id = $1 and event_type = 'public_interest_leads_read'`,
      [organizationId],
    )).rows;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "public-interest-lead-tenant-scope-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    for (const [user, session] of [
      [id.coordA, id.coordASession],
      [id.stewardA, id.stewardASession],
      [id.coordB, id.coordBSession],
    ]) {
      await client.query(
        "insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",
        [user, `${user}@example.invalid`],
      );
      await client.query(
        "insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')",
        [session, user],
      );
      await client.query(
        "insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic lead factor','totp','verified',now(),now())",
        [randomUUID(), user],
      );
    }
    const orgs = [
      [id.orgA, id.coordA, [[id.coordA, "coordinator"], [id.stewardA, "steward"]]],
      [id.orgB, id.coordB, [[id.coordB, "coordinator"]]],
    ];
    for (const [org, creator, staff] of orgs) {
      const chapter = `pil-${org}`;
      await client.query(
        "insert into public.organizations(id,slug,name,created_by) values($1,$2,$3,$4)",
        [org, `pil-${org}`, `Lead Scope ${org}`, creator],
      );
      await client.query(
        "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$2,$1,$3,false,8822)",
        [chapter, `Lead Scope Chapter ${org}`, org],
      );
      for (const [user, role] of staff) {
        await client.query(
          "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
          [org, user],
        );
        await client.query(
          "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
          [user, chapter],
        );
        await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
        await client.query(
          "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$2)",
          [org, user, role],
        );
      }
    }
    await client.query(
      `insert into public.public_interest_submissions(id,email,interest,locale,source,organization_id)
       values ($1,$2,'chapter_updates','en','public-landing',$3),
              ($4,$5,'chapter_updates','en','public-landing',$6),
              ($7,$8,'chapter_updates','en','public-landing',null)`,
      [
        id.leadA, `a-${id.leadA}@example.invalid`, id.orgA,
        id.leadB, `b-${id.leadB}@example.invalid`, id.orgB,
        id.leadNull, `n-${id.leadNull}@example.invalid`,
      ],
    );
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("returns only the caller organization's leads and records one durable access event", async () => {
    await act(id.coordA, id.coordASession);
    const result = await list(id.orgA);
    expect(result.ok).toBe(true);
    const ids = result.rows[0].value.leads.map((lead) => lead.id);
    expect(ids).toContain(id.leadA);
    expect(ids).not.toContain(id.leadB);
    expect(ids).not.toContain(id.leadNull);
    expect(result.rows[0].value.organizationId).toBe(id.orgA);

    const audits = await readAudits(id.orgA);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: id.coordA, organization_id: id.orgA });
    expect(audits[0].metadata).toMatchObject({ organizationId: id.orgA, rowCount: ids.length });
    expect(await readAudits(id.orgB)).toHaveLength(0);
  });

  it("refuses cross-organization and unauthorized reads without lead data or an access event", async () => {
    await act(id.coordA, id.coordASession);
    const crossOrg = await list(id.orgB);
    expect(crossOrg.ok).toBe(false);
    expect(crossOrg.code).toBe("42501");

    await act(id.stewardA, id.stewardASession);
    const steward = await list(id.orgA);
    expect(steward.ok).toBe(false);
    expect(steward.code).toBe("42501");

    expect(await readAudits(id.orgB)).toHaveLength(0);
    expect(await readAudits(id.orgA)).toHaveLength(1);
  });

  it("denies direct table reads to staff", async () => {
    await act(id.coordB, id.coordBSession);
    const direct = await attempt("select id from public.public_interest_submissions");
    expect(direct.ok).toBe(false);
    expect(direct.code).toBe("42501");
  });
});
