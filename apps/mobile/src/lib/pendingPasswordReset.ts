// BUG-UG-RESET-LINK-SPENT-ON-PAGE-OPEN-20261018. Opening the emailed
// link spends it (begin verifies GoTrue's recovery token), so an OS kill or a
// relaunch while the member is setting up an authenticator would otherwise end
// the reset. The server's sealed state stays valid for 15 minutes
// (STATE_TTL_SECONDS in api/_lib/passwordReset.js); this keeps it, and the
// enrolment key the server sends only once, in the platform keystore for no
// longer than that.
export const PENDING_RESET_KEY = 'password-reset-pending';
export const RESET_STATE_LIFETIME_MS = 15 * 60 * 1000;

// `account` is the server's opaque account tag; a record saved before the tag
// existed has none, and an unknown account never matches another one.
export type PendingReset = { ticket: string; status: 'challenge' | 'enroll'; state: string; secret: string; account?: string };
const RESET_ACCOUNT = /^a1\.[A-Za-z0-9_-]{22}$/;
export function resetAccount(value: unknown): string | null {
  return typeof value === 'string' && RESET_ACCOUNT.test(value) ? value : null;
}
export function sameResetAccount(saved: string | null | undefined, changed: string | null | undefined): boolean {
  return resetAccount(saved) !== null && resetAccount(saved) === resetAccount(changed);
}
export type PendingResetStore = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};
type ResetAttempt = { startedAt: number; order: number };

// The keystore module loads on first use, so screens that only import this
// file (and their tests) never pull in the native secure-store module.
const keystore: PendingResetStore = {
  getItem: async (key) => (await import('./secureSessionStorage')).secureSessionStorage.getItem(key),
  setItem: async (key, value) => (await import('./secureSessionStorage')).secureSessionStorage.setItem(key, value),
  removeItem: async (key) => (await import('./secureSessionStorage')).secureSessionStorage.removeItem(key),
};

// One begin per ticket at a time: a second mount while the first request is
// in flight shares its answer instead of spending the used link again.
const beginsInFlight = new Map<string, Promise<unknown>>();
let beginOrder = 0;
let beginSlot: Promise<unknown> = Promise.resolve();
export function shareBegin<T>(ticket: string, run: (attempt: ResetAttempt) => Promise<T>): Promise<T> {
  const running = beginsInFlight.get(ticket) as Promise<T> | undefined;
  if (running) return running;
  const attempt = { startedAt: Date.now(), order: ++beginOrder };
  // Different tickets may replace the same server-side unverified factor.
  // Keep that mutation and its local save together, so a late first request
  // cannot delete the factor belonging to the recovery saved by the second.
  const started = beginSlot.then(() => run(attempt)).finally(() => { beginsInFlight.delete(ticket); });
  beginSlot = started.catch(() => undefined);
  beginsInFlight.set(ticket, started);
  return started;
}

// Reads, replacements and conditional deletes share one queue, including the
// async keystore operations. A late read must not delete a replacement either.
let pendingSlot: Promise<unknown> = Promise.resolve();
const latestSavedOrder = new WeakMap<PendingResetStore, number>();
function inPendingSlot<T>(run: () => Promise<T>): Promise<T> {
  const result = pendingSlot.then(run);
  pendingSlot = result.catch(() => undefined);
  return result;
}

export function clearPendingReset(state: string, store: PendingResetStore = keystore): Promise<void> {
  return inPendingSlot(async () => {
    try {
      const raw = await store.getItem(PENDING_RESET_KEY);
      const saved: unknown = raw === null ? null : JSON.parse(raw);
      if (saved && typeof saved === 'object' && 'state' in saved && saved.state === state) {
        await store.removeItem(PENDING_RESET_KEY);
      }
    } catch { /* retain an unreadable slot rather than deleting another reset */ }
  });
}

// `startedAt` is read before the begin request, so this record can never
// outlive the server's state, which is sealed after the request arrives.
// `ticket` is the emailed link's sealed ticket, already spent by begin; it
// only tells a second tap of the same link from a newer one.
export function savePendingReset(
  { ticket, startedAt, order, recovery }: ResetAttempt & { ticket: string; recovery: Omit<PendingReset, 'ticket'> },
  store: PendingResetStore = keystore,
): Promise<void> {
  return inPendingSlot(async () => {
    // The begin order is monotonic even if two requests start in the same
    // millisecond or the wall clock moves backwards. Keep it after a clear so
    // an old reply cannot resurrect a reset that a newer attempt completed.
    if (order < (latestSavedOrder.get(store) ?? 0)) return;
    try {
      await store.setItem(PENDING_RESET_KEY, JSON.stringify({
        ticket, expiresAt: startedAt + RESET_STATE_LIFETIME_MS,
        status: recovery.status, state: recovery.state, secret: recovery.secret,
        ...(resetAccount(recovery.account) ? { account: recovery.account } : {}),
      }));
      latestSavedOrder.set(store, order);
    } catch { /* the reset still works in memory, as before */ }
  });
}

// The saved recovery, or null when there is none, it expired, or it is
// damaged (an unusable record is removed so it cannot hide a fresh link).
export function loadPendingReset(
  store: PendingResetStore = keystore,
  nowMs: number = Date.now(),
): Promise<PendingReset | null> {
  return inPendingSlot(async () => {
    try {
      const raw = await store.getItem(PENDING_RESET_KEY);
      if (raw === null) return null;
      const saved: unknown = JSON.parse(raw);
      const record = saved && typeof saved === 'object' ? saved as Record<string, unknown> : null;
      if (record
        && (record.status === 'challenge' || record.status === 'enroll')
        && typeof record.state === 'string' && record.state.length > 0 && record.state.length <= 16_384
        && typeof record.ticket === 'string' && typeof record.secret === 'string'
        && typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        // Only the lapse is checked against the clock: a clock stepped backwards
        // must not make a live record look forged, and the server refuses a
        // lapsed state whatever this record says.
        && record.expiresAt > nowMs) {
        const account = resetAccount(record.account);
        return { ticket: record.ticket, status: record.status, state: record.state, secret: record.secret, ...(account ? { account } : {}) };
      }
      await store.removeItem(PENDING_RESET_KEY);
      return null;
    } catch {
      // The queue keeps cleanup attached to the record read above.
      try { await store.removeItem(PENDING_RESET_KEY); } catch { /* unavailable */ }
      return null;
    }
  });
}
