import fs from "node:fs";import{describe,expect,it}from"vitest";
const sql=fs.readFileSync("supabase/migrations/20260810201500_private_space_membership_management.sql","utf8").toLowerCase();
describe("private space membership",()=>{
 it("gates all entry points through MFA, publishing roles, caller chapter, and a live space",()=>{expect(sql).toContain("private.mfa_satisfied()");expect(sql).toContain("member_has_role(array['steward','coordinator','advisor','admin','vp'])");expect(sql).toContain("s.chapter_id=private.current_member_chapter()");expect(sql).toContain("s.archived_at is null");});
 it("searches only same-chapter nonmembers with a bounded query",()=>{expect(sql).toContain("p.chapter_id=space.chapter_id");expect(sql).toContain("char_length(clean)<2");expect(sql).toContain("least(greatest(coalesce(p_limit,20),1),50)");expect(sql).toContain("not exists(select 1 from public.chapter_space_members");});
 it("protects the creator and validates the target before add/remove",()=>{expect(sql).toContain("space creator cannot be removed");expect(sql).toContain("p.id=p_user_id and p.chapter_id=space.chapter_id");expect(sql).toContain("on conflict(space_id,user_id) do nothing");});
});
