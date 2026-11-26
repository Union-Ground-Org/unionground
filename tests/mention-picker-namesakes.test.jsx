import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseNoteComposer } from "../src/components/CaseMentions.jsx";
import { MentionPicker } from "../src/features/messaging/ChannelControls.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";

// Fictional Tamarack people. Names alone never select a notification recipient.
const people = ["tamarack-east", "tamarack-west"].map((id) => ({ id, userId: id, fullName: "Alex Rivera", name: "Alex Rivera" }));
afterEach(() => { cleanup(); window.localStorage.clear(); });

describe.each(["en", "es"])("namesake mention choices in %s", (lang) => {
  const t = (key, vars) => translate(lang, key, vars);
  it.each(people)("names and notifies exactly $id from a case note", async (person) => {
    const onSubmit = vi.fn().mockResolvedValue({});
    render(<CaseNoteComposer caseId="tamarack-case" t={t} candidates={people} onSubmit={onSubmit} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "@Alex" } });
    for (const entry of people) expect(screen.getByRole("option", { name: `@Alex Rivera (${entry.id})` })).toHaveTextContent(`@Alex Rivera (${entry.id})`);
    fireEvent.click(screen.getByRole("option", { name: `@Alex Rivera (${person.id})` }));
    fireEvent.click(screen.getByRole("button", { name: t("coordinator.addNote") }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("tamarack-case", "@Alex Rivera", [person.id]));
  });
  it.each(people)("hands exactly $id back from the channel picker", async (person) => {
    const onPick = vi.fn();
    render(<MentionPicker t={t} api={{ mentionCandidates: vi.fn().mockResolvedValue(people) }} spaceId="tamarack-space" onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: t("channelControls.mention") }));
    const choice = await screen.findByRole("button", { name: t("channelControls.mentionPerson", { name: `Alex Rivera (${person.id})` }) });
    expect(choice).toHaveTextContent(`Alex Rivera (${person.id})`);
    fireEvent.click(choice);
    expect(onPick).toHaveBeenCalledWith(person);
    expect(screen.queryByLabelText(t("channelControls.mentionSearchLabel"))).toBeNull();
  });
  it("keeps both Messages senders, and keyboard insertion and dismissal", async () => {
    const onSendMessage = vi.fn().mockResolvedValue({});
    const conversation = { id: "tamarack-thread", sender: "Tamarack case team", messages: people.map((person) => ({ id: `post-${person.id}`, sender_id: person.id, sender_kind: "steward", sender_name: person.fullName, body: "Check the agenda", created_at: "2026-11-08T12:00:00-05:00" })) };
    render(<LanguageProvider lang={lang}><MessagesView alt desktop data={{ member: { id: "tamarack-member" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] } }} onSendMessage={onSendMessage} onReadConversation={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Tamarack case team/ }));
    const box = screen.getByRole("combobox");
    for (const [index, person] of people.entries()) {
      fireEvent.change(box, { target: { value: "Hi @Alex", selectionStart: 8 } });
      const options = within(screen.getByRole("listbox")).getAllByRole("option");
      expect(options).toHaveLength(2);
      expect(screen.getByRole("option", { name: `Alex Rivera (${person.id})` })).toHaveTextContent(`Alex Rivera (${person.id})`);
      if (index) fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "Enter" });
      expect(box).toHaveValue("Hi @Alex Rivera ");
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.submit(box.closest("form"));
      // Private Messages sends the conversation/body, not mention recipients.
      await waitFor(() => expect(onSendMessage).toHaveBeenCalledTimes(index + 1));
      expect(onSendMessage).toHaveBeenLastCalledWith("tamarack-thread", "Hi @Alex Rivera");
    }
    fireEvent.change(box, { target: { value: "@Alex", selectionStart: 5 } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box).toHaveValue("@Alex");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it.each(["Tamarack case team", "Alex Rivera"])("keeps the ordinary %s title/name choices unchanged", (sender) => {
    const conversation = { id: "tamarack-ordinary", sender, stewardUserId: "tamarack-east", messages: [{ id: "post-east", sender_id: "tamarack-east", sender_name: "Alex Rivera", sender_kind: "steward", body: "Tamarack", created_at: "2026-11-08T12:00:00-05:00" }] };
    render(<LanguageProvider lang={lang}><MessagesView alt desktop data={{ member: { id: "tamarack-member" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] } }} onSendMessage={vi.fn()} onReadConversation={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(sender) }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "@", selectionStart: 1 } });
    expect(screen.getAllByRole("option")).toHaveLength(sender === "Alex Rivera" ? 1 : 2);
    expect(screen.getByRole("option", { name: "Alex Rivera" })).toBeInTheDocument();
  });
  it("does not invent a third identity from an unbound namesake title", () => {
    const conversation = { id: "tamarack-unbound", sender: "Alex Rivera", messages: people.map((person) => ({ id: `post-${person.id}`, sender_id: person.id, sender_name: person.fullName, sender_kind: "steward", body: "Tamarack", created_at: "2026-11-08T12:00:00-05:00" })) };
    render(<LanguageProvider lang={lang}><MessagesView alt desktop data={{ member: { id: "tamarack-member" }, conversations: [conversation], broadcasts: [], product: { spaces: [], documents: [] } }} onSendMessage={vi.fn()} onReadConversation={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Alex Rivera/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "@Alex", selectionStart: 5 } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    for (const person of people) expect(screen.getByRole("option", { name: `Alex Rivera (${person.id})` })).toBeInTheDocument();
  });
});
