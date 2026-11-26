// @vitest-environment node
import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

// 20260907151000 wrap of the 20260831223000 inner source. Installing this
// exact predecessor is what "fails on Main's function" means: the reviewed
// Main body, not a copied SET list that can drift from it.
const MAIN_PREDECESSOR_DIGEST =
  "9d891c4ed2e2c858a394c72cad08c1d39bfed55eb3647d185a5e2361d3309b7b";

function mainRecoveryAccountDefinitionSql() {
  const original = parseFunctions(
    loadMigrationSql("20260831223000_mi1_dues_exact_head_repairs"),
    "20260831223000.sql",
  ).find((entry) => entry.name === "public.record_dues_stripe_oauth_recovery_account");
  if (!original) throw new Error("missing Main recovery-account function");
  const rtrimmed = original.source.replace(/[\n\r\t ]+$/, "");
  const wrapped = `\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n${rtrimmed}\nend;\n`;
  return `create or replace function public.record_dues_stripe_oauth_recovery_account(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_account_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $dues_oauth_main_pred$${wrapped}$dues_oauth_main_pred$;`;
}

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const FIXTURES = Object.freeze({
  admin: "08401900-0000-4000-8000-000000000001",
  organization: "08401900-0000-4000-8000-00000000000a",
  leaseOwner: "08401900-0000-4000-8000-0000000000fe",
});

async function provisionOrganization(client) {
  await client.query("insert into auth.users (id, email) values ($1, $2)", [
    FIXTURES.admin,
    "dues-oauth-recovery-account-check@example.invalid",
  ]);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, $2, $3, 'active', $4)
  `, [FIXTURES.organization, "dues-oauth-recovery-account-check", "Dues OAuth recovery-account check", FIXTURES.admin]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status)
    values ($1, $2, 'active')
  `, [FIXTURES.organization, FIXTURES.admin]);
}

