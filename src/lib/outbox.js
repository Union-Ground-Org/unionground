// Offline outbox + last-good snapshot store (PR8, gap I).
//
// Two jobs, one IndexedDB database ("sg-outbox", the sg- namespace):
//  • queue   — idempotent member writes that failed because the network was
//              gone, keyed so repeats coalesce, replayed oldest-first when the
//              connection returns.
//  • snapshots — RETIRED. Older builds kept the last loaded member-app payload
//              per user and painted it after a failed boot. A stored payload
//              can belong to a chapter the member has since left, so nothing
//              writes or reads one now
//              (BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111);
//              the store stays only so the purges below erase leftover rows.
//
// The queue accepts ONLY writes that are safe to run twice: server-side
// upserts, update-where-null marks, and last-write-wins field patches. The
// dangerous ones stay out on purpose — ballots (a queued vote is a spoiled
// vote nobody chose), messages (three non-atomic calls that duplicate on
// replay), and every points-awarding append (check-in, workload, submit) —
// those keep failing loudly exactly as before.
//
// Everything here is app-level, not service-worker-level. The SW's contract is
// "member data, auth, and mutations are never cached" (public/sw.js); replaying
// writes from the worker would need the auth token copied into worker-reachable
// storage, which is new attack surface for zero gain. The page has the session,
// the identity guard, and the toast — the page replays.
//
// Storage is injectable: createOutboxStore() uses IndexedDB and falls back to
// an in-memory store when IndexedDB is unavailable (some private modes), so
// the write path never gains a new way to fail. Tests exercise the same
// interface with either backend.

const DB_NAME = "sg-outbox";
const DB_VERSION = 1;
const QUEUE = "queue";
const SNAPSHOTS = "snapshots";

// Coalescing keeps the queue tiny in practice (one entry per target), so the
// cap is a backstop against a pathological session, not a working limit. A
// full queue refuses new entries — the write then fails visibly like today,
// which is honest; silently evicting someone's oldest queued change is not.
export const MAX_QUEUE_PER_USER = 30;
// Entries older than this are dropped at replay time rather than applied: a
// week-old "last write wins" patch is more likely to clobber newer work from
// another device than to preserve anything the member still wants.
export const MAX_ENTRY_AGE_MS = 7 * 86400000;
// The same window in days, because the copy that tells a member their work was
// discarded has to name the window, and a hardcoded "7" in two languages drifts
// the moment MAX_ENTRY_AGE_MS changes. Derived, then interpolated.
export const MAX_ENTRY_AGE_DAYS = MAX_ENTRY_AGE_MS / 86400000;

// Which single notice a finished replay pass should show, as an i18n key and
// its params, or null for "say nothing". A pure function rather than a chain
// of ifs inside the effect, so the PRECEDENCE below is testable without
// standing up a session, a store and a render.
//
// `expired` outranks everything because it is the only outcome already
// irreversible by the time this runs: replayQueue has DELETED those entries.
// Nothing read result.expired before, so a pass that applied two changes and
// discarded three said "Synced 2 changes" and the member never learned the
// other three were gone. A success toast over silent data loss is the worst of
// the things this can say.
//
// `halted` is deliberately absent, and its absence is asserted. replayQueue
// sets halted on two different returns — a network drop and an identity change
// — with nothing distinguishing them, so any notice keyed on it would also
// fire for the member who just signed out, on a device someone else is now
// holding. The offline banner and pendingSync already report queued work and
// both are cleared on identity change.
export function replayNotice(result) {
  if (result.expired > 0) {
    return result.expired === 1
      ? ["offline.expiredOne", { days: MAX_ENTRY_AGE_DAYS }]
      : ["offline.expiredMany", { count: result.expired, days: MAX_ENTRY_AGE_DAYS }];
  }
  if (result.failed.length > 0) {
    return result.failed.length === 1
      ? ["offline.syncFailedOne", undefined]
      : ["offline.syncFailedMany", { count: result.failed.length }];
  }
  if (result.replayed > 0) {
    return result.replayed === 1
      ? ["offline.syncedOne", undefined]
      : ["offline.syncedMany", { count: result.replayed }];
  }
  return null;
}

