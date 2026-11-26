// BUG-UG-PRIVATE-TWO-PERSON-MESSAGES-SEND-NO-NOTIFICATION-20261118 (#9173):
// a private two-person message notice (copy key peer.message) opens that
// conversation on the website, and its arrival or opening re-reads the
// cached two-person conversations.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { notificationDestination } from "../src/lib/notificationDestinations.js";
import { notificationRefreshResources } from "../src/lib/memberSessionLoader.js";

const CONVERSATION = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const openThread = () => document.querySelector(".inbox-detail__head-name")?.textContent ?? null;
const notice = { id: "n1", kind: "messages", copy_key: "peer.message", title: "New private message", body: "Someone wrote to you in a private conversation. Open Messages to read it.", peer_conversation_id: CONVERSATION, source_chapter_id: null };

function peerContact(conversations) {
  return { available: true, code: "", canRequest: false, incoming: [], outgoing: [], conversations };
}
const conversation = (id, peerName, body) => ({ id, peerName, peerInitials: peerName.slice(0, 2).toUpperCase(), updatedAt: "2026-11-18T22:00:00Z", messages: [{ id: `${id}-m`, sentByMe: false, body, createdAt: "2026-11-18T22:00:00Z" }] });

function view(contact, extra = {}) {
  return (
    <LanguageProvider lang="en">
      <MessagesView
        data={{ member: { id: "member-9173" }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] }, peerContact: contact }}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        peerContactApi={{ request: vi.fn(), respond: vi.fn(), send: vi.fn() }}
        desktop
        {...extra}
      />
    </LanguageProvider>
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/m");
});

describe("the peer message notice destination", () => {
  it("opens the conversation the notice names, in Messages", () => {
    expect(notificationDestination(notice)).toEqual({ view: "messages", path: `/m/messages?peerConversation=${CONVERSATION}` });
    // Not chapter-scoped: a cross-chapter conversation opens from any selected chapter.
    expect(notificationDestination(notice, { chapterId: "another-chapter" })).toEqual(notificationDestination(notice));
  });

  it("stays plain text without a well-formed conversation id", () => {
    for (const value of [null, undefined, "", "not-a-uuid", `${CONVERSATION}&filter=all`, 42]) {
      expect(notificationDestination({ ...notice, peer_conversation_id: value })).toBeNull();
    }
    // The id alone opens nothing under another key.
    expect(notificationDestination({ ...notice, copy_key: "channel.mention" })).toBeNull();
  });

  it("re-reads the two-person conversations when the notice arrives or is opened, and nothing else", () => {
    expect(notificationRefreshResources(notice)).toEqual(["rpc:list_reward_peer_contact"]);
    expect(notificationRefreshResources({ kind: "messages", copy_key: "channel.mention" })).toEqual([]);
  });
});

