import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "../src/components/MessageActions.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { redactMemberMessage, toggleMemberSavedMessage } from "../src/lib/memberApi.js";
import { MESSAGE_REACTION_CHOICES } from "../src/features/messaging/index.js";
import { chooseReminder } from "./helpers/reminderPicker.js";

// BUG-UG-MESSAGE-REACTION-PARITY-20260904 (all five kinds reach the RPC)
// and SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904 (the sender can actually
// remove a message, and only their own).

function makeApi(overrides = {}) {
  return {
    toggleReaction: vi.fn(async () => ({ reacted: true })),
    toggleSaved: vi.fn(async () => ({ saved: true })),
    remind: vi.fn(async () => ({ id: "reminder-1" })),
    ...overrides,
  };
}

function renderActions(message, api, sourceKind = "private") {
  return render(
    <LanguageProvider>
      <MessageActions sourceKind={sourceKind} message={message} actorId="me" api={api} />
    </LanguageProvider>,
  );
}

const baseMessage = {
  id: "msg-1",
  sender_kind: "member",
  body: "They wrote me up again after the Thursday meeting.",
  reactions: [],
};

describe("reaction parity on responsive web", () => {
  it("offers every database-supported reaction kind on a message with none", () => {
    renderActions(baseMessage, makeApi());
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    const choices = screen.getByRole("group", { name: "Reactions" });
    expect([...choices.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
      .toEqual(["Seen", "Agreed", "Solidarity", "Care", "Workplace issue", "Victory"]);
    expect(MESSAGE_REACTION_CHOICES).toHaveLength(6);
    expect(choices).not.toHaveTextContent(/Grievance/);
  });

  it("sends the selected kind straight to the bounded RPC", async () => {
    const api = makeApi();
    renderActions(baseMessage, api);
    (fireEvent.click(screen.getByRole("button", { name: "React" })), fireEvent.click(screen.getByRole("button", { name: "Solidarity" })));
    await waitFor(() => expect(api.toggleReaction).toHaveBeenCalledWith("private", "msg-1", "solidarity"));
  });

  it("aggregates counts and marks the viewer's own reaction", () => {
    renderActions({
      ...baseMessage,
      reactions: [
        { id: "r1", actor_id: "me", reaction: "like" },
        { id: "r2", actor_id: "other", reaction: "like" },
        { id: "r3", actor_id: "other", reaction: "strength" },
      ],
    }, makeApi());
    const summary = screen.getByLabelText("Reactions");
    expect(summary.textContent).toContain("2");
    expect(summary.textContent).toContain("1");
    expect(screen.getByRole("button", { name: "Like: 2" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not expose unsupported kinds in the picker", () => {
    const api = makeApi();
    renderActions(baseMessage, api);
    fireEvent.click(screen.getByRole("button", { name: "React" }));
    expect(screen.queryByRole("button", { name: "Shrug" })).toBeNull();
    expect(api.toggleReaction).not.toHaveBeenCalled();
  });
});

describe("removing a direct message", () => {
  it("offers removal on the member's own private message", () => {
    renderActions(baseMessage, makeApi({ redactMessage: vi.fn() }));
    expect(screen.getByText("Remove")).toBeTruthy();
  });

  it("requires a second press before destroying the text", async () => {
    const redactMessage = vi.fn(async () => ({ redacted: true }));
    renderActions(baseMessage, makeApi({ redactMessage }));
    fireEvent.click(screen.getByText("Remove"));
    expect(redactMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm removal")).toBeTruthy();
    fireEvent.click(screen.getByText("Confirm removal"));
    await waitFor(() => expect(redactMessage).toHaveBeenCalledWith("msg-1"));
  });

  it("takes a removal the learning period holds as removed, and fails on any other refusal", async () => {
    // REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103:
    // the server hides the sender's own message and keeps it undoable.
    const held = vi.fn(async () => ({ redacted: false, held: true, reasonCode: "sender_removed", message: { id: "msg-1", body: "" } }));
    renderActions(baseMessage, makeApi({ redactMessage: held }));
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Confirm removal"));
    await waitFor(() => expect(held).toHaveBeenCalledWith("msg-1"));
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("does not offer removal on a steward's message", () => {
    renderActions({ ...baseMessage, sender_kind: "steward" }, makeApi({ redactMessage: vi.fn() }));
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("does not offer removal on a message that is already removed", () => {
    renderActions(
      { ...baseMessage, body: "", redacted_at: "2026-09-06T00:00:00.000Z", redaction_reason: "sender_removed" },
      makeApi({ redactMessage: vi.fn() }),
    );
    expect(screen.queryByText("Remove")).toBeNull();
  });

  it("does not offer removal on channel or task sources, where the RPC does not apply", () => {
    for (const sourceKind of ["channel", "task"]) {
      const view = renderActions(baseMessage, makeApi({ redactMessage: vi.fn() }), sourceKind);
      expect(screen.queryByText("Remove"), sourceKind).toBeNull();
      view.unmount();
    }
  });

  it("does not offer removal when the surface provides no redaction api", () => {
    renderActions(baseMessage, makeApi());
    expect(screen.queryByText("Remove")).toBeNull();
  });

  // DEBT-UG-WEB-CAN-REMOVE-COMMENT-CLAIMS-ACTOR-CHECK-20260920: the client
  // condition makes no author check, so both halves of what it really tests are
  // pinned here. redact_member_message is what refuses an ineligible caller.
  it("offers removal to a viewer who did not write the row, because the client never checks the author", () => {
    renderActions({ ...baseMessage, user_id: "another-member" }, makeApi({ redactMessage: vi.fn() }));
    expect(screen.getByText("Remove")).toBeTruthy();
  });

  it("offers no removal to a steward-shaped api that carries messageAction but no redactMessage", async () => {
    const messageAction = vi.fn(async () => ({ canEdit: false, saved: false, reminders: [], reactions: [] }));
    renderActions(baseMessage, makeApi({ messageAction }));
    await waitFor(() => expect(messageAction).toHaveBeenCalledWith("private", "msg-1", "state"));
    expect(screen.queryByText("Remove")).toBeNull();
  });
});

// UX-UG-SHARED-REACTIONS-RAW-ID-AND-DUP-GROUP: in shared mode the actions
// are rendered by SharedMessageActions, which names its own "Message actions"
// group. This component still opened a second group with the same name around
// the removal button alone — empty on every message that cannot be removed, so
// a screen reader announced a duplicate, often unusable group per message.
describe("shared mode does not duplicate the message actions group", () => {
  function sharedApi(overrides = {}) {
    return makeApi({
      messageAction: vi.fn(async () => ({ canEdit: true, saved: false, reminders: [], reactions: [] })),
      ...overrides,
    });
  }

  it("names exactly one action group on a private message that also offers removal", async () => {
    renderActions(baseMessage, sharedApi({ redactMessage: vi.fn() }));
    expect(await screen.findByText("Remove")).toBeTruthy();
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(screen.getAllByRole("group", { name: "Message actions" })).toHaveLength(1);
  });

  it("opens no second, empty group on a channel message", async () => {
    renderActions(baseMessage, sharedApi({ redactMessage: vi.fn() }), "channel");
    expect(await screen.findByRole("button", { name: "React" })).toBeTruthy();
    const groups = screen.getAllByRole("group");
    expect(groups).toHaveLength(1);
    expect(groups[0].querySelectorAll("button, select").length).toBeGreaterThan(0);
  });
});

// The inline reminder control is a toggle, not a one-way switch: once a message
// carries a reminder the same slot has to hand it back. Before this, the only
// exit was the Messages scheduled list, so a reminder set from a thread could
// not be cancelled from that thread.
describe("cancelling a reminder from the message itself", () => {
  const reminded = { ...baseMessage, reminder: { id: "reminder-1", remind_at: "2026-09-18T00:00:00.000Z", status: "pending" } };

  it("offers cancellation in place of a second reminder once one is pending", () => {
    renderActions(reminded, makeApi({ cancelReminder: vi.fn(async () => ({ cancelled: true })) }));
    expect(screen.getByText("Cancel reminder")).toBeTruthy();
    expect(screen.queryByText("Remind me…")).toBeNull();
  });

  it("cancels the pending reminder by id and returns the slot to remind", async () => {
    const cancelReminder = vi.fn(async () => ({ cancelled: true }));
    const onNotice = vi.fn();
    const onMessageChange = vi.fn();
    render(
      <LanguageProvider>
        <MessageActions sourceKind="private" message={reminded} actorId="me" api={makeApi({ cancelReminder })} onNotice={onNotice} onMessageChange={onMessageChange} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByText("Cancel reminder"));
    await waitFor(() => expect(cancelReminder).toHaveBeenCalledWith("reminder-1"));
    await waitFor(() => expect(screen.getByText("Remind me…")).toBeTruthy());
    expect(onNotice).toHaveBeenCalledWith("Reminder cancelled");
    expect(onMessageChange).toHaveBeenCalledWith(expect.objectContaining({ id: "msg-1", reminder: null }));
  });

  it("keeps the reminder when the cancellation fails, and says so", async () => {
    const cancelReminder = vi.fn(async () => { throw new Error("Cancel reminder: reminder already fired"); });
    const onNotice = vi.fn();
    render(
      <LanguageProvider>
        <MessageActions sourceKind="private" message={reminded} actorId="me" api={makeApi({ cancelReminder })} onNotice={onNotice} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByText("Cancel reminder"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That message action could not be completed."));
    expect(screen.getByText("Cancel reminder")).toBeTruthy();
  });

  it("leaves a surface with no cancellation api on the disabled reminder button", () => {
    renderActions(reminded, makeApi());
    expect(screen.queryByText("Cancel reminder")).toBeNull();
    expect(screen.getByText("Reminder set").closest("button").disabled).toBe(true);
  });
});

// BUG-UG-WEB-MESSAGE-ACTION-RESULT-OVERWRITES-NEWER-MESSAGE-20260920: the
// helper used to apply a resolved result to the row the click closed over, so
// a peer reaction or thread reload that landed while the request was in flight
// was written back out of both the rendered row and onMessageChange.
describe("an action result lands on the newest message, not the click-time snapshot", () => {
  const peerReaction = [{ id: "r1", actor_id: "other", reaction: "like" }];

  function renderTask(message, api) {
    return render(
      <LanguageProvider>
        <MessageActions sourceKind="task" message={message} actorId="me" api={api} />
      </LanguageProvider>,
    );
  }

  it("keeps a reaction that arrives while a task-thread save is in flight", async () => {
    let settle;
    // The task thread wires no onMessageChange, so the rendered row is the
    // only place the newer data can survive.
    const api = makeApi({ toggleSaved: vi.fn(() => new Promise((resolve) => { settle = resolve; })) });
    const view = renderTask(baseMessage, api);
    fireEvent.click(screen.getByText("Save"));
    view.rerender(
      <LanguageProvider>
        <MessageActions sourceKind="task" message={{ ...baseMessage, reactions: peerReaction }} actorId="me" api={api} />
      </LanguageProvider>,
    );
    await act(async () => { settle({ saved: true }); });
    expect(screen.getByLabelText("Reactions").textContent).toContain("1");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("merges a removal into the newest row it hands to onMessageChange", async () => {
    let settle;
    const onMessageChange = vi.fn();
    const api = makeApi({ redactMessage: vi.fn(() => new Promise((resolve) => { settle = resolve; })) });
    const view = render(
      <LanguageProvider>
        <MessageActions sourceKind="private" message={baseMessage} actorId="me" api={api} onMessageChange={onMessageChange} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Confirm removal"));
    view.rerender(
      <LanguageProvider>
        <MessageActions sourceKind="private" message={{ ...baseMessage, reactions: peerReaction }} actorId="me" api={api} onMessageChange={onMessageChange} />
      </LanguageProvider>,
    );
    await act(async () => { settle({ redacted: true, message: { redacted_at: "2026-09-20T00:00:00.000Z", redaction_reason: "sender_removed" } }); });
    expect(onMessageChange).toHaveBeenCalledWith(expect.objectContaining({
      id: "msg-1",
      body: "",
      redacted_at: "2026-09-20T00:00:00.000Z",
      reactions: peerReaction,
    }));
  });

  it("drops an acknowledgement that resolves after the surface swapped rows", async () => {
    let settle;
    const onMessageChange = vi.fn();
    const api = makeApi({ toggleSaved: vi.fn(() => new Promise((resolve) => { settle = resolve; })) });
    const view = renderTask(baseMessage, api);
    fireEvent.click(screen.getByText("Save"));
    view.rerender(
      <LanguageProvider>
        <MessageActions sourceKind="task" message={{ ...baseMessage, id: "msg-2", reactions: [] }} actorId="me" api={api} onMessageChange={onMessageChange} />
      </LanguageProvider>,
    );
    await act(async () => { settle({ saved: true }); });
    expect(screen.getByText("Save")).toBeTruthy();
    expect(onMessageChange).not.toHaveBeenCalled();
  });
});

// UX-UG-WEB-MESSAGE-ACTION-FAILURE-TOAST-SHOWS-RAW-API-ERROR-20260920: a
// refused message action toasted whatever the driver put on the error — raw
// untranslated English naming the RPC, sometimes a Postgres code. The member
// reads the catalogue sentence in their own language instead.
describe("a refused message action speaks the catalogue sentence", () => {
  it.each([
    ["en", "authentication required", "Sign in and complete the second verification step to continue."],
    ["es", "authentication required", "Inicia sesión y completa el segundo paso de verificación para continuar."],
    ["en", "permission denied for function toggle_member_saved_message", "That message action could not be completed."],
  ])("explains a task message save refusal (%s, %s)", async (lang, message, expected) => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: "42501", message } });
    const api = makeApi({ toggleSaved: (kind, id) => toggleMemberSavedMessage({ rpc }, kind, id) });
    const onNotice = vi.fn();
    const onMessageChange = vi.fn();
    render(<LanguageProvider lang={lang}>
      <MessageActions sourceKind="task" message={baseMessage} actorId="me" api={api} onNotice={onNotice} onMessageChange={onMessageChange} />
    </LanguageProvider>);
    const save = screen.getByRole("button", { name: t(lang, "inbox.save") });
    fireEvent.click(save);
    expect(rpc).toHaveBeenCalledWith("toggle_member_saved_message", { p_source_kind: "task", p_message_id: "msg-1" });
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(onNotice).toHaveBeenCalledWith(expected);
    expect(onMessageChange).not.toHaveBeenCalled();
    expect(save).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["en", Object.assign(new Error("not permitted for this message"), { code: "42501" }), "inbox.actionFailed"],
    ["es", new TypeError("Failed to fetch"), "offline.unconfirmed"],
  ])("announces the action outcome and leaves the save state intact (%s)", async (lang, error, key) => {
    const api = makeApi({ toggleSaved: vi.fn().mockRejectedValue(error) });
    const onNotice = vi.fn();
    const onMessageChange = vi.fn();
    render(<LanguageProvider lang={lang}>
      <MessageActions sourceKind="task" message={baseMessage} actorId="me" api={api} onNotice={onNotice} onMessageChange={onMessageChange} />
    </LanguageProvider>);
    const save = screen.getByRole("button", { name: t(lang, "inbox.save") });
    fireEvent.click(save);
    expect(await screen.findByRole("alert")).toHaveTextContent(t(lang, key));
    expect(onNotice).toHaveBeenCalledWith(t(lang, key));
    expect(onMessageChange).not.toHaveBeenCalled();
    expect(save).toBeEnabled();
  });

  it.each([
    ["en", "conversation is under a preservation order", "That message action could not be completed."],
    ["es", "conversation is under a preservation order", "No se pudo completar esa acción del mensaje."],
    ["en", "not permitted", "Your role does not allow this change, so nothing was changed."],
    ["es", "permission denied", "No se pudo completar esa acción del mensaje."],
  ])("explains a private removal refusal (%s, %s)", async (lang, message, expected) => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: "42501", message } });
    const api = makeApi({ redactMessage: (id) => redactMemberMessage({ rpc }, id) });
    const onNotice = vi.fn();
    const onMessageChange = vi.fn();
    render(<LanguageProvider lang={lang}>
      <MessageActions sourceKind="private" message={baseMessage} actorId="me" api={api} onNotice={onNotice} onMessageChange={onMessageChange} />
    </LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: t(lang, "inbox.removeMessage") }));
    fireEvent.click(screen.getByRole("button", { name: t(lang, "inbox.confirmRemoveMessage") }));
    expect(rpc).toHaveBeenCalledWith("redact_member_message", { p_message_id: "msg-1" });
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    expect(onNotice.mock.calls).toEqual([[expected]]);
    expect(onMessageChange).not.toHaveBeenCalled();
  });

  const rejections = [
    ["reaction", () => (fireEvent.click(screen.getByRole("button", { name: "React" })), fireEvent.click(screen.getByRole("button", { name: "Solidarity" }))),
      { toggleReaction: vi.fn(async () => { throw new Error("Toggle reaction: permission denied for function toggle_member_message_reaction"); }) }],
    ["save", () => fireEvent.click(screen.getByText("Save")),
      { toggleSaved: vi.fn(async () => { throw new Error("Save message: JWT expired"); }) }],
    ["reminder", () => chooseReminder(document.body),
      { remind: vi.fn(async () => { throw Object.assign(new Error("Set reminder: duplicate key value violates unique constraint"), { code: "23505" }); }) }],
  ];

  for (const [label, trigger, overrides] of rejections) {
    it(`toasts the translated sentence when ${label} is refused`, async () => {
      const onNotice = vi.fn();
      render(
        <LanguageProvider>
          <MessageActions sourceKind="private" message={baseMessage} actorId="me" api={makeApi(overrides)} onNotice={onNotice} />
        </LanguageProvider>,
      );
      trigger();
      await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That message action could not be completed."));
      const notices = onNotice.mock.calls.map(([notice]) => String(notice));
      for (const driverText of ["permission denied", "JWT expired", "duplicate key", "toggle_member_message_reaction", "23505"]) {
        expect(notices.some((notice) => notice.includes(driverText)), driverText).toBe(false);
      }
    });
  }

  it("says the same thing when the server refuses a removal", async () => {
    const redactMessage = vi.fn(async () => { throw new Error("Remove message: message_not_removable"); });
    const onNotice = vi.fn();
    render(
      <LanguageProvider>
        <MessageActions sourceKind="private" message={baseMessage} actorId="me" api={makeApi({ redactMessage })} onNotice={onNotice} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByText("Remove"));
    fireEvent.click(screen.getByText("Confirm removal"));
    await waitFor(() => expect(redactMessage).toHaveBeenCalledWith("msg-1"));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("That message action could not be completed."));
    const notices = onNotice.mock.calls.map(([notice]) => String(notice));
    expect(notices.some((notice) => notice.includes("message_not_removable"))).toBe(false);
    expect(screen.getByText("Remove")).toBeTruthy();
  });
});