// Network-versus-server classification. Only network-shaped failures queue;
// a server rejection (RLS, validation, closed ballot) must surface to the
// member now — retrying it later cannot succeed and hides the truth.
// navigator.onLine === false is authoritative for "offline"; the message
// sniff catches the fetch layer's vocabulary for a request that never got a
// response (Chrome "Failed to fetch", Firefox "NetworkError…", Safari "Load
// failed", Node/undici "fetch failed"). A request deadline is the same
// no-response condition without browser-specific network vocabulary.
// supabase-js catches a rejected fetch and returns the exception text inside
// `{ error: { message } }`; MemberApiError then prefixes that message, so the
// classifier must recognize both the original TimeoutError and that wrapped
// form.
const NETWORK_ERROR_RE = /failed to fetch|fetch failed|networkerror|network request failed|load failed|network error/i;
const REQUEST_TIMEOUT_RE = /timeouterror|request timed out/i;

export function isRequestTimeoutError(error) {
  if (error?.name === "TimeoutError") return true;
  return REQUEST_TIMEOUT_RE.test(String(error?.message || ""));
}

export function isOfflineError(error, nav = typeof navigator === "undefined" ? null : navigator) {
  if (nav && nav.onLine === false) return true;
  if (isRequestTimeoutError(error)) return true;
  return NETWORK_ERROR_RE.test(String(error?.message || ""));
}

// A pinned replay token can expire while the SDK waits on Auth again. This
// rejection applied no change: retain the entry for the next pass, whose
// executor revalidates its owner and pins that member's freshly read token.
// Invalid JWTs and ordinary authorization/validation refusals stay terminal.
function isExpiredJwtError(error) {
  return ["PGRST301", "PGRST303"].includes(error?.code)
    && /\bjwt expired\b/i.test(String(error?.message || ""));
}

