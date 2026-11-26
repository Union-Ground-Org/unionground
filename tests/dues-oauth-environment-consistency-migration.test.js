// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260925620300_mi1_dues_oauth_environment_consistency";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const predecessorSql = loadMigrationSql("20260831211500_mi1_dues_review_repairs");
const contract = JSON.parse(readFileSync("scripts/db-contract.json", "utf8"));
const SIGNATURE = "public.complete_dues_stripe_oauth_callback(p_state_hash text, p_lease_epoch integer, p_lease_owner uuid, p_organization_id uuid, p_requested_by uuid, p_account_id text, p_account_label text, p_charges_enabled boolean, p_payouts_enabled boolean)";

function replacedBody(source, file = `${NAME}.sql`) {
  const fn = parseFunctions(source, file)
    .find((entry) => entry.name === "public.complete_dues_stripe_oauth_callback");
  expect(fn).toBeTruthy();
  return fn;
}

describe("Dues Stripe OAuth environment consistency migration", () => {
  it("runs as one forward-only transaction after the body it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260831211500_mi1_dues_review_repairs").toBe(true);
    expect(NAME > "20260907151000_account_deletion_finalization_reconciliation").toBe(true);
  });

  it("admits only the reviewed 20260907151000 wrap of the 20260831211500 body as its predecessor", () => {
    // The wrap installs `begin perform private.lock_case_graph(...)` around the
    // inner source 20260907151000 pins, so the live digest is the digest of the
    // wrapped text, not of the migration's own function body.
    const inner = replacedBody(predecessorSql, "20260831211500.sql");
    expect(inner.sourceSha256).toBe("862a05384bd58760ac97692336e53b634479a8d4bd742e9b5e77219e72dcc0b1");
    expect(loadMigrationSql("20260907151000_account_deletion_finalization_reconciliation"))
      .toContain(inner.sourceSha256);
    const wrapped = `\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n${inner.source.replace(/[\n\r\t ]+$/, "")}\nend;\n`;
    expect(createHash("sha256").update(wrapped).digest("hex"))
      .toBe("d807a6fe1262f1cdf3f668c7020f462ea7239d79a0572d8279c998a525405013");
    expect(sql).toContain(
      "if digest is distinct from 'd807a6fe1262f1cdf3f668c7020f462ea7239d79a0572d8279c998a525405013' then",
    );
  });

  it("keeps the installation lock wrapper as the first statement of the replaced body", () => {
    expect(replacedBody(sql).source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("requires the exchanged environment to match the approved callback surface before ready", () => {
    const source = stripComments(replacedBody(sql).source);
    // The two redirect_uri values public.save_dues_stripe_oauth_state admits,
    // each mapped to the one Stripe environment its surface is served by.
    expect(source).toContain("when 'https://app.example.invalid/api/dues-stripe-connect' then true");
    expect(source).toContain("when 'https://demo.example.com/api/dues-stripe-connect' then false");
    // An unmapped redirect_uri has no approved environment and is refused too.
    expect(source).toContain("if approved_livemode is null");
    expect(source).toContain("coalesce(saved.exchanged_livemode, false) is distinct from approved_livemode");
    expect(source).toContain("raise exception 'dues Stripe callback environment mismatch' using errcode = '22023'");
    // The guard precedes the only write that makes a connection ready.
    expect(source.indexOf("approved_livemode is null"))
      .toBeLessThan(source.indexOf("insert into public.dues_provider_connections"));
    // Main never read the retained indicator.
    expect(stripComments(replacedBody(predecessorSql, "20260831211500.sql").source))
      .not.toContain("exchanged_livemode");
  });

  it("keeps every guard and write the reviewed body already had", () => {
    const source = stripComments(replacedBody(sql).source);
    for (const needle of [
      "auth.jwt() ->> 'role'", "p_account_id !~ '^[A-Za-z0-9_:-]{3,255}$'",
      "saved.callback_state not in ('processing', 'exchanged')",
      "saved.callback_lease_epoch <> p_lease_epoch",
      "saved.callback_lease_owner is distinct from p_lease_owner",
      "saved.organization_id <> p_organization_id",
      "saved.requested_by <> p_requested_by",
      "saved.exchanged_account_id is distinct from p_account_id",
      "raise exception 'dues Stripe callback lease stale' using errcode = '42501'",
      "callback_state = 'completed'", "'dues_stripe_connected'",
      "jsonb_build_object('state', 'ready')",
    ]) expect(source).toContain(needle);
  });

  it("re-derives the live source digest from the replaced body and pins it", () => {
    const fn = replacedBody(sql);
    expect(createHash("sha256").update(fn.source).digest("hex")).toBe(fn.sourceSha256);
    expect(fn.sourceSha256).toBe("f9994bb747af6f595d3cf52982bda47f109446d2263617cba43cd355956b761e");
    expect(sql).toContain(
      "if digest is distinct from 'f9994bb747af6f595d3cf52982bda47f109446d2263617cba43cd355956b761e' then",
    );
  });

  it("keeps the completion function service-only and describes the new refusal in the contract", () => {
    expect(code).toContain("from public, anon, authenticated");
    expect(code).toContain("to service_role");
    const entry = contract.functions.find((item) => item.sig === SIGNATURE);
    expect(entry).toMatchObject({ secdef: true, exec: "service_role" });
    expect(entry.bodyContains).toContain("approved_livemode");
    expect(entry.bodyContains).toContain("dues Stripe callback environment mismatch");
  });

  it("changes nothing but that one function", () => {
    expect(code).not.toMatch(/\balter table\b/i);
    expect(code).not.toMatch(/\bcreate (?:table|policy|index|trigger)\b/i);
    expect(code).not.toMatch(/\bdrop constraint\b/i);
    expect(parseFunctions(sql, `${NAME}.sql`).map((entry) => entry.name))
      .toEqual(["public.complete_dues_stripe_oauth_callback"]);
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });
});
