// @vitest-environment node
// BUG-UG-WEB-VERIFY-RECEIPT-SAMPLE-WRONG-FORMAT-20261003: the /verify
// help text showed "K7TQ2MRX", a shape verify_ballot_receipt always rejects, so
// a member who copied the example's format was always told Not found.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { t } from "../src/lib/i18n.js";

const MIGRATION = readFileSync(new URL("../supabase/migrations/20260721223851_member_rewards_and_ballot_receipts.sql", import.meta.url), "utf8");
// The format check verify_ballot_receipt applies before it looks anything up.
const serverPattern = MIGRATION.match(/if clean_code !~ '([^']+)' then/)?.[1];

describe("verify receipt copy", () => {
  it("reads the server's receipt format check", () => {
    expect(serverPattern).toBe("^SG-[0-9A-HJ-KM-NP-TV-Z]{4}-[0-9A-HJ-KM-NP-TV-Z]{4}$");
  });

  it.each(["en", "es"])("shows a sample code the server's format check accepts (%s)", (lang) => {
    const sample = t(lang, "vrx.codeSample");
    expect(sample).toMatch(new RegExp(serverPattern));
    // Same shape as the field's placeholder.
    expect(sample.replace(/[0-9A-Z]/g, "X").replace(/^XX-/, "SG-")).toBe(t(lang, "verify.codePlaceholder"));
  });
});
