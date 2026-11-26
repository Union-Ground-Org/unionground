import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { MessagesView } from "../src/views/MessagesView.jsx";

// Demo Messages: a sent reply must appear in the open thread and opening a
// thread must clear its unread pill — both were success-toast no-ops before
// this wave.
beforeEach(() => {
  window.history.replaceState({}, "", "/m/messages");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

describe("demo Messages", () => {
  it("adds and removes a confirmed preview reaction without changing the shared fixture", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Messages" });
    fireEvent.click(screen.getByRole("button", { name: /Committee.*Write down what they asked/ }));
    const dialog = await screen.findByRole("dialog", { name: "Committee" });
    fireEvent.click(within(dialog).getByRole("button", { name: "React" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Solidarity" }));
    const selected = await within(dialog).findByRole("button", { name: "Solidarity: 1" });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(selected);
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Solidarity: 1" })).not.toBeInTheDocument());
    // A seeded legacy selection removes on the first click too.
    fireEvent.click(within(dialog).getByRole("button", { name: "Support: 1" }));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "Support: 1" })).not.toBeInTheDocument());
    expect(fallbackData.conversations[0].messages[0].reactions).toHaveLength(1);
    expect(fallbackData.conversations[0].messages[0].reactions[0].reaction).toBe("support");
  });

  it("appends a sent reply to the open conversation and updates the row preview", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Messages" });
    fireEvent.click(screen.getByRole("button", { name: /Committee.*Write down what they asked/ }));
    const dialog = await screen.findByRole("dialog", { name: "Committee" });
    const composer = within(dialog).getByLabelText("Write a message…");
    fireEvent.change(composer, { target: { value: "What should I bring to Thursday's huddle?" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    expect(await within(dialog).findByText("What should I bring to Thursday's huddle?")).toBeInTheDocument();
    await waitFor(() => expect(composer).toHaveValue(""));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const layer = dialog.closest(".sg-detail-layer");
    expect(layer).toHaveAttribute("data-state", "closing");
    // The prototype's modal keeps focus inside while its scrim fades.
    expect(layer).not.toHaveAttribute("inert");
    fireEvent.transitionEnd(layer);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Committee" })).not.toBeInTheDocument());
    // The inbox row now previews the reply, like the real loader would.
    expect(screen.getByText("What should I bring to Thursday's huddle?")).toBeInTheDocument();
    // Immutability: the shared fixture object must not have grown the message.
    expect(fallbackData.conversations[0].messages).toHaveLength(1);
  });

  it("clears the unread pill when a conversation is opened", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Messages" });
    const row = screen.getByRole("button", { name: /Committee.*Write down what they asked/ });
    expect(within(row).getByText("1")).toBeInTheDocument();
    fireEvent.click(row);
    await screen.findByRole("dialog", { name: "Committee" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(within(row).queryByText("1")).not.toBeInTheDocument());
    expect(fallbackData.conversations[0].unread).toBe(1);
  });

  it("opens the newest conversation from the Message-your-steward action", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Messages" });
    fireEvent.click(screen.getByRole("button", { name: "Message your committee contact" }));
    expect(await screen.findByRole("dialog", { name: "Committee" })).toBeInTheDocument();
  });

  it("does not show the start-empty block above a non-empty workflow list", () => {
    const data = {
      conversations: [],
      broadcasts: [{
        id: "b-1",
        title: "July committee meeting",
        sender: "Harborview Care United",
        body: "Thursday 6pm at the hall.",
        unread: true,
        publishedAt: "2026-07-10T18:00:00.000Z",
      }],
      product: {
        spaces: [{ id: "s1", threads: [{ id: "th1", title: "Parking changes", kind: "topic", status: "open", posts: [] }] }],
      },
    };
    render(<MessagesView data={data} onProfile={vi.fn()} onAssistant={vi.fn()} onSendMessage={vi.fn()} onStartConversation={vi.fn()} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenCases={vi.fn()} onOpenRights={vi.fn()} />);
    expect(screen.getByText(/2 items/)).toBeInTheDocument();
    expect(screen.getByText("# Parking changes")).toBeInTheDocument();
    expect(screen.getByText("July committee meeting")).toBeInTheDocument();
    expect(screen.queryByText(/No private threads yet/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("First message to your committee contact")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request a committee contact" })).not.toBeInTheDocument();
  });

  it("starts the first direct conversation and keeps the two alternative doors", async () => {
    const data = { conversations: [], broadcasts: [], product: { spaces: [] } };
    const onOpenCases = vi.fn();
    const onRequestSteward = vi.fn();
    const onStartConversation = vi.fn().mockResolvedValue({ conversationId: "new-conversation" });
    render(<MessagesView data={data} onProfile={vi.fn()} onAssistant={vi.fn()} onSendMessage={vi.fn()} onStartConversation={onStartConversation} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} onOpenCases={onOpenCases} onRequestSteward={onRequestSteward} />);
    expect(screen.getByText(/Send a first message/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "I need help understanding a deadline." } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    await waitFor(() => expect(onStartConversation).toHaveBeenCalledWith("I need help understanding a deadline."));
    fireEvent.click(screen.getByRole("button", { name: "Go to My issues" }));
    expect(onOpenCases).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Request a committee contact" }));
    expect(onRequestSteward).toHaveBeenCalledOnce();
    // Until refresh supplies the new row, the existing-thread shortcut has
    // nothing to open and must not render.
    expect(screen.queryByRole("button", { name: "Message your committee contact" })).not.toBeInTheDocument();
    expect(screen.queryByText(/steward/i)).not.toBeInTheDocument();
  });

  it("locks double-submit and preserves the first message after failure", async () => {
    let rejectStart;
    const onStartConversation = vi.fn(() => new Promise((resolve, reject) => { rejectStart = reject; }));
    render(<MessagesView data={{ conversations: [], broadcasts: [], product: { spaces: [] } }} onSendMessage={vi.fn()} onStartConversation={onStartConversation} onReadConversation={vi.fn()} onReadBroadcast={vi.fn()} onOpenTopics={vi.fn()} />);
    const field = screen.getByLabelText("First message to your committee contact");
    fireEvent.change(field, { target: { value: "Please contact me." } });
    const form = field.closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onStartConversation).toHaveBeenCalledOnce();
    rejectStart(new Error("offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("message is still here");
    expect(field).toHaveValue("Please contact me.");
  });

  it("clears an announcement's unread dot after it is read", async () => {
    render(<App />);
    await screen.findByRole("heading", { name: "Messages" });
    fireEvent.click(screen.getByRole("button", { name: "Announcements" }));
    const row = screen.getByText("Campaign briefing 1").closest("button");
    expect(within(row).getByLabelText("Unread")).toBeInTheDocument();
    fireEvent.click(row);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(within(row).queryByLabelText("Unread")).not.toBeInTheDocument());
  });
});
