// @vitest-environment jsdom
// Restore lane L7b AUTOMATION-2 web surfaces:
//   REQ-UG-MINUTES-PRE-EVENT-DISPATCH-20261001 (institutional records)
//   REQ-UG-SCHEDULED-EXPORTS-PARITY-20261001 (coordination desk)
//   REQ-UG-RETENTION-DEFAULT-POLICIES-20261001 (retention card)
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstitutionalRecordsPanel } from "../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { CoordinationWorkflowPanels } from "../src/features/coordination/ui/CoordinationWorkflowPanels.jsx";
import { OrganizationCoordinationDesk } from "../src/features/coordination/ui/OrganizationCoordinationDesk.jsx";
import { EMPTY_COORDINATION_EXTENSIONS } from "../src/features/coordination/contract.js";
import { RetentionEnginePanel } from "../src/features/retention/RetentionEnginePanel.jsx";
import { downloadCoordinationExport, OrganizationCoordinationView } from "../src/views/OrganizationCoordinationView.jsx";
import { buildCoordinationActor } from "../src/lib/mi1CoordinationWiring.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { automationRestoreCatalogue } from "../src/lib/i18n/automationRestore.js";
import { XLSX_MIME } from "../src/lib/xlsxWorkbook.js";
import { expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const minutesRecord = {
  id: "minutes-1",
  record_type: "minutes",
  lifecycle_status: "draft",
  visibility: "chapter",
  title: "June membership meeting",
  body: "Agenda and minutes.",
  occurred_at: "2026-06-10T18:00:00.000Z",
  version: 1,
};

const workspace = { canManage: true, canExport: false, records: [minutesRecord], contacts: [], roster: [], exportRuns: [] };

function preEventConfig(overrides = {}) {
  return {
    enabled: true,
    defaultHours: 24,
    notices: [],
    events: [{ id: "meeting-1", title: "General meeting", startsAt: "2026-10-20T22:00:00.000Z" }],
    ...overrides,
  };
}

function renderRecords({ config = preEventConfig(), records = [minutesRecord], lang = "en" } = {}) {
  const client = {
    rpc: vi.fn(async (name) => {
      if (name === "get_institutional_records_workspace") return { data: { ...workspace, records }, error: null };
      if (name === "get_minutes_pre_event_notices") return { data: config, error: null };
      if (name === "save_minutes_pre_event_notice") return { data: { recordId: "minutes-1", status: "scheduled" }, error: null };
      if (name === "clear_minutes_pre_event_notice") return { data: { recordId: "minutes-1", removed: true }, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    }),
  };
  const onNotice = vi.fn();
  render(<LanguageProvider lang={lang}><InstitutionalRecordsPanel client={client} canStaff onNotice={onNotice} /></LanguageProvider>);
  return { client, onNotice };
}

describe("pre-meeting minutes notice", () => {
  it("rejects a zero-hour notice without sending the scheduling RPC", async () => {
    const { client } = renderRecords();
    fireEvent.click(await screen.findByRole('button', { name:'Schedule pre-meeting notice' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name:'Meeting' }), { target:{value:'meeting-1'} });
    const hours = within(dialog).getByRole('spinbutton', { name:'Hours before the meeting' });
    expect(hours).toHaveAttribute('min','1');
    fireEvent.change(hours,{target:{value:'0'}});
    fireEvent.submit(dialog.querySelector('form'));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('The pre-meeting notice could not be saved.'));
    expect(client.rpc.mock.calls.some(([name])=>name==='save_minutes_pre_event_notice')).toBe(false);
  });

  it("schedules a notice for an upcoming chapter meeting with the chosen audience and lead time", async () => {
    const { client, onNotice } = renderRecords();
    fireEvent.click(await screen.findByRole("button", { name: "Schedule pre-meeting notice" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Leave blank to use your organization's default of 24 hours/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Meeting" }), { target: { value: "meeting-1" } });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Who to tell" }), { target: { value: "stewards_only" } });
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "Hours before the meeting" }), { target: { value: "48" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save notice" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_minutes_pre_event_notice", {
      p_record_id: "minutes-1", p_event_id: "meeting-1", p_audience: "stewards_only", p_hours_before: 48,
    }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Pre-meeting notice saved"));
  });

  it("sends a blank lead time as the organization default and removes an existing notice", async () => {
    const notice = { recordId: "minutes-1", eventId: "meeting-1", eventTitle: "General meeting", eventStartsAt: "2026-10-20T22:00:00.000Z", audience: "all_members", hoursBefore: null, status: "scheduled" };
    const { client, onNotice } = renderRecords({ config: preEventConfig({ notices: [notice] }) });
    expect(await screen.findByText(/Notice before General meeting/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change pre-meeting notice" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save notice" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("save_minutes_pre_event_notice", expect.objectContaining({ p_hours_before: null, p_audience: "all_members" })));
    fireEvent.click(await screen.findByRole("button", { name: "Change pre-meeting notice" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove notice" }));
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("clear_minutes_pre_event_notice", { p_record_id: "minutes-1" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Pre-meeting notice removed"));
  });

  // The notice:<record> lock refuses a second save or a removal
  // started in the same tick, before busy commits.
  it("writes one notice change when Save notice and Remove notice are activated in one tick", async () => {
    const notice = { recordId: "minutes-1", eventId: "meeting-1", eventTitle: "General meeting", eventStartsAt: "2026-10-20T22:00:00.000Z", audience: "all_members", hoursBefore: null, status: "scheduled" };
    const { client } = renderRecords({ config: preEventConfig({ notices: [notice] }) });
    fireEvent.click(await screen.findByRole("button", { name: "Change pre-meeting notice" }));
    const dialog = screen.getByRole("dialog");
    const save = within(dialog).getByRole("button", { name: "Save notice" });
    const remove = within(dialog).getByRole("button", { name: "Remove notice" });
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(save), () => fireEvent.click(save), () => fireEvent.click(remove)]);
  });

  it("names a sent or expired notice and offers only stewards for a staff-only record", async () => {
    const records = [
      { ...minutesRecord, visibility: "staff" },
      { ...minutesRecord, id: "minutes-2", title: "May minutes" },
    ];
    const notices = [
      { recordId: "minutes-1", eventTitle: "General meeting", status: "sent", recipientCount: 12 },
      { recordId: "minutes-2", eventTitle: "May meeting", status: "expired", outcome: "event_cancelled" },
    ];
    renderRecords({ records, config: preEventConfig({ notices, events: [] }) });
    expect(await screen.findByText("Notice for General meeting sent to 12")).toBeInTheDocument();
    expect(screen.getByText("Not sent: May meeting was cancelled")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Change pre-meeting notice" })[0]);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/This campaign has no upcoming meetings/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save notice" })).toBeDisabled();
  });

  it("offers only the steward audience for staff-only minutes and says so", async () => {
    renderRecords({ records: [{ ...minutesRecord, visibility: "staff" }] });
    fireEvent.click(await screen.findByRole("button", { name: "Schedule pre-meeting notice" }));
    const audience = within(screen.getByRole("dialog")).getByRole("combobox", { name: "Who to tell" });
    expect([...audience.options].map((option) => option.value)).toEqual(["stewards_only"]);
    expect(screen.getByText(/These minutes are staff-only/)).toBeInTheDocument();
  });

  it("shows a switched-off organization honestly instead of a dead control, in Spanish too", async () => {
    renderRecords({ config: preEventConfig({ enabled: false }), lang: "es" });
    expect(await screen.findByText(/Los avisos previos a las reuniones están desactivados/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /aviso previo/ })).not.toBeInTheDocument();
  });

  it("reports a refused save inside the dialog", async () => {
    const { client } = renderRecords();
    client.rpc.mockImplementation(async (name) => {
      if (name === "get_institutional_records_workspace") return { data: workspace, error: null };
      if (name === "get_minutes_pre_event_notices") return { data: preEventConfig(), error: null };
      return { data: null, error: { message: "refused", code: "42501" } };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Schedule pre-meeting notice" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Meeting" }), { target: { value: "meeting-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save notice" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The pre-meeting notice could not be saved.");
  });
});

const admin = buildCoordinationActor({
  userId: "user-1", organizationId: "org-1", membershipStatus: "active", selectedHat: "admin",
  organizationRoles: ["admin"], mfaSatisfied: true, sessionScope: "resolved", chapterId: "wor",
});
const coordinator = buildCoordinationActor({ ...admin, selectedHat: "coordinator", organizationRoles: ["coordinator"] });

describe("scheduled export parity in the coordination desk", () => {
  function operations(actor, exportRuns, records = []) {
    const actions = { onDownloadExport: vi.fn(), onReviewMergeMatch: vi.fn(), onExecuteMerge: vi.fn() };
    render(<LanguageProvider lang="en"><CoordinationWorkflowPanels
      tab="operations"
      actor={actor}
      model={{ state: "ready", organizationId: "org-1", staff: true, records, exportRuns }}
      extensions={{ ...EMPTY_COORDINATION_EXTENSIONS, state: "ready", organizationId: "org-1" }}
      busy={false}
      actions={actions}
    /></LanguageProvider>);
    return actions;
  }

  it("names each run's dataset and settled delivery, and offers CSV and XLSX where the server allows a download", () => {
    const actions = operations(admin, [
      { id: "run-email", scheduleId: "schedule-1", format: "csv", status: "not_configured", rowCount: 3, deliveryMode: "email_unset" },
      { id: "run-sftp", dataset: "events", format: "json", status: "not_configured", rowCount: 2, deliveryMode: "sftp_unset" },
      { id: "run-queued", dataset: "resources", format: "csv", status: "queued", rowCount: 1, deliveryMode: "email_unset" },
      { id: "run-skipped", dataset: "broadcast_log", format: "csv", status: "skipped", rowCount: 0, deliveryMode: "internal_download" },
    ], [{ id: "schedule-1", kind: "network_export_schedule", config: { dataset: "members_directory" } }]);
    expect(screen.getByText(/Workers directory \(name, role, campaign\) · email delivery is not set up for this site/)).toBeInTheDocument();
    expect(screen.getByText(/Meetings · SFTP delivery is not available on this site/)).toBeInTheDocument();
    expect(screen.getByText(/Resources · waiting for delivery/)).toBeInTheDocument();
    expect(screen.getByText(/Broadcast log · skipped while dataset exports are turned off/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Download export" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Download XLSX" })[0]);
    expect(actions.onDownloadExport).toHaveBeenCalledWith("run-email", "xlsx");
  });

  it("does not offer a coordinator the workers directory the server refuses them", () => {
    operations(coordinator, [
      { id: "run-directory", dataset: "members_directory", format: "csv", status: "ready", rowCount: 3, deliveryMode: "internal_download" },
      { id: "run-delivered", dataset: "events", format: "csv", status: "delivered", rowCount: 3, deliveryMode: "email_unset" },
    ]);
    expect(screen.getAllByRole("button", { name: "Download export" })).toHaveLength(1);
    expect(screen.getByText(/Meetings · download link emailed/)).toBeInTheDocument();
  });

  function renderDesk(actor, datasetExportsEnabled) {
    const onCreate = vi.fn(async () => true);
    render(<LanguageProvider lang="en"><OrganizationCoordinationDesk
      actor={actor}
      model={{ state: "ready", organizationId: "org-1", staff: true, records: [], leaderboards: [], messages: [], resources: [], exportRuns: [], outreach: [], directory: [], micrositeEditor: { state: "missing" } }}
      status="ready"
      onCreate={onCreate}
      datasetExportsEnabled={datasetExportsEnabled}
    /></LanguageProvider>);
    fireEvent.click(screen.getByRole("tab", { name: "Operations" }));
    const creator = within(screen.getByLabelText("Create coordination work"));
    fireEvent.change(creator.getByLabelText("Workflow"), { target: { value: "network_export_schedule" } });
    return { onCreate, creator };
  }

  it("creates a dataset schedule with email delivery when the organization switch is on", async () => {
    const { onCreate, creator } = renderDesk(admin, true);
    const dataset = creator.getByLabelText("Dataset");
    expect([...dataset.options].map((option) => option.value)).toEqual([
      "coordination_records", "members_directory", "events", "resources", "knowledge_articles", "broadcast_log",
    ]);
    fireEvent.change(dataset, { target: { value: "members_directory" } });
    fireEvent.change(creator.getByLabelText("Delivery"), { target: { value: "email_unset" } });
    fireEvent.change(creator.getByLabelText("First run"), { target: { value: "2026-10-05T09:00" } });
    fireEvent.change(creator.getByLabelText("Title"), { target: { value: "Weekly directory" } });
    fireEvent.click(creator.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      kind: "network_export_schedule",
      config: expect.objectContaining({ dataset: "members_directory", deliveryMode: "email_unset" }),
    }), expect.any(Function)));
    expect(creator.getByText(/An email carries only a sign-in link, never the data/)).toBeInTheDocument();
  });

  it("offers coordination records only while the switch is off, and the directory never to a coordinator", async () => {
    const { creator, onCreate } = renderDesk(coordinator, false);
    expect([...creator.getByLabelText("Dataset").options].map((option) => option.value)).toEqual(["coordination_records"]);
    expect(creator.getByText(/appear here when an organization admin turns on scheduled dataset exports/)).toBeInTheDocument();
    fireEvent.change(creator.getByLabelText("First run"), { target: { value: "2026-10-05T09:00" } });
    fireEvent.change(creator.getByLabelText("Title"), { target: { value: "Coordination export" } });
    fireEvent.click(creator.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].config).not.toHaveProperty("dataset");
  });

  it("lists the restored datasets except the directory for a coordinator when the switch is on", () => {
    const { creator } = renderDesk(coordinator, true);
    expect([...creator.getByLabelText("Dataset").options].map((option) => option.value)).not.toContain("members_directory");
  });

  it("reads the organization switch for the desk from the member configuration", async () => {
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_member_organization_configuration") return { data: { switches: { "features.automation.scheduled_dataset_exports": true } }, error: null };
        return { data: null, error: { message: "unavailable" } };
      }),
    };
    render(<LanguageProvider lang="en"><OrganizationCoordinationView actor={admin} client={client} api={{
      load: vi.fn(async () => ({ state: "ready", organizationId: "org-1", staff: true, records: [], leaderboards: [], messages: [], resources: [], exportRuns: [], outreach: [] })),
    }} /></LanguageProvider>);
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("get_member_organization_configuration", {}));
  });

  it("saves the same rows as an XLSX workbook and refuses a payload without a table", () => {
    const created = [];
    vi.stubGlobal("URL", Object.assign(Object.create(URL), {
      createObjectURL: vi.fn((blob) => { created.push(blob); return "blob:export"; }),
      revokeObjectURL: vi.fn(),
    }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const payload = {
      content: "\"name\",\"role\"\n\"A\",\"admin\"",
      filename: "members-directory-export-20261002120000.csv",
      mimeType: "text/csv",
      table: { columns: ["name", "role"], rows: [["A", "admin"]] },
    };
    downloadCoordinationExport(payload, { xlsx: true });
    expect(created[0].type).toBe(XLSX_MIME);
    downloadCoordinationExport(payload);
    expect(created[1].type).toBe("text/csv");
    expect(() => downloadCoordinationExport({ ...payload, table: null }, { xlsx: true })).toThrow("export download unavailable");
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });
});

