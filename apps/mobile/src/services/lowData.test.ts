import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOW_DATA_REASONS, type NetworkSignals } from '../lib/lowDataPolicy';

const MODE_KEY = 'org.unionground.app.low-data-mode-v1';
const NATIVE_MODULE_PATH = '../../modules/network-policy/src/NetworkPolicyModule';

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  /** Ordered write lifecycle, so interleaving is visible. */
  writeLog: [] as string[],
  readCount: 0,
  /** Held to keep a load in flight while a choice is made. */
  readGate: null as null | Promise<void>,
  failRead: false,
  failWrites: 0,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string): Promise<string | null> => {
    storage.readCount += 1;
    if (storage.readGate) await storage.readGate;
    if (storage.failRead) throw new Error('keychain is locked');
    return storage.values.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string): Promise<void> => {
    storage.writeLog.push(`start:${value}`);
    await Promise.resolve();
    await Promise.resolve();
    if (storage.failWrites > 0) {
      storage.failWrites -= 1;
      storage.writeLog.push(`fail:${value}`);
      throw new Error('keychain refused the write');
    }
    storage.values.set(key, value);
    storage.writeLog.push(`end:${value}`);
  },
  deleteItemAsync: async (key: string): Promise<void> => {
    storage.values.delete(key);
  },
}));

type NativeListener = (value: unknown) => void;

type NativeHarness = {
  module: {
    isSupported: () => boolean;
    getSignalsAsync: () => Promise<unknown>;
    addListener: (event: string, listener: NativeListener) => { remove: () => void };
  };
  /** Fires every listener the native side ever handed out, removed or not. */
  emit: (value: unknown) => void;
  /**
   * Fires a callback whose payload disagrees with the module's current state,
   * as Android's onLost did when it read the network that had just gone.
   */
  emitStale: (payload: unknown, current: unknown) => void;
  setReading: (value: unknown) => void;
  /** Resolves the oldest pending snapshot read, for out-of-order tests. */
  releaseRead: (value: unknown) => void;
  events: string[];
  subscriptions: number;
  removals: number;
  reads: number;
};

function reading(overrides: Partial<NetworkSignals> = {}): NetworkSignals {
  return { supported: true, connected: true, expensive: false, constrained: false, ...overrides };
}

const UNMETERED_WIFI = reading();
const METERED_CELLULAR = reading({ expensive: true });
const DATA_SAVER = reading({ constrained: true });
const DISCONNECTED = reading({ connected: false, expensive: null, constrained: null });

function createNative(options: { deferRead?: boolean; failRead?: boolean; failSubscribe?: boolean } = {}): NativeHarness {
  const captured: NativeListener[] = [];
  let current: unknown = UNMETERED_WIFI;
  const releases: Array<(value: unknown) => void> = [];
  const harness: NativeHarness = {
    module: {
      isSupported: () => true,
      getSignalsAsync: async () => {
        harness.reads += 1;
        if (options.failRead) throw new Error('the platform refused the reading');
        if (options.deferRead) {
          return new Promise<unknown>((resolve) => {
            releases.push(resolve);
          });
        }
        return current;
      },
      addListener: (event: string, listener: NativeListener) => {
        if (options.failSubscribe) throw new Error('no meeting support in this build');
        harness.events.push(event);
        harness.subscriptions += 1;
        captured.push(listener);
        return {
          remove: () => {
            harness.removals += 1;
          },
        };
      },
    },
    emit: (value: unknown) => {
      current = value;
      for (const listener of captured) listener(value);
    },
    emitStale: (payload: unknown, next: unknown) => {
      current = next;
      for (const listener of captured) listener(payload);
    },
    setReading: (value: unknown) => {
      current = value;
    },
    releaseRead: (value: unknown) => {
      releases.shift()?.(value);
    },
    events: [],
    subscriptions: 0,
    removals: 0,
    reads: 0,
  };
  return harness;
}

async function loadService(native: NativeHarness | null) {
  vi.resetModules();
  vi.doMock(NATIVE_MODULE_PATH, () => ({ default: native?.module ?? null }));
  return import('./lowData');
}

