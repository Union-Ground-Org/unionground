// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppRoute } from './routes';

const runtime = vi.hoisted(() => {
  const state = {
    mode: 'booting' as 'booting' | 'signedOut' | 'mfaRequired' | 'authenticated' | 'preview',
    sessionUserID: null as string | null,
    pathname: '/home',
    ready: false,
    replace: vi.fn(),
    push: vi.fn(),
    redirects: [] as string[],
    listeners: [] as Array<() => void>,
    // Ledger 361: the boot screen's mark and spinner, as drawn, and the platform it runs on.
    platform: { OS: 'android' },
    marks: [] as number[],
    spinners: [] as unknown[],
    captions: [] as unknown[],
    navigation: {
      isReady: () => false,
      addListener: (_event: string, _callback: () => void) => () => undefined,
    },
  };
  state.navigation = {
    isReady: () => state.ready,
    addListener: (_event: string, callback: () => void) => {
      state.listeners.push(callback);
      return () => {
        state.listeners = state.listeners.filter((listener) => listener !== callback);
      };
    },
  };
  return state;
});

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    useRouter: () => ({ replace: runtime.replace, push: runtime.push }),
    usePathname: () => runtime.pathname,
    useNavigationContainerRef: () => runtime.navigation,
    Redirect: ({ href }: { href: string }) => {
      useEffect(() => { runtime.redirects.push(href); }, [href]);
      return null;
    },
  };
});
vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    mode: runtime.mode,
    session: runtime.sessionUserID ? { user: { id: runtime.sessionUserID } } : null,
  }),
}));
vi.mock('../theme/ThemeProvider', () => ({
  useTheme: () => ({ background: '#fffaf3', primary: '#4c1d4e', mutedForeground: '#5c4a3a' }),
}));
vi.mock('../components/BrandMark', () => ({ BrandMark: ({ size }: { size: number }) => { runtime.marks.push(size); return null; } }));
vi.mock('../services/lifecycleDiagnostics', () => ({ recordLifecycleEvent: () => undefined }));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  // The boot screen's caption is its one Text; ledger 363 reads where it sits.
  const caption = ({ children, style }: { children?: ReactNode; style?: unknown }) => { runtime.captions.push(style); return h('div', null, children); };
  return {
    ActivityIndicator: ({ style }: { style?: unknown }) => { runtime.spinners.push(style); return null; },
    Platform: runtime.platform,
    StyleSheet: { create: <T,>(styles: T) => styles },
    Text: caption,
    View: text,
  };
});

import IndexScreen from '../../app/index';
import { useRootNavigatorReady, useRootSessionNavigation } from './rootLayoutNavigation';

const pending: { current: AppRoute | null } = { current: null };

function SessionProbe() {
  const ready = useRootNavigatorReady();
  useRootSessionNavigation(pending, ready);
  return null;
}

describe('root layout navigation waits until the navigator is mounted', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    runtime.mode = 'booting';
    runtime.sessionUserID = null;
    runtime.pathname = '/home';
    runtime.ready = false;
    runtime.replace.mockReset();
    runtime.push.mockReset();
    runtime.redirects = [];
    runtime.listeners = [];
    runtime.platform.OS = 'android';
    runtime.marks = [];
    runtime.spinners = [];
    runtime.captions = [];
    pending.current = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
  });

  function render(node: ReactNode) {
    act(() => { root.render(node); });
  }

  function publishReady(next: boolean) {
    runtime.ready = next;
    act(() => {
      for (const listener of [...runtime.listeners]) listener();
    });
  }

  it('does not replace to sign-in while the navigator is unmounted, then replaces once', () => {
    render(createElement(SessionProbe));
    expect(runtime.replace).not.toHaveBeenCalled();

    runtime.mode = 'signedOut';
    render(createElement(SessionProbe));
    expect(runtime.replace).not.toHaveBeenCalled();

    publishReady(true);
    expect(runtime.replace).toHaveBeenCalledTimes(1);
    expect(runtime.replace).toHaveBeenCalledWith('/sign-in');

    publishReady(true);
    expect(runtime.replace).toHaveBeenCalledTimes(1);
  });

  it('sends an assurance challenge to its own screen once the navigator is ready', () => {
    runtime.mode = 'mfaRequired';
    runtime.ready = true;
    render(createElement(SessionProbe));
    expect(runtime.replace).toHaveBeenCalledTimes(1);
    expect(runtime.replace).toHaveBeenCalledWith('/mfa-challenge');
  });

  it('leaves a public route where it is', () => {
    runtime.mode = 'signedOut';
    runtime.pathname = '/offline';
    runtime.ready = true;
    render(createElement(SessionProbe));
    expect(runtime.replace).not.toHaveBeenCalled();
  });

  it('drops the previous identity route when an established session signs out', () => {
    runtime.mode = 'authenticated';
    runtime.sessionUserID = 'member-1';
    runtime.ready = true;
    render(createElement(SessionProbe));
    pending.current = { kind: 'tab', tab: 'home' };
    expect(runtime.replace).not.toHaveBeenCalled();

    runtime.mode = 'signedOut';
    runtime.sessionUserID = null;
    render(createElement(SessionProbe));
    expect(pending.current).toBeNull();
    expect(runtime.replace).toHaveBeenCalledTimes(1);
    expect(runtime.replace).toHaveBeenCalledWith('/sign-in');
  });

  it('keeps the index splash up until the navigator can accept the sign-in redirect', () => {
    runtime.mode = 'signedOut';
    render(createElement(IndexScreen));
    expect(host.textContent).toContain('Opening Union Ground…');
    expect(runtime.redirects).toEqual([]);

    publishReady(true);
    expect(runtime.redirects).toEqual(['/sign-in']);
    expect(host.textContent).not.toContain('Opening Union Ground…');
  });

  // Ledger 361: the boot screen continues the launch mark at its size on each
  // platform (src/lib/launchMark.ts, pinned to app.config.ts by appConfig.test.ts),
  // and the spinner below it follows that size.
  it('draws the boot mark at the launch mark size on Android and on iPhone', () => {
    const flat = (style: unknown): Record<string, unknown> => Array.isArray(style)
      ? Object.assign({}, ...style.map(flat))
      : style && typeof style === 'object' ? style as Record<string, unknown> : {};
    const platforms: [string, number][] = [['android', 144], ['ios', 180]];
    for (const [os, size] of platforms) {
      act(() => { root.unmount(); });
      root = createRoot(host);
      runtime.platform.OS = os;
      runtime.marks = [];
      runtime.spinners = [];
      runtime.captions = [];
      render(createElement(IndexScreen));
      expect(host.textContent).toContain('Opening Union Ground…');
      expect(runtime.marks).toEqual([size]);
      expect(flat(runtime.spinners[0]).marginTop).toBe(size / 2 + 24);
      // Ledger 363: the spinner and its line hang from the screen's centre, below
      // the mark, and the line sits under the spinner (20 for the spinner, 12 gap).
      const spinner = flat(runtime.spinners[0]);
      const line = flat(runtime.captions[0]);
      expect([spinner.position, spinner.top]).toEqual(['absolute', '50%']);
      expect([line.position, line.top, line.marginTop]).toEqual(['absolute', '50%', size / 2 + 24 + 20 + 12]);
    }
  });
});
