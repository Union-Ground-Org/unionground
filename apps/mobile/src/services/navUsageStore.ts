// REQ-UG-USAGE-BASED-NAVIGATION-20261001: where the phone keeps its own
// navigation counts. One secure-storage value per signed-in account; nothing
// is ever sent to the server. The member resets it from Account.
import * as SecureStore from 'expo-secure-store';

import { emptyNavUsage, parseNavUsage, recordNavVisit, type NavUsage } from '../lib/navUsageShared';

const listeners = new Set<() => void>();
const ACCOUNT_KEY = /^[A-Za-z0-9-]{1,64}$/;

export function navUsageSecureKey(userID: string): string | null {
  return ACCOUNT_KEY.test(userID) ? `org.unionground.app.nav-usage-v1.${userID}` : null;
}

export function subscribeNavUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  listeners.forEach((listener) => listener());
}

export async function readNativeNavUsage(userID: string): Promise<NavUsage> {
  const key = navUsageSecureKey(userID);
  if (!key) return emptyNavUsage();
  try {
    return parseNavUsage(await SecureStore.getItemAsync(key));
  } catch {
    return emptyNavUsage();
  }
}

// Visits and resets share one queue so older writes cannot undo a reset.
let tail: Promise<unknown> = Promise.resolve();

export function recordNativeNavVisit(userID: string, destination: string, now: Date = new Date()): Promise<void> {
  const key = navUsageSecureKey(userID);
  if (!key) return Promise.resolve();
  const run = tail.catch(() => undefined).then(async () => {
    const next = recordNavVisit(await readNativeNavUsage(userID), destination, now);
    await SecureStore.setItemAsync(key, JSON.stringify(next));
    notify();
  });
  tail = run;
  return run.catch(() => undefined);
}

export function resetNativeNavUsage(userID: string): Promise<void> {
  const key = navUsageSecureKey(userID);
  if (!key) return Promise.resolve();
  const run = tail.catch(() => undefined).then(async () => {
    await SecureStore.deleteItemAsync(key);
    notify();
  });
  tail = run;
  return run;
}
