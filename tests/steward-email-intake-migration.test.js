// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = loadMigrationSql("20260812201000_steward_email_intake.sql");
// The two privilege pins below read the executable text, not the file: a clause
// commented out as `-- set search_path = ''` is off in Postgres while the raw
// bytes still satisfy a substring check.
const executableSql = stripComments(sql);

describe("steward email intake migration", () => {
  it("stores a chapter-scoped replay digest and bounded review content", () => {
    expect(sql).toContain("create table public.steward_email_intakes");
    expect(sql).toContain("chapter_id text not null references public.chapters(id)");
    expect(sql).toContain("provider_message_digest text not null unique");
    expect(sql).toContain("char_length(from_address) between 3 and 320");
    expect(sql).toContain("char_length(subject) <= 500");
    expect(sql).toContain("char_length(body_text) between 1 and 60000");
  });

  it("admits ingestion only through a service-role function with no content audit", () => {
    const body = fnBody(sql, "public.ingest_steward_email(p_provider_message_digest text, p_chapter_id text, p_from_address text, p_subject text, p_body_text text, p_received_at timestamptz)");
    expect(body).toContain("auth.jwt() ->> 'role') <> 'service_role'");
    expect(body).not.toContain("auth.role()");
    expect(body).toContain("on conflict (provider_message_digest) do nothing");
    expect(body).toContain("'duplicate', not inserted");
    expect(body).not.toContain("member_admin_audit");
    expect(sql).toContain("grant execute on function public.ingest_steward_email(text, text, text, text, text, timestamptz) to service_role");
  });

  it("limits review to current MFA staff in the intake chapter and serializes transitions", () => {
    const list = fnBody(sql, "public.list_steward_email_intakes(p_status text default 'pending', p_limit integer default 50)");
    const review = fnBody(sql, "public.review_steward_email_intake(p_intake_id uuid, p_action text)");
    for (const body of [list, review]) {
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).toContain("member_has_role(array['steward','admin'])");
      expect(body).toContain("private.current_member_chapter()");
    }
    expect(review).toContain("for update");
    expect(review).toContain("reviewed_by = caller");
    expect(review).toContain("member_admin_audit");
    expect(review).not.toContain("from_address");
    expect(review).not.toContain("body_text");
  });

  it("has no direct browser table access", () => {
    expect(sql).toContain("alter table public.steward_email_intakes enable row level security");
    expect(sql).toContain("revoke all on public.steward_email_intakes from public, anon, authenticated");
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*steward_email_intakes\s+to\s+authenticated/i);
  });

  it("pins an empty search_path on every security-definer intake function", () => {
    for (const name of [
      "public.ingest_steward_email(p_provider_message_digest text, p_chapter_id text, p_from_address text, p_subject text, p_body_text text, p_received_at timestamptz)",
      "public.list_steward_email_intakes(p_status text default 'pending', p_limit integer default 50)",
      "public.review_steward_email_intake(p_intake_id uuid, p_action text)",
    ]) {
      expect(fnBody(executableSql, name)).toContain("set search_path = ''");
    }
  });

  it("pins the function-level execute revokes against every default-privileged role", () => {
    // Whitespace-flattened because the migration wraps each revoke onto a second
    // line. The role list is pinned in full: dropping `public` alone would keep
    // the function's default PUBLIC execute privilege while the prefix stayed
    // green.
    const flattened = executableSql.replace(/\s+/g, " ");
    for (const signature of [
      "public.ingest_steward_email(text, text, text, text, text, timestamptz)",
      "public.list_steward_email_intakes(text, integer)",
      "public.review_steward_email_intake(uuid, text)",
    ]) {
      expect(flattened).toContain(`revoke all on function ${signature} from public, anon, authenticated;`);
    }
  });
});
