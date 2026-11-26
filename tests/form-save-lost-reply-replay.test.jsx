// Records #8935, #8938 and #8939, one test per acceptance line, on the real
// stores: the editor's ordered save lane (FormsView), the outbox store and its
// replay pass (src/lib/outbox.js) and the replay itself (formDraftSessions.js),
// against a model of the two save functions the database has now:
// save_member_form_draft (a base revision, #9092, 20261120222533) and
// save_form_draft (base answers, #8719). The editor's save goes through
// App's handleSaveDraft path: sent, and queued in the outbox when the network
// fails; the outbox's formDraft executor is App's.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { endFormDraftSession, memberDraftSaves, replayFormDraft } from "../src/lib/formDraftSessions.js";
import { createMemoryStore, enqueueWrite, pendingCount, replayQueue } from "../src/lib/outbox.js";

const deferred = () => { let settle; const promise = new Promise((resolve) => { settle = resolve; }); return { promise, settle }; };
const elsewhere = () => Object.assign(new Error("form changed elsewhere"), { code: "PT409", details: "form_saved_elsewhere" });
// jsonb equality, as the member_forms_revision trigger and save_form_draft
// compare answers (20261120222533 line 56; 20261113134400 line 107): key order
// does not matter.
const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);
const same = (left, right) => JSON.stringify(canonical(left ?? {})) === JSON.stringify(canonical(right ?? {}));
const unitRefusal = (message) => Object.assign(new Error(message), { code: "42501" });

// The member's grievance draft form-1 as the database keeps it. A write that
// changes the answers gets the next revision. loseReply: the next write
// commits, then its reply is lost to the network. holdReply: the next write
// commits, and its reply waits for that promise.
const database = (summary, revision = 1) => {
  const db = { answers: { summary }, revision, loseReply: false, holdReply: null, sent: [] };
  const write = (answers, fields = null) => {
    if (!same(answers, db.answers)) db.revision += 1;
    db.answers = answers;
    // db.units (opt in): stamp settings_scope as the a01_unit_form_settings
    // trigger does on the member's own write (20261113124000 lines 498 to
    // 557): an existing stamp is kept, held or released (lines 502 to 522);
    // while held nothing new is stamped; while released an unstamped row is
    // stamped with its chapter and the unit resolve_settings_unit picks (line
    // 520): the requested unit of a unit save (p_unit), or, for a save that
    // names none (the legacy workflow), the member's sole unit when they are
    // in exactly one (lines 226 to 230), no unit when they are in none (line
    // 226); a member of several units must choose, and that save is refused
    // (line 229; no row here models it).
    if (db.units && fields && !db.scope?.chapterId && db.units.released) {
      const unitId = fields.unitId !== undefined ? fields.unitId : (db.units.soleUnit ?? null);
      db.scope = { chapterId: "chapter-1", unitId, unitName: unitId ? `Name of ${unitId}` : null };
    }
  };
  db.save = async (fields) => {
    db.sent.push(fields);
    // offlineAfter: the next request waits for that promise, then fails on the
    // network before it reaches the server.
    if (db.offlineAfter) { const gate = db.offlineAfter; db.offlineAfter = null; await gate; throw new TypeError("Failed to fetch"); }
    // A unit save (unitId named: save_unit_member_form_draft) runs the unit
    // wrapper's checks BEFORE any revision is compared, as the SQL does
    // (20261120222533 lines 153 to 162). require_unit_workflow_context refuses
    // (42501) unless the actor, chapter and organization are the member's
    // current ones (20261113124000 lines 578 to 585); resolve_settings_unit
    // then refuses (42501) any named unit while settings are held (lines 216
    // to 219) and a unit the member is not in (lines 221 to 222). The model's
    // member is member-1 in chapter-1 of org-1, in units unit-a and unit-b,
    // with settings released unless db.units says otherwise.
    if (fields.unitId !== undefined) {
      const released = db.units ? db.units.released : true;
      const memberUnits = db.units?.memberUnits ?? ["unit-a", "unit-b"];
      if (fields.actorId !== "member-1" || fields.chapterId !== "chapter-1" || fields.organizationId !== "org-1") throw unitRefusal("work context changed; reload");
      if (fields.unitId !== null && (!released || !memberUnits.includes(fields.unitId))) throw unitRefusal("unit membership changed");
    }
    let result;
    if (Number.isSafeInteger(fields.baseRevision)) {
      if (fields.baseRevision > 0 && !fields.formId) throw Object.assign(new Error("form required with a base revision"), { code: "22023" });
      if (fields.baseRevision !== db.revision) throw elsewhere();
      write(fields.answers, fields);
      result = { formId: "form-1", revision: db.revision };
    } else {
      if (fields.baseAnswers && !same(fields.baseAnswers, db.answers)) throw elsewhere();
      write(fields.answers, fields);
      result = "form-1";
    }
    if (db.loseReply) { db.loseReply = false; throw new TypeError("Failed to fetch"); }
    if (db.holdReply) { const gate = db.holdReply; db.holdReply = null; await gate; }
    return result;
  };
  // The draft's unit (settings_scope) and organization, as readStoredFormDraft
  // returns them; {} and null while per-unit settings are held.
  db.scope = {};
  // organization_id as the database stores it on an ordinary or unit row:
  // null (only a sealed form sets it; tests/form-draft-row-shape.test.js).
  db.read = async () => ({ id: "form-1", answers: db.answers, revision: db.revision, settingsScope: db.scope, organizationId: null });
  db.otherDevice = (next) => write({ summary: next });
  return db;
};
const row = (db) => ({ id: "form-1", templateKey: "grievance", status: "draft", step: 0, answers: db.answers, revision: db.revision, cosigners: [] });

// App's handleSaveDraft: the save is sent; when the network fails it is
// queued in the outbox and the editor is told nothing was confirmed.
const appSave = (db, store) => async (fields) => {
  try {
    return await db.save(fields);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: fields.templateKey, args: { fields: { ...fields, onFormId: undefined, verify: undefined } } });
    return null;
  }
};
// App's outbox executor for formDraft.
const executors = (db) => ({
  formDraft: (args) => replayFormDraft({ memberId: "member-1", fields: args.fields, save: db.save, readStored: db.read }),
});
const formsView = (db, store, forms) => (
  <LanguageProvider lang="en">
    <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms }} onSaveDraft={appSave(db, store)}
      onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
  </LanguageProvider>
);
const editor = (db, store, forms = [row(db)]) => render(formsView(db, store, forms));
const lane = () => memberDraftSaves.get("member:member-1")?.get("grievance");
const settled = () => waitFor(() => expect(lane()?.tail ?? null).toBeNull());
const type = (summary) => fireEvent.change(screen.getByLabelText(/Issue summary/), { target: { value: summary } });
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const back = () => fireEvent.click(screen.getByRole("button", { name: "Back" }));
const refused = () => screen.queryByText(/changed somewhere else/);

// #9403 round 1 (item 8): this file's model reads a row as the database
// stores it (tests/form-draft-row-shape.test.js pins the same facts against the
// migrations): an ordinary or unit save leaves organization_id null, and
// settings_scope is {} until the unit trigger stamps {chapterId, unitId,
// unitName}.
describe("the database model of this file", () => {
  it("reads organization_id null and the settings scope as the database stores them", async () => {
    const db = database("A");
    await db.save({ templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, baseRevision: 1 });
    expect(await db.read()).toEqual({ id: "form-1", answers: { summary: "B" }, revision: 2, settingsScope: {}, organizationId: null });
    db.scope = { chapterId: "chapter-1", unitId: "unit-a", unitName: "Unit A" };
    expect(Object.keys((await db.read()).settingsScope).sort()).toEqual(["chapterId", "unitId", "unitName"]);
  });
});

