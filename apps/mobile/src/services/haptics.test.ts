import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  selectionAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  impactAsync: vi.fn(async () => undefined),
  performAndroidHapticsAsync: vi.fn(async () => undefined),
  platform: { OS: 'ios', Version: 34 },
  appState: { currentState: 'active' },
  getItemAsync: vi.fn<() => Promise<string | null>>(async () => null),
  setItemAsync: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('expo-haptics', () => ({
  ...native,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  ImpactFeedbackStyle: { Light: 'light' },
  AndroidHaptics: { Segment_Tick: 'segment-tick', Segment_Frequent_Tick: 'segment-frequent-tick', Confirm: 'confirm', Reject: 'reject', Virtual_Key: 'virtual-key', Clock_Tick: 'clock-tick', Long_Press: 'long-press' },
}));
vi.mock('react-native', () => ({ Platform: native.platform, AppState: native.appState }));
vi.mock('expo-secure-store', () => ({ getItemAsync: native.getItemAsync, setItemAsync: native.setItemAsync }));

async function hydrated(preference: 'system' | 'subtle' | 'off' = 'system') {
  native.getItemAsync.mockResolvedValue(preference);
  const store = await import('./hapticPreference');
  await store.initializeHapticPreference();
  return { ...store, ...(await import('./haptics')) };
}

