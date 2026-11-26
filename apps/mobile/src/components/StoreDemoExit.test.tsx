// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, type Rendered } from '../testing/reactNativeStandIn';

// Gate stage 122 on #8680 (r1s1/r2s1): Exit demo is drawn where the DEMO pill
// is not, needs no role or session, and says so when it cannot close.
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 32, bottom: 24, left: 0, right: 0 }) }));
vi.mock('../theme/ThemeProvider', async () => {
  const { resolveTheme } = await import('../theme/tokens');
  return { useTheme: () => resolveTheme() };
});
vi.mock('./ui', async () => {
  const { Text } = await import('../testing/reactNativeStandIn');
  return { Body: Text };
});
let app: { storeDemo: boolean; exitStoreDemo: () => Promise<void>; storeDemoExitBusy: boolean; memberLanguage: string | null; mode?: string; session?: null };
vi.mock('../state/AppProvider', () => ({ useApp: () => app }));
import { StoreDemoExit } from './StoreDemoExit';

let screen: Rendered | null = null;
beforeEach(() => {
  app = { storeDemo: true, exitStoreDemo: vi.fn(async () => undefined), storeDemoExitBusy: false, memberLanguage: null, mode: 'mfaRequired', session: null };
});
afterEach(async () => { await screen?.unmount(); screen = null; });

describe('Exit demo outside the DEMO pill', () => {
  it.each(['floating', 'inline'] as const)('is drawn %s with no role or session and leaves the demo with one tap', async (placement) => {
    screen = await render(h(StoreDemoExit, { placement }));
    expect(screen.container.textContent).toContain('DEMO · Exit demo');
    await press(getExposed(screen.container, 'Exit demo'));
    expect(app.exitStoreDemo).toHaveBeenCalledOnce();
  });

  it('draws nothing outside the store demo', async () => {
    app.storeDemo = false;
    screen = await render(h(StoreDemoExit, { placement: 'floating' }));
    expect(screen.container.textContent).toBe('');
  });

  it('says so when the demo could not close, in the worker language', async () => {
    app.memberLanguage = 'es';
    app.exitStoreDemo = vi.fn(async () => { throw new Error('keychain'); });
    screen = await render(h(StoreDemoExit, { placement: 'inline' }));
    await press(getExposed(screen.container, 'Salir de la demostración'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.container.textContent).toContain('No se pudo cerrar la demostración. Vuelva a intentarlo.');
  });

  it('holds while an exit is under way', async () => {
    app.storeDemoExitBusy = true;
    screen = await render(h(StoreDemoExit, { placement: 'floating' }));
    expect(getExposed(screen.container, 'Exit demo').getAttribute('aria-disabled')).toBe('true');
    expect(screen.container.textContent).toContain('Closing the demo…');
  });
});