async function asRole(client, role, userId = null) {
  await client.query("reset role");
  const claims = userId ? { sub: userId, role, aal: "aal2" } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

async function insertClaimedStartedState(client, {
  stateHash,
  accountId = null,
  exchangedAccountId = null,
}) {
  await client.query(`
    insert into private.dues_stripe_oauth_states (
      state_hash, organization_id, requested_by, selected_hat,
      browser_binding_hash, redirect_uri, expires_at, created_at,
      exchange_started_at, exchange_account_id, exchange_recorded_at,
      exchanged_account_id, callback_state, callback_lease_owner,
      callback_lease_epoch, callback_lease_expires_at, last_error_class,
      reconcile_after
    ) values (
      $1, $2, $3, 'admin', $4,
      'https://sibling-saas.example/api/dues-stripe-connect',
      now() + interval '5 minutes', now(),
      now() - interval '1 minute', $5::text,
      case when $5::text is null then null else now() - interval '1 minute' end,
      $6::text, 'processing', $7, 1,
      now() + interval '5 minutes', 'oauth_exchange_deferred',
      now() + interval '1 hour'
    )
  `, [
    stateHash,
    FIXTURES.organization,
    FIXTURES.admin,
    "b".repeat(64),
    accountId,
    exchangedAccountId,
    FIXTURES.leaseOwner,
  ]);
}

live("record_dues_stripe_oauth_recovery_account check constraint", () => {
  it("fails Main's function with 23514 after the 3-arg writer and passes once the pair is cleared", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-recovery-account-check-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client);
      const stateHash = "a".repeat(64);
      const accountId = "acct_legacy_three_arg";
      await insertClaimedStartedState(client, { stateHash });

      await asRole(client, "service_role", FIXTURES.admin);
      const recorded = (await client.query(
        "select public.record_dues_stripe_oauth_exchange($1::text, $2::text, $3::text) as value",
        [stateHash, "b".repeat(64), accountId],
      )).rows[0].value;
      expect(recorded).toEqual({
        organizationId: FIXTURES.organization,
        requestedBy: FIXTURES.admin,
        selectedHat: "admin",
        accountId,
      });

      await client.query("reset role");
      const afterThreeArg = (await client.query(`
        select exchange_account_id, exchange_recorded_at is not null as recorded,
               exchanged_account_id, recovery_required_at
          from private.dues_stripe_oauth_states
         where state_hash = $1
      `, [stateHash])).rows[0];
      expect(afterThreeArg).toEqual({
        exchange_account_id: accountId,
        recorded: true,
        exchanged_account_id: null,
        recovery_required_at: null,
      });

      // Install the digest-pinned Main function inside a savepoint, invoke it,
      // then roll back so the repaired definition is what the next call hits.
      await client.query("reset role");
      await client.query("savepoint main_writer");
      try {
        await client.query(mainRecoveryAccountDefinitionSql());
        const installed = (await client.query(`
          select pg_catalog.encode(
            extensions.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'),
            'hex'
          ) as digest
            from pg_catalog.pg_proc p
           where p.oid = 'public.record_dues_stripe_oauth_recovery_account(text, integer, uuid, text)'::regprocedure
        `)).rows[0].digest;
        expect(installed).toBe(MAIN_PREDECESSOR_DIGEST);

        await asRole(client, "service_role", FIXTURES.admin);
        let mainCode = null;
        try {
          await client.query(
            "select public.record_dues_stripe_oauth_recovery_account($1::text, $2::integer, $3::uuid, $4::text)",
            [stateHash, 1, FIXTURES.leaseOwner, accountId],
          );
        } catch (error) {
          mainCode = error.code;
        }
        expect(mainCode).toBe("23514");
      } finally {
        await client.query("rollback to savepoint main_writer");
      }

      await asRole(client, "service_role", FIXTURES.admin);
      await client.query(
        "select public.record_dues_stripe_oauth_recovery_account($1::text, $2::integer, $3::uuid, $4::text)",
        [stateHash, 1, FIXTURES.leaseOwner, accountId],
      );

      await client.query("reset role");
      const recovered = (await client.query(`
        select exchange_account_id, exchange_recorded_at, exchanged_account_id,
               recovery_required_at is not null as recovery_required,
               callback_state, last_error_class, callback_lease_owner,
               callback_lease_expires_at
          from private.dues_stripe_oauth_states
         where state_hash = $1
      `, [stateHash])).rows[0];
      expect(recovered).toEqual({
        exchange_account_id: null,
        exchange_recorded_at: null,
        exchanged_account_id: accountId,
        recovery_required: true,
        callback_state: "attention_required",
        last_error_class: "oauth_exchange_recovery_required",
        callback_lease_owner: null,
        callback_lease_expires_at: null,
      });
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);

  it("keeps the 6-arg live callback path working", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-recovery-account-six-arg-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client);
      const stateHash = "c".repeat(64);
      const accountId = "acct_live_six_arg";
      await insertClaimedStartedState(client, { stateHash });

      await asRole(client, "service_role", FIXTURES.admin);
      await client.query(
        "select public.record_dues_stripe_oauth_exchange($1::text, $2::integer, $3::uuid, $4::text, $5::text, $6::boolean)",
        [stateHash, 1, FIXTURES.leaseOwner, accountId, "read_write", true],
      );

      await client.query("reset role");
      const exchanged = (await client.query(`
        select exchange_account_id, exchanged_account_id, callback_state
          from private.dues_stripe_oauth_states
         where state_hash = $1
      `, [stateHash])).rows[0];
      expect(exchanged).toEqual({
        exchange_account_id: null,
        exchanged_account_id: accountId,
        callback_state: "exchanged",
      });

      await asRole(client, "service_role", FIXTURES.admin);
      await client.query(
        "select public.record_dues_stripe_oauth_recovery_account($1::text, $2::integer, $3::uuid, $4::text)",
        [stateHash, 1, FIXTURES.leaseOwner, accountId],
      );

      await client.query("reset role");
      const recovered = (await client.query(`
        select exchange_account_id, exchange_recorded_at, exchanged_account_id,
               recovery_required_at is not null as recovery_required,
               callback_state
          from private.dues_stripe_oauth_states
         where state_hash = $1
      `, [stateHash])).rows[0];
      expect(recovered).toEqual({
        exchange_account_id: null,
        exchange_recorded_at: null,
        exchanged_account_id: accountId,
        recovery_required: true,
        callback_state: "attention_required",
      });
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);
});
