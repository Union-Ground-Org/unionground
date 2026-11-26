// @vitest-environment node
//
// SEC-UG-AUTOMATION-PREVIEW-UNBOUNDED-CALL-RATE-20260920
//
// public.mi1_preview_automation_definition and
// public.preview_organization_automation_run wrote an
// organization_automation_runs 'preview' row and an automation_run_previewed
// audit-ledger row on every call with no bound. 20260925190700 routes both
// through private.automation_preview_admit: 60 previews per (organization,
// actor) per rolling 10 minutes, shared across both entry points, refused with
// 54000 before any write.
//
// The offline half pins the migration text and the db-contract entries. The
// live half (disposable loopback only) proves the refusal writes nothing, a
// colleague is unaffected, manual runs are not counted and the window rolls.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("automation_preview_call_bound"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("automation preview call bound migration", () => {
  it("sorts after both live preview bodies, inside one bounded transaction", () => {
    const name = findMigrationName("automation_preview_call_bound");
    expect(name).toBe("20260925190700_automation_preview_call_bound.sql");
    expect(name > "20260911070000_automation_shared_intelligence_v3.sql").toBe(true);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
  });

  it("admits both preview entry points before the candidate scan and any write, keeping the case-graph lock first", () => {
    for (const [name, scan] of [
      ["public.mi1_preview_automation_definition", "private.automation_v2_candidates"],
      ["public.preview_organization_automation_run", "private.cr108_candidate_count"],
    ]) {
      const body = squash(fnBody(sql, name));
      const admit = body.indexOf("perform private.automation_preview_admit(org, actor);");
      expect(admit, name).toBeGreaterThan(-1);
      expect(body.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);"), name).toBeLessThan(admit);
      expect(admit, name).toBeLessThan(body.indexOf(scan));
      expect(admit, name).toBeLessThan(body.indexOf("insert into public.organization_automation_runs"));
      expect(admit, name).toBeLessThan(body.indexOf("private.cr108_record_audit"));
    }
  });

  it("counts only the actor's own preview rows in one organization over a rolling window, serialized per actor", () => {
    const helper = squash(fnBody(sql, "private.automation_preview_admit"));
    expect(helper).toContain("if recent_previews >= 60 then");
    expect(helper).toContain("'automation-preview:' || p_org::text || ':' || p_actor::text");
    expect(helper).toContain("where r.organization_id = p_org and r.initiated_by = p_actor and r.mode = 'preview' and r.created_at > pg_catalog.now() - interval '10 minutes';");
    expect(helper).toContain("using errcode = '54000'");
    expect(flat).toContain("revoke all on function private.automation_preview_admit(uuid, uuid) from public, anon, authenticated, service_role;");
  });

  it("pins the admit call in the database contract for both RPCs", () => {
    for (const sig of [
      "public.mi1_preview_automation_definition(p_definition_id uuid)",
      "public.preview_organization_automation_run(p_definition_id uuid)",
    ]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, sig).toMatchObject({ secdef: true, exec: "authenticated" });
      expect(entry.bodyContains, sig).toEqual(expect.arrayContaining(["perform private.automation_preview_admit(org, actor);"]));
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("automation preview calls are bounded per organization and actor", () => {
  let client;
  let definitionId;
  const id = Object.fromEntries([
    "admin", "colleague", "adminSession", "colleagueSession", "org",
  ].map((key) => [key, randomUUID()]));
  const chapter = `apcb-${id.org}`;

  const act = async (actor, session) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal: "aal2" }),
    ]);
    await client.query("set local role authenticated");
  };

  const call = async (fn) => {
    await client.query("savepoint preview_call");
    try {
      const result = await client.query(`select public.${fn}($1) as out`, [definitionId]);
      await client.query("release savepoint preview_call");
      return { ok: true, out: result.rows[0].out };
    } catch (error) {
      await client.query("rollback to savepoint preview_call");
      return { ok: false, code: error.code, message: error.message };
    }
  };

  const counts = async (actor) => {
    await client.query("reset role");
    const result = await client.query(
      `select
         (select count(*)::int from public.organization_automation_runs where organization_id=$1 and initiated_by=$2 and mode='preview') as runs,
         (select count(*)::int from public.organization_audit_ledger where organization_id=$1 and actor_user_id=$2 and event_type='automation_run_previewed') as audits`,
      [id.org, actor],
    );
    return result.rows[0];
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "automation-preview-call-bound-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");

    for (const [user, session] of [[id.admin, id.adminSession], [id.colleague, id.colleagueSession]]) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic preview factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, `apcb-${id.org}`, id.admin]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9931)", [chapter, id.org]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name,created_by) values($1,'General',$2)", [chapter, id.admin]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [id.org]);
    for (const user of [id.admin, id.colleague]) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [id.org, user]);
    }
    await act(id.admin, id.adminSession);
    const saved = await client.query("select public.mi1_save_automation_definition_v2($1::jsonb) as out", [JSON.stringify({
      schemaVersion: 2, name: "Synthetic preview bound", triggerKind: "overdue_task", thresholdDays: 3,
      cadence: "daily", taskPriority: "medium", conditions: {}, actionKind: "create_standard_task", actionConfig: {},
    })]);
    definitionId = saved.rows[0].out.id;
    expect(definitionId).toMatch(/^[0-9a-f-]{36}$/);
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("admits 60 previews across both entry points, then refuses either with 54000 and writes no run or audit row", async () => {
    await act(id.admin, id.adminSession);
    for (let index = 0; index < 60; index += 1) {
      const fn = index % 2 === 0 ? "mi1_preview_automation_definition" : "preview_organization_automation_run";
      const result = await call(fn);
      expect(result, `${fn} #${index + 1}`).toMatchObject({ ok: true });
      await act(id.admin, id.adminSession);
    }
    expect(await counts(id.admin)).toEqual({ runs: 60, audits: 60 });
    for (const fn of ["mi1_preview_automation_definition", "preview_organization_automation_run"]) {
      await act(id.admin, id.adminSession);
      const refused = await call(fn);
      expect(refused, fn).toMatchObject({ ok: false, code: "54000" });
    }
    expect(await counts(id.admin)).toEqual({ runs: 60, audits: 60 });
  }, 120000);

  it("leaves a colleague in the same organization free to preview", async () => {
    await act(id.colleague, id.colleagueSession);
    const result = await call("preview_organization_automation_run");
    expect(result).toMatchObject({ ok: true });
    expect(await counts(id.colleague)).toEqual({ runs: 1, audits: 1 });
  });

  it("never counts manual or scheduled runs against the preview allowance", async () => {
    await client.query("reset role");
    await client.query(
      `insert into public.organization_automation_runs(organization_id,definition_id,definition_version,mode,status,initiated_by,completed_at)
       select $1,$2,1,m.mode,'no_op',$3,now() from generate_series(1,25) g cross join (values ('manual'),('scheduled')) m(mode)`,
      [id.org, definitionId, id.colleague],
    );
    await act(id.colleague, id.colleagueSession);
    expect(await call("mi1_preview_automation_definition")).toMatchObject({ ok: true });
  });

  it("re-admits the actor once earlier previews leave the rolling window", async () => {
    await client.query("reset role");
    await client.query(
      "update public.organization_automation_runs set created_at = now() - interval '11 minutes' where organization_id=$1 and initiated_by=$2 and mode='preview'",
      [id.org, id.admin],
    );
    await act(id.admin, id.adminSession);
    expect(await call("mi1_preview_automation_definition")).toMatchObject({ ok: true });
  });
});
