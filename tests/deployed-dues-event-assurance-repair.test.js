// @vitest-environment node
import { describe, expect, it } from "vitest";
import { migrationFiles, stripComments } from "./helpers/migration.js";

const repair = migrationFiles().find(({ name }) => (
  name.endsWith("deployed_dues_event_assurance_repair.sql")
));
const sql = stripComments(repair?.sql ?? "");

const authenticatedOnlyDues = [
  "apply_dues_credit_event(uuid, text, integer, text, text, text)",
  "cancel_dues_checkout_reservation(uuid)",
  "create_dues_checkout_reservation(uuid, text)",
  "disconnect_dues_stripe_account(text)",
  "get_dues_provider_status(text)",
  "get_dues_workspace(text, text, date, uuid, integer, text)",
  "get_mobile_dues_context()",
  "get_my_dues_workspace(uuid, integer)",
  "issue_dues_assessment_batch(text, text, text, text, integer, date, text, text, text)",
  "preview_dues_assessment_batch(text, text, text, text, integer, date, text)",
  "queue_dues_reminder(uuid, text, text, text)",
  "record_dues_manual_payment(uuid, integer, date, text, text, text, text, text)",
  "request_dues_stripe_connection(text)",
];

describe("deployed Dues and event assurance repair", () => {
  it("carries one explicit forward-only repair migration", () => {
    expect(repair?.name).toMatch(/^\d{14}_deployed_dues_event_assurance_repair\.sql$/);
    expect(sql).toContain("begin;");
    expect(sql).toContain("commit;");
  });

  it("removes service-role reachability from every authenticated-only Dues RPC", () => {
    for (const signature of authenticatedOnlyDues) {
      expect(sql).toContain(`revoke execute on function public.${signature} from service_role`);
      expect(sql).toContain(`grant execute on function public.${signature} to authenticated`);
    }
  });

  it("reasserts the reviewed Dues audit allowlists instead of trusting ledger presence", () => {
    expect(sql).toContain("drop constraint organization_audit_events_event_type_check");
    expect(sql).toContain("drop constraint organization_audit_events_metadata_keys");
    for (const event of ["dues_assessment_issued", "dues_checkout_attention_resolved"]) {
      expect(sql).toContain(`'${event}'`);
    }
    for (const key of ["reservationId", "failureClass"]) {
      expect(sql).toContain(`'${key}'`);
    }
  });

  it("keeps the event table policy tenant-first without a per-row scope helper", () => {
    const start = sql.indexOf("create policy member_events_select_scoped");
    const end = sql.indexOf(";", start);
    const policy = sql.slice(start, end + 1);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(policy).not.toContain("private.member_can_access_event_scope(");
    expect(policy).toContain("event_chapter.organization_id = (select private.current_member_organization())");
    expect(policy).toContain("event_chapter.id = (select private.current_member_chapter())");
  });
});
