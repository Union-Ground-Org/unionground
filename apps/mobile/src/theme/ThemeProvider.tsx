import * as SystemUI from 'expo-system-ui';
import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from 'react';

import { loadThemePreference } from '../services/themePreference';
import { useApp } from '../state/AppProvider';
import {
  defaultThemeKey,
  effectiveThemeKey,
  resolveTheme,
  type ThemeAppearance,
  type ThemeKey,
  type ThemeTokens,
} from './tokens';

type ThemePreferenceContextValue = {
  selectedTheme: ThemeKey;
  effectiveTheme: ThemeKey;
  appearance: ThemeAppearance;
  ready: boolean;
};

const ThemeContext = createContext<ThemeTokens | null>(null);
const ThemePreferenceContext = createContext<ThemePreferenceContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const { mode, previewHat } = useApp();
  const [selectedTheme, setSelectedTheme] = useState<ThemeKey>(defaultThemeKey);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    void loadThemePreference()
      .then((storedTheme) => { if (active) setSelectedTheme(storedTheme); })
      .catch(() => undefined)
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  const effectiveTheme = effectiveThemeKey(selectedTheme, mode === 'preview' ? previewHat : null);
  // Union Ground is the only theme. The app renders light only (owner order of Nov 5, 2026,
  // REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105): the device's
  // appearance is never read.
  const tokens = useMemo(() => resolveTheme(effectiveTheme), [effectiveTheme]);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(tokens.background).catch(() => undefined);
  }, [tokens.background]);

  const preference = useMemo<ThemePreferenceContextValue>(() => ({
    selectedTheme,
    effectiveTheme,
    appearance: tokens.appearance,
    ready,
  }), [effectiveTheme, ready, selectedTheme, tokens.appearance]);

  return (
    <ThemePreferenceContext.Provider value={preference}>
      <ThemeContext.Provider value={tokens}>{children}</ThemeContext.Provider>
    </ThemePreferenceContext.Provider>
  );
}

export function useTheme(): ThemeTokens {
  const tokens = useContext(ThemeContext);
  if (!tokens) throw new Error('useTheme must be used inside ThemeProvider.');
  return tokens;
}

export function useThemePreference(): ThemePreferenceContextValue {
  const preference = useContext(ThemePreferenceContext);
  if (!preference) throw new Error('useThemePreference must be used inside ThemeProvider.');
  return preference;
}
