// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260828230000_mi1_analytics_parity_five.sql",
  "utf8",
);

function body(name) {
  const start = migration.indexOf(`create function ${name}`);
  if (start < 0) return "";
  const end = migration.indexOf("$function$;", start);
  return migration.slice(start, end + "$function$;".length);
}

describe("MI1 analytics parity database contract", () => {
  it("uses RLS, an RPC-only write boundary, and browser-session-only execution", () => {
    expect(migration).toContain("alter table public.organization_analytics_layouts enable row level security");
    expect(migration).toContain("alter table public.organization_analytics_layout_events enable row level security");
    expect(migration).toContain("organization_analytics_layouts_authorized_read");
    expect(migration.match(/create policy mfa_assurance/g)).toHaveLength(2);
    expect(migration).toContain("on public.organization_analytics_layouts as restrictive");
    expect(migration).toContain("on public.organization_analytics_layout_events as restrictive");
    expect(migration).toContain("revoke all on public.organization_analytics_layouts from public, anon, authenticated, service_role");
    expect(migration).toContain("grant select on public.organization_analytics_layouts to authenticated");
    expect(migration).not.toMatch(/grant execute[^;]+to service_role/);
  });

  it("derives tenant scope from the session and rejects cross-organization chapter writes", () => {
    for (const name of [
      "public.get_organization_analytics_workspace",
      "public.save_organization_analytics_layout",
      "public.delete_organization_analytics_layout",
    ]) {
      expect(body(name)).toContain("private.mi1_require_selected_organization()");
      expect(body(name)).not.toMatch(/p_organization_id/);
    }
    expect(body("public.save_organization_analytics_layout"))
      .toContain("c.id = p_chapter_id and c.organization_id = org");
  });

  it("keeps the report card self-only and excludes case burden from its score", () => {
    const report = body("public.get_my_analytics_report_card");
    expect(report).toContain("e.user_id = caller");
    expect(report).toContain("e.organization_id = org");
    expect(report).toContain("current_date - last_activity::date");
    expect(report).not.toContain("pg_catalog.current_date");
    expect(report).not.toContain("member_cases");
    expect(report).not.toMatch(/email|phone|service_role/i);
  });

  it("enforces the 25-person aggregate floor and minimizes explorer records", () => {
    const workspace = body("public.get_organization_analytics_workspace");
    expect(workspace).toContain("privacy_threshold integer := 25");
    expect(workspace).toContain("totals.member_count >= privacy_threshold");
    expect(workspace).toContain("cs.organization_id = org");
    expect(workspace).not.toMatch(/email|phone|address|case.*title/i);
  });

  it("bounds chart grammar and makes write retries exact", () => {
    expect(body("private.analytics_layout_spec_valid")).toContain("'bar', 'stacked_bar', 'line', 'area', 'table'");
    expect(body("public.save_organization_analytics_layout")).toContain("analytics dataset is unavailable");
    expect(body("public.save_organization_analytics_layout")).toContain("organization:chapter-health");
    expect(body("public.save_organization_analytics_layout")).toContain("health-trend");
    expect(body("public.save_organization_analytics_layout")).toContain(") >= 25");
    expect(body("public.save_organization_analytics_layout"))
      .toContain("split_part(p_spec ->> 'datasetId', ':', 2) is distinct from p_chapter_id");
    expect(migration).toContain("organization_analytics_idempotency_receipts");
    expect(body("public.save_organization_analytics_layout")).toContain("idempotency key reused with different request");
    expect(body("public.delete_organization_analytics_layout")).toContain("pg_advisory_xact_lock");
    for (const name of ["public.save_organization_analytics_layout", "public.delete_organization_analytics_layout"]) {
      expect(body(name)).toContain("r.created_at < pg_catalog.now() - interval '30 days'");
    }
    expect(migration).toContain("Append-only, content-free history");
  });
});
