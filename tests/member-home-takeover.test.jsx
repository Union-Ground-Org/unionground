// REQ-UG-HOME-OVERRIDE-UNREAD-STEWARD-MESSAGE-20261001: the member Home
// takeover for the newest unread steward message and broadcast.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { HomeTakeover } from "../src/features/memberHome/HomeTakeover.jsx";
import {
  HOME_TAKEOVER_PREVIEW_CHARS,
  HOME_TAKEOVER_RPC,
  hideReadTakeoverItems,
  homeTakeoverFromSnapshot,
  homeTakeoverSignature,
  normalizeHomeTakeover,
} from "../src/features/memberHome/takeover.js";
import { catalogue } from "../src/lib/i18n.js";

const SWITCH = "features.home.unread_message_takeover";

function snapshot(overrides = {}) {
  return {
    organizationConfiguration: { switches: { [SWITCH]: true } },
    conversations: [
      {
        id: "conv-1",
        unread: 1,
        messages: [
          { id: "old", sender_kind: "steward", sender_name: "Dana Whitfield", body: "Earlier note", created_at: "2026-09-01T10:00:00Z", read_at: null },
          { id: "mine", sender_kind: "member", sender_name: "Member", body: "My reply", created_at: "2026-09-03T10:00:00Z", read_at: null },
          { id: "newest", sender_kind: "steward", sender_name: "Dana Whitfield", body: "Your Step 2 meeting is Thursday.", created_at: "2026-09-02T10:00:00Z", read_at: null },
        ],
      },
      {
        id: "conv-2",
        unread: 0,
        messages: [
          { id: "read", sender_kind: "steward", sender_name: "Sam", body: "Already read", created_at: "2026-09-05T10:00:00Z", read_at: "2026-09-05T11:00:00Z" },
          { id: "removed", sender_kind: "steward", sender_name: "Sam", body: "", created_at: "2026-09-06T10:00:00Z", read_at: null, redacted_at: "2026-09-06T12:00:00Z" },
        ],
      },
    ],
    broadcasts: [
      { id: "b-old", title: "Old notice", body: "Old", publishedAt: "2026-08-01T10:00:00Z", unread: true, sender: "Chapter office", audience: "chapter" },
      { id: "b-new", title: "Contract vote opens", body: "Vote by Friday.", publishedAt: "2026-09-04T10:00:00Z", unread: true, sender: "Chapter office", audience: "chapter" },
      { id: "b-read", title: "Read notice", body: "Read", publishedAt: "2026-09-08T10:00:00Z", unread: false },
      { id: "b-future", title: "Scheduled", body: "Later", publishedAt: "2999-01-01T00:00:00Z", unread: true },
    ],
    ...overrides,
  };
}

function renderTakeover(props) {
  return render(<LanguageProvider><HomeTakeover {...props} /></LanguageProvider>);
}

