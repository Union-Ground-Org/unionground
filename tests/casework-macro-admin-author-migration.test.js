// @vitest-environment node
//
// BUG-UG-CASEWORK-MACRO-ACTIONS-REJECT-ADMIN-AUTHORS-20260921
//
// casework_apply_macro admits the organization admin/VP hats (the only hats
// that may author an organization-wide macro), but its add_note and assign
// delegates asked for the coordinator hat, so an author was refused part-way
// through their own batch. Both hats are now settled before any write. These pins read the LAST definition in apply order;
// tests/case-macro-admin-author-db.test.js proves the behaviour live.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const REPAIR = "20260925260000_casework_macro_admin_author_actions";
const PREDECESSOR = "20260917144000_casework_macros_case_note_mentions";
const SIGNATURE = "public.casework_apply_macro(";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// prosrc as Postgres stores it: the text between the body's dollar quotes.
function storedSource(sql) {
  const at = sql.indexOf(`function ${SIGNATURE}`);
  const opens = sql.indexOf("as $function$", at) + "as $function$".length;
  return sql.slice(opens, sql.indexOf("$function$;", opens));
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

describe("casework macro admin/VP authors (static)", () => {
  it("checks both newest predecessor source hashes before replacing either macro", () => {
    const repairName = findMigrationName("casework_macro_refusals_hide_foreign_scopes");
    const sql = loadMigrationSql(repairName);
    const guardStart = sql.indexOf("do $predecessors$");
    const guardEnd = sql.indexOf("$predecessors$;", guardStart);
    expect(guardStart).toBeGreaterThan(sql.indexOf("set local search_path"));
    expect(guardEnd).toBeGreaterThan(guardStart);
    expect(guardEnd).toBeLessThan(sql.indexOf("create or replace function public.casework_"));
    const guard = sql.slice(guardStart, guardEnd);
    const entries = [...guard.matchAll(/\('(public\.[^']+)', '([a-f0-9]{32})'\)/g)];
    expect(entries).toHaveLength(2);
    for (const [name, signature] of [
      ["casework_save_macro", "public.casework_save_macro(uuid,text,text,jsonb,boolean)"],
      ["casework_apply_macro", "public.casework_apply_macro(uuid,uuid[],uuid)"],
    ]) {
      const declaration = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\(`, "i");
      const predecessors = migrationFiles().filter((entry) => entry.name < repairName && declaration.test(stripComments(entry.sql)));
      const newest = predecessors.at(-1);
      expect(newest, name).toBeDefined();
      // Keep body whitespace/comments: pg_proc.prosrc hashes the stored bytes.
      const definition = fnBody(newest.sql, `public.${name}(`);
      const source = /\bas\s+(\$(?:[a-z_]\w*)?\$)([\s\S]*?)\1/i.exec(definition)?.[2];
      expect(source, name).toBeDefined();
      const hash = createHash("md5").update(source).digest("hex");
      expect(entries.find((entry) => entry[1] === signature)?.[2], name).toBe(hash);
    }
    expect(guard).toContain("pg_catalog.md5(p.prosrc)");
    expect(guard).toContain("p.oid = entry.signature::regprocedure");
    expect(guard).toContain("is distinct from entry.source_md5");
    expect(guard).toContain("using errcode = '55000'");
  });

  it("is superseded only by the uniform macro-refusal repair", () => {
    const declares = /create\s+(or\s+replace\s+)?function\s+public\.casework_apply_macro\(/i;
    const definitions = migrationFiles().filter((entry) => declares.test(stripComments(entry.sql)));
    expect(definitions.map((entry) => entry.name)).toEqual([
      `${PREDECESSOR}.sql`, `${REPAIR}.sql`, findMigrationName("casework_macro_refusals_hide_foreign_scopes"),
    ]);
  });

  it("settles every hat before the first write and adds no note writer of its own", () => {
    const body = fnBody(stripComments(loadMigrationSql("casework_macro_refusals_hide_foreign_scopes")), SIGNATURE);
    const loop = body.indexOf("foreach v_case_id in array p_case_ids loop");
    const noteCheck = body.indexOf("'adding case notes requires the coordinator role'");
    const assignCheck = body.indexOf("'assigning cases requires the coordinator role'");
    expect(noteCheck).toBeGreaterThan(0);
    expect(assignCheck).toBeGreaterThan(noteCheck);
    expect(loop).toBeGreaterThan(assignCheck);
    // Each check mirrors its delegate's own authorization refusals.
    expect(body).toContain("and not public.member_has_role(array['coordinator']) then");
    expect(body).toContain("not public.member_has_role(array['coordinator', 'admin'])");
    expect(body).toContain("not public.staff_can_see_user(c.user_id, 'coordinator')");
    // The note stays on the coordinator-gated delegate: every client-callable
    // note writer must go through private.coordinator_case_for_update
    // (tests/casework-note-restriction-db.test.js), so this routine writes no
    // member_case_updates row itself.
    expect(body).toContain("perform public.coordinator_add_case_note(v_case.id, v_action->>'body');");
    expect(body).not.toMatch(/insert\s+into\s+public\.member_case_updates/i);
    expect(body).not.toMatch(/update\s+public\.member_cases\b/i);
  });

  it("keeps the predecessor's gates, bounds and grants", () => {
    const code = stripComments(loadMigrationSql("casework_macro_refusals_hide_foreign_scopes"));
    const body = fnBody(code, SIGNATURE);
    expect(body.indexOf("perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);")).toBeLessThan(
      body.indexOf("perform private.casework_require_mfa();"));
    for (const kept of [
      "security definer",
      "set search_path = ''",
      "array['coordinator','admin','vp']",
      "private.casework_staff_can_access(c.id)",
      "'macro is scoped to another chapter'",
      "not between 1 and 100",
      "'macro_applied'",
    ]) expect(body).toContain(kept);
    // CREATE OR REPLACE preserves the existing authenticated-only ACL,
    // including the later service-role revocation.
    expect(code).not.toMatch(/\b(?:grant|revoke)\b/i);
  });

  it("supersedes exactly the reviewed predecessor and pins its own replacement", () => {
    const repair = loadMigrationSql(REPAIR);
    expect(repair).toContain(sha256(storedSource(loadMigrationSql(PREDECESSOR))));
    expect(repair).toContain(sha256(storedSource(repair)));
  });

  it("teaches the live database contract to expect the up-front checks", () => {
    const entry = contract.functions.find((fn) => fn.sig.startsWith(SIGNATURE));
    expect(entry.bodyContains).toContain("'assigning cases requires the coordinator role'");
    expect(entry.bodyContains).toContain("'adding case notes requires the coordinator role'");
    const audience = "private.casework_macro_audience(organization_id, chapter_id, false)";
    expect(entry.bodyContains).toContain(audience);
    const body = fnBody(stripComments(loadMigrationSql("casework_macro_refusals_hide_foreign_scopes")), SIGNATURE);
    expect(body.indexOf(audience)).toBeGreaterThan(body.indexOf("where id = p_macro_id and organization_id = v_org"));
    expect(body.indexOf(audience)).toBeLessThan(body.indexOf("if v_macro.id is null or not v_macro.active then"));
  });
});