describe("#8935: a form save that committed but lost its reply", () => {
  it("replays as committed at the stored revision: the entry goes without an error, and the next edit is stored", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    editor(db, store);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    db.loseReply = true;
    type("B");
    next();
    await waitFor(async () => expect(await pendingCount(store, "member-1")).toBe(1));
    await settled();
    expect(db.answers).toEqual({ summary: "B" });

    const pass = await replayQueue(store, "member-1", executors(db));
    expect(pass).toMatchObject({ replayed: 1, failed: [], halted: false });
    expect(await pendingCount(store, "member-1")).toBe(0);
    expect(lane().formId).toBe("form-1");

    back();
    type("C");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
    expect(refused()).toBeNull();
  });

  it("keeps the refusal when the stored answers differ, and Your forms is read again", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    // B was queued offline and never reached the server; another device then
    // saved X.
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, step: 0, baseRevision: 1, baseAnswers: { summary: "A" } } } });
    db.otherDevice("X");
    const pass = await replayQueue(store, "member-1", executors(db));
    expect(pass.replayed).toBe(0);
    expect(pass.failed).toEqual([expect.objectContaining({ kind: "formDraft", message: expect.stringMatching(/form changed elsewhere/) })]);
    expect(db.answers).toEqual({ summary: "X" });
    // App's pass reads Your forms again after a refused form replay, not only
    // after a replayed one.
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const pass2 = app.slice(app.indexOf("const result = await replayQueue(outboxStoreRef.current, userId, outboxExecutors"));
    const branch = pass2.slice(0, pass2.indexOf("const passNotice = replayNotice(result);"));
    expect(branch).toMatch(/result\.failed\.some\(\(failure\) => failure\.kind === "formDraft"\)\)\s*\{[\s\S]*?refreshRef\.current\(activeSession, memberMutationResources\("saveFormDraft"\)\)/);
  });
});

describe("#8938: an outbox replay is ordered with the editor's saves of the same form", () => {
  // Record #8938's own scenario ("although only this session edited the
  // form"): this editor typed B, and that save went to the outbox offline, so
  // the lane is the editor's own and B is what it shows. While the replay of B
  // is on its way the member types C: C waits for the replay's reply, is built
  // on B's revision and is stored, never refused against the member's own B.
  // On Main this fails: C goes out at once on base A and is refused.
  it("holds the editor's own newer edit C until the replay of its offline B lands, then stores C on B", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    editor(db, store);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    db.offlineAfter = Promise.resolve();
    type("B");
    next();
    await waitFor(async () => expect((await store.listEntries("member-1")).map((entry) => entry.args.fields.answers)).toEqual([{ summary: "B" }]));
    await settled();
    expect(db).toMatchObject({ answers: { summary: "A" }, revision: 1 });
    // Back online: the replay's write commits at once; its reply is slow.
    const reply = deferred();
    db.holdReply = reply.promise;
    const pass = replayQueue(store, "member-1", executors(db));
    await waitFor(() => expect(db.answers).toEqual({ summary: "B" }));
    back();
    type("C");
    next();
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    expect(db.sent.some((fields) => fields.answers.summary === "C")).toBe(false);
    reply.settle();
    expect(await pass).toMatchObject({ replayed: 1, failed: [] });
    await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
    expect(db.sent.filter((fields) => fields.answers.summary === "C").map((fields) => fields.baseRevision)).toEqual([2]);
    expect(refused()).toBeNull();
  });

  // The outbox replays each entry under its cross-tab lock (#8966), and an
  // editor save that fails offline queues under the same lock. A replay that
  // waited inside that lock for the editor's save in flight would never end,
  // and neither would the save. The replay is deferred instead; the save
  // queues; the next pass sends the newest answers once.
  it("defers a replay while the editor's save is on its way, so that save can still queue offline under the entry's lock", async () => {
    endFormDraftSession();
    const held = new Map();
    const locks = { request: async (name, _options, operation) => {
      while (held.has(name)) await held.get(name);
      let release;
      held.set(name, new Promise((resolve) => { release = resolve; }));
      try { return await operation(); } finally { held.delete(name); release(); }
    } };
    Object.defineProperty(window.navigator, "locks", { value: locks, configurable: true });
    try {
      const db = database("A");
      const store = createMemoryStore();
      await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, step: 0, baseRevision: 1 } } });
      editor(db, store);
      fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
      const network = deferred();
      db.offlineAfter = network.promise;
      type("C");
      next();
      await waitFor(() => expect(db.sent).toHaveLength(1));
      expect(lane().tail).toBeTruthy();

      const first = await replayQueue(store, "member-1", executors(db));
      expect(first).toMatchObject({ replayed: 0, failed: [], halted: false });
      expect(db.sent.map((fields) => fields.answers.summary)).toEqual(["C"]);

      network.settle();
      await waitFor(async () => expect((await store.listEntries("member-1")).map((entry) => entry.args.fields.answers)).toEqual([{ summary: "C" }]));
      await settled();

      const second = await replayQueue(store, "member-1", executors(db));
      expect(second).toMatchObject({ replayed: 1, failed: [] });
      expect(db.answers).toEqual({ summary: "C" });
      expect(await pendingCount(store, "member-1")).toBe(0);
    } finally {
      delete window.navigator.locks;
    }
  });
});

// Advisory read R-8935 (P1 on 88b4c94a): a lane the replay makes knows no
// answers. Tab B saw revision 2 and queued X on it; this tab's list is older
// (A at revision 1) and the shared outbox replays X here. Whether the editor
// opens from that row while the replay is on its way, or was already open on
// it, it shows the row's answers, never a blank form, and its next save is
// built on what it shows: it is refused against X and never overwrites it.
describe("an editor on an older row never writes over a replayed write", () => {
  const staleRow = { id: "form-1", templateKey: "grievance", status: "draft", step: 0, answers: { summary: "A" }, revision: 1, cosigners: [] };
  const queuedX = { templateKey: "grievance", formId: "form-1", answers: { summary: "X" }, step: 0, baseRevision: 2 };

  it("shows the row's answers when the editor opens during the replay, and its next save never overwrites X", async () => {
    endFormDraftSession();
    const db = database("Y", 2);
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: queuedX } });
    const reply = deferred();
    db.holdReply = reply.promise;
    const pass = replayQueue(store, "member-1", executors(db));
    await waitFor(() => expect(db.answers).toEqual({ summary: "X" }));
    editor(db, store, [staleRow]);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("A");
    reply.settle();
    expect(await pass).toMatchObject({ replayed: 1, failed: [] });
    type("A more");
    next();
    await waitFor(() => expect(db.sent.some((fields) => fields.answers.summary === "A more")).toBe(true));
    await settled();
    expect(db.answers).toEqual({ summary: "X" });
    expect(db.revision).toBe(3);
  });

  it("keeps the base an editor already open on the row loaded, so its next save never overwrites X", async () => {
    endFormDraftSession();
    const db = database("Y", 2);
    const store = createMemoryStore();
    editor(db, store, [staleRow]);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: queuedX } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    type("A more");
    next();
    await waitFor(() => expect(db.sent.some((fields) => fields.answers.summary === "A more")).toBe(true));
    await settled();
    expect(db.sent.find((fields) => fields.answers.summary === "A more").baseRevision).toBe(1);
    expect(db.answers).toEqual({ summary: "X" });
  });
});

