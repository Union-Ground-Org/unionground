// @vitest-environment node
import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ENTRY_AGE_MS,
  MAX_QUEUE_PER_USER,
  createIdbStore,
  createMemoryStore,
  createOutboxStore,
  deleteSnapshot,
  enqueueWrite,
  forgetDepartedMemberDevice,
  isDepartedSessionResidue,
  isOfflineError,
  isRequestTimeoutError,
  pendingCount,
  purgeSensitiveEntries,
  replayQueue,
  sessionStamp,
  SENSITIVE_OUTBOX_KINDS,
} from "../src/lib/outbox.js";
import { MemberApiError } from "../src/lib/memberApi.js";

const USER_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const USER_B = "22222222-bbbb-4bbb-8bbb-222222222222";

// The app no longer writes or reads saved copies
// (BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111).
// Rows an older build left behind still have to be erased by the purges, so
// these tests plant such a row directly, stamped like the old writer did.
async function plantSnapshot(store, userId, data, savedAt = Date.now(), stamp = sessionStamp()) {
  await store.putSnapshot({ userId, savedAt, data, ...stamp });
}
async function readSnapshot(store, userId) {
  const snapshot = await store.getSnapshot(userId);
  return snapshot && snapshot.data ? snapshot : null;
}

describe("isOfflineError", () => {
  it("classifies the fetch layer's network vocabulary as offline", () => {
    for (const message of [
      "Failed to fetch",
      "TypeError: Failed to fetch",
      "fetch failed",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "Save rights progress: TypeError: fetch failed",
    ]) {
      expect(isOfflineError(new Error(message), { onLine: true })).toBe(true);
    }
  });

  it("classifies a finite request deadline as offline without message sniffing", () => {
    const error = new Error("Request timed out");
    error.name = "TimeoutError";
    expect(isOfflineError(error, { onLine: true })).toBe(true);
  });

  it("classifies the request deadline after supabase-js and MemberApiError wrap it", () => {
    const error = new MemberApiError("Profile", {
      message: "TimeoutError: Request timed out",
    });
    expect(error.name).toBe("MemberApiError");
    expect(isRequestTimeoutError(error)).toBe(true);
    expect(isOfflineError(error, { onLine: true })).toBe(true);
  });

  it("treats server rejections as NOT offline — they must surface, not queue", () => {
    for (const message of [
      "Submit ballot: new row violates row-level security policy",
      "invalid rsvp status",
      "Update settings: permission denied",
      "authentication required",
    ]) {
      expect(isOfflineError(new Error(message), { onLine: true })).toBe(false);
    }
  });

  it("trusts navigator.onLine === false regardless of the message", () => {
    expect(isOfflineError(new Error("permission denied"), { onLine: false })).toBe(true);
    expect(isOfflineError(null, { onLine: false })).toBe(true);
  });
});

describe("IndexedDB outbox failures", () => {
  it("selects the IndexedDB-backed runtime store when IndexedDB is available", () => {
    expect(createOutboxStore()).toMatchObject({ kind: "idb" });
  });

  it("propagates a failed IndexedDB request instead of treating it as a write", async () => {
    let putRequest;
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => ({
        objectStore: () => ({
          put: () => {
            putRequest = {};
            queueMicrotask(() => {
              putRequest.error = new Error("IndexedDB put failed");
              putRequest.onerror();
            });
            return putRequest;
          },
        }),
      }),
    };
    const idb = {
      open: () => {
        const request = {};
        queueMicrotask(() => {
          request.result = db;
          request.onsuccess();
        });
        return request;
      },
    };

    await expect(createIdbStore(idb).putEntry({ k: "failed" })).rejects.toThrow("IndexedDB put failed");
  });

  it("returns no store without IndexedDB, and retries a failed or blocked open on the next call", async () => {
    expect(createIdbStore(null)).toBeNull();
    const outcomes = ["error", "blocked"];
    const idb = {
      open: () => {
        const request = {};
        const outcome = outcomes.shift();
        queueMicrotask(() => {
          if (outcome === "error") request.onerror();
          else if (outcome === "blocked") request.onblocked();
          else { request.result = new IDBFactory(); request.onsuccess(); }
        });
        return request;
      },
    };
    const store = createIdbStore(idb);
    await expect(store.listAllEntries()).rejects.toThrow("IndexedDB open failed");
    await expect(store.listAllEntries()).rejects.toThrow("IndexedDB open blocked");
  });

  it("propagates a failed conditional queue read, a refused put and a failed queue listing", async () => {
    const failing = (error) => {
      const request = {};
      queueMicrotask(() => { request.error = error; request.onerror(); });
      return request;
    };
    const objectStore = {
      getAll: () => failing(undefined),
      openCursor: () => failing(new Error("cursor failed")),
    };
    const db = { transaction: () => ({ objectStore: () => objectStore }) };
    const idb = {
      open: () => {
        const request = {};
        queueMicrotask(() => { request.result = db; request.onsuccess(); });
        return request;
      },
    };
    const store = createIdbStore(idb);
    await expect(store.putEntryIf({ k: "a", userId: USER_A }, () => true)).rejects.toThrow("IndexedDB request failed");
    await expect(store.listEntries(USER_A)).rejects.toThrow("IndexedDB request failed");
    await expect(store.deleteEntryIf("a", () => true)).rejects.toThrow("cursor failed");

    objectStore.getAll = () => {
      const request = {};
      queueMicrotask(() => { request.result = []; request.onsuccess(); });
      return request;
    };
    objectStore.put = () => failing(undefined);
    await expect(store.putEntryIf({ k: "a", userId: USER_A }, () => true)).rejects.toThrow("IndexedDB request failed");
    await expect(store.putEntryIf({ k: "a", userId: USER_A }, () => { throw new Error("allows threw"); }))
      .rejects.toThrow("allows threw");
  });
});

describe("shared IndexedDB queue capacity", () => {
  it("enforces the limit across independent connections to the same database", async () => {
    const database = new IDBFactory();
    const stores = [createIdbStore(database), createIdbStore(database)];
    const accepted = await Promise.all(Array.from({ length: MAX_QUEUE_PER_USER + 3 }, (_, index) => (
      enqueueWrite(stores[index % 2], USER_A, { kind: "rsvp", key: `evt-${index}`, args: {} }, 1000)
    )));
    expect(accepted.filter(Boolean)).toHaveLength(MAX_QUEUE_PER_USER);
    expect(await pendingCount(stores[0], USER_A)).toBe(MAX_QUEUE_PER_USER);
    expect(await pendingCount(stores[1], USER_A)).toBe(MAX_QUEUE_PER_USER);
  });
});

