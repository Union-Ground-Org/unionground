import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { CasesView } from "../src/views/CasesView.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

// Why `disabled={busy}` was not enough on its own.
//
// The handler awaits before React has re-rendered with the disabled attribute,
// so anything that fires a second submit inside that window — Enter held down,
// a double tap on a slow phone, a screen reader activating the control twice —
// lands on a still-enabled button and posts the same write again. Firing two
// submits back to back without yielding is exactly that window.

const MEMBER = { initials: "DF", fullName: "Darnell Foster" };

const CONVERSATION = {
  id: "c1",
  sender: "Chapter steward",
  initials: "CS",
  preview: "Hello",
  dateLabel: "Jul 1",
  unread: 0,
  messages: [{ id: "m1", sender_kind: "steward", sender_name: "Chapter steward", body: "Hello", created_at: "2026-07-01T12:00:00Z" }],
};

function renderMessages(onSendMessage) {
  render(
    <LanguageProvider lang="en">
      <MessagesView
        data={{ member: MEMBER, conversations: [CONVERSATION], broadcasts: [] }}
        onSendMessage={onSendMessage}
        onReadConversation={vi.fn().mockResolvedValue(undefined)}
        onReadBroadcast={vi.fn().mockResolvedValue(undefined)}
      />
    </LanguageProvider>,
  );
}

describe("double-submit guards", () => {
  it("ignores a second reply submitted while the first is still in flight", async () => {
    // Never resolves during the test: the guard has to hold on its own, not
    // because the write happened to finish first.
    let release;
    const onSendMessage = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    renderMessages(onSendMessage);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Chapter steward/ })); });
    const composer = screen.getByPlaceholderText("Write a message…");
    fireEvent.change(composer, { target: { value: "Following up on my grievance" } });

    const form = composer.closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(onSendMessage).toHaveBeenCalledTimes(1);
    expect(onSendMessage).toHaveBeenCalledWith("c1", "Following up on my grievance");

    await act(async () => { release(); });
    // Once the write settles the composer accepts the next message again — the
    // guard must gate concurrency, not permanently disable the form.
    fireEvent.change(composer, { target: { value: "One more thing" } });
    await act(async () => { fireEvent.submit(composer.closest("form")); });
    expect(onSendMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps the reply's send control focused while the reply is sent (#8435)", async () => {
    const onSendMessage = vi.fn(async () => ({}));
    renderMessages(onSendMessage);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Chapter steward/ })); });
    const composer = screen.getByPlaceholderText("Write a message…");
    fireEvent.change(composer, { target: { value: "Following up" } });
    const send = composer.closest("form").querySelector('button[type="submit"], button:not([type])');
    await expectHeldWriteFocus(onSendMessage, send);
    expect(onSendMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores a second case-intake submit while the first is still in flight", async () => {
    let release;
    const onCreateCase = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    render(
      <LanguageProvider lang="en">
        <CasesView data={{ member: MEMBER, cases: [] }} onCreateCase={onCreateCase} />
      </LanguageProvider>,
    );

    // Wave 2b: the mobile cases screen opens NewCaseDialog from the "+ New"
    // header button (the desktop layout's is "+ Start a new case").
    fireEvent.click(screen.getByRole("button", { name: "+ New" }));
    const title = screen.getByRole("textbox", { name: /What happened/ });
    fireEvent.change(title, { target: { value: "Denied Weingarten rep" } });

    const form = title.closest("form");
    fireEvent.submit(form);
    fireEvent.submit(form);

    // A duplicated intake mints a SECOND grievance reference for one incident,
    // which a steward then has to reconcile by hand.
    expect(onCreateCase).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
  });
});
