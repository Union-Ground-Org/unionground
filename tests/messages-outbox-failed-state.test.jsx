// BUG-UG-MESSAGES-REPLIES-AND-NOTES-STALL-OR-FAIL-20261006: during the
// October 6 slowdown a member's follow-up, a steward's channel reply and a
// steward's private note failed with only a passing toast, so people could not
// tell whether anything was posted. Each composer now keeps the text, says
// beside its box that it was not sent, and offers one button that sends the
// same form again; a later success clears the notice.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";

const NOT_SENT = "Not sent. Your text is still in the box.";
const timedOut = () => Object.assign(new Error("Request timed out"), { name: "TimeoutError" });

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("a member's message in a private conversation", () => {
  const conversation = { id: "conversation-1", sender: "Chapter Steward", initials: "CS", preview: "Earlier", dateLabel: "Now", unread: 0, messages: [] };

  function show(onSendMessage, lang = "en") {
    window.history.replaceState({}, "", "/m/messages?conversation=conversation-1");
    render(
      <LanguageProvider lang={lang}>
        <MessagesView
          data={{ member: { id: "member-1" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] } }}
          desktop
          onSendMessage={onSendMessage}
          onReadConversation={vi.fn().mockResolvedValue(null)}
          onReadBroadcast={vi.fn().mockResolvedValue(null)}
          onOpenTopics={vi.fn()}
        />
      </LanguageProvider>,
    );
  }

  it("says it was not sent, keeps the text, and sends it once more from one button", async () => {
    const onSendMessage = vi.fn().mockRejectedValueOnce(timedOut()).mockResolvedValueOnce({ messageId: "message-1" });
    show(onSendMessage);
    const box = await screen.findByRole("textbox", { name: "Write a message…" });
    fireEvent.change(box, { target: { value: "Following up on the overtime dates" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(NOT_SENT);
    expect(box).toHaveValue("Following up on the overtime dates");
    fireEvent.click(within(alert).getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(2));
    expect(onSendMessage).toHaveBeenNthCalledWith(2, "conversation-1", "Following up on the overtime dates");
    await waitFor(() => expect(screen.queryByText(NOT_SENT)).toBeNull());
    expect(box).toHaveValue("");
  });

  // The notice outlived the text it describes.
  it("drops the notice when the box is emptied or a quick reply replaces the text", async () => {
    show(vi.fn().mockRejectedValue(timedOut()));
    const box = await screen.findByRole("textbox", { name: "Write a message…" });
    fireEvent.change(box, { target: { value: "Following up on the overtime dates" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(NOT_SENT);
    fireEvent.change(box, { target: { value: "" } });
    expect(screen.queryByText(NOT_SENT)).toBeNull();
    fireEvent.change(box, { target: { value: "Following up on the overtime dates" } });
    expect(screen.getByRole("alert")).toHaveTextContent(NOT_SENT);
    fireEvent.click(screen.getByRole("button", { name: "Thank you" }));
    expect(screen.queryByText(NOT_SENT)).toBeNull();
  });

  it("does not claim the text is in the box when a newer draft replaced it during the send", async () => {
    let fail;
    const onSendMessage = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    show(onSendMessage);
    const box = await screen.findByRole("textbox", { name: "Write a message…" });
    fireEvent.change(box, { target: { value: "Following up on the overtime dates" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(box, { target: { value: "On my way" } });
    fail(timedOut());
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    expect(box).toHaveValue("On my way");
    expect(screen.queryByText(NOT_SENT)).toBeNull();
  });

  it("does not carry a phone dialog's failure into the next conversation", async () => {
    const second = { ...conversation, id: "conversation-2", sender: "Second Steward", preview: "Other" };
    const props = {
      data: { member: { id: "member-1" }, conversations: [conversation, second], broadcasts: [], product: { spaces: [], documents: [] } },
      onSendMessage: vi.fn().mockRejectedValue(timedOut()),
      onReadConversation: vi.fn().mockResolvedValue(null),
      onReadBroadcast: vi.fn().mockResolvedValue(null),
      onOpenTopics: vi.fn(),
    };
    window.history.replaceState({}, "", "/m/messages");
    const view = render(<LanguageProvider lang="en"><MessagesView {...props} focus={{ view: "messages", conversationId: "conversation-1", nonce: 1 }} /></LanguageProvider>);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Write a message…" }), { target: { value: "First thread text" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByText(NOT_SENT)).toBeInTheDocument();
    view.rerender(<LanguageProvider lang="en"><MessagesView {...props} focus={{ view: "messages", conversationId: "conversation-2", nonce: 2 }} /></LanguageProvider>);
    await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("Second Steward"));
    expect(screen.queryByText(NOT_SENT)).toBeNull();
  });

  it("says the same in Spanish", async () => {
    show(vi.fn().mockRejectedValue(timedOut()), "es");
    const box = await screen.findByRole("textbox", { name: "Escribe un mensaje…" });
    fireEvent.change(box, { target: { value: "Seguimiento" } });
    fireEvent.submit(box.closest("form"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No se envió. Tu texto sigue en el cuadro.");
    expect(within(alert).getByRole("button", { name: "Enviar de nuevo" })).toBeInTheDocument();
  });
});

describe("a reply in a chapter channel thread", () => {
  const thread = { id: "thread-1", title: "Overtime scheduling", kind: "issue", status: "open", space_id: "space-1", posts: [{ id: "post-1", thread_id: "thread-1", author_id: "user-2", body: "Initial report", created_at: "2026-07-27T12:00:00Z" }] };
  const hubData = {
    member: { id: "user-1", initials: "MV", fullName: "Member Voice" },
    roles: ["steward"], conversations: [], broadcasts: [],
    product: { spaces: [{ id: "space-1", name: "Workplace issues", description: "", visibility: "chapter", threads: [thread] }], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] },
  };

  it("leaves the reply in the box, enables Reply again, and says it was not posted", async () => {
    const created = { id: "post-2", thread_id: "thread-1", author_id: "user-1", body: "We should file", created_at: "2026-07-27T13:00:00Z" };
    const onSendPost = vi.fn().mockRejectedValueOnce(timedOut()).mockResolvedValueOnce(created);
    render(<LanguageProvider lang="en"><ProductHubView data={hubData} onSendPost={onSendPost} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    const box = within(dialog).getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "We should file" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(NOT_SENT);
    expect(box).toHaveValue("We should file");
    expect(within(dialog).getByRole("button", { name: "Reply" })).toBeEnabled();
    fireEvent.click(within(alert).getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(onSendPost).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(dialog).queryByText(NOT_SENT)).toBeNull());
    expect(box).toHaveValue("");
  });

  it("does not say the reply is in the box after it was cleared during the send", async () => {
    let fail;
    const onSendPost = vi.fn(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<LanguageProvider lang="en"><ProductHubView data={hubData} onSendPost={onSendPost} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    const box = within(dialog).getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "We should file" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(onSendPost).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: "" } });
    fail(timedOut());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Reply" })).toBeEnabled());
    expect(within(dialog).queryByText(NOT_SENT)).toBeNull();
  });

  // Replacement text is not the reply that failed.
  it("does not put the notice beside different text typed during or after the send", async () => {
    let fail;
    const onSendPost = vi.fn(() => new Promise((_resolve, reject) => { fail = reject; }));
    render(<LanguageProvider lang="en"><ProductHubView data={hubData} onSendPost={onSendPost} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    const box = within(dialog).getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "We should file" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(onSendPost).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: "Hold off, I will call them" } });
    fail(timedOut());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Reply" })).toBeEnabled());
    expect(within(dialog).queryByText(NOT_SENT)).toBeNull();
    fireEvent.change(box, { target: { value: "We should file" } });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(NOT_SENT);
    fireEvent.change(box, { target: { value: "We should file today" } });
    expect(within(dialog).queryByText(NOT_SENT)).toBeNull();
  });

  it("clears the notice when the next attempt is a /remind that succeeds", async () => {
    const onSendPost = vi.fn().mockRejectedValueOnce(timedOut());
    const messagingApi = { remindHere: vi.fn().mockResolvedValue({ id: "r-1", coalesced: false }) };
    render(<LanguageProvider lang="en"><ProductHubView data={hubData} onSendPost={onSendPost} messagingApi={messagingApi} onNotice={vi.fn()} onCreateTask={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Overtime scheduling/ }));
    const dialog = await screen.findByRole("dialog", { name: "Overtime scheduling" });
    const box = within(dialog).getByRole("textbox", { name: "Reply" });
    fireEvent.change(box, { target: { value: "We should file" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    expect(await within(dialog).findByText(NOT_SENT)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "/remind here in 2h bring the overtime binder" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(messagingApi.remindHere).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(box).toHaveValue(""));
    expect(within(dialog).queryByText(NOT_SENT)).toBeNull();
  });
});

describe("a steward's reply and private note", () => {
  function desk() {
    return {
      queue: [],
      threads: [{
        id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "Newest from Renata", updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
        messages: [{ id: "m-new", conversation_id: "conv-1", sender_kind: "member", sender_name: "Renata Cole", body: "Newest from Renata", created_at: "2026-07-21T09:00:00Z" }],
      }],
      broadcasts: [], formsInbox: [],
      kpis: { openRequests: 0, membersCovered: 1, awaitingReply: 1, broadcasts30d: 0 },
    };
  }

  async function openThread(api) {
    render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} />);
    fireEvent.click(await screen.findByText("Newest from Renata"));
    return screen.findByRole("dialog", { name: "Renata Cole" });
  }

  it("keeps a failed reply in the box and says it was not sent until a retry posts it", async () => {
    const api = {
      loadDesk: vi.fn(async () => desk()),
      listScheduled: vi.fn().mockResolvedValue([]),
      reply: vi.fn().mockRejectedValueOnce(timedOut()).mockResolvedValueOnce({ id: "m-reply" }),
    };
    const dialog = await openThread(api);
    const box = within(dialog).getByPlaceholderText("Reply as Committee…");
    fireEvent.change(box, { target: { value: "I'll call you at noon" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send reply" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(NOT_SENT);
    expect(box).toHaveValue("I'll call you at noon");
    fireEvent.click(within(alert).getByRole("button", { name: "Send again" }));
    await waitFor(() => expect(api.reply).toHaveBeenCalledTimes(2));
    expect(api.reply).toHaveBeenNthCalledWith(2, "conv-1", "I'll call you at noon");
    await waitFor(() => expect(within(dialog).queryByText(NOT_SENT)).toBeNull());
  });

  it("keeps a failed private note in its box and says it was not saved, with Try again", async () => {
    const api = {
      loadDesk: vi.fn(async () => desk()),
      listScheduled: vi.fn().mockResolvedValue([]),
      listContactNotes: vi.fn().mockResolvedValue([]),
      createContactNote: vi.fn().mockRejectedValueOnce(timedOut()).mockResolvedValueOnce({ id: "note-1" }),
    };
    const dialog = await openThread(api);
    const note = within(dialog).getByPlaceholderText("Add a staff-only contact note…");
    fireEvent.change(note, { target: { value: "Prefers calls after 3 PM" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save private note" }));
    const alert = await within(dialog).findByText("Not saved. Your note is still in the box.");
    expect(alert).toHaveAttribute("role", "alert");
    expect(note).toHaveValue("Prefers calls after 3 PM");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.createContactNote).toHaveBeenCalledTimes(2));
    expect(api.createContactNote).toHaveBeenNthCalledWith(2, "conv-1", "Prefers calls after 3 PM", null);
    await waitFor(() => expect(within(dialog).queryByText("Not saved. Your note is still in the box.")).toBeNull());
  });
});
