import type { MemberConversation } from '../models/member';

// UX-UG-DIRECT-STEWARD-CONVERSATION-UNREAD-HAS-NO-REALTIME-OR-POLLING-PATH-THE-MESSAGES-20260921:
// the Messages tab badge and the inbox row only refreshed when fetchDashboard
// ran, while the channel half of the badge has a live store and the thread
// screen self-polls every 30 seconds. member_conversation_summaries is a view,
// so it cannot be a Realtime postgres_changes source; the bounded poll below
// mirrors the thread screen's cadence and re-projects the conversation half of
// fetchDashboard's projection, published through the same versioned-store
// shape the channel store uses so badge and inbox read one source.

// Mirrors the thread screen's self-poll (app/conversation/[id].tsx and
// MessageReplies.tsx both reconcile on this cadence), so a new steward reply
// lights up the badge and the open thread within the same window.
export const CONVERSATION_UNREAD_POLL_INTERVAL_MS = 30_000;

// The open thread's reconcile: a null load means the conversation row is no
// longer visible to this member, so the rendered private thread must clear.
export function reconcileThreadResult(next: unknown): 'clear' | 'keep' {
  return next ? 'keep' : 'clear';
}

type Listener = () => void;

let version = 0;
let latestConversations: readonly MemberConversation[] | null = null;
const listeners = new Set<Listener>();

function emit() {
  version += 1;
  listeners.forEach((listener) => listener());
}

// The versioned store surface the badge subscribes to, same shape as the
// channel store (subscribe/getVersion). Holds the latest published
// conversation projection; null until the first authenticated dashboard or
// poll publish, and reset back to null on sign-out.
export const conversationUnreadStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  getVersion: (): number => version,
  conversations: (): readonly MemberConversation[] | null => latestConversations,
  publish(conversations: readonly MemberConversation[]) {
    latestConversations = conversations;
    emit();
  },
  reset() {
    latestConversations = null;
    emit();
  },
};

export type ConversationUnreadLoad = (userID: string) => Promise<readonly MemberConversation[]>;

export type ConversationUnreadPollerOptions = {
  load: ConversationUnreadLoad;
  intervalMs?: number;
  connected?: boolean;
  // Called after a successful publish so the owner (AppProvider) can merge the
  // fresh projection into its dashboard snapshot for consumers that read
  // dashboard.conversations directly (the inbox screen, Home's metric).
  onPublished?: (conversations: readonly MemberConversation[]) => void;
  // When this value moves while a load awaits (a Steward Direct role refusal)
  // and the load still returns rows, those rows were read before the refusal
  // and are not published. An empty result is always published: it is what a
  // load that met the refusal itself returns, and it clears the screen.
  refusalEpoch?: () => number;
};

export type ConversationUnreadPoller = {
  start: () => void;
  setPolicy: (intervalMs: number, connected: boolean) => void;
  stop: () => void;
  isRunning: () => boolean;
  // Drops any in-flight tick without stopping the timer. fetchDashboard calls
  // this when a newer authoritative refresh (pull-to-refresh, chapter switch,
  // the open thread's read acknowledgement) is about to publish, so an older
  // poll response that resolves later cannot overwrite it.
  invalidate: () => void;
  // Runs one refresh immediately. Resolves to the fresh projection on success
  // and null when the load failed or a refresh was already in flight; a failed
  // tick never clears or corrupts the last good counts — the store keeps the
  // previous projection.
  tick: () => Promise<readonly MemberConversation[] | null>;
};

export function createConversationUnreadPoller(
  userID: string,
  options: ConversationUnreadPollerOptions,
): ConversationUnreadPoller {
  let intervalMs = options.intervalMs ?? CONVERSATION_UNREAD_POLL_INTERVAL_MS;
  let connected = options.connected ?? true;
  let running = false;
  let lastScheduledAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // stop() bumps the generation so a tick already awaiting load cannot
  // publish after sign-out, an account switch, or backgrounding: the captured
  // session's projection must never reach the global store once a different
  // account (or no account) owns the surface.
  let generation = 0;
  // Single-flight: while one load is in flight the interval skips further
  // ticks instead of starting overlapping requests. On a slow connection where
  // each summary query outlasts the interval, the old last-write-wins guard
  // rejected every successful response and the badge starved; serialized
  // loads publish every success, and no two responses can land out of order.
  let inFlight = false;

  const tick = async (): Promise<readonly MemberConversation[] | null> => {
    if (inFlight) return null;
    inFlight = true;
    const capturedGeneration = generation;
    const capturedEpoch = options.refusalEpoch?.();
    try {
      const conversations = await options.load(userID);
      // stop()/invalidate() bumped the generation while the load awaited: the
      // captured session's projection must not publish into a newer source.
      if (capturedGeneration !== generation) return null;
      if (conversations.length > 0 && options.refusalEpoch && options.refusalEpoch() !== capturedEpoch) return null;
      conversationUnreadStore.publish(conversations);
      options.onPublished?.(conversations);
      return conversations;
    } catch {
      return null;
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!running || !connected) return;
    // Preserve elapsed time across policy and connection changes. Explicit
    // Refresh stays independent of this optional periodic schedule.
    timer = setTimeout(() => {
      timer = null;
      lastScheduledAt = Date.now();
      void tick();
      schedule();
    }, Math.max(0, (lastScheduledAt ?? Date.now()) + intervalMs - Date.now()));
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastScheduledAt ??= Date.now();
      schedule();
    },
    setPolicy(nextIntervalMs, nextConnected) {
      intervalMs = Math.max(1_000, nextIntervalMs);
      if (connected && !nextConnected) generation += 1;
      connected = nextConnected;
      schedule();
    },
    stop() {
      generation += 1;
      running = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    invalidate() {
      generation += 1;
    },
    isRunning: () => running && connected,
    tick,
  };
}
