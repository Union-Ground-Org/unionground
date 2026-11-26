// #9466 (W3b-2, W3b-12): a failure is said once beside the pressed control, inside
// an open window, until the next press on that control replaces it.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationsDialog } from "../src/components/Dialogs.jsx";
import { MessageActions } from "../src/components/MessageActions.jsx";
import { SharedMessageActions } from "../src/components/SharedMessageActions.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { MemberApiError } from "../src/lib/memberApi.js";

afterEach(cleanup);

const unread = { id: "n1", title: "Tamarack update", body: "The latest chapter note is ready.", created_at: "2026-11-22T15:00:00Z", read_at: null, kind: "general", copy_key: null };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => act(async () => {});

function notifications(lang, onReadAll) {
  render(<LanguageProvider lang={lang}><NotificationsDialog notifications={[unread]} onClose={vi.fn()} onReadAll={onReadAll} /></LanguageProvider>);
  const dialog = within(screen.getByRole("dialog"));
  return { dialog, button: dialog.getByRole("button", { name: catalogue[lang]["dialogs.markAllRead"] }) };
}

describe("Mark all read in the notifications window (W3b-2)", () => {
  it.each(["en", "es"])("says once, under the button, that the items are still unread, and a retry clears it at once (%s)", async (lang) => {
    const retry = deferred();
    const onReadAll = vi.fn().mockRejectedValueOnce(new Error("Mark notifications read: permission denied")).mockReturnValueOnce(retry.promise);
    const { dialog, button } = notifications(lang, onReadAll);
    fireEvent.click(button);
    const alert = await dialog.findByRole("alert");
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    expect(alert).toHaveTextContent(catalogue[lang]["dialogs.markAllReadFailed"]);
    expect(button.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(dialog.queryByRole("alert")).toBeNull();
    retry.resolve({ status: "committed" });
    await flush();
    expect(dialog.queryByRole("alert")).toBeNull();
  });

  it("names a cause the app can explain instead of the general line", async () => {
    const { dialog, button } = notifications("en", vi.fn().mockRejectedValue(Object.assign(new Error("The request timed out"), { name: "TimeoutError" })));
    fireEvent.click(button);
    expect(await dialog.findByRole("alert")).toHaveTextContent(catalogue.en["error.requestTimedOut"]);
  });

  it("says inside the window when the change was kept on this device until the connection is back", async () => {
    const { dialog, button } = notifications("en", vi.fn().mockResolvedValue({ status: "queued", value: null }));
    fireEvent.click(button);
    expect(await dialog.findByRole("status")).toHaveTextContent(catalogue.en["offline.queued"]);
    expect(dialog.queryByRole("alert")).toBeNull();
  });

  it("lets only the latest of two overlapping presses set the line", async () => {
    const [older, newer, last] = [deferred(), deferred(), deferred()];
    const { dialog, button } = notifications("en", vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise).mockReturnValueOnce(last.promise));
    fireEvent.click(button);
    fireEvent.click(button);
    newer.resolve({ status: "committed" });
    older.reject(new Error("permission denied"));
    await flush();
    expect(dialog.queryByRole("alert")).toBeNull();
    fireEvent.click(button);
    last.resolve({ status: "queued", value: null });
    await flush();
    expect(dialog.getByRole("status")).toHaveTextContent(catalogue.en["offline.queued"]);
  });
});

describe("a message action inside a conversation (W3b-12)", () => {
  const taskRow = (id) => ({ id, body: "Hola", reactions: [] });

  it("says once under the row that a save failed, and a press that only opens the reminder chooser clears it", async () => {
    const api = { toggleReaction: vi.fn(), toggleSaved: vi.fn().mockRejectedValue(new Error("offline")), remind: vi.fn() };
    const onNotice = vi.fn();
    render(<LanguageProvider lang="es"><MessageActions sourceKind="task" message={taskRow("m1")} actorId="me" api={api} onNotice={onNotice} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["inbox.save"] }));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.es["inbox.actionFailed"]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(onNotice).toHaveBeenCalledWith(catalogue.es["inbox.actionFailed"]);
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["inbox.remindMe"] }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not put a late failure under the next row the same controls show", async () => {
    const save = deferred();
    const api = { toggleReaction: vi.fn(), toggleSaved: vi.fn(() => save.promise), remind: vi.fn() };
    const row = (message) => <LanguageProvider lang="en"><MessageActions sourceKind="task" message={message} actorId="me" api={api} onNotice={vi.fn()} /></LanguageProvider>;
    const { rerender } = render(row(taskRow("m1")));
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["inbox.save"] }));
    rerender(row(taskRow("m2")));
    save.reject(new Error("offline"));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says once under the row why a private reply was refused", async () => {
    const messageAction = vi.fn(async (_kind, _id, action) => {
      if (action === "state") return { canEdit: false, saved: false, reminders: [], reactions: [] };
      throw new MemberApiError("Reply", { message: "no steward assigned", code: "22023", details: "no_steward_assigned" });
    });
    render(<LanguageProvider lang="en"><SharedMessageActions sourceKind="private" message={{ id: "m2", sender_kind: "member", body: "Hello", reactions: [] }} actorId="me" api={{ messageAction }} onNotice={vi.fn()} onMessageChange={vi.fn()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: catalogue.en["inbox.reply"] }));
    fireEvent.change(screen.getByLabelText(catalogue.en["inbox.replyToMessage"]), { target: { value: "Anyone there?" } });
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["inbox.sendReply"] }));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.en["rpcError.no_steward_assigned"]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("says under the row that a private save was not confirmed, until a press opens the reply box", async () => {
    const messageAction = vi.fn(async (_kind, _id, action) => {
      if (action === "state") return { canEdit: false, saved: false, reminders: [], reactions: [] };
      throw new Error("offline");
    });
    render(<LanguageProvider lang="es"><SharedMessageActions sourceKind="private" message={{ id: "m3", body: "Hola", reactions: [] }} actorId="me" api={{ messageAction }} onNotice={vi.fn()} onMessageChange={vi.fn()} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: catalogue.es["inbox.saveMessage"] }));
    expect(await screen.findByRole("alert")).toHaveTextContent(catalogue.es["inbox.actionNotConfirmed"]);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: catalogue.es["inbox.reply"] }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
