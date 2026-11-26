import fs from "node:fs";
import { describe, expect, it } from "vitest";
const sql=fs.readFileSync("supabase/migrations/20260810193000_published_content_lifecycle.sql","utf8").toLowerCase();
describe("published content lifecycle",()=>{
  it("gates every write behind MFA, staff publishing roles, and caller chapter",()=>{
    expect(sql).toContain("private.mfa_satisfied()");
    expect(sql).toContain("member_has_role(array['steward','coordinator','advisor','admin','vp'])");
    expect(sql.match(/chapter_id=chapter/g)).toHaveLength(3);
  });
  it("archives spaces and records durably",()=>{
    expect(sql).toContain("alter table public.chapter_records add column archived_at");
    expect(sql.match(/coalesce\([sr]\.archived_at, now\(\)\)/g)).toHaveLength(2);
  });
  it("version-bumps and timestamps every explicit document re-publication",()=>{
    expect(sql).toContain("p_action not in ('save','republish','archive')");
    expect(sql).toContain("when p_action='republish' then d.version+1");
    expect(sql).toContain("when p_action='republish' then now()");
  });
});
