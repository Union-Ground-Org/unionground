// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { getExposed, press, render, setPlatform, type, type Rendered, Pressable } from '../testing/reactNativeStandIn';
import { noteResumeDraftReadFailure, readOwnHeldText, syncResumeDraftContext, type ResumeDraftReads } from '../lib/resumeDraftHolder';
import { nativeUiText } from '../lib/nativeUiCopy';
import { UNAVAILABLE_CHANNEL_CONTROLS, type ChannelControls, type ChannelSetting } from '../lib/channelControlsShared';
import palette from '../theme/palette.json';

const port = vi.hoisted(() => ({ save: vi.fn(), saved: vi.fn(), actor: 'member-a' }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../data/channelControls', () => ({ channelControlsApi: { setKeywords: port.save, setLevel: port.save, setMute: port.save } }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: Session) => ({
  isCurrent: async () => session.user.id === port.actor, check: async () => session.user.id === port.actor ? 'current' : 'changed',
}) }));
vi.mock('./ui', async () => ({
  ...await import('../testing/uiStandIn'),
  Button: ({ label, onPress, disabled, busy, selected }: { label: string; onPress?: () => void; disabled?: boolean; busy?: boolean; selected?: boolean }) => h(Pressable, {
    accessibilityLabel: label, accessibilityRole: 'button', accessibilityState: { disabled: disabled || busy, selected }, disabled: disabled || busy, onPress,
  }, label),
}));
const session = { access_token: 'test-session-a', user: { id: 'member-a' } } as Session;
const initialApp = () => ({ mode: 'authenticated', session: session as Session | null, organizationID: 'org-a', memberLanguage: 'en',
  dashboard: { member: { chapterID: 'chapter-a' } } as { member: { chapterID: string } } | null,
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], authorizedRoles: [] as string[],
  resumeDraftReads: { dashboard: true, memberships: true, staff: true } as ResumeDraftReads });
let app = initialApp();
vi.mock('../state/AppProvider', () => ({ useApp: () => { syncResumeDraftContext(app); return app; } }));
import { ChannelSettingsPanel } from './ChannelControls';

