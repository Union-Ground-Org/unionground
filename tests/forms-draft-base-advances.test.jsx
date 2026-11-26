import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { endFormDraftSession, memberDraftSaves, replayFormDraft } from "../src/lib/formDraftSessions.js";
import { OUTBOX_REPLAY_DEFERRED } from "../src/lib/outbox.js";

// BUG-UG-ORDINARY-FORM-SAVE-OVERWRITES-A-NEWER-EDIT-FROM-ANOTHER-SESSION-20261114
// (#8719), gate round 1 on #8770, rebuilt on the per-write revision (#9092,
// #8949 option a). An ordinary save names the revision it was based on, and
// save_member_form_draft refuses one whose base is not the stored revision.
// So the base must be the revision this editor's last successful save wrote,
// or the member's own second edit is refused; and a new form's first save
// names 0 so it cannot overwrite a draft another session created meanwhile.
describe("the base an ordinary save names", () => {
  it("is 0 for a new form, then the revision the previous successful save wrote", async () => {
    let revision = 0;
    const onSaveDraft = vi.fn(async () => ({ formId: "form-new", revision: ++revision }));
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { initials: "MV" }, forms: [] }} onSaveDraft={onSaveDraft}
          onSubmit={vi.fn()} onInviteCosigner={vi.fn()} onRespondCosign={vi.fn()} onWithdrawCosign={vi.fn()} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    const step = async (summary, button) => {
      if (summary !== null) fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: summary } });
      const before = onSaveDraft.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() => expect(onSaveDraft.mock.calls.length).toBeGreaterThan(before));
    };
    await step("First summary", "Next");
    await step(null, "Back");
    await step("Second summary", "Next");
    await step(null, "Back");
    await step("Third summary", "Next");

    const calls = onSaveDraft.mock.calls.map(([fields]) => fields);
    expect(calls[0].formId).toBeUndefined();
    expect(calls[0].baseRevision).toBe(0);
    for (let index = 1; index < calls.length; index += 1) {
      expect(calls[index].formId).toBe("form-new");
      expect(calls[index].baseRevision, `save ${index + 1}`).toBe(index);
    }
    expect(calls.at(-1).answers.summary).toBe("Third summary");
    expect(calls.every((fields) => fields.baseAnswers === undefined)).toBe(true);
  });

  const view = (forms, onSaveDraft, extra = {}) => (
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms }} onSaveDraft={onSaveDraft}
        onSubmit={vi.fn()} onInviteCosigner={vi.fn()} onRespondCosign={vi.fn()} onWithdrawCosign={vi.fn()} {...extra} />
    </LanguageProvider>
  );
  const elsewhere = () => Object.assign(new Error("form changed elsewhere"), { code: "PT409", details: "form_saved_elsewhere" });
  const draftWith = (summary, revision) => ({ id: "form-1", templateKey: "grievance", status: "draft", step: 0, answers: { summary }, revision, cosigners: [] });
  // save_member_form_draft as the database runs it (20261120222533).
  const storedServer = (summary, revision) => {
    const db = { answers: { summary }, revision };
    db.save = vi.fn(async (fields) => {
      if (fields.baseRevision !== db.revision) throw elsewhere();
      if (JSON.stringify(fields.answers) !== JSON.stringify(db.answers)) db.revision += 1;
      db.answers = fields.answers;
      return { formId: "form-1", revision: db.revision };
    });
    return db;
  };

  // Gate final on #8770 (r3s1, r4s1): a refused FIRST save knows no form id.
  // The draft the other session made is the template's open form in the forms
  // the parent re-read; the editor binds it and shows its answers, and Close
  // then saves against its revision instead of being refused again.
  it("binds the other session's draft after a refused first save, and Close then saves against it", async () => {
    endFormDraftSession();
    const theirs = { id: "form-theirs", templateKey: "grievance", status: "draft", step: 0,
      answers: { summary: "Saved in the other session", narrative: "Told in the other session" }, revision: 4, cosigners: [] };
    const onSaveDraft = vi.fn();
    let rerender;
    onSaveDraft.mockImplementationOnce(async () => {
      rerender(view([theirs], onSaveDraft));
      throw elsewhere();
    }).mockResolvedValue({ formId: "form-theirs", revision: 4 });
    ({ rerender } = render(view([], onSaveDraft)));
    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "Typed in this session" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getAllByRole("alert").map((node) => node.textContent).join(" ")).toMatch(/changed somewhere else/));
    expect(onSaveDraft.mock.calls[0][0]).toMatchObject({ baseRevision: 0 });
    // The alert commits before the effect that binds the other session's draft
    // runs; a Back in between is withdrawn by that effect and never saves. Act
    // once the stored answers are on this step:
    // TEST-UG-FORMS-DRAFT-BASE-CASE-CLICKS-BEFORE-THE-STORED-DRAFT-IS-BOUND-20261118
    await waitFor(() => expect(screen.getByLabelText(/What happened/)).toHaveValue("Told in the other session"));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.getByLabelText(/Issue summary/)).toHaveValue("Saved in the other session"));
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(onSaveDraft.mock.calls.length).toBeGreaterThan(1));
    const last = onSaveDraft.mock.calls.at(-1)[0];
    expect(last).toMatchObject({ formId: "form-theirs", baseRevision: 4, answers: { summary: "Saved in the other session" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
  });

  // Gate final on #8770 (r3s2): a save the outbox replayed stored its answers;
  // the editor's next save names the revision it wrote, not the older one.
  it("names as base the revision an outbox replay wrote", async () => {
    endFormDraftSession();
    // Offline, every save goes to the outbox and commits nothing here.
    const onSaveDraft = vi.fn(async () => null);
    render(view([draftWith("A", 1)], onSaveDraft));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    const queued = { ...onSaveDraft.mock.calls[0][0] };
    expect(queued).toMatchObject({ formId: "form-1", baseRevision: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(onSaveDraft.mock.calls.length).toBeGreaterThan(1));
    // Reconnected: the outbox replays B, which the server stores at revision 2.
    await replayFormDraft({ memberId: "member-1", fields: queued, save: async () => ({ formId: "form-1", revision: 2 }) });
    onSaveDraft.mockResolvedValue({ formId: "form-1", revision: 3 });
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft.mock.calls.some(([fields]) => fields.answers.summary === "C")).toBe(true));
    const sentC = onSaveDraft.mock.calls.find(([fields]) => fields.answers.summary === "C")[0];
    expect(sentC.baseRevision).toBe(2);
  });

  // #8938 (r5s2): the outbox replay and the editor's saves share one lane, so a
  // save made while a replay is on its way waits for it. This editor was open
  // on A before the replay made the lane and never showed B, so its save names
  // its own load, revision 1, and the server refuses it against B (read
  // R-9392R2, point 4). This case expected revision 2, which stored C over B
  // unseen; Main refuses it. The member's own offline edit is
  // tests/form-save-lost-reply-replay.test.jsx, "holds the editor's own newer
  // edit C until the replay of its offline B lands".
  it("holds a foreground save until the replay of the same template finishes, then names its own load", async () => {
    endFormDraftSession();
    const onSaveDraft = vi.fn(async () => ({ formId: "form-1", revision: 3 }));
    render(view([draftWith("A", 1)], onSaveDraft));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    let reply;
    const replayed = replayFormDraft({ memberId: "member-1", fields: { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, baseRevision: 1 },
      save: () => new Promise((resolve) => { reply = resolve; }) });
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    expect(onSaveDraft).not.toHaveBeenCalled();
    reply({ formId: "form-1", revision: 2 });
    await replayed;
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(onSaveDraft.mock.calls[0][0]).toMatchObject({ answers: { summary: "C" }, baseRevision: 1 });
  });

  // #8949 round 1 (r1s2), as the reviewers ran it: the replay's save is
  // refused as saved elsewhere and its lost-reply read is delayed. Meanwhile
  // another session saves C and the editor opens the form with C at revision
  // 3. The read then returns the older B at revision 2; the next save names 3.
  it("keeps the newer answers an editor opened during the replay, over the replay's late reply", async () => {
    endFormDraftSession();
    let readReply;
    const replayed = replayFormDraft({ memberId: "member-1", fields: { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, baseRevision: 1 },
      save: async () => { throw elsewhere(); },
      readStored: () => new Promise((resolve) => { readReply = resolve; }) });
    await waitFor(() => expect(readReply).toBeTypeOf("function"));
    const onSaveDraft = vi.fn(async () => ({ formId: "form-1", revision: 4 }));
    render(view([draftWith("C", 3)], onSaveDraft));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    readReply({ id: "form-1", answers: { summary: "B" }, revision: 2 });
    await replayed;
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled());
    expect(onSaveDraft.mock.calls[0][0]).toMatchObject({ answers: { summary: "D" }, baseRevision: 3 });
  });

  // #8949 final (r3s1, r4s1): a save of the same answers that finished ahead
  // of the replay (a step change) wrote no new revision. The entry was queued
  // before this page (it names no editor of it), so its replay moves nothing
  // (R-9392D): this editor never showed B, and its next save names its own
  // revision 1 and is refused against B, as on Main.
  it("moves nothing for a replay this editor did not queue, after a save of the same answers ahead of it", async () => {
    endFormDraftSession();
    let release;
    const onSaveDraft = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ formId: "form-1", revision: 1 }); }))
      .mockResolvedValue({ formId: "form-1", revision: 3 });
    render(view([draftWith("A", 1)], onSaveDraft));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    // A step change saves the unchanged answers; that save is still in flight.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(1));
    expect(onSaveDraft.mock.calls[0][0]).toMatchObject({ answers: { summary: "A" }, baseRevision: 1 });
    // The replay is deferred while that save is on its way (it never waits
    // for an editor save, #8938); the outbox's next pass sends it.
    const replay = () => replayFormDraft({ memberId: "member-1", fields: { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, baseRevision: 1 },
      save: async () => ({ formId: "form-1", revision: 2 }) });
    await expect(replay()).rejects.toMatchObject({ code: OUTBOX_REPLAY_DEFERRED });
    release();
    await waitFor(() => expect(memberDraftSaves.get("member:member-1")?.get("grievance")?.tail).toBeNull());
    await replay();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenCalledTimes(2));
    expect(onSaveDraft.mock.calls[1][0].baseRevision).toBe(1);
  });

  // #8949 stage 278 and stage 280 (r9s1, r10s1, r11s1, r12s1), through the
  // editor: B committed at revision 2 but its reply was lost, so the replay is
  // refused and reads the stored draft, and that read is slow. The editor
  // resumes B, leaves, and resumes A; the member types D. Whether A is the
  // write saved back after B (revision 3) or a list row read before B landed
  // (revision 1), the revision says which, and D is sent once and lands.
  const resumeAfterReplay = async (db, reopened) => {
    endFormDraftSession();
    let readReply;
    const replayed = replayFormDraft({ memberId: "member-1", fields: { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, baseRevision: 1 },
      save: async () => { throw elsewhere(); },
      readStored: () => new Promise((resolve) => { readReply = resolve; }) });
    await waitFor(() => expect(readReply).toBeTypeOf("function"));
    const first = render(view([draftWith("B", 2)], db.save));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    first.unmount();
    render(view([reopened], db.save));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    readReply({ id: "form-1", answers: { summary: "B" }, revision: 2 });
    await replayed;
    await waitFor(() => expect(db.save).toHaveBeenCalled());
    return db;
  };

  it("saves the next edit over answers another device saved back while the replay was on its way", async () => {
    const db = await resumeAfterReplay(storedServer("A", 3), draftWith("A", 3));
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(db.save.mock.calls.map(([fields]) => fields.baseRevision)).toEqual([3]);
    expect(db.revision).toBe(4);
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });

  // The reopened answers were a list row read before the replay's B landed:
  // no lane told this editor about B (a replay makes none, R-9392D), so its
  // save names the row's revision 1 and is refused, and B is kept and shown,
  // as on Main.
  it("refuses the next edit when the reopened answers were older than the replay's stored B, and keeps B", async () => {
    const db = await resumeAfterReplay(storedServer("B", 2), draftWith("A", 1));
    expect(db.save.mock.calls.map(([fields]) => fields.baseRevision)).toEqual([1]);
    await waitFor(() => expect(screen.getByText(/changed somewhere else/)).toBeTruthy());
    expect(db.answers).toEqual({ summary: "B" });
  });

  // #8972: a committed save of B, a refresh that failed, then a reopen from
  // the stale list row of A. The row names revision 1, below the lane's 2,
  // so the lane keeps B and the next save names revision 2 and lands.
  it("ignores a stale list row read before the lane's last save (#8972)", async () => {
    endFormDraftSession();
    const db = storedServer("A", 1);
    const first = render(view([draftWith("A", 1)], db.save));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.revision).toBe(2));
    first.unmount();
    render(view([draftWith("A", 1)], db.save));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(db.save.mock.calls.map(([fields]) => fields.baseRevision)).toEqual([1, 2]);
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });

  // #8972, the reads ordered against the lane's last confirmed save: after
  // this editor's save of B, a reopen shows whatever the list row names.
  // A row at a higher revision is a newer load and still reconciles; a row
  // at the lane's own revision, or one naming no revision at all, is not
  // newer than that save and must not put the older answers back.
  const reopenAfterSavingB = async (db, row) => {
    endFormDraftSession();
    const first = render(view([draftWith("A", 1)], db.save));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.revision).toBe(2));
    first.unmount();
    render(view([row], db.save));
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
  };

  it("still takes a list read newer than the lane's last save: another session's answers (#8972)", async () => {
    const db = storedServer("A", 1);
    await reopenAfterSavingB(db, draftWith("C", 3));
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("C");
    // Another session wrote C at revision 3 after this editor's B.
    db.answers = { summary: "C" };
    db.revision = 3;
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(db.save.mock.calls.at(-1)[0].baseRevision).toBe(3);
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });

  it("does not reconcile from a same-age list row, at the revision of the lane's last save (#8972)", async () => {
    const db = storedServer("A", 1);
    await reopenAfterSavingB(db, draftWith("A", 2));
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(db.save.mock.calls.map(([fields]) => fields.baseRevision)).toEqual([1, 2]);
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });

  it("does not reconcile from a stale list row that names no revision, after the lane's last save (#8972)", async () => {
    const db = storedServer("A", 1);
    const stale = { id: "form-1", templateKey: "grievance", status: "draft", step: 0, answers: { summary: "A" }, cosigners: [] };
    await reopenAfterSavingB(db, stale);
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(db.save.mock.calls.map(([fields]) => fields.baseRevision)).toEqual([1, 2]);
    expect(screen.queryByText(/changed somewhere else/)).toBeNull();
  });
});