/** Drains every pending microtask chain; the service schedules no timers. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

let networkProbe: ReturnType<typeof vi.fn>;

beforeEach(() => {
  storage.values.clear();
  storage.writeLog.length = 0;
  storage.readCount = 0;
  storage.readGate = null;
  storage.failRead = false;
  storage.failWrites = 0;
  // Nothing in this path may reach the network to work out the connection.
  networkProbe = vi.fn();
  vi.stubGlobal('fetch', networkProbe);
});

afterEach(() => {
  expect(networkProbe).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.doUnmock(NATIVE_MODULE_PATH);
});

describe('low data store without the native module', () => {
  it('reports an explicit unknown reading and keeps normal data use', async () => {
    const service = await loadService(null);
    expect(service.getLowDataSnapshot()).toEqual({
      mode: 'auto',
      enabled: false,
      reason: LOW_DATA_REASONS.unsupported,
      signals: { supported: false, connected: null, expensive: null, constrained: null },
    });
  });

  it('starts and stops monitoring without a native module and without crashing', async () => {
    const service = await loadService(null);
    const listener = vi.fn();
    service.subscribeLowData(listener);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.unsupported);
    expect(listener).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });

  it('still honours an explicit choice with no network reading at all', async () => {
    const service = await loadService(null);
    await service.setLowDataMode('on');
    const snapshot = service.getLowDataSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.reason).toBe(LOW_DATA_REASONS.userOn);
    expect(snapshot.signals.supported).toBe(false);
  });

  it('survives a build whose module cannot subscribe', async () => {
    const native = createNative({ failSubscribe: true });
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    // The snapshot read still works even though events are unavailable.
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.unrestricted);
    stop();
    expect(native.removals).toBe(0);
  });

  it('recovers the first asynchronous native reading on a foreground refresh even without meetings', async () => {
    const native = createNative({ failSubscribe: true });
    native.setReading({ supported: true, connected: null, expensive: null, constrained: null });
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.noReading);
    native.setReading(DATA_SAVER);
    await service.refreshLowDataSignals();
    expect(service.getLowDataSnapshot().enabled).toBe(true);
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.constrained);
    stop();
  });

});

describe('low data store readings', () => {
  it('takes the first reading when monitoring starts and subscribes before reading', async () => {
    const native = createNative();
    native.setReading(METERED_CELLULAR);
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();

    expect(native.events).toEqual(['onNetworkChange']);
    expect(native.subscriptions).toBe(1);
    const snapshot = service.getLowDataSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.reason).toBe(LOW_DATA_REASONS.expensive);
    expect(service.LOW_DATA_POLL_INTERVAL_MS).toBe(120_000);
    expect(service.NORMAL_POLL_INTERVAL_MS).toBe(30_000);
    stop();
  });

  it('turns low data on for a data saver path and off again when it clears', async () => {
    const native = createNative();
    native.setReading(DATA_SAVER);
    const service = await loadService(native);
    const listener = vi.fn();
    service.subscribeLowData(listener);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.constrained);

    native.emit(UNMETERED_WIFI);
    expect(service.getLowDataSnapshot().enabled).toBe(false);
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.unrestricted);
    stop();
  });

  it('follows an interruption and reconnect through native meetings', async () => {
    const native = createNative();
    const service = await loadService(native);
    const seen: string[] = [];
    service.subscribeLowData(() => {
      const snapshot = service.getLowDataSnapshot();
      seen.push(`${snapshot.enabled ? 'on' : 'off'}:${snapshot.reason}`);
    });
    const stop = service.startLowDataMonitoring();
    await settle();

    native.emit(DISCONNECTED);
    native.emit(METERED_CELLULAR);
    native.emit(UNMETERED_WIFI);

    expect(seen).toEqual([
      `off:${LOW_DATA_REASONS.unrestricted}`,
      `on:${LOW_DATA_REASONS.offline}`,
      `on:${LOW_DATA_REASONS.expensive}`,
      `off:${LOW_DATA_REASONS.unrestricted}`,
    ]);
    stop();
  });

  it('does not keep an unmetered reading across an offline gap when the meeting payload is stale', async () => {
    const native = createNative();
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.unrestricted);

    // The phone loses Wi-Fi and mobile data together. The change callback
    // still carries the unmetered network that just went away, and no
    // further callback follows, so only a fresh reading can see the gap.
    native.emitStale(UNMETERED_WIFI, DISCONNECTED);
    await settle();
    expect(service.getLowDataSnapshot()).toMatchObject({
      enabled: true,
      reason: LOW_DATA_REASONS.offline,
    });

    // Back on a metered network, Auto follows the new reading.
    native.emitStale(UNMETERED_WIFI, METERED_CELLULAR);
    await settle();
    expect(service.getLowDataSnapshot()).toMatchObject({
      enabled: true,
      reason: LOW_DATA_REASONS.expensive,
    });
    stop();
  });

  it('treats a blocked default network as offline until Android unblocks it', async () => {
    const native = createNative();
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.unrestricted);

    // Android blocks the default network for this application (background
    // restriction or a lockdown VPN). The network keeps its capabilities, but
    // the module reports it as disconnected, as activeNetwork's null did.
    native.emit(DISCONNECTED);
    await settle();
    expect(service.getLowDataSnapshot()).toMatchObject({ enabled: true, reason: LOW_DATA_REASONS.offline });

    native.emit(UNMETERED_WIFI);
    await settle();
    expect(service.getLowDataSnapshot()).toMatchObject({ enabled: false, reason: LOW_DATA_REASONS.unrestricted });
    stop();
  });

  it('reports an honest unknown when the platform refuses a reading', async () => {
    const native = createNative({ failRead: true });
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(service.getLowDataSnapshot().signals).toEqual({
      supported: false,
      connected: null,
      expensive: null,
      constrained: null,
    });
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.unsupported);
    stop();
  });

  it('normalizes a malformed native payload instead of trusting it', async () => {
    const native = createNative();
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();

    native.emit({ supported: true, connected: true });
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.noReading);
    native.emit('a string is not a reading');
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.unsupported);
    stop();
  });

  it('re-reads on demand, for a screen coming back to the foreground', async () => {
    const native = createNative();
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(service.getLowDataSnapshot().enabled).toBe(false);

    native.setReading(METERED_CELLULAR);
    await service.refreshLowDataSignals();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.expensive);
    expect(native.reads).toBe(2);
    stop();
  });
});

describe('low data store reading races', () => {
  it('keeps a newer meeting when an older snapshot read resolves late', async () => {
    const native = createNative({ deferRead: true });
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();

    // The event lands while the first read is still in flight.
    native.emit(METERED_CELLULAR);
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.expensive);

    native.releaseRead(UNMETERED_WIFI);
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.expensive);
    stop();
  });

  it('lets a newer meeting win over the re-read an older meeting asked for', async () => {
    const native = createNative({ deferRead: true });
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    native.releaseRead(UNMETERED_WIFI);
    await settle();

    native.emit(DISCONNECTED);
    native.emit(METERED_CELLULAR);
    expect(native.reads).toBe(3);
    // The re-read the offline event asked for resolves after the newer event.
    native.releaseRead(DISCONNECTED);
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.expensive);
    native.releaseRead(METERED_CELLULAR);
    await settle();
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.expensive);
    stop();
  });

  it('ignores a native callback that fires after the subscription is removed', async () => {
    const native = createNative();
    const service = await loadService(native);
    const listener = vi.fn();
    service.subscribeLowData(listener);
    const stop = service.startLowDataMonitoring();
    await settle();
    const before = service.getLowDataSnapshot();
    const notifications = listener.mock.calls.length;

    stop();
    expect(native.removals).toBe(1);
    native.emit(METERED_CELLULAR);

    expect(service.getLowDataSnapshot()).toBe(before);
    expect(listener.mock.calls.length).toBe(notifications);
  });

  it('shares one native subscription between consumers and removes it once', async () => {
    const native = createNative();
    const service = await loadService(native);
    const first = service.startLowDataMonitoring();
    const second = service.startLowDataMonitoring();
    await settle();
    expect(native.subscriptions).toBe(1);

    first();
    first();
    expect(native.removals).toBe(0);
    native.emit(METERED_CELLULAR);
    expect(service.getLowDataSnapshot().enabled).toBe(true);

    second();
    expect(native.removals).toBe(1);
  });

  it('subscribes again after every consumer has stopped', async () => {
    const native = createNative();
    const service = await loadService(native);
    service.startLowDataMonitoring()();
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(native.subscriptions).toBe(2);

    native.emit(DATA_SAVER);
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.constrained);
    stop();
    expect(native.removals).toBe(2);
  });

  it('hands React the same snapshot object while nothing has changed', async () => {
    const native = createNative();
    const service = await loadService(native);
    const listener = vi.fn();
    service.subscribeLowData(listener);
    const stop = service.startLowDataMonitoring();
    await settle();

    const settled = service.getLowDataSnapshot();
    expect(service.getLowDataSnapshot()).toBe(settled);
    const notifications = listener.mock.calls.length;

    native.emit(reading());
    await service.refreshLowDataSignals();
    expect(service.getLowDataSnapshot()).toBe(settled);
    expect(listener.mock.calls.length).toBe(notifications);
    stop();
  });
});

describe('low data preference persistence', () => {
  it('persists only the choice, and nothing about the network', async () => {
    const native = createNative();
    native.setReading(METERED_CELLULAR);
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    await service.setLowDataMode('off');

    expect([...storage.values.keys()]).toEqual([MODE_KEY]);
    expect(storage.values.get(MODE_KEY)).toBe('off');
    expect(JSON.stringify([...storage.values])).not.toContain('expensive');
    stop();
  });

  it('hydrates a stored choice when monitoring starts', async () => {
    storage.values.set(MODE_KEY, 'on');
    const native = createNative();
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();

    const snapshot = service.getLowDataSnapshot();
    expect(snapshot.mode).toBe('on');
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.reason).toBe(LOW_DATA_REASONS.userOn);
    stop();
  });

  it('falls back to Auto for a stored value it does not recognise', async () => {
    storage.values.set(MODE_KEY, 'aggressive');
    const service = await loadService(createNative());
    expect(await service.loadLowDataMode()).toBe('auto');
  });

  it('keeps the default when the keychain refuses the read', async () => {
    storage.failRead = true;
    const service = await loadService(createNative());
    await expect(service.loadLowDataMode()).resolves.toBe('auto');
    expect(service.getLowDataSnapshot().mode).toBe('auto');
  });

  it('lets a choice made during a load win over the stored value', async () => {
    storage.values.set(MODE_KEY, 'on');
    let openGate = (): void => undefined;
    storage.readGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const native = createNative();
    const service = await loadService(native);
    const stop = service.startLowDataMonitoring();
    await settle();
    expect(storage.readCount).toBe(1);

    // The member taps Off while the stored "on" is still being read.
    const chosen = service.setLowDataMode('off');
    expect(service.getLowDataSnapshot().mode).toBe('off');
    openGate();
    await chosen;
    await settle();

    expect(service.getLowDataSnapshot().mode).toBe('off');
    expect(service.getLowDataSnapshot().reason).toBe(LOW_DATA_REASONS.userOff);
    expect(storage.values.get(MODE_KEY)).toBe('off');
    stop();
  });

  it('serializes overlapping writes so the last choice is the stored one', async () => {
    const service = await loadService(createNative());
    const writes = [
      service.setLowDataMode('on'),
      service.setLowDataMode('off'),
      service.setLowDataMode('auto'),
    ];
    await Promise.all(writes);

    expect(storage.writeLog).toEqual([
      'start:on', 'end:on',
      'start:off', 'end:off',
      'start:auto', 'end:auto',
    ]);
    expect(storage.values.get(MODE_KEY)).toBe('auto');
    expect(service.getLowDataSnapshot().mode).toBe('auto');
  });

  it('reports a failed write while keeping the choice for this session and the queue usable', async () => {
    storage.failWrites = 1;
    const service = await loadService(createNative());
    await expect(service.setLowDataMode('on')).rejects.toThrow('keychain refused the write');
    expect(service.getLowDataSnapshot().mode).toBe('on');
    expect(service.getLowDataSnapshot().enabled).toBe(true);

    await service.setLowDataMode('off');
    expect(storage.writeLog).toEqual(['start:on', 'fail:on', 'start:off', 'end:off']);
    expect(storage.values.get(MODE_KEY)).toBe('off');
  });

  it('notifies subscribers once per real change in the resolved policy', async () => {
    const native = createNative();
    const service = await loadService(native);
    const listener = vi.fn();
    const unsubscribe = service.subscribeLowData(listener);
    await service.setLowDataMode('on');
    await service.setLowDataMode('on');
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await service.setLowDataMode('off');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.getLowDataSnapshot().mode).toBe('off');
  });
});

const mobileRoot = join(import.meta.dirname, '../..');
const moduleRoot = join(mobileRoot, 'modules/network-policy');
const swiftSource = readFileSync(join(moduleRoot, 'ios/NetworkPolicyModule.swift'), 'utf8');
const kotlinSource = readFileSync(
  join(moduleRoot, 'android/src/main/java/expo/modules/networkpolicy/NetworkPolicyModule.kt'),
  'utf8',
);
const manifestSource = readFileSync(join(moduleRoot, 'android/src/main/AndroidManifest.xml'), 'utf8');
const moduleConfig: unknown = JSON.parse(readFileSync(join(moduleRoot, 'expo-module.config.json'), 'utf8'));
const moduleBridgeSource = readFileSync(join(moduleRoot, 'src/NetworkPolicyModule.ts'), 'utf8');
const podspecSource = readFileSync(join(moduleRoot, 'ios/NetworkPolicy.podspec'), 'utf8');

describe('network policy module boundaries', () => {
  it('registers one optional module under the same name on both platforms', () => {
    expect(moduleConfig).toEqual({
      platforms: ['android', 'ios'],
      apple: { modules: ['NetworkPolicyModule'] },
      android: { modules: ['expo.modules.networkpolicy.NetworkPolicyModule'] },
    });
    expect(swiftSource).toContain('Name("NetworkPolicy")');
    expect(kotlinSource).toContain('Name("NetworkPolicy")');
    // Optional, so a build or platform without the module reports unknown
    // rather than throwing on the first import.
    expect(moduleBridgeSource).toContain("requireOptionalNativeModule<NetworkPolicyModule>('NetworkPolicy')");
    expect(moduleBridgeSource).not.toContain('requireNativeModule(');
  });

  it('reads the iOS path from NWPathMonitor and cleans the observer up', () => {
    expect(podspecSource).toContain("s.frameworks = 'Network'");
    expect(swiftSource).toContain('NWPathMonitor()');
    expect(swiftSource).toContain('path.status == .satisfied');
    expect(swiftSource).toContain('path.isExpensive');
    expect(swiftSource).toContain('path.isConstrained');
    expect(swiftSource).toContain('Events(networkChangeEvent)');
    expect(swiftSource).toContain('OnStartObserving(networkChangeEvent)');
    expect(swiftSource).toContain('OnStopObserving(networkChangeEvent)');
    expect(swiftSource).toContain('retired?.cancel()');
  });

  it('reads the Android state from ConnectivityManager and unregisters both listeners', () => {
    expect(kotlinSource).toContain('ConnectivityManager');
    expect(kotlinSource).toContain('NET_CAPABILITY_NOT_METERED');
    expect(kotlinSource).toContain('NET_CAPABILITY_TEMPORARILY_NOT_METERED');
    expect(kotlinSource).toContain('NET_CAPABILITY_VALIDATED');
    expect(kotlinSource).toContain('restrictBackgroundStatus');
    expect(kotlinSource).toContain('RESTRICT_BACKGROUND_STATUS_ENABLED');
    expect(kotlinSource).toContain('registerDefaultNetworkCallback(callback)');
    expect(kotlinSource).toContain('unregisterNetworkCallback(callback)');
    expect(kotlinSource).toContain('ACTION_RESTRICT_BACKGROUND_CHANGED');
    expect(kotlinSource).toContain('unregisterReceiver(receiver)');
  });

  it('reports the Android network from the callback arguments, not a racy lookup on their stack', () => {
    const callbackStart = kotlinSource.indexOf('object : ConnectivityManager.NetworkCallback()');
    const callbackEnd = kotlinSource.indexOf('\n      }\n', callbackStart);
    expect(callbackStart).toBeGreaterThan(-1);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    const callbacks = kotlinSource.slice(callbackStart, callbackEnd);
    expect(callbacks).toContain('override fun onBlockedStatusChanged');
    expect(callbacks).toContain('defaultCapabilities = capabilities');
    expect(callbacks).toContain('defaultCapabilities = null');

    // A member runs from its declaration to the next line indented like one.
    const member = (name: string) => {
      const start = kotlinSource.search(new RegExp(`\\n  private fun ${name}\\(`));
      expect(start, `${name} must be a module function`).toBeGreaterThan(-1);
      const rest = kotlinSource.slice(start + 1);
      const end = rest.slice(1).search(/\n  [^ })\n]/);
      return end === -1 ? rest : rest.slice(0, end + 1);
    };
    const moduleFunctions = new Set([...kotlinSource.matchAll(/\n  private fun (\w+)\(/g)].map((match) => match[1]));

    // Work posted to the main handler runs after the callback has returned,
    // so it is not part of the callback's own stack.
    const posted = /main\.post \{[^}]*\}/g;
    const synchronous = callbacks.replace(posted, '');
    expect(callbacks.match(posted)).toEqual(['main.post { refreshLegacy(manager, callback, network, expected) }']);

    // Follow every module function the callbacks call, directly or through
    // other functions, and keep the whole synchronous path free of queries.
    // In onLost, activeNetwork can still name the network that was just lost,
    // and in onAvailable a capabilities query can return an outdated reading.
    const reached = new Map<string, string>();
    const pending = [synchronous];
    while (pending.length > 0) {
      const source = pending.pop() as string;
      for (const [, name] of source.matchAll(/\b(\w+)\(/g)) {
        if (name === undefined || !moduleFunctions.has(name) || reached.has(name)) continue;
        const body = member(name);
        reached.set(name, body);
        pending.push(body);
      }
    }
    expect([...reached.keys()].sort()).toEqual([
      'isDataSaverRestricted',
      'isMetered',
      'isUsable',
      'publish',
      'reading',
      'trackedCapabilities',
    ]);
    const stack: [string, string][] = [['callbacks', synchronous], ...reached];
    for (const [name, source] of stack) {
      expect(source, `${name} runs on the callback stack`).not.toContain('activeNetwork');
      expect(source, `${name} runs on the callback stack`).not.toContain('getNetworkCapabilities');
      expect(source, `${name} runs on the callback stack`).not.toMatch(/\bsignals\(\)|currentCapabilities\(/);
    }

    // From Android O, onAvailable drops the old reading and publishes nothing;
    // onCapabilitiesChanged, which always follows it, reports the new network.
    const available = callbacks.slice(
      callbacks.indexOf('override fun onAvailable'),
      callbacks.indexOf('override fun onLost'),
    );
    expect(available).toMatch(
      /defaultNetwork = network\s*defaultCapabilities = null\s*\+\+generation[\s\S]*if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.O\) return\n/,
    );
    expect(available).not.toContain('publish()');
    // Every change to the tracked network, and a stop, retires a pending
    // Android 7 refresh.
    expect(callbacks.slice(callbacks.indexOf('override fun onLost'))).toMatch(/generation\+\+[\s\S]*generation\+\+/);
    expect(member('stopObserving')).toContain('generation++');
    expect(member('stopObserving')).toContain('main.removeCallbacksAndMessages(null)');

    // Android 7 promises no follow-up callback, so its refresh asks about the
    // named network once, off the callback stack, and keeps the answer only if
    // the tracked state is still the one it was posted for, checked again after
    // the query so a late answer cannot overwrite a newer callback.
    const refresh = member('refreshLegacy');
    expect(refresh).toMatch(
      /if \(!isCurrent\(callback, network, expected\)\) return[\s\S]*manager\.getNetworkCapabilities\(network\)[\s\S]*synchronized\(trackingLock\) \{\s*isCurrent\(callback, network, expected\)\.also \{ current ->\s*if \(current\) defaultCapabilities = capabilities/,
    );
    expect(refresh).toContain('catch (cause: SecurityException)');
    expect(member('isCurrent')).toContain(
      'tracking && networkCallback === callback && defaultNetwork == network && generation == expected',
    );
    // A snapshot read reports the same tracked network while observing.
    expect(kotlinSource).toContain('if (tracking) trackedCapabilities() else currentCapabilities(manager)');
  });

  it('reads a blocked Android default network as disconnected, as activeNetwork did', () => {
    // activeNetwork is null while the default network is blocked for this
    // application, so the tracked reading must drop that network's
    // capabilities too: connected false, nothing served as unmetered.
    const callbackStart = kotlinSource.indexOf('object : ConnectivityManager.NetworkCallback()');
    const callbacks = kotlinSource.slice(callbackStart, kotlinSource.indexOf('\n      }\n', callbackStart));
    const handler = (name: string) => {
      const start = callbacks.indexOf(`override fun ${name}(`);
      expect(start, `${name} must be overridden`).toBeGreaterThan(-1);
      const end = callbacks.indexOf('override fun ', start + 1);
      return callbacks.slice(start, end === -1 ? undefined : end);
    };

    // The blocked flag is recorded for the tracked network under the lock and
    // published like every other recorded change.
    expect(handler('onBlockedStatusChanged')).toMatch(
      /synchronized\(trackingLock\) \{\s*if \(defaultNetwork == network\) defaultBlocked = blocked\s*\}\s*publish\(\)/,
    );
    // A new, lost or released network starts unblocked; Android reports a
    // blocked one right after onAvailable.
    expect(handler('onAvailable')).toMatch(/if \(defaultNetwork != network\) defaultBlocked = false/);
    expect(handler('onLost')).toMatch(/defaultCapabilities = null\s*defaultBlocked = false/);
    expect(handler('onCapabilitiesChanged')).toMatch(/if \(defaultNetwork != network\) defaultBlocked = false/);
    expect(kotlinSource).toMatch(/defaultCapabilities = seedCapabilities\s*defaultBlocked = false/);
    expect(kotlinSource).toMatch(/defaultCapabilities = null\s*defaultBlocked = false\s*generation\+\+\s*networkCallback\.also/);

    // Both the event and a snapshot read serve no capabilities while blocked.
    expect(kotlinSource).toMatch(
      /private fun trackedCapabilities\(\): NetworkCapabilities\? =\s*synchronized\(trackingLock\) \{ if \(defaultBlocked\) null else defaultCapabilities \}/,
    );
    expect(kotlinSource).toContain('reading(manager, trackedCapabilities())');
    expect(kotlinSource.match(/reading\(manager, defaultCapabilities\)/g)).toBeNull();
  });

  it('never opens a connection to work out the network on either platform', () => {
    for (const [platform, source] of [['iOS', swiftSource], ['Android', kotlinSource]] as const) {
      for (const probe of ['URLSession', 'NWConnection', 'HttpURLConnection', 'OkHttp', 'Socket(', 'isReachable', 'downloadTask']) {
        expect(source, `${platform} must not probe with ${probe}`).not.toContain(probe);
      }
    }
  });

  it('adds one normal permission, no component, and nothing exported', () => {
    expect(manifestSource.match(/<uses-permission/g)).toHaveLength(1);
    expect(manifestSource).toContain('android.permission.ACCESS_NETWORK_STATE');
    expect(manifestSource).not.toContain('android.permission.INTERNET');
    for (const component of ['<activity', '<service', '<receiver', '<provider', 'android:exported']) {
      expect(manifestSource).not.toContain(component);
    }
    // The Data Saver receiver is runtime-registered only.
    expect(kotlinSource).toContain('host.registerReceiver(receiver');
  });
});
