// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { guidedDestinationGroups, INACTIVE_ONBOARDING_GUIDE } from '../../lib/onboardingGuide';
import type { HatFunctionGroup } from '../../lib/hatFunctions';

// BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018: an RPC error used
// to return the inactive guide, which reads exactly like finished onboarding.
// These tests drive the shipped hook with a stubbed Supabase client: a failed
// read yields an error state with a retry, a successful retry restores the
// guide, and returning to the foreground re-reads a bounded number of times.

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  session: { user: { id: 'user-a' } },
  appStateListeners: [] as ((state: string) => void)[],
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.push(listener);
      return { remove: () => { mocks.appStateListeners.splice(mocks.appStateListeners.indexOf(listener), 1); } };
    },
  },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-router', () => ({ useIsFocused: () => true }));
vi.mock('../../services/supabase', () => ({ getSupabaseClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => ({ mode: 'authenticated', session: mocks.session }) }));

import { GUIDE_FOREGROUND_RETRY_LIMIT, loadNativeOnboardingGuide, useOnboardingGuide, type OnboardingGuideState } from './useOnboardingGuide';

const READY = {
  state: 'ready',
  applies: true,
  enrolled: true,
  totalSteps: 6,
  completedSteps: 1,
  onboardingComplete: false,
  progressiveDisclosureActive: true,
  stage: 'welcome',
  nextStep: { id: 'step-2', title: 'Meet the committee' },
  featureDrip: false,
  showHud: true,
  spotlight: null,
  badge: null,
  switches: { progressiveDisclosure: true },
};
const FAILED = { data: null, error: { code: 'PGRST301', message: 'network' } };

let container: HTMLDivElement;
let root: Root;
let latest: OnboardingGuideState | null = null;

