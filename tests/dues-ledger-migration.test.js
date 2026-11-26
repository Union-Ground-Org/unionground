import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("supabase/migrations/20260831110000_mi1_dues_ledger_foundation.sql"), "utf8");

describe("dues ledger foundation migration", () => {
  it("creates tenant-keyed append-only storage and enables RLS", () => {
    for (const table of [
      "dues_member_subjects",
      "dues_assessment_batches",
      "dues_obligations",
      "dues_ledger_events",
      "dues_reminder_attempts",
    ]) {
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    expect(sql).toContain("amount_cents integer");
    expect(sql).toContain("references auth.users(id) on delete set null");
    expect(sql).toContain("foreign key (organization_id, chapter_id)");
    expect(sql).toContain("references public.chapters (organization_id, id)");
    expect(sql).toContain("unique (organization_id, batch_id, member_subject_id)");
  });

  it("derives tenant and staff authorization from session state", () => {
    expect(sql).toContain("private.current_member_organization()");
    expect(sql).toContain("private.has_organization_role(org, array[p_selected_hat])");
    expect(sql).toContain("p_selected_hat not in ('admin', 'vp')");
    expect(sql).toContain("dues financial role or MFA required");
    const publicDuesRpcs = sql.slice(sql.indexOf("create or replace function public.preview_dues_assessment_batch"));
    expect(publicDuesRpcs).not.toMatch(/p_organization_id\s+uuid/i);
  });

  it("provisions active subjects without fabricating a tenant and keeps preview read-only", () => {
    expect(sql).toContain("private.provision_dues_member_subjects()");
    expect(sql).toContain("provision_dues_member_subject_on_membership");
    expect(sql).toContain("dues subject provisioning incomplete");
    const preview = sql.slice(sql.indexOf("create or replace function public.preview_dues_assessment_batch"), sql.indexOf("create or replace function public.get_my_dues_workspace"));
    expect(preview).not.toMatch(/insert\s+into|update\s+public|delete\s+from/i);
    expect(sql).toContain("extensions.digest");
  });

  it("counts each eligible subject once and tenant-binds chapter eligibility", () => {
    expect(sql).not.toMatch(/join public\.member_chapter_memberships chapter_membership\s+on chapter_membership\.user_id = membership\.user_id/);
    expect(sql.match(/or exists \(/g)).toHaveLength(2);
    expect(sql.match(/chapter\.organization_id = subject\.organization_id/g)).toHaveLength(2);
    expect(sql.match(/chapter_membership\.chapter_id = p_chapter_id/g)).toHaveLength(2);
  });

  it("keeps direct table writes revoked and exposes scoped RPCs only", () => {
    expect(sql).toContain("revoke all on table public.dues_member_subjects");
    expect(sql).toContain("grant execute on function public.preview_dues_assessment_batch");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("least(greatest(coalesce(p_limit, 25), 1), 100)");
  });
});
