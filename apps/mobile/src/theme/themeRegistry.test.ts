import { describe, expect, it } from 'vitest';

import palette from './palette.json';
import {
  darkPaletteKey,
  HAT_THEME_KEYS,
  defaultThemeKey,
  effectiveThemeKey,
  minimumTouchTarget,
  normalizeThemeKey,
  resolveTheme,
  themeAppearance,
  themeKeys,
  themeOptions,
  themePalette,
  RETIRED_THEME_KEYS,
} from './tokens';

describe('native system theme registry', () => {
  // REQ-UG-THEMES-UNION-GREEN-ONLY-MOBILE-20261103 (owner ruling, Nov 3,
  // 2026): Union Ground is the only theme and the default for every account.
  // Supersedes the Aug 2026 rule "Union Ground plus the four named system themes".
  const removed = ['aubergine-ledger', 'cobalt-signal', 'union-printroom', 'night-shift', 'collected'];

  it('ships Union Ground as the only theme, with its dark form as a palette', () => {
    expect(themeKeys).toEqual(['union-ground']);
    expect(themeOptions.map((option) => option.key)).toEqual(themeKeys);
    expect(themeOptions.map((option) => option.label)).toEqual(['Union Ground']);
    expect(Object.keys(themePalette)).toEqual(['union-ground', darkPaletteKey]);
    expect(darkPaletteKey).toBe('union-ground-dark');
  });

  it('keeps the exact Union Ground cream, forest green, and gold', () => {
    const tokens = resolveTheme(defaultThemeKey);
    expect(tokens.background).toBe('#F6F2E9');
    expect(tokens.primary).toBe('#0E4034');
    expect(tokens.accent).toBe('#EFA738');
    expect(tokens.compass).toBe('#6240B5');
    expect(normalizeThemeKey('toString')).toBe(defaultThemeKey);
  });

  it.each(removed)('opens a saved %s choice in Union Ground', (key) => {
    expect(RETIRED_THEME_KEYS[key]).toBe(defaultThemeKey);
    expect(normalizeThemeKey(key)).toBe(defaultThemeKey);
    expect(resolveTheme(key as never)).toEqual(resolveTheme(defaultThemeKey));
    expect(resolveTheme(key as never, true)).toEqual(resolveTheme(defaultThemeKey, true));
    expect(themeKeys as readonly string[]).not.toContain(key);
    expect(Object.keys(themePalette)).not.toContain(key);
  });

  it('maps every retired theme, and nothing else, to Union Ground', () => {
    expect(RETIRED_THEME_KEYS).toEqual(Object.fromEntries(removed.map((key) => [key, defaultThemeKey])));
  });

  it('declares dark chrome only for Union Ground\'s dark form', () => {
    expect(themeAppearance(darkPaletteKey)).toBe('dark');
    expect(themeAppearance(defaultThemeKey)).toBe('light');
  });

  it('follows system appearance into Union Ground\'s dark form without replacing its saved choice', () => {
    const selected = defaultThemeKey;
    expect(resolveTheme(selected, true)).toEqual({ ...themePalette[darkPaletteKey], appearance: 'dark' });
    expect(resolveTheme(selected, false)).toEqual({ ...themePalette[selected], appearance: 'light' });
    expect(effectiveThemeKey(selected, null)).toBe(defaultThemeKey);
    expect(resolveTheme(null, true).appearance).toBe('dark');
  });

  it('keeps the dark form green, not the retired Night Shift navy and violet', () => {
    const dark = themePalette[darkPaletteKey];
    for (const retired of ['#0D1424', '#151F34', '#8B78F6', '#241F45', '#AFA2FF']) {
      expect(Object.values(dark)).not.toContain(retired);
    }
    const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(dark.primary.slice(offset, offset + 2), 16));
    expect(green).toBeGreaterThan(red!);
    expect(green).toBeGreaterThan(blue!);
  });

  it('gives every SAMPLE hat Union Ground, so no hat renders another palette by default', () => {
    for (const hat of ['member', 'steward', 'coordinator', 'advisor', 'admin', 'vp']) {
      expect(HAT_THEME_KEYS[hat]).toBe(defaultThemeKey);
      expect(effectiveThemeKey(defaultThemeKey, hat)).toBe(defaultThemeKey);
    }
    expect(effectiveThemeKey(defaultThemeKey, null)).toBe(defaultThemeKey);
    expect(effectiveThemeKey(defaultThemeKey, 'unknown-hat')).toBe(defaultThemeKey);
  });

  it('holds the 48-point minimum touch target the accessibility floor requires', () => {
    // The "48px minimum touch targets" rule sets this floor. The component
    // contract suites only assert that controls reference this identifier, so
    // they follow the token wherever it moves; this states the value itself.
    expect(minimumTouchTarget).toBe(48);
  });
});
