// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_QUEUE_PER_USER,
  createIdbStore,
  createMemoryStore,
  enqueueWrite,
  holdQueuedEntryWhile,
  pendingCount,
  replayQueue,
} from "../src/lib/outbox.js";

// REQ-UG-FORMS-DISCARD-DRAFT-AND-TEMPLATE-SIGNATURE-20261111, #8966
// final 3: the discard fence never lets a replay send under a session that
// ended while the fence was read (r7s1/r8s1), and never takes a queue slot
// (r7s2/r8s2).

const USER_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const key = `${USER_A}|formDraft|grievance`;
const formSave = (summary) => ({ kind: "formDraft", key: "grievance", startedAt: Date.now(),
  args: { fields: { templateKey: "grievance", answers: { summary }, step: 0 } } });
const confirmDiscard = (store) => holdQueuedEntryWhile(store, key, async () => ({ formId: "grv-D", discarded: true }),
  { fence: { userId: USER_A, templateKey: "grievance" } });

describe("an account switch while a replay reads the discard fence", () => {
  it("halts before sending the queued answers, and keeps them for their owner", async () => {
    const store = createMemoryStore();
    expect(await enqueueWrite(store, USER_A, formSave("Member A's own words"))).toBe(true);
    let acting = true;
    const getEntry = store.getEntry;
    // The second read for this entry is the fence lookup; another tab signs
    // in as someone else while it is pending.
    const switching = { ...store, getEntry: async (k) => {
      const found = await getEntry(k);
      if (k.includes("formDraftDiscarded")) acting = false;
      return found;
    } };
    const executor = vi.fn().mockResolvedValue("grv-new");
    const result = await replayQueue(switching, USER_A, { formDraft: executor }, { stillActing: () => acting });
    expect(executor).not.toHaveBeenCalled();
    expect(result.halted).toBe(true);
    expect((await store.getEntry(key))?.args.fields.answers.summary).toBe("Member A's own words");
  });
});

describe("discard fences and the queue cap", () => {
  it.each([
    ["the memory store", () => createMemoryStore()],
    ["the IndexedDB store", () => createIdbStore(new IDBFactory())],
  ])("leave every slot to real writes in %s", async (_case, makeStore) => {
    const store = makeStore();
    await confirmDiscard(store);
    for (let index = 0; index < MAX_QUEUE_PER_USER; index += 1) {
      expect(await enqueueWrite(store, USER_A, { kind: "rsvp", key: `event-${index}`, args: { eventId: `event-${index}`, status: "going" } })).toBe(true);
    }
    expect(await pendingCount(store, USER_A)).toBe(MAX_QUEUE_PER_USER);
    expect(await enqueueWrite(store, USER_A, { kind: "rsvp", key: "one-too-many", args: { eventId: "x", status: "going" } })).toBe(false);
    // The fence is still there and still voids a lost-reply save begun before it.
    expect(await enqueueWrite(store, USER_A, { ...formSave("Old"), startedAt: Date.now() - 60000 })).toBe(false);
  });
});

describe("a replayed save that stops because the signed-in member changed", () => {
  it("keeps the entry for its owner and halts the pass", async () => {
    const store = createMemoryStore();
    expect(await enqueueWrite(store, USER_A, formSave("Member A's own words"))).toBe(true);
    const changed = Object.assign(new Error("Form: You were signed out or switched accounts, so this form was not saved."), { code: "SESSION_CHANGED" });
    const executor = vi.fn().mockRejectedValue(changed);
    const result = await replayQueue(store, USER_A, { formDraft: executor });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(result.halted).toBe(true);
    expect(result.failed).toEqual([]);
    expect((await store.getEntry(key))?.args.fields.answers.summary).toBe("Member A's own words");
  });
});
