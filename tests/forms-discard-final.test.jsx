import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { endFormDraftSession } from "../src/lib/formDraftSessions.js";
import { createMemoryStore, enqueueWrite, holdQueuedEntryWhile, pendingCount, replayQueue } from "../src/lib/outbox.js";

// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111, #8966
// final: the edits a pending discard holds survive the editor leaving the
// screen (r3s1/r4s1), and the hold on a queued save reaches every tab (r3s2).

const flush = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
const draft = (id) => ({ id, templateKey: "grievance", status: "draft", step: 0, answers: { summary: "Saved" }, cosigners: [] });

function tree(memberId, forms, { onSaveDraft, onDiscardDraft }) {
  return (
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: memberId }, forms }} onSaveDraft={onSaveDraft} onSubmit={vi.fn()} onDiscardDraft={onDiscardDraft} />
    </LanguageProvider>
  );
}

// Opens the saved draft, types, confirms Discard, optionally types again
// while the delete is pending, then leaves Forms (the rail or Back replaces
// the view) before the server answers.
async function discardThenLeave(memberId, { typeDuring = false } = {}) {
  let answer;
  const onDiscardDraft = vi.fn(() => new Promise((resolve, reject) => { answer = { resolve, reject }; }));
  const onSaveDraft = vi.fn().mockResolvedValue({ formId: `${memberId}-form`, dataVersion: null });
  const view = render(tree(memberId, [draft(`${memberId}-form`)], { onSaveDraft, onDiscardDraft }));
  fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
  await flush();
  fireEvent.change(await screen.findByLabelText(/Issue summary/), { target: { value: "Typed before Discard" } });
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard" }));
  await flush();
  if (typeDuring) fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "Typed while it was pending" } });
  view.unmount();
  await flush();
  expect(onSaveDraft).not.toHaveBeenCalled();
  return { answer, onSaveDraft };
}

