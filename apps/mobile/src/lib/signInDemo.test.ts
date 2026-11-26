import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement, type PropsWithChildren } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  liveSample: false,
  app: {
    mode: 'signedOut', error: null, signOutError: null,
    sampleEntryBusy: false, previewAllowed: true,
    enterSample: vi.fn(), enterPreview: vi.fn(), signInWithPassword: vi.fn(),
  },
  buttons: [] as { label: string; variant?: string; disabled?: boolean; onPress: () => void }[],
}));

// Render the real screen with platform primitives replaced by inert host
// elements. Union Ground has no SAMPLE backend yet, so the live-entry
// predicate is mocked to prove both builds still offer exactly one demo action.
vi.mock('react-native', () => ({
  KeyboardAvoidingView: ({ children }: PropsWithChildren) => createElement('div', null, children),
  ScrollView: ({ children }: PropsWithChildren) => createElement('div', null, children),
  Text: ({ children }: PropsWithChildren) => createElement('span', null, children),
  TextInput: () => createElement('input'),
  View: ({ children }: PropsWithChildren) => createElement('div', null, children),
  Platform: { OS: 'android', select: (options: { android?: unknown; default?: unknown }) => options.android ?? options.default },
  StyleSheet: { create: (styles: unknown) => styles },
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('expo-router', () => ({
  Redirect: () => null, useLocalSearchParams: () => ({}), useRouter: () => ({}),
  // Static rendering does not run focus effects, like React's other effects.
  useFocusEffect: () => undefined,
}));
vi.mock('../components/ui', () => ({
  Body: ({ children }: PropsWithChildren) => createElement('p', null, children),
  Button: (props: (typeof state.buttons)[number]) => {
    state.buttons.push(props);
    return createElement('button', { disabled: props.disabled }, props.label);
  },
}));
vi.mock('../components/BrandMark', () => ({ BrandMark: () => null }));
vi.mock('./announce', () => ({ announceForAccessibility: vi.fn() }));
vi.mock('./config', () => ({ mobileConfig: {} }));
vi.mock('../services/nativeQuickActionRoutes', () => ({ nativeQuickActionDestinationPath: () => null }));
vi.mock('../services/sampleSession', () => ({ isLiveSampleBackend: () => state.liveSample }));
vi.mock('../state/AppProvider', () => ({ useApp: () => state.app }));
vi.mock('../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../theme/tokens');
  return { useTheme: () => resolveTheme() };
});

import SignInScreen from '../../app/sign-in';

function render() {
  return renderToStaticMarkup(createElement(SignInScreen));
}
function demoButtons() {
  return state.buttons.filter(({ label }) => /demo|SAMPLE|PREVIEW/.test(label));
}

beforeEach(() => {
  state.liveSample = false;
  state.app.mode = 'signedOut';
  state.app.previewAllowed = true;
  state.app.sampleEntryBusy = false;
  state.buttons.length = 0;
  vi.clearAllMocks();
});

describe('one signed-out demo action per build', () => {
  it('keeps retired demo labels out of mobile sources', () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const paths = execFileSync('git', [
      'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'apps/mobile',
    ], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
    const retiredLabels = [
      ['Explore', 'the', 'PREVIEW', 'demo'].join(' '),
      ['Open', 'SAMPLE'].join(' '),
    ].map((label) => ({
      label,
      // These ASCII labels use the same bytes in UTF-8 and legacy single-byte
      // text. Check UTF-16 in both byte orders too, with or without a BOM.
      encodings: [Buffer.from(label), Buffer.from(label, 'utf16le'), Buffer.from(label, 'utf16le').swap16()],
    }));
    const violations = paths.flatMap((path) => {
      const bytes = readFileSync(join(root, path));
      return retiredLabels.filter(({ encodings }) => encodings.some((label) => bytes.includes(label)))
        .map(({ label }) => ({ path, label }));
    });

    expect(paths).toContain('apps/mobile/src/lib/biometricAvailability.ts');
    expect(violations).toEqual([]);
  });

  it.each([true, false])('a SAMPLE build offers only live entry when previewAllowed=%s', (previewAllowed) => {
    state.liveSample = true;
    state.app.previewAllowed = previewAllowed;
    const html = render();
    expect(demoButtons().map(({ label }) => label)).toEqual(['Open the demo']);
    expect(html).toContain('Explore the demo as a fictional worker. No password is needed.');
    expect(html).not.toContain('Darnell Foster');
    demoButtons()[0]!.onPress();
    expect(state.app.enterSample).toHaveBeenCalledOnce();
    expect(state.app.enterPreview).not.toHaveBeenCalled();
  });

  it('any other build offers only the offline preview', () => {
    const html = render();
    expect(demoButtons().map(({ label }) => label)).toEqual(['Try the demo']);
    expect(demoButtons()[0]!.variant).toBe('secondary');
    expect(html).toContain('Starts as Darnell Foster, a fictional worker');
    demoButtons()[0]!.onPress();
    expect(state.app.enterPreview).toHaveBeenCalledWith({ hat: 'member', shell: 'tabs' });
    expect(state.app.enterSample).not.toHaveBeenCalled();
  });

  it('offers no demo when preview is not allowed and no SAMPLE backend is pinned', () => {
    state.app.previewAllowed = false;
    render();
    expect(demoButtons()).toEqual([]);
  });
});
