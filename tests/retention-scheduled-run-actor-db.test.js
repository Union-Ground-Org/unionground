// @vitest-environment node
//
// DEBT-UG-RETENTION-SCHEDULED-RUN-ACTOR-MISATTRIBUTED-20260921
//
// The nightly retention scheduler stamped the policy's last editor as the
// requester and authorizer of every scheduled run, and
// perform_organization_retention_run then wrote that admin as the
// retention.completed actor and as the redactor on every message tombstone.
// 20260925630500 leaves scheduled runs with no person and names the policy's
// standing authorizer separately in the ledger metadata; manual runs keep
// their authorizing admin.
//
// The static half compares the re-declared bodies with their predecessors.
// The live half drives the real scheduler with no JWT, as pg_cron does, on a
// disposable database inside one rolled-back transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20260925630500_retention_scheduled_run_actor_is_the_scheduler.sql";
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read(MIGRATION);

function bodyOf(sql, signature) {
  const start = sql.indexOf(`create or replace function ${signature}`);
  expect(start, signature).toBeGreaterThan(-1);
  const open = sql.indexOf("as $function$", start) + "as $function$".length;
  const close = sql.indexOf("$function$;", open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

const SCHEDULER_NOTE = "  loop\n"
  + "    -- The scheduler performs this run, not the policy's last editor, so it\n"
  + "    -- carries no requesting or authorizing person. The admin whose standing\n"
  + "    -- policy enabled execution is named in the ledger metadata instead.\n"
  + "    insert into public.organization_retention_runs (";

describe("retention scheduled-run actor (static)", () => {
  it("changes only the scheduled run's person columns and keeps both lock wrappers", () => {
    const predecessor = bodyOf(
      read("supabase/migrations/20260907121000_member_message_body_lifecycle.sql"),
      "private.run_due_organization_retention_jobs(p_limit integer default 25)",
    );
    const body = bodyOf(migration, "private.run_due_organization_retention_jobs(p_limit integer default 25)");
    const people = "      policy_row.updated_by, policy_row.updated_by, pg_catalog.now(),\n";
    expect(predecessor).toContain(people);
    const inner = predecessor
      .replace(people, "      null, null, pg_catalog.now(),\n")
      .replace("  loop\n    insert into public.organization_retention_runs (", SCHEDULER_NOTE);
    // 20260907151000 wrapped the 20260907121000 body in the case-graph gate,
    // then the message-lifecycle gate; the re-declaration keeps both.
    expect(body).toBe(
      "\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n\n"
        + "begin\n  perform private.lock_message_lifecycle();\n"
        + inner.trimEnd()
        + "\nend;\nend;\n",
    );
    expect(body).not.toContain("policy_row.updated_by");
  });

  it("adds the standing authorizer to scheduled ledger metadata and changes nothing else in the worker", () => {
    const predecessor = bodyOf(
      read("supabase/migrations/20260918204000_casework_record_versions_retention.sql"),
      "private.perform_organization_retention_run(p_run_id uuid)",
    );
    const body = bodyOf(migration, "private.perform_organization_retention_run(p_run_id uuid)");
    const added = body.slice(body.indexOf("      ) || case\n"), body.indexOf("      end\n    );") + "      end\n".length);
    expect(added).toContain("when run_row.mode = 'scheduled' and policy_row.updated_by is not null");
    expect(added).toContain("then pg_catalog.jsonb_build_object('userId', policy_row.updated_by)");
    expect(added).toContain("else '{}'::jsonb");
    expect(body.replace(added, "      )\n")).toBe(predecessor);
    // The actor and the redactor stay run_row.authorized_by, which is null for
    // every run the scheduler now inserts.
    expect(body).toContain("'privacy', 'retention.completed', 'delete', run_row.authorized_by,");
    expect(body).toContain("private.redact_member_message_row(candidate_id, 'retention_expired', run_row.authorized_by)");
  });

  it("refuses any unreviewed predecessor before replacing either body", () => {
    const guard = migration.indexOf("do $predecessor$");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(migration.indexOf("create or replace function"));
    expect(migration).toContain("'7a1a3f3ae75701fef3e096fc734b7c8880d8d2beb9c7ec3e8870cf51ad4a7436'");
    expect(migration).toContain("'4cbb4d5c2fe1cc34a549d35dbcceba6b72f01ba11fbad23a6567abf2d4634e8c'");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("retention scheduled-run actor on a disposable database", () => {
  let db;
  const f = { org: randomUUID(), admin: randomUUID(), member: randomUUID() };
  f.chapter = `retention-actor-${f.org}`;
  let scheduledRun;

  async function actAs(userId) {
    const session = randomUUID();
    await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
  }

  async function asScheduler() {
    // pg_cron runs the job as the database owner with no JWT at all.
    await db.query("select set_config('request.jwt.claims','',true)");
    await db.query("select set_config('request.jwt.claim.sub','',true)");
  }

  async function oldConversation(title) {
    const id = randomUUID();
    await db.query("insert into public.member_conversations(id,user_id,title,organization_id) values ($1,$2,$3,$4)", [id, f.member, title, f.org]);
    await db.query(
      "insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body,created_at) values ($1,$2,'member','Proof','retention actor evidence',now()-interval '4 years')",
      [id, f.member],
    );
    return id;
  }

  async function message(conversation) {
    return (await db.query("select body, redacted_by, redaction_reason from public.member_messages where conversation_id=$1", [conversation])).rows;
  }

  async function ledger(runId) {
    return (await db.query(
      "select actor_user_id, metadata from public.organization_audit_ledger where event_type='retention.completed' and entity_id=$1",
      [String(runId)],
    )).rows;
  }

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "retention-scheduled-run-actor-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [f.org, f.chapter]);
    await db.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9925)", [f.chapter, f.org]);
    for (const id of [f.admin, f.member]) {
      await db.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, f.chapter]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [f.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, f.chapter]);
    }
    await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [f.org, f.admin]);
    await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), f.admin]);
    f.scheduledConversation = await oldConversation("Scheduled retention proof");

    await actAs(f.admin);
    await db.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");
    await asScheduler();
    await db.query("select private.run_due_organization_retention_jobs(100)");
    scheduledRun = (await db.query(
      "select id, mode, status, requested_by, authorized_by, deleted_count from public.organization_retention_runs where organization_id=$1 and mode='scheduled'",
      [f.org],
    )).rows;
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("a scheduled run records no requesting or authorizing person", () => {
    expect(scheduledRun).toHaveLength(1);
    expect(scheduledRun[0]).toMatchObject({ mode: "scheduled", status: "completed", deleted_count: 1, requested_by: null, authorized_by: null });
  });

  it("its retention.completed event has no actor and names the policy author only as the standing authorizer", async () => {
    const rows = await ledger(scheduledRun[0].id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_user_id).toBeNull();
    expect(rows[0].metadata).toMatchObject({ mode: "scheduled", dataClass: "member_message_bodies", deletedCount: 1, userId: f.admin });
  });

  it("a scheduler-driven redaction stamps no redactor on the tombstone", async () => {
    expect(await message(f.scheduledConversation)).toEqual([{ body: "", redacted_by: null, redaction_reason: "retention_expired" }]);
  });

  it("a manual run is still attributed to the admin who authorized it", async () => {
    await db.query("savepoint manual_run");
    try {
      const conversation = await oldConversation("Manual retention proof");
      await actAs(f.admin);
      const run = (await db.query("select public.preview_organization_retention_run('member_message_bodies') as v")).rows[0].v;
      expect(run.eligibleCount).toBe(1);
      await db.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies')", [run.id]);
      expect((await db.query("select private.perform_organization_retention_run($1) as v", [run.id])).rows[0].v).toMatchObject({ status: "completed", deletedCount: 1 });
      const stored = (await db.query("select mode, requested_by, authorized_by from public.organization_retention_runs where id=$1", [run.id])).rows[0];
      expect(stored).toEqual({ mode: "manual", requested_by: f.admin, authorized_by: f.admin });
      const rows = await ledger(run.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(f.admin);
      expect(rows[0].metadata).toMatchObject({ mode: "manual" });
      expect(rows[0].metadata).not.toHaveProperty("userId");
      expect(await message(conversation)).toEqual([{ body: "", redacted_by: f.admin, redaction_reason: "retention_expired" }]);
    } finally {
      await db.query("rollback to savepoint manual_run");
    }
  });
});
