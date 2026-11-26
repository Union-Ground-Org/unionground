// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260918080000_mi1_dues_oauth_recovery_lease_release";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
// The canonical writer of this same documented recovery state.
const canonicalSql = loadMigrationSql("20260831223000_mi1_dues_exact_head_repairs");
// The predecessor this repair supersedes; its bytes must not move.
const predecessorSql = loadMigrationSql("20260917131000_mi1_dues_oauth_recovery_row_shape");

const RECOVERY_COLUMNS = [
  "last_error_class = 'oauth_exchange_recovery_required'",
  "callback_lease_owner = null",
  "callback_lease_expires_at = null",
  "reconcile_after = now()",
];

function replacedBody(source) {
  const fn = parseFunctions(source, `${NAME}.sql`)
    .find((entry) => entry.name === "public.get_pending_dues_stripe_oauth_exchange");
  expect(fn).toBeTruthy();
  return fn;
}

describe("Dues OAuth recovery lease-release migration", () => {
  it("runs as one forward-only transaction after the body it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260917131000_mi1_dues_oauth_recovery_row_shape").toBe(true);
  });

  it("admits only the reviewed 20260917131000 body as its predecessor", () => {
    expect(sql).toContain(
      "if digest is distinct from '3a343c15230e0532835ea1ab71e8ba2e5a3a4ceeb86bfd7802b20f08c300bffa' then",
    );
    // That digest is exactly what 20260917131000 leaves installed, and this
    // repair does not edit that file to get there.
    expect(replacedBody(predecessorSql).sourceSha256)
      .toBe("3a343c15230e0532835ea1ab71e8ba2e5a3a4ceeb86bfd7802b20f08c300bffa");
  });

  it("keeps the installation lock wrapper as the first statement of the replaced body", () => {
    expect(replacedBody(sql).source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("writes the canonical recovery row in both quarantine branches", () => {
    for (const needle of [
      "exchanged_account_id = coalesce(state.exchanged_account_id, state.exchange_account_id)",
      "recovery_required_at = coalesce(state.recovery_required_at, now())",
      "exchange_account_id = null",
      "exchange_recorded_at = null",
      "callback_state = 'attention_required'",
      ...RECOVERY_COLUMNS,
    ]) {
      expect([...code.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))]).toHaveLength(2);
    }
  });

  it("matches public.record_dues_stripe_oauth_recovery_account field for field", () => {
    const canonical = parseFunctions(canonicalSql, "20260831223000.sql")
      .find((entry) => entry.name === "public.record_dues_stripe_oauth_recovery_account");
    expect(canonical).toBeTruthy();
    for (const needle of RECOVERY_COLUMNS) expect(stripComments(canonical.source)).toContain(needle);
  });

  it("re-derives the live source digest from the replaced body and pins it", () => {
    const fn = replacedBody(sql);
    expect(createHash("sha256").update(fn.source).digest("hex")).toBe(fn.sourceSha256);
    expect(fn.sourceSha256).toBe("7caa2b9f9eaf09432f9bb239785438a9e741edce042121447cbbc120bfbb21bd");
    expect(sql).toContain(
      "if digest is distinct from '7caa2b9f9eaf09432f9bb239785438a9e741edce042121447cbbc120bfbb21bd' then",
    );
  });

  it("changes nothing but that one function", () => {
    expect(code).not.toMatch(/\balter table\b/i);
    expect(code).not.toMatch(/\bcreate (?:table|policy|index|trigger)\b/i);
    expect(code).not.toMatch(/\bdrop constraint\b/i);
    expect(code).not.toMatch(/organization_audit_events/);
    expect(parseFunctions(sql, `${NAME}.sql`).map((entry) => entry.name))
      .toEqual(["public.get_pending_dues_stripe_oauth_exchange"]);
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });
});
