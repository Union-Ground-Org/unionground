// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const NAME = "20260925230000_chapter_contact_log_immutable_history";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const save = stripComments(fnBody(sql, "public.save_chapter_contact_log"));
const createBranch = save.slice(save.indexOf("if p_contact_id is null then"), save.indexOf("else"));
const updateBranch = save.slice(save.indexOf("else"));

describe("chapter contact-log immutable history", () => {
  it("creates an insert-only versions table with RLS and a unique contact/version index", () => {
    expect(code).toContain("create table public.chapter_contact_log_versions");
    expect(code).toMatch(/alter table public\.chapter_contact_log_versions\s+enable row level security/);
    expect(code).toMatch(/unique\s*\(\s*contact_id\s*,\s*version\s*\)/);
    expect(code).toContain("on public.chapter_contact_log_versions (contact_id, version desc)");
    expect(code).toMatch(/create policy chapter_contact_log_versions_staff_read on public\.chapter_contact_log_versions\s+for select/);
    expect(code).not.toMatch(/create policy \w+ on public\.chapter_contact_log_versions[\s\S]{0,80}for update/i);
    expect(code).not.toMatch(/create policy \w+ on public\.chapter_contact_log_versions[\s\S]{0,80}for delete/i);
    expect(code).toContain("revoke all on public.chapter_contact_log_versions from public, anon, authenticated, service_role");
    expect(code).not.toMatch(/grant\s+(insert|update|delete|all)\s+on\s+public\.chapter_contact_log_versions\s+to\s+authenticated/i);
  });

  it("appends a version on create and captures the pre-image on update", () => {
    expect(createBranch).toContain("insert into public.chapter_contact_log_versions");
    expect(createBranch).toContain("insert into private.chapter_contact_log_audit");
    expect(updateBranch).toContain("insert into public.chapter_contact_log_versions");
    expect(updateBranch).toContain("insert into private.chapter_contact_log_audit");
    expect(updateBranch).toMatch(/with\s+pre\s+as\s*\(/);
    expect(updateBranch).toContain("for update");
    expect(updateBranch).toMatch(/returning l\.\*/);
    expect(updateBranch).toContain("(select coalesce(max(v.version), 0) + 1 from public.chapter_contact_log_versions v where v.contact_id = pre.id)");
    expect(updateBranch).not.toMatch(/select \* into pre from public\.chapter_contact_log/);
  });

  it("records created, edited, archived, and unarchived without copying the summary into the audit event", () => {
    expect(save).toContain("'created'");
    expect(save).toContain("'edited'");
    expect(save).toContain("'archived'");
    expect(save).toContain("'unarchived'");
    const auditInserts = [...save.matchAll(/insert into private\.chapter_contact_log_audit[\s\S]+?;/g)].map((match) => match[0]);
    expect(auditInserts.length).toBe(2);
    for (const insert of auditInserts) {
      expect(insert).not.toMatch(/\bsummary\b/);
      expect(insert).toMatch(/\b(actor_id|ctx\.caller_id)\b/);
      expect(insert).toMatch(/\baction\b/);
      expect(insert).toMatch(/\bcontact_id\b/);
    }
  });

  it("keeps the MFA gate, chapter-scope checks, and execute grants on the redefined writer", () => {
    expect(save).toContain("if not private.mfa_satisfied() then");
    expect(save).toContain("select * into ctx from private.institutional_context(true)");
    expect(save).toContain("contact subject is outside this chapter");
    expect(save).toContain("case is outside this chapter");
    expect(save).toContain("task is outside this chapter");
    expect(code).toContain(
      "revoke all on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) from public, anon, authenticated, service_role",
    );
    expect(code).toContain(
      "grant execute on function public.save_chapter_contact_log(uuid,text,text,text,text,text,timestamptz,timestamptz,uuid,uuid,uuid,boolean) to authenticated",
    );
  });
});
