// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260919012000_mi1_dues_oauth_recovery_account_check";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const originalSql = loadMigrationSql("20260831223000_mi1_dues_exact_head_repairs");
const sixArgSql = loadMigrationSql("20260831211500_mi1_dues_review_repairs");

const CLEARED_PAIR = [
  "exchange_account_id = null",
  "exchange_recorded_at = null",
];

function replacedBody(source, file = `${NAME}.sql`) {
  const fn = parseFunctions(source, file)
    .find((entry) => entry.name === "public.record_dues_stripe_oauth_recovery_account");
  expect(fn).toBeTruthy();
  return fn;
}

describe("Dues OAuth recovery-account check-constraint migration", () => {
  it("runs as one forward-only transaction after the body it supersedes", () => {
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260918080000_mi1_dues_oauth_recovery_lease_release").toBe(true);
  });

  it("admits only the reviewed 20260907151000-wrapped 20260831223000 body as its predecessor", () => {
    expect(sql).toContain(
      "if digest is distinct from '9d891c4ed2e2c858a394c72cad08c1d39bfed55eb3647d185a5e2361d3309b7b' then",
    );
    const original = replacedBody(originalSql, "20260831223000.sql");
    expect(original.sourceSha256)
      .toBe("6b857057f0e863f67616c3d7ebbc1e67b4ffadc58e8dbc7a7e75532da509c345");
    const rtrimmed = original.source.replace(/[\n\r\t ]+$/, "");
    const wrapped = `\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n${rtrimmed}\nend;\n`;
    expect(createHash("sha256").update(wrapped).digest("hex"))
      .toBe("9d891c4ed2e2c858a394c72cad08c1d39bfed55eb3647d185a5e2361d3309b7b");
  });

  it("keeps the installation lock wrapper as the first statement of the replaced body", () => {
    expect(replacedBody(sql).source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("clears the constrained legacy pair in the same UPDATE that stamps recovery_required_at", () => {
    const source = stripComments(replacedBody(sql).source);
    expect(source).toContain("recovery_required_at = coalesce(recovery_required_at, now())");
    for (const needle of CLEARED_PAIR) expect(source).toContain(needle);
    // The original writer, which this repair does not edit, still lacks the pair.
    const original = stripComments(replacedBody(originalSql, "20260831223000.sql").source);
    for (const needle of CLEARED_PAIR) expect(original).not.toContain(needle);
  });

  it("re-derives the live source digest from the replaced body and pins it", () => {
    const fn = replacedBody(sql);
    expect(createHash("sha256").update(fn.source).digest("hex")).toBe(fn.sourceSha256);
    expect(fn.sourceSha256).toBe("44ba23ee48aa62bc48b6f8ba1f8bbaf17cea5edd86f4aafb410658541b88ade9");
    expect(sql).toContain(
      "if digest is distinct from '44ba23ee48aa62bc48b6f8ba1f8bbaf17cea5edd86f4aafb410658541b88ade9' then",
    );
  });

  it("leaves the 6-arg live callback exchange writer unchanged", () => {
    expect(parseFunctions(sql, `${NAME}.sql`).map((entry) => entry.name))
      .toEqual(["public.record_dues_stripe_oauth_recovery_account"]);
    const sixArg = parseFunctions(sixArgSql, "20260831211500.sql")
      .find((entry) => entry.name === "public.record_dues_stripe_oauth_exchange" && entry.arity === 6);
    expect(sixArg).toBeTruthy();
    expect(stripComments(sixArg.source)).toContain("exchanged_account_id = p_account_id");
    expect(stripComments(sixArg.source)).not.toContain("exchange_account_id = p_account_id");
    expect(sql).not.toContain("public.record_dues_stripe_oauth_exchange");
  });

  it("changes nothing but that one function", () => {
    expect(code).not.toMatch(/\balter table\b/i);
    expect(code).not.toMatch(/\bcreate (?:table|policy|index|trigger)\b/i);
    expect(code).not.toMatch(/\bdrop constraint\b/i);
    expect(sql).not.toMatch(/stripe_(?:secret|access|refresh)_token/i);
  });
});