function Probe() {
  latest = useOnboardingGuide();
  return null;
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function mount() {
  await act(async () => { root.render(createElement(Probe)); });
  await flush();
}

function foreground() {
  act(() => { for (const listener of [...mocks.appStateListeners]) listener('active'); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.rpc.mockReset();
  mocks.session = { user: { id: 'user-a' } };
  mocks.appStateListeners.length = 0;
  latest = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('native onboarding guide read (BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018)', () => {
  it.each([
    { state: 'unavailable', applies: false, onboardingComplete: true },
    { state: 'ready' },
  ])('keeps retry errors visible after an unconfirmed response %j', async (data: { state: string; applies?: boolean; onboardingComplete?: boolean }) => {
    mocks.rpc.mockResolvedValueOnce({ data, error: null }).mockResolvedValue(FAILED);
    await mount();
    await act(async () => { latest?.retry(); });
    await flush();
    expect(latest?.loadFailed).toBe(true);
  });

  it('recovers the mounted Home and drawer together without sharing with another session', async () => {
    const firstSession = mocks.session;
    const secondSession = { user: { id: 'user-a' } };
    const values = new Map<string, OnboardingGuideState>();
    function Consumer({ name, session }: { name: string; session: typeof firstSession }) {
      mocks.session = session;
      const value = useOnboardingGuide();
      values.set(name, value);
      return createElement('div', { 'data-consumer': name }, value.guide.nextStep?.title ?? 'no step');
    }
    mocks.rpc.mockResolvedValue(FAILED);
    await act(async () => { root.render(createElement('div', {},
      createElement(Consumer, { name: 'home', session: firstSession }),
      createElement(Consumer, { name: 'drawer', session: firstSession }),
      createElement(Consumer, { name: 'other', session: secondSession }),
    )); });
    await flush();
    expect(values.get('drawer')?.loadFailed).toBe(true);
    mocks.rpc.mockResolvedValue({ data: { ...READY, spotlight: 'member-support' }, error: null });
    await act(async () => { values.get('home')?.retry(); });
    await flush();
    for (const name of ['home', 'drawer']) {
      const value = values.get(name)!;
      expect(value.loadFailed).toBe(false);
      expect(value.guide.nextStep?.title).toBe('Meet the committee');
      const groups: HatFunctionGroup[] = [{ key: 'features', label: 'Features', items: [
        { key: 'support', label: 'Support', href: '/feature/member-support', icon: 'help' },
        { key: 'events', label: 'Meetings', href: '/feature/events', icon: 'calendar' },
      ] }];
      expect(guidedDestinationGroups(groups, value.guide, value.showAll)[0]?.items.map(item => item.href))
        .toEqual(['/feature/member-support?source=onboarding']);
    }
    expect(values.get('other')?.loadFailed).toBe(true);
    expect(values.get('other')?.guide).toEqual(INACTIVE_ONBOARDING_GUIDE);
  });

  it('keeps sibling retry errors and pending recovery intact when a consumer receives an unready response', async () => {
    type Response = { data: unknown; error: unknown };
    let finishDrawer!: (response: Response) => void;
    let finishRecovery!: (response: Response) => void;
    const values = new Map<string, OnboardingGuideState>();
    function Consumer({ name }: { name: string }) {
      values.set(name, useOnboardingGuide());
      return null;
    }
    const unavailable = { data: { state: 'unavailable', applies: false }, error: null };
    mocks.rpc.mockResolvedValueOnce(FAILED)
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishDrawer = resolve; }));
    await act(async () => { root.render(createElement('div', {},
      createElement(Consumer, { name: 'home' }), createElement(Consumer, { name: 'drawer' }),
    )); });
    await flush();
    expect(values.get('home')?.loadFailed).toBe(true);
    await act(async () => { finishDrawer(unavailable); });
    expect(values.get('home')?.loadFailed).toBe(true);
    expect(values.get('drawer')?.loadFailed).toBe(false);

    // The later unready response also must not supersede a pending real recovery.
    mocks.rpc.mockImplementationOnce(() => new Promise<Response>(resolve => { finishRecovery = resolve; }))
      .mockResolvedValueOnce(unavailable);
    await act(async () => { values.get('home')?.retry(); });
    await act(async () => { values.get('drawer')?.retry(); });
    await act(async () => { finishRecovery({ data: READY, error: null }); });
    for (const name of ['home', 'drawer']) {
      expect(values.get(name)?.loadFailed).toBe(false);
      expect(values.get(name)?.guide.nextStep?.title).toBe('Meet the committee');
    }
  });

  it('rejects on an RPC error instead of returning the inactive guide', async () => {
    mocks.rpc.mockResolvedValueOnce(FAILED);
    await expect(loadNativeOnboardingGuide()).rejects.toMatchObject({ code: 'PGRST301' });
    mocks.rpc.mockResolvedValueOnce({ data: READY, error: null });
    await expect(loadNativeOnboardingGuide()).resolves.toMatchObject({ applies: true, stage: 'welcome' });
  });

  it('turns a failed read into an error state, and a successful retry restores the guide', async () => {
    mocks.rpc.mockResolvedValueOnce(FAILED).mockResolvedValue({ data: READY, error: null });
    await mount();
    expect(latest?.loadFailed).toBe(true);
    expect(latest?.guide).toEqual(INACTIVE_ONBOARDING_GUIDE);
    await act(async () => { latest?.retry(); });
    await flush();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(latest?.loadFailed).toBe(false);
    expect(latest?.guide).toMatchObject({ applies: true, progressiveDisclosureActive: true, nextStep: { title: 'Meet the committee' } });
  });

  it('re-reads on return to the foreground a bounded number of times; Try again is never capped', async () => {
    mocks.rpc.mockResolvedValue(FAILED);
    await mount();
    expect(latest?.loadFailed).toBe(true);
    for (let attempt = 0; attempt < GUIDE_FOREGROUND_RETRY_LIMIT + 2; attempt += 1) {
      foreground();
      await flush();
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(GUIDE_FOREGROUND_RETRY_LIMIT + 1);
    await act(async () => { latest?.retry(); });
    await flush();
    expect(mocks.rpc).toHaveBeenCalledTimes(GUIDE_FOREGROUND_RETRY_LIMIT + 2);
    expect(latest?.loadFailed).toBe(true);
  });

  it('does not let an old session response restore guidance in a replacement session', async () => {
    let resolveOld!: (value: { data: typeof READY; error: null }) => void;
    mocks.rpc.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(FAILED);
    await mount();
    mocks.session = { user: { id: 'user-a' } };
    await act(async () => { root.render(createElement(Probe)); });
    await flush();
    expect(latest?.loadFailed).toBe(true);
    await act(async () => { resolveOld({ data: READY, error: null }); });
    expect(latest?.guide).toEqual(INACTIVE_ONBOARDING_GUIDE);
    expect(latest?.loadFailed).toBe(true);
  });

  it('suppresses later errors after validated completion', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { ...READY, onboardingComplete: true, stage: 'complete' }, error: null }).mockResolvedValue(FAILED);
    await mount();
    await act(async () => { latest?.retry(); });
    await flush();
    expect(latest?.loadFailed).toBe(false);
  });

  it('shows no error state when the last good read said no guide applies', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { state: 'ready', applies: false }, error: null }).mockResolvedValueOnce(FAILED);
    await mount();
    expect(latest?.loadFailed).toBe(false);
    await act(async () => { latest?.retry(); });
    await flush();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(latest?.loadFailed).toBe(false);
  });
});
