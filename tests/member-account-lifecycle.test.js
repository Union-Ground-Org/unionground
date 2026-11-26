// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const sql = loadMigrationSql("20260812180000_member_account_lifecycle.sql");

describe("member account lifecycle migration", () => {
  it("generates a caller-scoped export without capability secrets or other-member addresses", () => {
    const body = fnBody(sql, "public.get_member_data_export()");
    expect(body).toContain("caller uuid := (select auth.uid())");
    expect(body).toContain("where p.id = caller");
    expect(body).toContain("where c.user_id = caller");
    expect(body).toContain("where f.user_id = caller");
    expect(body).toContain("where a.user_id = caller");
    expect(body).toContain("jsonb_build_object('schemaVersion', 1");
    for (const forbidden of ["token_hash", "auth_key", "p256dh", "encrypted_password", "reauthentication_token", "invited_email"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("requires exact typed confirmation and recent AAL2 on the current session", () => {
    const body = fnBody(sql, "public.authorize_member_account_deletion(p_confirmation text)");
    expect(body).toContain("p_confirmation <> 'DELETE MY ACCOUNT'");
    expect(body).toContain("auth.jwt() ->> 'aal'");
    expect(body).toContain("= 'aal2'");
    expect(body).toContain("auth.jwt() ->> 'session_id'");
    expect(body).toContain("auth.mfa_amr_claims");
    expect(body).toContain("now() - interval '10 minutes'");
    expect(body).toContain("auth.uid()");
    expect(body).not.toContain("p_user_id");
  });

  it("uses a short-lived one-time capability and atomic service-only claim/finalize", () => {
    const authorize = fnBody(sql, "public.authorize_member_account_deletion(p_confirmation text)");
    expect(authorize).toContain("pg_advisory_xact_lock");
    expect(authorize).toContain("extensions.gen_random_bytes(32)");
    expect(authorize).toContain("interval '5 minutes'");

    for (const signature of [
      "public.claim_member_account_deletion(p_request_id uuid, p_user_id uuid, p_token text)",
      "public.finalize_member_account_deletion(p_request_id uuid, p_token text, p_succeeded boolean, p_failure_code text)",
    ]) {
      const body = fnBody(sql, signature);
      expect(body).toContain("auth.role()) <> 'service_role'");
      expect(body).toContain("for update");
    }
    expect(sql).toContain("revoke all on function public.claim_member_account_deletion(uuid, uuid, text) from public, anon, authenticated");
    expect(sql).toContain("grant execute on function public.claim_member_account_deletion(uuid, uuid, text) to service_role");
  });

  it("stores only pseudonymous bounded deletion metadata", () => {
    expect(sql).toContain("create table private.member_account_deletions");
    expect(sql).toContain("subject_hash text not null");
    const tableDefinition = sql.slice(
      sql.indexOf("create table private.member_account_deletions"),
      sql.indexOf("create unique index member_account_deletions"),
    );
    expect(tableDefinition).not.toMatch(/\buser_id\b/);
    expect(sql).toContain("failure_code text check");
    expect(sql).toContain("char_length(failure_code) <= 64");
  });

  it("preserves chapter records and other members' appointments without retaining live attribution", () => {
    expect(sql).toContain("pg_catalog.pg_trigger_depth() > 1");
    expect(sql).toContain("detaching_identity and new.created_by is null and not exists");
    for (const constraint of [
      "chapter_spaces_created_by_fkey",
      "chapter_threads_created_by_fkey",
      "chapter_thread_posts_author_id_fkey",
      "chapter_documents_created_by_fkey",
      "chapter_records_created_by_fkey",
      "chapter_handshakes_requested_by_fkey",
      "member_appointments_steward_id_fkey",
    ]) {
      expect(sql).toContain(`drop constraint ${constraint}`);
    }
    expect(sql.match(/on delete set null/g)?.length).toBeGreaterThanOrEqual(7);
    for (const constraint of [
      "member_kb_articles_created_by_fkey",
      "member_kb_articles_updated_by_fkey",
      "member_kb_articles_verified_by_fkey",
      "member_kb_article_revisions_changed_by_fkey",
      "member_kb_article_revisions_verified_by_fkey",
    ]) {
      expect(sql).toContain(`drop constraint ${constraint}`);
    }
  });
});
