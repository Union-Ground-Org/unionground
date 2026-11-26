// @vitest-environment node
// BUG-UG-ORG-START-GUIDE-COUNTS-FOUNDER-RECORDS-20261102 (#6795): the
// org-start guide credited a new founder with their own founder invitation
// and starting chapter. The forward migration changes exactly those two rules
// in private.organization_start_milestones and nothing else; the live halves
// are in tests/organization-start-guide-db.test.js.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PREDECESSOR = "supabase/migrations/20261030201200_chapter_units_and_local_profile.sql";
const MIGRATION = "supabase/migrations/20261102215000_organization_start_guide_founder_counts.sql";
const SIGNATURE = "create or replace function private.organization_start_milestones(p_organization_id uuid)";

function functionBody(sql) {
  const start = sql.indexOf("as $function$", sql.indexOf(SIGNATURE)) + "as $function$".length;
  return sql.slice(start, sql.indexOf("$function$;", start));
}

const before = functionBody(readFileSync(PREDECESSOR, "utf8"));
const sql = readFileSync(MIGRATION, "utf8");
const after = functionBody(sql);

describe("org-start guide founder counts migration", () => {
  it("applies under the runner's empty search_path and pins the exact predecessor", () => {
    expect(sql).toMatch(/\nbegin;\n[\s\S]*set local search_path = pg_catalog;\n/);
    expect(sql).not.toMatch(/^set search_path = '';/m);
    const digest = createHash("md5").update(before).digest("hex");
    expect(sql).toContain(`where oid = 'private.organization_start_milestones(uuid)'::pg_catalog.regprocedure)\n      <> '${digest}' then`);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("leaves out the founder's own invitation and needs a chapter besides the starting one", () => {
    expect(after).toContain("where c.organization_id = org and i.sent_at is not null\n    and i.kind is distinct from 'founder';");
    expect(after).toContain("pg_catalog.jsonb_build_object('id', 'chapters', 'done', chapters_n > 1, 'count', chapters_n, 'adminOnly', true)");
    // The admin launch checklist's structure rule is the same: more than one chapter.
    expect(readFileSync("src/features/orgSetup/AdminLaunchChecklist.jsx", "utf8")).toContain("chapters.length > 1");
  });

  it("changes nothing else in the function, its header or its grants", () => {
    const stripped = after
      .replace(/\n {2}-- The founder's own invitation \(kind founder\) opened the organization; it\n {2}-- is not the administrator inviting anyone\./, "")
      .replace("\n    and i.kind is distinct from 'founder';", ";")
      .replace(/\n {6}-- The starting chapter comes with the organization; structure needs a\n {6}-- chapter added besides it, as on the admin launch checklist\./, "")
      .replace("'done', chapters_n > 1,", "'done', chapters_n > 0,");
    expect(stripped).toBe(before);
    expect(sql).toContain(`${SIGNATURE}\nreturns jsonb\nlanguage plpgsql\nstable\nsecurity definer\nset search_path = ''\nas $function$`);
    expect(sql).toContain("revoke all on function private.organization_start_milestones(uuid) from public, anon, authenticated, service_role;");
    expect(sql.match(/create or replace function/g)).toHaveLength(1);
    expect(sql).not.toMatch(/^\s*grant\s/im);
  });
});
