// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260917131000_mi1_dues_oauth_recovery_row_shape";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const previousEventSql = loadMigrationSql("20260901200000_deployed_dues_event_assurance_repair");
const wrapperSql = loadMigrationSql("20260907151000_account_deletion_finalization_reconciliation");

function eventTypes(source) {
  const definitions = [...source.matchAll(
    /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
  )];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("Dues OAuth recovery row-shape migration", () => {
  it("runs as one forward-only transaction after the installation wrapper", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260907151000_account_deletion_finalization_reconciliation").toBe(true);
    expect(NAME).not.toBe("20260917140000_mi1_dues_oauth_callback_audit_metadata");
  });

  it("pins the 20260907151000 wrap-time source hash before replacing the wrapped body", () => {
    expect(sql).toContain("748ebf5fc1caf686571c046a86ea0539a961d44e1472a3acacc7f4dd771befe3");
    expect(sql).toContain("b0b4bfd327e31353bc4126f8cc31b9a813b88c4890bdbaf7406deb3d3297ccb1");
    expect(wrapperSql).toContain(
      "('public.get_pending_dues_stripe_oauth_exchange(uuid,uuid,text)', '748ebf5fc1caf686571c046a86ea0539a961d44e1472a3acacc7f4dd771befe3')",
    );
  });

  it("keeps the installation lock wrapper as the first statement of the replaced body", () => {
    const fns = parseFunctions(sql, `${NAME}.sql`);
    const fn = fns.find((entry) => entry.name === "public.get_pending_dues_stripe_oauth_exchange");
    expect(fn).toBeTruthy();
    expect(fn.source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
    expect(fn.sourceSha256).toBe("3a343c15230e0532835ea1ab71e8ba2e5a3a4ceeb86bfd7802b20f08c300bffa");
    expect(sql).toContain("3a343c15230e0532835ea1ab71e8ba2e5a3a4ceeb86bfd7802b20f08c300bffa");
  });

  it("writes a recovery row that satisfies both oauth-state checks", () => {
    for (const needle of [
      "exchanged_account_id = coalesce(state.exchanged_account_id, state.exchange_account_id)",
      "recovery_required_at = coalesce(state.recovery_required_at, now())",
      "exchange_account_id = null",
      "exchange_recorded_at = null",
      "callback_state = 'attention_required'",
    ]) {
      expect(sql).toContain(needle);
      expect([...sql.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))]).toHaveLength(2);
    }
    expect(sql).not.toMatch(/set recovery_required_at = coalesce\(state\.recovery_required_at, now\(\)\)\s*$/m);
  });

  it("admits the documented recovery event type without rewriting metadata keys", () => {
    expect(sql).toContain("drop constraint organization_audit_events_event_type_check");
    expect(sql).not.toContain("drop constraint organization_audit_events_metadata_keys");
    expect(sql).not.toContain("organization_audit_events_metadata_keys check");
    const before = eventTypes(previousEventSql);
    const after = eventTypes(sql);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(before.length)).toEqual(["dues_stripe_oauth_recovery_required"]);
    expect(new Set(after).size).toBe(after.length);
  });

  it("does not retain provider credentials", () => {
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });
});

describe("Dues OAuth recovery row-shape hash derivation", () => {
  it("re-derives the live source digest from the replaced body", () => {
    const fns = parseFunctions(sql, `${NAME}.sql`);
    const fn = fns.find((entry) => entry.name === "public.get_pending_dues_stripe_oauth_exchange");
    expect(createHash("sha256").update(fn.source).digest("hex")).toBe(fn.sourceSha256);
  });
});