// Who owned a stored record.
//
// A departure purge has to tell the DEPARTED member's residue from work a
// REPLACEMENT session wrote while the purge was still in flight, and the bytes
// on disk cannot say which is which. "Delete it unless it changed since I read
// it" gets that backwards for erasure: the departed session lands a TRAILING
// sensitive write after the capture (App enqueues the write and only then
// throws in assertCurrent — nothing undoes the write), and a cold start that
// restores no session has no departed user id to scope by at all. So every
// write records the session that made it:
//
//   sessionLineage    the auth session_id. Unlike deviceBoot/generation, it is
//                     comparable across tabs, so one tab cannot erase a fresh
//                     replacement session written by another.
//   deviceBoot        unique per page load. This remains the compatibility
//                     fence for records written before sessionLineage shipped.
//   sessionGeneration sessionGuard's identity counter for this load. A
//                     replacement login is strictly higher than the departure;
//                     the departed session's own late writes are equal to it.
//
// Neither is member data: a random per-load id and a small integer, read by
// nothing but this erasure.
const deviceBootUuid = globalThis.crypto?.randomUUID?.();
const DEVICE_BOOT = typeof deviceBootUuid === "string" && deviceBootUuid
  ? deviceBootUuid
  : `boot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function sessionStamp(sessionGeneration = 0, deviceBoot = DEVICE_BOOT, sessionLineage = null) {
  return {
    deviceBoot,
    sessionGeneration,
    ...(typeof sessionLineage === "string" && sessionLineage ? { sessionLineage } : {}),
  };
}

// True when `record` cannot belong to a session that STARTED after the
// departure — so it is the departed device's to erase. A record with no stamp
// at all was written before this field existed and is residue by definition.
export function isDepartedSessionResidue(record, departure) {
  if (!record) return false;
  if (typeof record.sessionLineage === "string" && record.sessionLineage) {
    if (typeof departure.sessionLineage === "string" && departure.sessionLineage) {
      if (record.sessionLineage === departure.sessionLineage) return true;
    }
    // `undefined` means the shared auth slot could not be inspected. Preserve
    // lineage-stamped records rather than deleting a possibly active session.
    if (departure.activeSessionLineage === undefined) return false;
    return record.sessionLineage !== departure.activeSessionLineage;
  }
  if (record.deviceBoot !== departure.deviceBoot) return true;
  return (record.sessionGeneration ?? 0) <= departure.sessionGeneration;
}

// Enumerate-then-delete cannot see a sensitive write that creates a NEW key
// after the purge read the store, so a departure also closes the door behind
// itself: this store refuses another sensitive write from a session at or
// below the departed generation. Keyed by store rather than module-wide, so
// two stores never share a fence.
const departedGenerations = new WeakMap();

function closeDepartedSessions(store, { deviceBoot, sessionGeneration }) {
  let byBoot = departedGenerations.get(store);
  if (!byBoot) {
    byBoot = new Map();
    departedGenerations.set(store, byBoot);
  }
  const closed = byBoot.get(deviceBoot);
  if (closed === undefined || closed < sessionGeneration) byBoot.set(deviceBoot, sessionGeneration);
}

function sessionHasDeparted(store, { deviceBoot, sessionGeneration }) {
  const closed = departedGenerations.get(store)?.get(deviceBoot);
  return closed !== undefined && sessionGeneration <= closed;
}

// A write from one auth lineage must never overwrite another lineage's durable
// value merely because its tab has not received the auth event yet. Wall-clock
// timestamps cannot order sessions: request completion stamps arrive late and
// device clocks can move backwards. The replacement session's sign-in purge
// removes the departed lineage first; once another lineage is present under
// the same key, only that exact lineage may update it. Lineage-less legacy
// records remain replaceable, while a lineage-less incoming write may not
// replace a lineage-aware record.
function mayReplaceStoredLineage(current, incoming, readActiveSessionLineage, requireActive = false) {
  const incomingLineage = typeof incoming.sessionLineage === "string" && incoming.sessionLineage
    ? incoming.sessionLineage
    : null;
  let activeLineage;
  if (requireActive && typeof readActiveSessionLineage === "function") {
    try {
      activeLineage = readActiveSessionLineage() || null;
    } catch {
      return false;
    }
    if (incomingLineage !== activeLineage) return false;
  }
  if (!current) return true;
  const currentLineage = typeof current.sessionLineage === "string" && current.sessionLineage
    ? current.sessionLineage
    : null;
  if (!currentLineage) return true;
  if (!incomingLineage) return false;
  if (currentLineage === incomingLineage) return true;
  if (requireActive && typeof readActiveSessionLineage === "function") return true;
  try {
    activeLineage = readActiveSessionLineage?.() || null;
  } catch {
    return false;
  }
  return incomingLineage === activeLineage;
}

function openDb(idb) {
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(QUEUE)) db.createObjectStore(QUEUE, { keyPath: "k" });
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: "userId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

// IndexedDB-backed store. Opens lazily on first use and reuses the connection.
// Every method rejects on storage failure — callers treat storage as
// best-effort and catch.
export function createIdbStore(idb = typeof indexedDB === "undefined" ? null : indexedDB) {
  if (!idb) return null;
  let dbPromise = null;
  const db = () => {
    if (!dbPromise) {
      dbPromise = openDb(idb).catch((error) => {
        // A failed open must not poison every later call with the same
        // rejected promise if the environment recovers (e.g. quota freed).
        dbPromise = null;
        throw error;
      });
    }
    return dbPromise;
  };
  const inStore = async (name, mode, work) => {
    const handle = await db();
    return work(handle.transaction(name, mode).objectStore(name));
  };
  const deleteWhere = (name, key, matches) =>
    inStore(name, "readwrite", (store) => new Promise((resolve, reject) => {
      const request = store.openCursor(key);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && matches(cursor.value)) cursor.delete();
        resolve();
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    }));
  const putEntryWhere = (entry, allows) =>
    inStore(QUEUE, "readwrite", (store) => new Promise((resolve, reject) => {
      // Queue capacity and the put must share this transaction, including
      // across tabs with separate connections. An earlier list is only a
      // snapshot: concurrent new keys can all observe the same free slot.
      const request = store.getAll();
      request.onsuccess = () => {
        const entries = request.result;
        const current = entries.find((row) => row.k === entry.k);
        // Discard fences take no queue slot (#8966 final r7s2/r8s2).
        if (!current && entries.filter((row) => row.userId === entry.userId && row.kind !== DISCARD_FENCE_KIND).length >= MAX_QUEUE_PER_USER) {
          resolve(false);
          return;
        }
        let allowed;
        try {
          allowed = allows(current || null);
        } catch (error) {
          reject(error);
          return;
        }
        if (!allowed) {
          resolve(false);
          return;
        }
        const put = store.put(entry);
        put.onsuccess = () => resolve(true);
        put.onerror = () => reject(put.error || new Error("IndexedDB request failed"));
      };
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    }));
  return {
    kind: "idb",
    putEntry: (entry) => inStore(QUEUE, "readwrite", (store) => requestToPromise(store.put(entry))),
    putEntryIf: (entry, allows) => putEntryWhere(entry, allows),
    // Conditional delete in ONE readwrite transaction: the cursor's success
    // handler decides and deletes synchronously, so no foreground putEntry
    // can land between the read and the delete (a separate get-then-delete
    // pair leaves exactly that gap). `matches` must therefore be synchronous.
    deleteEntryIfUnchanged: (k, queuedAt) => deleteWhere(QUEUE, k, (entry) => entry.queuedAt === queuedAt),
    deleteEntryIf: (k, matches) => deleteWhere(QUEUE, k, matches),
    getEntry: async (k) => (await inStore(QUEUE, "readonly", (store) => requestToPromise(store.get(k)))) || null,
    listEntries: async (userId) => {
      const all = await inStore(QUEUE, "readonly", (store) => requestToPromise(store.getAll()));
      return (all || []).filter((entry) => entry.userId === userId);
    },
    listAllEntries: async () => (
      await inStore(QUEUE, "readonly", (store) => requestToPromise(store.getAll()))
    ) || [],
    // Unconditional delete, unlike deleteEntryIfUnchanged above: a sign-out
    // purge must take the entry even if a foreground write coalesced a newer
    // one under the same key while the purge was in flight. "Unless it changed"
    // is the right rule for replay bookkeeping and the wrong one for erasure.
    deleteEntry: (k) => inStore(QUEUE, "readwrite", (store) => requestToPromise(store.delete(k))),
    // Plants a row as an older build left it; only tests call it.
    putSnapshot: (snapshot) => inStore(SNAPSHOTS, "readwrite", (store) => requestToPromise(store.put(snapshot))),
    getSnapshot: async (userId) => (await inStore(SNAPSHOTS, "readonly", (store) => requestToPromise(store.get(userId)))) || null,
    listSnapshots: async () => (
      await inStore(SNAPSHOTS, "readonly", (store) => requestToPromise(store.getAll()))
    ) || [],
    deleteSnapshot: (userId) => inStore(SNAPSHOTS, "readwrite", (store) => requestToPromise(store.delete(userId))),
    deleteSnapshotIf: (userId, matches) => deleteWhere(SNAPSHOTS, userId, matches),
  };
}

// In-memory twin: the test backend and the runtime fallback when IndexedDB is
// unavailable. Queued writes then survive the tab, not the browser — strictly
// better than losing them at the moment of the failed request.
export function createMemoryStore() {
  const queue = new Map();
  const snapshots = new Map();
  return {
    kind: "memory",
    putEntry: async (entry) => { queue.set(entry.k, entry); },
    putEntryIf: async (entry, allows) => {
      const current = queue.get(entry.k);
      // Discard fences take no queue slot (#8966 final r7s2/r8s2).
      if (!current && [...queue.values()].filter((row) => row.userId === entry.userId && row.kind !== DISCARD_FENCE_KIND).length >= MAX_QUEUE_PER_USER) return false;
      if (!allows(current || null)) return false;
      queue.set(entry.k, entry);
      return true;
    },
    // Synchronous compare-and-delete — no await between the read and the
    // delete, matching the IDB store's single-transaction guarantee.
    deleteEntryIfUnchanged: async (k, queuedAt) => {
      const current = queue.get(k);
      if (current && current.queuedAt === queuedAt) queue.delete(k);
    },
    deleteEntryIf: async (k, matches) => {
      const current = queue.get(k);
      if (current && matches(current)) queue.delete(k);
    },
    getEntry: async (k) => queue.get(k) || null,
    listEntries: async (userId) => [...queue.values()].filter((entry) => entry.userId === userId),
    listAllEntries: async () => [...queue.values()],
    deleteEntry: async (k) => { queue.delete(k); },
    putSnapshot: async (snapshot) => { snapshots.set(snapshot.userId, snapshot); },
    getSnapshot: async (userId) => snapshots.get(userId) || null,
    listSnapshots: async () => [...snapshots.values()],
    deleteSnapshot: async (userId) => { snapshots.delete(userId); },
    deleteSnapshotIf: async (userId, matches) => {
      const current = snapshots.get(userId);
      if (current && matches(current)) snapshots.delete(userId);
    },
  };
}

export function createOutboxStore() {
  return createIdbStore() || createMemoryStore();
}

let queueWriteSequence = 0;

function createQueueWriteToken() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid) return uuid;
  queueWriteSequence += 1;
  return `queue-${Date.now().toString(36)}-${queueWriteSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// One queued write. `key` scopes coalescing: a second save to the same target
// (same lesson, same conversation, same settings field group) REPLACES the
// first, so replay applies only the newest state and the queue cannot grow by
// repetition. args must be plain JSON — they are frozen at enqueue time and
// cross a structured-clone boundary.
export async function enqueueWrite(store, userId, queueable, ...rest) {
  if (queueable?.kind !== "formDraft") return enqueueUnlocked(store, userId, queueable, ...rest);
  // A form save is queued under its entry's lock, and never when a discard
  // confirmed meanwhile voids it (#8966 final r6s1).
  return withQueuedEntryLock(`${userId}|${queueable.kind}|${queueable.key}`, async () => (
    (await fencedByDiscard(store, { userId, kind: queueable.kind, args: queueable.args, startedAt: queueable.startedAt }))
      ? false
      : enqueueUnlocked(store, userId, queueable, ...rest)));
}
async function enqueueUnlocked(
  store,
  userId,
  { kind, key, args, startedAt },
  now = Date.now(),
  stamp = sessionStamp(),
  stillCurrent = () => true,
  readActiveSessionLineage = null,
) {
  // A session that has already departed must not be able to put the member's
  // words back on the device behind the purge that just erased them. Only the
  // sensitive kinds are refused: the rest survive a departure for their owner
  // by design and replay when that member signs back in.
  const sensitive = SENSITIVE_OUTBOX_KINDS.includes(kind);
  if (!stillCurrent() || (sensitive && sessionHasDeparted(store, stamp))) return false;
  const entries = (await store.listEntries(userId)).filter((entry) => entry.kind !== DISCARD_FENCE_KIND);
  const k = `${userId}|${kind}|${key}`;
  const existing = entries.find((entry) => entry.k === k);
  if (!existing && entries.length >= MAX_QUEUE_PER_USER) return false;
  // A coalescing replacement is stamped STRICTLY newer than what it replaces,
  // even same-millisecond or across a backwards clock jump. Overlapping
  // writers can both have read the same earlier list, so this timestamp orders
  // replay while the unique writeToken identifies the exact value to remove.
  const queuedAt = existing ? Math.max(now, existing.queuedAt + 1) : now;
  // The list operation above yields. A departure can close and finish its
  // purge while this operation is suspended, so check again at the commit
  // boundary and verify after the asynchronous put as well. The unique token
  // lets cleanup remove only this late write if a replacement tab already
  // coalesced a newer value under the same key.
  if (!stillCurrent() || (sensitive && sessionHasDeparted(store, stamp))) return false;
  const writeToken = createQueueWriteToken();
  const entry = { k, userId, kind, args, queuedAt, writeToken, ...(Number.isFinite(startedAt) ? { startedAt } : {}), ...stamp };
  const committed = await store.putEntryIf(
    entry,
    (current) => stillCurrent()
      && (!sensitive || !sessionHasDeparted(store, stamp))
      && mayReplaceStoredLineage(current, entry, readActiveSessionLineage, sensitive),
  );
  if (!committed) return false;
  if (!stillCurrent() || (sensitive && sessionHasDeparted(store, stamp))) {
    await store.deleteEntryIf(k, (entry) => entry.writeToken === writeToken);
    return false;
  }
  return true;
}

export async function pendingCount(store, userId) {
  return (await store.listEntries(userId)).filter((entry) => entry.kind !== DISCARD_FENCE_KIND).length;
}

// Holds the queued entry under `key` while `work` runs: it stays in storage
// (a tab closed meanwhile loses nothing), every replay pass in every tab skips
// it while it is held (read again under the lock, so one queued by another tab
// is held too), and only a result `work` confirmed removes it, and only if it is
// still the entry that was held. A refusal, a throw or a superseded answer
// (undefined) leaves it queued, and a newer entry queued under the key in
// between is never touched (#8966 round 1 r1s1/r2s2: a discard refused
// offline must not cost the member the answers still waiting to sync).
// The queue is one IndexedDB store shared by every tab of this browser, so a
// hold must reach them all: a discard and a replay of the same queued entry
// take the same Web Lock. Only a real window realm has a shared LockManager
// (Node exposes one that serializes nothing across tabs); without it, the hold
// covers this tab only. A lock dies with its tab, so a closed or crashed tab
// never leaves an entry held.
function queuedEntryLocks() {
  try {
    return globalThis.window?.navigator?.locks?.request ? globalThis.window.navigator.locks : null;
  } catch { // swallow-ok: a realm whose navigator cannot be read has no shared LockManager; the hold then covers this tab
    return null;
  }
}
function withQueuedEntryLock(name, operation) {
  const locks = queuedEntryLocks();
  return locks ? locks.request(`outbox-entry:${name}`, { mode: "exclusive" }, operation) : operation();
}
// A confirmed discard leaves a fence in the shared queue: an unbound form save
// of that member's template begun before the discard confirmed is void. Such a
// save is the draft's own first save whose reply was lost (it created the
// draft and never learned its id), so it is neither queued nor replayed, in
// any tab, however late it fails (#8966 final r6s1). A refused discard leaves
// no fence. The fence outlives every entry it can void.
export const DISCARD_FENCE_KIND = "formDraftDiscarded";
const DISCARD_FENCE_KEPT_MS = MAX_ENTRY_AGE_MS + 86400000;
const fenceName = (userId, templateKey) => `${userId}|${DISCARD_FENCE_KIND}|${templateKey}`;
async function fencedByDiscard(store, entry) {
  const fields = entry.args?.fields;
  if (entry.kind !== "formDraft" || !fields?.templateKey || fields.formId || !store.getEntry) return false;
  const fence = await store.getEntry(fenceName(entry.userId, fields.templateKey));
  const started = Number.isFinite(entry.startedAt) ? entry.startedAt : entry.queuedAt;
  return Boolean(fence) && Number.isFinite(started) && started <= fence.args?.before;
}
async function putDiscardFence(store, { userId, templateKey }) {
  if (!userId || !templateKey || !store.putEntry) return;
  const at = Date.now();
  await store.putEntry({ k: fenceName(userId, templateKey), userId, kind: DISCARD_FENCE_KIND, queuedAt: at,
    writeToken: createQueueWriteToken(), args: { templateKey, before: at } });
}
const heldEntries = new WeakMap();
function holdCounts(store) {
  let counts = heldEntries.get(store);
  if (!counts) { counts = new Map(); heldEntries.set(store, counts); }
  return counts;
}
export function queuedEntryHeld(store, key) {
  return Boolean(store && heldEntries.get(store)?.get(key));
}
export async function holdQueuedEntryWhile(store, key, work, { fence = null } = {}) {
  if (!key || !store) return work();
  return withQueuedEntryLock(key, () => holdInThisTab(store, key, work, fence));
}
async function holdInThisTab(store, key, work, fence) {
  const counts = holdCounts(store);
  counts.set(key, (counts.get(key) || 0) + 1);
  try {
    const held = store.getEntry ? await store.getEntry(key).catch(() => null) : null; // swallow-ok: an entry that cannot be read is never deleted unread; it stays queued
    const result = await work();
    if (result && held && store.deleteEntryIf) {
      await store.deleteEntryIf(key, (current) => current.queuedAt === held.queuedAt && current.writeToken === held.writeToken);
    }
    if (result && fence) await putDiscardFence(store, fence);
    return result;
  } finally {
    const left = counts.get(key) - 1;
    if (left > 0) counts.set(key, left);
    else counts.delete(key);
  }
}

// An executor that may not send its entry yet (a form replay while the
// member's own save of that form is on its way, #8938) throws an error with
// this code: the entry stays queued, unsent and unreported, the pass goes on
// to the next entry, and a later pass replays it.
export const OUTBOX_REPLAY_DEFERRED = "OUTBOX_REPLAY_DEFERRED";

// Replay the queue for ONE user, oldest first. The caller gates the pass on
// the current session actually being that user (and on the MFA gate having
// cleared) — the store itself keeps other users' entries untouched so they
// replay when their owner signs back in.
//
// `stillActing` is re-checked before EVERY executor call, not just per pass:
// the shared supabase client's token flips the instant the tab's identity
// changes (a magic link completing in another tab), and an executor that runs
// after that writes under the WRONG member — the RPCs derive auth.uid()
// server-side, and the RLS-filtered updates would "succeed" with zero rows
// and be deleted as replayed. An identity change halts without deleting, the
// same as losing the network: the entries are still the owner's to replay.
//
// Per entry: success deletes it ONLY if the stored entry is still the one
// that executed (a foreground write can coalesce a NEWER entry under the same
// key mid-flight — deleting by key alone would silently discard it); a
// network-shaped failure halts the pass (the connection is gone again —
// everything after would fail the same way). An expired JWT also halts and
// retains the entry for a freshly validated owner/token; other failures are terminal
// for that entry — it is dropped and reported, because a server that
// rejected the write once will reject the replay too.
export async function replayQueue(store, userId, executors, {
  now = Date.now(),
  stillActing = () => true,
  activeSessionLineage = null,
} = {}) {
  const entries = (await store.listEntries(userId)).sort((a, b) => a.queuedAt - b.queuedAt);
  const result = { replayed: 0, failed: [], expired: 0, halted: false };
  // Atomic in the store layer: a foreground write that coalesces a newer entry
  // under the same key mid-flight keeps its entry — only the exact entry that
  // executed is removed.
  const deleteIfUnchanged = (entry) => store.deleteEntryIf(entry.k, (current) => (
    current.queuedAt === entry.queuedAt && current.writeToken === entry.writeToken
  ));
  for (const entry of entries) {
    if (!stillActing()) {
      result.halted = true;
      return result;
    }
    // Each entry is replayed under its cross-tab lock, so it never runs while
    // a discard in any tab holds it, and is read again under that lock
    // (#8966 final r3s2).
    const outcome = await withQueuedEntryLock(entry.k, async () => {
      // The identity can change while the lock is awaited.
      if (!stillActing()) return "halt";
      // Held by a discard in this tab still waiting for the server.
      if (queuedEntryHeld(store, entry.k)) return "skip";
      // The pass listed its entries up front. One removed from storage since
      // then (a discarded form draft, a purge), or replaced there by a newer
      // entry under its key, is not executed (#8309 gate round 1 and final); a
      // store without getEntry keeps the earlier behavior.
      if (typeof store.getEntry === "function") {
        const current = await store.getEntry(entry.k);
        if (!current || current.queuedAt !== entry.queuedAt || current.writeToken !== entry.writeToken) return "skip";
        // The identity can change while that read is pending.
        if (!stillActing()) return "halt";
      }
      if (entry.kind === DISCARD_FENCE_KIND) {
        if (now - entry.queuedAt > DISCARD_FENCE_KEPT_MS) await deleteIfUnchanged(entry);
        return "skip";
      }
      // Voided by a confirmed discard: dropped and reported, never sent. The
      // identity can change while the fence is read, so it is checked again
      // before anything is deleted or sent (#8966 final r7s1/r8s1).
      const fenced = await fencedByDiscard(store, entry);
      if (!stillActing()) return "halt";
      if (fenced) {
        await deleteIfUnchanged(entry);
        result.failed.push({ kind: entry.kind, message: "form draft discarded" });
        return "skip";
      }
      if (SENSITIVE_OUTBOX_KINDS.includes(entry.kind)
        && typeof entry.sessionLineage === "string" && entry.sessionLineage
        && entry.sessionLineage !== activeSessionLineage) {
        // Same-user sign-in replacements keep the same userId. Never replay a
        // departed session's sensitive payload under the replacement token while
        // its best-effort device sweep is still pending or has failed.
        await deleteIfUnchanged(entry);
        return "skip";
      }
      if (now - entry.queuedAt > MAX_ENTRY_AGE_MS) {
        await deleteIfUnchanged(entry);
        result.expired += 1;
        return "skip";
      }
      const executor = executors[entry.kind];
      if (!executor) {
        await deleteIfUnchanged(entry);
        result.failed.push({ kind: entry.kind, message: "unknown outbox kind" });
        return "skip";
      }
      try {
        await executor(entry.args);
      } catch (error) {
        // A save that stopped because the signed-in member changed sent
        // nothing: the entry stays its owner's to replay (#8966 held-commit
        // review).
        if (isOfflineError(error) || !stillActing() || error?.code === "SESSION_CHANGED" || isExpiredJwtError(error)) return "halt";
        if (error?.code === OUTBOX_REPLAY_DEFERRED) return "skip";
        await deleteIfUnchanged(entry);
        result.failed.push({ kind: entry.kind, message: String(error?.message || error) });
        return "skip";
      }
      await deleteIfUnchanged(entry);
      result.replayed += 1;
      return "done";
    });
    if (outcome === "halt") {
      result.halted = true;
      return result;
    }
  }
  return result;
}

// An explicit sign-out is a request to leave this device clean: the session
// token dies, and any saved copy of the member's cases/messages/forms an older
// build left behind must die with it — a shared terminal keeps only what the
// next member writes. App also erases that leftover at every sign-in.
// Most of the QUEUE deliberately survives sign-out (unsent changes belong to
// their owner and replay when that member signs back in); a queued rsvp or
// read-mark is one small frozen write, not the member's whole portal. The two
// exceptions are below.
export async function deleteSnapshot(store, userId) {
  await store.deleteSnapshot(userId);
}

// The two queue kinds that are NOT "one small frozen write". A formDraft entry
// carries the free text a member typed into a grievance or accommodation form —
// their account of a discipline meeting, a medical reason, names of coworkers.
// A profile entry carries their legal name, address, and phone. Both sat in
// IndexedDB after sign-out, unencrypted, readable by the next person to open
// devtools on a shared union-hall terminal, and account deletion left them
// behind too: the row was gone from Postgres while the payload stayed on the
// device.
//
// The trade is honest and deliberate. An unsent draft queued while offline is
// LOST when the member signs out on that device, rather than replaying on their
// next sign-in. That is the correct direction for a payload this sensitive on a
// shared machine — and a draft is recoverable by retyping, while a disclosure is
// not recoverable at all. Every other kind (rsvp, rightsProgress, broadcastRead,
// conversationRead, notificationsRead, settings) still survives and replays.
export const SENSITIVE_OUTBOX_KINDS = Object.freeze(["formDraft", "profile"]);

// Scoped to ONE user: another member's queued entries on the same device are
// theirs, still unsent, and are not this sign-out's to erase.
export async function purgeSensitiveEntries(store, userId, kinds = SENSITIVE_OUTBOX_KINDS) {
  const entries = await store.listEntries(userId);
  for (const entry of entries) {
    if (kinds.includes(entry.kind)) await store.deleteEntry(entry.k);
  }
}

// A session can also end on this device without anybody pressing "Sign out":
// the refresh token expires, another device revokes this one from
// Settings > Sessions, an admin deactivates the account, or a peer tab writes
// the durable closed-lineage tombstone. The member is just as gone and the
// shared terminal must be left just as clean, so the two erasures above travel
// together. Best-effort on purpose: a storage failure must not wedge the
// session teardown a departing member is already waiting on.
//
// The erasure is fenced by the session that WROTE each record, never by the
// version that was on disk when the purge read it (see isDepartedSessionResidue
// above). That is what lets it be unconditional in the direction that matters —
// the departed member's trailing draft goes even though it is newer than the
// capture — while a replacement login's work, written under a later
// generation, stays.
//
// `departedUserId` null is still a no-op. The implicit paths can observe a
// departure with no user id at all (a tab that never held a session, a
// cross-tab payload without user.id), and erasing "everyone" there would
// delete the member who is actually signed in on this device. Only a caller
// that KNOWS nobody is signed in — the cold start whose auth storage restores
// no session — may ask for { allOwners: true }, and it has to say so out loud.
export async function forgetDepartedMemberDevice(store, departedUserId, {
  allOwners = false,
  // No fence given means no stored session is spared by the erasure predicate,
  // but it must not permanently close the write door for every later session.
  // Every caller that can name its departed generation passes a finite value.
  sessionGeneration = null,
  deviceBoot = DEVICE_BOOT,
  sessionLineage = null,
  readActiveSessionLineage = () => null,
} = {}) {
  if (!departedUserId && !allOwners) return;
  const hasSessionFence = Number.isFinite(sessionGeneration);
  const departure = {
    deviceBoot,
    sessionGeneration: hasSessionFence ? sessionGeneration : Number.MAX_SAFE_INTEGER,
    sessionLineage,
  };
  // Close the door before reading, not after deleting: enumerate-then-delete
  // cannot catch a sensitive write that arrives under a NEW key.
  if (hasSessionFence) closeDepartedSessions(store, departure);
  const read = async (records) => {
    try {
      return (await records()) || [];
    } catch {
      return [];
    }
  };
  const [snapshots, entries] = await Promise.all([
    read(() => (allOwners
      ? store.listSnapshots()
      : store.getSnapshot(departedUserId).then((snapshot) => (snapshot ? [snapshot] : [])))),
    read(() => (allOwners ? store.listAllEntries() : store.listEntries(departedUserId))),
  ]);
  const residue = (record) => {
    let activeSessionLineage;
    try {
      activeSessionLineage = readActiveSessionLineage();
    } catch {
      // Losing access to the shared auth slot must fail closed for erasure:
      // preserve a lineage-stamped record that may belong to an active tab.
      activeSessionLineage = undefined;
    }
    return isDepartedSessionResidue(record, {
      ...departure,
      activeSessionLineage,
    });
  };
  const deletions = [
    ...snapshots.map((snapshot) => Promise.resolve().then(() => (
      store.deleteSnapshotIf(snapshot.userId, residue)
    ))),
    ...entries
      .filter((entry) => SENSITIVE_OUTBOX_KINDS.includes(entry.kind))
      .map((entry) => Promise.resolve().then(() => store.deleteEntryIf(entry.k, residue))),
  ];
  await Promise.allSettled(deletions);
}
