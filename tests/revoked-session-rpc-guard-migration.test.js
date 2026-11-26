// BUG-UG-REVOKED-SESSION-TOKEN-STILL-SERVES-THREE-RPCS-20261103
// (#6886): get_member_home_bootstrap, get_my_chapter_memberships and
// get_staff_mfa_standing check the caller's auth.sessions row the way the
// session RPCs do, and change nothing else. The live refusals are in
// tests/native-session-management-db.test.js.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, migrationNames, stripComments } from "./helpers/migration.js";

const name = "20261103112000_revoked_session_rpc_guard.sql";
const sql = readFileSync(`supabase/migrations/${name}`, "utf8");
const code = stripComments(sql);
const GUARD = "perform private.require_member_session();";
const source = (text, signature) => {
  const start = text.indexOf(`create or replace function ${signature}`);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  return text.slice(text.indexOf("as $function$", start), text.indexOf("$function$;", start));
};

describe("revoked-session guard on the three member reads", () => {
  it("sorts after the definitions it replaces and applies under an empty search_path", () => {
    const names = migrationNames();
    for (const earlier of [
      "20260812125000_member_device_sessions.sql",
      "20260822010000_mi1_organization_scope_foundation.sql",
      "20260924200000_member_support_chapterless_org_resolution.sql",
      "20261102173500_case_note_date_in_exports.sql",
    ]) expect(names.indexOf(name), earlier).toBeGreaterThan(names.indexOf(earlier));
    expect(sql).toMatch(/^begin;\nset local search_path = pg_catalog;$/m);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("adds a session-row guard that returns nothing and is reachable only by the member role", () => {
    const guard = stripComments(fnBody(sql, "private.require_member_session()"));
    expect(guard).toContain("perform private.current_member_session_id();");
    expect(code).toMatch(/create or replace function private\.require_member_session\(\)\nreturns void\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''\n/);
    expect(code).toContain("revoke all on function private.require_member_session() from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function private.require_member_session() to authenticated;");
  });

  it("changes the Home bootstrap only by the guard after its signed-in check, still as the caller", () => {
    const before = source(readFileSync("supabase/migrations/20261102173500_case_note_date_in_exports.sql", "utf8"), "public.get_member_home_bootstrap(");
    const after = source(sql, "public.get_member_home_bootstrap(");
    expect(after.replace(`  ${GUARD}\n`, "")).toBe(before);
    expect(after).toMatch(/raise exception 'authentication required' using errcode = '42501';\n {2}end if;\n {2}perform private\.require_member_session\(\);\n {2}if p_action_log_since is null then/);
    expect(code).toMatch(/function public\.get_member_home_bootstrap\(p_action_log_since timestamptz, p_resources text\[\]\)\nreturns jsonb\nlanguage plpgsql\nstable\nsecurity invoker\n/);
    expect(code).toContain("grant execute on function public.get_member_home_bootstrap(timestamptz, text[]) to authenticated;");
  });

  it("refuses before the membership query runs and leaves the query unchanged", () => {
    const before = source(readFileSync("supabase/migrations/20260924200000_member_support_chapterless_org_resolution.sql", "utf8"), "public.get_my_chapter_memberships(");
    const after = source(sql, "public.get_my_chapter_memberships(");
    expect(after.startsWith(`as $function$\nbegin\n  ${GUARD}\n  return (\n  select coalesce(`)).toBe(true);
    expect(after.replace(`begin\n  ${GUARD}\n  return (\n`, "").replace("\n  );\nend;\n", "\n")).toBe(before);
    expect(code).toContain("grant execute on function public.get_my_chapter_memberships() to authenticated;");
  });

  it("guards staff standing on the session row only, so it still answers before two-step sign-in", () => {
    const before = source(readFileSync("supabase/migrations/20260822010000_mi1_organization_scope_foundation.sql", "utf8"), "public.get_staff_mfa_standing(");
    const after = source(sql, "public.get_staff_mfa_standing(");
    expect(after.replace(`  ${GUARD}\n`, "")).toBe(before);
    expect(after.indexOf(GUARD)).toBeLessThan(after.indexOf("private.mfa_satisfied()"));
    expect(after.slice(0, after.indexOf(GUARD))).not.toContain("mfa_satisfied");
  });
});
