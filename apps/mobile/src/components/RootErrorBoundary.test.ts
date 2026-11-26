// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render as mount } from '../testing/reactNativeStandIn';

const { renderToStaticMarkup } = createRequire(import.meta.url)('react-dom/server') as { renderToStaticMarkup: (element: ReactNode) => string };
const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// BUG-UG-NATIVE-NO-ERROR-BOUNDARY-20261018. The mobile lane has no
// native renderer, so native primitives map to semantic host nodes and each
// pressable's handler is kept by label for the test to press.
const harness = vi.hoisted(() => ({
  presses: new Map<string, () => void>(),
  systemBars: [] as Array<{ bar: string; style?: string }>,
  announce: vi.fn((_message: string, _attempt?: string | number) => () => undefined),
  replace: vi.fn(),
  openURL: vi.fn(() => Promise.resolve()),
  report: vi.fn(() => true),
  colorScheme: vi.fn(() => 'dark' as 'light' | 'dark'),
}));

vi.mock('react-native', () => {
  const h = createElement;
  type Props = { children?: ReactNode; accessibilityLabel?: string; accessibilityRole?: string; onPress?: () => void; selectable?: boolean };
  return {
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Linking: { openURL: harness.openURL },
    useColorScheme: harness.colorScheme,
    ScrollView: ({ children }: Props) => h('section', null, children),
    View: ({ children }: Props) => h('div', null, children),
    Text: ({ children, accessibilityRole, selectable }: Props) => h(accessibilityRole === 'header' ? 'h1' : 'span', { 'data-selectable': selectable }, children),
    Pressable: ({ children, accessibilityLabel, accessibilityRole, onPress }: Props) => {
      if (accessibilityLabel && onPress) harness.presses.set(accessibilityLabel, onPress);
      return h('button', { 'aria-label': accessibilityLabel, role: accessibilityRole }, children);
    },
  };
});
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('main', null, children),
}));
vi.mock('expo-status-bar', () => ({
  StatusBar: ({ style }: { style?: string }) => { harness.systemBars.push({ bar: 'status', style }); return null; },
}));
vi.mock('expo-navigation-bar', () => ({
  NavigationBar: ({ style }: { style?: string }) => { harness.systemBars.push({ bar: 'navigation', style }); return null; },
}));
vi.mock('expo-router', () => ({ router: { replace: harness.replace } }));
vi.mock('../services/observability', () => ({ reportNativeRenderError: harness.report }));
vi.mock('../lib/announce', () => ({
  queueAccessibilityAnnouncement: harness.announce,
  useAccessibilityAnnouncementQueue: () => harness.announce,
}));

import { RECOVERY_ANNOUNCEMENT, RecoveryScreen, RootErrorBoundary, SUPPORT_ADDRESS } from './RootErrorBoundary';

function render(error = new Error('render failed')) {
  const retry = vi.fn(() => Promise.resolve());
  const html = renderToStaticMarkup(createElement(RootErrorBoundary, { error, retry }));
  return { html, retry, error };
}

function press(label: string) {
  const handler = harness.presses.get(label);
  if (!handler) throw new Error(`no pressable labelled ${label}`);
  handler();
}

