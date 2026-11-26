import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, it, vi } from "vitest";
import { ChannelPollCard } from "../src/components/ChannelPollCard.jsx";
import { ChannelSettingsDialog } from "../src/features/messaging/ChannelControls.jsx";
import { normalizeChannelSetting } from "../src/features/messaging/channelControls.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { expectOneWriteForSameTickDouble } from "./helpers/sameTickActivation.js";
import { expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";

// a review note (4) with 272 (1): the messages slice of record #8435
// (#8831). Its review showed Main sent twice for the poll vote, the channel
// mute, the reply send and the first message to a steward when a control was
// activated twice in one React update. Each pins its own runBusyWrite lock
// ("vote", "channel", "reply", "start"), so each fails with that lock removed.
afterEach(() => { window.localStorage.clear(); window.history.replaceState({}, "", "/m"); });

const wrap = (node) => <LanguageProvider lang="en">{node}</LanguageProvider>;

describe("messaging writes, two activations in one React update", () => {
  it("records a poll vote once", async () => {
    const onVote = vi.fn(async () => ({ mine: "yes" }));
    const poll = { pollId: "poll-1", question: "Keep this schedule?", mine: null, closesAt: null, options: [{ id: "yes", label: "Yes", votes: 1 }, { id: "no", label: "No", votes: 0 }] };
    render(wrap(<ChannelPollCard poll={poll} onVote={onVote} />));
    const option = screen.getAllByRole("button")[0];
    await expectOneWriteForSameTickDouble(onVote, () => option.click());
  });

  it("mutes a channel once", async () => {
    const t = (key, vars) => translate("en", key, vars);
    const on = { channelPinning: true, notificationLevels: true, channelMute: true, mentions: true, hereMentions: true, mentionSearch: true, keywordAlerts: true };
    const controls = { available: true, organizationId: "org", switches: on, keywordLimit: 10, keywordCount: 1, canPin: false, spaces: { s1: { spaceId: "s1", level: "mentions", muted: false, mutedUntil: null, keywords: [] } } };
    const api = { setMute: vi.fn(async (spaceId, muted, until) => normalizeChannelSetting({ spaceId, muted, mutedUntil: until, muteActive: true }, spaceId)) };
    render(wrap(<ChannelSettingsDialog t={t} lang="en" space={{ id: "s1", name: "Shop floor" }} controls={controls} api={api} onSaved={vi.fn()} onClose={() => {}} />));
    fireEvent.change(screen.getByLabelText("Mute for"), { target: { value: "forever" } });
    const mute = screen.getByRole("button", { name: "Mute channel" });
    await expectOneWriteForSameTickDouble(api.setMute, () => mute.click());
  });

  it("sends a reply once", async () => {
    const onSendMessage = vi.fn(async () => ({}));
    const conversation = { id: "c1", sender: "Campaign committee member", initials: "CS", preview: "Hello", dateLabel: "Jul 1", unread: 0, messages: [{ id: "m1", sender_kind: "committee member", sender_name: "Campaign committee member", body: "Hello", created_at: "2026-07-01T12:00:00Z" }] };
    render(wrap(<MessagesView data={{ member: { initials: "DF", fullName: "Darnell Foster" }, conversations: [conversation], broadcasts: [] }} onSendMessage={onSendMessage} onReadConversation={vi.fn().mockResolvedValue(undefined)} onReadBroadcast={vi.fn().mockResolvedValue(undefined)} />));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Campaign committee member/ })); });
    const composer = screen.getByPlaceholderText("Write a message…");
    fireEvent.change(composer, { target: { value: "Following up" } });
    const send = composer.closest("form").querySelector('button[type="submit"], button:not([type])');
    await expectOneWriteForSameTickDouble(onSendMessage, () => send.click());
  });

  // Record 8435, slice 9: each lock ends in the same finally
  // that clears its busy state, so a write that throws at once leaves a ready
  // control whose next press sends.
  it("mutes again from an immediate press after a mute that throws at once", async () => {
    const t = (key, vars) => translate("en", key, vars);
    const on = { channelPinning: true, notificationLevels: true, channelMute: true, mentions: true, hereMentions: true, mentionSearch: true, keywordAlerts: true };
    const controls = { available: true, organizationId: "org", switches: on, keywordLimit: 10, keywordCount: 1, canPin: false, spaces: { s1: { spaceId: "s1", level: "mentions", muted: false, mutedUntil: null, keywords: [] } } };
    const api = { setMute: vi.fn() };
    render(wrap(<ChannelSettingsDialog t={t} lang="en" space={{ id: "s1", name: "Shop floor" }} controls={controls} api={api} onSaved={vi.fn()} onClose={() => {}} />));
    fireEvent.change(screen.getByLabelText("Mute for"), { target: { value: "forever" } });
    await expectReadyRetryAfterThrowAtOnce(api.setMute, screen.getByRole("button", { name: "Mute channel" }));
  });

  it("sends the reply again from an immediate press after a send that throws at once", async () => {
    const onSendMessage = vi.fn();
    const conversation = { id: "c1", sender: "Campaign committee member", initials: "CS", preview: "Hello", dateLabel: "Jul 1", unread: 0, messages: [{ id: "m1", sender_kind: "committee member", sender_name: "Campaign committee member", body: "Hello", created_at: "2026-07-01T12:00:00Z" }] };
    render(wrap(<MessagesView data={{ member: { initials: "DF", fullName: "Darnell Foster" }, conversations: [conversation], broadcasts: [] }} onSendMessage={onSendMessage} onReadConversation={vi.fn().mockResolvedValue(undefined)} onReadBroadcast={vi.fn().mockResolvedValue(undefined)} />));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Campaign committee member/ })); });
    const composer = screen.getByPlaceholderText("Write a message…");
    const send = composer.closest("form").querySelector('button[type="submit"], button:not([type])');
    await expectReadyRetryAfterThrowAtOnce(onSendMessage, send, () => { fireEvent.change(composer, { target: { value: "Following up" } }); send.click(); });
  });

  it("sends a task message again from an immediate press after a send that throws at once", async () => {
    const onSendTaskMessage = vi.fn();
    window.history.replaceState({}, "", "/m/messages?taskThread=task-1");
    const data = { member: { id: "member-1" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] },
      tasks: [{ id: "task-1", title: "Translate member notice", status: "in_progress" }],
      taskMessages: [{ id: "tm-1", taskId: "task-1", senderId: "steward-1", recipientId: "member-1", body: "Draft is ready", createdAt: "2026-08-12T12:00:00Z" }] };
    render(wrap(<MessagesView data={data} desktop onSendMessage={vi.fn()} onSendTaskMessage={onSendTaskMessage} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />));
    const dialog = await screen.findByRole("dialog", { name: "Translate member notice" });
    const box = within(dialog).getByRole("textbox");
    const send = box.closest("form").querySelector('button[type="submit"], button:not([type])');
    await expectReadyRetryAfterThrowAtOnce(onSendTaskMessage, send, () => { fireEvent.change(box, { target: { value: "Thanks" } }); send.click(); });
  });

  it("sends the first message to a steward once", async () => {
    const onStartConversation = vi.fn(async () => ({ id: "c-new" }));
    const peerContact = { available: true, code: "UG-ABCD-1234", canRequest: false, incoming: [], outgoing: [], conversations: [] };
    render(wrap(<MessagesView data={{ member: { id: "member-same-tick" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] }, peerContact }} onSendMessage={vi.fn().mockResolvedValue({})} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn().mockResolvedValue(null)} onOpenTopics={vi.fn()} onStartConversation={onStartConversation} peerContactApi={{ request: vi.fn(), respond: vi.fn(), send: vi.fn() }} />));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Can we talk Monday?" } });
    const start = screen.getByRole("button", { name: "Start conversation" });
    await expectOneWriteForSameTickDouble(onStartConversation, () => start.click());
  });
});
