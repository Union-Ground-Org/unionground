import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260829002000_organization_intelligence_collective_actions.sql",
  "utf8",
);

const tables = [
  "organization_chart_nodes",
  "organization_relationships",
  "organization_topic_progress",
  "organization_timeline_events",
  "digital_actions",
  "digital_action_participants",
  "digital_action_exports",
  "organization_intelligence_audit_events",
];

const rpcs = [
  "get_organization_intelligence_snapshot",
  "get_collective_actions",
  "save_organization_chart_node",
  "save_organization_relationship",
  "save_organization_topic_progress",
  "save_organization_timeline_event",
  "save_digital_action",
  "toggle_digital_action_participation",
  "request_digital_action_participant_export",
];

describe("organization intelligence database contract", () => {
  it("creates tenant-keyed tables with RLS, restrictive MFA and no direct client grants", () => {
    for (const table of tables) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`create policy mfa_assurance on public.${table}`);
      expect(migration).toContain(`revoke all on public.${table} from public, anon, authenticated, service_role`);
    }
    expect(migration).not.toMatch(/grant\s+(select|insert|update|delete|truncate|references|trigger|maintain|all)\s+on\s+public\.(organization_chart_nodes|organization_relationships|organization_topic_progress|organization_timeline_events|digital_actions|digital_action_participants|digital_action_exports|organization_intelligence_audit_events)/i);
  });

  it("derives organization scope and exposes only exact authenticated RPCs", () => {
    expect(migration).toContain("private.mi1_require_selected_organization()");
    for (const rpc of rpcs) {
      expect(migration).toContain(`create function public.${rpc}`);
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${rpc}\\(`));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${rpc}\\(`));
    }
    const publicRpcSql = migration.slice(
      migration.indexOf("create function public.get_organization_intelligence_snapshot"),
    );
    expect(publicRpcSql).not.toMatch(/\bp_(organization|org|tenant)_id\b/i);
    expect(publicRpcSql).toContain("array[p_selected_hat]");
  });

  it("keeps staff intelligence separate from member-safe action aggregates", () => {
    const intelligence = migration.slice(
      migration.indexOf("create function public.get_organization_intelligence_snapshot"),
      migration.indexOf("create function public.get_collective_actions"),
    );
    const actions = migration.slice(
      migration.indexOf("create function public.get_collective_actions"),
      migration.indexOf("create function public.save_organization_chart_node"),
    );
    expect(intelligence).toContain("private.has_organization_role");
    expect(intelligence).toContain("relationshipNodes");
    expect(intelligence).toContain("from public.organization_memberships m");
    expect(intelligence.match(/limit 5000/g)).toHaveLength(5);
    expect(actions).toContain("private.is_organization_member");
    expect(actions).toContain("participantCount");
    expect(actions).toContain("viewerParticipation");
    expect(actions).toContain("p_limit integer default 25");
    expect(actions).toContain("limit p_limit offset p_offset");
    expect(actions).toContain("'nextOffset'");
    expect(actions).not.toContain("memberName");
    expect(actions).not.toContain("users.email");
  });

  it("requires MFA and export-authorized roles before returning named participants", () => {
    const exportRpc = migration.slice(
      migration.indexOf("create function public.request_digital_action_participant_export"),
      migration.indexOf("revoke all on function public.get_organization_intelligence_snapshot"),
    );
    expect(exportRpc).toContain("private.mfa_satisfied()");
    expect(exportRpc).toContain("p_selected_hat not in ('coordinator', 'admin', 'vp')");
    expect(exportRpc).toContain("array[p_selected_hat]");
    expect(exportRpc).toContain("p.organization_id = org and p.action_id = p_action_id");
    expect(exportRpc).toContain("result_count > 10000");
    expect(exportRpc).toContain("for share");
    expect(exportRpc).toContain("interval '24 hours'");
    expect(exportRpc).toContain("delete from public.digital_action_exports receipt");
    expect(exportRpc).toContain("receipt.expires_at <= pg_catalog.now()");
    expect(exportRpc).toContain("digital_action_export_requested");
  });

  it("preserves cross-organization foreign keys and rejects donor fixtures", () => {
    expect(migration).toContain("foreign key (organization_id, source_user_id)");
    expect(migration).toContain("foreign key (organization_id, target_user_id)");
    expect(migration).toContain("foreign key (organization_id, action_id)");
    expect(migration).toContain("foreign key (organization_id, user_id)");
    const schemaSql = migration.slice(0, migration.indexOf("create function private.write_organization_intelligence_audit"));
    expect(schemaSql).not.toMatch(/insert into public\.(organizations|organization_memberships|member_profiles|organization_chart_nodes|organization_relationships|organization_timeline_events|digital_actions|digital_action_participants)/i);
    const executableSql = migration.replace(/^--.*$/gm, "");
    expect(executableSql).not.toMatch(/createServiceClient|service[_-]role key|project[_-]ref/i);
  });

  it("rejects chart re-kinding that would orphan persisted child nodes", () => {
    expect(migration).toContain("child.parent_id = p_id");
    expect(migration).toContain("child.chart_kind <> p_chart_kind");
    expect(migration).toContain("chart kind change rejected while node has children");
  });
});