describe('native root error boundary', () => {
  beforeEach(() => {
    harness.presses.clear();
    harness.systemBars.length = 0;
    vi.clearAllMocks();
  });

  it('draws a recovery screen with both actions and no unpublished support address', () => {
    const { html } = render();
    expect(html).toContain('<h1>Something went wrong</h1>');
    expect(html).toContain('aria-label="Try again"');
    expect(html).toContain('aria-label="Go to Home"');
    expect(SUPPORT_ADDRESS).toBeNull();
    expect(html).not.toContain('email support');
    expect(html).not.toContain('render failed');
  });

  it('reports the caught error and announces the recovery screen', async () => {
    const error = new Error('render failed');
    const screen = await mount(createElement(RootErrorBoundary, { error, retry: vi.fn(() => Promise.resolve()) }));
    try {
      expect(harness.report).toHaveBeenCalledWith(error);
      expect(harness.announce).toHaveBeenCalledWith(RECOVERY_ANNOUNCEMENT, 'root-error-boundary:1');
    } finally { await screen.unmount(); }
  });

  it('Try again calls retry without navigating', async () => {
    const { retry } = render();
    press('Try again');
    await Promise.resolve();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it('Go to Home remounts the layout, then replaces to the index route', async () => {
    const { retry } = render();
    press('Go to Home');
    await vi.waitFor(() => expect(harness.replace).toHaveBeenCalledWith('/'));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(retry.mock.invocationCallOrder[0]).toBeLessThan(harness.replace.mock.invocationCallOrder[0]!);
  });

  it('offers no mail draft while Union Ground publishes no support mailbox', () => {
    const { html } = render();
    expect(html).not.toContain('mailto:');
    expect(harness.openURL).not.toHaveBeenCalled();
  });

  it.skipIf(SUPPORT_ADDRESS === null).each<[string, string]>([
    ['en-US', 'Union Ground could not open a mail app.'],
    ['es-US', 'Union Ground no pudo abrir una aplicación de correo.'],
  ])('shows and announces a copyable address when the mail app cannot open in %s', async (locale, reason) => {
    const options = Intl.DateTimeFormat().resolvedOptions();
    const localeSpy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, locale });
    harness.openURL.mockRejectedValueOnce(new Error('no mail app'));
    const screen = await mount(createElement(RootErrorBoundary, { error: new Error('render failed'), retry: vi.fn(() => Promise.resolve()) }));
    try {
      await act(async () => press(`Email ${SUPPORT_ADDRESS}`));
      const fallback = screen.container.querySelector('[data-selectable="true"]');
      expect(fallback?.textContent ?? '').toContain(reason);
      expect(fallback?.textContent ?? '').toContain(SUPPORT_ADDRESS);
      expect(harness.announce).toHaveBeenCalledWith(fallback?.textContent);
    } finally {
      await screen.unmount();
      localeSpy.mockRestore();
    }
  });

  it('sets dark system-bar icons for its light boot palette', () => {
    render();
    expect(harness.systemBars).toEqual([{ bar: 'status', style: 'dark' }, { bar: 'navigation', style: 'dark' }]);
  });

  // REQ-UG-DISABLE-DARK-MODE-WEB-AND-MOBILE-20261105: the app is light
  // only, so the boundary keeps the light palette on a device that prefers
  // dark (the harness answers 'dark') and never asks the device.
  it('stays on the light palette with dark system-bar icons on a dark device, without reading the appearance', () => {
    render();
    expect(harness.systemBars).toEqual([{ bar: 'status', style: 'dark' }, { bar: 'navigation', style: 'dark' }]);
    expect(harness.colorScheme).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(createElement(RecoveryScreen, { error: new Error('render failed'), retry: vi.fn(() => Promise.resolve()) }));
    expect(html).toContain('<h1>Something went wrong</h1>');
  });

  it('scrolls its content and gives the support link a full touch target', () => {
    const component = source('./RootErrorBoundary.tsx');
    expect(component).toMatch(/<ScrollView contentContainerStyle=\{styles\.content\}>/);
    expect(component).toMatch(/content: \{ flexGrow: 1,/);
    expect(component).toMatch(/link: \{ minHeight: minimumTouchTarget,/);
    expect(component).toMatch(/button: \{ minHeight: minimumTouchTarget, borderRadius: radii\.pill,/);
  });

  it('is the ErrorBoundary Expo Router picks up from the root layout', () => {
    const layout = source('../../app/_layout.tsx');
    expect(layout).toMatch(/^export \{ RootErrorBoundary as ErrorBoundary \};$/m);
  });
});
