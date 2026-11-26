// @vitest-environment node
import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

// 20260907151000 wrap of the 20260831211500 inner source. Installing this exact
// predecessor is what "fails on Main's function" means: the reviewed Main body,
// not a hand-copied approximation that can drift from it.
const MAIN_PREDECESSOR_DIGEST =
  "d807a6fe1262f1cdf3f668c7020f462ea7239d79a0572d8279c998a525405013";

const SIGNATURE = `(
  p_state_hash text,
  p_lease_epoch integer,
  p_lease_owner uuid,
  p_organization_id uuid,
  p_requested_by uuid,
  p_account_id text,
  p_account_label text,
  p_charges_enabled boolean,
  p_payouts_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''`;

function mainCompletionDefinitionSql() {
  const original = parseFunctions(
    loadMigrationSql("20260831211500_mi1_dues_review_repairs"),
    "20260831211500.sql",
  ).find((entry) => entry.name === "public.complete_dues_stripe_oauth_callback");
  if (!original) throw new Error("missing Main completion function");
  const rtrimmed = original.source.replace(/[\n\r\t ]+$/, "");
  const wrapped = `\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n${rtrimmed}\nend;\n`;
  return `create or replace function public.complete_dues_stripe_oauth_callback${SIGNATURE}
as $dues_oauth_main_pred$${wrapped}$dues_oauth_main_pred$;`;
}

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const FIXTURES = Object.freeze({
  admin: "08401901-0000-4000-8000-000000000001",
  organization: "08401901-0000-4000-8000-00000000000a",
  leaseOwner: "08401901-0000-4000-8000-0000000000fe",
});

// Both approved callback surfaces, each with the Stripe environment the surface
// is served by. public.save_dues_stripe_oauth_state admits no other redirect.
const SURFACES = Object.freeze([
  { name: "saas", redirectUri: "https://app.example.invalid/api/dues-stripe-connect", approvedLivemode: true },
  { name: "demo", redirectUri: "https://demo.example.com/api/dues-stripe-connect", approvedLivemode: false },
]);

async function connect(applicationName) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: applicationName,
  });
  await client.connect();
  return client;
}

