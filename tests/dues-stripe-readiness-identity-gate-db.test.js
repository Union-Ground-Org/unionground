// @vitest-environment node
import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql } from "./helpers/migration.js";

// DEBT-UG-DUES-STRIPE-TEST-ACCOUNT-HELPER-OMITS-MFA-AND-IDENTITY-20260921.
// 20260907151000 did not wrap this routine, so Main's live body is the
// 20260831223000 inner source verbatim. Installing that exact digest is what
// "served the account id before the repair" means here: the reviewed Main body,
// not a hand-copied approximation of it.
const MAIN_PREDECESSOR_DIGEST =
  "93ca879324f5e8ed1f2ca87291625ae04f2e35b6b8c1ea1498c7a827c1d1fc92";

function mainReadinessDefinitionSql() {
  const original = parseFunctions(
    loadMigrationSql("20260831223000_mi1_dues_exact_head_repairs"),
    "20260831223000.sql",
  ).find((entry) => entry.name === "public.read_dues_stripe_account_for_test");
  if (!original) throw new Error("missing Main readiness function");
  return `create or replace function public.read_dues_stripe_account_for_test(
  p_organization_id uuid,
  p_requested_by uuid,
  p_selected_hat text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $dues_readiness_main_pred$${original.source}$dues_readiness_main_pred$;`;
}

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const FIXTURES = Object.freeze({
  dualGrant: "0a220100-0000-4000-8000-000000000001",
  singleGrant: "0a220100-0000-4000-8000-000000000002",
  organization: "0a220100-0000-4000-8000-00000000000a",
  accountId: "acct_c21_readiness",
});

function connect() {
  return new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: "dues-stripe-readiness-identity-gate-proof",
  });
}

async function provision(client) {
  await client.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
    FIXTURES.dualGrant,
    "dues-readiness-dual-grant@example.invalid",
    FIXTURES.singleGrant,
    "dues-readiness-single-grant@example.invalid",
  ]);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, $2, $3, 'active', $4)
  `, [FIXTURES.organization, "dues-readiness-identity-gate", "Dues readiness identity gate", FIXTURES.dualGrant]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status)
    values ($1, $2, 'active'), ($1, $3, 'active')
  `, [FIXTURES.organization, FIXTURES.dualGrant, FIXTURES.singleGrant]);
  // A dual grant is the case private.dues_sync_financial_identity_for_context
  // deliberately refuses to auto-provision: the member must be assigned one
  // financial identity before any dues routine may act as that hat.
  await client.query(`
    insert into public.organization_role_grants (organization_id, user_id, role)
    values ($1, $2, 'admin'), ($1, $2, 'vp'), ($1, $3, 'admin')
  `, [FIXTURES.organization, FIXTURES.dualGrant, FIXTURES.singleGrant]);
  await client.query(`
    insert into public.dues_provider_connections (
      organization_id, state, stripe_account_id, charges_enabled, payouts_enabled
    ) values ($1, 'ready', $2, true, false)
  `, [FIXTURES.organization, FIXTURES.accountId]);
}

async function asServiceRole(client) {
  await client.query("reset role");
  await client.query(
    "select set_config('request.jwt.claims', $1, true)",
    [JSON.stringify({ role: "service_role" })],
  );
  await client.query("set local role service_role");
}

async function readiness(client, userId, hat) {
  return (await client.query(
    "select public.read_dues_stripe_account_for_test($1::uuid, $2::uuid, $3::text) as value",
    [FIXTURES.organization, userId, hat],
  )).rows[0].value;
}

async function readinessError(client, userId, hat) {
  await client.query("savepoint readiness_attempt");
  try {
    await readiness(client, userId, hat);
    return null;
  } catch (error) {
    return error.code;
  } finally {
    await client.query("rollback to savepoint readiness_attempt");
  }
}

live("read_dues_stripe_account_for_test financial-identity gate", () => {
  it("refuses the unassigned dual-grant identity Main's body served, and serves the assigned hat", async () => {
    const client = connect();
    await client.connect();
    await client.query("begin");
    try {
      await provision(client);
      const unassigned = (await client.query(`
        select count(*)::int as rows
          from private.dues_financial_identity_selections
         where organization_id = $1 and user_id = $2
      `, [FIXTURES.organization, FIXTURES.dualGrant])).rows[0].rows;
      expect(unassigned).toBe(0);

      // Install the digest-pinned Main body inside a savepoint, invoke it, then
      // roll back so the repaired definition is what the next call hits.
      await client.query("savepoint main_readiness");
      try {
        await client.query(mainReadinessDefinitionSql());
        const installed = (await client.query(`
          select pg_catalog.encode(
            extensions.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'),
            'hex'
          ) as digest
            from pg_catalog.pg_proc p
           where p.oid = 'public.read_dues_stripe_account_for_test(uuid, uuid, text)'::regprocedure
        `)).rows[0].digest;
        expect(installed).toBe(MAIN_PREDECESSOR_DIGEST);

        await asServiceRole(client);
        expect(await readiness(client, FIXTURES.dualGrant, "admin"))
          .toEqual({ accountId: FIXTURES.accountId });
      } finally {
        await client.query("rollback to savepoint main_readiness");
      }

      await asServiceRole(client);
      expect(await readinessError(client, FIXTURES.dualGrant, "admin")).toBe("42501");

      await client.query("reset role");
      await client.query(`
        insert into private.dues_financial_identity_selections (
          organization_id, user_id, selected_hat, reset_reason
        ) values ($1, $2, 'vp', 'readiness-identity-gate-proof')
      `, [FIXTURES.organization, FIXTURES.dualGrant]);

      await asServiceRole(client);
      // The assignment names one hat; the other is still refused.
      expect(await readinessError(client, FIXTURES.dualGrant, "admin")).toBe("42501");
      expect(await readiness(client, FIXTURES.dualGrant, "vp"))
        .toEqual({ accountId: FIXTURES.accountId });
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);

  it("leaves the auto-provisioned single-grant readiness path unchanged", async () => {
    const client = connect();
    await client.connect();
    await client.query("begin");
    try {
      await provision(client);
      const provisioned = (await client.query(`
        select selected_hat
          from private.dues_financial_identity_selections
         where organization_id = $1 and user_id = $2
      `, [FIXTURES.organization, FIXTURES.singleGrant])).rows[0];
      expect(provisioned).toEqual({ selected_hat: "admin" });

      await asServiceRole(client);
      expect(await readiness(client, FIXTURES.singleGrant, "admin"))
        .toEqual({ accountId: FIXTURES.accountId });
      // Every refusal the Main body already made is still made.
      expect(await readinessError(client, FIXTURES.singleGrant, "steward")).toBe("42501");
      expect(await readinessError(client, FIXTURES.singleGrant, "vp")).toBe("42501");
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);
});