describe("retention default policies in the admin card", () => {
  const api = { saveRetentionPolicy: vi.fn(async () => ({})), previewRetentionRun: vi.fn(), authorizeRetentionRun: vi.fn(), executeRetentionRun: vi.fn() };

  it("shows suggested windows with deletion off until an admin explicitly enables a rule", () => {
    render(<LanguageProvider lang="en"><RetentionEnginePanel
      engine={{
        organizationId: "org-1",
        schedulerConfigured: true,
        runs: [],
        policies: [
          { dataClass: "member_notifications", retentionDays: 365, minimumDays: 30, maximumDays: 3650, defaultDays: 365, executionEnabled: false, defaultExecutionEnabled: false, configured: false },
          { dataClass: "ai_usage_counters", retentionDays: 30, minimumDays: 1, maximumDays: 365, defaultDays: 30, executionEnabled: true, defaultExecutionEnabled: false, configured: true },
          { dataClass: "member_message_bodies", retentionDays: 1095, minimumDays: 365, maximumDays: 2555, defaultDays: 1095, executionEnabled: false, defaultExecutionEnabled: false, configured: false },
        ],
      }}
      api={api}
      reload={vi.fn()}
      onNotice={vi.fn()}
    /></LanguageProvider>);
    expect(screen.getByText("In-app notifications")).toBeInTheDocument();
    expect(screen.queryByText("On by default")).not.toBeInTheDocument();
    expect(screen.getByText(/Suggested window: 365 days. Automatic deletion is off/)).toBeInTheDocument();
    expect(screen.getByText("AI assistant usage counters")).toBeInTheDocument();
    expect(screen.getByText("Execution enabled")).toBeInTheDocument();
    expect(screen.getAllByText(/Suggested window: .* days. Automatic deletion is off/)).toHaveLength(2);
    expect(screen.queryByText(/Deleted after .* days by default/)).not.toBeInTheDocument();
  });
});

describe("lane catalogue", () => {
  it("declares every key in English and Spanish and reaches the shared catalogue", () => {
    expect(Object.keys(automationRestoreCatalogue.es).sort()).toEqual(Object.keys(automationRestoreCatalogue.en).sort());
    for (const key of Object.keys(automationRestoreCatalogue.en)) {
      expect(catalogue.en[key]).toBe(automationRestoreCatalogue.en[key]);
      expect(catalogue.es[key]).toBe(automationRestoreCatalogue.es[key]);
    }
  });
});
