// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./helpers/migration.js";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const compact = (source) => stripComments(source).replace(/\s+/g, " ").toLowerCase();

const identity = read("supabase/migrations/20260821010000_mobile_multichapter_identity.sql");
const repair = compact(read("supabase/migrations/20260821014000_mobile_authorization_repair.sql"));
const contract = JSON.parse(read("scripts/db-contract.json"));

describe("mobile workflow authorization repair", () => {
  it("makes the private RLS predicate executable only by authenticated callers", () => {
    expect(repair).toContain(
      "revoke all on function private.member_has_chapter_role(text, text[]) from public, anon, authenticated, service_role",
    );
    expect(repair).toContain(
      "grant execute on function private.member_has_chapter_role(text, text[]) to authenticated",
    );
    expect(repair).not.toMatch(/grant execute on function private\.member_has_chapter_role\(text, text\[\]\) to (?:public|anon|service_role)/);

    const helper = contract.functions.find((entry) => (
      entry.sig === "private.member_has_chapter_role(p_chapter_id text, p_roles text[])"
    ));
    expect(helper?.exec).toBe("authenticated");
  });

  it("accepts every audit action emitted by the membership RPCs", () => {
    const emittedActions = [...identity.matchAll(
      /values \(caller, '(grant_chapter_membership|revoke_chapter_membership)'/g,
    )].map((match) => match[1]);
    expect(new Set(emittedActions)).toEqual(new Set([
      "grant_chapter_membership",
      "revoke_chapter_membership",
    ]));

    const auditConstraint = contract.constraints.find((entry) => (
      entry.table === "member_admin_audit" && entry.name === "member_admin_audit_action_check"
    ));
    for (const action of emittedActions) {
      expect(repair).toContain(`'${action}'`);
      expect(auditConstraint?.defContains).toContain(`'${action}'`);
    }
  });

  it("preserves the settled closed audit vocabulary", () => {
    const auditConstraint = contract.constraints.find((entry) => (
      entry.table === "member_admin_audit" && entry.name === "member_admin_audit_action_check"
    ));
    expect(auditConstraint?.defContains).toHaveLength(27);
    for (const action of auditConstraint?.defContains ?? []) {
      expect(repair).toContain(action);
    }
  });
});
