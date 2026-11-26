// @vitest-environment node
//
// REQ-UG-PUBLIC-SIGNUP-OWNER-SWITCH-20261003. The owner's public signup
// switch is the private.open_signup_period row. Static half: the migration
// never opens it and grants nothing but the service-role status read. Live
// half (SUPABASE_DB_URL on the disposable loopback target): the switch ships
// off, only an owner SQL session can change it, every change is recorded, and
// no client role, the service role included, can read or write the switch or
// its audit.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { insertSignupCoverageLease, insertSignupRecoveryCheck } from "./helpers/signupRecovery.js";

const sql = stripComments(loadMigrationSql("public_signup_owner_switch"));

describe("public signup owner switch migration (static)", () => {
  it("sorts after the closed signup period it audits and never opens it", () => {
    expect(findMigrationName("public_signup_owner_switch") > findMigrationName("20260930040200_self_serve_organization_shell")).toBe(true);
    expect(sql).not.toMatch(/insert\s+into\s+private\.open_signup_period/i);
    expect(sql).not.toMatch(/update\s+private\.open_signup_period/i);
    expect(sql).toContain("after insert or update or delete on private.open_signup_period");
    expect(sql).toContain("after truncate on private.open_signup_period");
  });

  it("grants the status read to the service role only and nothing on the audit", () => {
    expect(sql).toContain("revoke all on function public.open_signup_switch_open() from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.open_signup_switch_open() to service_role;");
    expect(sql).toContain("revoke all on private.open_signup_switch_changes from public, anon, authenticated, service_role;");
    expect(sql).toContain("alter table private.open_signup_switch_changes force row level security;");
    expect(sql).not.toMatch(/grant [^;]* on (table )?private\.open_signup_switch_changes/i);
    expect(sql).not.toMatch(/grant [^;]* on function private\.record_open_signup_switch_change/i);
  });

  it("reviews its audit triggers for the account lifecycle and asserts the review is complete", () => {
    expect(sql).toContain("insert into private.account_lifecycle_trigger_review");
    expect(sql).toContain("'record_open_signup_switch_change', 'record_open_signup_switch_truncate'");
    expect(sql).toContain("s.object_name = 'record_open_signup_switch_change()'");
    expect(sql).toContain("if exists (select 1 from private.account_lifecycle_referential_action_trigger_issues()) then");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("public signup owner switch (disposable database)", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "public-signup-switch-proof" });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  async function inTransaction(run) {
    await client.query("begin");
    try {
      await insertSignupRecoveryCheck(client);
      await insertSignupCoverageLease(client);
      await run();
    } finally {
      await client.query("rollback");
    }
  }

  const switchOpen = async () => (await client.query("select public.open_signup_switch_open() as open")).rows[0].open;
  const changes = async () => (await client.query(
    "select operation, session_role, application_name, old_opens_at is not null as had_old, new_opens_at is not null as has_new, open_after from private.open_signup_switch_changes order by id",
  )).rows;

  it("ships off: no period row, a closed switch and an empty audit", async () => {
    expect((await client.query("select count(*)::int as n from private.open_signup_period")).rows[0].n).toBe(0);
    expect(await switchOpen()).toBe(false);
    expect((await client.query("select count(*)::int as n from private.open_signup_switch_changes")).rows[0].n).toBe(0);
  });

  it("opens and closes only through the owner's SQL session and records every change", async () => {
    await inTransaction(async () => {
      const sessionRole = (await client.query("select session_user as role")).rows[0].role;
      await client.query("insert into private.open_signup_period(singleton, opens_at) values (true, now() - interval '1 minute')");
      expect(await switchOpen()).toBe(true);
      await client.query("update private.open_signup_period set opens_at = now() + interval '1 day'");
      expect(await switchOpen()).toBe(false);
      await client.query("delete from private.open_signup_period");
      expect(await switchOpen()).toBe(false);
      await client.query("insert into private.open_signup_period(singleton, opens_at) values (true, now())");
      expect(await switchOpen()).toBe(true);
      await client.query("truncate private.open_signup_period");
      expect(await switchOpen()).toBe(false);
      expect(await changes()).toEqual([
        { operation: "INSERT", session_role: sessionRole, application_name: "public-signup-switch-proof", had_old: false, has_new: true, open_after: true },
        { operation: "UPDATE", session_role: sessionRole, application_name: "public-signup-switch-proof", had_old: true, has_new: true, open_after: false },
        { operation: "DELETE", session_role: sessionRole, application_name: "public-signup-switch-proof", had_old: true, has_new: false, open_after: false },
        { operation: "INSERT", session_role: sessionRole, application_name: "public-signup-switch-proof", had_old: false, has_new: true, open_after: true },
        { operation: "TRUNCATE", session_role: sessionRole, application_name: "public-signup-switch-proof", had_old: false, has_new: false, open_after: false },
      ]);
    });
  });

  it("lets no client role, the service role included, read or change the switch or its audit", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of ["private.open_signup_period", "private.open_signup_switch_changes"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect((await client.query("select has_table_privilege($1, $2, $3) as ok", [role, table, privilege])).rows[0].ok, `${role} ${privilege} ${table}`).toBe(false);
        }
      }
      expect((await client.query("select has_function_privilege($1, 'private.record_open_signup_switch_change()', 'EXECUTE') as ok", [role])).rows[0].ok, role).toBe(false);
    }
    await inTransaction(async () => {
      await client.query("set local role authenticated");
      await expect(client.query("insert into private.open_signup_period(singleton, opens_at) values (true, now())")).rejects.toMatchObject({ code: "42501" });
    });
    await inTransaction(async () => {
      await client.query("set local role service_role");
      await expect(client.query("update private.open_signup_period set opens_at = now()")).rejects.toMatchObject({ code: "42501" });
    });
  });

  it("leaves no unreviewed account lifecycle trigger behind", async () => {
    expect((await client.query("select * from private.account_lifecycle_referential_action_trigger_issues()")).rows).toEqual([]);
  }, 120_000);

  it("answers the status read for the service role alone", async () => {
    expect((await client.query("select has_function_privilege('service_role', 'public.open_signup_switch_open()', 'EXECUTE') as ok")).rows[0].ok).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      expect((await client.query("select has_function_privilege($1, 'public.open_signup_switch_open()', 'EXECUTE') as ok", [role])).rows[0].ok, role).toBe(false);
    }
    await inTransaction(async () => {
      await client.query("set local role service_role");
      expect(await switchOpen()).toBe(false);
    });
    await inTransaction(async () => {
      await client.query("set local role anon");
      await expect(client.query("select public.open_signup_switch_open()")).rejects.toMatchObject({ code: "42501" });
    });
  });
});
