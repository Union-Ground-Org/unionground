// @vitest-environment jsdom
import { createElement as h, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Rendered } from '../testing/reactNativeStandIn';
import { noteResumeDraftReadFailure, syncResumeDraftContext } from '../lib/resumeDraftHolder';

// Ledger 725 (#9482 final): the saved-work line was a Body marked as an alert,
// which skips the iPhone announcement queue that the shared Notice uses (that
// queue is pinned in src/lib/voiceoverQ19.test.ts). The line now goes through
// Notice; this suite records what Notice is handed.
const port = vi.hoisted(() => ({ notices: [] as string[], language: 'en' as 'en' | 'es' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('./ui', async () => {
  const ui = await import('../testing/uiStandIn');
  return { ...ui, Notice: ({ children }: { children: string }) => { port.notices.push(children); return h('p', null, children as ReactNode); } };
});
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => new Proxy({}, { get: () => '#123456' }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: port.language, dashboard: null, refreshing: false, refresh: async () => undefined }) }));

import { SavedWorkCheckFailed } from './SavedWorkCheckFailed';

let view: Rendered | null = null;
afterEach(async () => {
  await view?.unmount(); view = null; port.notices = []; port.language = 'en';
  syncResumeDraftContext({ mode: 'signedOut', session: null, organizationID: null });
});

describe('the saved-work check line', () => {
  it.each<['en' | 'es', unknown, string]>([
    ['en', { status: 0 }, 'Your saved work could not be checked. Check your connection and try again.'],
    ['en', { status: 500 }, 'Your saved work could not be checked. Try again.'],
    ['es', { status: 0 }, 'No se pudo comprobar tu trabajo guardado. Revisa tu conexión y vuelve a intentarlo.'],
    ['es', undefined, 'No se pudo comprobar tu trabajo guardado. Vuelve a intentarlo.'],
  ])('goes through Notice, the announcement queue, in %s after %j', async (language, error, words) => {
    port.language = language;
    syncResumeDraftContext({ mode: 'authenticated', session: { user: { id: 'officer-a' } } as never, organizationID: 'org-a' });
    noteResumeDraftReadFailure(error);
    view = await render(h(SavedWorkCheckFailed));
    expect(port.notices.at(-1)).toBe(words);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });
});
