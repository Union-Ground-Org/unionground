// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { latestFnBody, stripComments } from "./helpers/migration.js";

const source = readFileSync(resolve(import.meta.dirname, "../supabase/migrations/20260810194000_member_case_files.sql"), "utf8").toLowerCase();
const sql = stripComments(source).replace(/\s+/g, " ");
// TEST-UG-MIGRATION-TESTS-PIN-SUPERSEDED-RPC-DEFINITIONS-20260920: the
// 20260917 restriction gates redefine the register, remove, write and delete
// paths, so their authorization is read from the last definition in apply
// order rather than from the origin file above.
const effective = (name) => stripComments(latestFnBody(name)).replace(/\s+/g, " ").toLowerCase();

describe("member case file vault migration", () => {
  it("pins a private, bounded bucket and registration rows", () => {
    expect(sql).toContain("'case-files', 'case-files', false, 10485760");
    expect(sql).toContain("create table public.member_case_files");
    expect(sql).toContain("check (bucket_id = 'case-files')");
    expect(sql).toContain("size_bytes between 1 and 10485760");
    expect(sql).toContain("filename !~ '[/\\\\]'");
    expect(sql).toContain("references public.member_cases(id) on delete cascade");
  });

  it("keeps table writes behind MFA-gated definer RPCs", () => {
    expect(sql).toContain("alter table public.member_case_files enable row level security");
    expect(sql).toContain("create policy mfa_assurance on public.member_case_files");
    expect(sql).toContain("revoke all on table public.member_case_files from public, anon, authenticated");
    expect(sql).toContain("grant select on table public.member_case_files to authenticated");
    expect(sql).not.toMatch(/grant\s+(insert|update|delete)[^;]*member_case_files/);
    expect(sql).toContain("create or replace function public.register_member_case_file");
    expect(sql).toContain("create or replace function public.remove_member_case_file");
    expect(source.match(/not private\.mfa_satisfied\(\)/g)).toHaveLength(2);
  });

  it("authorizes only the owner or scoped coordinator", () => {
    expect(source.match(/staff_can_see_user\([^)]*'coordinator'\)/g).length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("c.user_id = caller or public.staff_can_see_user(c.user_id, 'coordinator')");
    expect(sql).toContain("f.user_id = caller or public.staff_can_see_user(f.user_id, 'coordinator')");
    expect(sql).not.toContain("member_has_role(array['steward'");
  });

  it("requires coordinator case visibility on the effective register, remove, write and delete paths", () => {
    const register = effective("register_member_case_file");
    const remove = effective("remove_member_case_file");
    const write = effective("private.can_write_member_case_object");
    const del = effective("private.can_delete_member_case_object");
    for (const [name, body] of [["register", register], ["remove", remove]]) {
      expect(body, name).toContain("security definer");
      expect(body, name).toContain("not private.mfa_satisfied()");
    }
    expect(register).toContain("c.user_id = caller or (public.staff_can_see_user(c.user_id, 'coordinator') and private.member_case_visible_to_caller(c.id))");
    expect(remove).toContain("f.user_id = caller or (public.staff_can_see_user(f.user_id, 'coordinator') and private.member_case_visible_to_caller(f.case_id))");
    for (const [name, body] of [["write", write], ["delete", del]]) {
      expect(body, name).toContain("f.user_id = (select auth.uid()) or (public.staff_can_see_user(f.user_id, 'coordinator') and private.member_case_visible_to_caller(f.case_id))");
    }
  });

  it("accepts storage bytes only at exact registered paths", () => {
    expect(sql).toContain("function private.can_read_member_case_object");
    expect(sql).toContain("function private.can_write_member_case_object");
    expect(sql).toContain("f.user_id = (select auth.uid()) or public.staff_can_see_user(f.user_id, 'coordinator')");
    expect(sql).toContain("create policy member_case_files_storage_insert on storage.objects");
    expect(sql).toContain("private.can_write_member_case_object(bucket_id, name)");
    expect(sql).not.toContain("delete from storage.objects");
  });

  it("indexes every ownership and lookup path", () => {
    for (const name of ["member_case_files_case_created_idx", "member_case_files_user_created_idx", "member_case_files_uploaded_by_idx"]) {
      expect(sql).toContain(`create index ${name}`);
    }
  });
});
