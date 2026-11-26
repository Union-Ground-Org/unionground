// Scope exists only in the foreground process. Never send it to the widget.
export type HomeWidgetScope = { userID: string; sessionID: string; organizationID: string; chapterID: string };
export type HomeWidgetSnapshot = { today: number; unread: number; updatedAt: number; expiresAt: number };
export const HOME_WIDGET_TTL_MS = 5 * 60 * 1_000;

export function sameWidgetScope(a: HomeWidgetScope | null, b: HomeWidgetScope | null): boolean {
  return a !== null && b !== null && a.userID === b.userID && a.sessionID === b.sessionID
    && a.organizationID === b.organizationID && a.chapterID === b.chapterID;
}

export function widgetSnapshot(today: number, unread: number, now = Date.now()): HomeWidgetSnapshot {
  if (![today, unread, now].every(Number.isSafeInteger) || today < 0 || unread < 0 || today > 2_147_483_647 || unread > 2_147_483_647 || now <= 0) {
    throw new Error('Widget counts unavailable.');
  }
  // Today must also expire at the device's next local midnight.
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return { today, unread, updatedAt: now, expiresAt: Math.min(now + HOME_WIDGET_TTL_MS, midnight.getTime()) };
}

export function widgetSnapshotIsFresh(snapshot: HomeWidgetSnapshot, now = Date.now()): boolean {
  return Number.isSafeInteger(snapshot.today) && snapshot.today >= 0
    && Number.isSafeInteger(snapshot.unread) && snapshot.unread >= 0
    && snapshot.updatedAt <= now && snapshot.expiresAt > now
    && snapshot.expiresAt > snapshot.updatedAt && snapshot.expiresAt - snapshot.updatedAt <= HOME_WIDGET_TTL_MS;
}

type Adapter = {
  resetAsync(generation: string): Promise<void>;
  publishAsync(generation: string, today: number, unread: number, updatedAt: number, expiresAt: number): Promise<void>;
};

// One native generation fences writes already in flight when a scope changes.
// Consent deliberately lives only in memory: each cold launch/sign-in starts off.
export function createHomeWidgetController(adapter: Adapter, nonce: () => string) {
  let scope: HomeWidgetScope | null = null;
  let enabled = false;
  let suspended = false;
  let generation = nonce();
  let request = 0;
  let barrier = Promise.resolve();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  function clear() {
    generation = nonce();
    request += 1;
    const captured = generation;
    // Ordering guarantees a reset cannot be overtaken by the next publication.
    barrier = barrier.catch(() => undefined).then(() => adapter.resetAsync(captured));
    return barrier;
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    enabled: () => enabled && !suspended,
    suspend() {
      if (suspended) return barrier;
      suspended = true;
      emit();
      return clear();
    },
    setScope(next: HomeWidgetScope | null) {
      if (sameWidgetScope(scope, next)) {
        if (!suspended) return;
        suspended = false;
        emit();
        return barrier;
      }
      scope = next;
      enabled = false;
      suspended = false;
      emit();
      return clear();
    },
    disable() { enabled = false; suspended = false; scope = null; emit(); return clear(); },
    async enable(expected: HomeWidgetScope) {
      if (suspended || !sameWidgetScope(scope, expected)) throw new Error('Open your signed-in workspace first.');
      const reset = clear();
      const captured = generation;
      await reset;
      if (suspended || captured !== generation || !sameWidgetScope(scope, expected)) return;
      enabled = true;
      emit();
    },
    async refresh(expected: HomeWidgetScope, read: () => Promise<HomeWidgetSnapshot>) {
      if (!enabled || suspended || !sameWidgetScope(scope, expected)) return;
      const captured = generation;
      const attempt = ++request;
      const current = () => enabled && !suspended && captured === generation && attempt === request && sameWidgetScope(scope, expected);
      try {
        await barrier;
        if (!current()) return;
        const snapshot = await read();
        if (!current()) return;
        if (!widgetSnapshotIsFresh(snapshot)) throw new Error('Widget counts unavailable.');
        await adapter.publishAsync(captured, snapshot.today, snapshot.unread, snapshot.updatedAt, snapshot.expiresAt);
      } catch {
        if (current()) await clear();
        throw new Error('Widget counts unavailable. Open the app and try again.');
      }
    },
  };
}
