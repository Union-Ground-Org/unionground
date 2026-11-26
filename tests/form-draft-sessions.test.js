// BUG-UG-FORM-DRAFT-SNAPSHOT-SESSION-SCOPE-20261027 (#6205): retained
// form-draft answers belong to one authentication session, and the shell ends
// that session on every identity change.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { advanceFormDraftLane, endFormDraftSession, forgetListedReplayedForms, forgetReplayedNewForm, formDraftLaneTurn, formDraftSessionGeneration, memberDraftSaves, mountFormEditor, newFormEditorToken, pageSessionId, replayedNewFormFor, replayFormDraft } from "../src/lib/formDraftSessions.js";
import { createMemoryStore, enqueueWrite, OUTBOX_REPLAY_DEFERRED, pendingCount, replayQueue } from "../src/lib/outbox.js";

describe("form-draft sessions", () => {
  it("advances the generation and drops every member lane when a session ends", () => {
    const before = formDraftSessionGeneration();
    memberDraftSaves.set("member:someone", new Map([["fmla_self", { snapshot: { answers: { reason: "x" } } }]]));
    endFormDraftSession();
    expect(formDraftSessionGeneration()).toBe(before + 1);
    expect(memberDraftSaves.size).toBe(0);
  });

  it("is ended by the shell whenever the session guard reports an identity change", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toMatch(/import \{ endFormDraftSession(?:, replayFormDraft)? \} from "\.\/lib\/formDraftSessions\.js";/);
    const start = app.indexOf("const beginSessionGeneration = useCallback(");
    const branch = app.indexOf("if (guardRef.current.beginSession(nextUserId, options)) {", start);
    expect(start).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(start);
    const firstStatements = app.slice(branch, app.indexOf("clearDeletionAuditPendingNoticeForSession(nextUserId);", branch));
    expect(firstStatements).toContain("endFormDraftSession();");
  });
});


const deferred = () => { let settle; const promise = new Promise((resolve) => { settle = resolve; }); return { promise, settle }; };
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });
const elsewhere = () => Object.assign(new Error("form changed elsewhere"), { code: "PT409", details: "form_saved_elsewhere" });
const A = { summary: "A" }, B = { summary: "B" }, C = { summary: "C" }, D = { summary: "D" };

// The editor that queued the entries below: its token, registered as the one
// editor of the template mounted now, and named by its lane's last save, as
// FormsView's FormEditor and saveDraftInOrder do it.
const TOKEN = newFormEditorToken();
const mounts = new Map();
const mountAs = (templateKey, token) => {
  mounts.get(templateKey)?.();
  mounts.set(templateKey, mountFormEditor("member:member-1", templateKey, token));
};
// A member's lane for the grievance template, as FormsView's ordered saves
// make it: the answers last known as stored, with their revision (#9092).
const install = (fields = {}) => {
  endFormDraftSession();
  mountAs("grievance", TOKEN);
  const queue = { formId: "form-1", baseVersion: null, versions: new Set([null]), reconciliation: 0, formEpoch: 0, tail: null,
    withdrawnThrough: 0, version: 0, confirmed: { answers: A, baseVersion: null, revision: 1 }, editorToken: TOKEN, ...fields };
  memberDraftSaves.set("member:member-1", new Map([["grievance", queue]]));
  return queue;
};
// What FormsView's pendingDraftFor does with an ordinary load: only a higher
// revision replaces what the lane holds (tests/forms-draft-base-advances.test.jsx
// drives the real one).
const reload = (queue, answers, revision) => {
  if (revision > queue.confirmed.revision) { queue.reconciliation += 1; queue.confirmed = { answers, baseVersion: null, revision }; }
};
// save_member_form_draft as the database runs it (20261120222533): the base
// must be the stored revision, a base above 0 must name its form, and a write
// that changes the answers gets the next revision.
const server = (answers = A, revision = 1) => {
  const db = { answers, revision, sent: [] };
  db.save = async (fields) => {
    db.sent.push(fields);
    if (fields.baseRevision > 0 && !fields.formId) throw Object.assign(new Error("form required with a base revision"), { code: "22023" });
    if (fields.baseRevision !== db.revision) throw elsewhere();
    if (JSON.stringify(fields.answers) !== JSON.stringify(db.answers)) db.revision += 1;
    db.answers = fields.answers;
    return { formId: "form-1", revision: db.revision };
  };
  db.write = (next) => { db.answers = next; db.revision += 1; };
  db.read = async () => ({ id: "form-1", answers: db.answers, revision: db.revision });
  return db;
};
// The editor's next save: based on the lane's revision, and its reply moves
// the lane as FormsView's saveDraftInOrder does.
const editorSave = async (queue, db, answers) => {
  const result = await db.save({ templateKey: "grievance", formId: queue.formId, answers, baseRevision: queue.confirmed.revision });
  advanceFormDraftLane(queue, { formId: result.formId, revision: result.revision, answers, epoch: queue.formEpoch });
  return result;
};
// The queued entry: answers B, based on revision 1 of form-1, queued by the
// editor above.
const queuedB = { templateKey: "grievance", formId: "form-1", answers: B, baseRevision: 1, editorToken: TOKEN };