// Delta read R-8935D (P1-b): the #8938 order where the replay finishes before
// the member types. The editor is open on the entry's own base with no lane
// yet; the replay's write is kept by the lane it made, and the editor's first
// save, which binds that lane to revision 1, applies it: C names revision 2.
// Read R-9392R2 (point 4): an editor that binds a lane the replay made while
// the replay's request is still on its way never showed the replay's write
// either: by its first save (it was already open) or by opening from a list
// read before the write. The reply then moves nothing; the editor's save
// names its own load and is refused against B, and B is kept, as on Main.
describe("an editor that binds the lane while the replay's request is on its way", () => {
  const queuedB = { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, step: 0, baseRevision: 1 };
  const replayInFlight = async (db, store, fields = queuedB) => {
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields } });
    const reply = deferred();
    db.holdReply = reply.promise;
    const pass = replayQueue(store, "member-1", executors(db));
    await waitFor(() => expect(db.answers).toEqual(fields.answers));
    return { reply, pass };
  };

  for (const typed of [false, true]) {
    it(`(a) already open, its first ${typed ? "typed" : "step-only"} save during the replay: refused, B kept`, async () => {
      endFormDraftSession();
      const db = database("A");
      const store = createMemoryStore();
      editor(db, store);
      fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
      const { reply, pass } = await replayInFlight(db, store);
      if (typed) type("C");
      next();
      await new Promise((resolve) => { setTimeout(resolve, 30); });
      reply.settle();
      expect(await pass).toMatchObject({ replayed: 1, failed: [] });
      await waitFor(() => expect(refused()).not.toBeNull());
      expect(db.sent.map((fields) => [fields.answers.summary, fields.baseRevision])).toEqual([["B", 1], [typed ? "C" : "A", 1]]);
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
    });

    it(`(b) opened during the replay from the list read before its write, then a ${typed ? "typed" : "step-only"} save: refused, B kept`, async () => {
      endFormDraftSession();
      const db = database("A");
      const store = createMemoryStore();
      const before = row(db);
      const { reply, pass } = await replayInFlight(db, store);
      editor(db, store, [before]);
      fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
      expect(screen.getByLabelText(/Issue summary/)).toHaveValue("A");
      reply.settle();
      expect(await pass).toMatchObject({ replayed: 1, failed: [] });
      if (typed) type("C");
      next();
      await waitFor(() => expect(refused()).not.toBeNull());
      expect(db.sent.at(-1)).toMatchObject({ answers: { summary: typed ? "C" : "A" }, baseRevision: 1 });
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
    });
  }

  it("(c) a blank new form opened during the replay from the empty list, typed: refused, the replay's form kept", async () => {
    endFormDraftSession();
    const db = database("", 0);
    db.answers = {};
    const store = createMemoryStore();
    const { reply, pass } = await replayInFlight(db, store, { templateKey: "grievance", answers: { summary: "B" }, step: 0, baseRevision: 0 });
    editor(db, store, []);
    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    reply.settle();
    expect(await pass).toMatchObject({ replayed: 1, failed: [] });
    type("C");
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "C" }, baseRevision: 0 });
    expect(db.sent.at(-1).formId).toBeUndefined();
    expect(db).toMatchObject({ answers: { summary: "B" }, revision: 1 });
  });

  it("(c') a blank new form already open, typed during the replay: refused, the replay's form kept", async () => {
    endFormDraftSession();
    const db = database("", 0);
    db.answers = {};
    const store = createMemoryStore();
    editor(db, store, []);
    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    const { reply, pass } = await replayInFlight(db, store, { templateKey: "grievance", answers: { summary: "B" }, step: 0, baseRevision: 0 });
    type("C");
    next();
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    reply.settle();
    expect(await pass).toMatchObject({ replayed: 1, failed: [] });
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "C" }, baseRevision: 0 });
    expect(db).toMatchObject({ answers: { summary: "B" }, revision: 1 });
  });
});

// Read R-9392R (point 4): an editor already open never builds on a replay
// write it did not show. The editor shows A; an outbox entry B, typed earlier
// in an editor closed offline, before a reload or in another tab, replays
// under it. Its save, unchanged (a step change) or typed, is built on A, so it
// is refused against B and the stored B is kept; App reads Your forms again
// and the editor shows B, as on Main. (Earlier this file expected C stored
// over B. That was wrong: the editor never showed B, so storing its save
// discarded the person's text with no message; Main refuses it.)
describe("an editor already open when a replay lands under it", () => {
  const queuedB = { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, step: 0, baseRevision: 1 };
  for (const typed of [false, true]) {
    it(`refuses its ${typed ? "typed" : "step-only"} save built on A, keeps the stored B and shows it`, async () => {
      endFormDraftSession();
      const db = database("A");
      const store = createMemoryStore();
      const view = editor(db, store);
      fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
      await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: queuedB } });
      expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
      if (typed) type("C");
      next();
      await waitFor(() => expect(refused()).not.toBeNull());
      expect(db.sent.map((fields) => [fields.answers.summary, fields.baseRevision])).toEqual([["B", 1], [typed ? "C" : "A", 1]]);
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
      // Your forms, read again, carries B: the editor shows it.
      // Your forms, read again, carries B: the editor adopts it, and its first
      // step shows it.
      view.rerender(formsView(db, store, [row(db)]));
      await waitFor(() => expect(screen.getByRole("button", { name: "Back" })).toBeTruthy());
      back();
      await waitFor(() => expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B"));
      expect(db.answers).toEqual({ summary: "B" });
    });
  }

  for (const typed of [false, true]) {
    it(`${typed ? "refuses a blank new form's typed save" : "sends nothing from a blank new form's step change"} over the new form a replay created, and keeps it`, async () => {
      endFormDraftSession();
      const db = database("", 0);
      db.answers = {};
      const store = createMemoryStore();
      editor(db, store, []);
      fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
      await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: { templateKey: "grievance", answers: { summary: "B" }, step: 0, baseRevision: 0 } } });
      expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
      if (typed) type("C");
      next();
      if (!typed) {
        // A blank new form's step change has nothing to save: nothing is sent,
        // and the replay's form stays as it wrote it.
        await settled();
        expect(db.sent).toHaveLength(1);
        expect(db).toMatchObject({ answers: { summary: "B" }, revision: 1 });
        return;
      }
      await waitFor(() => expect(refused()).not.toBeNull());
      const sent = db.sent.at(-1);
      expect(sent).toMatchObject({ answers: { summary: "C" }, baseRevision: 0 });
      expect(sent.formId).toBeUndefined();
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 1 });
    });
  }
});

