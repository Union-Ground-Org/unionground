import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from './helpers/migration.js';

const sql = readFileSync('supabase/migrations/20260831170400_mi1_dues_settlement_reconciliation.sql', 'utf8');
const CLAIM_FN = 'private.dues_claim_checkout_reconciliations';
const LIVE_CLAIM_MIGRATION = '20260831211500_mi1_dues_review_repairs.sql';
// Parenthesised deliberately: without the surrounding parens, Postgres AND/OR
// precedence lets the expired-lease branch bypass every earlier connection,
// state, attempt-count and scheduling filter.
const LEASE_ELIGIBILITY =
  '(reservation.reconcile_lease_expires_at is null or reservation.reconcile_lease_expires_at <= now())';

function compactSql(text) {
  return text.replace(/\s+/g, ' ');
}

describe('Dues settlement and reconciliation migration', () => {
  it('uses durable provider event, request hash, and lease boundaries without provider credentials', () => {
    for (const name of [
      'prepare_dues_checkout_reservation', 'settle_dues_stripe_event', 'reconcile_dues_checkout_reservation',
      'claim_dues_checkout_reconciliations', 'claim_dues_stripe_disconnect_reconciliations',
      'complete_dues_stripe_disconnect', 'cancel_dues_checkout_reservation',
    ]) expect(sql).toContain(name);
    expect(sql).toContain('private.dues_checkout_request_hash');
    expect(sql).toContain('dues_stripe_payment_reference_once');
    expect(sql).toContain("case when p_disconnect then 'disconnect' else 'ordinary' end");
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });

  it('preserves the pre-lease state so cancellation claims are actually expired', () => {
    expect(sql).toContain('reservation.state as prior_state');
    expect(sql).toContain('leased.prior_state as state');
  });

  it('fences competing ledger mutations while a checkout is active and keeps service functions private', () => {
    expect(sql).toContain('dues_reject_competing_checkout_mutation');
    expect(sql).toContain("new.payment_method is distinct from 'stripe'");
    expect(sql).toContain('public.settle_dues_stripe_event');
    expect(sql).toContain('to service_role');
    expect(sql).toContain("state = 'attention_required'");
  });

  it('exact-matches immutable provider observations before a Stripe ledger event can settle', () => {
    for (const needle of [
      'p_observed_account_id', 'p_amount_cents', 'p_currency', 'p_client_reference_id', 'p_metadata_reservation_id',
      'dues Stripe settlement mismatch', 'reservation.connected_account_id <> p_observed_account_id',
      'reservation.reserved_cents <> p_amount_cents', 'p_client_reference_id <> p_reservation_id::text',
    ]) expect(sql).toContain(needle);
  });

  it('requires a service-only, evidence-backed resolution for retention-expired checkouts', () => {
    expect(sql).toContain('resolve_dues_checkout_attention');
    expect(sql).toContain("p_outcome <> 'provider_confirmed_unpaid'");
    expect(sql).toContain("'operator_confirmed_unpaid'");
    expect(sql).toContain("'dues_checkout_attention_resolved'");
    expect(sql).toContain("extensions.digest(p_evidence_reference::bytea, 'sha256')");
  });

  it('never lets a disconnect claim steal a live ordinary reconciliation lease', () => {
    // Pinned on the body Postgres keeps (latestFnBody reads comment-stripped
    // SQL in apply order), not on the superseded 20260831170400 definition. A
    // later redefinition must fail here so the pin is re-reviewed against it.
    const claim = latestFnBody(CLAIM_FN);
    expect(claim, `a migration after ${LIVE_CLAIM_MIGRATION} redeclared ${CLAIM_FN}`)
      .toBe(fnBody(stripComments(loadMigrationSql(LIVE_CLAIM_MIGRATION)), CLAIM_FN));

    const releaseAt = claim.indexOf('update public.dues_checkout_reservations');
    const candidatesAt = claim.indexOf('with candidates as');
    const leasedAt = claim.indexOf('), leased as');
    expect(releaseAt).toBeGreaterThan(-1);
    expect(candidatesAt).toBeGreaterThan(releaseAt);
    expect(leasedAt).toBeGreaterThan(candidatesAt);

    // Both the exhausted-attempt release and the candidate selection skip a
    // reservation whose lease is still active, on the ordinary and the
    // disconnect path alike.
    const release = compactSql(claim.slice(releaseAt, candidatesAt));
    const selection = compactSql(claim.slice(candidatesAt, leasedAt));
    for (const statement of [release, selection]) {
      expect(statement).toContain(LEASE_ELIGIBILITY);
      expect(statement).toContain("(p_disconnect and connection.state = 'disconnecting')");
      expect(statement).toContain("(not p_disconnect and connection.state = 'ready')");
    }
    expect(compactSql(claim).split(LEASE_ELIGIBILITY)).toHaveLength(3);
    expect(claim).not.toContain("and (\n        p_disconnect\n        or");
  });

  it('keeps paid and waived standings distinct in both bounded read models', () => {
    expect(sql).toContain("when issued_cents - settled_cents <= 0 and waived_cents > 0 and paid_cents = 0 then 'waived'");
    expect(sql).toContain("'collectedCents', coalesce((select sum(paid_cents)");
  });
});
