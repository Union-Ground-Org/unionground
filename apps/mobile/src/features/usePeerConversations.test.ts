// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Notice = { new: { user_id: string } };
type Channel = { filter: Record<string, string>; deliver: (notice: Notice) => void; status: (status: string) => void };
const backend = vi.hoisted(() => ({
  rpc: vi.fn(), getSession: vi.fn(), removeChannel: vi.fn(), authUnsubscribe: vi.fn(),
  channels: [] as Channel[],
  auth: new Set<(event: string, session: { user: { id: string } } | null) => void>(),
  appState: 'active', appListeners: new Set<(state: string) => void>(),
  pushes: new Set<() => void>(), lowData: false,
}));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'https://notice-test.invalid', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));
vi.mock('react-native', () => ({ AppState: {
  get currentState() { return backend.appState; },
  addEventListener: (_event: string, listener: (state: string) => void) => {
    backend.appListeners.add(listener);
    return { remove: () => backend.appListeners.delete(listener) };
  },
} }));
vi.mock('expo-notifications', () => ({ addNotificationReceivedListener: (listener: () => void) => {
  backend.pushes.add(listener);
  return { remove: () => backend.pushes.delete(listener) };
} }));
// The real hook, service and Supabase adapter run. Only the SDK transport and
// native surfaces are replaced. The fake server honours the registered filter.
vi.mock('@supabase/supabase-js', () => ({ processLock: vi.fn(), createClient: () => ({
  rpc: backend.rpc,
  auth: {
    getSession: backend.getSession,
    onAuthStateChange: (listener: (event: string, session: { user: { id: string } } | null) => void) => {
      backend.auth.add(listener);
      return { data: { subscription: { unsubscribe: () => { backend.auth.delete(listener); backend.authUnsubscribe(); } } } };
    },
  },
  channel: () => {
    const record: Channel = { filter: {}, deliver: () => undefined, status: () => undefined };
    backend.channels.push(record);
    const channel = {
      on: (_event: string, filter: Record<string, string>, callback: (notice: Notice) => void) => {
        record.filter = filter; record.deliver = callback; return channel;
      },
      subscribe: (callback: (status: string) => void) => { record.status = callback; return channel; },
    };
    return channel;
  },
  removeChannel: backend.removeChannel,
}) }));

