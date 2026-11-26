import { createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };

// REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105 (owner order, Nov 5,
// 2026): the app renders light only. The device answers 'dark' here, and the
// root theme provider still hands every screen the light Union Ground palette
// without ever asking the device.
const harness = vi.hoisted(() => ({
  colorScheme: vi.fn(() => 'dark'),
  appearance: { getColorScheme: vi.fn(() => 'dark'), addChangeListener: vi.fn() },
  background: vi.fn((_color: string) => Promise.resolve()),
}));

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  // Server rendering skips effects; run each where it is declared.
  useEffect: (effect: () => void) => { effect(); },
}));
vi.mock('react-native', () => ({ useColorScheme: harness.colorScheme, Appearance: harness.appearance }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: harness.background }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ mode: 'signedOut', previewHat: null, session: null, organizationID: null }) }));
vi.mock('../services/supabase', () => ({ createCapturedSessionRpcClient: () => null }));
vi.mock('../services/themePreference', () => ({ loadThemePreference: () => Promise.resolve('union-ground') }));

const { ThemeProvider, useTheme, useThemePreference } = await import('./ThemeProvider');
const { themePalette } = await import('./tokens');

function Probe() {
  const theme = useTheme();
  const { appearance } = useThemePreference();
  return createElement('output', null, `${theme.appearance}|${appearance}|${theme.background}|${theme.foreground}`);
}

describe('the root theme on a device that prefers dark', () => {
  it('renders the light Union Ground palette and never reads the device appearance', () => {
    const html = renderToStaticMarkup(createElement(ThemeProvider, null, createElement(Probe)));
    const light = themePalette['union-ground'];
    expect(html).toContain(`light|light|${light.background}|${light.foreground}`);
    expect(html).not.toContain(themePalette['union-ground-dark'].background);
    expect(harness.background).toHaveBeenCalledWith(light.background);
    expect(harness.colorScheme).not.toHaveBeenCalled();
    expect(harness.appearance.getColorScheme).not.toHaveBeenCalled();
  });

  it('leaves no screen, provider or boundary reading the device appearance or asking for the dark palette', () => {
    const root = join(__dirname, '..', '..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(path);
      }
    };
    walk(join(root, 'app'));
    walk(join(root, 'src'));
    const offenders = sources.filter((path) => {
      const text = readFileSync(path, 'utf8');
      return /\buseColorScheme\b|\bAppearance\.(getColorScheme|addChangeListener|setColorScheme)\b/.test(text)
        // A call, not the definition in tokens.ts that the palette audits use.
        || /(?<!function )resolveTheme\([^()]*,\s*(true|prefersDark|systemDark|dark)\b/.test(text);
    });
    expect(offenders).toEqual([]);
    const config = readFileSync(join(root, 'app.config.ts'), 'utf8');
    expect(config).toContain("userInterfaceStyle: 'light',");
    expect(config).not.toMatch(/userInterfaceStyle: '(automatic|dark)'/);
  });
});
