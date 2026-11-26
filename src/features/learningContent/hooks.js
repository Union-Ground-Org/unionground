import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sessionIDFromAccessToken } from "../../lib/exactSessionStorage.js";
import { LearningContentError, createLearningContentApi } from "./api.js";
import { sharedLearningPreviewApi } from "./preview.js";
import {
  LEARNING_LOCALES,
  LEARNING_POLICY_POLL_MS,
  isLearningItemEligible,
  isLearningItemLive,
  learningDayKey,
  learningHomeRequest,
  learningLibraryRequest,
  learningRotationSeed,
  learningRotationStorageKey,
  liveLearningCount,
  nextLearningBoundary,
  nextLearningIndex,
  orderLearningItems,
  parseLearningRotationState,
  pickLearningItem,
  serializeLearningRotationState,
} from "./model.js";

const EMPTY = Object.freeze([]);

// ---------------------------------------------------------------------------
// Scope: who, where and in which language. Any change remounts the consumer
// (see learningScopeKey), so cached content clears in the same render and a
// late response from the previous scope has nobody left to update.
// ---------------------------------------------------------------------------

export function learningScopeFrom({ session, organizationId, chapterId, locale, preview }) {
  return {
    userId: typeof session?.user?.id === "string" ? session.user.id : null,
    // The auth session lineage survives token refresh but not a new sign-in.
    sessionKey: sessionIDFromAccessToken(session?.access_token),
    organizationId: organizationId || null,
    chapterId: chapterId || null,
    locale,
    preview: preview === true,
  };
}

// A way to reach the server: the preview fiction, App's per-session client
// factory (the live path), or an already captured client.
export function learningTransportReady({ preview = false, session = null, createSessionClient = null, client = null }) {
  if (preview === true) return true;
  if (typeof createSessionClient === "function") return typeof session?.access_token === "string" && session.access_token !== "";
  return Boolean(client && typeof client.rpc === "function");
}

// Anything at all needs a signed-in user and a supported language (content
// never falls back between languages).
export function learningScopeReady(scope, transportReady) {
  return Boolean(scope.userId && LEARNING_LOCALES.includes(scope.locale) && transportReady);
}

// Member content needs the selected organization and chapter. Without them
// only a provisioned platform owner reaches anything: the platform library.
export function learningScopeTenant(scope) {
  return Boolean(scope.organizationId && scope.chapterId);
}

export function learningScopeKey(scope) {
  return JSON.stringify([scope.userId, scope.sessionKey, scope.organizationId, scope.chapterId, scope.locale, scope.preview]);
}

export function useLearningApi(scope, { client = null, session = null, createSessionClient = null, override = null } = {}) {
  const accessToken = typeof session?.access_token === "string" && session.access_token ? session.access_token : null;
  // One captured client per access token: a request started under one
  // session can never ride a later one. A token refresh swaps the client
  // without remounting, because the scope key follows the stable lineage.
  const transport = useMemo(() => {
    if (scope.preview || override) return null;
    if (typeof createSessionClient === "function") {
      if (!accessToken) return null;
      try {
        return createSessionClient({ access_token: accessToken });
      } catch {
        return null;
      }
    }
    return client;
  }, [scope.preview, override, createSessionClient, accessToken, client]);
  return useMemo(() => {
    if (override) return override;
    return scope.preview
      ? sharedLearningPreviewApi({ organizationId: scope.organizationId, chapterId: scope.chapterId })
      : createLearningContentApi(transport);
  }, [override, scope.preview, scope.organizationId, scope.chapterId, transport]);
}

// ---------------------------------------------------------------------------
// Policy: the only thing clients poll. Every 60 s while visible, on focus and
// on returning to the tab. Any failure clears the policy (fail closed), and
// consumers derive "no content" from a missing policy.
// ---------------------------------------------------------------------------

function samePolicy(left, right) {
  return Boolean(left && right) && ["organizationId", "chapterId", "quotesEnabled", "lessonsEnabled", "homeHidden", "canManage", "isPlatformOwner", "version"]
    .every((field) => left[field] === right[field]);
}