// R-8935D (P1-a): the sealed (FMLA) twin. A sealed save names the data version
// of the envelope it was built on; the server refuses any other. A lane the
// replay made has loaded no version, so in both orders (the editor already
// open, or opened after the replay) the editor's save names the version that
// editor loaded: refused when that is not the replay's base, so the medical
// text the replay stored is never written over; stored when it is.
describe("a sealed form replayed under an editor that did not queue it", () => {
  const sealedServer = (reason, version) => {
    const db = { answers: { reason, condition_type: "continuous" }, dataVersion: version, writes: 0, sent: [] };
    db.save = async (fields) => {
      db.sent.push(fields);
      if ((fields.expectedDataVersion ?? null) !== db.dataVersion) {
        throw Object.assign(new Error("Sensitive content is unavailable."), { code: "SENSITIVE_DATA_UNAVAILABLE" });
      }
      db.writes += 1;
      db.answers = fields.answers;
      db.dataVersion = `w${db.writes}`;
      const result = { formId: "open-fmla", dataVersion: db.dataVersion };
      if (db.holdReply) { const gate = db.holdReply; db.holdReply = null; await gate; }
      return result;
    };
    return db;
  };
  const sealedRow = (version) => ({ id: "open-fmla", templateKey: "fmla_self", status: "draft", step: 0, sealed: true, cosigners: [],
    dataVersion: version, answers: { reason: "Original reason", condition_type: "continuous" } });
  const sealedEditor = (db, version) => render(
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms: [sealedRow(version)] }}
        focus={{ templateKey: "fmla_self", formId: "open-fmla" }} onSaveDraft={db.save}
        onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
    </LanguageProvider>,
  );
  const queueX = (store, base) => enqueueWrite(store, "member-1", { kind: "formDraft", key: "fmla_self",
    args: { fields: { templateKey: "fmla_self", formId: "open-fmla", answers: { reason: "X", condition_type: "continuous" }, step: 0, expectedDataVersion: base } } });
  const replay = (store, db) => replayQueue(store, "member-1", { formDraft: (args) => replayFormDraft({ memberId: "member-1", fields: args.fields, save: db.save }) });
  const editAndSave = async (db) => {
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Original reason, more" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.sent.some((fields) => fields.answers.reason === "Original reason, more")).toBe(true));
    return db.sent.find((fields) => fields.answers.reason === "Original reason, more");
  };

  // A new FMLA form a replay created (no form named, no data version). A
  // replay makes no lane (R-9392D), so an editor opened from the old empty list
  // opens a blank new form, and its save names no version and is refused
  // against X, which is kept and shown after the forms are read again. Main
  // makes no lane either and refuses the same save.
  it("a new FMLA form a replay created: an editor opened from the empty list saves on no version and is refused, X kept", async () => {
    endFormDraftSession();
    const db = sealedServer("", null);
    db.answers = {};
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "fmla_self",
      args: { fields: { templateKey: "fmla_self", answers: { reason: "X", condition_type: "continuous" }, step: 0, expectedDataVersion: null } } });
    expect(await replay(store, db)).toMatchObject({ replayed: 1, failed: [] });
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms: [] }} focus={{ templateKey: "fmla_self" }} onSaveDraft={db.save}
          onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
      </LanguageProvider>,
    );
    expect(screen.queryByDisplayValue("X")).toBeNull();
    const reason = screen.getAllByRole("textbox")[0];
    fireEvent.change(reason, { target: { value: "Typed on a blank form" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(db.sent.some((fields) => fields.answers.reason === "Typed on a blank form")).toBe(true));
    expect(db.sent.find((fields) => fields.answers.reason === "Typed on a blank form").expectedDataVersion ?? null).toBeNull();
    expect(db.answers.reason).toBe("X");
  });

  // R-9392R2, the sealed twin of (b): an FMLA editor opened during the replay
  // from the list read before its write, on the entry's own base v1. The reply
  // moves nothing; the save names v1 and is refused, and X is kept.
  it("opened during the replay from the list read before its write: the save names v1 and is refused, X kept", async () => {
    endFormDraftSession();
    const db = sealedServer("Original reason", "v1");
    const store = createMemoryStore();
    await queueX(store, "v1");
    const reply = deferred();
    db.holdReply = reply.promise;
    const pass = replay(store, db);
    await waitFor(() => expect(db.answers.reason).toBe("X"));
    sealedEditor(db, "v1");
    reply.settle();
    expect(await pass).toMatchObject({ replayed: 1, failed: [] });
    const sent = await editAndSave(db);
    expect(sent.expectedDataVersion).toBe("v1");
    expect(db.answers.reason).toBe("X");
  });

  for (const order of ["already open", "opened after the replay"]) {
    it(`${order}, on an older version: the save names that version and is refused, never written over X`, async () => {
      endFormDraftSession();
      const db = sealedServer("Y", "v1");
      const store = createMemoryStore();
      await queueX(store, "v1");
      if (order === "already open") sealedEditor(db, "v0");
      expect(await replay(store, db)).toMatchObject({ replayed: 1, failed: [] });
      if (order !== "already open") sealedEditor(db, "v0");
      const sent = await editAndSave(db);
      expect(sent.expectedDataVersion).toBe("v0");
      expect(db.answers.reason).toBe("X");
    });

    // The editor shows v1's text, never X, in both orders: X's entry names no
    // editor of this page (R-9392D), so nothing moves, and its save names v1
    // and is refused; X is kept. (This case expected the editor opened after
    // the replay to show X through the replay-made lane, which no longer
    // exists; Main refuses the same save.)
    it(`${order}, on the replay's own base: the save names v1 and is refused, X kept`, async () => {
      endFormDraftSession();
      const db = sealedServer("Original reason", "v1");
      const store = createMemoryStore();
      await queueX(store, "v1");
      if (order === "already open") sealedEditor(db, "v1");
      expect(await replay(store, db)).toMatchObject({ replayed: 1, failed: [] });
      if (order !== "already open") sealedEditor(db, "v1");
      const sent = await editAndSave(db);
      expect(sent.expectedDataVersion).toBe("v1");
      expect(db.answers.reason).toBe("X");
    });
  }
});