describe("a lane moves only to a higher revision of its form (advanceFormDraftLane)", () => {
  it("takes a higher revision of the same form with its answers, and learns the form", () => {
    const queue = install({ formId: null });
    expect(advanceFormDraftLane(queue, { formId: "form-1", revision: 2, answers: B, epoch: 0 })).toBe(true);
    expect(queue).toMatchObject({ formId: "form-1", confirmed: { answers: B, revision: 2, baseVersion: null } });
  });

  it("keeps the lane for a lower or equal revision, whatever the answers", () => {
    const queue = install({ confirmed: { answers: C, baseVersion: null, revision: 3 } });
    for (const [revision, answers] of [[2, B], [3, B], [1, C]]) {
      expect(advanceFormDraftLane(queue, { formId: "form-1", revision, answers, epoch: 0 }), String(revision)).toBe(false);
    }
    expect(queue.confirmed).toEqual({ answers: C, baseVersion: null, revision: 3 });
  });

  it("changes nothing for another form, a reply from before the lane was reset, or a reply without a form or revision", () => {
    const queue = install({ formEpoch: 1 });
    const before = structuredClone(queue.confirmed);
    const tries = [
      { formId: "form-2", revision: 9, answers: B, epoch: 1 },
      { formId: "form-1", revision: 9, answers: B, epoch: 0 },
      { formId: "", revision: 9, answers: B, epoch: 1 },
      { formId: 7, revision: 9, answers: B, epoch: 1 },
      { formId: "form-1", revision: "9", answers: B, epoch: 1 },
      { formId: "form-1", revision: 2.5, answers: B, epoch: 1 },
    ];
    for (const reply of tries) expect(advanceFormDraftLane(queue, reply), JSON.stringify(reply)).toBe(false);
    expect(advanceFormDraftLane(undefined, { formId: "form-1", revision: 9, epoch: 0 })).toBe(false);
    expect(queue.confirmed).toEqual(before);
    expect(queue.formId).toBe("form-1");
  });
});