describe("Messages opened from a peer message notice", () => {
  it("opens that two-person conversation", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    render(view(peerContact([conversation(OTHER, "Fictional Rowan", "Other note"), conversation(CONVERSATION, "Fictional Marisol", "Shift swap?")])));
    await waitFor(() => expect(openThread()).toBe("Fictional Marisol"));
  });

  it("opens it once the re-read conversations carry it", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    const { rerender } = render(view(peerContact([])));
    expect(openThread()).toBeNull();
    rerender(view(peerContact([conversation(CONVERSATION, "Fictional Marisol", "Late note")])));
    await waitFor(() => expect(openThread()).toBe("Fictional Marisol"));
  });

  it("leaves the ordinary inbox for a conversation the member does not have", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    render(view(peerContact([conversation(OTHER, "Fictional Rowan", "Other note")])));
    await waitFor(() => expect(screen.getAllByText("Fictional Rowan").length).toBeGreaterThan(0));
    expect(openThread()).toBeNull();
  });

  // #9470 (W8-9): once a re-read list arrives and still lacks it, the member is told, with Dismiss.
  it("says the conversation is no longer available when the re-read list still lacks it", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    const rowan = conversation(OTHER, "Fictional Rowan", "Other note");
    const { rerender } = render(view(peerContact([rowan])));
    await waitFor(() => expect(screen.getAllByText("Fictional Rowan").length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(view(peerContact([rowan])));
    expect(await screen.findByRole("alert")).toHaveTextContent("That message is no longer available, or you no longer have access to it.");
    expect(openThread()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #9470 (W8-9, review): a list that failed to load is not proof the message is gone.
  const failedList = () => ({ available: false, unavailable: true, canRequest: false, code: "", incoming: [], outgoing: [], conversations: [] });
  it("says the list could not be loaded, and Try again opens the conversation a fresh read carries", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    const list = vi.fn().mockResolvedValue(peerContact([conversation(CONVERSATION, "Fictional Marisol", "Late note")]));
    const extra = { peerContactApi: { request: vi.fn(), respond: vi.fn(), send: vi.fn(), list } };
    const { rerender } = render(view(peerContact([]), extra));
    rerender(view(failedList(), extra));
    expect(await screen.findByRole("alert")).toHaveTextContent("The linked message could not be loaded.");
    expect(screen.queryByText(/no longer available/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(openThread()).toBe("Fictional Marisol"));
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the conversation is gone only after Try again reads a list that lacks it, and stays on failed when the read fails", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    const list = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(peerContact([]));
    const extra = { peerContactApi: { request: vi.fn(), respond: vi.fn(), send: vi.fn(), list } };
    const { rerender } = render(view(peerContact([]), extra));
    rerender(view(failedList(), extra));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("The linked message could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That message is no longer available, or you no longer have access to it."));
  });

  it("drops a Try again answer once a newer list has arrived while it was reading", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    let settle;
    const list = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const onPeerContactChange = vi.fn();
    const extra = { peerContactApi: { request: vi.fn(), respond: vi.fn(), send: vi.fn(), list }, onPeerContactChange };
    const { rerender } = render(view(peerContact([]), extra));
    rerender(view(failedList(), extra));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    rerender(view(failedList(), extra));
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    await act(async () => { settle(peerContact([])); });
    expect(screen.getByRole("alert")).toHaveTextContent("The linked message could not be loaded.");
    expect(screen.queryByText(/no longer available/)).toBeNull();
    expect(onPeerContactChange).not.toHaveBeenCalled();
  });

  it("offers no Try again it cannot carry out, only Dismiss", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    const { rerender } = render(view(peerContact([])));
    rerender(view(failedList()));
    expect(await screen.findByRole("alert")).toHaveTextContent("The linked message could not be loaded.");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("keeps waiting, and says nothing, when a full window of 50 conversations lacks it", async () => {
    window.history.replaceState({}, "", `/m/messages?peerConversation=${CONVERSATION}`);
    const fifty = Array.from({ length: 50 }, (_, index) => conversation(`0a1b2c3d-4e5f-4a6b-8c7d-${String(index).padStart(12, "0")}`, `Fictional Peer ${index}`, "Note"));
    const { rerender } = render(view(peerContact(fifty)));
    rerender(view(peerContact([...fifty])));
    await waitFor(() => expect(screen.getAllByText("Fictional Peer 0").length).toBeGreaterThan(0));
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(view(peerContact([conversation(CONVERSATION, "Fictional Marisol", "Older note"), ...fifty.slice(1)])));
    await waitFor(() => expect(openThread()).toBe("Fictional Marisol"));
  });
});

// #9191 round 1 (r1s1 = r2s1, r1s3 = r2s2): a notice opened again reopens its
// conversation over a hand-picked one, and a conversation picked by hand wins
// over a notice still waiting for the re-read list.
const PATH = `/m/messages?peerConversation=${CONVERSATION}`;
const pick = (name) => {
  const row = screen.getAllByText(name).map((node) => node.closest("button")).find(Boolean);
  fireEvent.click(row);
};

describe("Messages after a peer message notice, round 1 repairs", () => {
  it("reopens the notice's conversation when the same notice is opened again after another was chosen", async () => {
    window.history.replaceState({}, "", PATH);
    const contact = peerContact([conversation(OTHER, "Fictional Rowan", "Other note"), conversation(CONVERSATION, "Fictional Marisol", "Shift swap?")]);
    const { rerender } = render(view(contact, { notificationOpenIntent: { id: 1, path: PATH } }));
    await waitFor(() => expect(openThread()).toBe("Fictional Marisol"));
    pick("Fictional Rowan");
    await waitFor(() => expect(openThread()).toBe("Fictional Rowan"));
    // The same address again: only the new open intent can bring it back.
    rerender(view(contact, { notificationOpenIntent: { id: 2, path: PATH } }));
    await waitFor(() => expect(openThread()).toBe("Fictional Marisol"));
  });

  it("does not reapply on a re-render without a new open, nor for an open of another screen", async () => {
    window.history.replaceState({}, "", PATH);
    const contact = peerContact([conversation(OTHER, "Fictional Rowan", "Other note"), conversation(CONVERSATION, "Fictional Marisol", "Shift swap?")]);
    const { rerender } = render(view(contact, { notificationOpenIntent: { id: 1, path: PATH } }));
    await waitFor(() => expect(openThread()).toBe("Fictional Marisol"));
    pick("Fictional Rowan");
    await waitFor(() => expect(openThread()).toBe("Fictional Rowan"));
    rerender(view({ ...contact }, { notificationOpenIntent: { id: 1, path: PATH } }));
    rerender(view({ ...contact }, { notificationOpenIntent: { id: 2, path: "/m/settings/requests" } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openThread()).toBe("Fictional Rowan");
  });

  it("keeps a conversation chosen by hand when the notice's conversation arrives later", async () => {
    window.history.replaceState({}, "", PATH);
    const rowan = conversation(OTHER, "Fictional Rowan", "Other note");
    const { rerender } = render(view(peerContact([rowan]), { notificationOpenIntent: { id: 1, path: PATH } }));
    expect(openThread()).toBeNull();
    pick("Fictional Rowan");
    await waitFor(() => expect(openThread()).toBe("Fictional Rowan"));
    rerender(view(peerContact([conversation(CONVERSATION, "Fictional Marisol", "Late note"), rowan]), { notificationOpenIntent: { id: 1, path: PATH } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openThread()).toBe("Fictional Rowan");
  });
});
