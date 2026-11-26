import { expectHeldWriteFocus, expectPendingFocus } from "./helpers/busyWriteFocus.js";
// REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006:
// the case tools rename a case and keep the deadline editor, and a steward
// keeps private dated reminders that can be attached to a case later (owner
// answer 11=A). Union Ground issues have no grievance step to edit.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import { StewardPrivateReminders } from "../src/components/StewardPrivateReminders.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { renameCaseworkCase, saveStewardPrivateReminder } from "../src/lib/caseworkApi.js";

const caseData = {
  scope: { id: "case-1", organization_id: "org-1", chapter_id: "ch-1", title: "On March 3 my supervisor told me", step: "Intake", status: "active", is_restricted: false },
  strength: [], deadlines: [], checklists: [], transitions: [], alerts: [], management: [], retaliation: [], links: [], reminders: [],
};

function panelApi(overrides = {}) {
  return { loadCaseworkCase: vi.fn().mockResolvedValue(caseData), renameCase: vi.fn().mockResolvedValue({ changed: true }), ...overrides };
}

function wrap(node, lang = "en") {
  return render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
}

describe("case rename in the case tools", () => {
  it("shows the current title and sends the trimmed new title with a closed reason", async () => {
    const api = panelApi();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    wrap(<CaseworkOperationsPanel caseId="case-1" api={api} onChanged={onChanged} />);
    const section = (await screen.findByRole("heading", { name: "Issue title" })).closest("article");
    expect(within(section).getByText("On March 3 my supervisor told me")).toBeInTheDocument();
    fireEvent.change(within(section).getByLabelText("New title"), { target: { value: "  Lift #4 overtime denial  " } });
    fireEvent.change(within(section).getByLabelText("Why rename"), { target: { value: "member_request" } });
    fireEvent.click(within(section).getByRole("button", { name: "Rename issue" }));
    await waitFor(() => expect(api.renameCase).toHaveBeenCalledWith("case-1", "Lift #4 overtime denial", "member_request"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("offers no rename control without the rename route, and speaks Spanish", async () => {
    const { unmount } = wrap(<CaseworkOperationsPanel caseId="case-1" api={panelApi({ renameCase: undefined })} />);
    await screen.findByText("Issue tools");
    expect(screen.queryByRole("heading", { name: "Issue title" })).toBeNull();
    unmount();
    wrap(<CaseworkOperationsPanel caseId="case-1" api={panelApi()} />, "es");
    const section = (await screen.findByRole("heading", { name: "Título del asunto" })).closest("article");
    expect(within(section).getByRole("button", { name: "Cambiar título" })).toBeInTheDocument();
    expect(within(section).getByRole("option", { name: "Lo pidió el trabajador/a" })).toBeInTheDocument();
  });

  // Union Ground issues have no grievance step: the case tools offer no
  // step editor or step focus target, while the title and deadline tools stay.
  it("offers no step editor or step focus target", async () => {
    const { container } = wrap(<CaseworkOperationsPanel caseId="case-1" api={panelApi()} />);
    expect(await screen.findByRole("heading", { name: "Issue title" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deadline center" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Step progression" })).toBeNull();
    expect(container.querySelector("#casework-step-case-1")).toBeNull();
    expect(screen.queryByRole("button", { name: /advance|next step/i })).toBeNull();
  });
});

describe("caseworkApi rename and private reminder routes", () => {
  it("calls the audited RPCs with trimmed text", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    await renameCaseworkCase(client, "case-1", "  New title ", "clearer_title");
    expect(client.rpc).toHaveBeenCalledWith("casework_rename_case", { p_case_id: "case-1", p_title: "New title", p_reason: "clearer_title" });
    await saveStewardPrivateReminder(client, { title: " File by Oct 16 ", remindOn: "2026-10-16" });
    expect(client.rpc).toHaveBeenCalledWith("steward_save_private_reminder", { p_title: "File by Oct 16", p_remind_on: "2026-10-16", p_case_id: null });
  });
});

const reminder = { id: "r-1", title: "Grievance filing window closes", remindOn: "2026-10-16", caseId: null, caseReference: null };

function reminderApi(overrides = {}) {
  return {
    listPrivateReminders: vi.fn().mockResolvedValue([reminder]),
    savePrivateReminder: vi.fn().mockResolvedValue([reminder, { ...reminder, id: "r-2", title: "Call the member" }]),
    attachPrivateReminder: vi.fn().mockResolvedValue([{ ...reminder, caseId: "case-1", caseReference: "GR-2026-87243" }]),
    deletePrivateReminder: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

const cases = [{ id: "case-1", reference: "GR-2026-87243", title: "Lift #4" }];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function submitReminder() {
  fireEvent.change(screen.getByLabelText("What to remember"), { target: { value: reminder.title } });
  fireEvent.change(screen.getByLabelText("Date"), { target: { value: reminder.remindOn } });
  fireEvent.click(screen.getByRole("button", { name: "Save reminder" }));
}

describe("steward private reminders", () => {
  it.each(["resolve", "reject"])("locks the submitted draft until a deferred save %ss", async (settle) => {
    const save = deferred();
    const api = reminderApi({ savePrivateReminder: vi.fn(() => save.promise) });
    wrap(<StewardPrivateReminders api={api} />);
    await screen.findByText(reminder.title);
    submitReminder();
    const title = screen.getByLabelText("What to remember");
    const date = screen.getByLabelText("Date");
    expect((title).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(title);
    expect((date).closest('[aria-disabled="true"]')).not.toBeNull();
    expect(api.savePrivateReminder).toHaveBeenCalledWith({ title: reminder.title, remindOn: reminder.remindOn });
    await act(async () => save[settle](settle === "resolve" ? [reminder] : new Error("offline")));
    expect(title).toBeEnabled();
    expect(date).toBeEnabled();
    expect(title).toHaveValue(settle === "resolve" ? "" : reminder.title);
    expect(date).toHaveValue(settle === "resolve" ? "" : reminder.remindOn);
  });

  it.each(["resolve", "reject"])("keeps a confirmed save when the initial read later %ss", async (settle) => {
    const read = deferred();
    const api = reminderApi({ listPrivateReminders: vi.fn(() => read.promise), savePrivateReminder: vi.fn().mockResolvedValue([reminder]) });
    wrap(<StewardPrivateReminders api={api} />);
    submitReminder();
    await screen.findByText(reminder.title);
    await act(async () => read[settle](settle === "resolve" ? [] : new Error("old read")));
    expect(screen.getByText(reminder.title)).toBeInTheDocument();
    expect(screen.queryByText("No private reminders yet.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("does not restore a deleted row from a retry started during the deletion", async () => {
    const deletion = deferred(), retry = deferred();
    const view = wrap(<StewardPrivateReminders api={reminderApi()} />);
    await screen.findByText(reminder.title);
    const api = reminderApi({ listPrivateReminders: vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => retry.promise), deletePrivateReminder: vi.fn(() => deletion.promise) });
    view.rerender(<LanguageProvider lang="en"><StewardPrivateReminders api={api} /></LanguageProvider>);
    await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await act(async () => deletion.resolve([]));
    expect(screen.getByText("No private reminders yet.")).toBeInTheDocument();
    await act(async () => retry.resolve([reminder]));
    expect(screen.queryByText(reminder.title)).toBeNull();
  });

  it("keeps the newer retry when overlapping retries finish in reverse order", async () => {
    const first = deferred(), second = deferred();
    const api = reminderApi({ listPrivateReminders: vi.fn().mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise) });
    wrap(<StewardPrivateReminders api={api} />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(api.listPrivateReminders).toHaveBeenCalledTimes(3);
    await act(async () => second.resolve([reminder]));
    await act(async () => first.resolve([]));
    expect(screen.getByText(reminder.title)).toBeInTheDocument();
  });

  it("rejects extended years in the form and accepts supported endpoint dates", () => {
    wrap(<StewardPrivateReminders api={reminderApi({ listPrivateReminders: () => new Promise(() => {}) })} />);
    const date = screen.getByLabelText("Date");
    for (const value of ["0001-01-01", "9999-12-31"]) {
      fireEvent.change(date, { target: { value } });
      expect(date.checkValidity()).toBe(true);
    }
    fireEvent.change(date, { target: { value: "10000-01-01" } });
    expect(date.checkValidity()).toBe(false);
  });

  it.each(["10000-01-01", "infinity", "-infinity", "0000-01-01", "2026-02-30", null])("keeps legacy unsupported date %s deletable after load", async (remindOn) => {
    const api = reminderApi({ listPrivateReminders: vi.fn().mockResolvedValue([{ ...reminder, remindOn }]) });
    wrap(<StewardPrivateReminders api={api} />);
    expect(await screen.findByText(reminder.title)).toBeInTheDocument();
    expect(screen.getByText("Date unavailable")).toBeInTheDocument();
    await expectHeldWriteFocus(api.deletePrivateReminder, screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("No private reminders yet.")).toBeInTheDocument();
    expect(api.deletePrivateReminder).toHaveBeenCalledWith(reminder.id);
  });

  it("records a dated reminder before a case exists", async () => {
    const api = reminderApi();
    const onNotice = vi.fn();
    wrap(<StewardPrivateReminders api={api} caseOptions={cases} onNotice={onNotice} />);
    expect(await screen.findByText("Grievance filing window closes")).toBeInTheDocument();
    expect(screen.getByText("Oct 16, 2026")).toBeInTheDocument();
    expect(screen.getByText(/Only you see these/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("What to remember"), { target: { value: " Call the member " } });
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-10-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reminder" }));
    await waitFor(() => expect(api.savePrivateReminder).toHaveBeenCalledWith({ title: "Call the member", remindOn: "2026-10-20" }));
    expect(await screen.findByText("Call the member")).toBeInTheDocument();
    const form = screen.getByRole("button", { name: "Save reminder" }).closest("form");
    expect(within(form).getByRole("status")).toHaveTextContent("Private reminders updated.");
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("attaches a reminder to a case once one is opened, and deletes", async () => {
    const api = reminderApi();
    wrap(<StewardPrivateReminders api={api} caseOptions={cases} />);
    await screen.findByText("Grievance filing window closes");
    fireEvent.change(screen.getByLabelText("Attach to case"), { target: { value: "case-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(api.attachPrivateReminder).toHaveBeenCalledWith("r-1", "case-1"));
    expect(await screen.findByText("Attached to GR-2026-87243")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deletePrivateReminder).toHaveBeenCalledWith("r-1"));
    expect(await screen.findByText("No private reminders yet.")).toBeInTheDocument();
  });

  it("keeps a refused row action separate from feedback on the add form", async () => {
    const onNotice = vi.fn();
    const api = reminderApi({ deletePrivateReminder: vi.fn().mockRejectedValue({ code: "22023" }) });
    wrap(<StewardPrivateReminders api={api} onNotice={onNotice} />);
    await screen.findByText(reminder.title);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That reminder could not be saved."));
    const form = screen.getByRole("button", { name: "Save reminder" }).closest("form");
    expect(within(form).getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText(reminder.title)).toBeInTheDocument();
  });

  it("says a failed read failed instead of showing an empty list, in Spanish too", async () => {
    const api = reminderApi({ listPrivateReminders: vi.fn().mockRejectedValue(new Error("boom")) });
    wrap(<StewardPrivateReminders api={api} />, "es");
    expect(await screen.findByText(/No se pudieron cargar tus recordatorios privados/)).toBeInTheDocument();
    expect(screen.queryByText("Aún no hay recordatorios privados.")).toBeNull();
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeInTheDocument();
  });

  it.each([
    ["en", "What to remember", "Date", "Save reminder", "That reminder could not be saved.", "Private reminders updated."],
    ["es", "Qué recordar", "Fecha", "Guardar recordatorio", "No se pudo guardar ese recordatorio.", "Recordatorios privados actualizados."],
  ])("keeps save feedback by the form in %s until the draft changes", async (lang, titleLabel, dateLabel, saveLabel, failed, saved) => {
    const api = reminderApi();
    api.savePrivateReminder.mockRejectedValueOnce({ code: "22023" });
    const onNotice = vi.fn();
    wrap(<StewardPrivateReminders api={api} onNotice={onNotice} />, lang);
    await screen.findByText(reminder.title);
    const title = screen.getByLabelText(titleLabel);
    const date = screen.getByLabelText(dateLabel);
    const button = screen.getByRole("button", { name: saveLabel });
    const form = button.closest("form");
    fireEvent.change(title, { target: { value: "Call the member" } });
    fireEvent.change(date, { target: { value: "2026-10-20" } });
    fireEvent.click(button);
    const failure = await within(form).findByText(failed);
    expect(within(form).getByRole("status")).toContainElement(failure);
    expect(title).toHaveValue("Call the member");
    expect(date).toHaveValue("2026-10-20");
    expect(screen.getByText(reminder.title)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again|intentar de nuevo/i })).toBeNull();

    vi.useFakeTimers();
    try {
      act(() => vi.advanceTimersByTime(5000));
      expect(failure).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }

    const titleEdit = [title, "Call the chapter"];
    const dateEdit = [date, "2026-10-21"];
    const [afterFailure, afterSuccess] = lang === "en" ? [titleEdit, dateEdit] : [dateEdit, titleEdit];
    fireEvent.change(afterFailure[0], { target: { value: afterFailure[1] } });
    expect(failure).not.toBeInTheDocument();

    fireEvent.click(button);
    const success = await within(form).findByText(saved);
    expect(within(form).getByRole("status")).toContainElement(success);
    fireEvent.change(afterSuccess[0], { target: { value: afterSuccess[1] } });
    expect(success).not.toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("renders nothing without the private reminder routes", () => {
    const { container } = wrap(<StewardPrivateReminders api={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
