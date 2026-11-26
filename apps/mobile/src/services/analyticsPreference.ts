// REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016: the member's Product
// analytics switch on this phone. It gates both kinds of product analytics the
// app sends: the feature page view behind the organization's Usage tiles (once
// the switch is off no record_workspace_page_view request leaves the phone,
// including one already waiting on authentication, which the abort signal
// cancels), and PostHog screen views and feature flags under one-way hashes
// (services/observability.ts reads productAnalyticsEnabledNow and
// productAnalyticsGeneration; #6247, #6432). Error reports are not product
// analytics and do not follow this switch. The choice is device-wide secure storage, so
// it survives sign-out and relaunch; an unreadable store counts as off.
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import type { FeaturePageViewRecorder } from '../lib/featurePageViews';

export type SignalledPageViewRecorder = (page: string, hat: string, signal: AbortSignal) => Promise<unknown>;

export const ANALYTICS_DISABLED_KEY = 'org.unionground.app.analytics-disabled-v1';

let disabled: boolean | null = null;
let reading: Promise<boolean> | null = null;
let writing: Promise<unknown> = Promise.resolve();
let pending = new AbortController();
const listeners = new Set<() => void>();

// Advances on every change of the switch, so analytics captured before a
// change is never sent after it (#6432 round 3).
let consentGeneration = 0;
export function productAnalyticsGeneration(): number {
  return consentGeneration;
}

function publish(next: boolean) {
  if (disabled !== next) consentGeneration += 1;
  disabled = next;
  if (next) pending.abort();
  else if (pending.signal.aborted) pending = new AbortController();
  listeners.forEach((listener) => listener());
}

export function productAnalyticsEnabled(): Promise<boolean> {
  if (disabled !== null) return Promise.resolve(!disabled);
  reading ??= SecureStore.getItemAsync(ANALYTICS_DISABLED_KEY)
    .then((value) => value === 'true', () => true)
    .then((stored) => {
      // A switch flipped while the read was in flight wins over the stored value.
      if (disabled === null) publish(stored);
      return !disabled;
    });
  return reading;
}

// Flips the in-memory gate before touching storage, so nothing is sent while
// the write is pending. Writes run one at a time and each stores the latest
// choice, so rapid toggles cannot leave an older value on disk. Resolves false
// when the choice could not be saved; the gate still holds for this run.
// The switch as this run knows it; false until the stored choice is read.
export function productAnalyticsEnabledNow(): boolean {
  if (disabled === null) void productAnalyticsEnabled();
  return disabled === false;
}

export function setProductAnalyticsEnabled(enabled: boolean): Promise<boolean> {
  publish(!enabled);
  const write = writing.then(async () => {
    try {
      if (disabled) await SecureStore.setItemAsync(ANALYTICS_DISABLED_KEY, 'true');
      else await SecureStore.deleteItemAsync(ANALYTICS_DISABLED_KEY);
      return true;
    } catch {
      return false;
    }
  });
  writing = write;
  return write;
}

export function gatePageViewRecorder(record: SignalledPageViewRecorder): FeaturePageViewRecorder {
  return async (page, hat) => ((await productAnalyticsEnabled()) ? record(page, hat, pending.signal) : null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// null until the stored choice has been read.
export function useProductAnalyticsEnabled(): boolean | null {
  const value = useSyncExternalStore(subscribe, () => (disabled === null ? null : !disabled));
  if (value === null) void productAnalyticsEnabled();
  return value;
}

export function resetProductAnalyticsPreferenceForTests() {
  disabled = null;
  reading = null;
  writing = Promise.resolve();
  pending = new AbortController();
  listeners.clear();
}