import { taskDiscussionScope } from '../lib/taskDiscussions';
import { pollIntervalMsFor, resolveLowDataPolicy, UNKNOWN_NETWORK_SIGNALS } from '../lib/lowDataPolicy';
import { usePeerConversations } from './usePeerConversations';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const POLL = 30_000;
const conversation = { id: 'pair', peerName: 'Rosa', peerInitials: 'RD', updatedAt: '2026-11-20T12:00:00Z', messages: [] };
let root: Root;
let container: HTMLDivElement;
function Harness({ user = A, poll = POLL, connected = true }: { user?: string | null; poll?: number; connected?: boolean }) {
  const state = usePeerConversations(taskDiscussionScope(user, 'org', 'chapter'), 0, poll, connected);
  return createElement('div', null, state.items.map((item) => item.peerName).join(','));
}
const render = (user: string | null = A, poll = pollIntervalMsFor(resolveLowDataPolicy(backend.lowData ? 'on' : 'off', UNKNOWN_NETWORK_SIGNALS)), connected = true) => act(async () => { root.render(createElement(Harness, { user, poll, connected })); });
const insert = (user = A) => act(async () => {
  for (const channel of backend.channels) {
    if (channel.filter.filter === `user_id=eq.${user}`) channel.deliver({ new: { user_id: user } });
  }
});
const auth = (user: string | null) => act(async () => {
  // Model the SDK's session as well as its event; AppProvider may ignore the
  // event while a staged native operation later restores the original user.
  backend.getSession.mockResolvedValue({ data: { session: user ? { user: { id: user } } : null }, error: null });
  for (const listener of [...backend.auth]) listener(user ? 'SIGNED_IN' : 'SIGNED_OUT', user ? { user: { id: user } } : null);
});
const appState = (next: string) => act(async () => {
  backend.appState = next;
  for (const listener of backend.appListeners) listener(next);
});
const tick = (ms = POLL) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  backend.rpc.mockReset().mockResolvedValue({ data: { conversations: [] }, error: null });
  backend.getSession.mockReset().mockResolvedValue({ data: { session: { user: { id: A } } }, error: null });
  backend.removeChannel.mockReset().mockResolvedValue('ok');
  backend.authUnsubscribe.mockReset();
  backend.channels.length = 0;
  backend.auth.clear(); backend.appListeners.clear(); backend.pushes.clear();
  backend.appState = 'active'; backend.lowData = false;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('Ledger 530: recipient notices refresh the real peer list before its poll', () => {
  it('shows a new conversation immediately on its recipient INSERT without push opt-in or a timer tick', async () => {
    await render();
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    backend.rpc.mockResolvedValue({ data: { conversations: [conversation] }, error: null });
    await insert();
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    expect(backend.rpc).toHaveBeenLastCalledWith('list_reward_peer_contact', undefined);
    expect(container.textContent).toBe('Rosa');
    expect(backend.channels[0]!.filter).toEqual({ event: 'INSERT', schema: 'public', table: 'member_notifications', filter: `user_id=eq.${A}` });
    await act(async () => undefined);
    expect(backend.rpc).toHaveBeenCalledTimes(2); // reading the list does not emit a notice
  });

  it('does not refresh for another recipient, even a late/misrouted payload', async () => {
    await render();
    expect(backend.channels).toHaveLength(1);
    await insert(B);
    await act(async () => { backend.channels[0]!.deliver({ new: { user_id: B } }); });
    expect(backend.rpc).toHaveBeenCalledTimes(1);
  });

  it('catches a message inserted between the initial read and SUBSCRIBED without looping', async () => {
    await render();
    backend.rpc.mockResolvedValue({ data: { conversations: [conversation] }, error: null });
    await act(async () => { backend.channels[0]!.status('SUBSCRIBED'); });
    expect(container.textContent).toBe('Rosa');
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    await act(async () => { backend.channels[0]!.status('SUBSCRIBED'); });
    expect(backend.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([null, B])('retires callbacks synchronously on auth change to %s before React rerenders', async (user) => {
    await render();
    const old = backend.channels[0]!;
    expect(old).toBeDefined();
    await auth(user);
    await act(async () => { old.deliver({ new: { user_id: A } }); });
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(backend.removeChannel).toHaveBeenCalledTimes(1);
    expect(backend.auth.size).toBe(0);
    backend.getSession.mockResolvedValue({ data: { session: user ? { user: { id: user } } : null }, error: null });
    await render(user);
    const reads = backend.rpc.mock.calls.length;
    await act(async () => { old.deliver({ new: { user_id: A } }); });
    expect(backend.rpc).toHaveBeenCalledTimes(reads);
    expect(container.textContent).toBe('');
  });

  it('removes the channel in background, ignores late callbacks, and catches up on foreground', async () => {
    await render();
    const old = backend.channels[0]!; expect(old).toBeDefined();
    await appState('background');
    await act(async () => { old.deliver({ new: { user_id: A } }); });
    await tick(POLL * 3);
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(backend.removeChannel).toHaveBeenCalledTimes(1);
    await appState('active');
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    expect(backend.channels).toHaveLength(2);
    await insert();
    expect(backend.rpc).toHaveBeenCalledTimes(3);
  });

  it.each([null, B])('keeps polling a retained scope after an ignored auth meeting for %s and restoration of its owner', async (user) => {
    await render();
    const retired = backend.channels[0]!;
    await auth(user);
    backend.rpc.mockResolvedValue({ data: { conversations: [{ ...conversation, peerName: 'Other account' }] }, error: null });
    await tick();
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');

    // AppProvider kept A's scope (nativeAuthGate/staged-session early return).
    // The native flow restores A. No render, tab change, refresh key, interval
    // change or connectivity change may be needed to resume the existing poll.
    await auth(A);
    backend.rpc.mockResolvedValue({ data: { conversations: [conversation] }, error: null });
    await tick();
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('Rosa');
    expect(backend.channels).toHaveLength(1);
    expect(backend.removeChannel).toHaveBeenCalledTimes(1);
    await act(async () => { retired.deliver({ new: { user_id: A } }); });
    expect(backend.rpc).toHaveBeenCalledTimes(2);
  });

  it('does not publish a retained-scope poll if its owner changes again while the read is pending', async () => {
    await render();
    await auth(B);
    await auth(A);
    let settle!: (answer: { data: { conversations: typeof conversation[] }; error: null }) => void;
    backend.rpc.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await tick();
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    // The socket watcher is already retired; the poll must check the current
    // session again before publishing, even without a React scope change.
    await auth(B);
    await act(async () => { settle({ data: { conversations: [{ ...conversation, peerName: 'Other account' }] }, error: null }); });
    expect(container.textContent).toBe('');
    await auth(A);
    backend.rpc.mockResolvedValue({ data: { conversations: [conversation] }, error: null });
    await tick();
    expect(container.textContent).toBe('Rosa');
  });

  it.each(['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'])('keeps the poll working after %s and ignores retired callbacks', async (status) => {
    await render();
    const old = backend.channels[0]!; expect(old).toBeDefined();
    await act(async () => { old.status(status); old.deliver({ new: { user_id: A } }); });
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    backend.rpc.mockResolvedValue({ data: { conversations: [conversation] }, error: null });
    await tick();
    expect(container.textContent).toBe('Rosa');
    expect(backend.rpc).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst behind an in-flight read without a loop', async () => {
    await render();
    let settle!: (answer: { data: { conversations: typeof conversation[] }; error: null }) => void;
    backend.rpc.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await insert(); await insert(); await insert();
    expect(backend.rpc).toHaveBeenCalledTimes(2);
    backend.rpc.mockResolvedValue({ data: { conversations: [conversation] }, error: null });
    await act(async () => { settle({ data: { conversations: [] }, error: null }); });
    expect(backend.rpc).toHaveBeenCalledTimes(3);
    expect(container.textContent).toBe('Rosa');
    await act(async () => undefined);
    expect(backend.rpc).toHaveBeenCalledTimes(3);
  });

  it('keeps Low data at 120 seconds with no socket, and still accepts a foreground push', async () => {
    backend.lowData = true;
    await render(A, 120_000);
    expect(backend.channels).toHaveLength(0);
    backend.rpc.mockResolvedValue({ data: { conversations: [conversation] }, error: null });
    await tick(119_999);
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    await act(async () => { for (const listener of backend.pushes) listener(); });
    expect(container.textContent).toBe('Rosa');
    await tick(1);
    expect(backend.rpc).toHaveBeenCalledTimes(3);
  });

  it('cancels pending subscribe setup after sign-out or background, without starting a late channel', async () => {
    let settle!: (answer: { data: { session: { user: { id: string } } }; error: null }) => void;
    backend.getSession.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await render();
    await auth(null);
    await appState('background');
    await act(async () => { settle({ data: { session: { user: { id: A } } }, error: null }); });
    expect(backend.channels).toHaveLength(0);
    expect(backend.auth.size).toBe(0);
  });

  it('stops a live socket when Low data turns on and restarts when it turns off', async () => {
    await render();
    const old = backend.channels[0]!;
    backend.lowData = true;
    await render(A, 120_000);
    expect(backend.removeChannel).toHaveBeenCalledTimes(1);
    expect(backend.channels).toHaveLength(1);
    const reads = backend.rpc.mock.calls.length;
    await act(async () => { old.deliver({ new: { user_id: A } }); });
    expect(backend.rpc).toHaveBeenCalledTimes(reads);
    backend.lowData = false;
    await render();
    expect(backend.channels).toHaveLength(2);
  });

  it('never opens a socket while offline or initially backgrounded and catches up on reconnect', async () => {
    backend.appState = 'background';
    await render();
    expect(backend.channels).toHaveLength(0);
    expect(backend.rpc).not.toHaveBeenCalled();
    await render(A, POLL, false);
    await appState('active');
    await tick();
    expect(backend.channels).toHaveLength(0);
    expect(backend.rpc).not.toHaveBeenCalled();
    await render();
    expect(backend.channels).toHaveLength(1);
    expect(backend.rpc).toHaveBeenCalledTimes(1);
  });

  it('ignores push and local refresh callbacks after auth loss, and removes every listener on unmount', async () => {
    await render();
    const push = [...backend.pushes][0]!;
    await auth(null);
    await act(async () => { push(); });
    await tick();
    expect(backend.rpc).toHaveBeenCalledTimes(1);
    await render(null);
    expect(backend.appListeners.size).toBe(0);
    expect(backend.pushes.size).toBe(0);
    expect(backend.auth.size).toBe(0);
  });

  it('keeps the socket through same-person auth refresh without resubscribing', async () => {
    await render();
    await auth(A);
    expect(backend.channels).toHaveLength(1);
    expect(backend.removeChannel).not.toHaveBeenCalled();
    await insert();
    expect(backend.rpc).toHaveBeenCalledTimes(2);
  });

  it('silently leaves the poll working when the session read refuses', async () => {
    backend.getSession.mockRejectedValueOnce(new Error('unavailable'));
    await render();
    expect(backend.channels).toHaveLength(0);
    await tick();
    expect(backend.rpc).toHaveBeenCalledTimes(2);
  });

  it('drops a read that settles in background and does not drain its queued refresh there', async () => {
    await render();
    let settle!: (answer: { data: { conversations: typeof conversation[] }; error: null }) => void;
    backend.rpc.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await insert(); await insert();
    await appState('background');
    await act(async () => { settle({ data: { conversations: [conversation] }, error: null }); });
    expect(container.textContent).toBe('');
    expect(backend.rpc).toHaveBeenCalledTimes(2);
  });

  it('does not replay a queued read or publish its old answer after account replacement', async () => {
    await render();
    let settle!: (answer: { data: { conversations: typeof conversation[] }; error: null }) => void;
    backend.rpc.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await insert(); await insert();
    await auth(B);
    backend.getSession.mockResolvedValue({ data: { session: { user: { id: B } } }, error: null });
    await render(B);
    const reads = backend.rpc.mock.calls.length;
    await act(async () => { settle({ data: { conversations: [conversation] }, error: null }); });
    expect(container.textContent).toBe('');
    expect(backend.rpc).toHaveBeenCalledTimes(reads);
  });
});
