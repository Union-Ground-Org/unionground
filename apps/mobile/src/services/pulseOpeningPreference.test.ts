import { beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => storage.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { storage.set(key, value); },
}));
import { loadPulseOpening, savePulseOpening } from './pulseOpeningPreference';

beforeEach(() => storage.clear());
it('persists the native adapter choice for the account without applying it to another account', async () => {
  const first = '10000000-0000-4000-8000-000000000001', second = '10000000-0000-4000-8000-000000000002';
  expect(await loadPulseOpening(first)).toEqual({ opening: 'week', setupComplete: false });
  await savePulseOpening(first, 'charts');
  expect(await loadPulseOpening(first)).toEqual({ opening: 'charts', setupComplete: true });
  expect(await loadPulseOpening(second)).toEqual({ opening: 'week', setupComplete: false });
});
