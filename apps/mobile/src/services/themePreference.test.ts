import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => secureStore);

import { loadThemePreference, saveThemePreference } from './themePreference';

describe('device-local native theme preference', () => {
  beforeEach(() => {
    secureStore.getItemAsync.mockReset();
    secureStore.setItemAsync.mockReset();
    secureStore.deleteItemAsync.mockReset();
  });

  // REQ-UG-THEMES-UNION-GREEN-ONLY-MOBILE-20261103: Union Ground is the
  // only theme, so every stored value, a retired theme included, loads as it.
  it.each(['union-ground', 'cobalt-signal', 'union-printroom', 'night-shift', 'collected', 'aubergine-ledger', 'retired-theme', null])(
    'loads a stored %s as Union Ground',
    async (stored) => {
      secureStore.getItemAsync.mockResolvedValueOnce(stored);
      await expect(loadThemePreference()).resolves.toBe('union-ground');
    },
  );

  it('clears storage when Union Ground is saved, so no retired value lingers', async () => {
    await saveThemePreference('union-ground');
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith('union-ground.native-theme.v1');
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();
  });
});
