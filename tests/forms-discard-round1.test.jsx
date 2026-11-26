import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { createMemoryStore, holdQueuedEntryWhile, replayQueue } from "../src/lib/outbox.js";

// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111, #8966
// gate round 1: nothing is removed before the server answers, and nothing is
// marked from an answer that never came.

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const draft = (id) => ({ id, templateKey: "grievance", status: "draft", step: 0, answers: { summary: "Saved" }, cosigners: [] });
const key = "member-a|formDraft|grievance";
// Queued just now, so no replay pass drops it as expired.
const entry = (order, summary) => ({ k: key, userId: "member-a", kind: "formDraft", queuedAt: Date.now() + order, writeToken: `w-${order}`,
  args: { fields: { templateKey: "grievance", answers: { summary }, step: 0, formId: "grv-1" } } });

function tree(memberId, forms, { onSaveDraft, onDiscardDraft }) {
  return (
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: memberId }, forms }} onSaveDraft={onSaveDraft} onSubmit={vi.fn()} onDiscardDraft={onDiscardDraft} />
    </LanguageProvider>
  );
}

// r1s1 / r2s2: the queued offline save is held, not deleted, until the server
// confirms the discard.
describe("the queued offline save around a discard", () => {
  it("puts the queued answers back when the discard is refused, and when it is superseded", async () => {
    for (const outcome of [() => Promise.reject(new Error("offline")), () => Promise.resolve(undefined)]) {
      const store = createMemoryStore();
      await store.putEntry(entry(1, "Newer offline answers"));
      const executor = vi.fn().mockResolvedValue("x");
      const result = holdQueuedEntryWhile(store, key, async () => {
        // While the delete is out the entry stays stored (a tab closed now
        // loses nothing), and a replay pass sends nothing for this key.
        expect((await store.getEntry(key))?.args.fields.answers.summary).toBe("Newer offline answers");
        await replayQueue(store, "member-a", { formDraft: executor });
        expect(executor).not.toHaveBeenCalled();
        return outcome();
      });
      await result.catch(() => {});
      expect((await store.getEntry(key))?.args.fields.answers.summary).toBe("Newer offline answers");
      // Released: the next pass sends it.
      await replayQueue(store, "member-a", { formDraft: executor });
      expect(executor).toHaveBeenCalledTimes(1);
    }
  });

  it("removes the queued answers for good only after a confirmed discard", async () => {
    const store = createMemoryStore();
    await store.putEntry(entry(1, "Answers of the discarded draft"));
    await holdQueuedEntryWhile(store, key, async () => ({ formId: "grv-1", discarded: true }));
    expect(await store.getEntry(key)).toBeNull();
    const executor = vi.fn().mockResolvedValue("x");
    await replayQueue(store, "member-a", { formDraft: executor });
    expect(executor).not.toHaveBeenCalled();
  });

  it("never removes a newer save queued while the discard was out", async () => {
    for (const outcome of [() => Promise.reject(new Error("refused")), () => Promise.resolve({ formId: "grv-1", discarded: true })]) {
      const store = createMemoryStore();
      await store.putEntry(entry(1, "Older"));
      await holdQueuedEntryWhile(store, key, async () => {
        await store.putEntry(entry(2, "Typed during the discard"));
        return outcome();
      }).catch(() => {});
      expect((await store.getEntry(key))?.args.fields.answers.summary).toBe("Typed during the discard");
    }
  });
});

// r1s3 / r2s1: Close waits while the editor's discard is pending, so a refusal
// always finds the editor mounted to give the held edits back.
describe("closing during an editor's discard", () => {
  it("keeps Close unavailable until the discard answers, then saves the held edit after a refusal", async () => {
    let refuse;
    const onDiscardDraft = vi.fn(() => new Promise((_resolve, reject) => { refuse = () => reject(new Error("attachment not confirmed")); }));
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-close", dataVersion: null });
    render(tree("round1-close", [draft("grv-close")], { onSaveDraft, onDiscardDraft }));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "Edit made before Discard" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    const close = screen.getAllByRole("button", { name: /Close form/ })[0];
    expect(close).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(close);
    await flush();
    expect(screen.getAllByRole("button", { name: /Close form/ })[0]).toBeInTheDocument();
    await act(async () => { refuse(); });
    await flush();
    expect(screen.getAllByRole("button", { name: /Close form/ })[0]).not.toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled(), { timeout: 4000 });
    expect(onSaveDraft.mock.lastCall[0].answers.summary).toBe("Edit made before Discard");
  });
});

// r2s3: a superseded discard (the session guard answers undefined and deletes
// nothing) neither marks the form deleted nor fences its saves.
describe("a superseded discard", () => {
  it("leaves the draft openable and saving, from the list and from the editor", async () => {
    const onDiscardDraft = vi.fn().mockResolvedValue(undefined);
    const onSaveDraft = vi.fn().mockResolvedValue({ formId: "grv-kept", dataVersion: null });
    const view = render(tree("round1-superseded", [draft("grv-kept")], { onSaveDraft, onDiscardDraft }));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(onDiscardDraft).toHaveBeenCalledWith("grv-kept", "grievance");
    // Still listed and still opens: no "done" mark was made.
    // The list's control went back to its plain button.
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await flush();
    fireEvent.change(await screen.findByLabelText(/Issue summary/), { target: { value: "Still mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    expect(onSaveDraft.mock.calls[0][0]).toMatchObject({ formId: "grv-kept", answers: expect.objectContaining({ summary: "Still mine" }) });
    // The editor's own discard, superseded, keeps the editor and its edits.
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(screen.getAllByRole("button", { name: /Close form/ })[0]).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await flush();
    fireEvent.change(await screen.findByLabelText(/Issue summary/), { target: { value: "Still mine after" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft.mock.lastCall[0].answers.summary).toBe("Still mine after"), { timeout: 4000 });
    expect(onSaveDraft.mock.lastCall[0]).toMatchObject({ formId: "grv-kept" });
    view.unmount();
  });
});