describe("shared IndexedDB queue capacity", () => {
  it("enforces the limit across independent connections to the same database", async () => {
    const database = new IDBFactory();
    const stores = [createIdbStore(database), createIdbStore(database)];
    const accepted = await Promise.all(Array.from({ length: MAX_QUEUE_PER_USER + 3 }, (_, index) => (
      enqueueWrite(stores[index % 2], USER_A, { kind: "rsvp", key: `evt-${index}`, args: {} }, 1000)
    )));
    expect(accepted.filter(Boolean)).toHaveLength(MAX_QUEUE_PER_USER);
    expect(await pendingCount(stores[0], USER_A)).toBe(MAX_QUEUE_PER_USER);
    expect(await pendingCount(stores[1], USER_A)).toBe(MAX_QUEUE_PER_USER);
  });
});

describe("device boot stamp", () => {
  it("falls back to a non-empty string when randomUUID returns a truthy non-string", async () => {
    const randomUuid = vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue({ invalid: true });
    vi.resetModules();
    try {
      const freshOutbox = await import("../src/lib/outbox.js");
      expect(freshOutbox.sessionStamp().deviceBoot).toEqual(expect.any(String));
      expect(freshOutbox.sessionStamp().deviceBoot).not.toBe("");
    } finally {
      randomUuid.mockRestore();
      vi.resetModules();
    }
  });
});

