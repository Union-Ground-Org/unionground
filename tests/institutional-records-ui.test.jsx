import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { InstitutionalRecordsPanel } from "../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
// The shared rpc mock carries reads too (a reload that
// lands inside the tick); only writes count toward the one-write rule.
const isRpcWrite = (name) => !/^(get|list|load|search)_/.test(String(name));

const workspace = {
  canManage: true,
  canExport: true,
  records: [
    {
      id: "minutes-1",
      record_type: "minutes",
      lifecycle_status: "published",
      title: "April membership meeting",
      body: "Members approved the training calendar.",
      occurred_at: "2026-04-10T18:00:00.000Z",
      version: 2,
      attendance: [{ userId: "member-1", status: "present" }],
      versions: [{ version: 1, lifecycle_status: "draft" }, { version: 2, lifecycle_status: "published" }],
      dispatch: { delivered: 14 },
    },
    {
      id: "milestone-1",
      record_type: "milestone",
      lifecycle_status: "published",
      title: "Safety committee established",
      body: "The first committee charter was adopted.",
      occurred_at: "2024-01-10T18:00:00.000Z",
      version: 1,
      pinned_at: "2024-01-10T18:00:00.000Z",
    },
    {
      id: "decision-1",
      record_type: "decision",
      lifecycle_status: "published",
      title: "Training calendar approved",
      body: "Delegates approved quarterly steward training.",
      occurred_at: "2025-01-20T18:00:00.000Z",
      version: 1,
      gap_note: "No formal votes were scheduled during the summer recess.",
    },
    {
      id: "legacy-contact-1",
      record_type: "management_contact",
      lifecycle_status: "published",
      title: "Earlier management contact",
      body: "Recorded before the standalone contact ledger launched.",
      occurred_at: "2024-02-15T18:00:00.000Z",
      version: 1,
    },
  ],
  contacts: [{
    id: "contact-1",
    contact_kind: "member",
    channel: "phone",
    purpose: "Scheduling follow-up",
    summary: "Confirmed the next check-in.",
    case_id: "case-1",
    task_id: "task-1",
    subjectName: "Jordan Lee",
    occurred_at: "2026-08-25T16:00:00.000Z",
  }],
  roster: [{ userId: "member-1", name: "Jordan Lee" }],
  exportRuns: [{ id: "export-1", format: "csv", row_count: 12, created_at: "2026-08-29T12:00:00.000Z" }],
};