describe("home takeover model", () => {
  it("returns nothing unless the server says the switch is on", () => {
    expect(normalizeHomeTakeover(null)).toEqual({ enabled: false, message: null, broadcast: null });
    expect(normalizeHomeTakeover({ enabled: false, message: { id: "x" } })).toEqual({ enabled: false, message: null, broadcast: null });
  });

  it("drops malformed items instead of rendering half a card", () => {
    const result = normalizeHomeTakeover({
      enabled: true,
      message: { id: "m", conversationId: "c", body: "   ", createdAt: "2026-09-01T00:00:00Z" },
      broadcast: { id: "b", title: "Title", publishedAt: "not a date" },
    });
    expect(result).toEqual({ enabled: true, message: null, broadcast: null });
  });

  it("keeps a well-formed payload and only known audiences", () => {
    const result = normalizeHomeTakeover({
      enabled: true,
      message: { id: "m", conversationId: "c", senderName: " Dana ", body: "Hello", truncated: true, createdAt: "2026-09-01T00:00:00Z" },
      broadcast: { id: "b", title: "Vote", body: "Body", sender: "Office", publishedAt: "2026-09-02T00:00:00Z", audience: "everyone" },
    });
    expect(result.message).toEqual({ id: "m", conversationId: "c", senderName: "Dana", body: "Hello", truncated: true, createdAt: "2026-09-01T00:00:00Z" });
    expect(result.broadcast).toMatchObject({ id: "b", title: "Vote", audience: null });
  });

  it("derives the newest unread steward message and newest unread published broadcast from a snapshot", () => {
    const result = homeTakeoverFromSnapshot(snapshot());
    expect(result.message).toMatchObject({ id: "newest", conversationId: "conv-1", senderName: "Dana Whitfield" });
    expect(result.broadcast).toMatchObject({ id: "b-new", title: "Contract vote opens", audience: "chapter" });
  });

  it("bounds the snapshot preview to the server's preview length", () => {
    const long = "x".repeat(HOME_TAKEOVER_PREVIEW_CHARS + 10);
    const data = snapshot({ conversations: [{ id: "c", messages: [{ id: "m", sender_kind: "steward", sender_name: "S", body: long, created_at: "2026-09-01T00:00:00Z" }] }], broadcasts: [] });
    const { message } = homeTakeoverFromSnapshot(data);
    expect(message.body).toHaveLength(HOME_TAKEOVER_PREVIEW_CHARS);
    expect(message.truncated).toBe(true);
  });

  it("hides an item as soon as the snapshot records the read, but never one the snapshot has not seen", () => {
    const takeover = { enabled: true, message: { id: "newest", conversationId: "conv-1" }, broadcast: { id: "b-new" } };
    const read = snapshot();
    read.conversations[0].messages = read.conversations[0].messages.map((row) => ({ ...row, read_at: "2026-09-09T00:00:00Z" }));
    read.broadcasts = read.broadcasts.map((row) => ({ ...row, unread: false }));
    expect(hideReadTakeoverItems(takeover, read)).toEqual({ enabled: true, message: null, broadcast: null });
    const unseen = { enabled: true, message: { id: "brand-new", conversationId: "conv-1" }, broadcast: { id: "b-unknown" } };
    expect(hideReadTakeoverItems(unseen, read)).toEqual(unseen);
  });

  it("changes its signature when unread state changes", () => {
    const before = homeTakeoverSignature(snapshot());
    const after = snapshot();
    after.conversations[0].unread = 0;
    expect(homeTakeoverSignature(after)).not.toBe(before);
  });

  it("has English and Spanish copy for every key, including the switch definition", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("homeTakeover.") || key.startsWith(`settings.def.${SWITCH}.`));
    expect(keys.length).toBeGreaterThanOrEqual(13);
    for (const key of keys) expect(catalogue.es[key], key).toBeTruthy();
  });
});

