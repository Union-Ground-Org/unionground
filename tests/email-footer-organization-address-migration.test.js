// BUG-UG-LOCAL-PROFILE-IS-READ-BY-NOTHING-AND-EVERY-UNION-SHARES-ONE-FOOTER-ADDRESS-20261122
// (#9507): the migration that has the notification claim and the engagement
// payload return the sending organization's own office address. It restates
// both functions from their installed definitions with one added key each and
// nothing else, behind exact predecessor pins, and grants nothing. The live
// behaviour is proven in email-footer-organization-address-db.test.js.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = "supabase/migrations";
const NAME = readdirSync(DIR).find((file) => file.endsWith("_email_footer_organization_postal_address.sql"));
const sql = readFileSync(`${DIR}/${NAME}`, "utf8");

function definition(text, signature) {
  const start = text.search(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${signature}`, "i"));
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("$function$;", text.indexOf("$function$", start) + "$function$".length);
  return text.slice(start, end + "$function$;".length);
}

// The lines this migration adds to a definition: the postalAddress key and its comments.
function withoutAddedLines(text) {
  return text
    .replace(/\n {4}-- #9507:[^\n]*\n {4}-- [^\n]*\n {4}'postalAddress', case when p_channel = 'email' then \(\n {6}select lp\.office_address from private\.organization_local_profiles lp\n {6}where lp\.organization_id = n\.organization_id\) end,/, "")
    .replace(/'unsubscribeToken', unsubscribe_token,\n {4}-- #9507:[^\n]*\n {4}-- [^\n]*\n {4}'postalAddress', \(select lp\.office_address from private\.organization_local_profiles lp\n {6}where lp\.organization_id = row\.organization_id\)\n/, "'unsubscribeToken', unsubscribe_token\n");
}

describe("email footer organization address migration (#9507)", () => {
  it("is one migration, stamped after the definitions it replaces", () => {
    expect(readdirSync(DIR).filter((file) => file.endsWith("_email_footer_organization_postal_address.sql"))).toHaveLength(1);
    expect(NAME > "20261118200500").toBe(true);
  });

  it("refuses to run unless both functions are exactly the reviewed installed bodies", () => {
    expect(sql).toContain("pg_catalog.md5(pg_catalog.pg_get_functiondef('public.claim_notification_deliveries(text, integer)'::regprocedure)) <> 'a1fef4bf19da1c9e846d70d39526bfa0'");
    expect(sql).toContain("pg_catalog.md5(pg_catalog.pg_get_functiondef('public.get_engagement_delivery_payload(uuid, uuid)'::regprocedure)) <> '53cb510a994d1835f61b440ad5dd46a3'");
    expect(sql.match(/using errcode = '55000'/g)).toHaveLength(3);
    expect(sql).toMatch(/^begin;$/m);
    expect(sql).toMatch(/^commit;$/m);
    expect(sql).toContain("set local search_path = pg_catalog;");
  });

  it("adds only the postalAddress key to the claim, for email rows", () => {
    const next = definition(sql, "claim_notification_deliveries");
    const previous = definition(readFileSync(`${DIR}/20261118200500_peer_message_notification.sql`, "utf8"), "claim_notification_deliveries");
    expect(next).toContain("'postalAddress', case when p_channel = 'email' then (");
    expect(withoutAddedLines(next)).toBe(previous);
  });

  it("adds only the postalAddress key to the engagement payload", () => {
    const next = definition(sql, "get_engagement_delivery_payload");
    const previous = definition(readFileSync(`${DIR}/20261102005607_unit_committee_scoped_access.sql`, "utf8"), "get_engagement_delivery_payload");
    expect(next).toContain("'postalAddress', (select lp.office_address from private.organization_local_profiles lp");
    expect(withoutAddedLines(next)).toBe(previous);
  });

  it("grants and revokes nothing and keeps any account-lifecycle receipt current", () => {
    expect(sql).not.toMatch(/^\s*(grant|revoke)\b/im);
    expect(sql).toContain("update private.account_lifecycle_trigger_review reviewed");
  });
});