// The outbox's formDraft replay, follow-ups of #8770's final.
describe("replaying a queued form-draft save", () => {
  // #8935 (r5s1): the save committed but its reply was lost, so the replay is
  // refused against the revision it moved itself.
  it("counts a replay as committed at the stored revision when the stored draft holds exactly the queued answers", async () => {
    const queue = install();
    const readStored = async () => ({ id: "form-1", answers: { ...B }, revision: 2 });
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => { throw elsewhere(); }, readStored }))
      .resolves.toEqual({ formId: "form-1", revision: 2 });
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
    const other = async () => ({ id: "form-1", answers: { summary: "Another session" }, revision: 3 });
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => { throw elsewhere(); }, readStored: other }))
      .rejects.toMatchObject({ details: "form_saved_elsewhere" });
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => { throw new Error("offline"); }, readStored }))
      .rejects.toThrow("offline");
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
  });

  // #8939 (r6s1): a newer confirmation landed while the replay was in flight.
  it("leaves a newer confirmation in place when the replay's reply arrives late", async () => {
    const queue = install();
    const reply = deferred();
    const pending = replayFormDraft({ memberId: "member-1", fields: queuedB, save: () => reply.promise });
    await tick();
    queue.confirmed = { answers: C, baseVersion: null, revision: 3 };
    reply.settle({ formId: "form-1", revision: 2 });
    await pending;
    expect(queue.confirmed).toMatchObject({ answers: C, revision: 3 });
  });

  // a review note (r6s2) and #8949 round 1 (r1s1, r2s1): the member
  // signed out or another member signed in while the replay was on its way.
  // After every await the app's client may speak for the next member, so
  // nothing more is sent or read and no lane is touched.
  const superseded = { message: expect.stringMatching(/Superseded form-draft replay/) };
  const stored = { formId: "form-1", revision: 2 };

  it("sends nothing when the session already ended before the replay started", async () => {
    const queue = install();
    const save = vi.fn(async () => stored);
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save, isCurrent: () => false })).rejects.toMatchObject(superseded);
    expect(save).not.toHaveBeenCalled();
    expect(queue.confirmed.answers).toEqual(A);
  });

  // #8938, rebuilt on Main's outbox (#8966): a replay runs under its entry's
  // cross-tab lock, and an editor save that fails offline queues under the
  // same lock. So a replay never waits for an editor save: while one is on its
  // way the replay is deferred, sending nothing and holding no turn, and the
  // outbox keeps the entry for its next pass.
  it("is deferred, sending nothing and holding no turn, while an editor save of the form is on its way", async () => {
    const tail = deferred();
    const queue = install({ tail: tail.promise });
    const save = vi.fn(async () => stored);
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save })).rejects.toMatchObject({ code: OUTBOX_REPLAY_DEFERRED });
    expect(save).not.toHaveBeenCalled();
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
    // No turn is held: an editor save made now waits for nothing.
    const turn = vi.fn();
    await formDraftLaneTurn({ tail: null }, "member:member-1", "grievance").then(turn);
    expect(turn).toHaveBeenCalled();
    // Once the save ahead settled, the next pass sends it.
    queue.tail = null;
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save })).resolves.toEqual(stored);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps a deferred entry queued in the outbox, unreported, and replays it on the next pass", async () => {
    const tail = deferred();
    const queue = install({ tail: tail.promise });
    const store = createMemoryStore();
    expect(await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: queuedB } })).toBe(true);
    const db = server(A, 1);
    const executors = { formDraft: (args) => replayFormDraft({ memberId: "member-1", fields: args.fields, save: db.save, readStored: db.read }) };
    const first = await replayQueue(store, "member-1", executors);
    expect(first).toMatchObject({ replayed: 0, failed: [], halted: false });
    expect(await pendingCount(store, "member-1")).toBe(1);
    expect(db.sent).toEqual([]);
    queue.tail = null;
    const second = await replayQueue(store, "member-1", executors);
    expect(second).toMatchObject({ replayed: 1, failed: [] });
    expect(await pendingCount(store, "member-1")).toBe(0);
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
  });

  it("reads nothing for a lost reply once the session ended, and confirms nothing after a read that outlived it", async () => {
    const queue = install();
    let current = true;
    const readStored = vi.fn(async () => ({ id: "form-1", answers: B, revision: 2 }));
    const refusedThenEnded = async () => { current = false; throw elsewhere(); };
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save: refusedThenEnded, readStored, isCurrent: () => current }))
      .rejects.toMatchObject(superseded);
    expect(readStored).not.toHaveBeenCalled();
    current = true;
    const endsDuringRead = vi.fn(async () => { current = false; return { id: "form-1", answers: B, revision: 2 }; });
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => { throw elsewhere(); }, readStored: endsDuringRead, isCurrent: () => current }))
      .rejects.toMatchObject(superseded);
    expect(queue.confirmed.answers).toEqual(A);
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const executor = app.slice(app.indexOf("formDraft: (args) => {"), app.indexOf("formDraft: (args) => {") + 1600);
    expect(executor.indexOf("guardRef.current.captureOperation(")).toBeGreaterThan(-1);
    expect(executor.indexOf("guardRef.current.captureOperation(")).toBeLessThan(executor.indexOf("replayFormDraft({"));
    expect(executor).toContain("memberId: operation.userId");
    expect(executor).toContain("isCurrent: operation.isCurrent");
    // The save and the recovery read are pinned to that member: they send
    // nothing once another member is signed in, and carry that member's token
    // (#8966 held-commit review; forms-api.test.js proves the pin itself).
    expect(executor.indexOf("const asUser = ")).toBeLessThan(executor.indexOf("replayFormDraft({"));
    expect(executor).toContain("save: (fields) => saveFormDraft(supabase, fields, { asUser })");
    expect(executor).toMatch(/readStored: \(fields\) => readStoredFormDraft\(supabase, \{[^}]*\}, \{ asUser \}\)/);
  });

  // R-9392D: a replay never makes a lane. With no lane it only confirms or
  // refuses the entry; the next editor opens on what Your forms reads.
  it("never makes a lane", async () => {
    endFormDraftSession();
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => ({ formId: "form-1", revision: 2 }) });
    await replayFormDraft({ memberId: "member-1", fields: { templateKey: "grievance", answers: B, baseRevision: 0, editorToken: TOKEN }, save: async () => ({ formId: "form-new", revision: 1 }) });
    expect(memberDraftSaves.get("member:member-1")?.get("grievance")).toBeUndefined();
  });

  // The new form an ordinary replay wrote is remembered,
  // for the member and template, until a forms list names it or the session
  // ends; nothing else is remembered.
  it("remembers only the new form an ordinary replay wrote, until a list names it or the session ends", async () => {
    endFormDraftSession();
    const fresh = { templateKey: "grievance", answers: B, step: 2, baseRevision: 0, unitId: "unit-a", chapterId: "chapter-1", organizationId: "org-1" };
    // Each of these writes nothing to remember: an entry naming its form, one
    // of the previous build (a bare form id), a sealed form (a data version),
    // a refused entry, and one whose member signed out before the reply.
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => ({ formId: "form-1", revision: 2 }) });
    await replayFormDraft({ memberId: "member-1", fields: { templateKey: "grievance", answers: B, baseAnswers: {} }, save: async () => "form-1" });
    await replayFormDraft({ memberId: "member-1", fields: { templateKey: "fmla_self", answers: B, expectedDataVersion: null }, save: async () => ({ formId: "form-s", dataVersion: "v-1" }) });
    await expect(replayFormDraft({ memberId: "member-1", fields: fresh, save: async () => { throw elsewhere(); } })).rejects.toMatchObject({ details: "form_saved_elsewhere" });
    let current = true;
    await expect(replayFormDraft({ memberId: "member-1", fields: fresh, isCurrent: () => current, save: async () => { current = false; return { formId: "form-new", revision: 1 }; } }))
      .rejects.toMatchObject(superseded);
    expect(replayedNewFormFor("member:member-1", "grievance")).toBeUndefined();
    expect(replayedNewFormFor("member:member-1", "fmla_self")).toBeUndefined();
    // A new form, written, or committed before its reply was lost.
    await replayFormDraft({ memberId: "member-1", fields: fresh, save: async () => ({ formId: "form-new", revision: 1 }) });
    expect(replayedNewFormFor("member:member-1", "grievance")).toEqual({ id: "form-new", templateKey: "grievance", answers: B, step: 2, revision: 1,
      unitId: "unit-a", chapterId: "chapter-1", organizationId: "org-1" });
    expect(replayedNewFormFor("member:member-2", "grievance")).toBeUndefined();
    forgetListedReplayedForms("member:member-1", new Set(["form-1"]));
    expect(replayedNewFormFor("member:member-1", "grievance")).toMatchObject({ id: "form-new" });
    forgetListedReplayedForms("member:member-1", new Set(["form-new"]));
    expect(replayedNewFormFor("member:member-1", "grievance")).toBeUndefined();
    const plain = { templateKey: "grievance", answers: B, baseRevision: 0 };
    await replayFormDraft({ memberId: "member-1", fields: plain, save: async () => { throw elsewhere(); }, readStored: async () => ({ id: "form-lost", answers: B, revision: 1, organizationId: null, settingsScope: {} }) });
    expect(replayedNewFormFor("member:member-1", "grievance")).toMatchObject({ id: "form-lost", revision: 1, answers: B });
    expect(replayedNewFormFor("member:member-1", "grievance").unitId).toBeUndefined();
    endFormDraftSession();
    expect(replayedNewFormFor("member:member-1", "grievance")).toBeUndefined();
  });

  // #9457 round 1: the page drops the note once it learns the form is gone
  // (only a note naming that form) or once a save of the template is
  // confirmed (any note of the template); another member's note stays.
  it("drops a note naming a form found gone, or any note of the template after a confirmed save", async () => {
    endFormDraftSession();
    const fresh = { templateKey: "grievance", answers: B, step: 0, baseRevision: 0 };
    const remember = (memberId, formId) => replayFormDraft({ memberId, fields: fresh, save: async () => ({ formId, revision: 1 }) });
    await remember("member-1", "form-old");
    await remember("member-2", "form-old");
    forgetReplayedNewForm("member:member-1", "grievance", "form-other");
    forgetReplayedNewForm("member:member-1", "grievance", null);
    forgetReplayedNewForm("member:member-1", "another-template");
    expect(replayedNewFormFor("member:member-1", "grievance")).toMatchObject({ id: "form-old" });
    forgetReplayedNewForm("member:member-1", "grievance", "form-old");
    expect(replayedNewFormFor("member:member-1", "grievance")).toBeUndefined();
    expect(replayedNewFormFor("member:member-2", "grievance")).toMatchObject({ id: "form-old" });
    await remember("member-1", "form-new");
    // A later replay of an entry naming the remembered form moves the note to
    // its higher revision; one naming another form, or an older revision,
    // does not.
    const named = (formId, revision, answers) => replayFormDraft({ memberId: "member-1", fields: { templateKey: "grievance", formId, answers, step: 1, baseRevision: revision - 1 }, save: async () => ({ formId, revision }) });
    await named("form-other", 5, D);
    await named("form-new", 2, C);
    await named("form-new", 2, D);
    expect(replayedNewFormFor("member:member-1", "grievance")).toMatchObject({ id: "form-new", answers: C, step: 1, revision: 2 });
    forgetReplayedNewForm("member:member-1", "grievance");
    expect(replayedNewFormFor("member:member-1", "grievance")).toBeUndefined();
    forgetReplayedNewForm(null, "grievance");
    expect(replayedNewFormFor("member:member-2", "grievance")).toMatchObject({ id: "form-old" });
    endFormDraftSession();
  });

  // R-8935: a lane at any revision other than the entry's base keeps it, so an
  // editor showing other answers is refused rather than saved over the replay.
  it("moves a lane only while it holds exactly the revision the entry was based on", async () => {
    const queue = install({ confirmed: { answers: { summary: "Older" }, baseVersion: null, revision: 1 } });
    await replayFormDraft({ memberId: "member-1", fields: { ...queuedB, answers: { summary: "X" }, baseRevision: 2 }, save: async () => ({ formId: "form-1", revision: 3 }) });
    expect(queue.confirmed).toMatchObject({ answers: { summary: "Older" }, revision: 1 });
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => ({ formId: "form-1", revision: 2 }) });
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
  });

  it("moves no lane once the lane was reset for another form during the replay", async () => {
    const queue = install();
    const reply = deferred();
    const pending = replayFormDraft({ memberId: "member-1", fields: queuedB, save: () => reply.promise });
    await tick();
    // What FormsView's resetDraftLane does when the form was submitted elsewhere.
    Object.assign(queue, { formId: null, formEpoch: 1, confirmed: { answers: {}, baseVersion: null, revision: 0 } });
    reply.settle({ formId: "form-1", revision: 2 });
    await pending;
    expect(queue).toMatchObject({ formId: null, confirmed: { answers: {}, revision: 0 } });
  });

  // An entry queued by the previous build names no base revision and no
  // editor. It is sent as queued (save_form_draft, base answers), and its reply
  // is a bare form id: it moves no lane, so the editor's next save names what
  // it shows and is refused against B, never written over it (Main moves this
  // base with no condition; R-9392D, the r1s1 ground, is safer than Main). Its
  // lost reply is still recognised: the entry goes without an error.
  it("moves no lane for an entry queued by the previous build, and recognises its lost reply", async () => {
    const queue = install();
    const db = server(A, 1);
    const legacy = { templateKey: "grievance", formId: "form-1", answers: B, baseAnswers: A };
    const save = vi.fn(async (fields) => { db.write(fields.answers); return "form-1"; });
    await expect(replayFormDraft({ memberId: "member-1", fields: legacy, save, readStored: db.read })).resolves.toBe("form-1");
    expect(save.mock.calls[0][0]).toBe(legacy);
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
    await expect(editorSave(queue, db, D)).rejects.toMatchObject({ details: "form_saved_elsewhere" });
    expect(db.answers).toEqual(B);
    await expect(replayFormDraft({ memberId: "member-1", fields: legacy, save: async () => { throw elsewhere(); }, readStored: db.read })).resolves.toBe("form-1");
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
  });

  // #9392 round 1 (r2s2) and #9403 round 1 (r2s1): the recovery read must find
  // the very draft the entry was for, comparing only what the database stores.
  // An ordinary or unit row keeps organization_id null (only a sealed form sets
  // it); its settings_scope is the stamp {chapterId, unitId, unitName}.
  it("confirms a lost reply from the entry's own unit draft with organization_id null, and never another unit's or organization's", async () => {
    const queue = install({ formId: null, confirmed: { answers: {}, baseVersion: null, revision: 0 } });
    const unitA = { templateKey: "grievance", answers: B, baseRevision: 0, unitId: "unit-a", actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1", editorToken: TOKEN };
    const stored = (scope, organizationId = null) => async () => ({ id: "form-b", answers: B, revision: 1, organizationId, settingsScope: scope });
    const refused = (readStored, fields = unitA) => expect(replayFormDraft({ memberId: "member-1", fields, save: async () => { throw elsewhere(); }, readStored }))
      .rejects.toMatchObject({ details: "form_saved_elsewhere" });
    // Another unit; another chapter (so another organization); a draft whose
    // stamp has no chapter; a sealed-kind row bound to another organization.
    await refused(stored({ chapterId: "chapter-1", unitId: "unit-b", unitName: "B" }));
    await refused(stored({ chapterId: "chapter-of-another-organization", unitId: "unit-a", unitName: "A" }));
    await refused(stored({ unitId: "unit-a" }));
    await refused(stored({ chapterId: "chapter-1", unitId: "unit-a", unitName: "A" }, "org-2"));
    expect(queue.confirmed).toMatchObject({ answers: {}, revision: 0 });
    // Its own unit, organization_id null as the database leaves it: recognised.
    await expect(replayFormDraft({ memberId: "member-1", fields: unitA, save: async () => { throw elsewhere(); }, readStored: stored({ chapterId: "chapter-1", unitId: "unit-a", unitName: "A" }) }))
      .resolves.toEqual({ formId: "form-b", revision: 1 });
    // An entry with no unit that names no form is confirmed only by a draft
    // with no unit.
    const plain = { templateKey: "grievance", answers: B, baseRevision: 0 };
    await refused(stored({ chapterId: "chapter-1", unitId: "unit-a", unitName: "A" }), plain);
    await expect(replayFormDraft({ memberId: "member-1", fields: plain, save: async () => { throw elsewhere(); }, readStored: stored({}) }))
      .resolves.toEqual({ formId: "form-b", revision: 1 });
    // #9403 final (r4s1): an entry with no unit (the legacy workflow) that
    // names its form matches that exact form whatever stamp it kept; another
    // form, or a sealed-kind row of another organization, still never does.
    const named = { templateKey: "grievance", formId: "form-b", answers: B, baseRevision: 1 };
    await expect(replayFormDraft({ memberId: "member-1", fields: named, save: async () => { throw elsewhere(); }, readStored: stored({ chapterId: "chapter-1", unitId: "unit-a", unitName: "A" }) }))
      .resolves.toEqual({ formId: "form-b", revision: 1 });
    await refused(stored({ chapterId: "chapter-1", unitId: "unit-a", unitName: "A" }), { ...named, formId: "another-form" });
    await refused(stored({ chapterId: "chapter-1", unitId: "unit-a", unitName: "A" }, "org-2"), { ...named, organizationId: "org-1" });
  });

  // A sealed form's dataVersion names one write. The replay's write is the
  // newer one when the lane still holds the version it was based on.
  it("takes a sealed replay's version only while the lane holds the version it was based on", async () => {
    const fields = { templateKey: "fmla_self", formId: "form-s", answers: { reason: "x" }, expectedDataVersion: "v-1", editorToken: TOKEN };
    const lane = (baseVersion) => {
      endFormDraftSession();
      mountAs("fmla_self", TOKEN);
      const queue = { formId: "form-s", baseVersion, versions: new Set([baseVersion]), reconciliation: 0, formEpoch: 0, tail: null,
        confirmed: { answers: { reason: "w" }, baseVersion, revision: 0 }, editorToken: TOKEN };
      memberDraftSaves.set("member:member-1", new Map([["fmla_self", queue]]));
      return queue;
    };
    let queue = lane("v-1");
    await replayFormDraft({ memberId: "member-1", fields, save: async () => ({ formId: "form-s", dataVersion: "v-2" }) });
    expect(queue).toMatchObject({ baseVersion: "v-2", confirmed: { answers: { reason: "x" }, baseVersion: "v-2" } });
    expect([...queue.versions].at(-1)).toBe("v-2");
    queue = lane("v-5");
    await replayFormDraft({ memberId: "member-1", fields, save: async () => ({ formId: "form-s", dataVersion: "v-2" }) });
    expect(queue).toMatchObject({ baseVersion: "v-5", confirmed: { answers: { reason: "w" }, baseVersion: "v-5" } });
  });
});