describe("HomeTakeover", () => {
  it("shows the steward message first and the broadcast second in a preview session", () => {
    renderTakeover({ data: snapshot(), transport: { preview: true } });
    const region = screen.getByRole("region", { name: "Unread updates" });
    const cards = within(region).getAllByRole("article");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole("heading", { name: "Dana Whitfield wrote to you" })).toBeTruthy();
    expect(within(cards[0]).getByText("Your Step 2 meeting is Thursday.")).toBeTruthy();
    expect(within(cards[1]).getByRole("heading", { name: "Contract vote opens" })).toBeTruthy();
    expect(within(cards[1]).getByText("Campaign announcement")).toBeTruthy();
  });

  it("renders nothing when the organization switch is off", () => {
    const data = snapshot({ organizationConfiguration: { switches: { [SWITCH]: false } } });
    const { container } = renderTakeover({ data, transport: { preview: true } });
    expect(container.firstChild).toBeNull();
  });

  it("opens the conversation and the broadcast through the Messages handlers", () => {
    const onOpenConversation = vi.fn();
    const onOpenBroadcast = vi.fn();
    renderTakeover({ data: snapshot(), transport: { preview: true }, onOpenConversation, onOpenBroadcast });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Read announcement" }));
    expect(onOpenConversation).toHaveBeenCalledWith("conv-1");
    expect(onOpenBroadcast).toHaveBeenCalledWith("b-new");
  });

  it("marks the message read and lets the next unread item take the slot", async () => {
    const onMarkConversationRead = vi.fn(async () => {});
    const data = snapshot();
    const { rerender } = renderTakeover({ data, transport: { preview: true }, onMarkConversationRead, onMarkBroadcastRead: vi.fn() });
    const [messageCard] = screen.getAllByRole("article");
    await expectHeldWriteFocus(onMarkConversationRead, within(messageCard).getByRole("button", { name: "Mark read" }));
    expect(onMarkConversationRead).toHaveBeenCalledWith("conv-1");
    // App patches the snapshot read state; the card leaves and the broadcast stays.
    const read = snapshot();
    read.conversations[0].messages = read.conversations[0].messages.map((row) => ({ ...row, read_at: "2026-09-09T00:00:00Z" }));
    rerender(<LanguageProvider><HomeTakeover data={read} transport={{ preview: true }} onMarkConversationRead={onMarkConversationRead} /></LanguageProvider>);
    expect(screen.queryByRole("heading", { name: "Dana Whitfield wrote to you" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Contract vote opens" })).toBeTruthy();
  });

  it("leaves Home usable when the captured session's takeover read rejects", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("offline"));
    const { container } = renderTakeover({ data: snapshot(), transport: { createSessionClient: () => ({ rpc }), session: { access_token: "t" } } });
    await act(async () => {});
    expect(rpc).toHaveBeenCalledWith(HOME_TAKEOVER_RPC);
    expect(container.firstChild).toBeNull();
  });

  it("keeps the card and says so when marking read fails", async () => {
    const onMarkBroadcastRead = vi.fn(async () => { throw new Error("offline"); });
    renderTakeover({ data: snapshot(), transport: { preview: true }, onMarkConversationRead: vi.fn(), onMarkBroadcastRead });
    const broadcastCard = screen.getAllByRole("article")[1];
    await act(async () => { fireEvent.click(within(broadcastCard).getByRole("button", { name: "Mark read" })); });
    expect(screen.getByRole("alert").textContent).toBe("That couldn't be marked read. Try again.");
    expect(screen.getByRole("heading", { name: "Contract vote opens" })).toBeTruthy();
  });

  it("reads the server takeover with the session-captured client in a live session", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        enabled: true,
        message: { id: "live-m", conversationId: "live-c", senderName: "Avery", body: "Call me back today.", createdAt: "2026-09-10T10:00:00Z" },
        broadcast: null,
      },
      error: null,
    }));
    const createSessionClient = vi.fn(() => ({ rpc }));
    renderTakeover({ data: snapshot(), transport: { createSessionClient, session: { access_token: "token-1" } } });
    expect(await screen.findByRole("heading", { name: "Avery wrote to you" })).toBeTruthy();
    expect(createSessionClient).toHaveBeenCalledWith({ access_token: "token-1" });
    expect(rpc).toHaveBeenCalledWith(HOME_TAKEOVER_RPC);
    // Live sessions never fall back to the snapshot's own items.
    expect(screen.queryByRole("heading", { name: "Contract vote opens" })).toBeNull();
  });

  it("renders nothing when the live read is refused", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501" } }));
    const { container } = renderTakeover({ data: snapshot(), transport: { createSessionClient: () => ({ rpc }), session: { access_token: "t" } } });
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("does not call the server when the member configuration has the switch off", async () => {
    const rpc = vi.fn();
    const data = snapshot({ organizationConfiguration: { switches: { [SWITCH]: false } } });
    renderTakeover({ data, transport: { createSessionClient: () => ({ rpc }), session: { access_token: "t" } } });
    await act(async () => {});
    expect(rpc).not.toHaveBeenCalled();
  });

  it("re-reads the server when the snapshot's unread state changes", async () => {
    const rpc = vi.fn(async () => ({ data: { enabled: true, message: null, broadcast: null }, error: null }));
    const transport = { createSessionClient: () => ({ rpc }), session: { access_token: "t" } };
    const { rerender } = renderTakeover({ data: snapshot(), transport });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const changed = snapshot();
    changed.conversations[1].unread = 2;
    rerender(<LanguageProvider><HomeTakeover data={changed} transport={transport} /></LanguageProvider>);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  });
});
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
