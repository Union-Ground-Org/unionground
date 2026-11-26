// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: private.form_template_label(text) and
// private.form_required_keys(text), both DROPPED by 20260724193000_tech_debt_
// indexes_and_cleanup -- the pins on them were removed rather than left to pass
// forever against a function that no longer exists.

const sql = loadMigrationSql("form_templates_lookup_rewrite");
const body = (signature) => fnBody(sql, signature);

describe("registry-backed lookup helpers", () => {
  // Trimmed to form_points: this migration also rewrote form_template_label(text)
  // and form_required_keys(text), but 20260724193000_tech_debt_indexes_and_cleanup
  // DROPPED both, so pinning their bodies here asserts a function that no longer
  // exists — permanently green, never red. Their absence is contracted in
  // scripts/db-contract.json (functionsAbsent) and checked against the live
  // catalog by `npm run verify:db`.
  it("rewrites the surviving 1-arg helper to a table read with the signature preserved", () => {
    for (const fn of ["form_points(p_template_key text)"]) {
      const def = body(`create or replace function private.${fn}`);
      expect(def, `${fn} must read the registry`).toContain("from public.form_templates");
      expect(def, `${fn} must not keep the hardcoded CASE`).not.toContain("case p_template_key");
      expect(def).toContain("stable");
      expect(def).toContain("set search_path = ''");
    }
  });

  it("unversioned reads resolve the current (max) version", () => {
    const points = body("create or replace function private.form_points(p_template_key text)");
    expect(points).toContain("order by version desc limit 1");
  });

  it("adds the version-pinned overload and the localized label helper", () => {
    const pinned = body("create function private.form_required_keys(p_template_key text, p_version integer)");
    expect(pinned).toContain("version = p_version");
    expect(pinned).toContain("stable");
    expect(pinned).toContain("set search_path = ''");

    const localized = body("create function private.form_template_label_localized(p_template_key text, p_lang text)");
    expect(localized).toContain("when p_lang = 'es' then label_es else label_en");
    expect(localized).toContain("stable");
    expect(localized).toContain("set search_path = ''");

    // Version-pinned localized label: notifications name the template exactly
    // as the member's pinned form renders it, falling back to current-version.
    const pinnedLabel = body("create function private.form_template_label_localized(p_template_key text, p_version integer, p_lang text)");
    expect(pinnedLabel).toContain("version = p_version");
    expect(pinnedLabel).toContain("private.form_template_label_localized(p_template_key, p_lang)");
    expect(pinnedLabel).toContain("stable");
    expect(pinnedLabel).toContain("set search_path = ''");
  });

  it("keeps the unknown-key fallback (points default 15)", () => {
    expect(body("create or replace function private.form_points(p_template_key text)")).toContain("15)");
  });

  it("revokes every private helper that still exists from client roles", () => {
    // The 1-arg label and required-keys helpers this migration also revoked are
    // gone (20260724193000_tech_debt_indexes_and_cleanup); a revoke pin on a
    // dropped signature proves nothing.
    for (const sig of [
      "private.form_points(text)",
      "private.form_required_keys(text, integer)",
      "private.form_template_label_localized(text, text)",
      "private.form_template_label_localized(text, integer, text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated`);
    }
  });
});
