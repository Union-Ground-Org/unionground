import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DemoChannel } from '../data/demoChannels';
import type { MemberConversation, MemberDashboard } from '../models/member';
import { dashboardMetrics } from '../models/member';
import { buildMessageInbox, nativeInboxUnreadItemCount } from './messageInbox';
import {
  CONVERSATION_UNREAD_POLL_INTERVAL_MS,
  conversationUnreadStore,
  createConversationUnreadPoller,
  reconcileThreadResult,
} from './conversationUnread';

const channels: DemoChannel[] = [
  {
    id: 'chapter',
    name: 'chapter-updates',
    unread: 0,
    topic: 'Campaign updates',
    messages: [{
      id: 'post-1',
      author: 'Jordan Patel',
      initials: 'JP',
      time: '4:15 PM',
      createdAt: '2026-09-21T16:15:00.000Z',
      body: 'The meeting agenda is ready.',
    }],
  },
];

function stewardConversation(id: string, unreadCount: number, latestMessage: string): MemberConversation {
  return {
    id,
    counterpartRole: 'steward',
    title: 'Sam Okafor',
    initials: 'SO',
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T15:00:00.000Z',
    unreadCount,
    latestMessage,
  };
}

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

function dashboardFrom(conversations: readonly MemberConversation[]): MemberDashboard {
  return {
    member: {
      id: 'member',
      firstName: 'Sam',
      fullName: 'Sam Okafor',
      initials: 'SO',
      roleLine: 'Worker',
      memberSince: 2022,
      chapterID: null,
      language: 'en',
    },
    notifications: [],
    cases: [],
    conversations: [...conversations],
    weeklyActions: [],
  };
}

// The badge counts unread inbox ITEMS (rows), not raw message totals, so a
// projection moves the number when the unread conversation set changes.
function unreadViaStore(): number {
  return nativeInboxUnreadItemCount(conversationUnreadStore.conversations() ?? [], channels);
}