describe('native haptic boundaries', () => {
  beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); native.getItemAsync.mockResolvedValue(null); native.platform.OS = 'ios'; native.platform.Version = 34; native.appState.currentState = 'active'; });

  it('does not emit feedback while the app is in the background', async () => {
    const { haptics } = await hydrated();
    native.appState.currentState = 'background';
    await haptics.success();
    expect(native.notificationAsync).not.toHaveBeenCalled();
  });

  it('absorbs a synchronous unavailable-native-module failure', async () => {
    const { haptics } = await hydrated();
    native.selectionAsync.mockImplementationOnce(() => { throw new Error('native module unavailable'); });
    await expect(haptics.select()).resolves.toBeUndefined();
  });

  it('defaults to one standard native meeting per confirmed feedback request on iOS', async () => {
    const { haptics } = await hydrated();
    await haptics.select(); await haptics.success(); await haptics.warning(); await haptics.impact();
    expect(native.selectionAsync).toHaveBeenCalledTimes(1);
    expect(native.notificationAsync.mock.calls).toEqual([['success'], ['warning']]);
    expect(native.impactAsync).toHaveBeenCalledExactlyOnceWith('light');
  });

  it('uses Android system touch-feedback meetings without a vibrator fallback', async () => {
    native.platform.OS = 'android';
    const { haptics } = await hydrated();
    await haptics.select(); await haptics.success(); await haptics.warning(); await haptics.impact();
    expect(native.performAndroidHapticsAsync.mock.calls).toEqual([['segment-tick'], ['confirm'], ['reject'], ['virtual-key']]);
    expect(native.selectionAsync).not.toHaveBeenCalled();
    expect(native.notificationAsync).not.toHaveBeenCalled();
    expect(native.impactAsync).not.toHaveBeenCalled();
  });

  it.each(['ios', 'android'])('Subtle requests only gentle feedback on %s', async (platform) => {
    native.platform.OS = platform;
    const { haptics } = await hydrated('subtle');
    await haptics.select(); await haptics.success(); await haptics.warning(); await haptics.impact();
    if (platform === 'ios') expect(native.selectionAsync).toHaveBeenCalledTimes(4);
    else expect(native.performAndroidHapticsAsync.mock.calls).toEqual(Array.from({ length: 4 }, () => ['segment-frequent-tick']));
    expect(native.notificationAsync).not.toHaveBeenCalled(); expect(native.impactAsync).not.toHaveBeenCalled();
  });

  it.each([24, 29, 30, 33])('keeps feedback available without newer constants on Android API %s', async (api) => {
    native.platform.OS = 'android'; native.platform.Version = api;
    const { haptics, saveHapticPreference } = await hydrated();
    await haptics.select(); await haptics.success(); await haptics.warning();
    await saveHapticPreference('subtle'); await haptics.success();
    expect(native.performAndroidHapticsAsync.mock.calls).toEqual([
      ['clock-tick'], [api >= 30 ? 'confirm' : 'virtual-key'], [api >= 30 ? 'reject' : 'long-press'], ['clock-tick'],
    ]);
  });

  it.each(['ios', 'android', 'web', 'windows'])('Off suppresses every feedback request on %s', async (platform) => {
    native.platform.OS = platform;
    const { haptics } = await hydrated('off');
    for (const feedback of Object.values(haptics)) await feedback();
    expect(native.selectionAsync).not.toHaveBeenCalled(); expect(native.notificationAsync).not.toHaveBeenCalled();
    expect(native.impactAsync).not.toHaveBeenCalled(); expect(native.performAndroidHapticsAsync).not.toHaveBeenCalled();
  });

  it('never attempts native feedback in a browser even with System selected', async () => {
    native.platform.OS = 'web';
    const { haptics } = await hydrated();
    for (const feedback of Object.values(haptics)) await feedback();
    expect(native.selectionAsync).not.toHaveBeenCalled(); expect(native.notificationAsync).not.toHaveBeenCalled();
    expect(native.impactAsync).not.toHaveBeenCalled(); expect(native.performAndroidHapticsAsync).not.toHaveBeenCalled();
  });

  it('drops startup feedback without replay while the saved Off choice loads', async () => {
    let resolve!: (value: string) => void;
    native.getItemAsync.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const { haptics } = await import('./haptics');
    const { initializeHapticPreference } = await import('./hapticPreference');
    await haptics.success();
    resolve('off'); await initializeHapticPreference();
    await haptics.success();
    expect(native.notificationAsync).not.toHaveBeenCalled();
  });

  it('is silent during hydration and preference writes, and persists Off across a restart', async () => {
    const { haptics, saveHapticPreference } = await hydrated();
    await saveHapticPreference('off');
    expect(native.setItemAsync).toHaveBeenCalledExactlyOnceWith('org.unionground.app.haptics-v1', 'off');
    vi.resetModules();
    native.getItemAsync.mockResolvedValue('off');
    const restarted = await hydrated('off');
    await restarted.haptics.select(); await haptics.success();
    expect(native.selectionAsync).not.toHaveBeenCalled(); expect(native.notificationAsync).not.toHaveBeenCalled();
  });

  it('keeps Off active when persistence fails and reports the unsaved choice', async () => {
    const { haptics, saveHapticPreference, getHapticPreferenceState } = await hydrated();
    native.setItemAsync.mockRejectedValueOnce(new Error('locked storage'));
    await expect(saveHapticPreference('off')).rejects.toThrow('could not be saved');
    expect(getHapticPreferenceState()).toMatchObject({ preference: 'off', error: 'save' });
    await haptics.warning(); expect(native.notificationAsync).not.toHaveBeenCalled();
  });

  it('fails closed on unreadable storage, then recovers through an explicit choice', async () => {
    native.getItemAsync.mockRejectedValue(new Error('locked storage'));
    const store = await import('./hapticPreference');
    await store.initializeHapticPreference();
    const { haptics } = await import('./haptics');
    await haptics.select(); expect(native.selectionAsync).not.toHaveBeenCalled();
    expect(store.getHapticPreferenceState()).toMatchObject({ ready: false, error: 'load' });
    await store.saveHapticPreference('system'); await haptics.select();
    expect(native.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('never lets a late startup read overwrite an explicit Off choice', async () => {
    let resolve!: (value: string) => void;
    native.getItemAsync.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const store = await import('./hapticPreference');
    const pending = store.initializeHapticPreference();
    await store.saveHapticPreference('off'); resolve('system'); await pending;
    expect(store.getHapticPreferenceState().preference).toBe('off');
  });

  it('does not hydrate over an explicit Off choice made before initialization', async () => {
    const store = await import('./hapticPreference');
    native.getItemAsync.mockResolvedValue('system');
    native.setItemAsync.mockRejectedValueOnce(new Error('locked storage'));
    await expect(store.saveHapticPreference('off')).rejects.toThrow();
    await store.initializeHapticPreference();
    expect(store.getHapticPreferenceState()).toMatchObject({ preference: 'off', error: 'save' });
    expect(native.getItemAsync).not.toHaveBeenCalled();
  });

  it('a failed subscriber cannot prevent persistence or wedge subsequent saves', async () => {
    const store = await hydrated();
    const observed = vi.fn();
    const unsubscribe = store.subscribeHapticPreference(() => { throw new Error('subscriber failed'); });
    store.subscribeHapticPreference(observed);
    await expect(store.saveHapticPreference('off')).resolves.toBeUndefined();
    expect(native.setItemAsync).toHaveBeenCalledOnce();
    expect(store.getHapticPreferenceState()).toMatchObject({ preference: 'off', saving: false, error: null });
    expect(observed).toHaveBeenCalledTimes(2);
    unsubscribe(); await store.saveHapticPreference('system');
    expect(native.setItemAsync).toHaveBeenCalledTimes(2);
  });

  it('serializes writes and suppresses feedback while a save is in flight', async () => {
    const { haptics, saveHapticPreference, getHapticPreferenceState } = await hydrated();
    let finish!: () => void;
    native.setItemAsync.mockImplementationOnce(() => new Promise<void>((done) => { finish = done; }));
    const saving = saveHapticPreference('subtle');
    await haptics.select();
    expect(native.selectionAsync).not.toHaveBeenCalled();
    await expect(saveHapticPreference('system')).rejects.toThrow('in progress');
    finish(); await saving;
    expect(getHapticPreferenceState()).toMatchObject({ preference: 'subtle', saving: false });
  });

  it.each(['ios', 'android'])('absorbs native promise rejection on %s without retry', async (platform) => {
    native.platform.OS = platform;
    const { haptics } = await hydrated();
    native.notificationAsync.mockRejectedValueOnce(new Error('no engine'));
    native.performAndroidHapticsAsync.mockRejectedValueOnce(new Error('no engine'));
    await expect(haptics.success()).resolves.toBeUndefined();
    expect(platform === 'ios' ? native.notificationAsync : native.performAndroidHapticsAsync).toHaveBeenCalledTimes(1);
  });
});
