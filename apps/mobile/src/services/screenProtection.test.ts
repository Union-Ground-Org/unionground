import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  appStateListeners: new Set<(state: string) => void>(),
  addAppStateListener: vi.fn(),
  isAvailableAsync: vi.fn(),
  preventScreenCaptureAsync: vi.fn(),
  allowScreenCaptureAsync: vi.fn(),
  enableAppSwitcherProtectionAsync: vi.fn(),
  disableAppSwitcherProtectionAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: { addEventListener: mocks.addAppStateListener },
}));
vi.mock('expo-screen-capture', () => ({
  isAvailableAsync: mocks.isAvailableAsync,
  preventScreenCaptureAsync: mocks.preventScreenCaptureAsync,
  allowScreenCaptureAsync: mocks.allowScreenCaptureAsync,
  enableAppSwitcherProtectionAsync: mocks.enableAppSwitcherProtectionAsync,
  disableAppSwitcherProtectionAsync: mocks.disableAppSwitcherProtectionAsync,
}));

import {
  disableAuthenticatedScreenProtection,
  enableAuthenticatedScreenProtection,
  startAuthenticatedScreenProtection,
} from './screenProtection';

function flushPromises(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}

describe('authenticated screen protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.OS = 'ios';
    mocks.appStateListeners.clear();
    mocks.addAppStateListener.mockImplementation((_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => { mocks.appStateListeners.delete(listener); } };
    });
    mocks.isAvailableAsync.mockResolvedValue(true);
    mocks.preventScreenCaptureAsync.mockResolvedValue(undefined);
    mocks.allowScreenCaptureAsync.mockResolvedValue(undefined);
    mocks.enableAppSwitcherProtectionAsync.mockResolvedValue(undefined);
    mocks.disableAppSwitcherProtectionAsync.mockResolvedValue(undefined);
  });

  it('protects screenshots and app-switcher previews on iOS', async () => {
    await expect(enableAuthenticatedScreenProtection()).resolves.toBe(true);

    expect(mocks.preventScreenCaptureAsync).toHaveBeenCalledWith('authenticated-session');
    expect(mocks.enableAppSwitcherProtectionAsync).toHaveBeenCalledWith(1);

    await disableAuthenticatedScreenProtection();
    expect(mocks.allowScreenCaptureAsync).toHaveBeenCalledWith('authenticated-session');
    expect(mocks.disableAppSwitcherProtectionAsync).toHaveBeenCalledOnce();
  });

  it('uses FLAG_SECURE-backed capture protection on Android', async () => {
    mocks.platform.OS = 'android';

    await expect(enableAuthenticatedScreenProtection()).resolves.toBe(true);
    expect(mocks.preventScreenCaptureAsync).toHaveBeenCalledWith('authenticated-session');
    expect(mocks.enableAppSwitcherProtectionAsync).not.toHaveBeenCalled();

    await disableAuthenticatedScreenProtection();
    expect(mocks.allowScreenCaptureAsync).toHaveBeenCalledWith('authenticated-session');
    expect(mocks.disableAppSwitcherProtectionAsync).not.toHaveBeenCalled();
  });

  it('does not request protection when the native API is unavailable', async () => {
    mocks.isAvailableAsync.mockResolvedValue(false);

    await expect(enableAuthenticatedScreenProtection()).resolves.toBe(false);
    expect(mocks.preventScreenCaptureAsync).not.toHaveBeenCalled();
    expect(mocks.enableAppSwitcherProtectionAsync).not.toHaveBeenCalled();
  });

  it('still releases screen capture when iOS overlay cleanup fails', async () => {
    mocks.disableAppSwitcherProtectionAsync.mockRejectedValue(new Error('overlay cleanup failed'));

    await expect(disableAuthenticatedScreenProtection()).rejects.toThrow('overlay cleanup failed');
    expect(mocks.allowScreenCaptureAsync).toHaveBeenCalledWith('authenticated-session');
  });

  it('serializes cleanup behind an in-flight native protection request', async () => {
    let resolveAvailability: ((available: boolean) => void) | undefined;
    mocks.isAvailableAsync.mockReturnValue(new Promise((resolve) => {
      resolveAvailability = resolve;
    }));

    const enabling = enableAuthenticatedScreenProtection();
    const disabling = disableAuthenticatedScreenProtection();
    expect(mocks.allowScreenCaptureAsync).not.toHaveBeenCalled();

    resolveAvailability?.(true);
    await enabling;
    await disabling;

    expect(mocks.preventScreenCaptureAsync.mock.invocationCallOrder[0]!)
      .toBeLessThan(mocks.allowScreenCaptureAsync.mock.invocationCallOrder[0]!);
  });

  it('retries one failed enable request on the next foreground transition', async () => {
    mocks.isAvailableAsync.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const stop = startAuthenticatedScreenProtection();
    await flushPromises();
    expect(mocks.addAppStateListener).toHaveBeenCalledWith('change', expect.any(Function));
    expect(mocks.preventScreenCaptureAsync).not.toHaveBeenCalled();

    for (const listener of mocks.appStateListeners) listener('background');
    await flushPromises();
    expect(mocks.preventScreenCaptureAsync).not.toHaveBeenCalled();

    for (const listener of mocks.appStateListeners) listener('active');
    await flushPromises();
    expect(mocks.preventScreenCaptureAsync).toHaveBeenCalledWith('authenticated-session');
    expect(mocks.appStateListeners).toHaveLength(0);

    stop();
    await flushPromises();
  });

  it('removes a pending retry listener when authentication ends', async () => {
    mocks.isAvailableAsync.mockRejectedValueOnce(new Error('native protection unavailable'));

    const stop = startAuthenticatedScreenProtection();
    await flushPromises();
    expect(mocks.appStateListeners.size).toBe(1);
    const [staleListener] = mocks.appStateListeners;

    stop();
    await flushPromises();
    expect(mocks.appStateListeners.size).toBe(0);

    staleListener?.('active');
    await flushPromises();
    expect(mocks.preventScreenCaptureAsync).not.toHaveBeenCalled();
  });
});
