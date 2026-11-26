// REQ-UG-QUOTES-MINI-LESSONS-20260928: the framework-free state
// machines behind the native Home card and the Learn library. A controller
// belongs to exactly one scope (session, user, organization, chapter and
// locale); a scope change disposes it, so its late answers are dropped and the
// next controller starts empty. Policy comes first and is the only thing
// polled; content is read only for enabled kinds, only when the policy version
// or switches change, and never for a hidden Home. Delivery and the day-stable
// rotation are the shared model's, exactly as the web client applies them.

import {
  LEARNING_HOME_BATCH,
  LEARNING_POLICY_POLL_MS,
  isLearningItemEligible,
  isLearningItemLive,
  learningDayKey,
  learningLibraryRequest,
  learningNextStoreKey,
  learningRotationSeed,
  liveLearningCount,
  msUntilNextLocalDay,
  nextLearningBoundary,
  nextLearningIndex,
  orderLearningItems,
  parseLearningRotationState,
  pickLearningItem,
  planLearningHomeLoad,
  serializeLearningRotationState,
  type LearningItem,
  type LearningKindFilter,
  type LearningLocale,
  type LearningPolicy,
} from '../../lib/learningContentModel';
import type { LearningContentApi } from '../../services/learningContent';

/** Local-only Next position storage: a serialized {day, index}, never content. */
export type LearningNextStore = {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
};

export function createMemoryLearningNextStore(): LearningNextStore {
  const values = new Map<string, string>();
  return {
    async read(key) { return values.get(key) ?? null; },
    async write(key, value) { values.set(key, value); },
  };
}

export type LearningScopeContext = {
  scopeKey: string;
  source: 'live' | 'preview';
  userId: string;
  organizationId: string | null;
  chapterId: string | null;
  locale: LearningLocale;
  api: LearningContentApi;
  nextStore: LearningNextStore;
  /** Captures the current session; the returned check fails once it changes. */
  captureGuard: () => () => boolean;
  clock?: () => number;
};

type Listener = () => void;

function createEmitter() {
  const listeners = new Set<Listener>();
  return {
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit() { listeners.forEach((listener) => listener()); },
    clear() { listeners.clear(); },
  };
}

/**
 * Focus/foreground activity plus the one-minute policy poll. Becoming active
 * refreshes at once (focus or foreground); staying active refreshes every
 * minute; covered or backgrounded screens read nothing.
 */
function createPolicyPoller(refresh: () => void) {
  let active = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (interval !== null) clearInterval(interval);
    interval = null;
  };
  return {
    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      stop();
      if (!next) return;
      refresh();
      interval = setInterval(refresh, LEARNING_POLICY_POLL_MS);
    },
    stop() {
      active = false;
      stop();
    },
  };
}

/** Re-renders at the next start or end among cached items, or local midnight. */
function createBoundaryTimer(onBoundary: () => void, clock: () => number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule(items: readonly LearningItem[]) {
      stop();
      const now = clock();
      const boundary = nextLearningBoundary(items, now);
      const untilMidnight = msUntilNextLocalDay(new Date(now));
      const wait = boundary === null ? untilMidnight : Math.min(Math.max(boundary - now, 250), untilMidnight);
      timer = setTimeout(() => {
        timer = null;
        onBoundary();
      }, wait);
    },
    stop,
  };
}

function deliveryContext(policy: LearningPolicy, locale: LearningLocale, kinds: { quotes: boolean; lessons: boolean }) {
  return {
    locale,
    quotesEnabled: kinds.quotes,
    lessonsEnabled: kinds.lessons,
    organizationId: policy.organizationId,
    chapterId: policy.chapterId,
  };
}

// ---------------------------------------------------------------------------
// Home

export type LearningHomeStatus = 'idle' | 'loading' | 'ready' | 'hidden' | 'disabled' | 'unavailable';

export type LearningHomeSnapshot = {
  status: LearningHomeStatus;
  policy: LearningPolicy | null;
  items: readonly LearningItem[];
  loaded: boolean;
  itemsVersion: string | null;
  itemsSignature: string | null;
  storedRotation: string | null;
  hiding: boolean;
  hideError: boolean;
  hiddenJustNow: boolean;
  tick: number;
};

export type LearningHomeView = {
  current: LearningItem | null;
  /** Position in the day's ordered list (what Next stores). */
  index: number;
  /** 1-based position among the items live right now. */
  position: number;
  total: number;
};

const EMPTY_VIEW: LearningHomeView = Object.freeze({ current: null, index: 0, position: 0, total: 0 });

