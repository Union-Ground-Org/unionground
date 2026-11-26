// BUG-UG-PHONE-CONTACTS-PANEL-COVERS-COMPOSER-20261006: at phone width
// the Contacts panel was a short dialog with the message box showing beneath
// it, so a tap on Start conversation only closed the panel; and the typed first
// message lived in the form alone, so a reload that unmounted the inbox (the
// slow loading screen) or a failed start that came back to a fresh form lost it.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const peerContact = { available: true, code: "PSG-ABCD-1234", canRequest: false, incoming: [], outgoing: [], conversations: [] };

function view({ memberId = "member-1", onStartConversation = vi.fn(), desktop = false, ...extra } = {}) {
  return (
    <LanguageProvider lang="en">
      <MessagesView
        data={{ member: { id: memberId }, conversations: [], broadcasts: [], product: { spaces: [], documents: [] }, peerContact }}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        onStartConversation={onStartConversation}
        peerContactApi={{ request: vi.fn(), respond: vi.fn(), send: vi.fn() }}
        desktop={desktop}
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

describe("the first message to a steward", () => {
  it("keeps Start conversation focused while the first message is sent, and sends it once (#8435)", async () => {
    const onStartConversation = vi.fn(async () => ({ id: "c-new" }));
    render(view({ memberId: "member-focus", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Can we talk Monday?" } });
    await expectHeldWriteFocus(onStartConversation, screen.getByRole("button", { name: "Start conversation" }));
    expect(onStartConversation).toHaveBeenCalledTimes(1);
  });

  it("keeps the typed text when a failed start comes back to a remounted inbox", async () => {
    let fail;
    const onStartConversation = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const first = render(view({ memberId: "member-keep", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "My shift was cut without notice" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    // The slow reload replaces the inbox with the loading screen mid-send.
    first.unmount();
    fail(new Error("Request timed out"));
    render(view({ memberId: "member-keep", onStartConversation }));
    expect(screen.getByLabelText("First message to your committee contact")).toHaveValue("My shift was cut without notice");
  });

  it("keeps the draft beside a failed start and forgets it once the conversation starts", async () => {
    const onStartConversation = vi.fn()
      .mockRejectedValueOnce(new Error("Request timed out"))
      .mockResolvedValueOnce({ conversationId: "conversation-1" });
    const first = render(view({ memberId: "member-sent", onStartConversation }));
    const box = screen.getByLabelText("First message to your committee contact");
    fireEvent.change(box, { target: { value: "Overtime question" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(box).toHaveValue("Overtime question");
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    await waitFor(() => expect(onStartConversation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(box).toHaveValue(""));
    first.unmount();
    render(view({ memberId: "member-sent", onStartConversation }));
    expect(screen.getByLabelText("First message to your committee contact")).toHaveValue("");
  });

  it("holds a remounted form while the first start is still in flight, so it cannot send twice", async () => {
    let finish;
    const onStartConversation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = render(view({ memberId: "member-inflight", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Schedule changed again" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    render(view({ memberId: "member-inflight", onStartConversation }));
    const box = screen.getByLabelText("First message to your committee contact");
    expect(box).toHaveValue("Schedule changed again");
    expect(box).toHaveAttribute("aria-disabled", "true");
    const start = screen.getByRole("button", { name: /Starting|Start conversation/ });
    expect(start).toHaveAttribute("aria-disabled", "true");
    fireEvent.submit(box.closest("form"));
    expect(onStartConversation).toHaveBeenCalledTimes(1);
    finish({ conversationId: "conversation-inflight" });
    await waitFor(() => expect(screen.getByLabelText("First message to your committee contact")).toHaveValue(""));
    expect(onStartConversation).toHaveBeenCalledTimes(1);
  });

  it("returns a remounted form to the saved draft and the error when the in-flight start fails", async () => {
    let fail;
    const onStartConversation = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const first = render(view({ memberId: "member-inflight-fail", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Pay stub is wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    render(view({ memberId: "member-inflight-fail", onStartConversation }));
    fail(new Error("Request timed out"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const box = screen.getByLabelText("First message to your committee contact");
    expect(box).toHaveValue("Pay stub is wrong");
    expect(box).toBeEnabled();
  });

  it("keeps the draft when a start resolves without a conversation", async () => {
    const onStartConversation = vi.fn().mockResolvedValue(undefined);
    render(view({ memberId: "member-superseded", onStartConversation }));
    const box = screen.getByLabelText("First message to your committee contact");
    fireEvent.change(box, { target: { value: "Still waiting on my schedule" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(box).toHaveValue("Still waiting on my schedule");
    expect(box).toBeEnabled();
  });

  it("shows a start that failed while no form was mounted on the next one", async () => {
    let fail;
    const onStartConversation = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const first = render(view({ memberId: "member-away", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Leave request" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    fail(new Error("Request timed out"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    render(view({ memberId: "member-away", onStartConversation }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByLabelText("First message to your committee contact")).toHaveValue("Leave request");
  });

  it("gives each first-message form its own steward draft and its own element ids", async () => {
    const onStartStewardConversation = vi.fn().mockResolvedValue({ conversationId: "c-b" });
    const props = { memberId: "member-two", onStartStewardConversation };
    const shown = render(view({ ...props, focus: { view: "messages", startStewardUserId: "steward-a", stewardName: "Steward A" } }));
    const forms = () => [...document.querySelectorAll(".inbox-first textarea")];
    const ids = forms().map((box) => [box.id, box.getAttribute("aria-describedby")]).flat();
    expect(new Set(ids).size).toBe(ids.length);
    const stewardBox = screen.getByRole("heading", { name: "Start a conversation with Steward A" }).closest("section").querySelector("textarea");
    fireEvent.change(stewardBox, { target: { value: "For steward A only" } });
    shown.rerender(view({ ...props, focus: { view: "messages", startStewardUserId: "steward-b", stewardName: "Steward B", nonce: 2 } }));
    await screen.findByRole("heading", { name: "Start a conversation with Steward B" });
    const section = screen.getByRole("heading", { name: "Start a conversation with Steward B" }).closest("section");
    expect(section.querySelector("textarea")).toHaveValue("");
  });

  // BUG-UG-FIRST-MESSAGE-START-NOT-SELECTED-AFTER-LEAVING-20261008:
  // once the inbox lists the new conversation the empty-inbox form is gone,
  // so a start that finished while Messages was away was never selected.
  const started = {
    id: "conversation-away", counterpartRole: "committee member", sender: "Campaign committee member", initials: "CS",
    preview: "Night shift swap", dateLabel: "Oct 8", unread: 0,
    messages: [{ id: "m-away", sender_kind: "member", sender_name: "Worker", body: "Night shift swap", created_at: "2026-10-08T15:00:00.000Z", read_at: null }],
  };
  const withConversation = (memberId, onStartConversation) => (
    <LanguageProvider lang="en">
      <MessagesView
        data={{ member: { id: memberId }, conversations: [started], broadcasts: [], product: { spaces: [], documents: [] }, peerContact }}
        onSendMessage={vi.fn().mockResolvedValue({})}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        onStartConversation={onStartConversation}
        peerContactApi={{ request: vi.fn(), respond: vi.fn(), send: vi.fn() }}
      />
    </LanguageProvider>
  );
  const selectedRow = () => document.querySelector(".inbox-row--selected");

  it("selects a first conversation that started while Messages was away when the member returns", async () => {
    let finish;
    const onStartConversation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = render(view({ memberId: "member-return", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Night shift swap" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    finish({ conversationId: "conversation-away" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    render(withConversation("member-return", onStartConversation));
    await waitFor(() => expect(selectedRow()).not.toBeNull());
    expect(selectedRow()).toHaveAttribute("aria-pressed", "true");
    expect(selectedRow()).toHaveTextContent("Campaign committee member");
  });

  it("opens a first conversation that settled while away when Messages returns under StrictMode", async () => {
    let finish;
    const onStartConversation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = render(<StrictMode>{view({ memberId: "member-strict-return", onStartConversation })}</StrictMode>);
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Night shift swap" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    // Settle fully before returning so the mount effect must consume the start.
    await act(async () => { finish({ conversationId: "conversation-away" }); });
    render(<StrictMode>{withConversation("member-strict-return", onStartConversation)}</StrictMode>);
    expect(await screen.findByRole("dialog", { name: "Campaign committee member" })).toBeInTheDocument();
    expect(selectedRow()).toHaveAttribute("aria-pressed", "true");
    expect(selectedRow()).toHaveTextContent("Campaign committee member");
    expect(onStartConversation).toHaveBeenCalledTimes(1);
  });

  it.each(["URL", "search"])("keeps a %s landing ahead of a start that settled while away under StrictMode", async (source) => {
    const memberId = `member-strict-landing-${source}`;
    let finish;
    const onStartConversation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = render(<StrictMode>{view({ memberId, onStartConversation })}</StrictMode>);
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Night shift swap" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    await act(async () => { finish({ conversationId: started.id }); });

    const linked = { ...started, id: "conversation-linked", sender: "Other steward", preview: "Linked thread", messages: [] };
    if (source === "URL") window.history.replaceState({}, "", `/m/messages?conversation=${linked.id}`);
    let returning;
    await act(async () => {
      returning = render(<StrictMode>{view({
        memberId,
        onStartConversation,
        data: { member: { id: memberId }, conversations: [started, linked], broadcasts: [], product: { spaces: [], documents: [] }, peerContact },
        focus: source === "search" ? { conversationId: linked.id } : null,
      })}</StrictMode>);
    });
    expect(screen.getByRole("dialog", { name: "Other steward" })).toBeInTheDocument();
    expect(selectedRow()).toHaveTextContent("Other steward");
    expect(screen.queryByRole("dialog", { name: "Campaign committee member" })).toBeNull();

    // The suppressed selection still consumed A; it cannot reopen on a later
    // ordinary visit after the landing instruction is gone.
    returning.unmount();
    window.history.replaceState({}, "", "/m/messages");
    let ordinary;
    await act(async () => {
      ordinary = render(<StrictMode>{withConversation(memberId, onStartConversation)}</StrictMode>);
    });
    expect(selectedRow()).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Campaign committee member" })).toBeNull();
    ordinary.unmount();
    render(<StrictMode>{view({ memberId, onStartConversation })}</StrictMode>);
    expect(screen.getByLabelText("First message to your committee contact")).toHaveValue("");
    expect(onStartConversation).toHaveBeenCalledTimes(1);
  });

  it("selects it when the start finishes after the member is already back on a listed inbox", async () => {
    let finish;
    const onStartConversation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = render(view({ memberId: "member-late", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Night shift swap" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    render(withConversation("member-late", onStartConversation));
    expect(selectedRow()).toBeNull();
    finish({ conversationId: "conversation-away" });
    await waitFor(() => expect(selectedRow()).not.toBeNull());
  });

  it("never hands one member's finished start to another account in the same tab", async () => {
    let finish;
    const onStartConversation = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const first = render(view({ memberId: "member-left", onStartConversation }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Night shift swap" } });
    fireEvent.click(screen.getByRole("button", { name: "Start conversation" }));
    first.unmount();
    finish({ conversationId: "conversation-away" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const other = render(withConversation("member-other", onStartConversation));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selectedRow()).toBeNull();
    other.unmount();
    // The start still belongs to the member who sent it.
    render(withConversation("member-left", onStartConversation));
    await waitFor(() => expect(selectedRow()).not.toBeNull());
  });

  it("never shows one member's draft to another account in the same tab", () => {
    const first = render(view({ memberId: "member-a" }));
    fireEvent.change(screen.getByLabelText("First message to your committee contact"), { target: { value: "Private issue detail" } });
    first.unmount();
    render(view({ memberId: "member-b" }));
    expect(screen.getByLabelText("First message to your committee contact")).toHaveValue("");
  });
});

describe("the Contacts panel", () => {
  it("opens as a full-height sheet at phone width, not a short dialog over the message box", () => {
    render(view());
    fireEvent.click(screen.getByRole("button", { name: /Contacts/ }));
    const panel = screen.getByRole("dialog");
    expect(panel).toHaveClass("app-dialog--detail");
    expect(panel.closest(".dialog-backdrop")).toHaveClass("dialog-backdrop--detail");
  });

  it("stays a default dialog beside the desktop split", () => {
    render(view({ desktop: true }));
    fireEvent.click(screen.getByRole("button", { name: /Contacts/ }));
    expect(screen.getByRole("dialog")).not.toHaveClass("app-dialog--detail");
  });
});
