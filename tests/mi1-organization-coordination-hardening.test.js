// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const raw = loadMigrationSql("20260828235000_mi1_organization_coordination_hardening");
const sql = stripComments(raw);

function body(name) {
  return stripComments(fnBody(sql, name));
}

describe("MI1 organization coordination hardening", () => {
  it("withholds invited records until the selected organization is an active participant", () => {
    const readable = body("private.organization_coordination_can_read");
    expect(readable).toContain("participant.status = 'active'");
    expect(readable).not.toMatch(/record\.partner_organization_id\s*=\s*\(select private\.current_member_organization\(\)\)/);
  });

  it("keeps sensitive and cross-organization workflow visibility narrow", () => {
    const validate = body("private.validate_organization_coordination_visibility");
    expect(validate).toContain("cross-organization visibility must stay participant scoped");
    expect(validate).toContain("network conversations require participant visibility");
    expect(validate).toContain("staff workflow visibility required");
    expect(sql).toContain("create trigger validate_organization_coordination_visibility");
  });

  it("derives bounded objective points once and preserves coalition quorum", () => {
    const transition = body("public.transition_organization_coordination_record");
    expect(sql).toContain("organization_coordination_objective_completion_once_idx");
    expect(transition).toContain("awarded_points := (item.config ->> 'points')::integer");
    expect(transition).toContain("coalition decision approval required");
    expect(transition).toContain("coordination record owner role required");
    expect(transition).not.toMatch(/points\s*=\s*least\(points\s*\+\s*p_points/i);
  });

  it("revalidates live network messaging permission and pages readable history", () => {
    const send = body("public.send_organization_coordination_message");
    const page = body("public.list_organization_coordination_messages");
    expect(send).toContain("private.organization_network_has_permission");
    expect(send).toContain("organization message permission required");
    expect(page).toContain("limit page_limit + 1");
    expect(page).toContain("(message.created_at, message.id) < (p_before_created_at, p_before_id)");
    expect(page).toContain("private.organization_coordination_can_read(message.conversation_id)");
  });

  it("requires parent-issued oversight before recording directory parentage", () => {
    const profile = body("public.upsert_organization_network_profile");
    expect(profile).toContain("permission.grantor_organization_id = p_parent_organization_id");
    expect(profile).toContain("permission.grantee_organization_id = organization");
    expect(profile).toContain("permission.capability = 'oversight'");
    expect(profile).toContain("accepted parent oversight grant required");
  });

  it("produces a retrievable bounded export while neutralizing spreadsheet formulas", () => {
    const due = body("public.run_due_organization_coordination_exports");
    const payload = body("public.get_organization_coordination_export_payload");
    const csv = body("private.organization_coordination_csv_cell");
    expect(due).toContain("auth.role()) <> 'service_role'");
    expect(payload).toContain("run.organization_id = organization");
    expect(payload).toContain("run.delivery_mode = 'internal_download'");
    expect(payload).not.toMatch(/'summary'|'config'|'body'/);
    expect(csv).toContain("~ '^[=+@-]'");
    expect(sql).toMatch(/grant execute on function public\.get_organization_coordination_export_payload\(uuid\)\s+to authenticated/i);
  });
});
