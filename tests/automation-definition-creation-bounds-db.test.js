// @vitest-environment node
//
// SEC-UG-AUTOMATION-DEFINITION-CREATION-BOUNDS-20260921
//
// Automation definitions could be created without any per-organization count
// or rate bound (mi1_save_automation_definition_v2 at 20260911070000 and the
// legacy save_organization_automation_definition). 20260925190800 calls
// private.automation_definition_creation_admit from both new-definition
// branches under the organization automation lock: at most 200 non-archived
// definitions and 100 creations per rolling hour per organization, refused
// with 54000 before the insert; edits never reach it.
//
// The offline half pins the migration and contract. The live half
// (disposable loopback only) drives both RPCs.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("automation_definition_creation_bounds"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("automation definition creation bounds migration", () => {
  it("sorts after both creation RPCs, inside one bounded transaction", () => {
    const name = findMigrationName("automation_definition_creation_bounds");
    expect(name).toBe("20260925190800_automation_definition_creation_bounds.sql");
    expect(name > "20260911070000_automation_shared_intelligence_v3.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("admits only the new-definition branch of both RPCs, after the organization lock and before the insert", () => {
    for (const [name, branch] of [
      ["public.mi1_save_automation_definition_v2", "if definition_id is null then"],
      ["public.save_organization_automation_definition", "if p_definition_id is null then"],
    ]) {
      const body = squash(fnBody(sql, name));
      const admit = body.indexOf("perform private.automation_definition_creation_admit(org);");
      expect(admit, name).toBeGreaterThan(-1);
      expect(body.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"), name).toBeLessThan(body.indexOf("'organization-automation:' || org::text"));
      expect(body.indexOf("'organization-automation:' || org::text"), name).toBeLessThan(admit);
      expect(body.indexOf(branch), name).toBeLessThan(admit);
      expect(admit, name).toBeLessThan(body.indexOf("insert into public.organization_automation_definitions"));
      expect(body.indexOf("perform private.automation_definition_creation_admit", admit + 1), name).toBe(-1);
    }
    const helper = squash(fnBody(sql, "private.automation_definition_creation_admit"));
    expect(helper).toContain("if live_definitions >= 200 then");
    expect(helper).toContain("if recent_creations >= 100 then");
    expect(helper).toContain("d.created_at > pg_catalog.now() - interval '1 hour'");
    expect(helper).toContain("using errcode = '54000'");
    expect(flat).toContain("revoke all on function private.automation_definition_creation_admit(uuid) from public, anon, authenticated, service_role;");
    expect(flat).not.toContain("create trigger");
  });

  it("pins the admission call and helper in the database contract", () => {
    const fn = contract.functions.find((row) => row.sig === "private.automation_definition_creation_admit(p_org uuid)");
    expect(fn.bodyContains).toEqual(expect.arrayContaining(["if live_definitions >= 200 then", "if recent_creations >= 100 then"]));
    for (const sig of [
      "public.mi1_save_automation_definition_v2(p_definition jsonb)",
      "public.save_organization_automation_definition(p_definition_id uuid, p_name text, p_trigger_kind text, p_threshold_days integer, p_cadence text, p_task_priority text, p_expected_version integer)",
    ]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry.bodyContains, sig).toEqual(expect.arrayContaining(["perform private.automation_definition_creation_admit(org);"]));
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("automation definition creation is bounded per organization", () => {
  let client;
  let firstId;
  const id = Object.fromEntries([
    "admin", "colleague", "adminSession", "colleagueSession", "org",
  ].map((key) => [key, randomUUID()]));
  const chapter = `adcb-${id.org}`;
  let serial = 0;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const attempt = async (text, params) => {
    await act(id.admin, id.adminSession);
    await client.query("savepoint definition_call");
    try {
      const result = await client.query(text, params);
      await client.query("release savepoint definition_call");
      return { ok: true, out: result.rows[0].out };
    } catch (error) {
      await client.query("rollback to savepoint definition_call");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const createV2 = () => {
    serial += 1;
    return attempt("select public.mi1_save_automation_definition_v2($1::jsonb) as out", [JSON.stringify({
      schemaVersion: 2, name: `Synthetic bound ${serial}`, triggerKind: "overdue_task", thresholdDays: 3,
      cadence: "daily", taskPriority: "medium", conditions: {}, actionKind: "create_standard_task", actionConfig: {},
    })]);
  };
  const createLegacy = () => {
    serial += 1;
    return attempt(
      "select public.save_organization_automation_definition(null,$1,'overdue_task',3,'daily','medium',null) as out",
      [`Synthetic legacy ${serial}`],
    );
  };

  const counts = async () => {
    await client.query("reset role");
    const result = await client.query(
      `select
         (select count(*)::int from public.organization_automation_definitions where organization_id=$1) as definitions,
         (select count(*)::int from public.organization_audit_ledger where organization_id=$1 and event_type='automation_definition_created') as audits`,
      [id.org],
    );
    return result.rows[0];
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "automation-definition-creation-bounds-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");

    for (const [user, session] of [[id.admin, id.adminSession], [id.colleague, id.colleagueSession]]) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic definition factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `adcb-${id.org}`, id.admin]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9932)", [chapter, id.org]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapter, id.admin]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const user of [id.admin, id.colleague]) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.org, user]);
    }
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("admits 100 creations an hour across both RPCs, then refuses either with 54000 and writes no definition or audit row", async () => {
    for (let index = 0; index < 100; index += 1) {
      const result = index % 2 === 0 ? await createV2() : await createLegacy();
      expect(result, `creation #${index + 1}`).toMatchObject({ ok: true });
      if (index === 0) firstId = result.out.id;
    }
    const before = await counts();
    expect(before.definitions).toBe(100);
    for (const create of [createV2, createLegacy]) {
      const refused = await create();
      expect(refused).toMatchObject({ ok: false, code: "54000" });
    }
    expect(await counts()).toEqual(before);
  });

  it("still permits an authorized edit of an existing definition at the bound", async () => {
    const edited = await attempt("select public.mi1_save_automation_definition_v2($1::jsonb) as out", [JSON.stringify({
      schemaVersion: 2, id: firstId, expectedVersion: 1, name: "Synthetic bound edited", triggerKind: "overdue_task",
      thresholdDays: 5, cadence: "weekly", taskPriority: "high", conditions: {}, actionKind: "create_standard_task", actionConfig: {},
    })]);
    expect(edited).toMatchObject({ ok: true });
    expect(edited.out.version).toBe(2);
  });

  it("re-admits creation once earlier creations leave the rolling hour", async () => {
    await client.query("reset role");
    await client.query("update public.organization_automation_definitions set created_at = now() - interval '2 hours' where organization_id=$1", [id.org]);
    expect(await createV2()).toMatchObject({ ok: true });
  });

  it("refuses creation at 200 live definitions and admits it again after one is archived", async () => {
    await client.query("reset role");
    const { definitions } = await counts();
    for (let index = definitions; index < 200; index += 1) {
      await client.query(
        "insert into public.organization_automation_definitions(organization_id,name,trigger_kind,threshold_days,created_by,updated_by,created_at) values($1,$2,'overdue_task',3,$3,$3,now() - interval '3 hours')",
        [id.org, `Synthetic filler ${index}`, id.admin],
      );
    }
    const refused = await createV2();
    expect(refused).toMatchObject({ ok: false, code: "54000" });
    expect(refused.message).toContain("200 per organization");
    await client.query("reset role");
    await client.query("update public.organization_automation_definitions set status='archived' where organization_id=$1 and name='Synthetic filler 199'", [id.org]);
    expect(await createLegacy()).toMatchObject({ ok: true });
  });
});