let screen: Rendered | null = null;
let spaceID = 'space-a'; let freshAccess = true;
let controls: ChannelControls;
const setting = (): Required<ChannelSetting> => ({ spaceId: spaceID, level: 'mentions', keywords: ['Union Ground'], muted: false, mutedUntil: null, muteActive: false });
function ChannelHost() {
  // The route's loading branch unmounts the panel while AppProvider checks
  // the session. Keep that owner boundary in this fixture.
  syncResumeDraftContext(app);
  return app.mode === 'authenticated' ? h(ChannelSettingsPanel, { spaceID, controls, onSaved: port.saved, resumeItemID: spaceID, freshAccess }) : null;
}
const tree = () => h(ChannelHost);
const t = () => nativeUiText(app.memberLanguage === 'es' ? 'es' : 'en');
function deferred<T>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function draft() {
  screen = await render(tree());
  await type(getExposed(screen.container, t()('New keyword')), '  Union Ground  ');
  await press(getExposed(screen.container, t()('1 hour')));
}
async function boot() {
  app = { ...app, mode: 'booting', dashboard: null, chapterMemberships: [], resumeDraftReads: { dashboard: false, memberships: false, staff: false } };
  await screen!.rerender(tree());
  expect(screen!.container.textContent).toBe('');
}
async function restore(language = 'en') { app = initialApp(); app.memberLanguage = language; await screen!.rerender(tree()); }
beforeEach(() => {
  syncResumeDraftContext({ mode: 'anonymous', session: null, organizationID: null });
  app = initialApp(); spaceID = 'space-a'; freshAccess = true; port.actor = 'member-a';
  vi.clearAllMocks(); port.save.mockImplementation(async () => setting());
  controls = { ...UNAVAILABLE_CHANNEL_CONTROLS, available: true, organizationId: 'org-a', keywordLimit: 40, keywordCount: 0, spaces: {},
    switches: { ...UNAVAILABLE_CHANNEL_CONTROLS.switches, keywordAlerts: true, channelMute: true, notificationLevels: true } };
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

describe.each<'ios' | 'android'>(['ios', 'android'])('channel settings resume on %s', (platform) => {
  beforeEach(() => setPlatform(platform));
  it.each<'en' | 'es'>(['en', 'es'])('restores exact keyword and duration after fresh reads in %s without saving', async (language) => {
    app.memberLanguage = language;
    await draft(); await boot();
    freshAccess = false; await restore(language);
    expect(screen!.container.textContent).toBe('');
    freshAccess = true; await screen!.rerender(tree());
    expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe('  Union Ground  ');
    expect(getExposed(screen!.container, t()('1 hour')).getAttribute('aria-selected')).toBe('true');
    expect(port.save).not.toHaveBeenCalled();
  });
  it.each(['account', 'organization', 'chapter', 'roles', 'item', 'signout'])('retires retained input after %s changes', async (change) => {
    await draft(); await boot(); app = initialApp();
    if (change === 'account') { app.session = { ...session, user: { ...session.user, id: 'member-b' } }; port.actor = 'member-b'; }
    if (change === 'organization') app.organizationID = 'org-b';
    if (change === 'chapter') { app.dashboard!.member.chapterID = 'chapter-b'; app.chapterMemberships[0]!.chapterID = 'chapter-b'; }
    if (change === 'roles') app.authorizedRoles = ['steward'];
    if (change === 'item') spaceID = 'space-b';
    if (change === 'signout') { app.session = null; app.mode = 'anonymous'; }
    await screen!.rerender(tree());
    if (change !== 'signout') expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe('');
    else expect(screen!.container.textContent).toBe('');
    expect(port.save).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'keyword-off'])('permanently retires the draft on fresh %s access', async (failure) => {
    await draft(); await boot();
    if (failure === 'disabled') controls = { ...controls, available: false };
    if (failure === 'keyword-off') controls = { ...controls, switches: { ...controls.switches, keywordAlerts: false } };
    await restore();
    controls = { ...controls, available: true, switches: { ...controls.switches, keywordAlerts: true } };
    await screen!.rerender(tree());
    expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe('');
  });
  it.each([true, false])('holds a pending keyword write across remount (accepted=%s)', async (accepted) => {
    const sending = deferred<Required<ChannelSetting>>(); port.save.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, t()('Add keyword')));
    expect(port.save).toHaveBeenCalledTimes(1);
    await boot(); await restore();
    expect(getExposed(screen!.container, t()('Add keyword')).getAttribute('aria-disabled')).toBe('true');
    await press(getExposed(screen!.container, t()('Add keyword')));
    await act(async () => sending.resolve(accepted ? setting() : Promise.reject(new Error('offline'))));
    expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe(accepted ? '' : '  Union Ground  ');
    expect(port.saved).toHaveBeenCalledTimes(accepted ? 1 : 0);
    expect(port.save).toHaveBeenCalledTimes(1);
  });
  it('retains an unsaved keyword when a different setting is confirmed during resume', async () => {
    const sending = deferred<Required<ChannelSetting>>(); port.save.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, t()('Every post')));
    await boot(); await act(async () => sending.resolve(setting())); await restore();
    expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe('  Union Ground  ');
    expect(port.saved).toHaveBeenCalledTimes(1);
    expect(port.save).toHaveBeenCalledTimes(1);
  });
  it.each(['account', 'controls-off'])('does not adopt an old acknowledgement after %s retirement', async (change) => {
    const sending = deferred<Required<ChannelSetting>>(); port.save.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, t()('Add keyword'))); await boot();
    if (change === 'account') {
      app = initialApp(); app.session = { ...session, user: { ...session.user, id: 'member-b' } }; port.actor = 'member-b';
      await screen!.rerender(tree());
    } else {
      controls = { ...controls, available: false }; await restore();
      controls = { ...controls, available: true }; await screen!.rerender(tree());
    }
    await type(getExposed(screen!.container, t()('New keyword')), 'Replacement work');
    await act(async () => sending.resolve(setting()));
    expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe('Replacement work');
    expect(port.saved).not.toHaveBeenCalled();
  });
  it('retires a pending keyword after an authoritative mutation refusal while concealed', async () => {
    const sending = deferred<Required<ChannelSetting>>(); port.save.mockReturnValueOnce(sending.promise);
    await draft(); await press(getExposed(screen!.container, t()('Add keyword'))); await boot();
    await act(async () => sending.resolve(Promise.reject({ code: '42501' })));
    await restore();
    expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe('');
    expect(port.saved).not.toHaveBeenCalled();
    expect(port.save).toHaveBeenCalledTimes(1);
  });
  it('consumes a failed receipt after showing its notice and keeps the keyword on reopen', async () => {
    port.save.mockRejectedValueOnce(new Error('offline'));
    await draft(); await press(getExposed(screen!.container, t()('Add keyword')));
    expect(screen!.container.textContent).toContain(t()('That change was not saved. Try again.'));
    await boot(); await restore();
    expect(screen!.container.textContent).not.toContain(t()('That change was not saved. Try again.'));
    expect((getExposed(screen!.container, t()('New keyword')) as HTMLInputElement).value).toBe('  Union Ground  ');
  });
  // Ledger 680: consuming that failed send stamps the attempt on the draft,
  // so the own-text panel still warns after the companion is gone.
  it('keeps the uncertainty mark on the keyword draft after consuming a failed send', async () => {
    port.save.mockRejectedValueOnce(new Error('offline'));
    await draft(); await press(getExposed(screen!.container, t()('Add keyword')));
    expect(screen!.container.textContent).toContain(t()('That change was not saved. Try again.'));
    noteResumeDraftReadFailure({ status: 0 });
    await boot();
    const shown = readOwnHeldText('member-a');
    expect(shown.map(row => row.lines)).toEqual([['  Union Ground  ']]);
    expect(shown[0]!.uncertain).toBe(true);
  });
  // #9426 round 1 (r1s1/r2s1): a confirmed rejection is a known outcome, so
  // consuming it must not stamp the uncertainty mark.
  it('does not mark a keyword the server explicitly refused at the keyword limit', async () => {
    port.save.mockRejectedValueOnce({ code: '22023', details: 'keyword-limit', message: 'keyword limit reached' });
    await draft(); await press(getExposed(screen!.container, t()('Add keyword')));
    expect(screen!.container.textContent).toContain(t()("You have reached your organization's keyword limit. Remove one first."));
    noteResumeDraftReadFailure({ status: 0 });
    await boot();
    const shown = readOwnHeldText('member-a');
    expect(shown.map(row => row.lines)).toEqual([['  Union Ground  ']]);
    expect(shown[0]!.uncertain).toBe(false);
  });
  // A gateway 5xx can arrive after the function committed; only a 4xx
  // answer is a known outcome, so the lost-answer warning stays.
  it('marks a keyword whose save answered 504 with no code', async () => {
    port.save.mockRejectedValueOnce({ status: 504, message: 'Gateway timeout' });
    await draft(); await press(getExposed(screen!.container, t()('Add keyword')));
    expect(screen!.container.textContent).toContain(t()('That change was not saved. Try again.'));
    noteResumeDraftReadFailure({ status: 0 });
    await boot();
    const shown = readOwnHeldText('member-a');
    expect(shown.map(row => row.lines)).toEqual([['  Union Ground  ']]);
    expect(shown[0]!.uncertain).toBe(true);
  });
  it('does not mark a keyword whose save never dispatched', async () => {
    port.save.mockRejectedValueOnce(Object.assign(new Error('The account changed before this was sent.'), { name: 'WriterSessionChanged', details: 'writer_session_changed' }));
    await draft(); await press(getExposed(screen!.container, t()('Add keyword')));
    expect(screen!.container.textContent).toContain(t()('That change was not saved. Try again.'));
    noteResumeDraftReadFailure({ status: 0 });
    await boot();
    const shown = readOwnHeldText('member-a');
    expect(shown.map(row => row.lines)).toEqual([['  Union Ground  ']]);
    expect(shown[0]!.uncertain).toBe(false);
  });
});
