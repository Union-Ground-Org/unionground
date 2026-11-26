import { useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { Dialog } from "../src/components/Dialog.jsx";
import { MessageActions } from "../src/components/MessageActions.jsx";
import { ReminderTimePicker } from "../src/components/ReminderTimePicker.jsx";
import { SharedMessageActions } from "../src/components/SharedMessageActions.jsx";
import {
  MESSAGE_REMINDER_MAX_AHEAD_MS,
  MESSAGE_REMINDER_MIN_LEAD_MS,
  messageActionChoices,
  messageReminderProblem,
} from "../src/features/messaging/actions.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// REQ-UG-CONNECTED-WORKFLOW-SHORTCUTS-20260928. "Remind me…" used to write a
// reminder 24 hours out on one press. It now opens a chooser: the member picks a
// future date and time (zone shown), and nothing is written until Set reminder.
// Vitest pins TZ to UTC, so a datetime-local value and its ISO instant differ
// only by the trailing ":00.000Z".

const NOW = new Date("2026-09-28T12:00:00.000Z");
const PICK = "2026-09-29T09:30";
const PICK_ISO = "2026-09-29T09:30:00.000Z";

beforeEach(() => {
  // Only Date is faked: timers, microtasks and testing-library polling stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const capabilities = { canEdit: false, saved: false, reminders: [], reactions: [] };

function pickTime(scope, value) {
  fireEvent.change(within(scope).getByLabelText("Reminder date and time"), { target: { value } });
}

describe("reminder bounds shared with native", () => {
  it("accepts the lead boundary and the horizon boundary, and names what falls outside", () => {
    const now = NOW.getTime();
    expect(messageReminderProblem(now + MESSAGE_REMINDER_MIN_LEAD_MS, now)).toBeNull();
    expect(messageReminderProblem(now + MESSAGE_REMINDER_MIN_LEAD_MS - 1, now)).toBe("past");
    expect(messageReminderProblem(now - 1, now)).toBe("past");
    expect(messageReminderProblem(now + MESSAGE_REMINDER_MAX_AHEAD_MS, now)).toBeNull();
    expect(messageReminderProblem(now + MESSAGE_REMINDER_MAX_AHEAD_MS + 1, now)).toBe("far");
    expect(messageReminderProblem(Number.NaN, now)).toBe("invalid");
  });

  it("stays a day inside the server's one-year ceiling", () => {
    expect(MESSAGE_REMINDER_MAX_AHEAD_MS).toBeLessThan(365 * 24 * 60 * 60 * 1000);
  });

  it("keeps the remind protocol id while the label promises a choice", () => {
    expect(messageActionChoices(capabilities).find((choice) => choice.id === "remind")).toEqual({ id: "remind", label: "Remind me…" });
    expect(messageActionChoices({ ...capabilities, reminders: [{}] }).some((choice) => choice.id === "remind")).toBe(false);
  });
});

describe("ReminderTimePicker", () => {
  function renderPicker(props = {}) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ReminderTimePicker onConfirm={onConfirm} onCancel={onCancel} {...props} />);
    return { onConfirm, onCancel, input: screen.getByLabelText("Reminder date and time") };
  }

  it("opens empty on the date field, names the time zone, and confirms nothing by itself", () => {
    const { onConfirm, input } = renderPicker();
    expect(screen.getByRole("group", { name: "Set a reminder for this message" })).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.getByText("Time zone: UTC")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("echoes the exact chosen instant with its zone, then confirms it once", () => {
    const { onConfirm, input } = renderPicker();
    fireEvent.change(input, { target: { value: PICK } });
    expect(screen.getByText(/Reminder for Tuesday, September 29, 2026 at 9:30\sAM UTC/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(PICK_ISO);
  });

  it("confirms from the keyboard with Enter in the field", () => {
    const { onConfirm, input } = renderPicker();
    fireEvent.change(input, { target: { value: PICK } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith(PICK_ISO);
  });

  it("cancels from the button and from Escape without confirming", () => {
    const first = renderPicker();
    fireEvent.change(first.input, { target: { value: PICK } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    expect(first.onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(first.onCancel).toHaveBeenCalledTimes(2);
    expect(first.onConfirm).not.toHaveBeenCalled();
  });

  it("reports an empty confirm and refuses it", () => {
    const { onConfirm, input } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a date and time.");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ["a time that has already passed", "2026-09-28T11:00", "Choose a time at least a minute from now."],
    ["the current minute", "2026-09-28T12:00", "Choose a time at least a minute from now."],
    ["a date more than a year away", "2027-09-28T12:00", "Choose a date within the next year."],
  ])("refuses %s as soon as it is entered, and Set reminder cannot send it", (_label, value, message) => {
    const { onConfirm, input } = renderPicker();
    fireEvent.change(input, { target: { value } });
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText(/^Reminder for /)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("accepts the first minute a reminder may fire and the last day it may be set", () => {
    const { onConfirm, input } = renderPicker();
    fireEvent.change(input, { target: { value: "2026-09-28T12:01" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(onConfirm).toHaveBeenLastCalledWith("2026-09-28T12:01:00.000Z");
    fireEvent.change(input, { target: { value: "2027-09-27T12:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(onConfirm).toHaveBeenLastCalledWith("2027-09-27T12:00:00.000Z");
  });

  it("clears the error once the time is corrected", () => {
    const { onConfirm, input } = renderPicker();
    fireEvent.change(input, { target: { value: "2026-09-28T11:00" } });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: PICK } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(onConfirm).toHaveBeenCalledWith(PICK_ISO);
  });

  it("re-reads the clock at confirm: a chosen time that has since gone by is refused", () => {
    const { onConfirm, input } = renderPicker();
    fireEvent.change(input, { target: { value: "2026-09-28T12:05" } });
    vi.setSystemTime(new Date("2026-09-28T12:30:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a time at least a minute from now.");
  });

  it("offers tomorrow as an optional shortcut that only fills the field", () => {
    const { onConfirm, input } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "Tomorrow, same time" }));
    expect(input).toHaveValue("2026-09-29T12:00");
    expect(onConfirm).not.toHaveBeenCalled();
    // The shortcut is a starting point: the member can still edit it.
    fireEvent.change(input, { target: { value: "2026-09-30T08:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(onConfirm).toHaveBeenCalledWith("2026-09-30T08:15:00.000Z");
  });

  it("keeps the confirm control focusable while a request is in flight (record 8435)", async () => {
    renderPicker({ busy: true });
    await expectPendingFocus(screen.getByRole("button", { name: "Setting reminder…" }));
  });

  it("locks every control and ignores Escape while a request is in flight", () => {
    const { onCancel, input } = renderPicker({ busy: true });
    // Unavailable while the request runs, but still focusable (record 8435).
    expect(input).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Setting reminder…" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Tomorrow, same time" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("answers the first Escape itself and leaves the dialog around it for the second", async () => {
    const onClose = vi.fn();
    // The picker opens inside a dialog that is already up, as in Messages, so
    // its Escape layer is the newer one. (Mounting both in one commit used to
    // pass only because the closing dialog went aria-hidden at once; the
    // dialog now keeps focus and stays exposed while its scrim fades.)
    function Host() {
      const [open, setOpen] = useState(false);
      useEffect(() => { setOpen(true); }, []);
      return (
        <Dialog eyebrow="Messages" title="Conversation" onClose={onClose}>
          {open && <ReminderTimePicker onConfirm={vi.fn()} onCancel={() => setOpen(false)} />}
        </Dialog>
      );
    }
    render(<Host />);
    expect(await screen.findByRole("group", { name: "Set a reminder for this message" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("speaks Spanish from the catalogue, zone and date included", () => {
    const es = catalogue.es;
    render(<LanguageProvider lang="es"><ReminderTimePicker onConfirm={vi.fn()} onCancel={vi.fn()} /></LanguageProvider>);
    expect(screen.getByRole("group", { name: es["inbox.remindPicker.title"] })).toBeInTheDocument();
    expect(screen.getByText("Zona horaria: UTC")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(es["inbox.remindPicker.when"]), { target: { value: PICK } });
    expect(screen.getByText(/Recordatorio para martes, 29 de septiembre de 2026/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: es["inbox.remindPicker.confirm"] })).toBeEnabled();
    expect(screen.getByRole("button", { name: es["inbox.remindPicker.tomorrow"] })).toBeEnabled();
    expect(document.body.textContent ?? "").not.toContain("Set reminder");
    fireEvent.change(screen.getByLabelText(es["inbox.remindPicker.when"]), { target: { value: "2026-09-28T11:00" } });
    expect(screen.getByRole("alert")).toHaveTextContent(es["inbox.remindPicker.errorPast"]);
  });
});

// The shared row is what production renders for private and channel messages:
// the server tells it which actions exist and answers a `remind` with the state.
describe("Remind me… on the shared message row", () => {
  function sharedApi(overrides = {}) {
    return {
      messageAction: vi.fn(async (_kind, _id, action) => action === "state"
        ? capabilities
        : { state: { ...capabilities, reminders: [{ id: "r1" }] }, result: { id: "r1" } }),
      ...overrides,
    };
  }
  const remindCalls = (api) => api.messageAction.mock.calls.filter(([, , action]) => action === "remind");

  function renderRow(message, api, extra = {}) {
    const props = { sourceKind: "private", message, actorId: "me", api, onNotice: vi.fn(), onMessageChange: vi.fn(), ...extra };
    const view = render(<SharedMessageActions {...props} />);
    return { ...view, props };
  }

  it("opens a chooser on press and writes nothing until it is confirmed", async () => {
    const api = sharedApi();
    renderRow({ id: "m1", body: "Hello", reactions: [] }, api);
    const trigger = await screen.findByRole("button", { name: "Remind me…" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Set a reminder for this message" })).toBeInTheDocument();
    pickTime(document.body, PICK);
    expect(remindCalls(api)).toHaveLength(0);
  });

  it("cancels back to the trigger with focus restored and no request", async () => {
    const api = sharedApi();
    renderRow({ id: "m1", body: "Hello", reactions: [] }, api);
    const trigger = await screen.findByRole("button", { name: "Remind me…" });
    fireEvent.click(trigger);
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remind me…" })).toHaveFocus();
    expect(remindCalls(api)).toHaveLength(0);
  });

  it("sends the exact instant the member chose, then swaps in Remove reminders", async () => {
    const api = sharedApi();
    const { props } = renderRow({ id: "m1", body: "Hello", reactions: [] }, api);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(api.messageAction).toHaveBeenCalledWith("private", "m1", "remind", PICK_ISO));
    expect(remindCalls(api)).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "Remove reminders" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    expect(props.onMessageChange).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", reminder: { id: "r1" } }));
    expect(props.onNotice).toHaveBeenCalledWith("Message action saved.");
    expect(screen.getByRole("button", { name: "Remove reminders" })).toHaveFocus();
  });

  it("does not send a second request for a second press while one is in flight", async () => {
    let finish;
    const api = sharedApi({
      messageAction: vi.fn((_kind, _id, action) => action === "state"
        ? Promise.resolve(capabilities)
        : new Promise((resolve) => { finish = resolve; })),
    });
    renderRow({ id: "m1", body: "Hello", reactions: [] }, api);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    const confirm = screen.getByRole("button", { name: "Set reminder" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(remindCalls(api)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Setting reminder…" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => finish({ state: { ...capabilities, reminders: [{ id: "r1" }] } }));
  });

  it("keeps the chooser and the chosen time when the write is refused", async () => {
    const api = sharedApi({
      messageAction: vi.fn(async (_kind, _id, action) => {
        if (action === "state") return capabilities;
        throw new Error("Set reminder: limit reached");
      }),
    });
    const { props } = renderRow({ id: "m1", body: "Hello", reactions: [] }, api);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Action not confirmed. Try again."));
    expect(screen.getByLabelText("Reminder date and time")).toHaveValue(PICK);
    expect(screen.getByRole("button", { name: "Set reminder" })).toBeEnabled();
    expect(props.onMessageChange).not.toHaveBeenCalled();
    expect(props.onNotice).not.toHaveBeenCalledWith("Message action saved.");
  });

  it("drops the chooser and actions and uses neutral copy for bare permission denied", async () => {
    const api = sharedApi({
      messageAction: vi.fn(async (_kind, _id, action) => {
        if (action === "state") return capabilities;
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      }),
    });
    const { props } = renderRow({ id: "m1", body: "Hello", reactions: [] }, api);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("Action not confirmed. Try again."));
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remind me…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load message actions" })).toBeEnabled();
  });

  it("closes the chooser when a reminder already exists on a refreshed snapshot", async () => {
    const api = sharedApi();
    const message = { id: "m1", body: "Hello", reactions: [] };
    const view = renderRow(message, api);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me…" }));
    expect(screen.getByRole("group", { name: "Set a reminder for this message" })).toBeInTheDocument();
    api.messageAction.mockResolvedValue({ ...capabilities, reminders: [{ id: "elsewhere" }] });
    await act(async () => view.rerender(<SharedMessageActions {...view.props} message={{ ...message }} />));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Remove reminders" })).toBeInTheDocument();
  });

  it("keeps a half-chosen time across an equivalent snapshot of the same message", async () => {
    const api = sharedApi();
    const message = { id: "m1", body: "Hello", reactions: [] };
    const view = renderRow(message, api);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    await act(async () => view.rerender(<SharedMessageActions {...view.props} message={{ ...message, reactions: [{ actor_id: "peer", reaction: "like" }] }} />));
    expect(screen.getByLabelText("Reminder date and time")).toHaveValue(PICK);
  });

  it("puts the reminder on the exact message chosen, not the newest one", async () => {
    const api = sharedApi();
    const rows = [
      { id: "m-old", body: "First", reactions: [] },
      { id: "m-mid", body: "Second", reactions: [] },
      { id: "m-new", body: "Latest", reactions: [] },
    ];
    render(<ul>{rows.map((row) => (
      <li key={row.id} data-testid={row.id}>
        <SharedMessageActions sourceKind="private" message={row} actorId="me" api={api} onNotice={vi.fn()} onMessageChange={vi.fn()} />
      </li>
    ))}</ul>);
    const older = screen.getByTestId("m-old");
    fireEvent.click(await within(older).findByRole("button", { name: "Remind me…" }));
    pickTime(older, PICK);
    fireEvent.click(within(older).getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(remindCalls(api)).toHaveLength(1));
    expect(remindCalls(api)[0]).toEqual(["private", "m-old", "remind", PICK_ISO]);
    expect(await within(older).findByRole("button", { name: "Remove reminders" })).toBeInTheDocument();
    // The other rows still offer a fresh choice; neither gained a reminder or a chooser.
    for (const id of ["m-mid", "m-new"]) {
      const row = screen.getByTestId(id);
      expect(await within(row).findByRole("button", { name: "Remind me…" })).toBeInTheDocument();
      expect(within(row).queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    }
  });

  it("drops a late acknowledgement after the surface moved to another message", async () => {
    let finish;
    const api = sharedApi({
      messageAction: vi.fn((_kind, _id, action) => action === "state"
        ? Promise.resolve(capabilities)
        : new Promise((resolve) => { finish = resolve; })),
    });
    const view = renderRow({ id: "m1", body: "Hello", reactions: [] }, api);
    fireEvent.click(await screen.findByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(remindCalls(api)).toHaveLength(1);

    // Navigating to another message replaces the row before the server answers.
    api.messageAction.mockImplementation(async () => capabilities);
    view.rerender(<SharedMessageActions {...view.props} message={{ id: "m2", body: "Other", reactions: [] }} />);
    await act(async () => finish({ state: { ...capabilities, reminders: [{ id: "r-late" }] } }));

    expect(view.props.onMessageChange).not.toHaveBeenCalled();
    expect(view.props.onNotice).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "Remind me…" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove reminders" })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
  });

  it("reads Remind me… in Spanish from the catalogue and never in English", async () => {
    const es = catalogue.es;
    const api = sharedApi();
    render(<LanguageProvider lang="es"><SharedMessageActions sourceKind="private" message={{ id: "m1", body: "Hola", reactions: [] }} actorId="me" api={api} onNotice={vi.fn()} onMessageChange={vi.fn()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: es["inbox.remindMe"] }));
    expect(screen.getByRole("group", { name: es["inbox.remindPicker.title"] })).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/Remind me|Set reminder|Time zone/);
  });
});

// SAMPLE, task threads and any surface without messageAction render the
// fallback component; it shares the chooser and the same rules.
describe("Remind me… on the fallback message row", () => {
  function makeApi(overrides = {}) {
    return {
      toggleReaction: vi.fn(async () => ({ reacted: true })),
      toggleSaved: vi.fn(async () => ({ saved: true })),
      remind: vi.fn(async () => ({ id: "reminder-1" })),
      ...overrides,
    };
  }
  const base = { id: "msg-1", sender_kind: "member", body: "Hello", reactions: [] };

  function renderRow(message, api, sourceKind = "private", extra = {}) {
    const props = { sourceKind, message, actorId: "me", api, onNotice: vi.fn(), onMessageChange: vi.fn(), ...extra };
    const view = render(<MessageActions {...props} />);
    return { ...view, props };
  }

  it("opens the chooser and writes nothing until it is confirmed", () => {
    const api = makeApi();
    renderRow(base, api);
    const trigger = screen.getByRole("button", { name: "Remind me…" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    pickTime(document.body, PICK);
    expect(api.remind).not.toHaveBeenCalled();
  });

  it("cancels back to the trigger with focus restored and no request", () => {
    const api = makeApi();
    renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remind me…" })).toHaveFocus();
    expect(api.remind).not.toHaveBeenCalled();
  });

  it.each(["private", "channel", "task"])("sends the chosen instant on the %s source boundary, then offers cancellation", async (sourceKind) => {
    const api = makeApi({ cancelReminder: vi.fn(async () => ({ cancelled: true })) });
    const { props } = renderRow(base, api, sourceKind);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(api.remind).toHaveBeenCalledWith(sourceKind, "msg-1", PICK_ISO));
    expect(api.remind).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Cancel reminder" })).toHaveFocus();
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    expect(props.onMessageChange).toHaveBeenCalledWith(expect.objectContaining({
      id: "msg-1",
      reminder: { id: "reminder-1", remind_at: PICK_ISO, status: "pending" },
    }));
    expect(props.onNotice).toHaveBeenCalledWith("Reminder set");
  });

  it("presses once: a second press during the request sends no second reminder", async () => {
    let finish;
    const api = makeApi({ remind: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    const confirm = screen.getByRole("button", { name: "Set reminder" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.remind).toHaveBeenCalledTimes(1);
    await act(async () => finish({ id: "reminder-1" }));
  });

  it("keeps the chooser and the chosen time when the write is refused, without leaking the driver text", async () => {
    const api = makeApi({ remind: vi.fn(async () => { throw new Error("Set reminder: duplicate key value violates unique constraint"); }) });
    const { props } = renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("That message action could not be completed."));
    expect(screen.getByLabelText("Reminder date and time")).toHaveValue(PICK);
    expect(screen.getByRole("button", { name: "Set reminder" })).toBeEnabled();
    expect(props.onMessageChange).not.toHaveBeenCalled();
  });

  it("drops the chooser and uses neutral copy for bare permission denied", async () => {
    const api = makeApi({ remind: vi.fn(async () => { throw Object.assign(new Error("permission denied"), { code: "42501" }); }) });
    const { props } = renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(props.onNotice).toHaveBeenCalledWith("That message action could not be completed."));
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
  });

  it("closes the chooser when a reminder lands on the same message meanwhile", async () => {
    const api = makeApi({ cancelReminder: vi.fn() });
    const view = renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    expect(screen.getByRole("group", { name: "Set a reminder for this message" })).toBeInTheDocument();
    view.rerender(<MessageActions {...view.props} message={{ ...base, reminder: { id: "elsewhere", remind_at: PICK_ISO, status: "pending" } }} />);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Cancel reminder" })).toBeInTheDocument();
  });

  it("keeps a half-chosen time across an equivalent snapshot of the same message", () => {
    const api = makeApi();
    const view = renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    view.rerender(<MessageActions {...view.props} message={{ ...base, reactions: [{ id: "r", actor_id: "peer", reaction: "like" }] }} />);
    expect(screen.getByLabelText("Reminder date and time")).toHaveValue(PICK);
  });

  it("puts the reminder on the exact message chosen, not the newest one", async () => {
    const api = makeApi();
    const rows = ["m-old", "m-mid", "m-new"].map((id) => ({ ...base, id }));
    render(<ul>{rows.map((row) => (
      <li key={row.id} data-testid={row.id}><MessageActions sourceKind="private" message={row} actorId="me" api={api} /></li>
    ))}</ul>);
    const older = screen.getByTestId("m-old");
    fireEvent.click(within(older).getByRole("button", { name: "Remind me…" }));
    pickTime(older, PICK);
    fireEvent.click(within(older).getByRole("button", { name: "Set reminder" }));
    await waitFor(() => expect(api.remind).toHaveBeenCalledTimes(1));
    expect(api.remind).toHaveBeenCalledWith("private", "m-old", PICK_ISO);
    expect(await within(older).findByText("Reminder set")).toBeInTheDocument();
    for (const id of ["m-mid", "m-new"]) {
      const row = screen.getByTestId(id);
      expect(within(row).getByRole("button", { name: "Remind me…" })).toBeEnabled();
      expect(within(row).queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    }
  });

  it("drops a late acknowledgement after the surface moved to another message", async () => {
    let finish;
    const api = makeApi({ remind: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    const view = renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
    expect(api.remind).toHaveBeenCalledTimes(1);

    view.rerender(<MessageActions {...view.props} message={{ ...base, id: "msg-2" }} />);
    await act(async () => finish({ id: "reminder-late" }));

    expect(view.props.onMessageChange).not.toHaveBeenCalled();
    expect(view.props.onNotice).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remind me…" })).toBeEnabled();
    expect(screen.queryByText("Reminder set")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
  });

  it("gives a different message no inherited open chooser", () => {
    const api = makeApi();
    const view = renderRow(base, api);
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    pickTime(document.body, PICK);
    view.rerender(<MessageActions {...view.props} message={{ ...base, id: "msg-2" }} />);
    expect(screen.queryByRole("group", { name: "Set a reminder for this message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remind me…" }));
    expect(screen.getByLabelText("Reminder date and time")).toHaveValue("");
  });
});
