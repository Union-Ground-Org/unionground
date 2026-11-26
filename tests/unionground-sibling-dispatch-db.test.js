// @vitest-environment node
// Live-effect audit (2026-10-15): a database built from these migrations has
// no installed path that calls the sibling product. The two dispatch setup
// functions refuse before any Vault or control-row write, the dispatch control
// rows hold no endpoint, and no scheduled job names a host or project.
// Rolled back against the owned disposable stack.
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

const live = process.env.RUN_UNIONGROUND_SIBLING_DISPATCH_DB_TESTS === "1" ? describe : describe.skip;

live("sibling-product dispatch stays unreachable", () => {
  let client;
  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "unionground-sibling-dispatch-proof" });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => { await client.query("begin"); });
  afterEach(async () => { await client.query("rollback"); });

  async function vaultState() {
    return (await client.query(`select pg_catalog.count(*)::int as n from vault.secrets
      where name in ('integration-webhooks-dispatch-secret', 'notifications-dispatch-secret')`)).rows[0].n;
  }

  it("refuses both setup functions for the service role before any Vault or control-row write", async () => {
    const vaultBefore = await vaultState();
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    for (const [call, refusal] of [
      ["select public.configure_integration_webhook_dispatch('https://unionground.invalid/api/integration-webhooks-dispatch', repeat('s', 40))",
        "integration webhook dispatch has no Union Ground endpoint to configure"],
      ["select public.configure_notification_dispatch('https://unionground.invalid/api/notifications-dispatch', repeat('s', 40))",
        "notification dispatch has no Union Ground endpoint to configure"],
    ]) {
      await client.query("savepoint setup");
      await client.query("set local role service_role");
      let error;
      try { await client.query(call); } catch (caught) { error = caught; }
      await client.query("rollback to savepoint setup");
      await client.query("release savepoint setup");
      expect(error?.code, call).toBe("55000");
      expect(error?.message).toBe(refusal);
    }
    await client.query("reset role");
    expect(await vaultState()).toBe(vaultBefore);
    const controls = (await client.query(`select
      (select dispatch_url from private.integration_webhook_dispatch_controls where id) as webhook_url,
      (select dispatch_url from private.notification_controls where id) as notification_url,
      (select files_reconcile_url from private.notification_controls where id) as reconcile_url`)).rows[0];
    expect(controls).toEqual({ webhook_url: null, notification_url: null, reconcile_url: null });
  });

  it("schedules no job that names a host or the sibling product", async () => {
    const jobs = (await client.query("select jobname, command from cron.job order by jobname")).rows;
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(siblingIdentityIn(job.command), job.jobname).toEqual([]);
      expect(job.command, job.jobname).not.toMatch(/https?:\/\//);
    }
    // The three pg_net ticks read their endpoint from the cleared control rows.
    const ticks = jobs.filter((job) => job.command.includes("net.http_post")).map((job) => job.jobname);
    expect(ticks).toEqual(["integration-webhooks-dispatch-tick", "notifications-dispatch-tick", "task-files-reconcile-tick"]);
  });

  it("sets no database or role parameter that names the sibling product", async () => {
    const settings = (await client.query("select coalesce(pg_catalog.array_to_string(setconfig, ' '), '') as config from pg_catalog.pg_db_role_setting")).rows;
    for (const row of settings) expect(siblingIdentityIn(row.config)).toEqual([]);
  });
});
