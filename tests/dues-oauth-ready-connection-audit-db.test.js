// @vitest-environment node
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const FIXTURES = Object.freeze({
  adminMatched: "08401910-0000-4000-8000-000000000001",
  adminZero: "08401910-0000-4000-8000-000000000002",
  adminAmbiguous: "08401910-0000-4000-8000-000000000003",
  organizationMatched: "08401910-0000-4000-8000-00000000000a",
  organizationZero: "08401910-0000-4000-8000-00000000000b",
  organizationAmbiguous: "08401910-0000-4000-8000-00000000000c",
});

const LEASE_OWNER = "08401910-0000-4000-8000-0000000000fe";

async function provisionOrganization(client, { organizationId, adminId, slug, name, email }) {
  await client.query("insert into auth.users (id, email) values ($1, $2)", [adminId, email]);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, $2, $3, 'active', $4)
  `, [organizationId, slug, name, adminId]);
  await client.query(`
    insert into public.organization_memberships (organization_id, user_id, status)
    values ($1, $2, 'active')
  `, [organizationId, adminId]);
}

async function asRole(client, role, userId = null) {
  await client.query("reset role");
  const claims = userId ? { sub: userId, role, aal: "aal2" } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

async function insertLegacyRecordedState(client, {
  organizationId,
  requestedBy,
  stateHash,
  accountId,
}) {
  await client.query(`
    insert into private.dues_stripe_oauth_states (
      state_hash, organization_id, requested_by, selected_hat,
      browser_binding_hash, redirect_uri, expires_at, created_at,
      exchange_started_at, exchange_account_id, exchange_recorded_at,
      callback_state, callback_lease_owner, callback_lease_epoch,
      callback_lease_expires_at, last_error_class, reconcile_after
    ) values (
      $1, $2, $3, 'admin', $4,
      'https://sibling-saas.example/api/dues-stripe-connect',
      now() + interval '5 minutes', now(),
      now() - interval '1 minute', $5, now() - interval '1 minute',
      'exchanged', $6, 1,
      now() + interval '5 minutes', 'oauth_exchange_deferred',
      now() + interval '1 hour'
    )
  `, [stateHash, organizationId, requestedBy, "b".repeat(64), accountId, LEASE_OWNER]);
}

async function insertReadyConnection(client, organizationId, accountId) {
  await client.query(`
    insert into public.dues_provider_connections (
      organization_id, state, stripe_account_id, charges_enabled, connected_at, updated_at
    ) values ($1, 'ready', $2, true, now(), now())
    on conflict (organization_id) do update
      set state = 'ready', stripe_account_id = excluded.stripe_account_id,
          charges_enabled = true, connected_at = now(), updated_at = now(),
          last_error_class = null
  `, [organizationId, accountId]);
}

function recoveryAudits(client, organizationId) {
  return client.query(`
    select event_type, metadata->>'reason' as reason
      from public.organization_audit_events
     where organization_id = $1
       and event_type = 'dues_stripe_oauth_recovery_required'
     order by reason
  `, [organizationId]);
}

live("ready-connection dues Stripe OAuth recovery audit", () => {
  it("writes superseded_by_ready_connection when the quarantine UPDATE matched a row", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-ready-audit-matched-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client, {
        organizationId: FIXTURES.organizationMatched,
        adminId: FIXTURES.adminMatched,
        slug: "dues-oauth-ready-audit-matched",
        name: "Dues OAuth ready audit matched",
        email: "dues-oauth-ready-audit-matched@example.invalid",
      });
      const organizationId = FIXTURES.organizationMatched;
      await insertReadyConnection(client, organizationId, "acct_ready_matched");
      await insertLegacyRecordedState(client, {
        organizationId,
        requestedBy: FIXTURES.adminMatched,
        stateHash: "d".repeat(64),
        accountId: "acct_stale_matched",
      });

      await asRole(client, "service_role", FIXTURES.adminMatched);
      const result = (await client.query(
        "select public.get_pending_dues_stripe_oauth_exchange($1, $2, 'admin') as value",
        [organizationId, FIXTURES.adminMatched],
      )).rows[0].value;
      expect(result).toEqual({ state: "none" });

      await client.query("reset role");
      expect((await client.query(
        "select state from public.dues_provider_connections where organization_id = $1",
        [organizationId],
      )).rows[0].state).toBe("ready");
      expect((await recoveryAudits(client, organizationId)).rows).toEqual([{
        event_type: "dues_stripe_oauth_recovery_required",
        reason: "superseded_by_ready_connection",
      }]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);

  it("writes no audit when a ready connection has nothing to quarantine", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-ready-audit-zero-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client, {
        organizationId: FIXTURES.organizationZero,
        adminId: FIXTURES.adminZero,
        slug: "dues-oauth-ready-audit-zero",
        name: "Dues OAuth ready audit zero",
        email: "dues-oauth-ready-audit-zero@example.invalid",
      });
      const organizationId = FIXTURES.organizationZero;
      await insertReadyConnection(client, organizationId, "acct_ready_zero");

      await asRole(client, "service_role", FIXTURES.adminZero);
      const result = (await client.query(
        "select public.get_pending_dues_stripe_oauth_exchange($1, $2, 'admin') as value",
        [organizationId, FIXTURES.adminZero],
      )).rows[0].value;
      expect(result).toEqual({ state: "none" });

      await client.query("reset role");
      expect((await client.query(
        "select state from public.dues_provider_connections where organization_id = $1",
        [organizationId],
      )).rows[0].state).toBe("ready");
      expect((await recoveryAudits(client, organizationId)).rows).toEqual([]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);

  it("keeps the ambiguous-branch audit as delivered", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-ready-audit-ambiguous-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client, {
        organizationId: FIXTURES.organizationAmbiguous,
        adminId: FIXTURES.adminAmbiguous,
        slug: "dues-oauth-ready-audit-ambiguous",
        name: "Dues OAuth ready audit ambiguous",
        email: "dues-oauth-ready-audit-ambiguous@example.invalid",
      });
      const organizationId = FIXTURES.organizationAmbiguous;
      await client.query(`
        insert into public.dues_provider_connections (organization_id, state, updated_at)
        values ($1, 'pending', now())
        on conflict (organization_id) do update
          set state = 'pending', last_error_class = null, updated_at = now()
          where public.dues_provider_connections.state <> 'ready'
      `, [organizationId]);
      await insertLegacyRecordedState(client, {
        organizationId,
        requestedBy: FIXTURES.adminAmbiguous,
        stateHash: "a".repeat(64),
        accountId: "acct_ambiguous_one",
      });
      await insertLegacyRecordedState(client, {
        organizationId,
        requestedBy: FIXTURES.adminAmbiguous,
        stateHash: "c".repeat(64),
        accountId: "acct_ambiguous_two",
      });

      await asRole(client, "service_role", FIXTURES.adminAmbiguous);
      const result = (await client.query(
        "select public.get_pending_dues_stripe_oauth_exchange($1, $2, 'admin') as value",
        [organizationId, FIXTURES.adminAmbiguous],
      )).rows[0].value;
      expect(result).toEqual({ state: "attention_required" });

      await client.query("reset role");
      expect((await recoveryAudits(client, organizationId)).rows).toEqual([{
        event_type: "dues_stripe_oauth_recovery_required",
        reason: "recorded_exchange_ambiguous",
      }]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);
});
