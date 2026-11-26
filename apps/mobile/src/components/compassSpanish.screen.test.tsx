// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

const port = vi.hoisted(() => ({ app: {} as Record<string, unknown>, history: vi.fn(), ask: vi.fn(), save: vi.fn() }));
vi.mock('react-native', async () => ({ ...await import('../testing/reactNativeStandIn'), Easing: { bezier: () => undefined } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../services/livedIn', () => ({ loadMobileCompassHistory: port.history, saveMobileCompassExchange: port.save }));
vi.mock('../services/compassSuggestions', () => ({ loadCompassSwitchConfiguration: async () => null, loadCompassMemberNudges: async () => [] }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => null, session?.user.id ?? 'signed-out'), COMPASS_QUESTION_WITHHELD_MESSAGE: 'Withheld', compassRateLimitMessage: () => 'Rate limited', isCompassPausedError: () => false, isCompassQuestionWithheldError: () => false, isCompassRateLimitError: () => false }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./ui', () => import('../testing/uiStandIn'));
vi.mock('./PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children), usePinnedHeaderChrome: () => null }));
vi.mock('./TopChrome', () => ({ TopRamp: () => null }));

import { CompassPanel } from './CompassPanel';

const history = () => ({ threadID: 'thread-a', title: 'Member-authored title', messages: [{ id: 'old-answer', role: 'assistant', body: 'Member-authored answer' }], threads: [] });
let view: Rendered | null = null;
const text = () => view!.container.textContent ?? '';
const field = () => view!.container.querySelector<HTMLTextAreaElement>('textarea')!;
async function settle() {
  for (let turn = 0; turn < 4; turn += 1) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  port.history.mockReset().mockResolvedValue(history());
  port.ask.mockReset();
  port.save.mockReset().mockResolvedValue('thread-a');
});
afterEach(async () => { await view?.unmount(); view = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('Guide copy on %s', (platform) => {
  describe.each<'en' | 'es'>(['en', 'es'])('%s', (language) => {
    const spanish = language === 'es';
    const send = spanish ? 'Enviar pregunta' : 'Send question';
    beforeEach(() => {
      setPlatform(platform);
      port.app = { mode: 'authenticated', session: { user: { id: 'member-a' } }, memberLanguage: language, dashboard: { member: { id: 'member-a', firstName: 'Ana', chapterID: 'chapter-a', language } }, organizationID: 'org-a', authorizedRoles: [], askCompass: port.ask, locked: false, privacyCovered: false };
    });

    it('shows loading, a history error, retry and the composer in the saved language', async () => {
      let reject!: (error: Error) => void;
      port.history.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
      view = await render(h(CompassPanel));
      expect(text()).toContain(spanish ? 'Cargando las fuentes aprobadas de su sindicato' : 'Loading your approved union sources');
      await act(async () => { reject(new Error('offline')); });
      expect(text()).toContain(spanish ? 'El historial de la Guía no está disponible en este momento.' : 'Guide history is unavailable right now.');
      await press(getExposed(view.container, spanish ? 'Reintentar' : 'Try again'));
      await settle();
      expect(field().placeholder).toBe(spanish ? 'Preguntar a la Guía' : 'Ask the Guide');
      expect(text()).toContain('Member-authored answer');
      getExposed(view.container, send);
    });

    it('localizes a failed answer without translating the worker question', async () => {
      port.ask.mockRejectedValueOnce(new Error('offline'));
      view = await render(h(CompassPanel));
      await settle();
      await type(field(), 'Keep this member-written question exactly');
      await press(getExposed(view.container, send));
      await settle();
      expect(text()).toContain(spanish ? 'La Guía no está disponible en este momento.' : 'Guide is unavailable right now.');
      expect(field().value).toBe('Keep this member-written question exactly');
    });

    it('localizes the explicit unsaved-answer decision and preserves submitted text', async () => {
      port.ask.mockResolvedValueOnce({ answer: 'Original answer text', sources: [] });
      port.save.mockRejectedValueOnce(new Error('offline'));
      view = await render(h(CompassPanel));
      await settle();
      await type(field(), 'Original question text');
      await press(getExposed(view.container, send));
      await settle();
      expect(text()).toContain(spanish ? 'Se recibió la respuesta, pero no se guardó el historial de la Guía.' : 'Answer received, but Guide history was not saved.');
      getExposed(view.container, spanish ? 'Intentar guardar de nuevo' : 'Try saving again');
      getExposed(view.container, spanish ? 'Descartar la respuesta sin guardar' : 'Discard unsaved answer');
      expect(port.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member-a' }), 'thread-a', 'Original question text', 'Original answer text', []);
    });
  });
});
