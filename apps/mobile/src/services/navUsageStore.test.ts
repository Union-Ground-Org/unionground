import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as SecureStore from 'expo-secure-store';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  deleteItemAsync: vi.fn(async (key: string) => { values.delete(key); }),
}));

import { NATIVE_DESTINATIONS, computeNavWeights, destinationForPath, orderByUsage, primaryNavKeys } from '../lib/navUsageShared';
import { navUsageSecureKey, readNativeNavUsage, recordNativeNavVisit, resetNativeNavUsage, subscribeNavUsage } from './navUsageStore';

const USER = '0f6b2c7e-4c1d-4c55-9a51-6a2d0b7f9e10';
const NOW = new Date(2026, 9, 1, 12);

describe('REQ-UG-USAGE-BASED-NAVIGATION-20261001 native ranking', () => {
  beforeEach(() => values.clear());

  it('maps routes to worker destinations and never ranks staff desks', () => {
    expect(destinationForPath('/home')).toBe('today');
    expect(destinationForPath('/messages')).toBe('messages');
    expect(destinationForPath('/conversation/abc')).toBe('messages');
    expect(destinationForPath('/issue/123')).toBe('cases');
    expect(destinationForPath('/feature/voting')).toBe('voting');
    expect(destinationForPath('/feature/steward')).toBeNull();
    expect(destinationForPath('/feature/tasks')).toBeNull();
    // Union Ground leaves dues out, so Dues is never a ranked destination.
    expect(destinationForPath('/feature/dues')).toBeNull();
    expect(NATIVE_DESTINATIONS.filter((item) => item.key === 'dues' || /dues/i.test(item.label) || item.href.includes('dues'))).toEqual([]);
    expect(destinationForPath('/sign-in')).toBeNull();
    expect(destinationForPath(null)).toBeNull();
  });

  it('keeps counts in this phone’s secure storage only, per account, and bounded', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNavUsage(listener);
    for (let index = 0; index < 3; index += 1) await recordNativeNavVisit(USER, 'events', NOW);
    await recordNativeNavVisit(USER, 'messages', NOW);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    const key = navUsageSecureKey(USER);
    expect(key).toBe(`org.unionground.app.nav-usage-v1.${USER}`);
    expect([...values.keys()]).toEqual([key]);
    const weights = computeNavWeights(await readNativeNavUsage(USER), NOW);
    expect(weights).toEqual([{ key: 'events', weight: 24 }, { key: 'messages', weight: 8 }]);
    for (let index = 0; index < 30; index += 1) await recordNativeNavVisit(USER, `dest-${index}`, NOW);
    expect(Object.keys((await readNativeNavUsage(USER)).visits).length).toBeLessThanOrEqual(12);
    expect((values.get(key ?? '') ?? '').length).toBeLessThan(2048);
  });

  it('refuses a malformed account key and resets on request', async () => {
    expect(navUsageSecureKey('../x')).toBeNull();
    await recordNativeNavVisit('../x', 'events', NOW);
    expect(values.size).toBe(0);
    await recordNativeNavVisit(USER, 'events', NOW);
    await resetNativeNavUsage(USER);
    expect(values.size).toBe(0);
    expect((await readNativeNavUsage(USER)).visits).toEqual({});
  });

  it('keeps history erased when a previously started visit finishes during reset', async () => {
    await recordNativeNavVisit(USER, 'events', NOW);
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      started();
      await pending;
      values.set(key, value);
    });
    const visit = recordNativeNavVisit(USER, 'messages', NOW);
    await writing;
    const reset = resetNativeNavUsage(USER);
    release();
    await Promise.all([visit, reset]);
    expect((await readNativeNavUsage(USER)).visits).toEqual({});
  });

  it('retains visits requested after reset and preserves the other account', async () => {
    const otherUser = 'other-account';
    await recordNativeNavVisit(USER, 'events', NOW);
    await recordNativeNavVisit(otherUser, 'rights', NOW);
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const writing = new Promise<void>((resolve) => { started = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
      started();
      await pending;
      values.set(key, value);
    });
    const before = recordNativeNavVisit(USER, 'messages', NOW);
    await writing;
    const reset = resetNativeNavUsage(USER);
    const after = recordNativeNavVisit(USER, 'cases', NOW);
    release();
    await Promise.all([before, reset, after]);
    expect(Object.keys((await readNativeNavUsage(USER)).visits)).toEqual(['cases']);
    expect(Object.keys((await readNativeNavUsage(otherUser)).visits)).toEqual(['rights']);
  });

  it('continues through a failed visit and a failed reset without losing later writes', async () => {
    await recordNativeNavVisit(USER, 'events', NOW);
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('write refused'));
    const failedVisit = recordNativeNavVisit(USER, 'messages', NOW);
    const reset = resetNativeNavUsage(USER);
    const after = recordNativeNavVisit(USER, 'cases', NOW);
    await Promise.all([failedVisit, reset, after]);
    expect(Object.keys((await readNativeNavUsage(USER)).visits)).toEqual(['cases']);

    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('reset refused'));
    await expect(resetNativeNavUsage(USER)).rejects.toThrow('reset refused');
    await recordNativeNavVisit(USER, 'events', NOW);
    expect(Object.keys((await readNativeNavUsage(USER)).visits).sort()).toEqual(['cases', 'events']);
  });

  it('ranks the four most-used destinations and reorders Quick actions by use', () => {
    const weights = [{ key: 'today', weight: 50 }, { key: 'events', weight: 9 }, { key: 'staff-only', weight: 8 }, { key: 'voting', weight: 7 }];
    expect(primaryNavKeys(weights, NATIVE_DESTINATIONS.map((item) => item.key))).toEqual(['events', 'voting']);
    const order = orderByUsage([{ key: 'notifications' }, { key: 'messages' }, { key: 'work' }], [{ key: 'work', weight: 3 }]);
    expect(order.map((item) => item.key)).toEqual(['work', 'notifications', 'messages']);
  });

  it('wires the recorder, the Home row, Quick actions and the Account reset', () => {
    const layout = readFileSync(join(__dirname, '../../app/_layout.tsx'), 'utf8');
    expect(layout).toContain('<NavUsageRecorder />');
    const home = readFileSync(join(__dirname, '../../app/(tabs)/home.tsx'), 'utf8');
    const liveStart = home.indexOf('function AuthenticatedHome');
    expect(liveStart, 'AuthenticatedHome must exist').toBeGreaterThanOrEqual(0);
    const live = home.slice(liveStart);
    const usageIndex = live.indexOf('const navUsage = useNativeNavUsage();');
    const dashboardIndex = live.indexOf('if (!dashboard)');
    expect(usageIndex, 'useNativeNavUsage must run on live Home').toBeGreaterThanOrEqual(0);
    expect(dashboardIndex, 'The dashboard guard must exist on live Home').toBeGreaterThanOrEqual(0);
    expect(usageIndex).toBeLessThan(dashboardIndex);
    expect(live).toContain('{navUsage.enabled ? <MostUsedRow weights={navUsage.weights} /> : null}');
    expect(live).toContain('const quickActions = orderByUsage<QuickActionItem>([');
    const account = readFileSync(join(__dirname, '../../app/(tabs)/account.tsx'), 'utf8');
    expect(account).toContain('<NavUsageResetCard />');
    const component = readFileSync(join(__dirname, '../features/home/NavUsage.tsx'), 'utf8');
    expect(component).toContain('label="Reset most used"');
    expect(component).toContain('accessibilityRole="button"');
  });
});