// A new form a replay created (its reply, or its lost reply). A replay makes
// no lane (R-9392D). Until Your forms is read again the list has no row for
// the form, so an editor opened from that old empty list opened a blank new
// form; its save named no form at revision 0 and was refused against B, and
// the stored B then replaced what the person had typed (a review note,
// the gate's P1 at stage 467 on #9392: the new edit is lost). The replay now
// remembers the form it wrote, and that editor opens on it: B at revision 1,
// as the list read after the replay shows it, so the next edit is stored on
// top of B. (This case expected the blank editor and the refusal.)
describe("a new form a replay created", () => {
  const noDraft = () => { const db = database("", 0); db.answers = {}; return db; };
  const newForm = { templateKey: "grievance", answers: { summary: "B" }, step: 0, baseRevision: 0 };
  const openNewForm = () => fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);

  for (const lost of [false, true]) {
    it(`leaves no lane, and an editor opened from the old empty list opens on B and stores the next edit on it${lost ? " (its reply was lost)" : ""} (ledger 653)`, async () => {
      endFormDraftSession();
      const db = noDraft();
      const store = createMemoryStore();
      // Lost reply: the write committed before the entry replays.
      if (lost) await db.save(newForm);
      await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: newForm } });
      expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 1 });
      expect(lane()).toBeUndefined();
      editor(db, store, []);
      openNewForm();
      expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
      type("C");
      next();
      await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
      expect(refused()).toBeNull();
      expect(db.sent.at(-1)).toMatchObject({ formId: "form-1", answers: { summary: "C" }, baseRevision: 1 });
      expect(db.revision).toBe(2);
    });
  }

  // Changed on another device after the replay, before the editor opens: the
  // editor shows B at revision 1, its save names revision 1 and is refused
  // against the newer write, which is kept and shown, as for any list row read
  // before another session's save (#8719).
  it("refuses the next edit, writing nothing, when another device saved the form after the replay", async () => {
    endFormDraftSession();
    const db = noDraft();
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: newForm } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    db.otherDevice("X");
    editor(db, store, []);
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    type("C");
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.at(-1)).toMatchObject({ formId: "form-1", answers: { summary: "C" }, baseRevision: 1 });
    expect(db).toMatchObject({ answers: { summary: "X" }, revision: 2 });
  });

  // Deleted on another device after the replay, before the editor opens: the
  // editor asks once whether the form still exists (#8574) and, told it does
  // not, starts a new draft with the edit instead of naming the deleted form.
  it("starts a new draft with the next edit when the form was deleted elsewhere after the replay", async () => {
    endFormDraftSession();
    const db = noDraft();
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: newForm } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    db.answers = {};
    db.revision = 0;
    const checked = [];
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms: [] }} onSaveDraft={appSave(db, store)}
          onCheckDraft={async (formId, memberId) => { checked.push([formId, memberId]); return false; }}
          onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
      </LanguageProvider>,
    );
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    type("C");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
    expect(checked).toEqual([["form-1", "member-1"]]);
    const sent = db.sent.at(-1);
    expect(sent).toMatchObject({ answers: { summary: "C" }, baseRevision: 0 });
    expect(sent.formId).toBeUndefined();
    expect(refused()).toBeNull();
  });

  // #9457 round 1 (r1s1, r2s1): the replay note must not outlive the form it
  // names. This model gives every new form its own id, so the deleted form
  // (form-old) and the draft that replaces it (form-new) differ. One open
  // draft per member and template, as save_member_form_draft keeps it.
  const separateForms = () => {
    const db = { id: null, status: null, answers: {}, revision: 0, sent: [], ids: ["form-old", "form-new"] };
    const notEditable = () => Object.assign(new Error("form no longer editable"), { code: "PT409", details: "form_not_editable" });
    db.save = async (fields) => {
      db.sent.push(fields);
      if (fields.formId) {
        if (fields.formId !== db.id || db.status !== "draft") throw notEditable();
        if (fields.baseRevision !== db.revision) throw elsewhere();
      } else {
        if (db.id && db.status === "draft") throw elsewhere();
        Object.assign(db, { id: db.ids.shift(), status: "draft", answers: {}, revision: 0 });
      }
      if (!same(fields.answers, db.answers)) db.revision += 1;
      db.answers = fields.answers;
      return { formId: db.id, revision: db.revision };
    };
    db.read = async () => ({ id: db.id, answers: db.answers, revision: db.revision, settingsScope: {}, organizationId: null });
    return db;
  };
  const replayInto = async (db) => {
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: newForm } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    expect(db).toMatchObject({ id: "form-old", answers: { summary: "B" }, revision: 1 });
    return store;
  };
  // The forms read after each save fails, so the page keeps the list read
  // before the replay: always empty here.
  const staleView = (db, store, extra = {}) => render(
    <LanguageProvider lang="en">
      <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms: [] }} onSaveDraft={appSave(db, store)} {...extra}
        onCheckDraft={async (formId) => formId === db.id && db.status !== null}
        onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
    </LanguageProvider>,
  );

  it("reopens on the replacement, not the deleted form, after the edit started a new draft and the list stayed empty", async () => {
    endFormDraftSession();
    const db = separateForms();
    const store = await replayInto(db);
    // Deleted on another device before any list named it.
    Object.assign(db, { id: null, status: null, answers: {}, revision: 0 });
    const first = staleView(db, store);
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    type("C");
    next();
    await waitFor(() => expect(db).toMatchObject({ id: "form-new", answers: { summary: "C" }, revision: 1 }));
    expect(db.sent.at(-1).formId).toBeUndefined();
    await settled();
    first.unmount();
    // The same template, opened again in the same session from the same
    // empty list: the replacement's answers, and the next edit is stored on it.
    staleView(db, store);
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("C");
    type("D");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(refused()).toBeNull();
    expect(db.sent.at(-1)).toMatchObject({ formId: "form-new", answers: { summary: "D" }, baseRevision: 1 });
    expect(db).toMatchObject({ id: "form-new", revision: 2 });
  });

  // #9457 final (r3s1): another device deleted the remembered form and already
  // made the replacement before this editor's first save. The existence check
  // finds the remembered form gone, the editor stops naming it, its unnamed
  // save is refused against the replacement, and recovery (App re-reads Your
  // forms before the refusal reaches the editor) adopts the replacement by
  // template, so the next edit is stored on it.
  it("adopts a replacement another device made before the first save, after finding the remembered form deleted", async () => {
    endFormDraftSession();
    const db = separateForms();
    const store = await replayInto(db);
    Object.assign(db, { id: "form-new", status: "draft", answers: { summary: "X" }, revision: 1, ids: [] });
    const replacementRow = () => ({ id: db.id, templateKey: "grievance", status: "draft", step: 0, answers: db.answers, revision: db.revision, cosigners: [] });
    let view;
    const page = (forms) => (
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms }} onSaveDraft={onSave}
          onCheckDraft={async (formId) => formId === db.id}
          onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
      </LanguageProvider>
    );
    // App's handleSaveDraft: a refused save re-reads Your forms, then the
    // refusal reaches the editor.
    const onSave = async (fields) => {
      try {
        return await appSave(db, store)(fields);
      } catch (error) {
        if (error?.details === "form_saved_elsewhere") view.rerender(page([replacementRow()]));
        throw error;
      }
    };
    view = render(page([]));
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    type("C");
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "C" }, baseRevision: 0 });
    expect(db.sent.at(-1).formId).toBeUndefined();
    expect(db).toMatchObject({ id: "form-new", answers: { summary: "X" }, revision: 1 });
    back();
    await waitFor(() => expect(screen.getByLabelText(/Issue summary/)).toHaveValue("X"));
    type("D");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(db.sent.at(-1)).toMatchObject({ formId: "form-new", answers: { summary: "D" }, baseRevision: 1 });
    // Close saves on the replacement and leaves the editor.
    await settled();
    fireEvent.click(screen.getAllByRole("button", { name: /Close form/ })[0]);
    await waitFor(() => expect(screen.queryByLabelText(/Issue summary/)).toBeNull());
    expect(db).toMatchObject({ id: "form-new", answers: { summary: "D" } });
    expect(db.sent.some((fields) => fields.formId === "form-old")).toBe(false);
  });

  it("offers no draft sharing for a remembered form no list has shown", async () => {
    endFormDraftSession();
    const db = separateForms();
    const store = await replayInto(db);
    const asked = [];
    const sharingApi = { sharing: async (formId) => { asked.push(formId); return []; }, share: async () => null };
    staleView(db, store, { draftSharingApi: sharingApi });
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(asked).toEqual([]);
  });

  it("never reopens a remembered form that was closed elsewhere: the next editor of the template opens blank", async () => {
    endFormDraftSession();
    const db = separateForms();
    const store = await replayInto(db);
    // Submitted on another device before any list named it.
    db.status = "submitted";
    const first = staleView(db, store);
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    type("C");
    next();
    await waitFor(() => expect(db.sent.at(-1)).toMatchObject({ formId: "form-old", answers: { summary: "C" }, baseRevision: 1 }));
    await settled();
    expect(db).toMatchObject({ id: "form-old", status: "submitted", answers: { summary: "B" } });
    first.unmount();
    staleView(db, store);
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("");
  });

  it("drops a discarded remembered form: the template opens again, blank, from the same empty list", async () => {
    endFormDraftSession();
    const db = separateForms();
    const store = await replayInto(db);
    const discard = async () => { Object.assign(db, { id: null, status: null, answers: {}, revision: 0 }); return { discarded: true }; };
    const first = staleView(db, store, { onDiscardDraft: discard });
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("B");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByLabelText(/Issue summary/)).toBeNull());
    expect(db.id).toBeNull();
    first.unmount();
    staleView(db, store, { onDiscardDraft: discard });
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("");
    type("C");
    next();
    await waitFor(() => expect(db).toMatchObject({ id: "form-new", answers: { summary: "C" } }));
    expect(db.sent.at(-1).formId).toBeUndefined();
  });

  // A list that names the form was read after the replay: it decides. Shown
  // submitted, the form is no longer remembered, so the next editor of the
  // template opens a blank new form and its save starts a new draft.
  it("opens a blank new form once a list shows the replay's form submitted", async () => {
    endFormDraftSession();
    const db = noDraft();
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: newForm } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    const view = editor(db, store, [{ ...row(db), status: "submitted" }]);
    db.answers = {};
    db.revision = 0;
    view.rerender(formsView(db, store, []));
    openNewForm();
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("");
    type("C");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
    expect(db.sent.at(-1).formId).toBeUndefined();
  });

  // A new form's editor already open never showed the replay's form, so its
  // save names no form at revision 0 and is refused; the form stays as the
  // replay wrote it (R-9392R, point 4; this case expected the editor's text
  // stored over it, which discarded B unseen; Main refuses it).
  it("is never written over by a new form's editor that was already open", async () => {
    endFormDraftSession();
    const db = noDraft();
    const store = createMemoryStore();
    editor(db, store, []);
    openNewForm();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: newForm } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    type("C");
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "C" }, baseRevision: 0 });
    expect(db).toMatchObject({ answers: { summary: "B" }, revision: 1 });
  });
});