describe('conversationUnreadStore', () => {
  beforeEach(() => {
    conversationUnreadStore.reset();
  });

  it('mirrors the channel store shape: subscribe, getVersion, and a publish that notifies listeners', () => {
    const listener = vi.fn();
    const unsubscribe = conversationUnreadStore.subscribe(listener);
    const before = conversationUnreadStore.getVersion();

    conversationUnreadStore.publish([
      stewardConversation('direct-1', 2, 'First reply.'),
      stewardConversation('direct-2', 1, 'Second thread.'),
    ]);

    expect(conversationUnreadStore.getVersion()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(unreadViaStore()).toBe(2);
    unsubscribe();
    conversationUnreadStore.publish([stewardConversation('direct-1', 3, 'Third reply.')]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('resets back to null so a signed-out badge cannot read a stale projection', () => {
    conversationUnreadStore.publish([stewardConversation('direct-1', 2, 'First reply.')]);
    conversationUnreadStore.reset();
    expect(conversationUnreadStore.conversations()).toBeNull();
  });
});

describe('createConversationUnreadPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    conversationUnreadStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls on the same 30s cadence the thread screen self-polls at', () => {
    expect(CONVERSATION_UNREAD_POLL_INTERVAL_MS).toBe(30_000);
    // House cadence pin: the open thread reconciles every 30 seconds, so a
    // steward reply lights up the badge and the open thread in one window.
    expect(source('../../app/conversation/[id].tsx')).toContain('setInterval(reconcile, 30000)');
  });

  it('does not run before start, runs on the interval after start, and stops cleanly', async () => {
    const load = vi.fn().mockResolvedValue([stewardConversation('direct-1', 1, 'One new message.')]);
    const poller = createConversationUnreadPoller('user-1', { load });

    await vi.advanceTimersByTimeAsync(CONVERSATION_UNREAD_POLL_INTERVAL_MS * 2);
    expect(load).not.toHaveBeenCalled();

    poller.start();
    expect(poller.isRunning()).toBe(true);
    // start() is idempotent: a second call must not stack timers.
    poller.start();
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNREAD_POLL_INTERVAL_MS);
    expect(load).toHaveBeenCalledTimes(1);
    expect(unreadViaStore()).toBe(1);

    poller.stop();
    expect(poller.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(CONVERSATION_UNREAD_POLL_INTERVAL_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('raises the unread count a new committee member reply reports without any manual refresh', async () => {
    let projection = [stewardConversation('direct-1', 1, 'Earlier reply.')];
    const poller = createConversationUnreadPoller('user-1', {
      load: vi.fn().mockImplementation(async () => projection),
    });

    expect(await poller.tick()).not.toBeNull();
    expect(unreadViaStore()).toBe(1);

    // Between ticks the steward's follow-up lands server-side: the existing
    // thread's count rises and a second steward thread shows its first unread.
    projection = [
      stewardConversation('direct-1', 3, 'Follow-up reply.'),
      stewardConversation('direct-2', 1, 'New committee member thread.'),
    ];
    expect(await poller.tick()).not.toBeNull();

    const published = conversationUnreadStore.conversations();
    expect(published).toHaveLength(2);
    expect(published?.find((item) => item.id === 'direct-1')?.unreadCount).toBe(3);
    expect(published?.find((item) => item.id === 'direct-1')?.latestMessage).toBe('Follow-up reply.');
    expect(published?.find((item) => item.id === 'direct-2')?.unreadCount).toBe(1);
    expect(unreadViaStore()).toBe(2);
  });

  it('notifies the owner on publish so the dashboard projection merges too', async () => {
    const onPublished = vi.fn();
    const next = [stewardConversation('direct-1', 4, 'Fresh projection.')];
    const poller = createConversationUnreadPoller('user-1', { load: vi.fn().mockResolvedValue(next), onPublished });

    await poller.tick();

    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(onPublished).toHaveBeenCalledWith(next);
  });

  it('serializes overlapping ticks so a slow load never stacks requests', async () => {
    // Single-flight regression: with intervalMs below the load latency the
    // interval must skip ticks while one load is in flight instead of
    // starting overlapping requests whose last-write-wins would starve the
    // badge (the Codex round-4 seq guard rejected every response here).
    let pending = 0;
    let maxPending = 0;
    let latest: MemberConversation[] = [stewardConversation('direct-1', 1, 'First reply.')];
    const load = vi.fn().mockImplementation(async () => {
      pending += 1;
      maxPending = Math.max(maxPending, pending);
      await new Promise((resolve) => setTimeout(resolve, 40));
      pending -= 1;
      return latest;
    });
    const poller = createConversationUnreadPoller('user-1', { load, intervalMs: 30 });
    poller.start();

    // Every request outlasts the 30ms interval; the store must still refresh.
    await vi.advanceTimersByTimeAsync(200);
    expect(maxPending).toBe(1);
    expect(load.mock.calls.length).toBeGreaterThan(1);
    expect(unreadViaStore()).toBe(1);

    // The connection is still slow when the follow-up lands; the next
    // serialized tick publishes it instead of the badge staying stale.
    latest = [stewardConversation('direct-1', 3, 'Follow-up reply.')];
    await vi.advanceTimersByTimeAsync(200);
    poller.stop();
    expect(unreadViaStore()).toBe(1);
    expect(conversationUnreadStore.conversations()?.find((item) => item.id === 'direct-1')?.latestMessage)
      .toBe('Follow-up reply.');
    expect(maxPending).toBe(1);
  });

  it('skips a manual tick while a load is in flight and lets the in-flight one publish', async () => {
    const resolvers: Array<(value: MemberConversation[]) => void> = [];
    const load = vi.fn().mockImplementation(() => new Promise<MemberConversation[]>((resolve) => {
      resolvers.push(resolve);
    }));
    const onPublished = vi.fn();
    const poller = createConversationUnreadPoller('user-1', { load, onPublished });

    const first = poller.tick();
    // A second tick while the first load is pending must not start a second
    // request; it resolves null immediately.
    await expect(poller.tick()).resolves.toBeNull();
    expect(resolvers).toHaveLength(1);

    resolvers[0]?.([stewardConversation('direct-1', 2, 'Latest projection.')]);
    expect(await first).not.toBeNull();
    expect(unreadViaStore()).toBe(1);
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('invalidate() drops an in-flight tick when a newer authoritative refresh wins', async () => {
    let resolveLoad: (value: MemberConversation[]) => void = () => {};
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<MemberConversation[]>((resolve) => {
        resolveLoad = resolve;
      }))
      .mockResolvedValue([stewardConversation('direct-1', 1, 'Fresh projection.')]);
    const onPublished = vi.fn();
    const poller = createConversationUnreadPoller('user-1', { load, onPublished, intervalMs: 30 });
    poller.start();
    await vi.advanceTimersByTimeAsync(30);

    // pull-to-refresh / the open thread's read acknowledgement starts a full
    // dashboard reload: the older poll must not publish over it.
    poller.invalidate();
    resolveLoad([stewardConversation('direct-1', 5, 'Older poll preview.')]);
    await vi.advanceTimersByTimeAsync(10);
    expect(conversationUnreadStore.conversations()).toBeNull();
    expect(onPublished).not.toHaveBeenCalled();

    // The timer survives invalidate(); the next tick publishes normally.
    await vi.advanceTimersByTimeAsync(30);
    expect(unreadViaStore()).toBe(1);
    expect(onPublished).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('refreshes the badge and the inbox/home projections from one poll without a manual refresh', async () => {
    // The mobile lane has no React renderer, so TabLayout/MessagesScreen cannot
    // mount here. The badge, inbox row, and Home metric all derive from the
    // same published projection: the store the badge reads, and the dashboard
    // snapshot AppProvider merges through onPublished for inbox and Home.
    let dashboard = dashboardFrom([stewardConversation('direct-1', 1, 'Earlier reply.')]);
    conversationUnreadStore.publish(dashboard.conversations);
    const next = [
      stewardConversation('direct-1', 3, 'Follow-up reply.'),
      stewardConversation('direct-2', 1, 'New committee member thread.'),
    ];
    const poller = createConversationUnreadPoller('user-1', {
      load: vi.fn().mockResolvedValue(next),
      onPublished: (conversations) => {
        dashboard = { ...dashboard, conversations: [...conversations] };
      },
    });

    expect(unreadViaStore()).toBe(1);
    expect(dashboardMetrics(dashboard, channels).unreadInboxItems).toBe(1);
    expect(buildMessageInbox(dashboard.conversations, channels).find((item) => item.id === 'direct-1')?.preview)
      .toBe('Earlier reply.');

    expect(await poller.tick()).not.toBeNull();

    expect(unreadViaStore()).toBe(2);
    expect(dashboardMetrics(dashboard, channels).unreadInboxItems).toBe(2);
    const inbox = buildMessageInbox(dashboard.conversations, channels);
    expect(inbox.find((item) => item.id === 'direct-1')?.preview).toBe('Follow-up reply.');
    expect(inbox.find((item) => item.id === 'direct-2')?.unread).toBe(1);
  });

  it('never publishes an in-flight tick after stop() invalidates it', async () => {
    let resolveLoad: (value: MemberConversation[]) => void = () => {};
    const load = vi.fn().mockImplementation(() => new Promise<MemberConversation[]>((resolve) => {
      resolveLoad = resolve;
    }));
    const onPublished = vi.fn();
    const poller = createConversationUnreadPoller('user-1', { load, onPublished });

    const inFlight = poller.tick();
    // Sign-out / account switch / background lands while the request awaits:
    // stop() must invalidate the pending tick, not just clear future intervals.
    poller.stop();
    resolveLoad([stewardConversation('direct-1', 5, 'Stale cross-account preview.')]);
    expect(await inFlight).toBeNull();

    // The stale projection never reached the global store or the owner.
    expect(conversationUnreadStore.conversations()).toBeNull();
    expect(onPublished).not.toHaveBeenCalled();
    expect(unreadViaStore()).toBe(0);
  });

  it('leaves the previous counts intact when a tick fails', async () => {
    let fail = false;
    const poller = createConversationUnreadPoller('user-1', {
      load: vi.fn().mockImplementation(async () => {
        if (fail) throw new Error('network down');
        return [
          stewardConversation('direct-1', 2, 'Last good projection.'),
          stewardConversation('direct-2', 1, 'Second thread.'),
        ];
      }),
    });

    await poller.tick();
    expect(unreadViaStore()).toBe(2);
    const versionBefore = conversationUnreadStore.getVersion();

    fail = true;
    expect(await poller.tick()).toBeNull();

    // The failed refresh neither cleared nor corrupted the last good counts.
    expect(conversationUnreadStore.getVersion()).toBe(versionBefore);
    const kept = conversationUnreadStore.conversations();
    expect(kept?.find((item) => item.id === 'direct-1')?.unreadCount).toBe(2);
    expect(kept?.find((item) => item.id === 'direct-1')?.latestMessage).toBe('Last good projection.');
    expect(unreadViaStore()).toBe(2);
  });
});

describe('conversation unread poll wiring', () => {
  // UX-UG-DIRECT-STEWARD-CONVERSATION-UNREAD-HAS-NO-REALTIME-OR-POLLING-PATH-THE-MESSAGES-20260921:
  // the poller must start only for an authenticated session, stop on
  // background and sign-out, and never run in preview mode; the badge reads
  // the same versioned store the poll publishes through.
  it('gates the poller on an authenticated session and foreground state', () => {
    const provider = source('../state/AppProvider.tsx');

    expect(provider).toContain("if (mode !== 'authenticated' || !session) return undefined;");
    expect(provider).toContain("if (next === 'active') poller.start();");
    expect(provider).toContain('else poller.stop();');
    expect(provider).toContain('poller.stop();');
    expect(provider).toContain('load: loadConversationSummaries');
  });

  it('publishes fetchDashboard and poll refreshes through the one versioned store the badge subscribes to', () => {
    const provider = source('../state/AppProvider.tsx');
    const tabs = source('../../app/(tabs)/_layout.tsx');

    expect(provider).toContain('conversationUnreadStore.publish(nextDashboard.conversations)');
    expect(provider).toContain('conversationUnreadStore.reset()');
    expect(tabs).toContain('useSyncExternalStore(conversationUnreadStore.subscribe, conversationUnreadStore.getVersion)');
    expect(tabs).toContain("mode === 'authenticated'");
    expect(tabs).toContain('nativeInboxUnreadItemCount(conversations, channels)');
  });

  it('acknowledges the read in the open thread reconcile path, not only on initial load', () => {
    const thread = source('../../app/conversation/[id].tsx');

    // The reconcile branch the 30s timer and foreground event drive must
    // clear a positive unread_count the same way the initial-load branch
    // does; otherwise the poll merges the open thread's unread count into
    // the badge while the member is reading it.
    const reconcile = thread.split('const reconcile = () => {')[1] ?? '';
    expect(reconcile.slice(0, 1800)).toContain('markConversationRead(writer, userID, id)');
    expect(reconcile.slice(0, 1800)).toContain('unreadCount: 0');
    // The dashboard refresh is reached through a ref so its changing identity
    // never restarts the load effect (REQ-UG-NATIVE-MESSAGE-ACTIONS-20260904).
    expect(reconcile.slice(0, 1800)).toContain('void refreshRef.current()');
    // A rejected acknowledgement is caught on its own, so it cannot reach the
    // load catch that clears the thread the reconcile just loaded.
    const reconcileBody = reconcile.split('const timer = setInterval')[0] ?? '';
    expect(reconcileBody).toMatch(/try \{\s*await markConversationRead\(writer, userID, id\);\s*\} catch \{\s*return;\s*\}/);
    // A null reload (conversation deleted or hidden by RLS) clears the thread.
    expect(reconcileThreadResult(null)).toBe('clear');
    expect(reconcileBody).toContain("if (reconcileThreadResult(next) === 'clear' || !next) { retireAuthoring(); setThread(null); return; }");
    // The initial-load branch keeps its acknowledgement.
    expect(thread).toContain('if (nextThread?.conversation.unreadCount && !nextThread.readerIsStaff)');
  });

  it('invalidates an in-flight poll when a full dashboard refresh wins', () => {
    const provider = source('../state/AppProvider.tsx');

    const fetchDashboard = provider.split('const fetchDashboard = useCallback')[1] ?? '';
    expect(fetchDashboard.slice(0, 900)).toContain('conversationPollerRef.current?.invalidate();');
    // The poller registers itself so fetchDashboard can reach it, and the
    // effect cleanup clears the ref before stopping the poller.
    expect(provider).toContain('conversationPollerRef.current = poller;');
    expect(provider).toContain('conversationPollerRef.current = null;');
  });

  it('resets the conversation store on every path that leaves an authenticated session', () => {
    const provider = source('../state/AppProvider.tsx');

    // Session-revalidation sign-out, the auth-state-change SIGNED_OUT branch,
    // and PREVIEW entry each clear the dashboard/live-channel state; the
    // module-global conversation store must be cleared on all of them so the
    // badge can never keep counting a former live account in preview mode.
    expect(provider).toContain('signedOut: () => {\n          const lossTransition = ++sessionTransition.current;');
    const revalidateSignedOut = provider.split('signedOut: () => {')[1] ?? '';
    expect(revalidateSignedOut.slice(0, 700)).toContain('conversationUnreadStore.reset()');
    const authChangeSignedOut = provider.split('liveChannelStore.resetForSession();')[1] ?? '';
    expect(authChangeSignedOut.slice(0, 200)).toContain('conversationUnreadStore.reset()');
    const previewEntry = provider.split('resetPreviewHandoffs();')[0] ?? '';
    expect(previewEntry.slice(-400)).toContain('conversationUnreadStore.reset()');
  });
});

describe('policy and connectivity changes preserve the unread deadline', () => {
  beforeEach(() => { vi.useFakeTimers(); conversationUnreadStore.reset(); });
  afterEach(() => { vi.useRealTimers(); conversationUnreadStore.reset(); });

  it('cannot starve a poll by changing cost signals before every interval ends', async () => {
    const load = vi.fn(async () => []);
    const poller = createConversationUnreadPoller('member', { load });
    poller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    poller.setPolicy(120_000, true);
    await vi.advanceTimersByTimeAsync(20_000);
    poller.setPolicy(30_000, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('performs an overdue poll on reconnect', async () => {
    const load = vi.fn(async () => []);
    const poller = createConversationUnreadPoller('member', { load });
    poller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    poller.setPolicy(30_000, false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).not.toHaveBeenCalled();
    poller.setPolicy(30_000, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});


it('rejects a policy-disconnected response before it can restore revoked counts', async () => {
  conversationUnreadStore.reset();
  let finish!: (rows: readonly MemberConversation[]) => void;
  const poller = createConversationUnreadPoller('member', { load: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = poller.tick();
  poller.setPolicy(30_000, false);
  finish([stewardConversation('old', 3, 'Old projection')]);
  expect(await pending).toBeNull();
  expect(conversationUnreadStore.conversations()).toBeNull();
});

// G7-7900: a Steward Direct refusal that lands while a summary load awaits
// means the load began before it; its rows are not published.
it('does not publish a load that began before a Committee Direct refusal', async () => {
  conversationUnreadStore.reset();
  let epoch = 0;
  let finish: (rows: MemberConversation[]) => void = () => undefined;
  const onPublished = vi.fn();
  const poller = createConversationUnreadPoller('user-1', {
    load: () => new Promise<MemberConversation[]>((resolve) => { finish = resolve; }),
    refusalEpoch: () => epoch,
    onPublished,
  });
  const stale = poller.tick();
  epoch += 1;
  finish([stewardConversation('private', 1, 'Private before the refusal')]);
  expect(await stale).toBeNull();
  expect(onPublished).not.toHaveBeenCalled();
  expect(conversationUnreadStore.conversations()).toBeNull();
  const fresh = poller.tick();
  finish([]);
  expect(await fresh).toEqual([]);
  expect(onPublished).toHaveBeenCalledWith([]);
});

// G4-7900: the load's own read met the refusal and moved the epoch. Its empty
// page is still published, so the refused rows leave the screen.
it('publishes the empty page of a load that met the refusal itself', async () => {
  conversationUnreadStore.reset();
  let epoch = 0;
  const onPublished = vi.fn();
  const poller = createConversationUnreadPoller('user-1', {
    load: async () => { epoch += 1; return []; },
    refusalEpoch: () => epoch,
    onPublished,
  });
  expect(await poller.tick()).toEqual([]);
  expect(onPublished).toHaveBeenCalledWith([]);
  expect(conversationUnreadStore.conversations()).toEqual([]);
});
