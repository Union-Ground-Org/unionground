import * as SecureStore from 'expo-secure-store';

import { defaultThemeKey, normalizeThemeKey, type ThemeKey } from '../theme/tokens';

const themePreferenceKey = 'union-ground.native-theme.v1';

// Union Ground is the only theme (Nov 3, 2026): every stored value, a retired
// theme saved before then included, loads as Union Ground.
export async function loadThemePreference(): Promise<ThemeKey> {
  return normalizeThemeKey(await SecureStore.getItemAsync(themePreferenceKey));
}

export async function saveThemePreference(theme: ThemeKey): Promise<void> {
  if (theme === defaultThemeKey) {
    await SecureStore.deleteItemAsync(themePreferenceKey);
    return;
  }
  await SecureStore.setItemAsync(themePreferenceKey, theme);
}