function renderSurface({ rpcOverride, onNotice = vi.fn(), data = workspace, lang = "en", canStaff = true } = {}) {
  const client = {
    rpc: vi.fn(async (name) => {
      const overridden = await rpcOverride?.(name);
      if (overridden) return overridden;
      if (name === "get_institutional_records_workspace") return { data, error: null };
      if (name === "save_institutional_record") return { data: { saved: true }, error: null };
      if (name === "save_chapter_contact_log") return { data: { saved: true }, error: null };
      if (name === "request_filtered_organization_export") return { data: { receiptId: "receipt-2", format: "csv", domains: ["members"], rowCount: 1, expiresAt: "2026-08-30T12:15:00.000Z", rows: [] }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    }),
  };
  const rendered = render(
    <LanguageProvider lang={lang}>
      <InstitutionalRecordsPanel client={client} canStaff={canStaff} onNotice={onNotice} />
    </LanguageProvider>,
  );
  return { ...rendered, client, onNotice };
}

describe("institutional records staff workspace", () => {
  it("hides record authoring when Member is selected even if the server confirms an account-level office", async () => {
    const {client}=renderSurface({canStaff:false});
    await screen.findByText("April membership meeting");
    expect(screen.queryByRole("button",{name:"New minutes"})).toBeNull();
    expect(screen.queryByRole("button",{name:"Edit"})).toBeNull();
    expect(client.rpc.mock.calls.some(([name])=>name==="get_minutes_pre_event_notices")).toBe(false);
  });
  it("keeps an existing chapter record unscoped when an officer edits it", async () => {
    const data = { ...workspace, chapterId: "chapter", organizationId: "org", canManageUnscoped: true, recordScopes: [], records: [workspace.records[0]] };
    const { client } = renderSurface({ data, rpcOverride: async (name) => name === "save_scoped_institutional_record" ? { data: { saved: true } } : null });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_scoped_institutional_record", expect.objectContaining({ p_access_unit_id: null, p_access_committee_id: null })));
  });

  it("requires an explicit scope when the workspace supplies no active scoped choices", async () => {
    renderSurface({ data: { ...workspace, canManageUnscoped: false, recordScopes: [] } });
    fireEvent.click(await screen.findByRole("button", { name: "New minutes" }));
    const scope = within(screen.getByRole("dialog")).getByLabelText("Access scope");
    expect(scope).toBeRequired();
    expect(scope.selectedIndex).toBe(-1);
    expect(scope.checkValidity()).toBe(false);
  });

  it.each([
    ["unit:u", true], ["committee:c", true], ["unit:retained", true],
    ["unit:u", false], ["committee:c", false],
  ])("preserves a saved %s scope when editing, with scope choices %s", async (scope, choices) => {
    const [kind, id] = scope.split(":");
    const row = { ...workspace.records[0], access_unit_id: kind === "unit" ? id : null, access_committee_id: kind === "committee" ? id : null };
    const data = { ...workspace, chapterId: "chapter", organizationId: "org", canManageUnscoped: true, records: [row],
      recordScopes: choices ? [{ role: "secretary", unitId: "u", name: "Garage", records: true }, { role: "records", committeeId: "c", name: "Safety", records: true }, { role: "secretary", unitId: "disabled", name: "No records permission", records: false }] : [] };
    const { client } = renderSurface({ data, rpcOverride: async (name) => name === "save_scoped_institutional_record" ? { data: { saved: true } } : null });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    if (choices) {
      expect(within(dialog).getByLabelText("Access scope")).toHaveValue(scope);
      if (id === "retained") expect(within(dialog).getByRole("option", { name: "Current scope" })).toBeInTheDocument();
    } else expect(within(dialog).queryByLabelText("Access scope")).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_scoped_institutional_record", expect.objectContaining({
      p_access_unit_id: row.access_unit_id, p_access_committee_id: row.access_committee_id,
      p_expected_chapter: "chapter", p_expected_organization: "org", p_expected_version: 2,
    })));
  });

  it("keeps a records office out of contacts and binds scoped publishing to its loaded chapter", async () => {
    const data = { ...workspace, chapterId: "chapter", organizationId: "org", canContacts: false, canManageUnscoped: false,
      recordScopes: [{ role: "secretary", unitId: "u", name: "Garage", records: true }, { role: "records", committeeId: "c", name: "Safety", records: true }],
      records: workspace.records.filter((record) => record.record_type === "minutes").map((record) => ({ ...record, canManage: false })), contacts: [] };
    const { client } = renderSurface({ data, rpcOverride: async (name) => name === "save_scoped_institutional_record" ? { data: { saved: true } } : null });
    await screen.findByText("April membership meeting"); expect(screen.queryByRole("button", { name: "Contact log" })).not.toBeInTheDocument(); expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New minutes" }));
    const dialog = screen.getByRole("dialog"); expect(within(dialog).getByLabelText("Access scope")).toHaveValue("unit:u");
    fireEvent.change(within(dialog).getByLabelText("Access scope"), { target: { value: "committee:c" } });
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Safety minutes" } }); fireEvent.change(within(dialog).getByLabelText("Record"), { target: { value: "Meeting record" } }); fireEvent.change(within(dialog).getByLabelText("Date and time"), { target: { value: "2026-10-31T12:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_scoped_institutional_record", expect.objectContaining({ p_access_committee_id: "c", p_access_unit_id: null, p_expected_chapter: "chapter", p_expected_organization: "org" })));
  });
  // save_chapter_minutes saves through save_institutional_record, which keeps
  // the record's stored scope, so a location change carries the stored scope.
  it("saves a changed minutes location through the minutes save when the scope is unchanged", async () => {
    const row = { ...workspace.records[0], access_unit_id: "u", access_committee_id: null };
    const data = { ...workspace, chapterId: "chapter", organizationId: "org", canManageUnscoped: true, records: [row],
      recordScopes: [{ role: "secretary", unitId: "u", name: "Garage", records: true }, { role: "records", committeeId: "c", name: "Safety", records: true }] };
    const { client } = renderSurface({ data, rpcOverride: async (name) => name === "save_chapter_minutes" ? { data: { saved: true } } : null });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: "Union hall" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_chapter_minutes", expect.objectContaining({ p_record_id: "minutes-1", p_location: "Union hall", p_expected_version: 2 })));
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("save_scoped_institutional_record");
  });

  it("creates new scoped minutes with a location in their scope, then saves the location and action there", async () => {
    const data = { ...workspace, chapterId: "chapter", organizationId: "org", canManageUnscoped: false, records: [],
      recordScopes: [{ role: "secretary", unitId: "u", name: "Garage", records: true }] };
    const { client } = renderSurface({ data, rpcOverride: async (name) => (
      name === "save_scoped_institutional_record" ? { data: { id: "minutes-new", version: 1, access_unit_id: "u" } }
        : name === "save_chapter_minutes" ? { data: { id: "minutes-new", version: 2 } } : null) });
    fireEvent.click(await screen.findByRole("button", { name: "New minutes" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Access scope")).toHaveValue("unit:u");
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Garage minutes" } });
    fireEvent.change(within(dialog).getByLabelText("Record"), { target: { value: "Meeting record" } });
    fireEvent.change(within(dialog).getByLabelText("Date and time"), { target: { value: "2026-10-31T12:00" } });
    fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: "Union hall" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_chapter_minutes", expect.objectContaining({
      p_record_id: "minutes-new", p_expected_version: 1, p_location: "Union hall", p_action: "publish" })));
    expect(client.rpc).toHaveBeenCalledWith("save_scoped_institutional_record", expect.objectContaining({
      p_record_id: null, p_action: "save", p_access_unit_id: "u", p_access_committee_id: null, p_expected_chapter: "chapter" }));
    const names = client.rpc.mock.calls.map(([name]) => name);
    expect(names.indexOf("save_scoped_institutional_record")).toBeLessThan(names.indexOf("save_chapter_minutes"));
  });

  it("refuses a minutes save that changes both the location and the access scope", async () => {
    const row = { ...workspace.records[0], access_unit_id: "u", access_committee_id: null };
    const data = { ...workspace, chapterId: "chapter", organizationId: "org", canManageUnscoped: true, records: [row],
      recordScopes: [{ role: "secretary", unitId: "u", name: "Garage", records: true }, { role: "records", committeeId: "c", name: "Safety", records: true }] };
    const { client } = renderSurface({ data });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Access scope"), { target: { value: "committee:c" } });
    fireEvent.change(within(dialog).getByLabelText("Location"), { target: { value: "Union hall" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The change could not be saved.");
    const names = client.rpc.mock.calls.map(([name]) => name);
    expect(names).not.toContain("save_chapter_minutes");
    expect(names).not.toContain("save_scoped_institutional_record");
  });

  it("exposes the complete staff workflow without mixing member-only controls", async () => {
    renderSurface();
    expect(await screen.findByText("April membership meeting")).toBeInTheDocument();
    expect(screen.getByText("Delivered to 14")).toBeInTheDocument();
    expect(screen.getByText("1 attendance entries")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.getByText("History gaps")).toBeInTheDocument();
    expect(screen.getByText(/days without a recorded milestone or decision/)).toBeInTheDocument();
    expect(screen.getByText("No formal votes were scheduled during the summer recess.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Contact log" }));
    expect(screen.getByText("Scheduling follow-up")).toBeInTheDocument();
    expect(screen.getByText("Jordan Lee")).toBeInTheDocument();
    expect(screen.getByText("Earlier management contact")).toBeInTheDocument();
    expect(screen.getByText("Earlier contact record")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Exports" }));
    expect(screen.getByRole("button", { name: "Build and download" })).toBeInTheDocument();
    expect(screen.getByText("Recent export receipts")).toBeInTheDocument();
  });

  it("tracks the selected record type and only gathers attendance for minutes", async () => {
    const { client } = renderSurface();
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "New minutes" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Attendance")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole("combobox", { name: "Record type" }), { target: { value: "milestone" } });
    expect(within(dialog).queryByText("Attendance")).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), { target: { value: "New chapter office" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Record" }), { target: { value: "Members opened a permanent meeting space." } });
    fireEvent.change(within(dialog).getByLabelText("Date and time"), { target: { value: "2026-08-29T13:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_institutional_record", expect.objectContaining({
      p_record_type: "milestone",
      p_action: "publish",
      p_attendance: [],
    })));
  });

  it("preserves authorized case and task links when a contact is edited", async () => {
    const { client } = renderSurface();
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "Contact log" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_chapter_contact_log", expect.objectContaining({
      p_contact_id: "contact-1",
      p_case_id: "case-1",
      p_task_id: "task-1",
    })));
  });

  it("builds a bounded export, downloads it, and refreshes the receipts", async () => {
    const createObjectURL = vi.fn(() => "blob:institutional-export");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    try {
      const { client, onNotice } = renderSurface();
      await screen.findByText("April membership meeting");
      fireEvent.click(screen.getByRole("button", { name: "Exports" }));
      fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-01" } });
      fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-08-30" } });
      fireEvent.click(screen.getByRole("button", { name: "Build and download" }));

      await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("request_filtered_organization_export", expect.objectContaining({
        p_domains: ["members"],
        p_format: "csv",
        p_from: new Date("2026-08-01T00:00:00").toISOString(),
        p_to: new Date("2026-08-30T23:59:59.999").toISOString(),
      })));
      expect(click).toHaveBeenCalledOnce();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:institutional-export");
      expect(onNotice).toHaveBeenCalledWith("Downloaded 1 authorized rows");
      expect(client.rpc.mock.calls.filter(([name]) => name === "get_institutional_records_workspace")).toHaveLength(2);
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("shows export failures and disables submission with no selected domains", async () => {
    renderSurface({ rpcOverride: async (name) => name === "request_filtered_organization_export"
      ? { data: null, error: { message: "Narrow the date range", code: "54000" } }
      : null });
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "Exports" }));
    const members = screen.getByRole("checkbox", { name: "Workers" });
    fireEvent.click(members);
    expect(screen.getByRole("button", { name: "Build and download" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Issues" }));
    fireEvent.click(screen.getByRole("button", { name: "Build and download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The export could not be built.");
  });

  it("hides staff-only attendance and delivery chips from members, whose payload always carries zero placeholders", async () => {
    const memberRecord = { ...workspace.records[0], attendance: [], versions: [], dispatch: { delivered: 0, failed: 0 } };
    renderSurface({ data: { canManage: false, canExport: false, records: [memberRecord], contacts: [], roster: [], exportRuns: [] } });
    expect(await screen.findByText("April membership meeting")).toBeInTheDocument();
    expect(screen.queryByText(/attendance entries/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delivered to/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  // UX-UG-EXPORT-HISTORY-TIMESTAMP-USES-BROWSER-LOCALE-20260920. The receipt
  // stamp used to be `new Date(run.created_at).toLocaleString()` with no locale
  // argument, so it followed the BROWSER's locale while every sibling list in
  // this panel followed the member's language. A Spanish member on an en-US
  // browser read "8/29/2026, 8:00:00 AM" under Spanish minutes and contact
  // dates. Asserted against a raw Intl formatter rather than the helper so the
  // test still fails if the call site silently drops back to the browser.
  it("stamps export receipts in the member's language, not the browser's", async () => {
    const createdAt = workspace.exportRuns[0].created_at;
    const collapse = (value) => String(value).replace(/[\u00a0\u202f]/g, " ");
    const stamped = (locale) => collapse(new Intl.DateTimeFormat(locale, {
      dateStyle: "medium", timeStyle: "short", hourCycle: "h12",
    }).format(new Date(createdAt)));

    const spanish = renderSurface({ lang: "es" });
    await screen.findByText("Actas");
    fireEvent.click(screen.getByRole("button", { name: "Exportaciones" }));
    const spanishStamp = collapse(spanish.container.querySelector(".institutional-runs p").textContent);
    expect(spanishStamp).toContain(stamped("es"));
    expect(spanishStamp).not.toContain(stamped("en-US"));
    spanish.unmount();

    renderSurface();
    await screen.findByText("Minutes");
    fireEvent.click(screen.getByRole("button", { name: "Exports" }));
    expect(collapse(document.querySelector(".institutional-runs p").textContent)).toContain(stamped("en-US"));
  });

  it("renders a no-client member fallback without staff controls", () => {
    render(<LanguageProvider lang="en"><InstitutionalRecordsPanel
      fallbackRecords={[{ id: "fallback-1", record_type: "meeting", title: "Fallback meeting", body: "Published fallback.", occurred_at: "2026-08-01T12:00:00.000Z" }]}
    /></LanguageProvider>);
    expect(screen.getByText("Fallback meeting")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Contact log" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Exports" })).not.toBeInTheDocument();
  });

  it("surfaces refresh, record archive, and contact archive failures", async () => {
    const { client } = renderSurface({ rpcOverride: async (name) => {
      if (name === "save_institutional_record") return { data: null, error: { message: "Record changed", code: "40001" } };
      if (name === "save_chapter_contact_log") return { data: null, error: { message: "Contact denied", code: "42501" } };
      return null;
    } });
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("The change could not be saved.");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    fireEvent.transitionEnd(document.querySelector(".dialog-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Contact log" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("The change could not be saved.");
    expect(screen.queryByText(/Contact denied/)).not.toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("save_chapter_contact_log", expect.objectContaining({ p_archive: true }));
  });

  it("shows a workspace load failure and can retry", async () => {
    let calls = 0;
    const { client } = renderSurface({ rpcOverride: async (name) => {
      if (name !== "get_institutional_records_workspace") return null;
      calls += 1;
      return calls === 1 ? { data: null, error: { message: "Workspace unavailable", code: "503" } } : { data: workspace, error: null };
    } });
    expect(await screen.findByRole("alert")).toHaveTextContent("The campaign record could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("April membership meeting")).toBeInTheDocument();
    expect(client.rpc.mock.calls.filter(([name]) => name === "get_institutional_records_workspace")).toHaveLength(2);
  });
});

// MINUTES-NOTIFICATION-REFRESH-OPEN-CHAPTER-RECORD (#3998): activating a minutes
// notice while the records page is already open must reload the workspace and
// show Minutes. The notice's source-chapter match and the backend's
// authorization are decided before the intent reaches the panel.
describe("minutes notification opened on an already-open chapter record", () => {
  const RECORD_PATH = "/m/organize/record";
  const newMinutes = {
    id: "minutes-2",
    record_type: "minutes",
    lifecycle_status: "published",
    title: "May membership meeting",
    body: "Members approved the summer schedule.",
    occurred_at: "2026-05-14T18:00:00.000Z",
    version: 1,
  };
  const refreshedWorkspace = { ...workspace, records: [newMinutes, ...workspace.records] };

  function mountedPanel() {
    let current = workspace;
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_institutional_records_workspace") return { data: current, error: null };
        throw new Error(`Unexpected RPC: ${name}`);
      }),
    };
    const view = (openIntent) => (
      <LanguageProvider lang="en">
        <InstitutionalRecordsPanel client={client} openIntent={openIntent} />
      </LanguageProvider>
    );
    const rendered = render(view(null));
    return { ...rendered, client, view, publish: () => { current = refreshedWorkspace; } };
  }
  const loads = (client) => client.rpc.mock.calls.filter(([name]) => name === "get_institutional_records_workspace").length;

  it("reloads the workspace and returns to Minutes when a notice is opened with the panel mounted", async () => {
    const { client, rerender, view, publish } = mountedPanel();
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    expect(screen.getByRole("button", { name: "Timeline" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("May membership meeting")).not.toBeInTheDocument();
    expect(loads(client)).toBe(1);

    publish();
    rerender(view({ id: 1, path: RECORD_PATH }));
    expect(await screen.findByText("May membership meeting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Minutes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Timeline" })).toHaveAttribute("aria-pressed", "false");
    expect(loads(client)).toBe(2);
  });

  it("refreshes again for a repeated notice, but not for the same intent re-rendered", async () => {
    const { client, rerender, view } = mountedPanel();
    await screen.findByText("April membership meeting");
    rerender(view({ id: 1, path: RECORD_PATH }));
    await waitFor(() => expect(loads(client)).toBe(2));
    rerender(view({ id: 1, path: RECORD_PATH }));
    expect(loads(client)).toBe(2);
    rerender(view({ id: 2, path: RECORD_PATH }));
    await waitFor(() => expect(loads(client)).toBe(3));
  });

  it("mounts normally from another page: the intent already present at mount adds no second load", async () => {
    let current = workspace;
    const client = { rpc: vi.fn(async () => ({ data: current, error: null })) };
    render(<LanguageProvider lang="en"><InstitutionalRecordsPanel client={client} openIntent={{ id: 7, path: RECORD_PATH }} /></LanguageProvider>);
    await screen.findByText("April membership meeting");
    expect(loads(client)).toBe(1);
    expect(screen.getByRole("button", { name: "Minutes" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ignores an intent for another destination", async () => {
    const { client, rerender, view } = mountedPanel();
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "Timeline" }));
    rerender(view({ id: 1, path: "/m/somewhere/else" }));
    expect(loads(client)).toBe(1);
    expect(screen.getByRole("button", { name: "Timeline" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is wired from the notification dialog through App and the hub, in memory only", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const hub = readFileSync("src/views/ProductHubView.jsx", "utf8");
    expect(app).toContain("setNotificationOpenIntent({ id: notificationOpenCounter.current, path: destination.path })");
    expect(app).toContain("notificationOpenIntent={notificationOpenIntent}");
    expect(app).toContain("const [notificationOpenIntent, setNotificationOpenIntent] = useState(null);");
    expect(hub).toContain("openIntent={notificationOpenIntent}");
  });
});

// An editor's Save stays focusable while its write runs.
describe("institutional record editors keep focus while they save", () => {
  it("keeps the contact editor's Save focused while the contact is saved, and saves it once", async () => {
    const { client } = renderSurface();
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "Contact log" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const saves = () => client.rpc.mock.calls.filter(([name]) => name === "save_chapter_contact_log").length;
    await expectHeldWriteFocus(client.rpc, within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saves()).toBe(1));
  });
});

// Each records lock refuses a second write started in the same
// tick, before busy commits (Main's `if (busy) return` reads a stale busy).
describe("institutional record writes started twice in one tick", () => {
  it("saves a record once when Save draft and Publish are activated in one tick", async () => {
    const row = { ...workspace.records[0], access_unit_id: "u", access_committee_id: null };
    const data = { ...workspace, chapterId: "chapter", organizationId: "org", canManageUnscoped: true, records: [row],
      recordScopes: [{ role: "secretary", unitId: "u", name: "Garage", records: true }] };
    const { client } = renderSurface({ data, rpcOverride: async (name) => name === "save_chapter_minutes" ? { data: { saved: true } } : null });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save draft" });
    const publish = within(dialog).getByRole("button", { name: /^Publish/ });
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(save), () => fireEvent.click(publish)], { isWrite: isRpcWrite });
  });

  it("saves a contact once when its Save is activated twice in one tick", async () => {
    const { client } = renderSurface();
    await screen.findByText("April membership meeting");
    fireEvent.click(screen.getByRole("button", { name: "Contact log" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = within(screen.getByRole("dialog")).getByRole("button", { name: "Save" });
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(save), () => fireEvent.click(save)], { isWrite: isRpcWrite });
  });

  it("builds one export when Build and download is activated twice in one tick", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:institutional-export"), revokeObjectURL: vi.fn() });
    try {
      const { client } = renderSurface();
      await screen.findByText("April membership meeting");
      fireEvent.click(screen.getByRole("button", { name: "Exports" }));
      fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-01" } });
      fireEvent.change(screen.getByLabelText("Through"), { target: { value: "2026-08-30" } });
      const build = screen.getByRole("button", { name: "Build and download" });
      await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(build), () => fireEvent.click(build)], { isWrite: isRpcWrite });
      expect(client.rpc.mock.calls.filter(([name]) => name === "request_filtered_organization_export")).toHaveLength(1);
    } finally {
      click.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
