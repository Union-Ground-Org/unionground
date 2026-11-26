import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { createMemoryStore, replayQueue } from "../src/lib/outbox.js";
import { applyDeviceParityState } from "../src/lib/deviceParity.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111.
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function hub(forms, onDiscardDraft) {
  render(
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: "m1" }, forms }} onSaveDraft={vi.fn().mockResolvedValue("x")} onSubmit={vi.fn()} onDiscardDraft={onDiscardDraft} />
    </LanguageProvider>,
  );
}

describe("discarding a saved draft", () => {
  it("asks once, then discards the draft by id and template from the forms list", async () => {
    const onDiscardDraft = vi.fn().mockResolvedValue({ discarded: true });
    hub([{ id: "grv-1", templateKey: "grievance", status: "draft", step: 0, answers: {}, cosigners: [] }], onDiscardDraft);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent("cannot be undone");
    expect(onDiscardDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(onDiscardDraft).toHaveBeenCalledWith("grv-1", "grievance");
  });

  it("says so when the discard fails, and offers none for a returned form", async () => {
    const onDiscardDraft = vi.fn().mockRejectedValue(new Error("form not found"));
    hub([
      { id: "grv-1", templateKey: "grievance", status: "draft", step: 0, answers: {}, cosigners: [] },
      { id: "srv-1", templateKey: "service_request", status: "returned", step: 0, answers: {}, cosigners: [], reviewNote: "Add a date" },
    ], onDiscardDraft);
    expect(screen.getAllByRole("button", { name: "Discard draft" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(screen.getByText("The draft could not be discarded. Try again.")).toBeInTheDocument();
  });

  it("offers Discard in the editor of a saved draft, and closes the editor after it", async () => {
    const onDiscardDraft = vi.fn().mockResolvedValue({ discarded: true });
    hub([{ id: "grv-1", templateKey: "grievance", status: "draft", step: 0, answers: {}, cosigners: [] }], onDiscardDraft);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    expect(screen.getAllByRole("button", { name: /Close form/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(onDiscardDraft).toHaveBeenCalledWith("grv-1", "grievance");
    expect(screen.queryAllByRole("button", { name: /Close form/ })).toHaveLength(0);
  });
});

// #8309 gate round 1: a discard coordinates with the template's save lane and
// with offline replay. Each test uses its own member, since lanes outlive a
// render.
function lanes(memberId, forms, { onSaveDraft, onDiscardDraft, onCheckDraft = null }) {
  const tree = (rows, focus = null) => (
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: memberId }, forms: rows }} onSaveDraft={onSaveDraft} onSubmit={vi.fn()} onDiscardDraft={onDiscardDraft} onCheckDraft={onCheckDraft} focus={focus} />
    </LanguageProvider>
  );
  const view = render(tree(forms));
  return { rerender: (rows, focus) => view.rerender(tree(rows, focus)) };
}
const draft = (id, extra = {}) => ({ id, templateKey: "grievance", status: "draft", step: 0, answers: { summary: "Saved" }, cosigners: [], ...extra });
async function confirmDiscard() {
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await flush();
}

describe("discarding coordinates with saving", () => {

  it("keeps the saved baseline and the unsent edits when the editor's discard is refused (r1s2)", async () => {
    let saves = 0;
    const onSaveDraft = vi.fn(async () => ({ formId: "grv-kept", dataVersion: `v${(saves += 1) + 1}` }));
    const onDiscardDraft = vi.fn().mockRejectedValue(new Error("attachment not confirmed"));
    lanes("lane-refused", [draft("grv-kept", { dataVersion: "v1" })], { onSaveDraft, onDiscardDraft });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    expect(onSaveDraft.mock.calls[0][0].expectedDataVersion).toBe("v1");
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Unsent edit" } });
    await confirmDiscard();
    expect(onDiscardDraft).toHaveBeenCalledWith("grv-kept", "grievance");
    expect(screen.getByText("The draft could not be discarded. Try again.")).toBeInTheDocument();
    // Autosave resumes with the held edit, against the version the lane saved.
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(onSaveDraft.mock.calls[1][0]).toEqual(expect.objectContaining({ formId: "grv-kept", expectedDataVersion: "v2",
      answers: expect.objectContaining({ narrative: "Unsent edit" }) }));
  });

  it("waits for a save already sent before asking for the delete (r1s3, foreground)", async () => {
    let finishSave;
    const onSaveDraft = vi.fn(() => new Promise((resolve) => { finishSave = () => resolve({ formId: "grv-busy", dataVersion: null }); }));
    const onDiscardDraft = vi.fn().mockResolvedValue({ discarded: true });
    lanes("lane-busy", [draft("grv-busy")], { onSaveDraft, onDiscardDraft });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    await confirmDiscard();
    expect(onDiscardDraft).not.toHaveBeenCalled();
    await act(async () => { finishSave(); });
    await flush();
    expect(onDiscardDraft).toHaveBeenCalledWith("grv-busy", "grievance");
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it("does not replay a queued draft save that was removed while the pass was running (r1s3, replay)", async () => {
    const store = createMemoryStore();
    const userId = "lane-replay";
    const now = Date.now();
    const draftKey = `${userId}|formDraft|grievance`;
    await store.putEntry({ k: `${userId}|rsvp|one`, userId, kind: "rsvp", queuedAt: now, writeToken: "rsvp", args: {} });
    await store.putEntry({ k: draftKey, userId, kind: "formDraft", queuedAt: now + 1, writeToken: "draft", args: { fields: { templateKey: "grievance" } } });
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const formDraft = vi.fn().mockResolvedValue(null);
    const pass = replayQueue(store, userId, { rsvp: async () => { entered(); await held; }, formDraft }, { now: now + 2 });
    await started;
    await store.deleteEntry(draftKey);
    release();
    const result = await pass;
    expect(formDraft).not.toHaveBeenCalled();
    expect(result.replayed).toBe(1);
  });

  it("halts without sending a queued draft when the account changes while its entry is read (#8309 final r3s1)", async () => {
    const store = createMemoryStore();
    const userId = "lane-identity";
    const now = Date.now();
    const draftKey = `${userId}|formDraft|grievance`;
    await store.putEntry({ k: draftKey, userId, kind: "formDraft", queuedAt: now, writeToken: "draft", args: { fields: { templateKey: "grievance" } } });
    let acting = true;
    const read = store.getEntry;
    // Another tab signs in as someone else while this read is pending.
    store.getEntry = async (key) => { const entry = await read(key); acting = false; return entry; };
    const formDraft = vi.fn().mockResolvedValue(null);
    const result = await replayQueue(store, userId, { formDraft }, { now: now + 1, stillActing: () => acting });
    expect(formDraft).not.toHaveBeenCalled();
    expect(result.halted).toBe(true);
    expect(await read(draftKey)).toEqual(expect.objectContaining({ writeToken: "draft" }));
  });

  it("does not send the listed answers when a newer draft replaced them under the same key during the pass", async () => {
    const store = createMemoryStore();
    const userId = "lane-replaced";
    const now = Date.now();
    const draftKey = `${userId}|formDraft|grievance`;
    await store.putEntry({ k: `${userId}|rsvp|one`, userId, kind: "rsvp", queuedAt: now, writeToken: "rsvp", args: {} });
    await store.putEntry({ k: draftKey, userId, kind: "formDraft", queuedAt: now + 1, writeToken: "old", args: { fields: { templateKey: "grievance", answers: { fixture: "DISCARDED-OLD" } } } });
    let entered;
    let release;
    const started = new Promise((resolve) => { entered = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const formDraft = vi.fn().mockResolvedValue(null);
    const pass = replayQueue(store, userId, { rsvp: async () => { entered(); await held; }, formDraft }, { now: now + 2 });
    await started;
    // The old draft is discarded and a new one queued under the same key.
    await store.putEntry({ k: draftKey, userId, kind: "formDraft", queuedAt: now + 2, writeToken: "new", args: { fields: { templateKey: "grievance", answers: { fixture: "NEW-DRAFT" } } } });
    release();
    await pass;
    expect(formDraft).not.toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ answers: { fixture: "DISCARDED-OLD" } }) }));
    expect(await store.getEntry(draftKey)).toEqual(expect.objectContaining({ writeToken: "new" }));
  });

  it("does not save an edit made while the editor's discard is pending, once the discard succeeds (#8309 final r3s2)", async () => {
    let finishDiscard;
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-late", dataVersion: null });
    const onDiscardDraft = vi.fn(() => new Promise((resolve) => { finishDiscard = () => resolve({ discarded: true }); }));
    lanes("lane-late-edit", [draft("grv-late")], { onSaveDraft, onDiscardDraft });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    await confirmDiscard();
    expect(onDiscardDraft).toHaveBeenCalledWith("grv-late", "grievance");
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Edit during discard" } });
    await act(async () => { finishDiscard(); });
    await flush();
    expect(screen.queryAllByRole("button", { name: /Close form/ })).toHaveLength(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1400)); });
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it("keeps an edit made while a refused discard was pending, and saves it after the refusal", async () => {
    let refuseDiscard;
    let saves = 0;
    const onSaveDraft = vi.fn(async () => ({ formId: "grv-held", dataVersion: `v${(saves += 1) + 1}` }));
    const onDiscardDraft = vi.fn(() => new Promise((_resolve, reject) => { refuseDiscard = () => reject(new Error("attachment not confirmed")); }));
    lanes("lane-held-edit", [draft("grv-held", { dataVersion: "v1" })], { onSaveDraft, onDiscardDraft });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    await confirmDiscard();
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Edit kept" } });
    await act(async () => { refuseDiscard(); });
    await flush();
    expect(screen.getByText("The draft could not be discarded. Try again.")).toBeInTheDocument();
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(onSaveDraft.mock.calls[1][0]).toEqual(expect.objectContaining({ formId: "grv-held", expectedDataVersion: "v2",
      answers: expect.objectContaining({ narrative: "Edit kept" }) }));
  });
});

// #8309 final r6s1: a list discard with no save lane yet. No entry point may
// open an editor on that draft until the discard settles, a discarded draft
// never opens again from a stale list, and a discard made in the paired
// desktop or phone tree fences an editor already open on the draft.
describe("no editor reaches a draft whose discard is pending or done", () => {
  const editorOpen = () => screen.queryAllByRole("button", { name: /Close form/ }).length > 0;
  const pendingDiscard = () => {
    let finish;
    let refuse;
    const onDiscardDraft = vi.fn(() => new Promise((resolve, reject) => {
      finish = () => resolve({ discarded: true });
      refuse = () => reject(new Error("attachment not confirmed"));
    }));
    return { onDiscardDraft, finish: () => finish(), refuse: () => refuse() };
  };

  it("keeps Resume from opening the draft while its list discard is pending, with no save lane, and saves nothing", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-nolane", dataVersion: null });
    const discard = pendingDiscard();
    lanes("lane-r6s1-resume", [draft("grv-nolane")], { onSaveDraft, onDiscardDraft: discard.onDiscardDraft });
    await confirmDiscard();
    expect(discard.onDiscardDraft).toHaveBeenCalledWith("grv-nolane", "grievance");
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    expect(editorOpen()).toBe(false);
    await act(async () => { discard.finish(); });
    await flush();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1400)); });
    expect(onSaveDraft).not.toHaveBeenCalled();
  });


  it("does not reopen a discarded draft from a list that has not refreshed yet", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-stale", dataVersion: null });
    const onDiscardDraft = vi.fn().mockResolvedValue({ discarded: true });
    lanes("lane-r6s1-stale", [draft("grv-stale")], { onSaveDraft, onDiscardDraft });
    await confirmDiscard();
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    expect(editorOpen()).toBe(false);
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it("opens a draft with the same id again once a refreshed list showed it gone (a reset demo)", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-reset", dataVersion: null });
    const view = lanes("lane-r6s1-reset", [draft("grv-reset")], { onSaveDraft, onDiscardDraft: vi.fn().mockResolvedValue({ discarded: true }) });
    await confirmDiscard();
    view.rerender([]);
    await flush();
    view.rerender([draft("grv-reset")]);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    expect(editorOpen()).toBe(true);
  });

  // #8966 round 1 r1s2, the reviewer's scenario: tab A saves draft D and
  // closes it, keeping its save lane; tab B discards D; tab A's list no longer
  // shows D and the member starts a fresh grievance. The fresh form checks D
  // directly before its first save and, finding it gone, starts a new draft:
  // no refusal, no stuck editor, the new answers saved.


  it("opens the draft again after a refused list discard", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-kept-list", dataVersion: null });
    const discard = pendingDiscard();
    lanes("lane-r6s1-refused", [draft("grv-kept-list")], { onSaveDraft, onDiscardDraft: discard.onDiscardDraft });
    await confirmDiscard();
    await act(async () => { discard.refuse(); });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    expect(editorOpen()).toBe(true);
  });

  it("fences an editor open on the draft when the paired tree discards it, and closes it without saving", async () => {
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-paired", dataVersion: null });
    lanes("lane-r6s1-paired", [draft("grv-paired")], { onSaveDraft, onDiscardDraft: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    expect(editorOpen()).toBe(true);
    await act(async () => { applyDeviceParityState("forms.discards", [{ templateKey: "grievance", formId: "grv-paired", state: "pending" }]); });
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Typed in the other tree during its discard" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1400)); });
    expect(onSaveDraft).not.toHaveBeenCalled();
    await act(async () => { applyDeviceParityState("forms.discards", [{ templateKey: "grievance", formId: "grv-paired", state: "done" }]); });
    await flush();
    expect(editorOpen()).toBe(false);
    expect(onSaveDraft).not.toHaveBeenCalled();
    await act(async () => { applyDeviceParityState("forms.discards", []); });
  });
});

// The list's Discard confirm keeps keyboard focus while its own
// discard runs, refuses a second press, and a same-tick double sends one.
describe("the discard confirm keeps focus while it runs (record 8435)", () => {
  it("stays focused and unavailable while the discard is held, and sends one discard", async () => {
    const onDiscardDraft = vi.fn().mockResolvedValue({ discarded: true });
    hub([{ id: "grv-8435", templateKey: "grievance", status: "draft", step: 0, answers: {}, cosigners: [] }], onDiscardDraft);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await expectHeldWriteFocus(onDiscardDraft, screen.getByRole("button", { name: "Discard" }));
    expect(onDiscardDraft).toHaveBeenCalledTimes(1);
  });

  it("starts one discard from two presses in one tick", async () => {
    const onDiscardDraft = vi.fn().mockResolvedValue({ discarded: true });
    hub([{ id: "grv-8435b", templateKey: "grievance", status: "draft", step: 0, answers: {}, cosigners: [] }], onDiscardDraft);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    const discard = screen.getByRole("button", { name: "Discard" });
    await expectOneWriteFromOneTick(onDiscardDraft, [() => discard.click(), () => discard.click()]);
  });
});
