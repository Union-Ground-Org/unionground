// @vitest-environment node
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;

const FIXTURES = Object.freeze({
  adminA: "08401700-0000-4000-8000-000000000001",
  adminB: "08401700-0000-4000-8000-000000000002",
  adminC: "08401700-0000-4000-8000-000000000003",
  adminD: "08401700-0000-4000-8000-000000000004",
  organizationA: "08401700-0000-4000-8000-00000000000a",
  organizationB: "08401700-0000-4000-8000-00000000000b",
  organizationC: "08401700-0000-4000-8000-00000000000c",
  organizationD: "08401700-0000-4000-8000-00000000000d",
});

// This proof runs in the required lane's shared-fixtures phase, where earlier
// suites have already committed organizations. `bootstrap_first_organization`
// refuses with 23505 once any organization exists, so the tenant is built from
// only the rows this RPC actually needs: the requester, the organization the
// audit writer and the provider connection reference, and the active
// membership the service-role audit writer resolves its actor from.
async function provisionOrganization(client, { organizationId, adminId, slug, name, email }) {
  await client.query("insert into auth.users (id, email) values ($1, $2)", [adminId, email]);
  await client.query(`
    insert into public.organizations (id, slug, name, status, created_by)
    values ($1, $2, $3, 'active', $4)
  `, [organizationId, slug, name, adminId]);
  // private.mi1_write_tenant_audit refuses a service-role event whose
  // requestedBy is not an active member of the audited organization.
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

// A legacy recorded exchange is reached through the callback, so the row it
// leaves behind carries a live lease, whatever error class the callback last
// wrote, and a reconcile_after in the future. Seeding those three makes the
// recovery row shape observable: every column the quarantine must write here
// starts out holding a different value.
const LEASE_OWNER = "08401700-0000-4000-8000-0000000000fe";

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

// public.record_dues_stripe_oauth_recovery_account (20260831223000:279-287) is
// the canonical writer of this state. Every quarantine branch must leave the
// same seven columns, or an operator cannot tell one recovery reason from
// another and the row keeps a lease that no longer means anything.
const RECOVERY_ROW_COLUMNS = `
  exchange_account_id, exchange_recorded_at, exchanged_account_id,
  recovery_required_at is not null as recovery_required, callback_state,
  last_error_class, callback_lease_owner, callback_lease_expires_at,
  reconcile_after = now() as reconcile_rearmed
`;

function quarantinedRow(exchangedAccountId) {
  return {
    exchange_account_id: null,
    exchange_recorded_at: null,
    exchanged_account_id: exchangedAccountId,
    recovery_required: true,
    callback_state: "attention_required",
    last_error_class: "oauth_exchange_recovery_required",
    callback_lease_owner: null,
    callback_lease_expires_at: null,
    reconcile_rearmed: true,
  };
}

live("legacy-column dues Stripe OAuth recovery", () => {
  it("quarantines an ambiguous recorded exchange without violating table checks", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-recovery-row-shape-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client, {
        organizationId: FIXTURES.organizationA,
        adminId: FIXTURES.adminA,
        slug: "dues-oauth-recovery-a",
        name: "Dues OAuth recovery proof",
        email: "dues-oauth-recovery@example.invalid",
      });
      const organizationId = FIXTURES.organizationA;

      await client.query(`
        insert into public.dues_provider_connections (organization_id, state, updated_at)
        values ($1, 'pending', now())
        on conflict (organization_id) do update
          set state = 'pending', last_error_class = null, updated_at = now()
          where public.dues_provider_connections.state <> 'ready'
      `, [organizationId]);
      await insertLegacyRecordedState(client, {
        organizationId,
        requestedBy: FIXTURES.adminA,
        stateHash: "a".repeat(64),
        accountId: "acct_recovery_one",
      });
      await insertLegacyRecordedState(client, {
        organizationId,
        requestedBy: FIXTURES.adminA,
        stateHash: "c".repeat(64),
        accountId: "acct_recovery_two",
      });

      await asRole(client, "service_role", FIXTURES.adminA);
      const result = (await client.query(
        "select public.get_pending_dues_stripe_oauth_exchange($1, $2, 'admin') as value",
        [organizationId, FIXTURES.adminA],
      )).rows[0].value;
      expect(result).toEqual({ state: "attention_required" });

      await client.query("reset role");
      const rows = (await client.query(`
        select ${RECOVERY_ROW_COLUMNS}
          from private.dues_stripe_oauth_states
         where organization_id = $1
         order by exchanged_account_id
      `, [organizationId])).rows;
      expect(rows).toEqual([
        quarantinedRow("acct_recovery_one"),
        quarantinedRow("acct_recovery_two"),
      ]);

      const connection = (await client.query(
        "select state, last_error_class from public.dues_provider_connections where organization_id = $1",
        [organizationId],
      )).rows[0];
      expect(connection).toEqual({
        state: "attention_required",
        last_error_class: "oauth_recorded_exchange_ambiguous",
      });

      const audit = (await client.query(`
        select event_type, metadata->>'reason' as reason
          from public.organization_audit_events
         where organization_id = $1
           and event_type = 'dues_stripe_oauth_recovery_required'
      `, [organizationId])).rows;
      expect(audit).toEqual([{
        event_type: "dues_stripe_oauth_recovery_required",
        reason: "recorded_exchange_ambiguous",
      }]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);

  it("quarantines a superseded recorded exchange when a ready connection already exists", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-recovery-ready-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client, {
        organizationId: FIXTURES.organizationB,
        adminId: FIXTURES.adminB,
        slug: "dues-oauth-recovery-b",
        name: "Dues OAuth ready recovery proof",
        email: "dues-oauth-ready@example.invalid",
      });
      const organizationId = FIXTURES.organizationB;

      await client.query(`
        insert into public.dues_provider_connections (
          organization_id, state, stripe_account_id, charges_enabled, connected_at, updated_at
        ) values ($1, 'ready', 'acct_ready', true, now(), now())
        on conflict (organization_id) do update
          set state = 'ready', stripe_account_id = excluded.stripe_account_id,
              charges_enabled = true, connected_at = now(), updated_at = now(),
              last_error_class = null
      `, [organizationId]);
      await insertLegacyRecordedState(client, {
        organizationId,
        requestedBy: FIXTURES.adminB,
        stateHash: "d".repeat(64),
        accountId: "acct_stale_recorded",
      });

      await asRole(client, "service_role", FIXTURES.adminB);
      const result = (await client.query(
        "select public.get_pending_dues_stripe_oauth_exchange($1, $2, 'admin') as value",
        [organizationId, FIXTURES.adminB],
      )).rows[0].value;
      expect(result).toEqual({ state: "none" });

      await client.query("reset role");
      const row = (await client.query(`
        select ${RECOVERY_ROW_COLUMNS}
          from private.dues_stripe_oauth_states
         where state_hash = $1
      `, ["d".repeat(64)])).rows[0];
      expect(row).toEqual(quarantinedRow("acct_stale_recorded"));
      expect((await client.query(
        "select state from public.dues_provider_connections where organization_id = $1",
        [organizationId],
      )).rows[0].state).toBe("ready");
      expect((await client.query(`
        select event_type, metadata->>'reason' as reason
          from public.organization_audit_events
         where organization_id = $1
           and event_type = 'dues_stripe_oauth_recovery_required'
      `, [organizationId])).rows).toEqual([{
        event_type: "dues_stripe_oauth_recovery_required",
        reason: "superseded_by_ready_connection",
      }]);

      // The quarantine is only useful if the documented exit still accepts it.
      // public.resolve_dues_stripe_oauth_recovery requires an unconsumed row
      // with recovery_required_at set, and leaves a ready connection alone.
      await asRole(client, "service_role", FIXTURES.adminB);
      await client.query(
        "select public.resolve_dues_stripe_oauth_recovery($1, 'authorization_revoked')",
        ["d".repeat(64)],
      );

      await client.query("reset role");
      const resolved = (await client.query(`
        select callback_state, last_error_class, callback_lease_owner,
               callback_lease_expires_at, consumed_at is not null as consumed,
               completed_at is not null as completed
          from private.dues_stripe_oauth_states
         where state_hash = $1
      `, ["d".repeat(64)])).rows[0];
      expect(resolved).toEqual({
        callback_state: "refused",
        last_error_class: "oauth_exchange_authorization_revoked",
        callback_lease_owner: null,
        callback_lease_expires_at: null,
        consumed: true,
        completed: true,
      });
      expect((await client.query(
        "select state from public.dues_provider_connections where organization_id = $1",
        [organizationId],
      )).rows[0].state).toBe("ready");
      expect((await client.query(`
        select metadata->>'failureClass' as failure_class
          from public.organization_audit_events
         where organization_id = $1
           and event_type = 'dues_stripe_oauth_failed'
      `, [organizationId])).rows).toEqual([
        { failure_class: "oauth_exchange_authorization_revoked" },
      ]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);

  it("writes no recovery audit when a ready connection has nothing to quarantine", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-recovery-ready-zero-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client, {
        organizationId: FIXTURES.organizationD,
        adminId: FIXTURES.adminD,
        slug: "dues-oauth-recovery-d",
        name: "Dues OAuth ready zero-match proof",
        email: "dues-oauth-ready-zero@example.invalid",
      });
      const organizationId = FIXTURES.organizationD;

      await client.query(`
        insert into public.dues_provider_connections (
          organization_id, state, stripe_account_id, charges_enabled, connected_at, updated_at
        ) values ($1, 'ready', 'acct_ready_zero', true, now(), now())
        on conflict (organization_id) do update
          set state = 'ready', stripe_account_id = excluded.stripe_account_id,
              charges_enabled = true, connected_at = now(), updated_at = now(),
              last_error_class = null
      `, [organizationId]);

      await asRole(client, "service_role", FIXTURES.adminD);
      const result = (await client.query(
        "select public.get_pending_dues_stripe_oauth_exchange($1, $2, 'admin') as value",
        [organizationId, FIXTURES.adminD],
      )).rows[0].value;
      expect(result).toEqual({ state: "none" });

      await client.query("reset role");
      expect((await client.query(
        "select state from public.dues_provider_connections where organization_id = $1",
        [organizationId],
      )).rows[0].state).toBe("ready");
      expect((await client.query(`
        select event_type, metadata->>'reason' as reason
          from public.organization_audit_events
         where organization_id = $1
           and event_type = 'dues_stripe_oauth_recovery_required'
      `, [organizationId])).rows).toEqual([]);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);

  it("returns a single legacy recorded exchange without entering recovery", async () => {
    const client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "dues-oauth-recovery-recorded-proof",
    });
    await client.connect();
    await client.query("begin");
    try {
      await provisionOrganization(client, {
        organizationId: FIXTURES.organizationC,
        adminId: FIXTURES.adminC,
        slug: "dues-oauth-recovery-c",
        name: "Dues OAuth recorded proof",
        email: "dues-oauth-recorded@example.invalid",
      });
      const organizationId = FIXTURES.organizationC;

      await insertLegacyRecordedState(client, {
        organizationId,
        requestedBy: FIXTURES.adminC,
        stateHash: "e".repeat(64),
        accountId: "acct_single_recorded",
      });

      await asRole(client, "service_role", FIXTURES.adminC);
      const result = (await client.query(
        "select public.get_pending_dues_stripe_oauth_exchange($1, $2, 'admin') as value",
        [organizationId, FIXTURES.adminC],
      )).rows[0].value;
      expect(result).toEqual({ state: "recorded", accountId: "acct_single_recorded" });

      await client.query("reset role");
      const row = (await client.query(`
        select exchange_account_id, recovery_required_at, callback_state,
               last_error_class, callback_lease_owner
          from private.dues_stripe_oauth_states
         where state_hash = $1
      `, ["e".repeat(64)])).rows[0];
      expect(row.exchange_account_id).toBe("acct_single_recorded");
      expect(row.recovery_required_at).toBeNull();
      // No quarantine happened, so none of the recovery columns moved.
      expect(row.callback_state).toBe("exchanged");
      expect(row.last_error_class).toBe("oauth_exchange_deferred");
      expect(row.callback_lease_owner).toBe(LEASE_OWNER);
    } finally {
      await client.query("rollback");
      await client.end();
    }
  }, 60_000);
});