async function provisionOrganization(client) {
  await client.query("insert into auth.users (id, email) values ($1, $2)", [
    FIXTURES.admin,
    "dues-oauth-environment-consistency@example.invalid",
  ]);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, $2, $3, 'active', $4)
  `, [FIXTURES.organization, "dues-oauth-environment-consistency", "Dues OAuth environment consistency", FIXTURES.admin]);
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

// One leased callback that has already exchanged its code: exactly the row
// public.record_dues_stripe_oauth_exchange leaves behind, with the environment
// indicator the provider reported.
async function insertExchangedState(client, { stateHash, redirectUri, accountId, livemode }) {
  await client.query(`
    insert into private.dues_stripe_oauth_states (
      state_hash, organization_id, requested_by, selected_hat,
      browser_binding_hash, redirect_uri, expires_at, created_at,
      exchanged_account_id, exchanged_scope, exchanged_livemode,
      callback_state, callback_lease_owner, callback_lease_epoch,
      callback_lease_expires_at, reconcile_after
    ) values (
      $1, $2, $3, 'admin', $4, $5,
      now() + interval '5 minutes', now(),
      $6::text, 'read_write', $7::boolean,
      'exchanged', $8, 1,
      now() + interval '5 minutes', now() + interval '1 hour'
    )
  `, [
    stateHash,
    FIXTURES.organization,
    FIXTURES.admin,
    "b".repeat(64),
    redirectUri,
    accountId,
    livemode,
    FIXTURES.leaseOwner,
  ]);
}

async function complete(client, { stateHash, accountId }) {
  return client.query(`
    select public.complete_dues_stripe_oauth_callback(
      $1::text, $2::integer, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::text, $8::boolean, $9::boolean
    ) as value
  `, [stateHash, 1, FIXTURES.leaseOwner, FIXTURES.organization, FIXTURES.admin, accountId, "Dues account", true, true]);
}

async function connectionState(client) {
  await client.query("reset role");
  const rows = (await client.query(
    "select state from public.dues_provider_connections where organization_id = $1",
    [FIXTURES.organization],
  )).rows;
  return rows.map((row) => row.state);
}

live("dues Stripe OAuth environment consistency", () => {
  it("completes each approved surface whose exchanged environment is the one it is served by", async () => {
    const client = await connect("dues-oauth-environment-match-proof");
    try {
      for (const surface of SURFACES) {
        await client.query("begin");
        try {
          await provisionOrganization(client);
          const stateHash = `${surface.name === "saas" ? "a" : "b"}`.repeat(64);
          const accountId = `acct_env_${surface.name}`;
          await insertExchangedState(client, {
            stateHash,
            redirectUri: surface.redirectUri,
            accountId,
            livemode: surface.approvedLivemode,
          });

          await asRole(client, "service_role", FIXTURES.admin);
          const completed = (await complete(client, { stateHash, accountId })).rows[0].value;
          expect(completed, surface.name).toEqual({ state: "ready" });

          expect(await connectionState(client), surface.name).toEqual(["ready"]);
          const saved = (await client.query(
            "select callback_state, consumed_at is not null as consumed from private.dues_stripe_oauth_states where state_hash = $1",
            [stateHash],
          )).rows[0];
          expect(saved, surface.name).toEqual({ callback_state: "completed", consumed: true });
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      await client.end();
    }
  }, 60_000);

  it("refuses each mismatched environment and surface pair and leaves no ready connection", async () => {
    const client = await connect("dues-oauth-environment-mismatch-proof");
    try {
      for (const surface of SURFACES) {
        await client.query("begin");
        try {
          await provisionOrganization(client);
          const stateHash = `${surface.name === "saas" ? "c" : "d"}`.repeat(64);
          const accountId = `acct_env_mismatch_${surface.name}`;
          await insertExchangedState(client, {
            stateHash,
            redirectUri: surface.redirectUri,
            accountId,
            // The environment the approved surface is NOT served by.
            livemode: !surface.approvedLivemode,
          });

          await asRole(client, "service_role", FIXTURES.admin);
          // The refusal aborts the transaction, so the observation of what it
          // left behind has to run from a savepoint taken before the call.
          await client.query("savepoint attempt");
          let code = null;
          try {
            await complete(client, { stateHash, accountId });
          } catch (error) {
            code = error.code;
          }
          expect(code, surface.name).toBe("22023");

          await client.query("rollback to savepoint attempt");
          expect(await connectionState(client), surface.name).toEqual([]);
          const saved = (await client.query(
            "select callback_state, consumed_at from private.dues_stripe_oauth_states where state_hash = $1",
            [stateHash],
          )).rows[0];
          expect(saved, surface.name).toEqual({ callback_state: "exchanged", consumed_at: null });
        } finally {
          await client.query("rollback");
        }
      }
    } finally {
      await client.end();
    }
  }, 60_000);

  it("is a behavior change: the reviewed Main body makes the same mismatched pair ready", async () => {
    const client = await connect("dues-oauth-environment-predecessor-proof");
    await client.query("begin");
    try {
      await provisionOrganization(client);
      const stateHash = "e".repeat(64);
      const accountId = "acct_env_predecessor";
      await insertExchangedState(client, {
        stateHash,
        redirectUri: "https://demo.example.com/api/dues-stripe-connect",
        accountId,
        livemode: true,
      });

      await client.query("reset role");
      await client.query(mainCompletionDefinitionSql());
      const installed = (await client.query(`
        select pg_catalog.encode(
          extensions.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'),
          'hex'
        ) as digest
          from pg_catalog.pg_proc p
         where p.oid = 'public.complete_dues_stripe_oauth_callback(text, integer, uuid, uuid, uuid, text, text, boolean, boolean)'::regprocedure
      `)).rows[0].digest;
      expect(installed).toBe(MAIN_PREDECESSOR_DIGEST);

      await asRole(client, "service_role", FIXTURES.admin);
      const completed = (await complete(client, { stateHash, accountId })).rows[0].value;
      expect(completed).toEqual({ state: "ready" });
      expect(await connectionState(client)).toEqual(["ready"]);
    } finally {
      // The transaction rollback also removes the predecessor definition, so
      // the repaired function is what any later proof in this lane hits.
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);
});