// Entries queued by the previous website build carry no revision and no
// editor token: an existing form names its base answers, a new form {} and no
// form. They replay through save_form_draft, which answers with the form id
// only, and move no lane (R-9392D, the r1s1 ground): an editor that never
// showed B is refused at its next save and shown B. Main moves that base with
// no condition (confirmReplayedFormDraft), the silent-overwrite class, so this
// is safer than Main. The reopened editor (laneBefore) is a review note,
// now closed by the token: it too is refused. (Both cases expected C stored
// over B.)
describe("an entry queued by the previous build", () => {
  const legacyB = { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, step: 0, baseAnswers: { summary: "A" } };
  for (const laneBefore of [false, true]) {
    it(`of an existing form, replayed while the editor is open${laneBefore ? " on a lane an earlier editor made" : ""}: the next save, built on A, is refused and B is kept`, async () => {
      endFormDraftSession();
      const db = database("A");
      const store = createMemoryStore();
      if (laneBefore) {
        const earlier = editor(db, store);
        fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
        next();
        await waitFor(() => expect(db.sent).toHaveLength(1));
        await settled();
        earlier.unmount();
      }
      editor(db, store);
      fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
      await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: legacyB } });
      expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
      type("C");
      next();
      await waitFor(() => expect(refused()).not.toBeNull());
      expect(db.sent.find((fields) => fields.answers.summary === "C").baseRevision).toBe(1);
      expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
    });
  }

  it("of a new form: an editor opened from the old empty list is refused, and B is kept", async () => {
    endFormDraftSession();
    const db = database("", 0);
    db.answers = {};
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: { templateKey: "grievance", answers: { summary: "B" }, step: 0, baseAnswers: {} } } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    editor(db, store, []);
    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("");
    type("C");
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.answers).toEqual({ summary: "B" });
  });
});

// #9392 round 1 (r2s2): a lost reply is recognised only from the draft the
// entry was for. A unit-A new form refused as saved elsewhere, with a unit-B
// draft of the same answers stored, stays a refusal: it is reported, not
// counted as written.
describe("a unit entry's lost reply", () => {
  it("is not confirmed by another unit's draft with the same answers", async () => {
    endFormDraftSession();
    const db = database("B", 1);
    db.scope = { chapterId: "chapter-1", unitId: "unit-b", unitName: "Unit B" };
    const store = createMemoryStore();
    const unitA = { templateKey: "grievance", answers: { summary: "B" }, step: 0, baseRevision: 0, unitId: "unit-a", actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1" };
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: unitA } });
    const pass = await replayQueue(store, "member-1", executors(db));
    expect(pass.replayed).toBe(0);
    expect(pass.failed).toEqual([expect.objectContaining({ kind: "formDraft", message: expect.stringMatching(/form changed elsewhere/) })]);
    // Of its own unit, the same lost reply counts as written.
    db.scope = { chapterId: "chapter-1", unitId: "unit-a", unitName: "Unit A" };
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: unitA } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
  });
});

// #9403 round 1 (r2s1): record 8935 line 1 for a unit form. The editor saves
// with its unit (FormsView adds unitId, actorId, chapterId and organizationId
// to a unit save); the save commits and its reply is lost. The stored row has
// organization_id null, as the database leaves it on a unit save, and the
// stamp of its own unit and chapter: the replay recognises its own write, the
// entry goes without an error, and the next edit is stored.
describe("a unit form's lost reply", () => {
  const unitFields = { unitId: "unit-a", actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1" };
  it("is recognised from its own unit's draft with organization_id null, and the next edit is stored", async () => {
    endFormDraftSession();
    const db = database("A");
    db.scope = { chapterId: "chapter-1", unitId: "unit-a", unitName: "Unit A" };
    const store = createMemoryStore();
    const save = appSave(db, store);
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "member-1", initials: "MV" }, forms: [row(db)] }} onSaveDraft={(fields) => save({ ...fields, ...unitFields })}
          onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    db.loseReply = true;
    type("B");
    next();
    await waitFor(async () => expect(await pendingCount(store, "member-1")).toBe(1));
    await settled();
    expect(db.answers).toEqual({ summary: "B" });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    expect(lane().confirmed).toMatchObject({ answers: { summary: "B" }, revision: 2 });
    back();
    type("C");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
    expect(refused()).toBeNull();
  });
});

describe("#8939: a late replay confirmation never rewinds a newer one", () => {
  it("keeps C, confirmed while the replay's reply was on its way, so the next save names C and is stored", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    // Earlier in this session the editor saved form-1 (a step change), so the
    // lane for it exists and holds A.
    const first = editor(db, store);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    next();
    await waitFor(() => expect(db.sent).toHaveLength(1));
    await settled();
    first.unmount();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, step: 0, baseRevision: 1, baseAnswers: { summary: "A" } } } });
    const reply = deferred();
    db.holdReply = reply.promise;
    const pass = replayQueue(store, "member-1", executors(db));
    await waitFor(() => expect(db.answers).toEqual({ summary: "B" }));
    // Another device saves C over B; this tab's refreshed list shows it and
    // the member opens it, which confirms C in the lane.
    db.otherDevice("C");
    editor(db, store, [row(db)]);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("C");
    // The replay's late reply (B) arrives.
    reply.settle();
    await pass;
    type("D");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "D" }));
    expect(refused()).toBeNull();
  });
});