export function useLearningPolicy(api, scope, { poll = true, pollMs = LEARNING_POLICY_POLL_MS } = {}) {
  const [state, setState] = useState({ status: "loading", policy: null, error: null, refreshCount: 0 });
  const sequence = useRef(0);
  const inFlight = useRef(null);

  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    const token = ++sequence.current;
    const request = api.getPolicy({ chapterId: scope.chapterId })
      .then((policy) => {
        if (token !== sequence.current) return;
        // The answer must be for the chapter asked about. Without a chapter
        // (a platform owner before any tenant) the server resolves the
        // organization, possibly none.
        const organizationId = scope.chapterId ? scope.organizationId : policy.organizationId;
        if (policy.chapterId !== scope.chapterId || policy.organizationId !== organizationId) {
          throw new LearningContentError("learning_scope_mismatch");
        }
        setState((prior) => ({ status: "ready", policy: samePolicy(prior.policy, policy) ? prior.policy : policy, error: null, refreshCount: prior.refreshCount + 1 }));
      })
      .catch((error) => {
        if (token !== sequence.current) return;
        setState((prior) => ({ status: "error", policy: null, error, refreshCount: prior.refreshCount }));
      })
      .finally(() => {
        if (inFlight.current === request) inFlight.current = null;
      });
    inFlight.current = request;
    return request;
  }, [api, scope.chapterId, scope.organizationId]);

  // A confirmed local write (the member's own hide or restore) is reflected
  // at once; the next poll reconciles the version.
  const confirm = useCallback((changes) => {
    // Reads started before the confirmed write cannot replace it, and a
    // later refresh must get its own request rather than join that old read.
    sequence.current += 1;
    inFlight.current = null;
    setState((prior) => (prior.status === "ready" ? { ...prior, policy: Object.freeze({ ...prior.policy, ...changes }) } : prior));
  }, []);

  useEffect(() => {
    refresh();
    // Without a tenant there is no content to keep fresh: one read decides
    // whether the platform-library entrance shows at all.
    if (!poll) {
      return () => {
        sequence.current += 1;
        inFlight.current = null;
      };
    }
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, pollMs);
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      sequence.current += 1;
      inFlight.current = null;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh, poll, pollMs]);

  return { ...state, refresh, confirm };
}

// ---------------------------------------------------------------------------
// Clock: delivery is checked against Date.now() at render. This re-renders
// exactly when a cached item starts or expires, at local midnight (a new
// rotation day) and when the member comes back to the tab.
// ---------------------------------------------------------------------------

export function useLearningTick(items) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    const boundary = nextLearningBoundary(items, now);
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const target = Math.min(boundary ?? Number.POSITIVE_INFINITY, midnight.getTime());
    const delay = Math.min(Math.max(target - now + 25, 25), 2147483647);
    const timer = window.setTimeout(() => setTick((value) => value + 1), delay);
    const wake = () => {
      if (document.visibilityState !== "hidden") setTick((value) => value + 1);
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [items, tick]);
  return tick;
}

function deliveryContext(policy, locale) {
  return policy ? {
    locale,
    quotesEnabled: policy.quotesEnabled,
    lessonsEnabled: policy.lessonsEnabled,
    organizationId: policy.organizationId,
    chapterId: policy.chapterId,
  } : null;
}

function readRotation(storageKey, day) {
  try {
    return parseLearningRotationState(window.localStorage.getItem(storageKey), day);
  } catch {
    return 0;
  }
}

function writeRotation(storageKey, day, index) {
  try {
    window.localStorage.setItem(storageKey, serializeLearningRotationState(day, index));
  } catch {
    // Storage may be unavailable; the rotation still advances for this view.
  }
}

// ---------------------------------------------------------------------------
// Home: one bounded read per policy version, then a daily stable rotation
// that "Next" advances locally without a request.
// ---------------------------------------------------------------------------

export function useLearningHome(api, scope, policyState) {
  const policy = policyState.status === "ready" ? policyState.policy : null;
  const request = learningHomeRequest(policy);
  const requestKind = request ? request.kind : null;
  const requestLimit = request ? request.limit : 0;
  const requestKey = request ? JSON.stringify([policy.version, requestKind, policy.quotesEnabled, policy.lessonsEnabled]) : null;
  const [cache, setCache] = useState({ key: null, items: EMPTY, failed: false });
  const loaded = useRef(null);
  const sequence = useRef(0);

  useEffect(() => {
    if (!requestKey) { loaded.current = null; return undefined; }
    // An unchanged successful policy poll retries a failed batch, but never
    // re-fetches a healthy batch or makes Next a network action.
    if (loaded.current === requestKey) return undefined;
    const token = ++sequence.current;
    api.listContent({ chapterId: scope.chapterId, locale: scope.locale, kind: requestKind, offset: 0, limit: requestLimit })
      .then((page) => {
        if (token === sequence.current) {
          loaded.current = requestKey;
          setCache({ key: requestKey, items: page.items, failed: false });
        }
      })
      .catch(() => {
        if (token === sequence.current) setCache({ key: requestKey, items: EMPTY, failed: true });
      });
    return () => {
      sequence.current += 1;
    };
  }, [api, requestKey, requestKind, requestLimit, scope.chapterId, scope.locale, policyState.refreshCount]);

  // A cache for any other version, kind set or policy state is never shown.
  const items = cache.key === requestKey && requestKey ? cache.items : EMPTY;
  // The policy object keeps its identity across unchanged polls.
  const eligible = useMemo(() => {
    const context = deliveryContext(policy, scope.locale);
    return context ? items.filter((item) => isLearningItemEligible(item, context)) : EMPTY;
  }, [items, policy, scope.locale]);
  useLearningTick(eligible);

  const nowMs = Date.now();
  const day = learningDayKey(new Date(nowMs));
  const seed = learningRotationSeed({ day, userId: scope.userId, organizationId: scope.organizationId, chapterId: scope.chapterId, locale: scope.locale });
  const ordered = useMemo(() => orderLearningItems(eligible, seed), [eligible, seed]);
  const storageKey = learningRotationStorageKey(scope);
  const [rotation, setRotation] = useState(() => ({ day, index: readRotation(storageKey, day) }));
  const index = rotation.day === day ? rotation.index : readRotation(storageKey, day);
  const picked = pickLearningItem(ordered, index, nowMs);
  const liveCount = liveLearningCount(ordered, nowMs);
  const position = picked ? liveLearningCount(ordered.slice(0, picked.index), nowMs) + 1 : 0;

  const next = useCallback(() => {
    const now = Date.now();
    const today = learningDayKey(new Date(now));
    if (today !== day) {
      setRotation({ day: today, index: readRotation(storageKey, today) });
      return;
    }
    const nextIndex = nextLearningIndex(ordered, index, now);
    writeRotation(storageKey, today, nextIndex);
    setRotation({ day: today, index: nextIndex });
  }, [day, index, ordered, storageKey]);

  return {
    policy,
    item: picked ? picked.item : null,
    position,
    liveCount,
    next,
    loading: Boolean(requestKey) && cache.key !== requestKey,
    failed: cache.key === requestKey && cache.failed,
  };
}

