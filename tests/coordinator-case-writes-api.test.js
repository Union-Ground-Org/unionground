// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { coordinatorAddCaseNote, coordinatorLogCaseContact, coordinatorRecordCaseOutcome, coordinatorUpdateCase } from "../src/lib/memberApi.js";

function client() {
  const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
  return { rpc, client: { rpc } };
}

describe("coordinator case write API", () => {
  it("forwards status, deadline and the mandatory reason, and intentionally ignores a supplied step because step changes use the procedure transition path", async () => {
    const { client: api, rpc } = client();
    await coordinatorUpdateCase(api, "case-1", { status: "active", step: "Step 3", deadline: "2026-09-01", reason: "Employer granted extension" });
    expect(rpc).toHaveBeenCalledWith("coordinator_update_case", { p_case_id: "case-1", p_status: "active", p_step: null, p_deadline: "2026-09-01", p_reason: "Employer granted extension" });
  });

  it("routes notes through the coordinator-only atomic writer", async () => {
    const { client: api, rpc } = client();
    await coordinatorAddCaseNote(api, "case-1", "Demand filed");
    expect(rpc).toHaveBeenCalledWith("coordinator_add_case_note", { p_case_id: "case-1", p_body: "Demand filed" });
  });

  it("preserves structured contact evidence", async () => {
    const { client: api, rpc } = client();
    await coordinatorLogCaseContact(api, "case-1", { type: "phone", direction: "outbound", summary: "Called HR", contactedAt: "2026-08-10T14:00:00Z" });
    expect(rpc).toHaveBeenCalledWith("coordinator_log_case_contact", { p_case_id: "case-1", p_contact_type: "phone", p_direction: "outbound", p_summary: "Called HR", p_contacted_at: "2026-08-10T14:00:00Z" });
  });

  it("records outcomes separately from ordinary status edits", async () => {
    const { client: api, rpc } = client();
    await coordinatorRecordCaseOutcome(api, "case-1", { outcome: "settled", summary: "Back pay restored" });
    expect(rpc).toHaveBeenCalledWith("coordinator_record_case_outcome", { p_case_id: "case-1", p_outcome: "settled", p_summary: "Back pay restored" });
  });
});
