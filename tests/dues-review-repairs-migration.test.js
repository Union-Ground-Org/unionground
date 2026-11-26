import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const path = "supabase/migrations/20260831211500_mi1_dues_review_repairs.sql";
const sql = readFileSync(path, "utf8");
const mutationSql = readFileSync("supabase/migrations/20260831110100_mi1_dues_ledger_mutations.sql", "utf8");
const providerSql = readFileSync("supabase/migrations/20260831110200_mi1_dues_stripe_provider.sql", "utf8");

describe("Dues review repair migration", () => {
  it("removes authenticated self-selection and provisions only one exact organization context", () => {
    expect(sql).toContain("drop function if exists public.set_my_dues_financial_identity(text)");
    expect(sql).toContain("p_organization_id uuid");
    expect(sql).toContain("private.refresh_dues_financial_identity_for_context");
    expect(sql).toContain("refresh_dues_financial_identity_on_role_grant");
    expect(sql).toContain("membership.organization_id = p_organization_id");
    expect(sql).not.toContain("grant execute on function public.set_my_dues_financial_identity");
  });

  it("persists and reconciles Stripe OAuth callback state without retaining credentials", () => {
    for (const needle of [
      "callback_state", "callback_lease_epoch", "exchanged_account_id",
      "claim_dues_stripe_oauth_callback", "record_dues_stripe_oauth_exchange",
      "defer_dues_stripe_oauth_callback", "complete_dues_stripe_oauth_callback",
      "claim_dues_stripe_oauth_reconciliations",
    ]) expect(sql).toContain(needle);
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });

  it("binds paid settlement to the exact account, amount, currency, session, and both reservation references", () => {
    for (const needle of [
      "p_payment_status text", "p_amount_total integer", "p_currency text",
      "p_connected_account_id text", "p_client_reference_id uuid",
      "p_metadata_reservation_id uuid", "reservation.connected_account_id",
      "reservation.reserved_cents", "reservation.checkout_currency",
    ]) expect(sql).toContain(needle);
    expect(sql).toContain("p_payment_status <> 'paid'");
  });

  it("paces disconnect claims, quarantines exhaustion, and exposes an audited operator recovery path", () => {
    expect(sql).toContain("reservation.reconcile_after <= now()");
    expect(sql).toContain("reconcile_attempts_exhausted");
    expect(sql).toContain("resolve_dues_checkout_attention");
    expect(sql).toContain("private.dues_checkout_recovery_audit");
    expect(sql).toContain("provider-search-no-session");
  });

  it("returns last-visible cursors and authoritative member totals", () => {
    expect(sql).toContain("select id from visible order by id desc limit 1");
    expect(sql).toContain("'authoritative', pg_catalog.jsonb_build_object(");
    expect(sql).toContain("'nextDueOn'");
  });

  it("rejects idempotency-key reuse when any canonical mutation input changes", () => {
    const idempotencySql = `${mutationSql}\n${providerSql}`;
    for (const needle of [
      "existing.effective_on <> p_paid_on", "existing.payment_method <> p_payment_method",
      "existing.reason <> pg_catalog.btrim(p_reason)",
      "existing.external_reference is distinct from",
      "existing.effective_on <> current_date", "attempt.obligation_id <> p_obligation_id",
      "attempt.channel <> p_channel", "existing.obligation_id <> p_obligation_id",
    ]) expect(idempotencySql).toContain(needle);
  });

  it("uses the schema-qualified normalizer's NFC default without an unresolved token", () => {
    const assessmentSql = `${readFileSync("supabase/migrations/20260831110000_mi1_dues_ledger_foundation.sql", "utf8")}\n${mutationSql}`;
    expect(assessmentSql).toContain("pg_catalog.normalize(p_title)");
    expect(assessmentSql).not.toContain("pg_catalog.normalize(p_title, NFC)");
    expect(assessmentSql).not.toContain("pg_catalog.normalize(coalesce(p_description, ''), NFC)");
  });

  it("keeps the receipt-year local distinct from the conflict-target column", () => {
    expect(mutationSql).toContain("effective_year integer := extract(year from p_effective_on)");
    expect(mutationSql).toContain("values (p_organization_id, effective_year, 2)");
    expect(mutationSql).not.toContain("receipt_year integer :=");
  });

  it("registers Dues with the preference-aware notification delivery spine", () => {
    expect(sql).toContain("'appointments', 'workload', 'dues'");
    expect(sql).toContain("pref_value := prefs -> new.kind");
    expect(sql).toContain("insert into public.member_notification_deliveries");
    expect(sql).toContain("insert into public.member_notifications (user_id, title, body, kind)");
    expect(sql).toContain("p_outbound_delivery_key is not null");
  });

  it("allows every Dues audit event and its bounded metadata before runtime", () => {
    for (const event of [
      "dues_assessment_issued", "dues_manual_payment_recorded",
      "dues_credit_event_applied", "dues_reminder_queued",
      "dues_financial_identity_provisioned", "dues_stripe_connected",
      "dues_stripe_oauth_deferred", "dues_stripe_oauth_failed",
      "dues_checkout_attention_resolved",
    ]) expect(sql).toContain(`'${event}'`);
    for (const key of [
      "eligibleCount", "amountCents", "obligationId", "receiptNumber",
      "eventKind", "attemptId", "selectedHat", "requestedBy",
      "reservationId", "evidenceReference", "failureClass",
    ]) expect(sql).toContain(`'${key}'`);
  });
});