// ---------------------------------------------------------------------------
// Learn: the published mini-lesson library in pages of 40.
// ---------------------------------------------------------------------------

function mergeById(existing, incoming) {
  const seen = new Set(existing.map((item) => item.id));
  return [...existing, ...incoming.filter((item) => !seen.has(item.id) && seen.add(item.id))];
}

export function useLearningLibrary(api, scope, policyState) {
  const [retryCount, setRetryCount] = useState(0);
  const policy = policyState.status === "ready" ? policyState.policy : null;
  const first = learningLibraryRequest(policy, 0);
  const firstLimit = first ? first.limit : 0;
  const baseKey = first ? JSON.stringify([policy.version, policy.lessonsEnabled, retryCount]) : null;
  const [state, setState] = useState({ key: null, status: "idle", items: EMPTY, hasMore: false, nextOffset: 0, moreFailed: false, loadingMore: false });
  const sequence = useRef(0);

  useEffect(() => {
    if (!baseKey) return undefined;
    const token = ++sequence.current;
    api.listContent({ chapterId: scope.chapterId, locale: scope.locale, kind: "mini_lesson", offset: 0, limit: firstLimit })
      .then((page) => {
        if (token !== sequence.current) return;
        setState({ key: baseKey, status: "ready", items: page.items, hasMore: page.hasMore, nextOffset: firstLimit, moreFailed: false, loadingMore: false });
      })
      .catch(() => {
        if (token !== sequence.current) return;
        setState({ key: baseKey, status: "error", items: EMPTY, hasMore: false, nextOffset: 0, moreFailed: false, loadingMore: false });
      });
    return () => {
      sequence.current += 1;
    };
  }, [api, baseKey, firstLimit, scope.chapterId, scope.locale]);

  const current = state.key === baseKey && baseKey ? state : null;

  const loadMore = useCallback(() => {
    if (!current || current.loadingMore || !current.hasMore) return;
    const request = learningLibraryRequest(policy, current.nextOffset);
    if (!request) return;
    const token = sequence.current;
    setState((prior) => (prior.key === baseKey ? { ...prior, loadingMore: true, moreFailed: false } : prior));
    api.listContent({ chapterId: scope.chapterId, locale: scope.locale, kind: "mini_lesson", offset: request.offset, limit: request.limit })
      .then((page) => {
        if (token !== sequence.current) return;
        setState((prior) => (prior.key !== baseKey ? prior : {
          ...prior, items: mergeById(prior.items, page.items), hasMore: page.hasMore, nextOffset: request.offset + request.limit, loadingMore: false,
        }));
      })
      .catch(() => {
        if (token !== sequence.current) return;
        setState((prior) => (prior.key !== baseKey ? prior : { ...prior, loadingMore: false, moreFailed: true }));
      });
  }, [api, baseKey, current, policy, scope.chapterId, scope.locale]);

  const context = deliveryContext(policy, scope.locale);
  const items = current ? current.items : EMPTY;
  useLearningTick(items);
  const nowMs = Date.now();
  const lessons = context ? items.filter((item) => isLearningItemEligible(item, context) && isLearningItemLive(item, nowMs)) : EMPTY;

  let status;
  if (policyState.status === "loading") status = "loading";
  else if (policyState.status === "error") status = "error";
  else if (!policy?.lessonsEnabled) status = "off";
  else if (!current) status = "loading";
  else status = current.status;

  return {
    policy,
    status,
    lessons,
    hasMore: Boolean(current?.hasMore),
    loadingMore: Boolean(current?.loadingMore),
    moreFailed: Boolean(current?.moreFailed),
    loadMore,
    retry: () => {
      if (policyState.status === "ready") setRetryCount((value) => value + 1);
      else policyState.refresh();
    },
  };
}
