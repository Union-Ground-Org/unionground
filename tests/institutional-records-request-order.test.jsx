import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstitutionalRecordsPanel } from "../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";

afterEach(cleanup);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function workspace(title = "Current minutes", canManage = false) {
  return {
    canManage, canExport: false, contacts: [], roster: [], exportRuns: [],
    records: [{
      id: "minutes-1", record_type: "minutes", lifecycle_status: "published",
      title, body: "Fictional meeting record.", occurred_at: "2026-10-20T16:00:00-04:00",
      event_id: "meeting-1",
    }],
  };
}

function clientFor(read, { notices = { enabled: true, notices: [] }, meetings = [] } = {}) {
  return {
    rpc: vi.fn((name) => {
      const data = name === "get_institutional_records_workspace" ? read
        : name === "get_minutes_pre_event_notices" ? notices : meetings;
      return Promise.resolve(data).then((value) => ({ data: value, error: null }));
    }),
  };
}

function panel(client) {
  return <LanguageProvider lang="en"><InstitutionalRecordsPanel client={client} canStaff /></LanguageProvider>;
}

describe("institutional records request ordering", () => {
  it("keeps the new client's minutes when an older workspace read finishes last", async () => {
    const old = deferred();
    const next = deferred();
    const view = render(panel(clientFor(old.promise)));
    view.rerender(panel(clientFor(next.promise)));
    await act(async () => { next.resolve(workspace()); });
    expect(screen.getByText("Current minutes")).toBeInTheDocument();
    await act(async () => { old.resolve(workspace("Retired minutes")); });
    expect(screen.getByText("Current minutes")).toBeInTheDocument();
    expect(screen.queryByText("Retired minutes")).not.toBeInTheDocument();
  });

  it("ignores a retired failure after the current workspace succeeds", async () => {
    const old = deferred();
    const view = render(panel(clientFor(old.promise)));
    view.rerender(panel(clientFor(workspace())));
    await screen.findByText("Current minutes");
    await act(async () => { old.reject(new Error("retired request offline")); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Current minutes")).toBeInTheDocument();
  });

  it("does not let an obsolete completion clear the current loading state", async () => {
    const old = deferred();
    const next = deferred();
    const view = render(panel(clientFor(old.promise)));
    view.rerender(panel(clientFor(next.promise)));
    await act(async () => { old.resolve(workspace("Retired minutes")); });
    expect(screen.getByText(t("en", "records.loading"))).toBeInTheDocument();
    expect(screen.queryByText("Retired minutes")).not.toBeInTheDocument();
    await act(async () => { next.resolve(workspace()); });
    expect(screen.getByText("Current minutes")).toBeInTheDocument();
  });

  it("keeps current optional notices when a retired notice read finishes", async () => {
    const oldNotices = deferred();
    const oldClient = clientFor(workspace("Current minutes", true), { notices: oldNotices.promise });
    const view = render(panel(oldClient));
    await waitFor(() => expect(oldClient.rpc).toHaveBeenCalledWith("get_minutes_pre_event_notices"));
    view.rerender(panel(clientFor(workspace("Current minutes", true))));
    await screen.findByText("Current minutes");
    await act(async () => { oldNotices.resolve({ enabled: false, notices: [] }); });
    expect(screen.queryByText(t("en", "preEvent.turnedOff"))).not.toBeInTheDocument();
    // The two soft reads start together; the retired chain reads nothing more.
    expect(oldClient.rpc.mock.calls.map(([name]) => name)).toEqual([
      "get_institutional_records_workspace", "get_minutes_pre_event_notices", "get_admin_events",
    ]);
  });

  it("keeps current meeting data when an older meeting read finishes", async () => {
    const oldMeetings = deferred();
    const oldClient = clientFor(workspace("Current minutes", true), { meetings: oldMeetings.promise });
    const view = render(panel(oldClient));
    await waitFor(() => expect(oldClient.rpc).toHaveBeenCalledWith("get_admin_events"));
    view.rerender(panel(clientFor(workspace("Current minutes", true), { meetings: [{ id: "meeting-1", title: "Current meeting" }] })));
    await screen.findByText(t("en", "records.meeting", { event: "Current meeting" }));
    await act(async () => { oldMeetings.resolve([{ id: "meeting-1", title: "Retired meeting" }]); });
    expect(screen.getByText(t("en", "records.meeting", { event: "Current meeting" }))).toBeInTheDocument();
    expect(screen.queryByText(t("en", "records.meeting", { event: "Retired meeting" }))).not.toBeInTheDocument();
  });

  it("stops the pending read chain when the panel unmounts", async () => {
    const read = deferred();
    const client = clientFor(read.promise);
    const view = render(panel(client));
    view.unmount();
    await act(async () => { read.resolve(workspace("Retired minutes", true)); });
    expect(client.rpc.mock.calls).toEqual([["get_institutional_records_workspace"]]);
  });

  it("reports current workspace errors and still tolerates optional-read failures", async () => {
    const failed = deferred();
    const view = render(panel(clientFor(failed.promise)));
    await act(async () => { failed.reject(new Error("current request offline")); });
    expect(screen.getByRole("alert")).toHaveTextContent(t("en", "records.loadFailed"));
    const client = clientFor(workspace("Current minutes", true));
    client.rpc.mockImplementation((name) => name === "get_institutional_records_workspace"
      ? Promise.resolve({ data: workspace("Current minutes", true), error: null })
      : Promise.reject(new Error("optional read unavailable")));
    view.rerender(panel(client));
    await screen.findByText("Current minutes");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
