import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260831110200_mi1_dues_stripe_provider.sql");
// Every pin below that claims the migration DOES something has to read
// executable SQL. The OAuth recovery pin used to match a sentence that lives
// only in a line comment, so deleting the durable-claim statements left it
// green; `live` is the comment-stripped text those pins run against instead.
const live = stripComments(sql);
const compact = (text) => stripComments(text).replace(/\s+/g, " ");
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));

describe("Dues Stripe provider migration", () => {
  it("keeps provider connection state separate from secrets and guards every checkout with a reservation", () => {
    expect(sql).toContain("create table public.dues_provider_connections");
    expect(sql).toContain("create table public.dues_checkout_reservations");
    expect(sql).toContain("dues_one_active_checkout_per_obligation");
    expect(sql).toContain("stripe_idempotency_replay_until");
    expect(sql).toContain("reconcile_lease_epoch");
    expect(sql).toContain("create_dues_checkout_reservation");
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });

  it("uses exact financial-hat and service-only boundaries", () => {
    expect(sql).toContain("private.dues_require_financial_hat(p_selected_hat)");
    expect(sql).toContain("private.dues_financial_identity_selections");
    expect(sql).toContain("public.save_dues_stripe_oauth_state");
    expect(sql).toContain("grant execute on function public.save_dues_stripe_oauth_state");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("revoke all on public.dues_provider_connections");
  });

  it("keeps Connect OAuth exchange recovery durable and non-replayable", () => {
    for (const needle of [
      "exchange_started_at", "exchange_account_id", "recovery_required_at",
      "record_dues_stripe_oauth_exchange", "finalize_dues_stripe_oauth_state",
      "resolve_dues_stripe_oauth_recovery", "oauth_exchange_recovery_required",
      "service role required",
    ]) expect(live).toContain(needle);
    expect(live).toContain("set state = 'unset', last_error_class = 'oauth_exchange_authorization_revoked'");

    // The durable claim itself, scoped to the function that owns it: the row is
    // locked, a second claim on an in-flight exchange records recovery instead
    // of re-spending the non-idempotent OAuth code, and the state is consumed
    // only on the finalize path. Deleting any of these statements fails here.
    const claim = compact(fnBody(sql, "public.consume_dues_stripe_oauth_state"));
    expect(claim).toContain("and (expires_at > now() or exchange_account_id is not null) for update");
    expect(claim).toContain(
      "update private.dues_stripe_oauth_states set recovery_required_at = coalesce(recovery_required_at, now())",
    );
    expect(claim).toContain("last_error_class = 'oauth_exchange_recovery_required'");
    expect(claim).not.toContain("consumed_at = now()");
    expect(compact(fnBody(sql, "public.finalize_dues_stripe_oauth_state"))).toContain(
      "update private.dues_stripe_oauth_states set consumed_at = now() where state_hash = saved.state_hash",
    );

    // The retired needle: prose in a line comment, which the pin above used to
    // accept as proof of the behavior.
    expect(live).not.toContain("OAuth code is non-idempotent");
  });

  it("tracks the durable OAuth claim RPC as service-only current state", () => {
    const signature = "public.consume_dues_stripe_oauth_state(p_state_hash text, p_browser_binding_hash text)";
    expect(contract.functions).toContainEqual(expect.objectContaining({
      sig: signature,
      secdef: true,
      exec: "service_role",
    }));
    expect(contract.functionsAbsent).not.toContainEqual(expect.objectContaining({
      sig: "public.consume_dues_stripe_oauth_state(text, text)",
    }));
  });
});
