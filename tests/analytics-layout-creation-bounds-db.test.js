// @vitest-environment node
//
// SEC-UG-ANALYTICS-LAYOUT-CREATION-RETRY-BOUNDS-20260921
//
// public.save_organization_analytics_layout had no bound on how many layouts a
// person or an organization could create, and expired idempotency receipts
// were purged only on that same user's next write. 20260925570600 re-emits the
// save RPC from its installed definition (case-graph lock kept first) with a
// 50-per-owner and 500-per-organization creation bound, and schedules a daily
// purge of expired receipts for every user.
//
// The offline half pins the migration text and the db-contract entries. The
// live half (disposable loopback only) saves as an organization admin in one
// rolled-back transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20260925570600_analytics_layout_creation_bounds.sql";
const SAVE = "public.save_organization_analytics_layout";
const sql = loadMigrationSql("analytics_layout_creation_bounds");
const save = stripComments(fnBody(sql, SAVE));
const installed = stripComments(fnBody(loadMigrationSql("20260828230000_mi1_analytics_parity_five.sql"), SAVE));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const LOCK = "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);";
// The create-branch bound starts at its per-organization advisory lock.
const boundStart = save.lastIndexOf("perform", save.indexOf("'organization_analytics_layouts:' || org::text"));

describe("analytics layout creation bounds migration", () => {
  it("is the newest emitter of the save RPC, inside one bounded transaction", () => {
    expect(findMigrationName("analytics_layout_creation_bounds")).toBe(NAME);
    const later = migrationFiles()
      .filter(({ name }) => name > NAME)
      .filter(({ sql: body }) => /function public\.save_organization_analytics_layout\s*\(/i.test(stripComments(body)));
    expect(later).toEqual([]);
    expect(stripComments(sql).trimStart().startsWith("begin;")).toBe(true);
    expect(stripComments(sql).trimEnd().endsWith("commit;")).toBe(true);
    for (const label of ["save_organization_analytics_layout", "sync_organization_job_runs_from_cron_history", "list_organization_job_health"]) {
      expect(sql).toContain(`raise exception 'unreviewed ${label} predecessor: %'`);
    }
  });

  it("keeps the case-graph entry lock first and changes only the create branch", () => {
    const after = (text) => squash(text.slice(text.indexOf("as $function$")));
    const current = after(save);
    expect(current.startsWith(`as $function$ begin ${LOCK} declare caller uuid`)).toBe(true);
    // Remove the lock wrapper, the two constants and the create-branch bound;
    // what is left is the 20260828230000 body byte-for-byte.
    const bound = squash(save.slice(boundStart, save.indexOf("insert into public.organization_analytics_layouts (")));
    const reduced = current
      .replace(`begin ${LOCK} declare`, "declare")
      .replace(" owner_layout_limit constant integer := 50; organization_layout_limit constant integer := 500;", "")
      .replace(` ${bound}`, "")
      .replace(/ end; end; \$function\$;?$/, " end; $function$;");
    expect(reduced).toBe(after(installed).replace(/\$function\$;?$/, "$function$;"));
  });

  it("refuses new layouts past both bounds under an organization lock, after the idempotent replay", () => {
    const createBranch = save.slice(boundStart, save.indexOf("insert into public.organization_analytics_layouts ("));
    expect(createBranch).toContain("pg_advisory_xact_lock");
    expect(createBranch).toContain("'organization_analytics_layouts:' || org::text");
    expect(createBranch).toMatch(/l\.organization_id = org and l\.owner_user_id = caller\s*\) >= owner_layout_limit/);
    expect(createBranch).toMatch(/where l\.organization_id = org\s*\) >= organization_layout_limit/);
    expect(createBranch.match(/errcode = '54000'/g)).toHaveLength(2);
    expect(save.indexOf("return prior.response")).toBeLessThan(save.indexOf("owner_layout_limit then"));
    const updateBranch = save.slice(save.indexOf("if action_name = 'updated' then"), boundStart);
    expect(updateBranch).not.toContain("layout_limit");
    expect(sql).toMatch(/grant execute on function public\.save_organization_analytics_layout\(uuid, text, text, text, jsonb, uuid\)\s+to authenticated;/);
  });

  it("purges expired receipts for every user on a daily schedule", () => {
    const purge = stripComments(fnBody(sql, "private.purge_expired_analytics_idempotency_receipts"));
    expect(purge).toContain("security definer");
    expect(purge).toContain("r.created_at < pg_catalog.now() - interval '30 days'");
    expect(purge).not.toContain("user_id");
    expect(sql).toMatch(/revoke all on function private\.purge_expired_analytics_idempotency_receipts\(\)\s+from public, anon, authenticated, service_role;/);
    expect(sql).not.toMatch(/grant execute on function private\.purge_expired_analytics_idempotency_receipts/);
    expect(sql).toContain("'mi1-analytics-receipt-retention',");
    expect(sql).toContain("$job$ select private.purge_expired_analytics_idempotency_receipts(); $job$");
  });

  it("pins the bounds, the purge function, the job and its health monitoring in the database contract", () => {
    const entry = contract.functions.find((row) => row.sig.startsWith(`${SAVE}(`));
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      LOCK,
      "owner_layout_limit constant integer := 50",
      "organization_layout_limit constant integer := 500",
      "analytics layout limit reached",
    ]));
    for (const needle of entry.bodyContains) expect(squash(save)).toContain(squash(needle));
    const purge = contract.functions.find((row) => row.sig === "private.purge_expired_analytics_idempotency_receipts()");
    expect(purge).toMatchObject({ secdef: true, exec: "" });
    expect(contract.cron).toContainEqual(expect.objectContaining({
      jobname: "mi1-analytics-receipt-retention",
      schedule: "23 4 * * *",
      active: true,
      commandContains: ["private.purge_expired_analytics_idempotency_receipts()"],
    }));
    const constraint = contract.constraints.find((row) => row.name === "organization_job_runs_job_name_check");
    expect(constraint.defContains).toContain("mi1-analytics-receipt-retention");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("analytics layout creation is bounded and receipts expire on schedule", () => {
  let client;
  const id = Object.fromEntries(["org", "admin", "other", "session"].map((key) => [key, randomUUID()]));
  const chapter = `analytics-bounds-${id.org.slice(0, 8)}`;
  const spec = { datasetId: "organization:chapter-health", chartType: "bar", title: "Bound proof" };

  async function saveAs(name, key, layoutId = null) {
    await client.query("savepoint save_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: id.admin, role: "authenticated", session_id: id.session, aal: "aal2",
      })]);
      await client.query("set local role authenticated");
      const result = await client.query(
        "select public.save_organization_analytics_layout($1, $2, 'personal', null, $3::jsonb, $4) result",
        [layoutId, name, JSON.stringify({ ...spec, title: name }), key],
      );
      await client.query("reset role");
      await client.query("release savepoint save_probe");
      return { code: "", result: result.rows[0].result };
    } catch (error) {
      await client.query("rollback to savepoint save_probe");
      return { code: error.code || "?", message: error.message || "" };
    }
  }

  async function layoutCount(owner = null) {
    const { rows } = await client.query(
      "select count(*)::int n from public.organization_analytics_layouts where organization_id = $1 and ($2::uuid is null or owner_user_id = $2)",
      [id.org, owner],
    );
    return rows[0].n;
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "analytics-layout-creation-bounds-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '120s'");
    await client.query("set local lock_timeout = '15s'");
    await client.query(
      "insert into auth.users (id, email) values ($1, $3), ($2, $4)",
      [id.admin, id.other, `${id.admin}@example.invalid`, `${id.other}@example.invalid`],
    );
    await client.query("insert into public.organizations (id, slug, name, created_by) values ($1, $2, $2, $3)", [id.org, chapter, id.admin]);
    await client.query(
      "insert into public.chapters (id, name, slug, organization_id, is_default, order_index) values ($1, $1, $1, $2, false, 9905)",
      [chapter, id.org],
    );
    for (const user of [id.admin, id.other]) {
      await client.query("insert into public.organization_memberships (organization_id, user_id, status) values ($1, $2, 'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships (user_id, chapter_id, status) values ($1, $2, 'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter]);
    }
    await client.query(
      "insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')",
      [id.session, id.admin],
    );
    await client.query(
      "insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at) values ($1, $2, 'Analytics bounds factor', 'totp', 'verified', now(), now())",
      [randomUUID(), id.admin],
    );
    await client.query(
      "insert into public.organization_role_grants (organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2)",
      [id.org, id.admin],
    );
  });

  afterAll(async () => {
    await client?.query("rollback").catch(() => {});
    await client?.end();
  });

  it("refuses the 51st layout one person creates in an organization and writes nothing", async () => {
    let firstKey = null;
    let firstId = null;
    for (let index = 1; index <= 50; index += 1) {
      const key = randomUUID();
      const saved = await saveAs(`Layout ${index}`, key);
      expect(saved, saved.message).toMatchObject({ code: "" });
      if (index === 1) { firstKey = key; firstId = saved.result.id; }
    }
    expect(await layoutCount(id.admin)).toBe(50);
    const refused = await saveAs("Layout 51", randomUUID());
    expect(refused.code).toBe("54000");
    expect(refused.message).toContain("50 per person per organization");
    expect(await layoutCount(id.admin)).toBe(50);

    // A retried save of an already-created layout replays its receipt at the
    // bound, and an update of an existing layout is never counted.
    const replay = await saveAs("Layout 1", firstKey);
    expect(replay, replay.message).toMatchObject({ code: "", result: { id: firstId } });
    const updated = await saveAs("Layout 1 renamed", randomUUID(), firstId);
    expect(updated, updated.message).toMatchObject({ code: "", result: { id: firstId, name: "Layout 1 renamed" } });
    expect(await layoutCount(id.admin)).toBe(50);
  });

  it("refuses a new layout once the organization holds 500", async () => {
    await client.query(
      `insert into public.organization_analytics_layouts (organization_id, owner_user_id, scope, chapter_id, name, spec)
       select $1, $2, 'personal', null, 'Filler ' || g, $3::jsonb from generate_series(1, 450) g`,
      [id.org, id.other, JSON.stringify(spec)],
    );
    expect(await layoutCount()).toBe(500);
    await client.query("delete from public.organization_analytics_layouts where organization_id = $1 and owner_user_id = $2 and name = 'Layout 50'", [id.org, id.admin]);
    await client.query(
      "insert into public.organization_analytics_layouts (organization_id, owner_user_id, scope, chapter_id, name, spec) values ($1, $2, 'personal', null, 'Filler 451', $3::jsonb)",
      [id.org, id.other, JSON.stringify(spec)],
    );
    expect(await layoutCount(id.admin)).toBe(49);
    const refused = await saveAs("Over the organization bound", randomUUID());
    expect(refused.code).toBe("54000");
    expect(refused.message).toContain("500 per organization");
    expect(await layoutCount()).toBe(500);
  });

  it("purges every user's expired receipts without a later write and keeps fresh ones", async () => {
    const stale = randomUUID();
    const fresh = randomUUID();
    await client.query(
      `insert into private.organization_analytics_idempotency_receipts (user_id, idempotency_key, operation, request_hash, response, created_at)
       values ($1, $2, 'save_layout', repeat('a', 64), '{}'::jsonb, now() - interval '31 days'),
              ($1, $3, 'save_layout', repeat('b', 64), '{}'::jsonb, now() - interval '29 days')`,
      [id.other, stale, fresh],
    );
    const { rows } = await client.query("select private.purge_expired_analytics_idempotency_receipts() removed");
    expect(rows[0].removed).toBeGreaterThanOrEqual(1);
    const left = await client.query(
      "select idempotency_key from private.organization_analytics_idempotency_receipts where user_id = $1 order by idempotency_key",
      [id.other],
    );
    expect(left.rows.map((row) => row.idempotency_key)).toEqual([fresh]);
  });

  it("schedules the daily purge and lets the job-health mirror record it", async () => {
    const { rows } = await client.query("select schedule, command from cron.job where jobname = 'mi1-analytics-receipt-retention'");
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toBe("23 4 * * *");
    expect(rows[0].command).toContain("private.purge_expired_analytics_idempotency_receipts()");
    const check = await client.query(
      "select pg_get_constraintdef(oid) def from pg_constraint where conname = 'organization_job_runs_job_name_check'",
    );
    expect(check.rows[0].def).toContain("mi1-analytics-receipt-retention");
  });
});