export const EMPTY_LEARNING_HOME: LearningHomeSnapshot = Object.freeze({
  status: 'idle',
  policy: null,
  items: [],
  loaded: false,
  itemsVersion: null,
  itemsSignature: null,
  storedRotation: null,
  hiding: false,
  hideError: false,
  hiddenJustNow: false,
  tick: 0,
});

export type LearningHomeController = {
  subscribe(listener: Listener): () => void;
  getSnapshot(): LearningHomeSnapshot;
  start(): void;
  setActive(active: boolean): void;
  refreshPolicy(): Promise<void>;
  view(nowMs?: number): LearningHomeView;
  next(): void;
  hide(): Promise<void>;
  dispose(): void;
};

export function createLearningHomeController(context: LearningScopeContext): LearningHomeController {
  const clock = context.clock ?? (() => Date.now());
  const emitter = createEmitter();
  const rotationScope = { userId: context.userId, organizationId: context.organizationId, chapterId: context.chapterId, locale: context.locale };
  const storeKey = learningNextStoreKey(rotationScope);
  let snapshot: LearningHomeSnapshot = EMPTY_LEARNING_HOME;
  let disposed = false;
  let policyRequest = 0;
  let contentRequest = 0;

  const publish = (next: Partial<LearningHomeSnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...next };
    emitter.emit();
  };
  const boundary = createBoundaryTimer(() => publish({ tick: snapshot.tick + 1 }), clock);
  const cleared = { items: [], loaded: false, itemsVersion: null, itemsSignature: null };
  const failClosed = () => {
    contentRequest += 1;
    boundary.stop();
    publish({ status: 'unavailable', policy: null, ...cleared });
  };

  async function loadContent(policy: LearningPolicy, kind: LearningKindFilter, signature: string) {
    const request = ++contentRequest;
    const stillCurrent = context.captureGuard();
    try {
      const page = await context.api.listContent({ chapterId: context.chapterId, locale: context.locale, kind, offset: 0, limit: LEARNING_HOME_BATCH });
      if (disposed || request !== contentRequest || !stillCurrent() || snapshot.policy?.version !== policy.version) return;
      publish({ status: 'ready', items: page.items, loaded: true, itemsVersion: policy.version, itemsSignature: signature });
      boundary.schedule(page.items);
    } catch {
      if (disposed || request !== contentRequest || !stillCurrent()) return;
      failClosed();
    }
  }

  async function refreshPolicy() {
    if (disposed) return;
    const request = ++policyRequest;
    const stillCurrent = context.captureGuard();
    if (!snapshot.policy) publish({ status: 'loading' });
    let policy: LearningPolicy;
    try {
      policy = await context.api.getPolicy(context.chapterId);
    } catch {
      if (disposed || request !== policyRequest || !stillCurrent()) return;
      // Any policy failure takes the cached content with it (fail closed).
      failClosed();
      return;
    }
    if (disposed || request !== policyRequest || !stillCurrent()) return;
    const plan = planLearningHomeLoad({ version: snapshot.itemsVersion, signature: snapshot.itemsSignature, loaded: snapshot.loaded }, policy);
    if (plan.clear) {
      contentRequest += 1;
      boundary.stop();
    }
    const status: LearningHomeStatus = policy.homeHidden ? 'hidden'
      : !policy.quotesEnabled && !policy.lessonsEnabled ? 'disabled'
        : plan.load || !snapshot.loaded ? 'loading' : 'ready';
    publish({
      policy,
      status,
      hiddenJustNow: policy.homeHidden ? snapshot.hiddenJustNow : false,
      ...(plan.clear ? cleared : {}),
    });
    if (plan.load) await loadContent(policy, plan.kind, plan.signature);
  }

  const poller = createPolicyPoller(() => { void refreshPolicy(); });

  function ordered(nowMs: number): { day: string; ordered: LearningItem[] } | null {
    const policy = snapshot.policy;
    if (!policy || policy.homeHidden || snapshot.status !== 'ready') return null;
    const eligibility = deliveryContext(policy, context.locale, { quotes: policy.quotesEnabled, lessons: policy.lessonsEnabled });
    const eligible = snapshot.items.filter((item) => isLearningItemEligible(item, eligibility));
    const day = learningDayKey(new Date(nowMs));
    const seed = learningRotationSeed({ day, ...rotationScope });
    return { day, ordered: orderLearningItems(eligible, seed) };
  }

  function view(nowMs: number = clock()): LearningHomeView {
    const current = ordered(nowMs);
    if (!current) return EMPTY_VIEW;
    const index = parseLearningRotationState(snapshot.storedRotation, current.day);
    const picked = pickLearningItem(current.ordered, index, nowMs);
    if (!picked) return EMPTY_VIEW;
    return {
      current: picked.item,
      index: picked.index,
      position: liveLearningCount(current.ordered.slice(0, picked.index), nowMs) + 1,
      total: liveLearningCount(current.ordered, nowMs),
    };
  }

  return {
    subscribe: emitter.subscribe,
    getSnapshot: () => snapshot,
    start() {
      const stillCurrent = context.captureGuard();
      void context.nextStore.read(storeKey).then((stored) => {
        if (!disposed && stillCurrent() && stored !== null && snapshot.storedRotation === null) publish({ storedRotation: stored });
      }).catch(() => undefined);
    },
    setActive: (active) => poller.setActive(active && !disposed),
    refreshPolicy,
    view,
    next() {
      // Next is local: no request, no animation, the same day-stable order.
      const nowMs = clock();
      const current = ordered(nowMs);
      if (!current || current.ordered.length === 0) return;
      const index = parseLearningRotationState(snapshot.storedRotation, current.day);
      const stored = serializeLearningRotationState(current.day, nextLearningIndex(current.ordered, index, nowMs));
      publish({ storedRotation: stored });
      void context.nextStore.write(storeKey, stored).catch(() => undefined);
    },
    async hide() {
      if (snapshot.hiding || !snapshot.policy) return;
      const stillCurrent = context.captureGuard();
      publish({ hiding: true, hideError: false });
      try {
        await context.api.setHomeHidden({ chapterId: context.chapterId, hidden: true });
        if (disposed || !stillCurrent()) return;
        contentRequest += 1;
        boundary.stop();
        publish({
          hiding: false,
          hiddenJustNow: true,
          status: 'hidden',
          policy: snapshot.policy ? { ...snapshot.policy, homeHidden: true } : null,
          ...cleared,
        });
      } catch {
        if (disposed || !stillCurrent()) return;
        publish({ hiding: false, hideError: true });
      }
    },
    dispose() {
      disposed = true;
      poller.stop();
      boundary.stop();
      emitter.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Learn library (mini-lessons, forty at a time)

export type LearningLibraryStatus = 'idle' | 'loading' | 'ready' | 'disabled' | 'unavailable';

export type LearningLibrarySnapshot = {
  status: LearningLibraryStatus;
  policy: LearningPolicy | null;
  items: readonly LearningItem[];
  hasMore: boolean;
  nextOffset: number;
  itemsVersion: string | null;
  loadingMore: boolean;
  loadMoreError: boolean;
  restoring: boolean;
  restoreError: boolean;
  restoredJustNow: boolean;
  tick: number;
};

export const EMPTY_LEARNING_LIBRARY: LearningLibrarySnapshot = Object.freeze({
  status: 'idle',
  policy: null,
  items: [],
  hasMore: false,
  nextOffset: 0,
  itemsVersion: null,
  loadingMore: false,
  loadMoreError: false,
  restoring: false,
  restoreError: false,
  restoredJustNow: false,
  tick: 0,
});

export type LearningLibraryController = {
  subscribe(listener: Listener): () => void;
  getSnapshot(): LearningLibrarySnapshot;
  setActive(active: boolean): void;
  refreshPolicy(): Promise<void>;
  loadMore(): Promise<void>;
  restoreHome(): Promise<void>;
  lessons(nowMs?: number): LearningItem[];
  dispose(): void;
};

export function createLearningLibraryController(context: LearningScopeContext): LearningLibraryController {
  const clock = context.clock ?? (() => Date.now());
  const emitter = createEmitter();
  let snapshot: LearningLibrarySnapshot = EMPTY_LEARNING_LIBRARY;
  let disposed = false;
  let policyRequest = 0;
  let pageRequest = 0;

  const publish = (next: Partial<LearningLibrarySnapshot>) => {
    if (disposed) return;
    snapshot = { ...snapshot, ...next };
    emitter.emit();
  };
  const boundary = createBoundaryTimer(() => publish({ tick: snapshot.tick + 1 }), clock);
  const cleared = { items: [], hasMore: false, nextOffset: 0, itemsVersion: null, loadingMore: false, loadMoreError: false };

  async function loadPage(policy: LearningPolicy, offset: number) {
    const request = learningLibraryRequest(policy, offset);
    if (!request) return;
    const sequence = ++pageRequest;
    const stillCurrent = context.captureGuard();
    if (offset > 0) publish({ loadingMore: true, loadMoreError: false });
    try {
      const page = await context.api.listContent({ chapterId: context.chapterId, locale: context.locale, kind: request.kind, offset: request.offset, limit: request.limit });
      if (disposed || sequence !== pageRequest || !stillCurrent() || snapshot.policy?.version !== policy.version) return;
      const known = new Set(snapshot.items.map((item) => item.id));
      const items = offset === 0 ? page.items : [...snapshot.items, ...page.items.filter((item) => !known.has(item.id))];
      const nextOffset = request.offset + request.limit;
      publish({ status: 'ready', items, hasMore: page.hasMore && learningLibraryRequest(policy, nextOffset) !== null, nextOffset, itemsVersion: policy.version, loadingMore: false });
      boundary.schedule(items);
    } catch {
      if (disposed || sequence !== pageRequest || !stillCurrent()) return;
      if (offset > 0) publish({ loadingMore: false, loadMoreError: true });
      else {
        boundary.stop();
        publish({ status: 'unavailable', ...cleared });
      }
    }
  }

  async function refreshPolicy() {
    if (disposed) return;
    const request = ++policyRequest;
    const stillCurrent = context.captureGuard();
    if (!snapshot.policy) publish({ status: 'loading' });
    let policy: LearningPolicy;
    try {
      policy = await context.api.getPolicy(context.chapterId);
    } catch {
      if (disposed || request !== policyRequest || !stillCurrent()) return;
      pageRequest += 1;
      boundary.stop();
      publish({ status: 'unavailable', policy: null, ...cleared });
      return;
    }
    if (disposed || request !== policyRequest || !stillCurrent()) return;
    if (!learningLibraryRequest(policy, 0)) {
      // A disabled module is never read, and anything cached from before the
      // switch changed is dropped at once.
      pageRequest += 1;
      boundary.stop();
      publish({ status: 'disabled', policy, ...cleared });
      return;
    }
    if (snapshot.status === 'ready' && snapshot.itemsVersion === policy.version) {
      publish({ policy, restoredJustNow: policy.homeHidden ? false : snapshot.restoredJustNow });
      return;
    }
    pageRequest += 1;
    boundary.stop();
    publish({ status: 'loading', policy, ...cleared });
    await loadPage(policy, 0);
  }

  const poller = createPolicyPoller(() => { void refreshPolicy(); });

  return {
    subscribe: emitter.subscribe,
    getSnapshot: () => snapshot,
    setActive: (active) => poller.setActive(active && !disposed),
    refreshPolicy,
    async loadMore() {
      const policy = snapshot.policy;
      if (!policy || snapshot.status !== 'ready' || !snapshot.hasMore || snapshot.loadingMore) return;
      await loadPage(policy, snapshot.nextOffset);
    },
    async restoreHome() {
      if (snapshot.restoring || !snapshot.policy) return;
      const stillCurrent = context.captureGuard();
      publish({ restoring: true, restoreError: false, restoredJustNow: false });
      try {
        await context.api.setHomeHidden({ chapterId: context.chapterId, hidden: false });
        if (disposed || !stillCurrent()) return;
        publish({ restoring: false, restoredJustNow: true, policy: snapshot.policy ? { ...snapshot.policy, homeHidden: false } : null });
      } catch {
        if (disposed || !stillCurrent()) return;
        publish({ restoring: false, restoreError: true });
      }
    },
    lessons(nowMs = clock()) {
      const policy = snapshot.policy;
      if (!policy || snapshot.status !== 'ready') return [];
      const eligibility = deliveryContext(policy, context.locale, { quotes: false, lessons: policy.lessonsEnabled });
      return snapshot.items.filter((item) => item.kind === 'mini_lesson' && isLearningItemEligible(item, eligibility) && isLearningItemLive(item, nowMs));
    },
    dispose() {
      disposed = true;
      poller.stop();
      boundary.stop();
      emitter.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Administration entrance (Account). Know your rights is a member route, so
// staff, administrators and platform owners also get an explicit entrance
// that never changes their hat. Its visibility costs exactly one policy-only
// read: no content, workspace or choices are fetched for the entrance, and the
// server's canManage / isPlatformOwner decide. Any failure hides it.

export function learningAdministrationAllowed(policy: LearningPolicy | null): boolean {
  return Boolean(policy && (policy.canManage || policy.isPlatformOwner));
}

export async function readLearningAdministration(scope: Pick<LearningScopeContext, 'api' | 'chapterId'>): Promise<LearningPolicy | null> {
  try {
    const policy = await scope.api.getPolicy(scope.chapterId);
    return learningAdministrationAllowed(policy) ? policy : null;
  } catch {
    return null;
  }
}
