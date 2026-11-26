import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';

const port = vi.hoisted(() => ({ app: {} as Record<string, unknown>, history: vi.fn(), ask: vi.fn(), save: vi.fn(), pan: {} as Record<string, (...args: unknown[]) => void> }));
vi.mock('react-native', async () => ({ ...await import('../testing/reactNativeStandIn'), Easing: { bezier: () => undefined }, PanResponder: { create: (callbacks: typeof port.pan) => { port.pan = callbacks; return { panHandlers: {} }; } } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, usePathname: () => '/messages', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('../services/livedIn', () => ({ loadMobileCompassHistory: port.history, saveMobileCompassExchange: port.save }));
vi.mock('../services/compassSuggestions', () => ({ loadCompassSwitchConfiguration: async () => null, loadCompassMemberNudges: async () => [] }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => null, session?.user.id ?? 'signed-out'), COMPASS_QUESTION_WITHHELD_MESSAGE: 'Withheld', compassRateLimitMessage: () => 'Rate limited', isCompassPausedError: () => false, isCompassQuestionWithheldError: () => false, isCompassRateLimitError: () => false }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => true }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('./ui', async () => ({ ...await import('../testing/uiStandIn'), StateMessage: ({ title, body }: { title: string; body: string }) => h('section', null, title, body) }));
vi.mock('./PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children), usePinnedHeaderChrome: () => null }));
vi.mock('./TopChrome', () => ({ TopRamp: () => null }));

import CompassScreen from '../../app/(tabs)/compass';
import { QuickActionsDrawer } from './QuickActionsDrawer';

const history = () => ({ threadID: 'thread-a', title: 'My rights', messages: [{ id: 'old-answer', role: 'assistant', body: 'Protected Guide history' }], threads: [{ id: 'thread-a', title: 'My rights', messages: [{ id: 'old-answer', role: 'assistant', body: 'Protected Guide history' }] }] });
let screen: Rendered | null = null;
const field = () => screen!.container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask the Guide"]')!;
const text = () => screen!.container.textContent ?? '';
beforeEach(() => {
  port.history.mockReset().mockResolvedValue(history());
  port.save.mockReset().mockResolvedValue('thread-a');
  port.ask.mockReset();
  port.app = { mode: 'authenticated', session: { user: { id: 'member-a' } }, dashboard: { member: { id: 'member-a', chapterID: 'chapter-a' } }, organizationID: 'org-a', authorizedRoles: [], chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], askCompass: port.ask, locked: false, privacyCovered: false };
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('Guide foreground checks on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  describe.each<'route' | 'drawer'>(['route', 'drawer'])('%s', (surface) => {
    const tree = () => surface === 'route' ? h(CompassScreen) : h(QuickActionsDrawer, null, h('p', null, 'Messages'));
    async function open() {
      screen = await render(tree());
      if (surface === 'drawer') await act(async () => { port.pan.onPanResponderGrant!(); port.pan.onPanResponderRelease!({}, { vx: -1 }); });
      expect(field()).not.toBeNull();
      expect(text()).toContain('Protected Guide history');
    }
    it.each<'draft' | 'answer'>(['draft', 'answer'])('R9256E retires the old %s on confirmed organization-only membership during a staff outage', async (phase) => {
      port.app = { ...port.app, organizationID: null, staffScopeAvailable: false, dashboard: { member: { id: 'member-a', chapterID: null } }, confirmedMembershipScope: [{ chapterID: null, organizationID: 'org-a' }] };
      await open();
      await type(field(), 'Original organization question');
      let finish!: (value: { answer: string; sources: [] }) => void;
      if (phase === 'answer') {
        port.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
        await press(getExposed(screen!.container, 'Send question'));
      }
      port.app = { ...port.app, confirmedMembershipScope: [{ chapterID: null, organizationID: 'org-b' }] };
      await screen!.rerender(tree());
      if (phase === 'answer') await act(async () => { finish({ answer: 'Old organization answer', sources: [] }); });
      expect(field()?.value ?? '').toBe('');
      expect(text()).not.toContain('Original organization question');
      expect(text()).not.toContain('Old organization answer');
      expect(port.save).not.toHaveBeenCalled();
    });
    async function boot() {
      const actor = port.app;
      if (surface === 'drawer') {
        // Background privacy cover arrives before the foreground booting
        // transition. It must disarm/conceal without losing the draft owner.
        port.app = { ...actor, privacyCovered: true };
        await screen!.rerender(tree());
        expect(() => getExposed(screen!.container, 'Send question')).toThrow();
        expect(() => getExposed(screen!.container, 'Close Guide')).toThrow();
      }
      port.app = { ...actor, mode: 'booting', dashboard: null, organizationID: null, chapterMemberships: [], authorizedRoles: [], privacyCovered: true };
      await screen!.rerender(tree());
      expect(field()).toBeNull();
      expect(text()).not.toContain('Protected Guide history');
      return actor;
    }
    it('keeps the exact unfinished question, hidden until fresh history access succeeds', async () => {
      await open();
      await type(field(), 'Unfinished Guide question');
      const actor = await boot();
      let allow!: (value: ReturnType<typeof history>) => void;
      port.history.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; }));
      port.app = actor;
      await screen!.rerender(tree());
      expect(field()).toBeNull();
      expect(text()).not.toContain('Protected Guide history');
      await act(async () => { allow(history()); });
      expect(field().value).toBe('Unfinished Guide question');
      expect(port.ask).not.toHaveBeenCalled();
      expect(port.save).not.toHaveBeenCalled();
    });

    it('keeps a pending answer owned through resume and saves it once', async () => {
      await open();
      let finish!: (value: { answer: string; sources: [] }) => void;
      port.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await type(field(), 'Question in flight');
      await press(getExposed(screen!.container, 'Send question'));
      port.app = await boot();
      await screen!.rerender(tree());
      expect(getExposed(screen!.container, 'Send question').getAttribute('aria-disabled')).toBe('true');
      expect(text()).toContain('Question in flight');
      await act(async () => { finish({ answer: 'Fresh answer', sources: [] }); });
      expect(text()).toContain('Fresh answer');
      expect(port.ask).toHaveBeenCalledTimes(1);
      expect(port.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: 'member-a' }), 'thread-a', 'Question in flight', 'Fresh answer', []);
    });

    it('keeps an answer that finishes during booting hidden until the fresh history read succeeds', async () => {
      await open();
      let finish!: (value: { answer: string; sources: [] }) => void;
      let saved!: () => void;
      port.save.mockImplementationOnce(() => new Promise<string>((resolve) => { saved = () => resolve('thread-a'); }));
      port.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await type(field(), 'Answer while away');
      await press(getExposed(screen!.container, 'Send question'));
      const actor = await boot();
      await act(async () => { finish({ answer: 'Finished under the cover', sources: [] }); });
      expect(text()).not.toContain('Finished under the cover');
      expect(port.save).not.toHaveBeenCalled();
      let allow!: (value: ReturnType<typeof history>) => void;
      port.history.mockImplementationOnce(() => new Promise((resolve) => { allow = resolve; }));
      port.app = actor;
      await screen!.rerender(tree());
      expect(text()).not.toContain('Finished under the cover');
      await act(async () => { allow(history()); });
      await act(async () => { saved(); });
      expect(text()).toContain('Finished under the cover');
      expect(port.save).toHaveBeenCalledTimes(1);
    });

    it('never saves a returned answer while the organization is being checked or after it changes', async () => {
      await open();
      let finish!: (value: { answer: string; sources: [] }) => void;
      port.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await type(field(), 'Question for the original organization');
      await press(getExposed(screen!.container, 'Send question'));
      const actor = await boot();
      await act(async () => { finish({ answer: 'Original organization answer', sources: [] }); });
      expect(port.save).not.toHaveBeenCalled();
      port.history.mockResolvedValue({ threadID: null, title: null, messages: [], threads: [] });
      port.app = { ...actor, organizationID: 'org-b' };
      await screen!.rerender(tree());
      expect(field().value).toBe('');
      expect(text()).not.toContain('Original organization answer');
      expect(port.save).not.toHaveBeenCalled();
    });

    it('keeps an unsaved answer and its explicit save decision across resume', async () => {
      await open();
      port.ask.mockResolvedValue({ answer: 'Answer needing a save', sources: [] });
      port.save.mockRejectedValueOnce(new Error('offline'));
      await type(field(), 'Keep my answer');
      await press(getExposed(screen!.container, 'Send question'));
      getExposed(screen!.container, 'Try saving again');
      port.app = await boot();
      await screen!.rerender(tree());
      expect(text()).toContain('Answer needing a save');
      expect(port.save).toHaveBeenCalledTimes(1);
      await press(getExposed(screen!.container, 'Try saving again'));
      expect(port.save).toHaveBeenCalledTimes(2);
      expect(text()).not.toContain('Discard unsaved answer');
    });

    it('retires a removed Guide conversation and its pending answer on the fresh read', async () => {
      await open();
      let finish!: (value: { answer: string; sources: [] }) => void;
      port.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await type(field(), 'Question in removed history');
      await press(getExposed(screen!.container, 'Send question'));
      const actor = await boot();
      port.history.mockResolvedValue({ threadID: null, title: null, messages: [], threads: [] });
      port.app = actor;
      await screen!.rerender(tree());
      await act(async () => { finish({ answer: 'Retired answer', sources: [] }); });
      expect(text()).not.toContain('Protected Guide history');
      expect(text()).not.toContain('Question in removed history');
      expect(text()).not.toContain('Retired answer');
      expect(field().value).toBe('');
      expect(port.save).not.toHaveBeenCalled();
    });

    it.each(['answer', 'save'])('retires a refused Guide owner before access is restored (pending %s)', async (pending) => {
      await open();
      let finish!: () => void;
      if (pending === 'answer') port.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ answer: 'Retired answer', sources: [] }); }));
      else {
        port.ask.mockResolvedValue({ answer: 'Retired answer', sources: [] });
        port.save.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = () => resolve('thread-a'); }));
      }
      await type(field(), 'Retired question');
      await press(getExposed(screen!.container, 'Send question'));
      const actor = await boot();
      port.history.mockRejectedValueOnce({ code: '42501' });
      port.app = actor;
      await screen!.rerender(tree());
      expect(field()).toBeNull();
      port.history.mockResolvedValue(history());
      await press(getExposed(screen!.container, 'Try again'));
      await type(field(), 'New question after access returns');
      await act(async () => { finish(); });
      expect(field().value).toBe('New question after access returns');
      expect(text()).not.toContain('Retired question');
      expect(text()).not.toContain('Retired answer');
      expect(port.save).toHaveBeenCalledTimes(pending === 'answer' ? 0 : 1);
    });

    it('does not save a first account answer after sign-out and another account signs in', async () => {
      await open();
      let finish!: (value: { answer: string; sources: [] }) => void;
      port.ask.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      await type(field(), 'First account question');
      await press(getExposed(screen!.container, 'Send question'));
      port.app = { ...port.app, mode: 'signedOut', session: null, dashboard: null };
      await screen!.rerender(tree());
      port.app = { ...port.app, mode: 'authenticated', session: { user: { id: 'member-b' } }, dashboard: { member: { chapterID: 'chapter-a' } } };
      await screen!.rerender(tree());
      if (surface === 'drawer') await act(async () => { port.pan.onPanResponderGrant!(); port.pan.onPanResponderRelease!({}, { vx: -1 }); });
      await type(field(), 'Second account question');
      await act(async () => { finish({ answer: 'First account answer', sources: [] }); });
      expect(field().value).toBe('Second account question');
      expect(text()).not.toContain('First account question');
      expect(text()).not.toContain('First account answer');
      expect(port.save).not.toHaveBeenCalled();
    });

    it.each<'role changed' | 'chapter changed' | 'organization changed' | 'access refused'>(['role changed', 'chapter changed', 'organization changed', 'access refused'])('does not show held Guide content when %s', async (change) => {
      await open();
      await type(field(), 'Do not carry this question');
      const actor = await boot();
      if (change === 'access refused') port.history.mockRejectedValue(new Error('permission denied'));
      port.app = { ...actor,
        ...(change === 'role changed' ? { authorizedRoles: ['steward'] } : {}),
        ...(change === 'chapter changed' ? { dashboard: { member: { chapterID: 'chapter-b' } }, chapterMemberships: [{ chapterID: 'chapter-b', selected: true }] } : {}),
        ...(change === 'organization changed' ? { organizationID: 'org-b' } : {}),
      };
      await screen!.rerender(tree());
      expect(field()?.value ?? '').toBe('');
      expect(text()).not.toContain('Do not carry this question');
      if (change === 'access refused') expect(text()).not.toContain('Protected Guide history');
      expect(port.ask).not.toHaveBeenCalled();
    });
  });
});