// R-9392D: the one invariant on the real lane and outbox. A replay moves a lane
// only for the editor that queued the entry (its token), while that editor is
// the only one mounted on the lane and made its last save, at exactly the
// entry's base. Every other editor is refused at its next save, and the stored
// answers are kept, as on Main or safer. These pin the token's lifetime.
describe("the editor token on the real lane and outbox", () => {
  const queuedB = { templateKey: "grievance", formId: "form-1", answers: { summary: "B" }, step: 0, baseRevision: 1 };
  // The member's own offline save of B from the open editor: it is queued with
  // that editor's token.
  const typeBOffline = async (db, store) => {
    db.offlineAfter = Promise.resolve();
    type("B");
    next();
    await waitFor(async () => expect((await store.listEntries("member-1")).map((entry) => entry.args.fields.answers)).toEqual([{ summary: "B" }]));
    await settled();
  };

  it("queues the editor's token as a plain string that survives the outbox's structured clone, and the clone moves its lane", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    editor(db, store);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await typeBOffline(db, store);
    const [entry] = await store.listEntries("member-1");
    expect(typeof entry.args.fields.editorToken).toBe("string");
    expect(entry.args.fields.editorToken).toBe(lane().editorToken);
    const cloned = structuredClone(entry.args);
    await replayFormDraft({ memberId: "member-1", fields: cloned.fields, save: db.save, readStored: db.read });
    expect(lane().confirmed).toMatchObject({ answers: { summary: "B" }, revision: 2 });
  });

  it("moves the queuing editor's lane under StrictMode, whose second effect run keeps its token registered", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    render(<StrictMode>{formsView(db, store, [row(db)])}</StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await typeBOffline(db, store);
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    back();
    type("C");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
    expect(db.sent.find((fields) => fields.answers.summary === "C").baseRevision).toBe(2);
    expect(refused()).toBeNull();
  });

  it("moves nothing while a second tree has an editor of the form mounted, so the queuing editor's next save is refused and B kept", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    const first = editor(db, store);
    const second = render(formsView(db, store, [row(db)]));
    fireEvent.click(within(first.container).getByRole("button", { name: "Resume draft" }));
    // The second tree mirrors the first (device parity): its editor opens too.
    await waitFor(() => expect(within(second.container).getByLabelText(/Issue summary/)).toBeTruthy());
    db.offlineAfter = Promise.resolve();
    fireEvent.change(within(first.container).getByLabelText(/Issue summary/), { target: { value: "B" } });
    fireEvent.click(within(first.container).getByRole("button", { name: "Next" }));
    await waitFor(async () => expect(await pendingCount(store, "member-1")).toBe(1));
    await settled();
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    expect(lane().confirmed).toMatchObject({ revision: 1 });
    fireEvent.click(within(first.container).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(within(first.container).queryByText(/changed somewhere else/)).not.toBeNull());
    expect(db.answers).toEqual({ summary: "B" });
  });

  it("moves nothing for a closed editor's entry: the next editor, opened from the old list, is refused and B kept", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    const closing = editor(db, store);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await typeBOffline(db, store);
    // Still offline as the editor closes: its unsaved B is queued again (the
    // same entry, its own token), not stored.
    db.offlineAfter = Promise.resolve();
    closing.unmount();
    await settled();
    editor(db, store, [{ ...row(db) }]);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await settled();
    expect(db.answers).toEqual({ summary: "A" });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    expect(lane().confirmed).toMatchObject({ revision: 1 });
    type("C");
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.find((fields) => fields.answers.summary === "C").baseRevision).toBe(1);
    expect(db.answers).toEqual({ summary: "B" });
  });

  // A lane an earlier editor of this
  // tab loaded, an editor reopened on it, and an entry from another page (a
  // reload) or no editor at all: nothing moves, the reopened editor is refused.
  for (const token of [undefined, "an-earlier-page:3"]) {
    it(`refuses an editor reopened on a lane an earlier editor loaded, for an entry ${token ? "from an earlier page" : "naming no editor"}`, async () => {
      endFormDraftSession();
      const db = database("A");
      const store = createMemoryStore();
      const earlier = editor(db, store);
      fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
      next();
      await waitFor(() => expect(db.sent).toHaveLength(1));
      await settled();
      earlier.unmount();
      editor(db, store);
      fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
      await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: { ...queuedB, ...(token ? { editorToken: token } : {}) } } });
      expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
      next();
      await waitFor(() => expect(refused()).not.toBeNull());
      expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "A" }, baseRevision: 1 });
      expect(db.answers).toEqual({ summary: "B" });
    });
  }

  // The final on #9392 (r4s1): the first attempt fails offline (the entry is
  // kept) while an editor opens on A; the retry writes B and moves nothing, so
  // that editor's step-only save is refused and B kept.
  it("moves nothing on a retry after a failed attempt during which an editor opened", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: queuedB } });
    const network = deferred();
    db.offlineAfter = network.promise;
    const first = replayQueue(store, "member-1", executors(db));
    await waitFor(() => expect(db.sent).toHaveLength(1));
    editor(db, store);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    network.settle();
    expect(await first).toMatchObject({ replayed: 0, halted: true });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "A" }, baseRevision: 1 });
    expect(db.answers).toEqual({ summary: "B" });
  });

  // The final on #9392 (r3s1): a replay of a unit-A new form makes no lane, so
  // an editor opened afterwards (another unit, the old empty list) inherits no
  // unit-A answers: it opens blank and its save is refused.
  it("makes no lane for another unit's editor to inherit after a unit's new form replays", async () => {
    endFormDraftSession();
    const db = database("", 0);
    db.answers = {};
    db.scope = { chapterId: "chapter-1", unitId: "unit-a", unitName: "Unit A" };
    const store = createMemoryStore();
    const unitA = { templateKey: "grievance", answers: { summary: "Unit A's answers" }, step: 0, baseRevision: 0, unitId: "unit-a", actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1" };
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: unitA } });
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    expect(lane()).toBeUndefined();
    editor(db, store, []);
    fireEvent.click(screen.getAllByRole("button", { name: /Workplace issue report/ })[0]);
    expect(screen.getByLabelText(/Issue summary/)).toHaveValue("");
    type("Unit B's answers");
    next();
    await waitFor(() => expect(refused()).not.toBeNull());
    expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "Unit B's answers" }, baseRevision: 0 });
    expect(db.answers).toEqual({ summary: "Unit A's answers" });
  });

  // A member change (or the next sign-in as the same member) ends the draft
  // session: its lanes go, so an entry its editor queued moves nothing.
  it("moves nothing after a member change ends the session the queuing editor belonged to", async () => {
    endFormDraftSession();
    const db = database("A");
    const store = createMemoryStore();
    editor(db, store);
    fireEvent.click(screen.getByRole("button", { name: "Resume draft" }));
    await typeBOffline(db, store);
    endFormDraftSession();
    expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
    expect(lane()).toBeUndefined();
    expect(db.answers).toEqual({ summary: "B" });
  });
});