// The IndexedDB adapter and the in-memory fallback must be interchangeable, so
// the whole behavioral suite runs against both.
for (const [name, makeStore] of [
  ["memory store", () => createMemoryStore()],
  ["indexeddb store", () => createIdbStore(new IDBFactory())],
]) {
  describe(`outbox over ${name}`, () => {
    it("coalesces repeat writes to the same key and keeps users separate", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { eventId: "evt-1", status: "going" } }, 1000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { eventId: "evt-1", status: "not_going" } }, 2000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-2", args: { eventId: "evt-2", status: "going" } }, 3000);
      await enqueueWrite(store, USER_B, { kind: "rsvp", key: "evt-1", args: { eventId: "evt-1", status: "going" } }, 4000);

      expect(await pendingCount(store, USER_A)).toBe(2);
      expect(await pendingCount(store, USER_B)).toBe(1);
      const entries = await store.listEntries(USER_A);
      const coalesced = entries.find((entry) => entry.k.endsWith("evt-1"));
      expect(coalesced.args.status).toBe("not_going");
      expect(coalesced.queuedAt).toBe(2000);
    });

    it("refuses new keys when full but still coalesces existing ones", async () => {
      const store = makeStore();
      for (let i = 0; i < MAX_QUEUE_PER_USER; i += 1) {
        expect(await enqueueWrite(store, USER_A, { kind: "rsvp", key: `evt-${i}`, args: {} }, i)).toBe(true);
      }
      expect(await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-overflow", args: {} }, 99)).toBe(false);
      expect(await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-0", args: { updated: true } }, 100)).toBe(true);
      expect(await pendingCount(store, USER_A)).toBe(MAX_QUEUE_PER_USER);
    });

    it("caps concurrent distinct-key writes independently for each user", async () => {
      const store = makeStore();
      for (const userId of [USER_A, USER_B]) {
        const accepted = await Promise.all(Array.from({ length: MAX_QUEUE_PER_USER + 3 }, (_, index) => (
          enqueueWrite(store, userId, { kind: "rsvp", key: `evt-${index}`, args: { index } }, 1000)
        )));
        expect(accepted.filter(Boolean)).toHaveLength(MAX_QUEUE_PER_USER);
        const entries = await store.listEntries(userId);
        expect(entries).toHaveLength(MAX_QUEUE_PER_USER);
        expect(entries.map((entry) => entry.args.index).sort((a, b) => a - b))
          .toEqual(accepted.flatMap((ok, index) => ok ? [index] : []));
      }
    });

    it("reserves the last slot once while allowing an overlapping replacement", async () => {
      const store = makeStore();
      for (let index = 0; index < MAX_QUEUE_PER_USER - 1; index += 1) {
        await enqueueWrite(store, USER_A, { kind: "rsvp", key: `evt-${index}`, args: { index } }, index);
      }
      const [first, second, replacement] = await Promise.all([
        enqueueWrite(store, USER_A, { kind: "rsvp", key: "new-a", args: {} }, 1000),
        enqueueWrite(store, USER_A, { kind: "rsvp", key: "new-b", args: {} }, 1000),
        enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-0", args: { updated: true } }, 1000),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect(replacement).toBe(true);
      const entries = await store.listEntries(USER_A);
      expect(entries).toHaveLength(MAX_QUEUE_PER_USER);
      expect(entries.find((entry) => entry.k.endsWith("|evt-0"))?.args).toEqual({ updated: true });
    });

    it("replays oldest-first, deletes successes, and refreshes nothing it should not", async () => {
      const store = makeStore();
      const order = [];
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-2", args: { id: "second" } }, 2000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { id: "first" } }, 1000);
      await enqueueWrite(store, USER_B, { kind: "rsvp", key: "evt-9", args: { id: "other-user" } }, 500);

      const result = await replayQueue(store, USER_A, {
        rsvp: async (args) => { order.push(args.id); },
      }, { now: 10_000 });

      expect(order).toEqual(["first", "second"]);
      expect(result).toMatchObject({ replayed: 2, halted: false, failed: [] });
      expect(await pendingCount(store, USER_A)).toBe(0);
      // The other member's entry is untouched, waiting for its owner.
      expect(await pendingCount(store, USER_B)).toBe(1);
    });

    it("halts on a network-shaped failure and keeps the remaining entries", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: {} }, 1000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-2", args: {} }, 2000);

      let calls = 0;
      const result = await replayQueue(store, USER_A, {
        rsvp: async () => { calls += 1; throw new Error("Failed to fetch"); },
      }, { now: 10_000 });

      expect(calls).toBe(1);
      expect(result.halted).toBe(true);
      expect(result.replayed).toBe(0);
      expect(await pendingCount(store, USER_A)).toBe(2);
    });

    it("keeps a queued write when replay receives a MemberApiError-wrapped timeout", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: {} }, 1000);

      const result = await replayQueue(store, USER_A, {
        rsvp: async () => {
          throw new MemberApiError("RSVP", { message: "TimeoutError: Request timed out" });
        },
      }, { now: 10_000 });

      expect(result).toMatchObject({ replayed: 0, halted: true, failed: [] });
      expect(await pendingCount(store, USER_A)).toBe(1);
    });

    it.each([
      ["PGRST301", "JWT expired", true],
      ["PGRST303", "JWT expired", true],
      ["PGRST303", "JWT EXPIRED", true],
      ["PGRST301", "JWT signature invalid", false],
      ["PGRST303", "JWT claims invalid", false],
      ["42501", "permission denied", false],
      ["22023", "JWT expired is not a valid event title", false],
      ["PGRST301", "", false],
    ])("retains only expired-JWT rejections: %s / %s", async (code, message, retain) => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: {} }, 1000);
      const result = await replayQueue(store, USER_A, {
        rsvp: async () => { throw new MemberApiError("RSVP", { code, message }); },
      }, { now: 10_000 });
      expect(result.halted).toBe(retain);
      expect(result.failed.length).toBe(retain ? 0 : 1);
      expect(await pendingCount(store, USER_A)).toBe(retain ? 1 : 0);
    });

    it("drops and reports server-rejected entries instead of retrying forever", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: {} }, 1000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-2", args: {} }, 2000);

      let calls = 0;
      const result = await replayQueue(store, USER_A, {
        rsvp: async () => {
          calls += 1;
          if (calls === 1) throw new Error("invalid rsvp status");
        },
      }, { now: 10_000 });

      expect(result.replayed).toBe(1);
      expect(result.failed).toEqual([{ kind: "rsvp", message: "invalid rsvp status" }]);
      expect(await pendingCount(store, USER_A)).toBe(0);
    });

    it("expires entries older than the age cap rather than applying them", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "settings", key: "language", args: {} }, 1000);
      let executed = 0;
      const result = await replayQueue(store, USER_A, {
        settings: async () => { executed += 1; },
      }, { now: 1000 + MAX_ENTRY_AGE_MS + 1 });
      expect(executed).toBe(0);
      expect(result.expired).toBe(1);
      expect(await pendingCount(store, USER_A)).toBe(0);
    });

    it("drops entries whose kind has no executor instead of wedging the queue", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "retired-kind", key: "x", args: {} }, 1000);
      const result = await replayQueue(store, USER_A, {}, { now: 2000 });
      expect(result.failed).toEqual([{ kind: "retired-kind", message: "unknown outbox kind" }]);
      expect(await pendingCount(store, USER_A)).toBe(0);
    });

    it("halts before EVERY entry when the identity changes mid-pass, deleting nothing", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: {} }, 1000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-2", args: {} }, 2000);
      let acting = true;
      const executed = [];
      const result = await replayQueue(store, USER_A, {
        rsvp: async (args) => { executed.push(args); acting = false; }, // identity flips during the first round trip
      }, { now: 10_000, stillActing: () => acting });
      // The first entry ran (and deleted); the second must NOT execute under
      // the new identity — the pass halts and the entry stays queued.
      expect(executed.length).toBe(1);
      expect(result.halted).toBe(true);
      expect(result.replayed).toBe(1);
      expect(await pendingCount(store, USER_A)).toBe(1);
    });

    it("deletes departed sensitive residue and replays durable work for a replacement session", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, {
        kind: "formDraft",
        key: "grievance",
        args: { fields: { statement: "departed draft" } },
      }, 1000, sessionStamp(1, "departed-tab", "session-a"));
      await enqueueWrite(store, USER_A, {
        kind: "rsvp",
        key: "evt-1",
        args: { status: "going" },
      }, 1001, sessionStamp(1, "departed-tab", "session-a"));
      const executeDraft = vi.fn();
      const executeRsvp = vi.fn();

      const result = await replayQueue(store, USER_A, {
        formDraft: executeDraft,
        rsvp: executeRsvp,
      }, {
        now: 2000,
        activeSessionLineage: "session-b",
      });

      expect(result).toMatchObject({ replayed: 1, halted: false, failed: [] });
      expect(executeDraft).not.toHaveBeenCalled();
      expect(executeRsvp).toHaveBeenCalledOnce();
      expect(await pendingCount(store, USER_A)).toBe(0);
    });

    it("stamps a coalescing replacement strictly newer, even same-ms or after a clock jump", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { v: 1 } }, 5000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { v: 2 } }, 5000); // same millisecond
      let [entry] = await store.listEntries(USER_A);
      expect(entry.queuedAt).toBe(5001);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { v: 3 } }, 4000); // clock jumped back
      [entry] = await store.listEntries(USER_A);
      expect(entry.queuedAt).toBe(5002);
      expect(entry.args.v).toBe(3);
    });

    it("deleteEntryIfUnchanged removes only the exact entry it was told about", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: {} }, 1000);
      await store.deleteEntryIfUnchanged(`${USER_A}|rsvp|evt-1`, 999); // stale stamp — keep
      expect(await pendingCount(store, USER_A)).toBe(1);
      await store.deleteEntryIfUnchanged(`${USER_A}|rsvp|evt-1`, 1000); // exact stamp — delete
      expect(await pendingCount(store, USER_A)).toBe(0);
      await store.deleteEntryIfUnchanged(`${USER_A}|rsvp|evt-gone`, 1000); // absent key — no-op, no throw
    });

    it("a same-millisecond mid-flight coalesce still survives the delete", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { status: "going" } }, 1000);
      const result = await replayQueue(store, USER_A, {
        // The replacement lands at the SAME Date.now() ms as the entry being
        // replayed — the monotonic stamp still distinguishes them.
        rsvp: async () => {
          await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { status: "not_going" } }, 1000);
        },
      }, { now: 10_000 });
      expect(result.replayed).toBe(1);
      const remaining = await store.listEntries(USER_A);
      expect(remaining.length).toBe(1);
      expect(remaining[0].args.status).toBe("not_going");
    });

    it("does not delete a newer coalesced entry that replaced the one it executed", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { status: "going" } }, 1000);
      const result = await replayQueue(store, USER_A, {
        // While v1's request is "in flight", a foreground write coalesces a
        // newer v2 under the same key. v1 still succeeds — but the delete
        // must not take v2 with it.
        rsvp: async () => {
          await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { status: "not_going" } }, 5000);
        },
      }, { now: 10_000 });
      expect(result.replayed).toBe(1);
      const remaining = await store.listEntries(USER_A);
      expect(remaining.length).toBe(1);
      expect(remaining[0].args.status).toBe("not_going");
    });

    it.each(["success", "refusal"])("preserves an overlapping save after replay %s even when both writers read an empty queue", async (outcome) => {
      const store = makeStore();
      const listEntries = store.listEntries;
      let releaseSecondRead;
      const secondRead = new Promise((resolve) => { releaseSecondRead = resolve; });
      let reads = 0;
      store.listEntries = async (userId) => {
        const rows = await listEntries(userId);
        if (++reads === 2) await secondRead;
        return rows;
      };
      const enqueue = (status) => enqueueWrite(store, USER_A, {
        kind: "rsvp", key: "evt-1", args: { status },
      }, 1000);
      const first = enqueue("going");
      const replacement = enqueue("not_going");
      await first;

      const sent = [];
      await replayQueue(store, USER_A, {
        rsvp: async (args) => {
          sent.push(args.status);
          releaseSecondRead();
          await replacement;
          if (outcome === "refusal") throw new Error("server refused the older value");
        },
      }, { now: 2000 });

      expect(sent).toEqual(["going"]);
      expect((await listEntries(USER_A)).map((entry) => entry.args.status)).toEqual(["not_going"]);
      await replayQueue(store, USER_A, { rsvp: async (args) => sent.push(args.status) }, { now: 2000 });
      expect(sent).toEqual(["going", "not_going"]);
      expect(await pendingCount(store, USER_A)).toBe(0);
    });

    it.each(["expired", "unknown", "departed"])("preserves a replacement when cleaning up a captured %s entry", async (reason) => {
      const store = makeStore();
      const kind = reason === "departed" ? "formDraft" : reason === "unknown" ? "retired-kind" : "rsvp";
      const original = {
        k: `${USER_A}|${kind}|target`, userId: USER_A, kind, queuedAt: 1000,
        writeToken: "original", sessionLineage: "departed", args: { value: "original" },
      };
      await store.putEntry(original);
      const listEntries = store.listEntries;
      store.listEntries = async (userId) => {
        const captured = await listEntries(userId);
        await store.putEntry({ ...original, writeToken: "replacement", sessionLineage: "active", args: { value: "replacement" } });
        return captured;
      };
      const execute = vi.fn();
      await replayQueue(store, USER_A, { rsvp: execute, formDraft: execute }, {
        now: reason === "expired" ? 1001 + MAX_ENTRY_AGE_MS : 2000,
        activeSessionLineage: "active",
      });
      expect(execute).not.toHaveBeenCalled();
      expect((await listEntries(USER_A)).map((entry) => entry.args.value)).toEqual(["replacement"]);
    });

    it.each([false, true])("cleans legacy entries without erasing a tokenized replacement (replacement=%s)", async (replace) => {
      const store = makeStore();
      const legacy = {
        k: `${USER_A}|rsvp|evt-1`, userId: USER_A, kind: "rsvp", queuedAt: 1000, args: { status: "going" },
      };
      await store.putEntry(legacy);
      await replayQueue(store, USER_A, {
        rsvp: async () => {
          if (replace) await store.putEntry({ ...legacy, writeToken: "new-writer", args: { status: "not_going" } });
        },
      }, { now: 2000 });
      expect((await store.listEntries(USER_A)).map((entry) => entry.args.status)).toEqual(replace ? ["not_going"] : []);
    });

    it("purges only the signed-out member's leftover snapshot", async () => {
      const store = makeStore();
      await plantSnapshot(store, USER_A, { member: { id: USER_A } }, 5000);
      await plantSnapshot(store, USER_B, { member: { id: USER_B } }, 6000);
      await deleteSnapshot(store, USER_A);
      expect(await readSnapshot(store, USER_A)).toBeNull();
      expect((await readSnapshot(store, USER_B)).savedAt).toBe(6000);
    });

    it("uses distinct queue fallback tokens when crypto UUIDs are unavailable", async () => {
      const store = makeStore();
      vi.stubGlobal("crypto", undefined);
      try {
        await enqueueWrite(store, USER_A, {
          kind: "rsvp",
          key: "event-1",
          args: { status: "going" },
        }, 100);
        await enqueueWrite(store, USER_A, {
          kind: "rsvp",
          key: "event-2",
          args: { status: "going" },
        }, 100);
        const [firstEntry, secondEntry] = await store.listEntries(USER_A);
        expect(firstEntry.writeToken).toMatch(/^queue-/);
        expect(secondEntry.writeToken).toMatch(/^queue-/);
        expect(secondEntry.writeToken).not.toBe(firstEntry.writeToken);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("refuses new sensitive records from a lineage that is no longer active", async () => {
      const store = makeStore();
      const departed = sessionStamp(1, "departed-tab", "session-a");
      const readActiveSessionLineage = () => "session-b";

      await expect(enqueueWrite(store, USER_A, {
        kind: "formDraft",
        key: "new-draft",
        args: { fields: { statement: "departed draft" } },
      }, 5000, departed, () => true, readActiveSessionLineage)).resolves.toBe(false);

      expect(await pendingCount(store, USER_A)).toBe(0);
    });

    it("fails closed when the active lineage reader throws at a sensitive write boundary", async () => {
      const store = makeStore();
      const stamp = sessionStamp(1, "departed-tab", "session-a");
      const unreadableLineage = () => { throw new Error("auth storage unreadable"); };

      await expect(enqueueWrite(store, USER_A, {
        kind: "formDraft",
        key: "grievance",
        args: { fields: { statement: "must not be stored" } },
      }, 1000, stamp, () => true, unreadableLineage)).resolves.toBe(false);

      expect(await pendingCount(store, USER_A)).toBe(0);
    });

    it("does not let legacy or unreadable lineage writes replace lineage-aware queue records", async () => {
      const store = makeStore();
      const lineageA = sessionStamp(1, "tab-a", "session-a");
      const lineageB = sessionStamp(1, "tab-b", "session-b");

      await enqueueWrite(store, USER_A, {
        kind: "rsvp",
        key: "event-1",
        args: { status: "going" },
      }, 1000, lineageA);
      await expect(enqueueWrite(store, USER_A, {
        kind: "rsvp",
        key: "event-1",
        args: { status: "maybe" },
      }, 1500, sessionStamp(2, "legacy-tab"))).resolves.toBe(false);
      await expect(enqueueWrite(store, USER_A, {
        kind: "rsvp",
        key: "event-1",
        args: { status: "not_going" },
      }, 2000, lineageB, () => true, () => { throw new Error("auth storage unreadable"); }))
        .resolves.toBe(false);

      expect(await store.listEntries(USER_A)).toMatchObject([{
        sessionLineage: "session-a",
        args: { status: "going" },
      }]);
    });

    it("lets the same lineage, and the active replacement lineage, replace a lineage-aware queue record", async () => {
      const store = makeStore();
      const lineageA = sessionStamp(1, "tab-a", "session-a");
      const lineageB = sessionStamp(2, "tab-b", "session-b");

      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "event-1", args: { status: "going" } }, 1000, lineageA);
      await expect(enqueueWrite(store, USER_A, { kind: "rsvp", key: "event-1", args: { status: "maybe" } }, 1100, lineageA))
        .resolves.toBe(true);
      expect(await store.listEntries(USER_A)).toMatchObject([{ sessionLineage: "session-a", args: { status: "maybe" } }]);

      await enqueueWrite(store, USER_A, {
        kind: "formDraft", key: "grievance", args: { fields: { statement: "first session" } },
      }, 1200, lineageA, () => true, () => "session-a");
      await expect(enqueueWrite(store, USER_A, {
        kind: "formDraft", key: "grievance", args: { fields: { statement: "replacement session" } },
      }, 1300, lineageB, () => true, () => "session-b")).resolves.toBe(true);
      expect((await store.listEntries(USER_A)).find((entry) => entry.kind === "formDraft"))
        .toMatchObject({ sessionLineage: "session-b", args: { fields: { statement: "replacement session" } } });
    });

    it("refuses a queued write whose operation ends while the queue is being read", async () => {
      const backingStore = makeStore();
      let current = true;
      const store = {
        ...backingStore,
        listEntries: async (userId) => {
          const entries = await backingStore.listEntries(userId);
          current = false;
          return entries;
        },
      };
      await expect(enqueueWrite(store, USER_A, {
        kind: "rsvp", key: "event-1", args: { status: "going" },
      }, 1000, sessionStamp(1), () => current)).resolves.toBe(false);
      expect(await backingStore.listEntries(USER_A)).toEqual([]);
    });

    it("removes queued writes that lose currency immediately after commit", async () => {
      const queueStore = makeStore();
      let queueCurrent = true;
      const queueRaceStore = {
        ...queueStore,
        putEntryIf: async (entry, allows) => {
          const committed = await queueStore.putEntryIf(entry, allows);
          queueCurrent = false;
          return committed;
        },
      };

      await expect(enqueueWrite(queueRaceStore, USER_A, {
        kind: "rsvp",
        key: "event-1",
        args: { status: "going" },
      }, 1000, sessionStamp(1), () => queueCurrent)).resolves.toBe(false);
      expect(await queueStore.listEntries(USER_A)).toEqual([]);
    });

    // SEC-UG-SIGNOUT-OUTBOX-DRAFTS-20260817. formDraft and profile entries
    // hold the member's own words and personal details; the rest of the queue
    // holds read-marks and rsvps. Only the first two leave on sign-out.
    it("purges the departing member's sensitive kinds and keeps the replayable rest", async () => {
      const store = makeStore();
      const draftText = "My supervisor threatened me on the 3rd.";
      await enqueueWrite(store, USER_A, {
        kind: "formDraft",
        key: "grievance",
        args: { fields: { templateKey: "grievance", answers: { what: draftText } } },
      }, 1000);
      await enqueueWrite(store, USER_A, {
        kind: "profile",
        key: "profile",
        args: { userId: USER_A, fields: { fullName: "Darnell Foster", phone: "617-555-0134" } },
      }, 2000);
      await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { status: "going" } }, 3000);
      await enqueueWrite(store, USER_A, { kind: "settings", key: "notify", args: { userId: USER_A, fields: {} } }, 4000);

      await purgeSensitiveEntries(store, USER_A);

      const remaining = await store.listEntries(USER_A);
      expect(remaining.map((entry) => entry.kind).sort()).toEqual(["rsvp", "settings"]);
      // Not just "the kind is gone" — the payload text itself must be gone.
      expect(JSON.stringify(remaining)).not.toContain(draftText);
      expect(JSON.stringify(remaining)).not.toContain("Darnell Foster");
      expect(JSON.stringify(remaining)).not.toContain("617-555-0134");
    });

    it("leaves another member's unsent sensitive entries alone", async () => {
      const store = makeStore();
      await enqueueWrite(store, USER_A, { kind: "formDraft", key: "grievance", args: { fields: {} } }, 1000);
      await enqueueWrite(store, USER_B, { kind: "formDraft", key: "grievance", args: { fields: {} } }, 1000);

      await purgeSensitiveEntries(store, USER_A);

      expect(await pendingCount(store, USER_A)).toBe(0);
      expect(await pendingCount(store, USER_B)).toBe(1);
    });

    // deleteEntryIfUnchanged is the right rule for replay bookkeeping and the
    // wrong one for erasure: a draft saved between the purge's read and its
    // delete must not survive because its queuedAt moved. The regression
    // drives purgeSensitiveEntries itself — wrapping delete so the newer
    // write lands in the list-to-delete gap — so a change from unconditional
    // delete to the queuedAt-sensitive primitive fails this case.
    it("erases a sensitive entry that was coalesced newer mid-purge", async () => {
      const backingStore = makeStore();
      await enqueueWrite(backingStore, USER_A, {
        kind: "formDraft",
        key: "grievance",
        args: { fields: { v: 1 } },
      }, 1000);
      await enqueueWrite(backingStore, USER_A, {
        kind: "rsvp",
        key: "evt-1",
        args: { status: "going" },
      }, 1500);

      let newerWriteLanded = false;
      const injectNewerWrite = async () => {
        if (newerWriteLanded) return;
        newerWriteLanded = true;
        const committed = await enqueueWrite(backingStore, USER_A, {
          kind: "formDraft",
          key: "grievance",
          args: { fields: { v: 2 } },
        }, 2000);
        expect(committed).toBe(true);
        const [newer] = (await backingStore.listEntries(USER_A))
          .filter((entry) => entry.kind === "formDraft");
        expect(newer.args.fields.v).toBe(2);
        expect(newer.queuedAt).toBeGreaterThan(1000);
      };
      const store = {
        ...backingStore,
        deleteEntry: async (k) => {
          await injectNewerWrite();
          return backingStore.deleteEntry(k);
        },
        deleteEntryIfUnchanged: async (k, queuedAt) => {
          await injectNewerWrite();
          return backingStore.deleteEntryIfUnchanged(k, queuedAt);
        },
      };

      await purgeSensitiveEntries(store, USER_A);

      expect(newerWriteLanded).toBe(true);
      const remaining = await backingStore.listEntries(USER_A);
      expect(remaining.filter((entry) => SENSITIVE_OUTBOX_KINDS.includes(entry.kind))).toEqual([]);
      expect(remaining).toEqual([
        expect.objectContaining({
          kind: "rsvp",
          args: { status: "going" },
          queuedAt: 1500,
        }),
      ]);
    });

    // The pair a departure fires, explicit or not. An implicit end of session
    // (revoked from another device, refresh token expired, account
    // deactivated, peer-tab tombstone) leaves no chance to ask the member
    // anything, so it must erase exactly what a pressed "Sign out" erases.
    describe("forgetDepartedMemberDevice", () => {
      it("erases the departing member's saved copy and sensitive queue kinds in one call", async () => {
        const store = makeStore();
        await plantSnapshot(store, USER_A, { member: { id: USER_A }, cases: ["written warning, 3rd"] }, 1000);
        await enqueueWrite(store, USER_A, { kind: "formDraft", key: "grievance", args: { fields: {} } }, 1000);
        await enqueueWrite(store, USER_A, { kind: "profile", key: "profile", args: { fields: {} } }, 2000);
        await enqueueWrite(store, USER_A, { kind: "rsvp", key: "evt-1", args: { status: "going" } }, 3000);

        await forgetDepartedMemberDevice(store, USER_A);

        expect(await readSnapshot(store, USER_A)).toBeNull();
        expect((await store.listEntries(USER_A)).map((entry) => entry.kind)).toEqual(["rsvp"]);
      });

      // The two halves of the same race, and they pull in opposite
      // directions. A replacement login's work must survive a purge that is
      // still in flight; the DEPARTED session's own trailing write must not,
      // even though it is newer than everything the purge captured. Version
      // fencing ("delete it unless it changed") gets the first right and the
      // second wrong, so the fence is the session that wrote the record.
      it("does not erase sensitive writes created by a rapid same-user replacement session", async () => {
        const baseStore = makeStore();
        const departed = sessionStamp(1);
        const replacement = sessionStamp(2);
        await plantSnapshot(baseStore, USER_A, { member: { id: USER_A }, cases: ["departed"] }, 1000, departed);
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "grievance",
          args: { fields: { statement: "departed draft" } },
        }, 1000, departed);

        let releaseSnapshotDelete;
        let snapshotDeleteStarted;
        const snapshotDeleteStartedPromise = new Promise((resolve) => { snapshotDeleteStarted = resolve; });
        const snapshotDeleteGate = new Promise((resolve) => { releaseSnapshotDelete = resolve; });
        const delayedStore = {
          ...baseStore,
          deleteSnapshotIf: async (userId, matches) => {
            snapshotDeleteStarted();
            await snapshotDeleteGate;
            return baseStore.deleteSnapshotIf(userId, matches);
          },
        };

        const forgetting = forgetDepartedMemberDevice(delayedStore, USER_A, {
          sessionGeneration: departed.sessionGeneration,
        });
        await snapshotDeleteStartedPromise;
        await plantSnapshot(
          baseStore,
          USER_A,
          { member: { id: USER_A }, cases: ["replacement"] },
          2000,
          replacement,
        );
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "grievance",
          args: { fields: { statement: "replacement draft" } },
        }, 2000, replacement, () => true, () => replacement.sessionLineage);
        await enqueueWrite(baseStore, USER_A, {
          kind: "profile",
          key: "profile",
          args: { fields: { phone: "replacement phone" } },
        }, 2000, replacement);
        releaseSnapshotDelete();
        await forgetting;

        expect(await readSnapshot(baseStore, USER_A)).toMatchObject({
          data: { cases: ["replacement"] },
        });
        expect((await baseStore.listEntries(USER_A)).map((entry) => [entry.kind, entry.args.fields]))
          .toEqual([
            ["formDraft", { statement: "replacement draft" }],
            ["profile", { phone: "replacement phone" }],
          ]);
      });

      it("keeps a replacement session entry written while its deletion is paused", async () => {
        const baseStore = makeStore();
        const departed = sessionStamp(1);
        const replacement = sessionStamp(2);
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "grievance",
          args: { fields: { statement: "departed draft" } },
        }, 1000, departed);

        let releaseEntryDelete;
        let entryDeleteStarted;
        const entryDeleteStartedPromise = new Promise((resolve) => { entryDeleteStarted = resolve; });
        const entryDeleteGate = new Promise((resolve) => { releaseEntryDelete = resolve; });
        const delayedStore = {
          ...baseStore,
          deleteEntryIf: async (k, matches) => {
            entryDeleteStarted();
            await entryDeleteGate;
            return baseStore.deleteEntryIf(k, matches);
          },
        };

        const forgetting = forgetDepartedMemberDevice(delayedStore, USER_A, {
          sessionGeneration: departed.sessionGeneration,
        });
        await entryDeleteStartedPromise;
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "grievance",
          args: { fields: { statement: "replacement draft" } },
        }, 2000, replacement);
        releaseEntryDelete();
        await forgetting;

        expect(JSON.stringify(await baseStore.listEntries(USER_A))).toContain("replacement draft");
      });

      it("preserves another tab's replacement lineage during a departure sweep", async () => {
        const baseStore = makeStore();
        const departed = sessionStamp(1, "departed-tab", "session-a");
        const replacement = sessionStamp(1, "replacement-tab", "session-b");
        await plantSnapshot(baseStore, USER_A, { member: { id: USER_A }, cases: ["departed"] }, 1000, departed);
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft", key: "grievance", args: { fields: { statement: "departed draft" } },
        }, 1000, departed);

        let releaseDelete;
        let deleteStarted;
        const deleteStartedPromise = new Promise((resolve) => { deleteStarted = resolve; });
        const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
        const delayedStore = {
          ...baseStore,
          deleteSnapshotIf: async (userId, matches) => {
            deleteStarted();
            await deleteGate;
            return baseStore.deleteSnapshotIf(userId, matches);
          },
        };

        const forgetting = forgetDepartedMemberDevice(delayedStore, USER_A, {
          sessionGeneration: departed.sessionGeneration,
          deviceBoot: departed.deviceBoot,
          sessionLineage: departed.sessionLineage,
          readActiveSessionLineage: () => replacement.sessionLineage,
        });
        await deleteStartedPromise;
        await plantSnapshot(
          baseStore,
          USER_A,
          { member: { id: USER_A }, cases: ["replacement"] },
          2000,
          replacement,
        );
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft", key: "grievance", args: { fields: { statement: "replacement draft" } },
        }, 2000, replacement, () => true, () => replacement.sessionLineage);
        releaseDelete();
        await forgetting;

        expect(await readSnapshot(baseStore, USER_A)).toMatchObject({ data: { cases: ["replacement"] } });
        expect(JSON.stringify(await baseStore.listEntries(USER_A))).toContain("replacement draft");
      });

      it("purges older lineage residue alongside the departing lineage", async () => {
        const store = makeStore();
        const older = sessionStamp(1, "older-tab", "session-a");
        const departing = sessionStamp(1, "departing-tab", "session-b");
        await plantSnapshot(store, USER_A, { member: { id: USER_A }, cases: ["older"] }, 1000, older);
        await enqueueWrite(store, USER_A, {
          kind: "formDraft", key: "older", args: { fields: { statement: "older draft" } },
        }, 1000, older);
        await enqueueWrite(store, USER_A, {
          kind: "profile", key: "departing", args: { fields: { phone: "617-555-0199" } },
        }, 2000, departing);

        await forgetDepartedMemberDevice(store, USER_A, {
          sessionGeneration: departing.sessionGeneration,
          deviceBoot: departing.deviceBoot,
          sessionLineage: departing.sessionLineage,
          readActiveSessionLineage: () => null,
        });

        expect(await readSnapshot(store, USER_A)).toBeNull();
        expect(await store.listEntries(USER_A)).toEqual([]);
      });

      it("erases the departed session's own trailing write, newer stamp and all", async () => {
        const baseStore = makeStore();
        const departed = sessionStamp(1);
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "grievance",
          args: { fields: { statement: "early draft" } },
        }, 1000, departed);

        let releaseEntryDelete;
        let entryDeleteStarted;
        const entryDeleteStartedPromise = new Promise((resolve) => { entryDeleteStarted = resolve; });
        const entryDeleteGate = new Promise((resolve) => { releaseEntryDelete = resolve; });
        const delayedStore = {
          ...baseStore,
          deleteEntryIf: async (k, matches) => {
            entryDeleteStarted();
            await entryDeleteGate;
            return baseStore.deleteEntryIf(k, matches);
          },
        };

        const forgetting = forgetDepartedMemberDevice(delayedStore, USER_A, {
          sessionGeneration: departed.sessionGeneration,
        });
        await entryDeleteStartedPromise;
        // The revoked session's Save lands anyway: App enqueues the write and
        // only then throws in assertCurrent, and nothing undoes the write.
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "grievance",
          args: { fields: { statement: "trailing draft from the DEPARTED session" } },
        }, 2000, departed);
        releaseEntryDelete();
        await forgetting;

        expect(JSON.stringify(await baseStore.listEntries(USER_A))).not.toContain("trailing draft");
        expect(await pendingCount(baseStore, USER_A)).toBe(0);
      });

      it("refuses a departed session's later sensitive write under a brand-new key", async () => {
        const store = makeStore();
        const departed = sessionStamp(1);

        await forgetDepartedMemberDevice(store, USER_A, { sessionGeneration: departed.sessionGeneration });

        // A NEW key cannot be caught by enumerate-then-delete at all, so the
        // departure closes the door behind it instead.
        expect(await enqueueWrite(store, USER_A, {
          kind: "formDraft",
          key: "accommodation",
          args: { fields: { statement: "after the purge" } },
        }, 3000, departed)).toBe(false);
        // The replacement session is not fenced, and non-sensitive kinds queue
        // for their owner exactly as they do after a sign-out.
        expect(await enqueueWrite(store, USER_A, {
          kind: "formDraft",
          key: "accommodation",
          args: { fields: { statement: "the next session's own words" } },
        }, 3000, sessionStamp(2))).toBe(true);
        expect(await enqueueWrite(store, USER_A, {
          kind: "rsvp",
          key: "evt-1",
          args: { status: "going" },
        }, 3000, departed)).toBe(true);

        expect((await store.listEntries(USER_A)).map((entry) => entry.kind).sort()).toEqual(["formDraft", "rsvp"]);
        expect(JSON.stringify(await store.listEntries(USER_A))).not.toContain("after the purge");
      });

      it("preserves a replacement draft when a departed write resumes before its put", async () => {
        const baseStore = makeStore();
        const departed = sessionStamp(1, "departed-tab", "session-a");
        let releasePut;
        let putStarted;
        const putStartedPromise = new Promise((resolve) => { putStarted = resolve; });
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const delayedStore = {
          ...baseStore,
          putEntryIf: async (entry, allows) => {
            putStarted();
            await putGate;
            return baseStore.putEntryIf(entry, allows);
          },
        };

        const enqueueing = enqueueWrite(delayedStore, USER_A, {
          kind: "formDraft",
          key: "accommodation",
          args: { fields: { statement: "late sensitive draft" } },
        }, 3000, departed);
        await putStartedPromise;
        await forgetDepartedMemberDevice(delayedStore, USER_A, {
          sessionGeneration: departed.sessionGeneration,
          deviceBoot: departed.deviceBoot,
          sessionLineage: departed.sessionLineage,
        });
        await expect(enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "accommodation",
          args: { fields: { statement: "replacement draft" } },
        }, 4000, sessionStamp(1, "replacement-tab", "session-b"))).resolves.toBe(true);
        releasePut();

        await expect(enqueueing).resolves.toBe(false);
        expect(await baseStore.listEntries(USER_A)).toMatchObject([{
          sessionLineage: "session-b",
          args: { fields: { statement: "replacement draft" } },
        }]);
      });

      it("refuses a stale lineage draft after a replacement lands first across a backwards clock", async () => {
        const baseStore = makeStore();
        let releasePut;
        let putStarted;
        const putStartedPromise = new Promise((resolve) => { putStarted = resolve; });
        const putGate = new Promise((resolve) => { releasePut = resolve; });
        const delayedStore = {
          ...baseStore,
          putEntryIf: async (entry, allows) => {
            putStarted();
            await putGate;
            return baseStore.putEntryIf(entry, allows);
          },
        };

        const staleWrite = enqueueWrite(delayedStore, USER_A, {
          kind: "formDraft",
          key: "accommodation",
          args: { fields: { statement: "stale session draft" } },
        }, 5000, sessionStamp(1, "departed-tab", "session-a"), () => true);
        await putStartedPromise;
        await expect(enqueueWrite(baseStore, USER_A, {
          kind: "formDraft",
          key: "accommodation",
          args: { fields: { statement: "replacement draft" } },
        }, 1000, sessionStamp(1, "replacement-tab", "session-b"), () => true, () => "session-b"))
          .resolves.toBe(true);
        releasePut();

        await expect(staleWrite).resolves.toBe(false);
        expect(await baseStore.listEntries(USER_A)).toMatchObject([{
          queuedAt: 1000,
          sessionLineage: "session-b",
          args: { fields: { statement: "replacement draft" } },
        }]);
      });

      it("touches nobody else's device residue", async () => {
        const store = makeStore();
        await plantSnapshot(store, USER_B, { member: { id: USER_B } }, 1000);
        await enqueueWrite(store, USER_B, { kind: "formDraft", key: "grievance", args: { fields: {} } }, 1000);

        await forgetDepartedMemberDevice(store, USER_A);

        expect(await readSnapshot(store, USER_B)).not.toBeNull();
        expect(await pendingCount(store, USER_B)).toBe(1);
      });

      it("erases without a fence but leaves later sensitive writes open for every user", async () => {
        const store = makeStore();
        await plantSnapshot(store, USER_A, { member: { id: USER_A } }, 1000);
        await enqueueWrite(store, USER_A, {
          kind: "formDraft", key: "grievance", args: { fields: { statement: "departed draft" } },
        }, 1000);

        await forgetDepartedMemberDevice(store, USER_A);

        expect(await readSnapshot(store, USER_A)).toBeNull();
        expect(await store.listEntries(USER_A)).toEqual([]);
        expect(await enqueueWrite(store, USER_A, {
          kind: "formDraft", key: "later-a", args: { fields: { statement: "same user later" } },
        }, 2000, sessionStamp(1))).toBe(true);
        expect(await enqueueWrite(store, USER_B, {
          kind: "profile", key: "later-b", args: { fields: { phone: "another user later" } },
        }, 2000, sessionStamp(1))).toBe(true);
      });

      // The implicit paths can observe a departure with no user id at all (a
      // tab that never held a session, a cross-tab payload with no user.id).
      // Erasing "everyone" there would delete the member who is actually
      // signed in on this device, so null alone is still a no-op and the
      // device-wide intent has to be named.
      it("does nothing when no departing member can be named", async () => {
        const store = makeStore();
        await plantSnapshot(store, USER_A, { member: { id: USER_A } }, 1000);
        await enqueueWrite(store, USER_A, { kind: "formDraft", key: "grievance", args: { fields: {} } }, 1000);

        await forgetDepartedMemberDevice(store, null);
        await forgetDepartedMemberDevice(store, undefined, { sessionGeneration: 4 });

        expect(await readSnapshot(store, USER_A)).not.toBeNull();
        expect(await pendingCount(store, USER_A)).toBe(1);
        expect(await enqueueWrite(store, USER_A, {
          kind: "formDraft", key: "later", args: { fields: {} },
        }, 2000, sessionStamp(1))).toBe(true);
      });

      it("purges every owner's saved copy and sensitive entry when the cold start asks for all owners", async () => {
        const store = makeStore();
        // Residue from an EARLIER page load: its generation counter started at
        // zero again, so generations alone cannot rank it against this load.
        const priorLoad = sessionStamp(7, "a-previous-page-load");
        await plantSnapshot(store, USER_A, { member: { id: USER_A } }, 1000, priorLoad);
        await plantSnapshot(store, USER_B, { member: { id: USER_B } }, 1000, priorLoad);
        await enqueueWrite(store, USER_A, { kind: "formDraft", key: "grievance", args: { fields: {} } }, 1000, priorLoad);
        await enqueueWrite(store, USER_B, { kind: "profile", key: "profile", args: { fields: {} } }, 1000, priorLoad);
        await enqueueWrite(store, USER_B, { kind: "rsvp", key: "event", args: { status: "going" } }, 1000, priorLoad);

        // What a cold start knows: nobody is signed in, and this load has not
        // written anything yet.
        await forgetDepartedMemberDevice(store, null, { allOwners: true, sessionGeneration: 0 });

        expect(await readSnapshot(store, USER_A)).toBeNull();
        expect(await readSnapshot(store, USER_B)).toBeNull();
        expect(await store.listEntries(USER_A)).toEqual([]);
        expect((await store.listEntries(USER_B)).map((entry) => entry.kind)).toEqual(["rsvp"]);
      });

      it("keeps another tab's fresh lineage while the cold-start purge is still in flight", async () => {
        const baseStore = makeStore();
        const prior = sessionStamp(3, "a-previous-page-load", "session-a");
        const replacement = sessionStamp(1, "replacement-tab", "session-b");
        await plantSnapshot(baseStore, USER_A, { member: { id: USER_A } }, 1000, prior);
        await enqueueWrite(baseStore, USER_A, {
          kind: "formDraft", key: "grievance", args: { fields: { statement: "the departed member's words" } },
        }, 1000, prior);

        let releaseDelete;
        let deleteStarted;
        const deleteStartedPromise = new Promise((resolve) => { deleteStarted = resolve; });
        const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
        const delayedStore = {
          ...baseStore,
          deleteSnapshotIf: async (userId, matches) => {
            deleteStarted();
            await deleteGate;
            return baseStore.deleteSnapshotIf(userId, matches);
          },
        };

        const forgetting = forgetDepartedMemberDevice(delayedStore, null, {
          allOwners: true,
          sessionGeneration: 0,
          readActiveSessionLineage: () => replacement.sessionLineage,
        });
        await deleteStartedPromise;
        // Somebody signs in while the purge is mid-flight: generation 1 of
        // THIS page load.
        await plantSnapshot(baseStore, USER_B, { member: { id: USER_B } }, 2000, replacement);
        await enqueueWrite(baseStore, USER_B, {
          kind: "formDraft", key: "grievance", args: { fields: { statement: "the new member's words" } },
        }, 2000, replacement);
        releaseDelete();
        await forgetting;

        expect(await readSnapshot(baseStore, USER_A)).toBeNull();
        expect(JSON.stringify(await baseStore.listEntries(USER_A))).not.toContain("departed member's words");
        expect(await readSnapshot(baseStore, USER_B)).not.toBeNull();
        expect(JSON.stringify(await baseStore.listEntries(USER_B))).toContain("new member's words");
      });

      it("preserves lineage records when auth storage is unreadable and keeps the highest departure fence", async () => {
        const store = makeStore();
        const stored = sessionStamp(4, "stored-tab", "session-b");
        await store.putSnapshot({
          userId: USER_A,
          savedAt: 1000,
          writeToken: "stored-snapshot",
          data: { member: { id: USER_A } },
          ...stored,
        });
        await store.putEntry({
          k: `${USER_A}|formDraft|grievance`,
          userId: USER_A,
          kind: "formDraft",
          args: { fields: { statement: "possibly active" } },
          queuedAt: 1000,
          writeToken: "stored-entry",
          ...stored,
        });

        await forgetDepartedMemberDevice(store, USER_A, {
          sessionGeneration: 5,
          deviceBoot: "departed-tab",
          sessionLineage: "session-a",
          readActiveSessionLineage: () => { throw new Error("auth storage unreadable"); },
        });
        expect(await readSnapshot(store, USER_A)).not.toBeNull();
        expect(await pendingCount(store, USER_A)).toBe(1);

        await forgetDepartedMemberDevice(store, USER_A, {
          sessionGeneration: 3,
          deviceBoot: "departed-tab",
        });
        await expect(enqueueWrite(store, USER_A, {
          kind: "profile",
          key: "profile",
          args: { fields: { phone: "617-555-0100" } },
        }, 2000, sessionStamp(4, "departed-tab"))).resolves.toBe(false);
      });

      // Best-effort: a device whose storage is refusing writes must still be
      // able to finish tearing the session down.
      it("stays quiet when the store itself is broken", async () => {
        const broken = {
          deleteSnapshot: async () => { throw new Error("QuotaExceededError"); },
          listEntries: async () => { throw new Error("QuotaExceededError"); },
        };

        await expect(forgetDepartedMemberDevice(broken, USER_A)).resolves.toBeUndefined();
        await expect(forgetDepartedMemberDevice(broken, null, { allOwners: true })).resolves.toBeUndefined();
      });
    });
  });
}

