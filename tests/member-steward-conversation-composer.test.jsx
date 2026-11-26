import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922, inbox half.
//
// Contact on a steward card that has no thread yet has to land somewhere. It
// cannot mint an empty conversation — start_member_conversation's whole point
// was that a shell can never be stranded — so the inbox opens a composer
// addressed to that steward, and the send creates the bound conversation and
// its first message in one transaction.

function makeData(conversations = []) {
  return {
    member: { id: "member-1" },
    conversations,
    broadcasts: [],
    product: { spaces: [], documents: [] },
  };
}

function show({ focus = null, conversations = [], onStartStewardConversation = vi.fn() } = {}) {
  render(
    <LanguageProvider lang="en">
      <MessagesView
        data={makeData(conversations)}
        focus={focus}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        onStartStewardConversation={onStartStewardConversation}
      />
    </LanguageProvider>,
  );
  return onStartStewardConversation;
}

const stewardFocus = { view: "messages", startStewardUserId: "steward-priya", stewardName: "Priya Chandran" };

describe("steward-addressed first message", () => {
  beforeEach(() => window.localStorage.clear());

  it("opens a composer naming the steward the member pressed Contact on", () => {
    show({ focus: stewardFocus });
    expect(screen.getByRole("heading", { name: "Start a conversation with Priya Chandran" })).toBeInTheDocument();
    expect(screen.getByLabelText("First message to your committee contact")).toBeInTheDocument();
  });

  it("falls back to the localized counterpart name when the card carried none", () => {
    show({ focus: { view: "messages", startStewardUserId: "steward-priya" } });
    expect(screen.getByRole("heading", { name: "Start a conversation with Campaign committee member" })).toBeInTheDocument();
  });

  it("sends the first message against that steward's id and opens the new thread", async () => {
    const onStart = vi.fn().mockResolvedValue({ conversationId: "conv-priya" });
    show({
      focus: stewardFocus,
      onStartStewardConversation: onStart,
      conversations: [{
        id: "conv-priya", counterpartRole: "steward", stewardUserId: "steward-priya",
        sender: "Priya Chandran", initials: "PC", preview: "Hello", dateLabel: "Sep 22", unread: 0, messages: [],
      }],
    });
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Can we talk about my schedule?" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith("steward-priya", "Can we talk about my schedule?"));
    // The composer closes once the bound conversation exists.
    await waitFor(() => expect(screen.queryByRole("heading", { name: /Start a conversation with/ })).toBeNull());
  });

  it("keeps the composer and shows an error when the send fails", async () => {
    const onStart = vi.fn().mockRejectedValue(new Error("offline"));
    show({ focus: stewardFocus, onStartStewardConversation: onStart });
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Help" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Start a conversation with Priya Chandran" })).toBeInTheDocument();
  });

  it("lets the member back out without writing anything", () => {
    show({ focus: stewardFocus });
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("heading", { name: /Start a conversation with/ })).toBeNull();
  });

  it("stays out of the way for an ordinary inbox visit", () => {
    show({ focus: null });
    expect(screen.queryByRole("heading", { name: /Start a conversation with/ })).toBeNull();
  });

  it("is not offered when the app passed no steward-scoped starter", () => {
    // App only supplies onStartStewardConversation for a real session; without
    // it the focus must not render a composer that cannot send.
    render(
      <LanguageProvider lang="en">
        <MessagesView
          data={makeData()}
          focus={stewardFocus}
          onSendMessage={vi.fn()}
          onReadConversation={vi.fn().mockResolvedValue(null)}
          onReadBroadcast={vi.fn().mockResolvedValue(null)}
          onOpenTopics={vi.fn()}
        />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("heading", { name: /Start a conversation with/ })).toBeNull();
  });

  it("still honours a plain conversation deep link", async () => {
    const onRead = vi.fn().mockResolvedValue(null);
    render(
      <LanguageProvider lang="en">
        <MessagesView
          data={makeData([{
            id: "conv-1", counterpartRole: "steward", stewardUserId: null, sender: "Chapter steward",
            initials: "CS", preview: "Hi", dateLabel: "Sep 22", unread: 0, messages: [],
          }])}
          focus={{ view: "messages", conversationId: "conv-1" }}
          onSendMessage={vi.fn()}
          onReadConversation={onRead}
          onReadBroadcast={vi.fn().mockResolvedValue(null)}
          onOpenTopics={vi.fn()}
          onStartStewardConversation={vi.fn()}
        />
      </LanguageProvider>,
    );
    await waitFor(() => expect(onRead).toHaveBeenCalledWith("conv-1"));
    expect(screen.queryByRole("heading", { name: /Start a conversation with/ })).toBeNull();
  });

  it("projects the steward id the inbox needs to tell two threads apart", () => {
    show({
      conversations: [
        { id: "a", counterpartRole: "steward", stewardUserId: "steward-sam", sender: "Sam Okafor", initials: "SO", preview: "One", dateLabel: "Sep 21", unread: 0, messages: [] },
        { id: "b", counterpartRole: "steward", stewardUserId: "steward-priya", sender: "Priya Chandran", initials: "PC", preview: "Two", dateLabel: "Sep 22", unread: 0, messages: [] },
      ],
    });
    const feed = document.querySelector(".inbox-feed") ?? document.body;
    expect(within(feed).getByText("Sam Okafor")).toBeInTheDocument();
    expect(within(feed).getByText("Priya Chandran")).toBeInTheDocument();
  });
});