// Every sequence the #8949 gate raised, rounds 1 to 12, replayed through the
// revision. The lane holds A at revision 1; the outbox holds B based on it.
describe("the #8949 sequences: the higher revision wins", () => {
  // These three were raised against a replay that waited for the save ahead.
  // A replay now never waits: it is deferred while that save is on its way
  // and sent by the outbox's next pass, so each ends as the higher revision.
  const deferredThenReplayed = async (queue, fields, db) => {
    await expect(replayFormDraft({ memberId: "member-1", fields, save: db.save })).rejects.toMatchObject({ code: OUTBOX_REPLAY_DEFERRED });
    return () => { queue.tail = null; return replayFormDraft({ memberId: "member-1", fields, save: db.save }); };
  };

  it("r3s1, r4s1: the save ahead saved the same answers again (no new revision), then the replay's C lands", async () => {
    const ahead = deferred();
    const queue = install({ tail: ahead.promise, confirmed: { answers: B, baseVersion: null, revision: 2 } });
    const db = server(B, 2);
    const next = await deferredThenReplayed(queue, { ...queuedB, answers: C, baseRevision: 2 }, db);
    await editorSave(queue, db, B);
    expect(db.revision).toBe(2);
    ahead.settle();
    await expect(next()).resolves.toEqual({ formId: "form-1", revision: 3 });
    expect(queue.confirmed).toMatchObject({ answers: C, revision: 3 });
  });

  it("r5s1, r6s1: the save ahead wrote the replay's base over other answers", async () => {
    const ahead = deferred();
    const queue = install({ tail: ahead.promise });
    const db = server(A, 1);
    const next = await deferredThenReplayed(queue, { ...queuedB, answers: C, baseRevision: 2 }, db);
    await editorSave(queue, db, B);
    ahead.settle();
    await next();
    expect(queue.confirmed).toMatchObject({ answers: C, revision: 3 });
    expect(db.answers).toEqual(C);
  });

  it("r7s1, r8s1: a reload during the wait only caught up with the save ahead", async () => {
    const ahead = deferred();
    const queue = install({ tail: ahead.promise });
    const db = server(B, 2);
    const next = await deferredThenReplayed(queue, { ...queuedB, answers: C, baseRevision: 2 }, db);
    reload(queue, B, 2);
    // The save ahead's late reply names the same revision: nothing moves.
    advanceFormDraftLane(queue, { formId: "form-1", revision: 2, answers: B, epoch: 0 });
    ahead.settle();
    await next();
    expect(queue.confirmed).toMatchObject({ answers: C, revision: 3 });
  });

  it("r1s2: a reload during the request brought another session's answers, which stay", async () => {
    const queue = install();
    const reply = deferred();
    const pending = replayFormDraft({ memberId: "member-1", fields: queuedB, save: () => reply.promise });
    await tick();
    reload(queue, { summary: "Another session" }, 3);
    reply.settle({ formId: "form-1", revision: 2 });
    await pending;
    expect(queue.confirmed).toMatchObject({ answers: { summary: "Another session" }, revision: 3 });
  });

  // B committed but its reply was lost; the replay is refused and reads the
  // stored draft, and that read is held until the test releases it.
  const lostReply = (db) => {
    const read = deferred();
    const pending = replayFormDraft({ memberId: "member-1", fields: queuedB, save: db.save, readStored: () => read.promise });
    return { pending, read };
  };

  it("r9s1: a refresh caught up with B before the replay sent, then another device saved A back", async () => {
    const queue = install();
    const db = server(B, 2);
    reload(queue, B, 2);
    const { pending, read } = lostReply(db);
    await tick();
    db.write(A);
    reload(queue, A, 3);
    read.settle({ id: "form-1", answers: B, revision: 2 });
    await expect(pending).resolves.toEqual({ formId: "form-1", revision: 2 });
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 3 });
    await editorSave(queue, db, D);
    expect(db).toMatchObject({ answers: D, revision: 4 });
  });

  it("r10s1: the editor resumed B during the replay, then another device saved A back and the editor resumed A", async () => {
    const queue = install();
    const db = server(B, 2);
    const { pending, read } = lostReply(db);
    await tick();
    reload(queue, B, 2);
    db.write(A);
    reload(queue, A, 3);
    read.settle({ id: "form-1", answers: B, revision: 2 });
    await pending;
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 3 });
    await editorSave(queue, db, D);
    expect(db.answers).toEqual(D);
    expect(db.sent.filter((fields) => fields.answers === D)).toHaveLength(1);
  });

  // r11s1, r12s1: the reload of A was equal to what the lane already held, so
  // the old reconciliation counter stayed put and the late replay confirmed
  // B over it. The reload names revision 3, above the lane's 1, so the lane
  // takes it; the replay's revision 2 is below it and changes nothing.
  it("r11s1, r12s1: an equal reload of the base, written back after the replay, is newer and stays", async () => {
    const queue = install();
    const db = server(A, 1);
    const reply = deferred();
    const pending = replayFormDraft({ memberId: "member-1", fields: queuedB, save: async (fields) => { await db.save(fields); return reply.promise; } });
    await tick();
    expect(db).toMatchObject({ answers: B, revision: 2 });
    db.write(A);
    reload(queue, A, 3);
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 3 });
    reply.settle({ formId: "form-1", revision: 2 });
    await pending;
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 3 });
    await editorSave(queue, db, D);
    expect(db).toMatchObject({ answers: D, revision: 4 });
  });

  // The stale read the old allowance was for: the reload of A was read before
  // B landed. It names revision 1, not above the lane, so it changes nothing,
  // and the replay's revision 2 moves the lane; the next edit lands.
  it("an older reload of the base, read before the replay's B landed, is ignored", async () => {
    const queue = install();
    const db = server(A, 1);
    const reply = deferred();
    const pending = replayFormDraft({ memberId: "member-1", fields: queuedB, save: async (fields) => { await db.save(fields); return reply.promise; } });
    await tick();
    reload(queue, A, 1);
    reply.settle({ formId: "form-1", revision: 2 });
    await pending;
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
    await editorSave(queue, db, D);
    expect(db).toMatchObject({ answers: D, revision: 3 });
  });

  // r12s2: the second base did not survive the offline outbox. There is one
  // base now, the revision, and it is plain JSON in the queued entry: after a
  // page reload (no lane at all) the replay is still checked against it.
  it("r12s2: an entry's base revision survives the outbox and a page reload", async () => {
    const entry = JSON.parse(JSON.stringify({ fields: { ...queuedB, baseRevision: 3, answers: D } }));
    expect(entry.fields.baseRevision).toBe(3);
    endFormDraftSession();
    const stale = server(A, 4);
    await expect(replayFormDraft({ memberId: "member-1", fields: entry.fields, save: stale.save, readStored: stale.read }))
      .rejects.toMatchObject({ details: "form_saved_elsewhere" });
    expect(stale.answers).toEqual(A);
    endFormDraftSession();
    const current = server(A, 3);
    await expect(replayFormDraft({ memberId: "member-1", fields: entry.fields, save: current.save })).resolves.toEqual({ formId: "form-1", revision: 4 });
    expect(current.answers).toEqual(D);
  });

  // A loaded earlier and A saved back later used to look the same. The lane
  // read A at revision 1; another session wrote B, then A, so A is stored at
  // revision 3. The phone's save based on revision 1 is refused.
  it("refuses an edit based on A read earlier, after another session wrote B and then A back", async () => {
    const queue = install();
    const db = server(A, 1);
    db.write(B);
    db.write(A);
    await expect(editorSave(queue, db, D)).rejects.toMatchObject({ details: "form_saved_elsewhere" });
    expect(db).toMatchObject({ answers: A, revision: 3 });
    reload(queue, A, 3);
    await editorSave(queue, db, D);
    expect(db).toMatchObject({ answers: D, revision: 4 });
  });
});