describe("isDepartedSessionResidue", () => {
  const boot = "this-page-load";
  const departure = { deviceBoot: boot, sessionGeneration: 4 };

  it.each([
    ["an unstamped record written before the field existed", {}, true],
    ["another page load's record, however high its counter", { deviceBoot: "earlier", sessionGeneration: 99 }, true],
    ["the departed generation's own late write", { deviceBoot: boot, sessionGeneration: 4 }, true],
    ["an older generation of this load", { deviceBoot: boot, sessionGeneration: 1 }, true],
    ["the replacement session's write", { deviceBoot: boot, sessionGeneration: 5 }, false],
  ])("%s", (_label, record, expected) => {
    expect(isDepartedSessionResidue(record, departure)).toBe(expected);
  });

  it("compares auth-session lineage across tabs before falling back to page-local stamps", () => {
    expect(isDepartedSessionResidue(
      sessionStamp(99, "replacement-tab", "session-b"),
      { ...departure, sessionLineage: "session-a", activeSessionLineage: "session-b" },
    )).toBe(false);
    expect(isDepartedSessionResidue(
      sessionStamp(1, "departed-tab", "session-a"),
      { ...departure, sessionLineage: "session-a", activeSessionLineage: "session-b" },
    )).toBe(true);
  });

  it("preserves an unknown record and lineage-stamped records when auth storage is unreadable", () => {
    expect(isDepartedSessionResidue(null, departure)).toBe(false);
    expect(isDepartedSessionResidue(
      sessionStamp(1, "replacement-tab", "session-b"),
      { ...departure, sessionLineage: "session-a", activeSessionLineage: undefined },
    )).toBe(false);
  });
});

describe("sensitive outbox kinds", () => {
  // Pinned as a list, not inferred: adding a new queueable kind that carries
  // member text (a message body, a case note) means adding it HERE, and this
  // assertion is where that decision surfaces in review.
  it("names exactly the two kinds whose queued args carry member content", () => {
    expect([...SENSITIVE_OUTBOX_KINDS]).toEqual(["formDraft", "profile"]);
  });
});
