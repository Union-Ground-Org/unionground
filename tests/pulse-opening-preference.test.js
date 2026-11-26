import { describe, expect, it } from 'vitest';
import { createPulseOpeningStore, normalizePulseOpening, pulseOpeningKey } from '../src/lib/pulseOpeningPreference.js';

const A = '10000000-0000-4000-8000-000000000001';
const B = '10000000-0000-4000-8000-000000000002';
function memory() {
  const values = new Map();
  return { getItem: async (key) => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); } };
}
describe('native per-account Pulse opening choice', () => {
  it('defaults a new or unreadable account to This week and keeps setup optional', () => {
    for (const value of [null, '', '{}', 'null', 'bad', '{"version":1,"opening":"bad","setupComplete":true}']) {
      expect(normalizePulseOpening(value)).toEqual({ opening: 'week', setupComplete: false });
    }
    expect(() => pulseOpeningKey('')).toThrow('signed-in account');
    expect(() => pulseOpeningKey('other/account')).toThrow('signed-in account');
    expect(pulseOpeningKey(A.toUpperCase())).toBe(pulseOpeningKey(A));
  });
  it('persists across store instances, isolates accounts, and allows Skip to keep the default', async () => {
    const storage = memory();
    const first = createPulseOpeningStore(storage);
    expect(await first.load(A)).toMatchObject({ opening: 'week', setupComplete: false });
    await first.save(A, 'charts');
    expect(await createPulseOpeningStore(storage).load(A)).toEqual({ opening: 'charts', setupComplete: true });
    expect(await first.load(B)).toEqual({ opening: 'week', setupComplete: false });
    await first.save(B, 'week');
    expect(await first.load(B)).toEqual({ opening: 'week', setupComplete: true });
    expect(await first.load(A)).toMatchObject({ opening: 'charts' });
    await expect(first.save(A, 'other')).rejects.toThrow('Choose');
  });
  it('reports storage refusal or a dropped write without claiming it saved', async () => {
    const refused = createPulseOpeningStore({ getItem: async () => { throw new Error('storage'); }, setItem: async () => { throw new Error('storage'); } });
    await expect(refused.load(A)).rejects.toThrow('storage');
    await expect(refused.save(A, 'week')).rejects.toThrow('storage');
    const dropped = createPulseOpeningStore({ ...memory(), setItem: async () => {} });
    await expect(dropped.save(A, 'charts')).rejects.toThrow('could not be saved');
  });
});
