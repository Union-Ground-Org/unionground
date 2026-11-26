import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentState: 'active',
  listeners: new Set<(state: string) => void>(),
  addAppStateListener: vi.fn(),
  removeAppStateListener: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() { return mocks.currentState; },
    addEventListener: mocks.addAppStateListener,
  },
}));

import * as lifecycleModule from './authRefreshLifecycle';

type StartLifecycle = (auth: {
  startAutoRefresh(): void;
  stopAutoRefresh(): void;
}) => () => void;

const startLifecycle = (lifecycleModule as { startSupabaseAuthRefreshLifecycle?: StartLifecycle })
  .startSupabaseAuthRefreshLifecycle;

function createAuthControl() {
  return {
    startAutoRefresh: vi.fn(),
    stopAutoRefresh: vi.fn(),
  };
}

describe('Supabase auth refresh lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentState = 'active';
    mocks.listeners.clear();
    mocks.addAppStateListener.mockImplementation((_event: string, listener: (state: string) => void) => {
      mocks.listeners.add(listener);
      return {
        remove: () => {
          mocks.removeAppStateListener();
          mocks.listeners.delete(listener);
        },
      };
    });
  });

  it('starts token refresh when the app is initially active', () => {
    expect(startLifecycle).toBeTypeOf('function');
    if (!startLifecycle) return;
    const auth = createAuthControl();

    const stop = startLifecycle(auth);

    expect(auth.startAutoRefresh).toHaveBeenCalledOnce();
    expect(auth.stopAutoRefresh).not.toHaveBeenCalled();
    stop();
  });

  it('stops token refresh outside the active state and restarts it on return', () => {
    expect(startLifecycle).toBeTypeOf('function');
    if (!startLifecycle) return;
    mocks.currentState = 'inactive';
    const auth = createAuthControl();

    const stop = startLifecycle(auth);
    expect(auth.stopAutoRefresh).toHaveBeenCalledOnce();

    for (const listener of mocks.listeners) listener('active');
    expect(auth.startAutoRefresh).toHaveBeenCalledOnce();

    for (const listener of mocks.listeners) listener('background');
    expect(auth.stopAutoRefresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('removes its listener and leaves a retained stale callback inert on cleanup', () => {
    expect(startLifecycle).toBeTypeOf('function');
    if (!startLifecycle) return;
    const auth = createAuthControl();

    const stop = startLifecycle(auth);
    const [staleListener] = mocks.listeners;
    stop();

    expect(mocks.removeAppStateListener).toHaveBeenCalledOnce();
    expect(auth.stopAutoRefresh).toHaveBeenCalledOnce();
    staleListener?.('active');
    expect(auth.startAutoRefresh).toHaveBeenCalledOnce();
  });
});
