import { beforeEach, describe, expect, it, vi } from 'vitest';

const removed = vi.hoisted(() => [] as string[]);
vi.mock('./secureSessionStorage', () => ({
  secureSessionStorage: { removeItem: vi.fn(async (key: string) => { removed.push(key); }) },
}));

import { PRODUCTION_AUTH_STORAGE_KEY, STORE_DEMO_AUTH_STORAGE_KEY } from './storeDemo';
import { storeDemoDevice } from './storeDemoDevice';

beforeEach(() => { removed.length = 0; });

// Gate stage 122 on #8680: Exit demo removes the demo session from the phone
// itself, so a visitor who leaves with SAMPLE unreachable leaves nothing
// behind, and the Production session is never part of it.
describe('the demo session is removed on this phone only', () => {
  it('removes the demo client keys and their origin markers, and nothing of Production', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await storeDemoDevice.clearDemoSession();
    expect(removed.sort()).toEqual([
      STORE_DEMO_AUTH_STORAGE_KEY,
      `${STORE_DEMO_AUTH_STORAGE_KEY}-code-verifier`,
      `${STORE_DEMO_AUTH_STORAGE_KEY}-code-verifier.backend-origin`,
      `${STORE_DEMO_AUTH_STORAGE_KEY}-user`,
      `${STORE_DEMO_AUTH_STORAGE_KEY}-user.backend-origin`,
      `${STORE_DEMO_AUTH_STORAGE_KEY}.backend-origin`,
    ].sort());
    expect(removed.some((key) => key.startsWith(`${PRODUCTION_AUTH_STORAGE_KEY}`) && !key.startsWith(STORE_DEMO_AUTH_STORAGE_KEY))).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