// #9403 final (r4s1) and THE CLASS from what the client sends. Each row drives
// FormsView's real argument builder: the legacy workflow passes the editor's
// save through as it is (FormsView.jsx line 620, no unit fields); the unit
// workflow wraps it with the form's pinned unit or the chosen one, the actor,
// chapter and organization (the same line). The database model stamps
// settings_scope as the trigger does. A committed save whose reply was lost is
// queued with the fields the editor really built, replayed, and must be
// recognised: the entry goes without an error and the next edit is stored.
describe("a lost reply through the editor's real save arguments, on every save path", () => {
  const member = { id: "member-1", initials: "MV", chapterId: "chapter-1", organizationId: "org-1" };
  const legacyApi = () => ({ load: async () => ({ legacy: true }) });
  const unitApi = (unitId) => ({ load: async () => ({ actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1",
    units: [{ id: "unit-a", name: "Unit A" }, { id: "unit-b", name: "Unit B" }], unitCount: 2, unitId, needsChoice: !unitId,
    effective: { forms: ["grievance"], templates: [], capabilities: {}, configuration: null } }) });
  // A list row as memberApi maps it (unitPinned when the stamp names a chapter).
  const listRow = (db) => ({ ...row(db), unitId: db.scope.unitId ?? null, unitName: db.scope.unitName ?? null, unitPinned: Boolean(db.scope.chapterId) });
  const lostReplyThroughEditor = async ({ api, released, stamp = {}, existing = true, releasedAtReplay = released, soleUnit = null }) => {
    endFormDraftSession();
    const db = existing ? database("A") : Object.assign(database("", 0), { answers: {} });
    db.units = { released, soleUnit };
    db.scope = stamp;
    const store = createMemoryStore();
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member, forms: existing ? [listRow(db)] : [] }} unitSettingsApi={api} onSaveDraft={appSave(db, store)}
          onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
      </LanguageProvider>,
    );
    if (existing) fireEvent.click(await screen.findByRole("button", { name: "Resume draft" }));
    else fireEvent.click((await screen.findAllByRole("button", { name: /Workplace issue report/ }))[0]);
    db.loseReply = true;
    type("B");
    next();
    await waitFor(async () => expect(await pendingCount(store, "member-1")).toBe(1));
    await settled();
    expect(db.answers).toEqual({ summary: "B" });
    const [entry] = await store.listEntries("member-1");
    db.units.released = releasedAtReplay;
    const pass = await replayQueue(store, "member-1", executors(db));
    return { db, entry: entry.args.fields, pass };
  };
  const nextEditIsStored = async (db) => {
    back();
    type("C");
    next();
    await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
    expect(refused()).toBeNull();
  };

  it("legacy workflow, settings held, an unstamped form: recognised", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: legacyApi(), released: false });
    expect(entry.unitId).toBeUndefined();
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
    await nextEditIsStored(db);
  });

  // r4s1 exactly as the pass wrote it: form-1 carries {chapter-1, unit-a},
  // settings are held, the legacy workflow saves B at revision 1 and the reply
  // is lost; the server keeps the stamp. The entry names form-1 and no unit.
  it("legacy workflow, settings held, a form already stamped with a unit (r4s1): recognised against its kept stamp", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: legacyApi(), released: false, stamp: { chapterId: "chapter-1", unitId: "unit-a", unitName: "Unit A" } });
    expect(entry).toMatchObject({ formId: "form-1", baseRevision: 1 });
    expect(entry.unitId).toBeUndefined();
    expect(db.scope).toMatchObject({ unitId: "unit-a" });
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
    await nextEditIsStored(db);
  });

  it("legacy workflow, settings held, a new form with no id: recognised (no stamp)", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: legacyApi(), released: false, existing: false });
    expect(entry.formId).toBeUndefined();
    expect(entry.unitId).toBeUndefined();
    expect(db.scope).toEqual({});
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
  });

  it("unit workflow, settings released, a form pinned to its unit: the entry carries that unit and is recognised", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: unitApi("unit-a"), released: true, stamp: { chapterId: "chapter-1", unitId: "unit-a", unitName: "Unit A" } });
    expect(entry).toMatchObject({ unitId: "unit-a", actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1" });
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
    await nextEditIsStored(db);
  });

  it("unit workflow, settings released, an unstamped form: the save stamps the chosen unit and is recognised", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: unitApi("unit-a"), released: true });
    expect(entry).toMatchObject({ unitId: "unit-a", chapterId: "chapter-1" });
    expect(db.scope).toMatchObject({ chapterId: "chapter-1", unitId: "unit-a" });
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
    await nextEditIsStored(db);
  });

  it("unit workflow, settings released, a new form with no id: stamped with the chosen unit and recognised", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: unitApi("unit-a"), released: true, existing: false });
    expect(entry).toMatchObject({ unitId: "unit-a", chapterId: "chapter-1" });
    expect(entry.formId).toBeUndefined();
    expect(db.scope).toMatchObject({ unitId: "unit-a" });
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
  });

  // Settings held after a unit-workflow save whose reply was lost: the replay
  // is a unit save, and save_unit_member_form_draft refuses it (42501, unit
  // membership changed: resolve_settings_unit refuses a named unit while held,
  // 20261113124000 lines 216 to 219) before any revision is compared, so it
  // never reaches the lost-reply read. The entry is reported, nothing is
  // recovered, the committed B stays stored, the lane is unchanged, and the
  // editor's next unit save is refused the same way. Equal on Main.
  // (This case expected a recovery the database cannot produce:
  // #9408.)
  it("settings held between the queueing and the replay, unit workflow: the unit save is refused and reported, B kept (ledger 672)", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: unitApi("unit-a"), released: true, releasedAtReplay: false });
    expect(entry).toMatchObject({ unitId: "unit-a", chapterId: "chapter-1" });
    expect(db.scope).toMatchObject({ unitId: "unit-a" });
    expect(pass.replayed).toBe(0);
    expect(pass.failed).toEqual([expect.objectContaining({ kind: "formDraft", message: expect.stringMatching(/unit membership changed/) })]);
    expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
    expect(lane().confirmed).toMatchObject({ revision: 1 });
    // The editor's next save (the step back, still a unit save naming unit-a
    // on revision 1) is refused the same way, and nothing is written.
    const sent = db.sent.length;
    back();
    await waitFor(() => expect(db.sent.length).toBeGreaterThan(sent));
    await settled();
    expect(db.sent.slice(sent)).toEqual([expect.objectContaining({ answers: { summary: "B" }, unitId: "unit-a", baseRevision: 1 })]);
    expect(db).toMatchObject({ answers: { summary: "B" }, revision: 2 });
  });

  it("settings released between the queueing and the replay, legacy workflow on a stamped form: recognised", async () => {
    const { db, pass } = await lostReplyThroughEditor({ api: legacyApi(), released: false, releasedAtReplay: true, stamp: { chapterId: "chapter-1", unitId: "unit-a", unitName: "Unit A" } });
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
    await nextEditIsStored(db);
  });

  it("settings released between the queueing and the replay, legacy workflow on a new form: recognised (its save stamped nothing)", async () => {
    const { db, pass } = await lostReplyThroughEditor({ api: legacyApi(), released: false, releasedAtReplay: true, existing: false });
    expect(db.scope).toEqual({});
    expect(pass).toMatchObject({ replayed: 1, failed: [] });
  });

  // A page left on the
  // chapter workflow across the per-unit release (useUnitWorkflow loads its
  // context once per mount), a NEW form, a member in exactly one unit. The
  // server, released by the time of the save, stamps that sole unit; the entry
  // names no form and no unit, so the strict rule does not recognise it: the
  // entry is reported as refused and Your forms is read again. Recognising it
  // would reopen #9392 r2s2 (an unnamed entry confirmed by another unit's
  // same-answers draft). Main recognises no lost reply at all.
  it("does not recognise a new form's lost reply from a page left on the chapter workflow across the release, for a member in one unit (ledger 671)", async () => {
    const { db, entry, pass } = await lostReplyThroughEditor({ api: legacyApi(), released: true, existing: false, soleUnit: "unit-a" });
    expect(entry.formId).toBeUndefined();
    expect(entry.unitId).toBeUndefined();
    expect(db.scope).toMatchObject({ chapterId: "chapter-1", unitId: "unit-a" });
    expect(pass.replayed).toBe(0);
    expect(pass.failed).toEqual([expect.objectContaining({ kind: "formDraft", message: expect.stringMatching(/form changed elsewhere/) })]);
    expect(db.answers).toEqual({ summary: "B" });
  });

  // r2s2 of #9392 stays closed on the client's own arguments: a legacy entry
  // that names no form is never confirmed by a draft another unit stamped.
  it("never recognises a legacy new form's entry from a draft stamped with a unit", async () => {
    const { pass } = await lostReplyThroughEditor({ api: legacyApi(), released: false, existing: false });
    expect(pass).toMatchObject({ replayed: 1 });
    const store = createMemoryStore();
    const db = Object.assign(database("B", 1), { scope: { chapterId: "chapter-1", unitId: "unit-b", unitName: "Unit B" } });
    await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: { templateKey: "grievance", answers: { summary: "B" }, step: 0, baseRevision: 0 } } });
    const refusedPass = await replayQueue(store, "member-1", executors(db));
    expect(refusedPass.replayed).toBe(0);
    expect(refusedPass.failed).toEqual([expect.objectContaining({ kind: "formDraft" })]);
  });

  // a review note in the unit workflow: the new form a unit entry wrote
  // opens only in an editor that saves where it was saved (the same unit,
  // chapter and organization). Another unit's editor, or a page on the
  // chapter workflow, still opens a blank form and inherits none of its
  // answers (the final on #9392, r3s1); that save is refused as on Main.
  describe("a unit's new form a replay wrote, opened from the old empty list (ledger 653)", () => {
    const unitNewForm = { templateKey: "grievance", answers: { summary: "Unit A's answers" }, step: 0, baseRevision: 0,
      unitId: "unit-a", actorId: "member-1", chapterId: "chapter-1", organizationId: "org-1" };
    const replayThenOpen = async (api) => {
      endFormDraftSession();
      const db = Object.assign(database("", 0), { answers: {} });
      const store = createMemoryStore();
      await enqueueWrite(store, "member-1", { kind: "formDraft", key: "grievance", args: { fields: unitNewForm } });
      expect(await replayQueue(store, "member-1", executors(db))).toMatchObject({ replayed: 1, failed: [] });
      expect(lane()).toBeUndefined();
      render(
        <LanguageProvider lang="en">
          <FormsView data={{ member, forms: [] }} unitSettingsApi={api} onSaveDraft={appSave(db, store)}
            onSubmit={() => {}} onInviteCosigner={() => {}} onRespondCosign={() => {}} onWithdrawCosign={() => {}} />
        </LanguageProvider>,
      );
      fireEvent.click((await screen.findAllByRole("button", { name: /Workplace issue report/ }))[0]);
      return db;
    };

    it("opens on the form in the same unit and stores the next edit on it, as a unit save of that unit", async () => {
      const db = await replayThenOpen(unitApi("unit-a"));
      expect(screen.getByLabelText(/Issue summary/)).toHaveValue("Unit A's answers");
      type("C");
      next();
      await waitFor(() => expect(db.answers).toEqual({ summary: "C" }));
      expect(refused()).toBeNull();
      expect(db.sent.at(-1)).toMatchObject({ formId: "form-1", baseRevision: 1, unitId: "unit-a", chapterId: "chapter-1", organizationId: "org-1" });
    });

    for (const [name, api] of [["another unit", () => unitApi("unit-b")], ["the chapter workflow", legacyApi]]) {
      it(`opens a blank form in ${name}, showing none of the unit's answers`, async () => {
        const db = await replayThenOpen(api());
        expect(screen.getByLabelText(/Issue summary/)).toHaveValue("");
        type("Other answers");
        next();
        await waitFor(() => expect(refused()).not.toBeNull());
        expect(db.sent.at(-1)).toMatchObject({ answers: { summary: "Other answers" }, baseRevision: 0 });
        expect(db.sent.at(-1).formId).toBeUndefined();
        expect(db.answers).toEqual({ summary: "Unit A's answers" });
      });
    }
  });
});
