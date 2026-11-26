// BUG-UG-STAFF-MESSAGES-TO-CHAPTER-STEWARD-UNDELIVERED-20261003: when
// the member's chapter has no steward, the server refuses a "Chapter steward"
// message (detail no_steward_assigned). The inbox must say so and point to the
// chapter's officers, keep the draft, and never treat the message as sent; a
// follow-up refusal reaches the toast through the same translated token.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { SharedMessageActions } from "../src/components/SharedMessageActions.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MemberApiError } from "../src/lib/memberApiError.js";
import { rpcErrorText } from "../src/lib/rpcErrorText.js";
import { t as translate } from "../src/lib/i18n.js";

const EN = "Your campaign has no committee contact assigned yet, so this message was not sent. To reach someone now, contact your campaign's leaders, such as the Campaign chair or an Admin.";
const ES = "Tu campaña todavía no tiene un contacto del comité asignado, así que este mensaje no se envió. Para comunicarte con alguien ahora, contacta a quienes lideran tu campaña, como la presidencia de campaña o la administración.";

const refusal = () => new MemberApiError("Start conversation", { message: "no steward assigned", code: "22023", details: "no_steward_assigned" });

function show({ onStartConversation, lang = "en" }) {
  render(
    <LanguageProvider lang={lang}>
      <MessagesView
        data={{ member: { id: "member-1" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] } }}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        onStartConversation={onStartConversation}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("a Committee contact message nobody could read", () => {
  it("says no steward is assigned, names the officers to contact, keeps the draft and opens no thread", async () => {
    const onStartConversation = vi.fn().mockRejectedValue(refusal());
    show({ onStartConversation });
    const box = screen.getByLabelText("First message to your committee contact");
    fireEvent.change(box, { target: { value: "Fall goals for the chapter" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(EN);
    expect(onStartConversation).toHaveBeenCalledWith("Fall goals for the chapter");
    expect(box).toHaveValue("Fall goals for the chapter");
    expect(screen.queryByText(/message sent/i)).toBeNull();
  });

  it("says the same in Spanish", async () => {
    show({ onStartConversation: vi.fn().mockRejectedValue(refusal()), lang: "es" });
    const box = document.querySelector(".inbox-first textarea");
    fireEvent.change(box, { target: { value: "Metas del capítulo" } });
    fireEvent.submit(box.closest("form"));
    expect(await screen.findByRole("alert")).toHaveTextContent(ES);
  });

  it("keeps the generic copy for any other failure", async () => {
    show({ onStartConversation: vi.fn().mockRejectedValue(new MemberApiError("Start conversation", { message: "a direct conversation already exists", code: "23505" })) });
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The conversation couldn't be started. Your message is still here; try again."));
  });

  it("translates a refused follow-up for the send toast instead of showing the server's English", () => {
    const followUp = new MemberApiError("Send message", { message: "no steward assigned", code: "22023", details: "no_steward_assigned" });
    expect(rpcErrorText((key, vars) => translate("en", key, vars), followUp, "toast.saveFailed")).toBe(EN);
    expect(rpcErrorText((key, vars) => translate("es", key, vars), followUp, "toast.saveFailed")).toBe(ES);
  });

  // Review round 2: a member's reply into the same conversation is refused by
  // the server too, and the action toast says why instead of "not confirmed".
  it("says no steward is assigned when a reply is refused", async () => {
    const en = (key) => translate("en", key);
    const onNotice = vi.fn();
    const messageAction = vi.fn(async (_kind, _id, action) => {
      if (action === "state") return { canEdit: false, saved: false, reminders: [], reactions: [] };
      throw new MemberApiError("Reply", { message: "no steward assigned", code: "22023", details: "no_steward_assigned" });
    });
    render(
      <LanguageProvider lang="en">
        <SharedMessageActions sourceKind="private" message={{ id: "msg-1", sender_kind: "member", body: "Hello", reactions: [] }} actorId="member-1" api={{ messageAction }} onNotice={onNotice} onMessageChange={vi.fn()} />
      </LanguageProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: en("inbox.reply") }));
    fireEvent.change(screen.getByLabelText(en("inbox.replyToMessage")), { target: { value: "Anyone there?" } });
    fireEvent.click(screen.getByRole("button", { name: en("inbox.sendReply") }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(EN));
    expect(screen.getByLabelText(en("inbox.replyToMessage"))).toHaveValue("Anyone there?");
  });
});