describe("leaving Forms while the editor's discard is pending", () => {
  it.each([
    ["typed before Discard", false, "Typed before Discard"],
    ["typed while it was pending", true, "Typed while it was pending"],
  ])("sends the edits %s once the discard is refused, with the editor gone", async (_case, typeDuring, expected) => {
    const { answer, onSaveDraft } = await discardThenLeave(`final-refused-${typeDuring}`, { typeDuring });
    await act(async () => { answer.reject(new Error("attachment not confirmed")); });
    await flush();
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    expect(onSaveDraft.mock.calls[0][0]).toMatchObject({ formId: `final-refused-${typeDuring}-form`, answers: expect.objectContaining({ summary: expected }) });
  });

  it("sends nothing after a confirmed discard", async () => {
    const { answer, onSaveDraft } = await discardThenLeave("final-confirmed", { typeDuring: true });
    await act(async () => { answer.resolve({ formId: "final-confirmed-form", discarded: true }); });
    await flush();
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it("sends nothing after a superseded discard (another account signed in)", async () => {
    const { answer, onSaveDraft } = await discardThenLeave("final-superseded", { typeDuring: true });
    await act(async () => { answer.resolve(undefined); });
    await flush();
    expect(onSaveDraft).not.toHaveBeenCalled();
  });
});

// The paired tree (desktop and phone layouts of one tab) discards the draft
// from its list while this tree's editor holds edits typed meanwhile; then
// the rail replaces both.
describe("leaving Forms while the paired tree's discard is pending", () => {
  it("sends the edits the fenced editor held once that discard is refused", async () => {
    let answer;
    const onDiscardDraft = vi.fn(() => new Promise((resolve, reject) => { answer = { resolve, reject }; }));
    const editorSave = vi.fn().mockResolvedValue({ formId: "paired-form", dataVersion: null });
    const listSave = vi.fn().mockResolvedValue({ formId: "paired-form", dataVersion: null });
    const forms = [draft("paired-form")];
    const editorTree = render(tree("final-paired", forms, { onSaveDraft: editorSave, onDiscardDraft }));
    fireEvent.click(within(editorTree.container).getByRole("button", { name: "Resume draft" }));
    await flush();
    const listTree = render(tree("final-paired", forms, { onSaveDraft: listSave, onDiscardDraft }));
    fireEvent.click(within(listTree.container).getByRole("button", { name: "Discard draft" }));
    fireEvent.click(within(listTree.container).getByRole("button", { name: "Discard" }));
    await flush();
    expect(onDiscardDraft).toHaveBeenCalledTimes(1);
    fireEvent.change(within(editorTree.container).getByLabelText(/Issue summary/), { target: { value: "Typed in this tree during the other's discard" } });
    editorTree.unmount();
    listTree.unmount();
    await flush();
    expect(editorSave).not.toHaveBeenCalled();
    await act(async () => { answer.reject(new Error("attachment not confirmed")); });
    await flush();
    expect(editorSave).toHaveBeenCalledTimes(1);
    expect(editorSave.mock.calls[0][0]).toMatchObject({ formId: "paired-form", answers: expect.objectContaining({ summary: "Typed in this tree during the other's discard" }) });
  });
});

// Web Locks as a browser shares them between tabs: one holder per name.
function sharedLocks() {
  const tails = new Map();
  return {
    request(name, _options, operation) {
      const run = (tails.get(name) || Promise.resolve()).then(() => operation());
      tails.set(name, run.catch(() => {})); // swallow-ok: the queue of waiters only needs to know the holder finished
      return run;
    },
  };
}
const key = "member-a|formDraft|grievance";
// A first save whose reply was lost, queued without a form id.
const unbound = { k: key, userId: "member-a", kind: "formDraft", queuedAt: Date.now(), writeToken: "w-lost",
  args: { fields: { templateKey: "grievance", answers: { summary: "Answers of the draft being discarded" }, step: 0 } } };

describe("a queued save held by a discard in another tab", () => {
  afterEach(() => { delete window.navigator.locks; });

  it.each([
    ["confirmed", () => Promise.resolve({ formId: "grv-D", discarded: true }), 0],
    ["refused", () => Promise.reject(new Error("attachment not confirmed")), 1],
  ])("is not replayed by the other tab while the discard is out, and after a %s discard is sent only if it was refused", async (_case, outcome, sends) => {
    Object.defineProperty(window.navigator, "locks", { value: sharedLocks(), configurable: true });
    const tabA = createMemoryStore();
    const tabB = { ...tabA }; // its own store object over the same IndexedDB
    await tabA.putEntry(unbound);
    const executor = vi.fn().mockResolvedValue({ formId: "grv-D2" });
    let answer;
    const discard = holdQueuedEntryWhile(tabB, key, () => new Promise((resolve) => { answer = resolve; }));
    await flush();
    const replay = replayQueue(tabA, "member-a", { formDraft: executor });
    await flush();
    expect(executor).not.toHaveBeenCalled();
    answer(outcome());
    await discard.catch(() => {});
    await replay;
    expect(executor).toHaveBeenCalledTimes(sends);
    expect(Boolean(await tabA.getEntry(key))).toBe(false);
  });

  it("makes the discard wait for a replay the other tab already started", async () => {
    Object.defineProperty(window.navigator, "locks", { value: sharedLocks(), configurable: true });
    const tabA = createMemoryStore();
    const tabB = { ...tabA };
    await tabA.putEntry(unbound);
    let sent;
    const executor = vi.fn(() => new Promise((resolve) => { sent = resolve; }));
    const replay = replayQueue(tabA, "member-a", { formDraft: executor });
    await flush();
    expect(executor).toHaveBeenCalledTimes(1);
    const work = vi.fn().mockResolvedValue({ formId: "grv-D", discarded: true });
    const discard = holdQueuedEntryWhile(tabB, key, work);
    await flush();
    expect(work).not.toHaveBeenCalled();
    sent({ formId: "grv-D" });
    await replay;
    await discard;
    expect(work).toHaveBeenCalledTimes(1);
  });
});

// r6s1: the draft's own first save, whose reply was lost, fails after the
// discard's hold read and is queued late. A confirmed discard voids it in
// every tab; a refused one leaves it to sync.
describe("a form save begun before a confirmed discard and queued late", () => {
  afterEach(() => { delete window.navigator.locks; });
  const save = (startedAt, fields = {}) => ({ kind: "formDraft", key: "grievance", startedAt,
    args: { fields: { templateKey: "grievance", answers: { summary: "Answers of the draft being discarded" }, step: 0, ...fields } } });
  const fence = { fence: { userId: "member-a", templateKey: "grievance" } };

  it.each([["with", true], ["without", false]])("is never sent once the discard is confirmed, %s Web Locks", async (_case, locks) => {
    if (locks) Object.defineProperty(window.navigator, "locks", { value: sharedLocks(), configurable: true });
    const tabA = createMemoryStore();
    const tabB = { ...tabA };
    const startedAt = Date.now() - 5000;
    let answer;
    const discard = holdQueuedEntryWhile(tabB, key, () => new Promise((resolve) => { answer = resolve; }), fence);
    await flush();
    // Tab A's request times out while B's discard is out.
    const queued = enqueueWrite(tabA, "member-a", save(startedAt));
    await flush();
    answer({ formId: "grv-D", discarded: true });
    await discard;
    await queued;
    const executor = vi.fn().mockResolvedValue({ formId: "grv-D2" });
    const result = await replayQueue(tabA, "member-a", { formDraft: executor });
    expect(executor).not.toHaveBeenCalled();
    expect(Boolean(await tabA.getEntry(key))).toBe(false);
    expect(result.replayed).toBe(0);
    expect(await pendingCount(tabA, "member-a")).toBe(0);
    // Queued after the discard confirmed: refused at the door.
    expect(await enqueueWrite(tabA, "member-a", save(startedAt))).toBe(false);
  });

  it("is kept and sent when the discard is refused", async () => {
    Object.defineProperty(window.navigator, "locks", { value: sharedLocks(), configurable: true });
    const tabA = createMemoryStore();
    const tabB = { ...tabA };
    await holdQueuedEntryWhile(tabB, key, async () => { throw new Error("attachment not confirmed"); }, fence).catch(() => {});
    expect(await enqueueWrite(tabA, "member-a", save(Date.now() - 5000))).toBe(true);
    const executor = vi.fn().mockResolvedValue({ formId: "grv-D" });
    await replayQueue(tabA, "member-a", { formDraft: executor });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("leaves alone a save that names its form, and one begun after the discard", async () => {
    const store = createMemoryStore();
    await holdQueuedEntryWhile(store, key, async () => ({ formId: "grv-D", discarded: true }), fence);
    expect(await enqueueWrite(store, "member-a", save(Date.now() - 5000, { formId: "grv-other" }))).toBe(true);
    expect(await pendingCount(store, "member-a")).toBe(1);
    const executor = vi.fn().mockResolvedValue({ formId: "grv-other" });
    await replayQueue(store, "member-a", { formDraft: executor });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(await enqueueWrite(store, "member-a", save(Date.now() + 1000))).toBe(true);
    await replayQueue(store, "member-a", { formDraft: executor });
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

// The await audit: a save queued behind the lane's previous one is not sent
// when the session ends while it waits (an account switch in another tab).
describe("a save waiting behind the previous one when the session ends", () => {
  it("is never sent under the session that followed", async () => {
    let first;
    const onSaveDraft = vi.fn(() => new Promise((resolve) => { first = resolve; }));
    const view = render(tree("final-session-ends", [draft("final-session-ends-form")], { onSaveDraft, onDiscardDraft: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    fireEvent.change(await screen.findByLabelText(/Issue summary/), { target: { value: "First save" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flush();
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Queued behind it" } });
    view.unmount();
    endFormDraftSession();
    await act(async () => { first({ formId: "final-session-ends-form", dataVersion: null }); });
    await flush();
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });
});

// The await audit: the autofill record that follows a save is not sent when
// the session ended while that save was out.
describe("an autofill record after a save that outlived the session", () => {
  it("is not sent under the session that followed", async () => {
    let saved;
    const onSaveDraft = vi.fn(() => new Promise((resolve) => { saved = resolve; }));
    const record = vi.fn(async () => ({}));
    const api = { load: vi.fn(async () => ({ preference: "ask", shared: true, values: { employer: "Metro Transit Authority" } })), savePreference: vi.fn(async () => ({})), record };
    const template = { key: "audit_workplace", titleKey: "Audit workplace report", fields: [], steps: [{ key: "s1", fields: [
      { key: "employer", type: "text", label: "Employer", autocomplete: "organization", required: false },
      { key: "what_happened", type: "textarea", label: "What happened", required: false },
    ] }] };
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "final-autofill" }, forms: [], formTemplates: [template] }} onSaveDraft={onSaveDraft} onSubmit={vi.fn()} formAutofillApi={api} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Audit workplace report/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, fill them in" }));
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 1400); }); });
    expect(onSaveDraft).toHaveBeenCalled();
    endFormDraftSession();
    await act(async () => { saved("audit-form"); });
    await flush();
    expect(record).not.toHaveBeenCalled();
  });
});
