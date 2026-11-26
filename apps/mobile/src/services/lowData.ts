import * as SecureStore from 'expo-secure-store';

import NetworkPolicyModule from '../../modules/network-policy/src/NetworkPolicyModule';
import {
  DEFAULT_LOW_DATA_MODE,
  UNKNOWN_NETWORK_SIGNALS,
  lowDataPolicyEquals,
  normalizeLowDataMode,
  normalizeNetworkSignals,
  resolveLowDataPolicy,
  type LowDataMode,
  type LowDataPolicy,
  type NetworkSignals,
} from '../lib/lowDataPolicy';

// The pollers the application schedules live with the policy; re-exported here
// so a caller that already holds the store does not need a second import.
export { LOW_DATA_POLL_INTERVAL_MS, NORMAL_POLL_INTERVAL_MS } from '../lib/lowDataPolicy';

// Only the member's choice is persisted. A network reading is never stored:
// it belongs to the moment it was taken, and a stale one would silently decide
// a later session's data use.
const modeStorageKey = 'org.unionground.app.low-data-mode-v1';
const networkChangeEvent = 'onNetworkChange';

type NetworkSubscription = { remove(): void };

let mode: LowDataMode = DEFAULT_LOW_DATA_MODE;
let signals: NetworkSignals = UNKNOWN_NETWORK_SIGNALS;
let snapshot: LowDataPolicy = resolveLowDataPolicy(mode, signals);
const listeners = new Set<() => void>();

// Readings are ordered, not merged. A snapshot read that resolves after a
// newer native event must not push the older reading back into the store.
let issuedReading = 0;
let appliedReading = 0;

// Monitoring is reference counted so two mounted consumers share one native
// subscription, and a system callback that fires once more after removal is
// recognised by its stale epoch instead of mutating the store.
let monitors = 0;
let monitorEpoch = 0;
let subscription: NetworkSubscription | null = null;

// Preference writes are serialized, and an explicit choice outranks a load
// that started before it.
let pendingWrites: Promise<void> = Promise.resolve();
let explicitChoices = 0;

function publish(next: LowDataPolicy): void {
  if (lowDataPolicyEquals(snapshot, next)) return;
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

function recompute(): void {
  publish(resolveLowDataPolicy(mode, signals));
}

function applyReading(value: unknown, reading: number): void {
  if (reading <= appliedReading) return;
  appliedReading = reading;
  signals = normalizeNetworkSignals(value);
  recompute();
}

/** The current policy. Stable by value, so React can compare it by identity. */
export function getLowDataSnapshot(): LowDataPolicy {
  return snapshot;
}

export function subscribeLowData(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Takes one reading from the operating system. A missing native module, or a
 * module that refuses, resolves to an explicit unknown reading: no HTTP
 * request is ever made to infer the connection.
 */
export async function refreshLowDataSignals(): Promise<void> {
  const reading = ++issuedReading;
  if (!NetworkPolicyModule) {
    applyReading(null, reading);
    return;
  }
  try {
    applyReading(await NetworkPolicyModule.getSignalsAsync(), reading);
  } catch {
    applyReading(null, reading);
  }
}

/**
 * Reads the stored preference. A choice made while this was in flight wins:
 * the member's tap is newer information than the value on disk, and a locked
 * keychain changes nothing at all.
 */
export async function loadLowDataMode(): Promise<LowDataMode> {
  const choicesAtStart = explicitChoices;
  let stored: string | null = null;
  try {
    stored = await SecureStore.getItemAsync(modeStorageKey);
  } catch {
    return mode;
  }
  if (explicitChoices !== choicesAtStart) return mode;
  mode = normalizeLowDataMode(stored);
  recompute();
  return mode;
}

/**
 * Records the member's choice. The store reflects it immediately so the
 * control cannot lag the tap, then the write is queued behind any earlier
 * write so the last choice is the stored one. A rejected promise means this
 * session honours the choice but the phone did not keep it.
 */
export async function setLowDataMode(next: LowDataMode): Promise<void> {
  const chosen = normalizeLowDataMode(next);
  explicitChoices += 1;
  mode = chosen;
  recompute();

  const write = pendingWrites.then(() => SecureStore.setItemAsync(modeStorageKey, chosen));
  // The queue must survive one failed write so a later choice still reaches
  // storage; the caller still sees this write's own failure.
  pendingWrites = write.then(
    () => undefined,
    () => undefined,
  );
  await write;
}

/**
 * Subscribes to native path changes and hydrates the stored preference.
 * Returns the cleanup for one consumer; the native subscription is removed
 * when the last one stops.
 */
export function startLowDataMonitoring(): () => void {
  monitors += 1;
  if (monitors === 1) {
    monitorEpoch += 1;
    const epoch = monitorEpoch;
    if (NetworkPolicyModule) {
      try {
        // Subscribing before the first read means a change that lands between
        // the two is not lost, and the reading order settles it.
        subscription = NetworkPolicyModule.addListener(networkChangeEvent, (value) => {
          if (epoch !== monitorEpoch) return;
          applyReading(value, ++issuedReading);
          // An event says the path changed; its payload can still describe the
          // network that just went away, and going fully offline may send no
          // second event. A fresh read issued after it outranks the payload, so
          // a stale unmetered reading cannot outlive the change.
          void refreshLowDataSignals();
        });
      } catch {
        subscription = null;
      }
    }
    void refreshLowDataSignals();
    void loadLowDataMode();
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    monitors -= 1;
    if (monitors > 0) return;
    // Retire the epoch first: a callback already on its way in must not land.
    monitorEpoch += 1;
    const retired = subscription;
    subscription = null;
    try {
      retired?.remove();
    } catch {
      // The platform already tore this listener down.
    }
  };
}