// R-9392D: the one rule. A replay's reply moves a lane only for the editor
// that queued the entry, while that editor is the one mounted on the lane and
// made its last save, at exactly the entry's base, and only to a higher
// revision. The token's lifetime is pinned here: two editors on one lane, a
// StrictMode remount, a member change, a reload, a failed attempt and the
// outbox's clone.
describe("the editor token", () => {
  const reply2 = async () => ({ formId: "form-1", revision: 2 });

  it("moves the lane only for an entry its own mounted editor queued", async () => {
    let queue = install();
    await replayFormDraft({ memberId: "member-1", fields: { ...queuedB, editorToken: undefined }, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
    await replayFormDraft({ memberId: "member-1", fields: { ...queuedB, editorToken: newFormEditorToken() }, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
    // The lane's last save came from another editor.
    queue = install({ editorToken: newFormEditorToken() });
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
    queue = install();
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
  });

  it("moves nothing while two editors of the template are mounted (two trees on one lane)", async () => {
    const queue = install();
    const second = mountFormEditor("member:member-1", "grievance", newFormEditorToken());
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
    // The second tree unmounts: its cleanup removes its own token only.
    second();
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
  });

  it("keeps the token registered once across StrictMode's effect, cleanup and effect, and drops it at unmount", async () => {
    const queue = install();
    mounts.get("grievance")();
    mounts.delete("grievance");
    const token = newFormEditorToken();
    queue.editorToken = token;
    const first = mountFormEditor("member:member-1", "grievance", token);
    first();
    const second = mountFormEditor("member:member-1", "grievance", token);
    await replayFormDraft({ memberId: "member-1", fields: { ...queuedB, editorToken: token }, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
    second();
    await replayFormDraft({ memberId: "member-1", fields: { ...queuedB, editorToken: token, answers: C, baseRevision: 2 }, save: async () => ({ formId: "form-1", revision: 3 }) });
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
  });

  it("moves nothing after a member change, and nothing for an entry from an earlier page", async () => {
    install();
    endFormDraftSession();
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: reply2 });
    expect(memberDraftSaves.get("member:member-1")?.get("grievance")).toBeUndefined();
    // A new session's lane, made by a new editor: the old entry names another.
    const queue = install({ editorToken: newFormEditorToken() });
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
    // A token from another page session (a reload) never equals this page's.
    const page = install();
    await replayFormDraft({ memberId: "member-1", fields: { ...queuedB, editorToken: "an-earlier-page:1" }, save: reply2 });
    expect(page.confirmed).toMatchObject({ answers: A, revision: 1 });
    expect(TOKEN.startsWith("an-earlier-page:")).toBe(false);
  });

  // The final on #9392 (r4s1): a failed attempt, then a retry after another
  // editor took the lane, moves nothing.
  it("moves nothing on a retry after another editor took the lane during a failed attempt", async () => {
    const queue = install();
    await expect(replayFormDraft({ memberId: "member-1", fields: queuedB, save: async () => { throw new TypeError("Failed to fetch"); } }))
      .rejects.toThrow("Failed to fetch");
    mountAs("grievance", newFormEditorToken());
    queue.editorToken = "the editor that opened meanwhile";
    await replayFormDraft({ memberId: "member-1", fields: queuedB, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
  });

  it("survives the outbox's structured clone as a plain string", async () => {
    const queue = install();
    const cloned = structuredClone({ fields: queuedB }).fields;
    expect(typeof cloned.editorToken).toBe("string");
    expect(cloned.editorToken).toBe(TOKEN);
    await replayFormDraft({ memberId: "member-1", fields: cloned, save: reply2 });
    expect(queue.confirmed).toMatchObject({ answers: B, revision: 2 });
  });

  // #8939: a newer confirmation C, then the late reply of B: the next save
  // names C.
  it("leaves a newer confirmation of the queuing editor's lane in place against the late reply", async () => {
    const queue = install();
    const reply = deferred();
    const pending = replayFormDraft({ memberId: "member-1", fields: queuedB, save: () => reply.promise });
    await tick();
    advanceFormDraftLane(queue, { formId: "form-1", revision: 3, answers: C, epoch: 0 });
    reply.settle({ formId: "form-1", revision: 2 });
    await pending;
    expect(queue.confirmed).toMatchObject({ answers: C, revision: 3 });
    const db = server(C, 3);
    await editorSave(queue, db, D);
    expect(db.sent.at(-1).baseRevision).toBe(3);
  });
});

// #9403: the page-session id never uses Math.random (the scan) and is never a
// clock value that two pages could share (round 1, r2s2). It takes the
// platform's randomUUID, else getRandomValues; with neither there is no id,
// no editor token, and an entry such a page queues moves no lane.
describe("the page-session id", () => {
  it("takes randomUUID first, then getRandomValues, each a plain string that survives a structured clone", () => {
    let n = 0;
    const first = pageSessionId({ randomUUID: () => `uuid-${++n}` });
    expect(first).not.toBe(pageSessionId({ randomUUID: () => `uuid-${++n}` }));
    let seed = 7;
    const values = { getRandomValues: (array) => { array.fill(seed += 1); return array; } };
    const drawn = pageSessionId(values);
    expect(drawn).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    expect(drawn).not.toBe(pageSessionId(values));
    expect(structuredClone({ id: drawn }).id).toBe(drawn);
  });

  it("is null with no random source or a throwing one, and never calls Math.random", () => {
    const random = vi.spyOn(Math, "random");
    try {
      expect(pageSessionId({})).toBeNull();
      expect(pageSessionId(null)).toBeNull();
      expect(pageSessionId({ randomUUID: () => { throw new Error("unavailable"); } })).toBeNull();
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });

  it("gives a page with no random source no editor token, so an entry it queues moves no lane", async () => {
    vi.resetModules();
    vi.stubGlobal("crypto", undefined);
    try {
      const sessions = await import("../src/lib/formDraftSessions.js");
      expect(sessions.newFormEditorToken()).toBeNull();
      sessions.endFormDraftSession();
      const unmount = sessions.mountFormEditor("member:member-1", "grievance", sessions.newFormEditorToken());
      const queue = { formId: "form-1", baseVersion: null, versions: new Set([null]), reconciliation: 0, formEpoch: 0, tail: null,
        withdrawnThrough: 0, version: 0, confirmed: { answers: A, baseVersion: null, revision: 1 }, editorToken: null };
      sessions.memberDraftSaves.set("member:member-1", new Map([["grievance", queue]]));
      await sessions.replayFormDraft({ memberId: "member-1", fields: { ...queuedB, editorToken: null }, save: async () => ({ formId: "form-1", revision: 2 }) });
      expect(queue.confirmed).toMatchObject({ answers: A, revision: 1 });
      unmount();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
